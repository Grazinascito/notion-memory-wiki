import { AxiError } from "../../shared/errors.js";
import type {
  AgentScopeConfig,
  CacheSnapshot,
  FractalPointers,
  NotionParent,
  OntologyConfig,
} from "../../shared/types.js";
import type { NotionGateway } from "../ports.js";

const MAX_PARENT_WALK_HOPS = 4;
export const REDACTED_MARKER = "[REDACTED:SCOPE_DENIED]";

export class ScopeGuard {
  private readonly verifiedInRoot = new Set<string>();

  /**
   * Fail-closed profile resolution (DESIGN-DOC.md Section 3.2.2).
   */
  resolveProfile(
    ontology: OntologyConfig,
    envProfile: string | undefined,
    cliProfile: string | undefined,
  ): { profileName: string; scope: AgentScopeConfig } {
    const names = Object.keys(ontology.agent_scopes);
    if (names.length === 0) {
      throw new AxiError(
        "CONFIG_INVALID",
        "No profiles defined under agent_scopes in ontology.yaml.",
        ["Add at least one profile under agent_scopes or run `wiki setup`."],
      );
    }

    const cleanEnv = envProfile?.trim() || undefined;
    const cleanCli = cliProfile?.trim() || undefined;

    if (cleanEnv && cleanCli && cleanEnv !== cleanCli) {
      throw new AxiError(
        "SCOPE_LOCKED",
        `Profile is locked to "${cleanEnv}" via WIKI_AGENT_PROFILE; conflicting --profile "${cleanCli}" is forbidden.`,
      );
    }

    let chosen = cleanEnv ?? cleanCli;
    if (!chosen) {
      if (names.length === 1) {
        chosen = names[0]!;
      } else {
        throw new AxiError(
          "PROFILE_REQUIRED",
          `Multiple profiles exist (${names.join(", ")}); specify WIKI_AGENT_PROFILE or --profile <name>.`,
          [`Available profiles: ${names.join(", ")}`],
        );
      }
    }

    const scope = ontology.agent_scopes[chosen];
    if (!scope) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Unknown agent profile "${chosen}".`,
        [`Configured profiles: ${names.join(", ")}`],
      );
    }

    return { profileName: chosen, scope };
  }

  /**
   * Exact set-algebra scope formula:
   * Permitted = (DatabasesIn(allow_areas) U allow_databases) \ deny_databases
   */
  getPermittedAliases(ontology: OntologyConfig, profileName: string): Set<string> {
    const scope = ontology.agent_scopes[profileName];
    if (!scope) {
      throw new AxiError("SCOPE_DENIED", `Unknown profile "${profileName}".`);
    }

    const allAliases = Object.keys(ontology.databases);
    const allowAllAreas = scope.allow_areas.includes("*");
    const allowAllDbs = scope.allow_databases.includes("*");
    const allowedAreas = new Set(scope.allow_areas);
    const explicitAllowedDbs = new Set(scope.allow_databases);
    const deniedDbs = new Set(scope.deny_databases);

    const permitted = new Set<string>();
    for (const alias of allAliases) {
      const db = ontology.databases[alias]!;
      const inArea = allowAllAreas || (db.area !== "" && allowedAreas.has(db.area));
      const inExplicit = allowAllDbs || explicitAllowedDbs.has(alias);
      if ((inArea || inExplicit) && !deniedDbs.has(alias)) {
        permitted.add(alias);
      }
    }
    return permitted;
  }

  getPermittedDataSourceIds(
    ontology: OntologyConfig,
    profileName: string,
  ): Set<string> {
    const aliases = this.getPermittedAliases(ontology, profileName);
    const ids = new Set<string>();
    for (const alias of aliases) {
      const db = ontology.databases[alias];
      if (db) ids.add(db.data_source_id);
    }
    return ids;
  }

  assertDatabaseAccess(
    ontology: OntologyConfig,
    profileName: string,
    alias: string,
    mode: "read" | "write",
  ): void {
    const scope = ontology.agent_scopes[profileName];
    if (!scope) {
      throw new AxiError("SCOPE_DENIED", `Unknown profile "${profileName}".`);
    }
    const permitted = this.getPermittedAliases(ontology, profileName);
    if (!permitted.has(alias)) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Profile "${profileName}" is not authorized to access database "${alias}".`,
      );
    }
    if (mode === "write" && scope.read_only) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Profile "${profileName}" is read_only and cannot write to "${alias}".`,
      );
    }
  }

  assertDataSourceAccess(
    ontology: OntologyConfig,
    profileName: string,
    dataSourceId: string,
  ): void {
    const allowed = this.getPermittedDataSourceIds(ontology, profileName);
    if (!allowed.has(dataSourceId)) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Profile "${profileName}" is not authorized to traverse data source "${dataSourceId}".`,
      );
    }
  }

  isGuidePageAllowed(
    ontology: OntologyConfig,
    profileName: string,
    pageId: string,
  ): boolean {
    const scope = ontology.agent_scopes[profileName];
    if (!scope) return false;
    if (scope.allow_guide_pages === "all") return true;
    return scope.allow_guide_pages.includes(pageId);
  }

  /**
   * Filter page properties before returning to an agent:
   * - Strips rollups whose underlying relation targets an out-of-scope data_source_id.
   * - Redacts formulas referencing any stripped rollup or blocked relation property.
   * - Redacts relation values pointing to a blocked data_source_id.
   */
  filterRecordProperties(
    ontology: OntologyConfig,
    cache: CacheSnapshot | null,
    profileName: string,
    dataSourceId: string,
    rawProperties: Record<string, Record<string, unknown>>,
  ): Record<string, Record<string, unknown> | string> {
    const permittedDs = this.getPermittedDataSourceIds(ontology, profileName);
    const cachedDs = cache?.data_sources[dataSourceId];
    if (!cachedDs) {
      return rawProperties;
    }

    const propSchemasByName = new Map(
      Object.values(cachedDs.properties).map((p) => [p.name, p]),
    );

    const blockedRelationNames = new Set<string>();
    for (const schema of propSchemasByName.values()) {
      if (
        schema.type === "relation" &&
        schema.relation_target_data_source_id &&
        !permittedDs.has(schema.relation_target_data_source_id)
      ) {
        blockedRelationNames.add(schema.name);
      }
    }

    const strippedRollupNames = new Set<string>();
    for (const schema of propSchemasByName.values()) {
      if (
        schema.type === "rollup" &&
        schema.rollup_relation_property_name &&
        blockedRelationNames.has(schema.rollup_relation_property_name)
      ) {
        strippedRollupNames.add(schema.name);
      }
    }

    const out: Record<string, Record<string, unknown> | string> = {};
    for (const [propName, propVal] of Object.entries(rawProperties)) {
      if (strippedRollupNames.has(propName)) {
        // Strip rollup leaking values from out-of-scope database.
        continue;
      }
      if (blockedRelationNames.has(propName)) {
        out[propName] = REDACTED_MARKER;
        continue;
      }
      const schema = propSchemasByName.get(propName);
      if (schema?.type === "formula" && schema.formula_expression) {
        const expr = schema.formula_expression;
        let leaks = false;
        for (const blocked of [...strippedRollupNames, ...blockedRelationNames]) {
          if (expr.includes(blocked)) {
            leaks = true;
            break;
          }
        }
        if (leaks) {
          out[propName] = REDACTED_MARKER;
          continue;
        }
      }
      out[propName] = propVal;
    }
    return out;
  }

  /**
   * Verify that a raw Notion page/database UUID is inside workspace.root_id
   * or an approved database, bounded to at most 4 upward GET calls.
   */
  async verifyUuidInRootScope(
    ontology: OntologyConfig,
    cache: CacheSnapshot | null,
    fractals: FractalPointers,
    notion: NotionGateway,
    profileName: string,
    targetId: string,
  ): Promise<void> {
    const rootId = ontology.workspace.root_id;
    const permittedDs = this.getPermittedDataSourceIds(ontology, profileName);
    const knownAllowedIds = new Set<string>([
      rootId,
      ...ontology.workspace.approved_linked_view_ids,
      ...ontology.taxonomy.map((t) => t.hub_page_id),
      ...ontology.guide.pages
        .filter((g) => this.isGuidePageAllowed(ontology, profileName, g.page_id))
        .map((g) => g.page_id),
    ]);
    if (ontology.capture_inbox?.id) {
      knownAllowedIds.add(ontology.capture_inbox.id);
    }
    for (const dsId of permittedDs) {
      knownAllowedIds.add(dsId);
      const cached = cache?.data_sources[dsId];
      if (cached?.database_id) knownAllowedIds.add(cached.database_id);
    }
    for (const [parentId, children] of Object.entries(fractals.by_parent_page_id)) {
      knownAllowedIds.add(parentId);
      for (const child of children) {
        knownAllowedIds.add(child.child_database_id);
        knownAllowedIds.add(child.child_data_source_id);
      }
    }

    if (knownAllowedIds.has(targetId) || this.verifiedInRoot.has(targetId)) {
      return;
    }

    // Check if target is an explicitly excluded or out-of-scope database/guide page.
    if (ontology.excluded_data_source_ids.includes(targetId)) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Target "${targetId}" is excluded in ontology.yaml.`,
      );
    }
    const guidePage = ontology.guide.pages.find((g) => g.page_id === targetId);
    if (guidePage && !this.isGuidePageAllowed(ontology, profileName, targetId)) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Profile "${profileName}" is not authorized to read guide page "${guidePage.title}".`,
      );
    }

    // Walk parent chain upward for at most 4 GET calls.
    let currentId = targetId;
    for (let hop = 0; hop < MAX_PARENT_WALK_HOPS; hop += 1) {
      const page = await notion.getPage(currentId);
      const parent = page.parent;
      const parentId = extractParentId(parent);
      if (!parentId) break;

      if (parent.type === "data_source_id") {
        // Record inside a database: enforce Agent Scope on that data_source_id.
        if (permittedDs.has(parent.data_source_id)) {
          this.verifiedInRoot.add(targetId);
          return;
        }
        const isKnownDb = Object.values(ontology.databases).some(
          (db) => db.data_source_id === parent.data_source_id,
        );
        if (isKnownDb) {
          throw new AxiError(
            "SCOPE_DENIED",
            `Page "${targetId}" belongs to a database outside profile "${profileName}" scope.`,
          );
        }
      }

      if (knownAllowedIds.has(parentId) || this.verifiedInRoot.has(parentId)) {
        this.verifiedInRoot.add(targetId);
        return;
      }

      if (parent.type === "database_id") {
        // Check if parent database container belongs to an authorized data source or root.
        const matchingDs = Object.values(cache?.data_sources ?? {}).find(
          (ds) => ds.database_id === parent.database_id,
        );
        if (matchingDs) {
          if (permittedDs.has(matchingDs.data_source_id)) {
            this.verifiedInRoot.add(targetId);
            return;
          }
          throw new AxiError(
            "SCOPE_DENIED",
            `Page "${targetId}" belongs to a database outside profile "${profileName}" scope.`,
          );
        }
        const db = await notion.getDatabase(parent.database_id);
        const dbParentId = extractParentId(db.parent);
        if (dbParentId && knownAllowedIds.has(dbParentId)) {
          this.verifiedInRoot.add(targetId);
          return;
        }
        if (!dbParentId) break;
        currentId = dbParentId;
        continue;
      }

      currentId = parentId;
    }

    throw new AxiError(
      "OUT_OF_ROOT_SCOPE",
      `Target "${targetId}" could not be verified as a descendant of Root Page within ${MAX_PARENT_WALK_HOPS} hops.`,
      ["Ensure the page is inside your configured Root Page or run `wiki sync`."],
    );
  }
}

function extractParentId(parent: NotionParent): string | null {
  switch (parent.type) {
    case "page_id":
      return parent.page_id;
    case "database_id":
      return parent.database_id;
    case "data_source_id":
      return parent.data_source_id;
    case "block_id":
      return parent.block_id;
    case "workspace":
      return null;
  }
}
