import { AxiError } from "../../shared/errors.js";
import { normalizeNfd } from "../../shared/text.js";
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
import {
  assertRelationTargetAllowed,
  buildClearPayload,
  buildSetPayload,
  extractCurrentList,
  type MutationOp,
  type NotionWritePropertyPayload,
  parseRelationUuid,
  SchemaDriftError,
  snapValidOption,
  UnknownOptionError,
  type ValidatedPropertyChange,
} from "./property-payload-builder.js";

export {
  type MutationOp,
  type NotionWritePropertyPayload,
  UnknownOptionError,
  type ValidatedPropertyChange,
};

export interface RawPropertyMutation {
  op: MutationOp;
  property: string;
  value?: string;
}

export interface ValidationResult {
  cachedDs: CachedDataSource;
  changes: ValidatedPropertyChange[];
  notionProperties: Record<string, Record<string, unknown>>;
  titleValue?: string;
}

const OPTION_FIELD_TYPES = new Set(["select", "multi_select", "status"]);

export class WriteValidator {
  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
    private readonly scopeGuard: ScopeGuard,
  ) {}

  async refreshDataSourceSchema(
    ontology: OntologyConfig,
    dataSourceId: string,
  ): Promise<CachedDataSource> {
    return this.loadDataSourceSchema(ontology, dataSourceId, true);
  }

  private async loadDataSourceSchema(
    ontology: OntologyConfig,
    dataSourceId: string,
    forceRefresh: boolean,
  ): Promise<CachedDataSource> {
    const cache = await this.store.readCache();
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

  private findCurrentProperty(
    currentPage: NotionPage | undefined,
    schema: CachedProperty,
  ): NotionPropertyValue | undefined {
    if (!currentPage) return undefined;
    return (
      currentPage.properties[schema.name] ??
      Object.values(currentPage.properties).find((p) => p.id === schema.id)
    );
  }

  private async enrichEmptySchemaOptions(
    cachedDs: CachedDataSource,
    mutations: RawPropertyMutation[],
    cachedRows?: NotionPage[],
  ): Promise<{ ds: CachedDataSource; rows?: NotionPage[] }> {
    const needsDiscovery = mutations.some((mut) => {
      if (mut.op === "clear") return false;
      const schema = this.findProperty(cachedDs, mut.property);
      return (
        schema !== undefined &&
        OPTION_FIELD_TYPES.has(schema.type) &&
        (schema.options?.length ?? 0) === 0
      );
    });
    if (!needsDiscovery) return { ds: cachedDs, rows: cachedRows };

    let rows = cachedRows;
    if (!rows) {
      const resp = await this.notion.queryDataSource(cachedDs.data_source_id, {
        page_size: 20,
      });
      rows = resp.results.filter((item): item is NotionPage => item.object === "page");
    }

    const updatedProperties: Record<string, CachedProperty> = { ...cachedDs.properties };
    for (const [id, schema] of Object.entries(cachedDs.properties)) {
      if (!OPTION_FIELD_TYPES.has(schema.type) || (schema.options?.length ?? 0) > 0) {
        continue;
      }
      const discovered = new Set<string>();
      for (const row of rows) {
        const prop = this.findCurrentProperty(row, schema);
        if (!prop) continue;
        if (prop.type === "select" && prop.select?.name) {
          discovered.add(prop.select.name);
        } else if (prop.type === "status" && prop.status?.name) {
          discovered.add(prop.status.name);
        } else if (prop.type === "multi_select") {
          for (const opt of prop.multi_select ?? []) {
            if (opt.name) discovered.add(opt.name);
          }
        }
      }
      if (discovered.size > 0) {
        updatedProperties[id] = { ...schema, options: [...discovered] };
      }
    }

    return { ds: { ...cachedDs, properties: updatedProperties }, rows };
  }

  private async fetchFullRelationItems(
    currentPage: NotionPage | undefined,
    schemas: CachedProperty[],
  ): Promise<Map<string, string[]>> {
    const fullById = new Map<string, string[]>();
    if (!currentPage) return fullById;

    for (const schema of schemas) {
      if (schema.type !== "relation" || fullById.has(schema.id)) continue;
      const currentProp = this.findCurrentProperty(currentPage, schema);
      if (currentProp?.type !== "relation" || !currentProp.has_more) continue;

      const collected: string[] = [];
      const propertyId = currentProp.id ?? schema.id;
      let cursor: string | undefined;
      do {
        const page = await this.notion.listPagePropertyItems(
          currentPage.id,
          propertyId,
          cursor,
        );
        for (const item of page.results) {
          if (item.relation?.id) collected.push(item.relation.id);
        }
        cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
      } while (cursor);

      fullById.set(schema.id, [...new Set(collected)]);
    }
    return fullById;
  }

  private consolidateArrayProperty(params: {
    ontology: OntologyConfig;
    profileName: string;
    alias: string;
    schema: CachedProperty;
    muts: RawPropertyMutation[];
    prevItems: string[];
    previousFormatted: string;
    allowDriftRetry: boolean;
  }): ValidatedPropertyChange {
    const {
      ontology,
      profileName,
      alias,
      schema,
      muts,
      prevItems,
      previousFormatted,
      allowDriftRetry,
    } = params;

    if (schema.type === "relation") {
      assertRelationTargetAllowed(this.scopeGuard, ontology, profileName, schema);
    }

    let working = [...prevItems];
    const ops: MutationOp[] = [];
    const rawInputs: string[] = [];

    for (const mut of muts) {
      if (mut.op === "clear") {
        working = [];
        ops.push("clear");
        continue;
      }
      const rawVal = (mut.value ?? "").trim();
      if (mut.op === "set" && rawVal === "") {
        working = [];
        ops.push("clear");
        rawInputs.push("");
        continue;
      }
      if (!rawVal) {
        throw new AxiError(
          "VALIDATION_ERROR",
          `Operation --${mut.op} on "${schema.name}" requires a non-empty value.`,
        );
      }

      rawInputs.push(rawVal);
      const inputItems = rawVal.split(",").map((s) => s.trim()).filter(Boolean);
      const parsed =
        schema.type === "multi_select"
          ? inputItems.map((v) => snapValidOption(alias, schema, v, allowDriftRetry))
          : inputItems.map((v) => parseRelationUuid(schema.name, v));

      if (mut.op === "set") {
        working = [...new Set(parsed)];
        ops.push("set");
      } else if (mut.op === "add") {
        working = [...new Set([...working, ...parsed])];
        ops.push("add");
      } else {
        const toRemove =
          schema.type === "multi_select"
            ? new Set(parsed.map((s) => normalizeNfd(s)))
            : new Set(parsed);
        working = working.filter((item) =>
          schema.type === "multi_select"
            ? !toRemove.has(normalizeNfd(item))
            : !toRemove.has(item),
        );
        ops.push("remove");
      }
    }

    let finalOp: MutationOp;
    if (working.length === 0 && ops[ops.length - 1] === "clear") {
      finalOp = "clear";
    } else if (ops.every((o) => o === "add")) {
      finalOp = "add";
    } else if (ops.every((o) => o === "remove")) {
      finalOp = "remove";
    } else {
      finalOp = "set";
    }

    const notionPayload: NotionWritePropertyPayload =
      finalOp === "clear"
        ? buildClearPayload(schema)
        : schema.type === "multi_select"
          ? { multi_select: working.map((name) => ({ name })) }
          : { relation: working.map((id) => ({ id })) };

    return {
      op: finalOp,
      schema,
      ...(rawInputs.length > 0 ? { rawInputValue: rawInputs.join(", ") } : {}),
      notionPayload,
      previousItems: prevItems,
      nextItems: working,
      previousFormatted,
      nextFormatted: working.join(", "),
    };
  }

  private buildValidatedChanges(params: {
    ontology: OntologyConfig;
    profileName: string;
    alias: string;
    cachedDs: CachedDataSource;
    mode: "create" | "update";
    mutations: RawPropertyMutation[];
    currentPage?: NotionPage;
    fullRelationItems: Map<string, string[]>;
    allowDriftRetry: boolean;
  }): ValidationResult {
    const {
      ontology,
      profileName,
      alias,
      cachedDs,
      mode,
      mutations,
      currentPage,
      fullRelationItems,
      allowDriftRetry,
    } = params;

    const dbOverlay = ontology.databases[alias];
    if (!dbOverlay) {
      throw new AxiError("NOT_FOUND", `Database alias "${alias}" not found in ontology.yaml.`);
    }

    // Resolve and group mutations by immutable schema.id preserving first-touch order.
    const grouped = new Map<string, { schema: CachedProperty; muts: RawPropertyMutation[] }>();
    for (const mut of mutations) {
      const schema = this.findProperty(cachedDs, mut.property);
      if (!schema) {
        const names = Object.values(cachedDs.properties)
          .filter((p) => !p.read_only)
          .map((p) => p.name);
        const msg = `Unknown property "${mut.property}" on database "${alias}".`;
        const help = [`Writable properties: ${names.join(", ")}`];
        if (allowDriftRetry) {
          throw new SchemaDriftError("VALIDATION_ERROR", msg, help);
        }
        throw new AxiError("VALIDATION_ERROR", msg, help);
      }
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

      const bucket = grouped.get(schema.id);
      if (bucket) {
        bucket.muts.push(mut);
      } else {
        grouped.set(schema.id, { schema, muts: [mut] });
      }
    }

    const changes: ValidatedPropertyChange[] = [];
    const notionProperties: Record<string, Record<string, unknown>> = {};
    const touchedById = new Map<string, string>();
    let titleValue: string | undefined;

    for (const { schema, muts } of grouped.values()) {
      const currentProp = this.findCurrentProperty(currentPage, schema);
      const overridePrev = fullRelationItems.get(schema.id);
      const prevItems = overridePrev ?? extractCurrentList(currentProp);
      const previousFormatted = overridePrev
        ? overridePrev.join(", ")
        : currentProp
          ? formatNotionPropertyValue(currentProp)
          : "";

      if (schema.type === "multi_select" || schema.type === "relation") {
        const change = this.consolidateArrayProperty({
          ontology,
          profileName,
          alias,
          schema,
          muts,
          prevItems,
          previousFormatted,
          allowDriftRetry,
        });
        notionProperties[schema.name] = change.notionPayload;
        touchedById.set(schema.id, change.nextFormatted ?? "");
        changes.push(change);
        continue;
      }

      let finalChange: ValidatedPropertyChange | undefined;
      for (const mut of muts) {
        if (mut.op === "add" || mut.op === "remove") {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Operation --${mut.op} is only supported on multi_select and relation properties (got "${schema.name}" of type ${schema.type}).`,
          );
        }
        const rawVal = (mut.value ?? "").trim();
        if (mut.op === "clear" || rawVal === "") {
          finalChange = {
            op: "clear",
            schema,
            ...(mut.op === "set" ? { rawInputValue: "" } : {}),
            notionPayload: buildClearPayload(schema),
            previousFormatted,
            nextFormatted: "",
          };
          if (schema.type === "title") titleValue = undefined;
          continue;
        }
        finalChange = buildSetPayload({
          scopeGuard: this.scopeGuard,
          ontology,
          profileName,
          alias,
          dbOverlay,
          schema,
          rawVal,
          previousItems: prevItems,
          previousFormatted,
          allowDriftRetry,
        });
        if (schema.type === "title") titleValue = rawVal;
      }

      if (finalChange) {
        notionProperties[schema.name] = finalChange.notionPayload;
        touchedById.set(schema.id, finalChange.nextFormatted ?? "");
        changes.push(finalChange);
      }
    }

    const requiredIds = new Set(dbOverlay.extra_required_fields.map((f) => f.property_id));

    if (mode === "create") {
      if (!titleValue || titleValue.trim().length === 0) {
        const titleProp = Object.values(cachedDs.properties).find((p) => p.type === "title");
        throw new AxiError(
          "VALIDATION_ERROR",
          `Creating a record in "${alias}" requires a non-empty title property ("${titleProp?.name ?? "Name"}").`,
        );
      }
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
    } else {
      for (const ch of changes) {
        const isEmpty =
          ch.op === "clear" ||
          (ch.nextFormatted ?? "").trim().length === 0 ||
          ((ch.schema.type === "multi_select" || ch.schema.type === "relation") &&
            (ch.nextItems?.length ?? 0) === 0);
        if (!isEmpty) continue;
        if (ch.schema.type === "title") {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Cannot leave required title property "${ch.schema.name}" empty in "${alias}".`,
          );
        }
        if (requiredIds.has(ch.schema.id)) {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Cannot leave required field "${ch.schema.name}" (property_id: "${ch.schema.id}") empty in "${alias}".`,
          );
        }
      }
    }

    return { cachedDs, changes, notionProperties, titleValue };
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
    skipDriftRefresh?: boolean;
  }): Promise<ValidationResult> {
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

    const cachedDs = await this.loadDataSourceSchema(
      params.ontology,
      dbOverlay.data_source_id,
      false,
    );

    let cachedRows: NotionPage[] | undefined;
    const relationCache = new Map<string, string[]>();

    const runPass = async (
      ds: CachedDataSource,
      allowDriftRetry: boolean,
    ): Promise<ValidationResult> => {
      const discovered = await this.enrichEmptySchemaOptions(ds, params.mutations, cachedRows);
      cachedRows = discovered.rows;
      const schemas = params.mutations
        .map((m) => this.findProperty(discovered.ds, m.property))
        .filter((s): s is CachedProperty => s !== undefined);
      const uncachedSchemas = schemas.filter((s) => !relationCache.has(s.id));
      if (uncachedSchemas.length > 0) {
        const fetched = await this.fetchFullRelationItems(params.currentPage, uncachedSchemas);
        for (const [k, v] of fetched) {
          relationCache.set(k, v);
        }
      }
      return this.buildValidatedChanges({
        ...params,
        cachedDs: discovered.ds,
        fullRelationItems: relationCache,
        allowDriftRetry,
      });
    };

    try {
      return await runPass(cachedDs, !params.skipDriftRefresh);
    } catch (err) {
      if (err instanceof SchemaDriftError && !params.skipDriftRefresh) {
        const refreshed = await this.loadDataSourceSchema(
          params.ontology,
          dbOverlay.data_source_id,
          true,
        );
        return await runPass(refreshed, false);
      }
      throw err;
    }
  }
}
