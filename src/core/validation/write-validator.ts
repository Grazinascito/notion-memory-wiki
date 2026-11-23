import { AxiError } from "../../shared/errors.js";
import { extractNotionUuid, normalizeNfd } from "../../shared/text.js";
import type {
  CachedDataSource,
  CachedProperty,
  CacheSnapshot,
  NotionPage,
  NotionPropertyValue,
  OntologyConfig,
} from "../../shared/types.js";
import type { MetadataStore, NotionGateway } from "../ports.js";
import type { ScopeGuard } from "../scope/scope-guard.js";
import {
  buildRelationEdges,
  formatNotionPropertyValue,
  toCachedDataSource,
} from "../sync/notion-mapper.js";

export type MutationOp = "set" | "add" | "remove" | "clear";

/**
 * Internal marker error for validation failures that could be caused by stale
 * cached schemas (unknown property or unknown/missing select/status option),
 * triggering at most one reactive refresh of that single data_source_id.
 */
class SchemaDriftError extends AxiError {}

export interface RawPropertyMutation {
  op: MutationOp;
  property: string;
  value?: string;
}

export interface ValidatedPropertyChange {
  op: MutationOp;
  schema: CachedProperty;
  rawInputValue?: string;
  notionPayload: Record<string, unknown>;
  /** For relation / multi_select: exact item lists before and after mutation. */
  previousItems?: string[];
  nextItems?: string[];
  previousFormatted?: string;
  nextFormatted?: string;
}

export interface ValidationResult {
  cachedDs: CachedDataSource;
  changes: ValidatedPropertyChange[];
  notionProperties: Record<string, Record<string, unknown>>;
  titleValue?: string;
}

export class WriteValidator {
  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
    private readonly scopeGuard: ScopeGuard,
  ) {}

  private async loadDataSourceSchema(
    ontology: OntologyConfig,
    dataSourceId: string,
    forceRefresh: boolean,
  ): Promise<CachedDataSource> {
    let cache = await this.store.readCache();
    let cachedDs = cache?.data_sources[dataSourceId];
    if (!forceRefresh && cachedDs) return cachedDs;

    const fresh = await this.notion.getDataSource(dataSourceId);
    const parentNodeId = cachedDs?.parent_node_id ?? null;
    cachedDs = toCachedDataSource(fresh, parentNodeId);

    const nextCache: CacheSnapshot = cache ?? {
      schema_version: 1,
      synced_at: new Date().toISOString(),
      root: {
        id: ontology.workspace.root_id,
        type: ontology.workspace.root_type,
        is_wiki: ontology.workspace.root_type === "wiki_database",
      },
      taxonomy_nodes: [],
      data_sources: {},
      relation_edges: [],
      guide_pages: [],
    };
    nextCache.data_sources[dataSourceId] = cachedDs;
    nextCache.relation_edges = buildRelationEdges(nextCache.data_sources);
    nextCache.synced_at = new Date().toISOString();
    await this.store.writeCache(nextCache);
    return cachedDs;
  }

  private findProperty(
    cachedDs: CachedDataSource,
    input: string,
  ): CachedProperty | undefined {
    const byId = cachedDs.properties[input];
    if (byId) return byId;
    const norm = normalizeNfd(input);
    return Object.values(cachedDs.properties).find(
      (p) => normalizeNfd(p.name) === norm,
    );
  }

  private extractCurrentList(prop: NotionPropertyValue | undefined): string[] {
    if (!prop) return [];
    if (prop.type === "multi_select") {
      return (prop.multi_select ?? []).map((o) => o.name);
    }
    if (prop.type === "relation") {
      return (prop.relation ?? []).map((r) => r.id);
    }
    return [];
  }

  private snapValidOption(
    alias: string,
    schema: CachedProperty,
    rawVal: string,
  ): string {
    const options = schema.options ?? [];
    if (options.length === 0) {
      throw new SchemaDriftError(
        "VALIDATION_ERROR",
        `Field "${schema.name}" (${schema.type}) has no known options in schema for "${alias}".`,
        [`Run \`wiki sync\` or propose a new option via \`wiki schema propose-option ${alias} "${schema.name}" "${rawVal}"\`.`],
      );
    }
    const norm = normalizeNfd(rawVal);
    const matched = options.find((o) => normalizeNfd(o) === norm);
    if (!matched) {
      const hints = [`Valid options for "${schema.name}": ${options.join(", ")}`];
      if (schema.type === "select" || schema.type === "multi_select") {
        hints.push(
          `To add a new option safely, run \`wiki schema propose-option ${alias} "${schema.name}" "${rawVal}"\`.`,
        );
      }
      throw new SchemaDriftError(
        "VALIDATION_ERROR",
        `Invalid ${schema.type} value "${rawVal}" for field "${schema.name}".`,
        hints,
      );
    }
    return matched;
  }

  private buildValidatedChanges(params: {
    ontology: OntologyConfig;
    profileName: string;
    alias: string;
    cachedDs: CachedDataSource;
    mode: "create" | "update";
    mutations: RawPropertyMutation[];
    currentPage?: NotionPage;
  }): ValidationResult {
    const { ontology, profileName, alias, cachedDs, mode, mutations, currentPage } = params;
    const dbOverlay = ontology.databases[alias];
    if (!dbOverlay) {
      throw new AxiError("NOT_FOUND", `Database alias "${alias}" not found in ontology.yaml.`);
    }

    const changes: ValidatedPropertyChange[] = [];
    const notionProperties: Record<string, Record<string, unknown>> = {};
    const touchedById = new Map<string, string>();
    let titleValue: string | undefined;

    for (const mut of mutations) {
      const schema = this.findProperty(cachedDs, mut.property);
      if (!schema) {
        const names = Object.values(cachedDs.properties)
          .filter((p) => !p.read_only)
          .map((p) => p.name);
        throw new SchemaDriftError(
          "VALIDATION_ERROR",
          `Unknown property "${mut.property}" on database "${alias}".`,
          [`Writable properties: ${names.join(", ")}`],
        );
      }

      // Check (e): strict write-block on read-only Notion properties.
      if (schema.read_only) {
        throw new AxiError(
          "VALIDATION_ERROR",
          `Property "${schema.name}" (${schema.type}) is read-only in Notion and cannot be written.`,
        );
      }
      if (schema.type === "verification" && !dbOverlay.allow_wiki_verification) {
        throw new AxiError(
          "VALIDATION_ERROR",
          `Wiki verification writes are disabled for "${alias}" (allow_wiki_verification: false).`,
        );
      }

      const currentProp = currentPage?.properties[schema.name];
      const previousFormatted = currentProp ? formatNotionPropertyValue(currentProp) : "";

      if (mut.op === "clear") {
        const clearPayload = this.buildClearPayload(schema);
        notionProperties[schema.name] = clearPayload;
        changes.push({
          op: "clear",
          schema,
          notionPayload: clearPayload,
          previousFormatted,
          nextFormatted: "",
          ...(schema.type === "relation" || schema.type === "multi_select"
            ? { previousItems: this.extractCurrentList(currentProp), nextItems: [] }
            : {}),
        });
        continue;
      }

      const rawVal = (mut.value ?? "").trim();

      if (mut.op === "add" || mut.op === "remove") {
        if (schema.type !== "multi_select" && schema.type !== "relation") {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Operation --${mut.op} is only supported on multi_select and relation properties (got "${schema.name}" of type ${schema.type}).`,
          );
        }
        if (!rawVal) {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Operation --${mut.op} on "${schema.name}" requires a non-empty value.`,
          );
        }

        const prevItems = this.extractCurrentList(currentProp);
        const inputItems = rawVal.split(",").map((s) => s.trim()).filter(Boolean);
        let nextItems: string[];

        if (schema.type === "multi_select") {
          const snapped = inputItems.map((v) => this.snapValidOption(alias, schema, v));
          if (mut.op === "add") {
            nextItems = [...new Set([...prevItems, ...snapped])];
          } else {
            const toRemove = new Set(snapped.map((s) => normalizeNfd(s)));
            nextItems = prevItems.filter((item) => !toRemove.has(normalizeNfd(item)));
          }
          const payload = { multi_select: nextItems.map((name) => ({ name })) };
          notionProperties[schema.name] = payload;
          touchedById.set(schema.id, nextItems.join(", "));
          changes.push({
            op: mut.op,
            schema,
            rawInputValue: rawVal,
            notionPayload: payload,
            previousItems: prevItems,
            nextItems,
            previousFormatted,
            nextFormatted: nextItems.join(", "),
          });
        } else {
          // relation
          this.assertRelationTargetAllowed(ontology, profileName, schema);
          const ids = inputItems.map((v) => this.parseRelationUuid(schema.name, v));
          if (mut.op === "add") {
            nextItems = [...new Set([...prevItems, ...ids])];
          } else {
            const toRemove = new Set(ids);
            nextItems = prevItems.filter((item) => !toRemove.has(item));
          }
          const payload = { relation: nextItems.map((id) => ({ id })) };
          notionProperties[schema.name] = payload;
          touchedById.set(schema.id, nextItems.join(", "));
          changes.push({
            op: mut.op,
            schema,
            rawInputValue: rawVal,
            notionPayload: payload,
            previousItems: prevItems,
            nextItems,
            previousFormatted,
            nextFormatted: nextItems.join(", "),
          });
        }
        continue;
      }

      // op === "set"
      if (rawVal === "") {
        // Setting empty string maps to clearing the field (gated by ApprovalGate on updates).
        const clearPayload = this.buildClearPayload(schema);
        notionProperties[schema.name] = clearPayload;
        changes.push({
          op: "clear",
          schema,
          rawInputValue: "",
          notionPayload: clearPayload,
          previousFormatted,
          nextFormatted: "",
        });
        continue;
      }

      const built = this.buildSetPayload({
        ontology,
        profileName,
        alias,
        dbOverlay,
        schema,
        rawVal,
        currentProp,
        previousFormatted,
      });
      notionProperties[schema.name] = built.notionPayload;
      touchedById.set(schema.id, built.nextFormatted ?? rawVal);
      if (schema.type === "title") {
        titleValue = rawVal;
      }
      changes.push(built);
    }

    // Check (c): non-empty title required on page creation.
    if (mode === "create") {
      if (!titleValue || titleValue.trim().length === 0) {
        const titleProp = Object.values(cachedDs.properties).find((p) => p.type === "title");
        throw new AxiError(
          "VALIDATION_ERROR",
          `Creating a record in "${alias}" requires a non-empty title property ("${titleProp?.name ?? "Name"}").`,
        );
      }

      // Check (h): user-declared extra_required_fields matched by immutable property_id.
      for (const reqField of dbOverlay.extra_required_fields) {
        const val = touchedById.get(reqField.property_id);
        if (!val || val.trim().length === 0) {
          const liveName = cachedDs.properties[reqField.property_id]?.name ?? reqField.label;
          throw new AxiError(
            "VALIDATION_ERROR",
            `Missing required field "${liveName}" (property_id: "${reqField.property_id}") declared in ontology.yaml for "${alias}".`,
          );
        }
      }
    }

    return { cachedDs, changes, notionProperties, titleValue };
  }

  private assertRelationTargetAllowed(
    ontology: OntologyConfig,
    profileName: string,
    schema: CachedProperty,
  ): void {
    if (!schema.relation_target_data_source_id) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Relation property "${schema.name}" has no known target data_source_id in cache.`,
        ["Run `wiki sync` to refresh database schemas."],
      );
    }
    this.scopeGuard.assertDataSourceAccess(
      ontology,
      profileName,
      schema.relation_target_data_source_id,
    );
  }

  private parseRelationUuid(propName: string, input: string): string {
    const uuid = extractNotionUuid(input);
    if (!uuid) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Relation property "${propName}" requires valid Notion page UUIDs (got "${input}").`,
      );
    }
    return uuid;
  }

  private buildClearPayload(schema: CachedProperty): Record<string, unknown> {
    switch (schema.type) {
      case "title":
        return { title: [] };
      case "rich_text":
        return { rich_text: [] };
      case "status":
        return { status: null };
      case "select":
        return { select: null };
      case "multi_select":
        return { multi_select: [] };
      case "number":
        return { number: null };
      case "date":
        return { date: null };
      case "url":
        return { url: null };
      case "email":
        return { email: null };
      case "phone_number":
        return { phone_number: null };
      case "relation":
        return { relation: [] };
      case "checkbox":
        return { checkbox: false };
      default:
        throw new AxiError(
          "VALIDATION_ERROR",
          `Clearing property "${schema.name}" of type "${schema.type}" is not supported.`,
        );
    }
  }

  private buildSetPayload(params: {
    ontology: OntologyConfig;
    profileName: string;
    alias: string;
    dbOverlay: OntologyConfig["databases"][string];
    schema: CachedProperty;
    rawVal: string;
    currentProp?: NotionPropertyValue;
    previousFormatted: string;
  }): ValidatedPropertyChange {
    const { ontology, profileName, alias, dbOverlay, schema, rawVal, currentProp, previousFormatted } = params;

    switch (schema.type) {
      case "title":
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { title: [{ type: "text", text: { content: rawVal } }] },
          previousFormatted,
          nextFormatted: rawVal,
        };
      case "rich_text":
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { rich_text: [{ type: "text", text: { content: rawVal } }] },
          previousFormatted,
          nextFormatted: rawVal,
        };
      case "status": {
        const snapped = this.snapValidOption(alias, schema, rawVal);
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { status: { name: snapped } },
          previousFormatted,
          nextFormatted: snapped,
        };
      }
      case "select": {
        const snapped = this.snapValidOption(alias, schema, rawVal);
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { select: { name: snapped } },
          previousFormatted,
          nextFormatted: snapped,
        };
      }
      case "multi_select": {
        const prevItems = this.extractCurrentList(currentProp);
        const items = rawVal.split(",").map((s) => s.trim()).filter(Boolean);
        const snapped = [...new Set(items.map((v) => this.snapValidOption(alias, schema, v)))];
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { multi_select: snapped.map((name) => ({ name })) },
          previousItems: prevItems,
          nextItems: snapped,
          previousFormatted,
          nextFormatted: snapped.join(", "),
        };
      }
      case "relation": {
        this.assertRelationTargetAllowed(ontology, profileName, schema);
        const prevItems = this.extractCurrentList(currentProp);
        const items = rawVal.split(",").map((s) => s.trim()).filter(Boolean);
        const ids = [...new Set(items.map((v) => this.parseRelationUuid(schema.name, v)))];
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { relation: ids.map((id) => ({ id })) },
          previousItems: prevItems,
          nextItems: ids,
          previousFormatted,
          nextFormatted: ids.join(", "),
        };
      }
      case "number": {
        const num = Number(rawVal);
        if (!Number.isFinite(num)) {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Property "${schema.name}" requires a valid number (got "${rawVal}").`,
          );
        }
        const bounds = dbOverlay.numeric_bounds[schema.id];
        if (bounds) {
          if (bounds.min !== undefined && num < bounds.min) {
            throw new AxiError(
              "VALIDATION_ERROR",
              `Property "${schema.name}" value ${num} is below configured minimum ${bounds.min}.`,
            );
          }
          if (bounds.max !== undefined && num > bounds.max) {
            throw new AxiError(
              "VALIDATION_ERROR",
              `Property "${schema.name}" value ${num} exceeds configured maximum ${bounds.max}.`,
            );
          }
        }
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { number: num },
          previousFormatted,
          nextFormatted: String(num),
        };
      }
      case "checkbox": {
        const lower = rawVal.toLowerCase();
        if (lower !== "true" && lower !== "false") {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Property "${schema.name}" requires "true" or "false" (got "${rawVal}").`,
          );
        }
        const checked = lower === "true";
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { checkbox: checked },
          previousFormatted,
          nextFormatted: String(checked),
        };
      }
      case "date": {
        const parts = rawVal.split("..").map((s) => s.trim());
        const start = parts[0]!;
        const end = parts[1] || null;
        if (!/^\d{4}-\d{2}-\d{2}/.test(start)) {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Property "${schema.name}" requires ISO-8601 date YYYY-MM-DD (got "${rawVal}").`,
          );
        }
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { date: end ? { start, end } : { start } },
          previousFormatted,
          nextFormatted: rawVal,
        };
      }
      case "url": {
        try {
          const parsed = new URL(rawVal);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("invalid protocol");
          }
        } catch {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Property "${schema.name}" requires a valid http(s) URL (got "${rawVal}").`,
          );
        }
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { url: rawVal },
          previousFormatted,
          nextFormatted: rawVal,
        };
      }
      case "email":
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { email: rawVal },
          previousFormatted,
          nextFormatted: rawVal,
        };
      case "phone_number":
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { phone_number: rawVal },
          previousFormatted,
          nextFormatted: rawVal,
        };
      case "verification": {
        const state = rawVal.toLowerCase();
        if (state !== "verified" && state !== "unverified") {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Wiki verification "${schema.name}" accepts "verified" or "unverified" (got "${rawVal}").`,
          );
        }
        // Strip Notion-managed verified_by; write state only.
        return {
          op: "set",
          schema,
          rawInputValue: rawVal,
          notionPayload: { verification: { state } },
          previousFormatted,
          nextFormatted: state,
        };
      }
      default:
        throw new AxiError(
          "VALIDATION_ERROR",
          `Writing property "${schema.name}" of type "${schema.type}" is not supported.`,
        );
    }
  }

  /**
   * Deterministic zero-LLM validation with at most 1 reactive schema refresh on drift.
   */
  async validate(params: {
    ontology: OntologyConfig;
    profileName: string;
    alias: string;
    mode: "create" | "update";
    mutations: RawPropertyMutation[];
    currentPage?: NotionPage;
  }): Promise<ValidationResult> {
    // Check (a): Agent Scope write permission.
    this.scopeGuard.assertDatabaseAccess(
      params.ontology,
      params.profileName,
      params.alias,
      "write",
    );

    const dbOverlay = params.ontology.databases[params.alias];
    if (!dbOverlay) {
      throw new AxiError("NOT_FOUND", `Unknown database alias "${params.alias}".`);
    }

    // Check (b): schema availability, refreshing at most once on unknown property/option.
    const cachedDs = await this.loadDataSourceSchema(
      params.ontology,
      dbOverlay.data_source_id,
      false,
    );

    try {
      return this.buildValidatedChanges({
        ...params,
        cachedDs,
      });
    } catch (err) {
      if (err instanceof SchemaDriftError) {
        const refreshed = await this.loadDataSourceSchema(
          params.ontology,
          dbOverlay.data_source_id,
          true,
        );
        return this.buildValidatedChanges({
          ...params,
          cachedDs: refreshed,
        });
      }
      throw err;
    }
  }
}
