import crypto from "node:crypto";
import { AxiError } from "../../shared/errors.js";
import {
  classifyResolution,
  extractNotionUuid,
  normalizeNfd,
  sanitizeNotionUris,
  slugifyAlias,
  wrapUntrustedContent,
} from "../../shared/text.js";
import type {
  CacheSnapshot,
  CachedDataSource,
  CachedGuidePage,
  CachedProperty,
  CachedRelationEdge,
  CachedTaxonomyNode,
  NotionBlock,
  NotionDataSource,
  NotionDatabase,
  NotionFormulaValue,
  NotionPage,
  NotionPropertyValue,
  NotionRichText,
  NotionRollupValue,
  OntologyConfig,
} from "../../shared/types.js";
import type { MetadataStore, NotionGateway } from "../ports.js";
import type { OntologyEngine } from "../ontology/ontology-engine.js";
import { RenderService } from "../ontology/render-service.js";
import type { ScopeGuard } from "../scope/scope-guard.js";

const READ_ONLY_PROPERTY_TYPES = new Set([
  "formula",
  "rollup",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "button",
  "auto_increment_id",
  "unique_id",
]);

const LAYOUT_CONTAINER_BLOCKS = new Set([
  "column_list",
  "column",
  "toggle",
  "callout",
  "synced_block",
]);

export interface SetupDiscoveryResult {
  workspaceName: string;
  rootId: string;
  rootType: "page" | "wiki_database";
  rootDataSourceId?: string;
  wikiBlocksSupported: boolean | null;
  hubs: CachedTaxonomyNode[];
  dataSources: CachedDataSource[];
  unplacedDataSourceIds: string[];
  unmatchedUnsupportedHubIds: string[];
  ontology: OntologyConfig;
  cache: CacheSnapshot;
  apiCalls: number;
}

export interface SyncResult {
  syncedDataSources: number;
  staleGuidePages: string[];
  missingPropertyWarnings: string[];
  apiCalls: number;
}

export interface ReadPageResult {
  pageId: string;
  resolvedVia: "alias" | "search" | "raw_url" | "fractal";
  content: string;
  truncated: boolean;
  totalChars: number;
  nextOffset: number | null;
  unknownBlockIds: string[];
  apiCalls: number;
}

export interface QueryDatabaseResult {
  alias: string;
  dataSourceId: string;
  resolvedVia: "alias" | "search";
  nonce: string;
  rows: Array<{ id: string; fields: Record<string, string> }>;
  wrappedRows: string;
  hasMore: boolean;
  nextCursor: string | null;
  apiCalls: number;
}

function richTextToPlain(items?: NotionRichText[]): string {
  if (!items || items.length === 0) return "";
  return items.map((t) => t.plain_text).join("").trim();
}

function extractPageTitle(page: NotionPage): string {
  for (const val of Object.values(page.properties)) {
    if (val.type === "title") {
      return richTextToPlain(val.title);
    }
  }
  return "Untitled";
}

function hashObject(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function toCachedDataSource(
  ds: NotionDataSource,
  parentNodeId: string | null,
): CachedDataSource {
  const properties: Record<string, CachedProperty> = {};
  for (const [propName, schema] of Object.entries(ds.properties)) {
    let options: string[] | undefined;
    let relationTargetDataSourceId: string | undefined;
    let rollupRelationPropertyName: string | undefined;
    let formulaExpression: string | undefined;

    switch (schema.type) {
      case "select":
        options = schema.select.options.map((o) => o.name);
        break;
      case "multi_select":
        options = schema.multi_select.options.map((o) => o.name);
        break;
      case "status":
        options = schema.status.options.map((o) => o.name);
        break;
      case "relation":
        relationTargetDataSourceId = schema.relation.data_source_id;
        break;
      case "rollup":
        rollupRelationPropertyName = schema.rollup.relation_property_name;
        break;
      case "formula":
        formulaExpression = schema.formula.expression;
        break;
      default:
        break;
    }

    properties[schema.id] = {
      id: schema.id,
      name: schema.name ?? propName,
      type: schema.type,
      read_only: READ_ONLY_PROPERTY_TYPES.has(schema.type),
      ...(options ? { options } : {}),
      ...(relationTargetDataSourceId
        ? { relation_target_data_source_id: relationTargetDataSourceId }
        : {}),
      ...(rollupRelationPropertyName
        ? { rollup_relation_property_name: rollupRelationPropertyName }
        : {}),
      ...(formulaExpression ? { formula_expression: formulaExpression } : {}),
    };
  }

  const databaseId =
    ds.parent.type === "database_id" ? ds.parent.database_id : ds.id;
  const title = richTextToPlain(ds.title) || ds.name || "Untitled Database";

  return {
    data_source_id: ds.id,
    database_id: databaseId,
    title,
    parent_node_id: parentNodeId,
    last_edited_time: ds.last_edited_time,
    schema_hash: hashObject(properties),
    properties,
  };
}

function buildRelationEdges(
  dataSources: Record<string, CachedDataSource>,
): CachedRelationEdge[] {
  const edges: CachedRelationEdge[] = [];
  for (const ds of Object.values(dataSources)) {
    for (const prop of Object.values(ds.properties)) {
      if (prop.type === "relation" && prop.relation_target_data_source_id) {
        edges.push({
          from_data_source_id: ds.data_source_id,
          property_id: prop.id,
          property_name: prop.name,
          to_data_source_id: prop.relation_target_data_source_id,
        });
      }
    }
  }
  return edges;
}

function formatDateRange(d: { start: string; end?: string | null } | null): string {
  if (!d?.start) return "";
  return d.end ? `${d.start}..${d.end}` : d.start;
}

function formatFormulaValue(f: NotionFormulaValue | null | undefined): string {
  if (!f) return "";
  switch (f.type) {
    case "string":
      return f.string ?? "";
    case "number":
      return f.number === null || f.number === undefined ? "" : String(f.number);
    case "boolean":
      return f.boolean === null || f.boolean === undefined ? "" : String(f.boolean);
    case "date":
      return formatDateRange(f.date);
    default:
      return "";
  }
}

function formatRollupValue(r: NotionRollupValue | null | undefined): string {
  if (!r) return "";
  switch (r.type) {
    case "number":
      return r.number === null || r.number === undefined ? "" : String(r.number);
    case "date":
      return formatDateRange(r.date);
    case "array":
      return Array.isArray(r.array)
        ? r.array
            .map((item) => formatNotionPropertyValue(item))
            .filter(Boolean)
            .join(", ")
        : "";
    case "unsupported":
    case "incomplete":
    default:
      return "";
  }
}

export function formatNotionPropertyValue(raw: NotionPropertyValue | string | null | undefined): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  switch (raw.type) {
    case "title":
      return richTextToPlain(raw.title);
    case "rich_text":
      return richTextToPlain(raw.rich_text);
    case "status":
      return raw.status?.name ?? "";
    case "select":
      return raw.select?.name ?? "";
    case "multi_select":
      return (raw.multi_select ?? []).map((o) => o.name).join(", ");
    case "number":
      return raw.number === null || raw.number === undefined ? "" : String(raw.number);
    case "checkbox":
      return raw.checkbox ? "true" : "false";
    case "url":
      return raw.url ?? "";
    case "email":
      return raw.email ?? "";
    case "phone_number":
      return raw.phone_number ?? "";
    case "date":
      return formatDateRange(raw.date);
    case "relation":
      return (raw.relation ?? []).map((r) => r.id).join(", ");
    case "formula":
      return formatFormulaValue(raw.formula);
    case "rollup":
      return formatRollupValue(raw.rollup);
    case "created_time":
      return raw.created_time ?? "";
    case "last_edited_time":
      return raw.last_edited_time ?? "";
    case "created_by":
      return raw.created_by?.name ?? raw.created_by?.id ?? "";
    case "last_edited_by":
      return raw.last_edited_by?.name ?? raw.last_edited_by?.id ?? "";
    case "people":
      return (raw.people ?? []).map((u) => u.name ?? u.id).filter(Boolean).join(", ");
    case "files":
      return (raw.files ?? []).map((f) => f.name).filter(Boolean).join(", ");
    case "unique_id": {
      const uid = raw.unique_id;
      if (!uid || uid.number === null || uid.number === undefined) return "";
      return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
    }
    case "auto_increment_id": {
      const aid = raw.auto_increment_id;
      if (aid === null || aid === undefined) return "";
      if (typeof aid === "number") return String(aid);
      if (aid.number === null || aid.number === undefined) return "";
      return aid.prefix ? `${aid.prefix}-${aid.number}` : String(aid.number);
    }
    case "button":
      return "";
    case "verification":
      if (!raw.verification) return "";
      return raw.verification.date?.start
        ? `${raw.verification.state} (${raw.verification.date.start})`
        : raw.verification.state;
    case "unsupported":
    default:
      return "";
  }
}

function formatQueryRowLines(
  rows: Array<{ id: string; fields: Record<string, string> }>,
): string {
  return rows
    .map((row) => {
      const pairs = Object.entries(row.fields)
        .map(([k, v]) => `${k}=${v.replace(/\s+/g, " ").trim()}`)
        .join(" | ");
      return `  ${row.id} | ${pairs}`;
    })
    .join("\n");
}

export class SyncService {
  private readonly renderService: RenderService;

  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
    private readonly scopeGuard: ScopeGuard,
    private readonly ontologyEngine: OntologyEngine,
    renderService?: RenderService,
  ) {
    this.renderService = renderService ?? new RenderService(store, ontologyEngine);
  }

  getApiCallCount(): number {
    return this.notion.getCallCount();
  }

  private async listAllBlocksInContainer(
    blockId: string,
    maxDepth = 2,
    depth = 0,
  ): Promise<NotionBlock[]> {
    const collected: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const resp = await this.notion.listBlockChildren(blockId, cursor, 100);
      for (const block of resp.results) {
        collected.push(block);
        if (
          depth < maxDepth &&
          block.has_children &&
          LAYOUT_CONTAINER_BLOCKS.has(block.type)
        ) {
          const nested = await this.listAllBlocksInContainer(
            block.id,
            maxDepth,
            depth + 1,
          );
          collected.push(...nested);
        }
      }
      cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return collected;
  }

  /**
   * Bounded 2-level workspace discovery combining:
   * 1. Root page blocks + official Wiki root data_source query (result_type: "page" & "data_source")
   * 2. Paginated POST /v1/search (object: "data_source")
   * 3. Paginated GET /v1/views?data_source_id=... resolving view.parent.database_id back to hubs
   */
  async setupWorkspace(options: {
    rootUrlOrId: string;
    workspaceName?: string;
    profileName?: string;
    renderTarget?: string;
    apply?: boolean;
    allowPat?: boolean;
  }): Promise<SetupDiscoveryResult> {
    const startCalls = this.notion.getCallCount();
    const rootId = extractNotionUuid(options.rootUrlOrId);
    if (!rootId) {
      throw new AxiError(
        "INVALID_ARGUMENT",
        `Could not extract a valid Notion UUID from "${options.rootUrlOrId}".`,
      );
    }

    const me = await this.notion.getMe();
    if (me.type !== "bot" && !options.allowPat) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Refusing setup with non-bot token type "${me.type}" (Personal Access Tokens carry full user permissions).`,
        [
          "Use a Notion internal integration token (type=bot) scoped to shared pages, or pass --allow-pat to override explicitly.",
        ],
      );
    }

    // 1. Detect regular page vs native Wiki database.
    let rootType: "page" | "wiki_database" = "page";
    let rootTitle = options.workspaceName ?? "notion-wiki";
    let rootDataSourceId: string | undefined;
    let wikiBlocksSupported: boolean | null = null;
    const hubs: CachedTaxonomyNode[] = [];
    const directDbContainerToParent = new Map<string, string>();
    const directWikiDataSources: NotionDataSource[] = [];
    const unsupportedBlockIdsByHub = new Map<string, Set<string>>();

    let rootDatabase: NotionDatabase | null = null;
    try {
      rootDatabase = await this.notion.getDatabase(rootId);
      rootType = "wiki_database";
      rootTitle = options.workspaceName ?? (richTextToPlain(rootDatabase.title) || "notion-wiki");
      rootDataSourceId = rootDatabase.data_sources?.[0]?.id;
    } catch (err) {
      if (!(err instanceof AxiError) || (err.httpStatus !== 404 && err.httpStatus !== 400)) {
        throw err;
      }
      const rootPage = await this.notion.getPage(rootId);
      rootType = "page";
      rootTitle = options.workspaceName ?? (extractPageTitle(rootPage) || "notion-wiki");
    }

    // Enumerate level-1 hubs and direct child data sources.
    if (rootType === "wiki_database" && rootDataSourceId) {
      let cursor: string | undefined;
      do {
        const resp = await this.notion.queryDataSource(rootDataSourceId, {
          result_type: "page",
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        });
        for (const item of resp.results) {
          if (item.object === "page" && !item.in_trash) {
            hubs.push({
              page_id: item.id,
              title: extractPageTitle(item),
              parent_id: rootId,
            });
          }
        }
        cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
      } while (cursor);

      let dsCursor: string | undefined;
      do {
        const resp = await this.notion.queryDataSource(rootDataSourceId, {
          result_type: "data_source",
          page_size: 100,
          ...(dsCursor ? { start_cursor: dsCursor } : {}),
        });
        for (const item of resp.results) {
          if (item.object === "data_source" && item.id !== rootDataSourceId) {
            directWikiDataSources.push(item);
            if (item.parent.type === "database_id") {
              directDbContainerToParent.set(item.parent.database_id, rootId);
            } else if (item.parent.type === "page_id") {
              directDbContainerToParent.set(item.id, item.parent.page_id);
            }
          }
        }
        dsCursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
      } while (dsCursor);

      // Probe GET /v1/blocks/{rootId}/children once gracefully (Section 5 live check).
      try {
        const homeBlocks = await this.listAllBlocksInContainer(rootId, 2);
        wikiBlocksSupported = true;
        for (const block of homeBlocks) {
          if (block.type === "child_database") {
            directDbContainerToParent.set(block.id, rootId);
          } else if (block.type === "child_page") {
            if (!hubs.some((h) => h.page_id === block.id)) {
              hubs.push({
                page_id: block.id,
                title: block.child_page?.title ?? "Untitled",
                parent_id: rootId,
              });
            }
          }
        }
      } catch {
        wikiBlocksSupported = false;
      }
    } else {
      const rootBlocks = await this.listAllBlocksInContainer(rootId, 2);
      for (const block of rootBlocks) {
        if (block.type === "child_page") {
          hubs.push({
            page_id: block.id,
            title: block.child_page?.title ?? "Untitled",
            parent_id: rootId,
          });
        } else if (block.type === "child_database") {
          directDbContainerToParent.set(block.id, rootId);
        } else if (block.type === "unsupported") {
          const set = unsupportedBlockIdsByHub.get(rootId) ?? new Set<string>();
          set.add(block.id);
          unsupportedBlockIdsByHub.set(rootId, set);
        }
      }
    }

    // Level-2 bounded block scan inside each hub page (no database row reads).
    for (const hub of hubs) {
      const blocks = await this.listAllBlocksInContainer(hub.page_id, 2);
      for (const block of blocks) {
        if (block.type === "child_database") {
          directDbContainerToParent.set(block.id, hub.page_id);
        } else if (block.type === "unsupported") {
          const set = unsupportedBlockIdsByHub.get(hub.page_id) ?? new Set<string>();
          set.add(block.id);
          unsupportedBlockIdsByHub.set(hub.page_id, set);
        }
      }
    }

    // 2. Paginated POST /v1/search for all shared data_sources (excluding the root wiki data source).
    const discoveredDsById = new Map<string, NotionDataSource>();
    for (const ds of directWikiDataSources) {
      discoveredDsById.set(ds.id, ds);
    }
    let searchCursor: string | undefined;
    do {
      const resp = await this.notion.search({
        filter: { property: "object", value: "data_source" },
        page_size: 100,
        ...(searchCursor ? { start_cursor: searchCursor } : {}),
      });
      for (const item of resp.results) {
        if (item.object === "data_source" && item.id !== rootDataSourceId) {
          discoveredDsById.set(item.id, item);
        }
      }
      searchCursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (searchCursor);
    const discoveredDs = [...discoveredDsById.values()];

    // 3. Reconcile linked views via paginated GET /v1/views?data_source_id=...
    const matchedUnsupportedBlocks = new Set<string>();
    const dsToParentHub = new Map<string, string>();
    const approvedLinkedViewIds: string[] = [];
    const knownHubIds = new Set<string>([rootId, ...hubs.map((h) => h.page_id)]);

    for (const ds of discoveredDs) {
      const dbId = ds.parent.type === "database_id" ? ds.parent.database_id : ds.id;
      const directHub =
        directDbContainerToParent.get(dbId) ?? directDbContainerToParent.get(ds.id);
      if (directHub) {
        dsToParentHub.set(ds.id, directHub);
      }

      try {
        let viewCursor: string | undefined;
        do {
          const viewsResp = await this.notion.listViews({
            data_source_id: ds.id,
            ...(viewCursor ? { start_cursor: viewCursor } : {}),
          });
          for (const view of viewsResp.results) {
            if (view.parent.type === "database_id") {
              const viewDbId = view.parent.database_id;
              let matched = false;
              for (const [hubId, unsupSet] of unsupportedBlockIdsByHub.entries()) {
                if (unsupSet.has(viewDbId)) {
                  matchedUnsupportedBlocks.add(viewDbId);
                  if (!dsToParentHub.has(ds.id)) {
                    dsToParentHub.set(ds.id, hubId);
                  }
                  if (!approvedLinkedViewIds.includes(view.id)) {
                    approvedLinkedViewIds.push(view.id);
                  }
                  matched = true;
                }
              }
              // Fall back to GET /v1/databases/{view.parent.database_id} when view container wasn't matched directly.
              if (!matched && !dsToParentHub.has(ds.id)) {
                try {
                  const viewDb = await this.notion.getDatabase(viewDbId);
                  const parentPageId =
                    viewDb.parent.type === "page_id" ? viewDb.parent.page_id : null;
                  if (parentPageId && knownHubIds.has(parentPageId)) {
                    dsToParentHub.set(ds.id, parentPageId);
                    if (!approvedLinkedViewIds.includes(view.id)) {
                      approvedLinkedViewIds.push(view.id);
                    }
                  }
                } catch {
                  // Linked view container database inaccessible; leave unplaced for confirmation.
                }
              }
            }
          }
          viewCursor = viewsResp.has_more ? (viewsResp.next_cursor ?? undefined) : undefined;
        } while (viewCursor);
      } catch {
        // If Views API returns 404/403 on a data source, search reconciliation still surfaces it.
      }
    }

    const cachedDataSourcesRecord: Record<string, CachedDataSource> = {};
    const unplacedDataSourceIds: string[] = [];
    for (const ds of discoveredDs) {
      const parentHub = dsToParentHub.get(ds.id) ?? null;
      if (!parentHub) unplacedDataSourceIds.push(ds.id);
      cachedDataSourcesRecord[ds.id] = toCachedDataSource(ds, parentHub);
    }

    const unmatchedUnsupportedHubIds: string[] = [];
    for (const [hubId, unsupSet] of unsupportedBlockIdsByHub.entries()) {
      for (const blockId of unsupSet) {
        if (!matchedUnsupportedBlocks.has(blockId)) {
          unmatchedUnsupportedHubIds.push(hubId);
          break;
        }
      }
    }

    // Build starter ontology.yaml from discovered hubs and data sources.
    const usedAreaIds = new Set<string>();
    const hubIdToAreaId = new Map<string, string>();
    const taxonomy = hubs.map((hub) => {
      let areaId = slugifyAlias(hub.title);
      let suffix = 2;
      while (usedAreaIds.has(areaId)) {
        areaId = `${slugifyAlias(hub.title)}_${suffix++}`;
      }
      usedAreaIds.add(areaId);
      hubIdToAreaId.set(hub.page_id, areaId);
      return {
        id: areaId,
        label: hub.title,
        alt_labels: [],
        hub_page_id: hub.page_id,
      };
    });

    const usedDbAliases = new Set<string>();
    const databases: OntologyConfig["databases"] = {};
    for (const ds of Object.values(cachedDataSourcesRecord)) {
      let alias = slugifyAlias(ds.title);
      let suffix = 2;
      while (usedDbAliases.has(alias)) {
        alias = `${slugifyAlias(ds.title)}_${suffix++}`;
      }
      usedDbAliases.add(alias);
      const area = ds.parent_node_id
        ? (hubIdToAreaId.get(ds.parent_node_id) ?? "")
        : "";
      databases[alias] = {
        data_source_id: ds.data_source_id,
        area,
        purpose: `Store and query ${ds.title} records`,
        alt_labels: [],
        pinned_level0: false,
        extra_required_fields: [],
        numeric_bounds: {},
        stale_after_days: 30,
        allow_wiki_verification: false,
      };
    }

    const profileName = options.profileName ?? "default";
    const ontology: OntologyConfig = {
      version: 1,
      workspace: {
        name: slugifyAlias(rootTitle),
        root_id: rootId,
        root_type: rootType,
        approved_linked_view_ids: approvedLinkedViewIds,
      },
      taxonomy,
      databases,
      excluded_data_source_ids: [],
      guide: {
        enabled: false,
        summary_file: "guide-summary.md",
        user_pinned: false,
        pages: [],
      },
      agent_scopes: {
        [profileName]: {
          injection_mode: options.renderTarget ? "render" : "wakeup_on_demand",
          ...(options.renderTarget ? { render_target: options.renderTarget } : {}),
          allow_areas: ["*"],
          allow_databases: ["*"],
          deny_databases: [],
          allow_guide_pages: "all",
          read_only: false,
        },
      },
      maintenance: {
        enabled: false,
        mode: "deterministic",
        max_pages: 200,
        report_page_id: null,
      },
    };

    const cache: CacheSnapshot = {
      schema_version: 1,
      synced_at: new Date().toISOString(),
      root: {
        id: rootId,
        type: rootType,
        is_wiki: rootType === "wiki_database",
        ...(rootDataSourceId ? { root_data_source_id: rootDataSourceId } : {}),
      },
      taxonomy_nodes: hubs,
      data_sources: cachedDataSourcesRecord,
      relation_edges: buildRelationEdges(cachedDataSourcesRecord),
      guide_pages: [],
    };

    if (options.apply !== false) {
      await this.store.writeOntology(ontology);
      await this.store.writeCache(cache);
      if (options.renderTarget) {
        await this.renderService.renderProfile(profileName);
      }
    }

    return {
      workspaceName: ontology.workspace.name,
      rootId,
      rootType,
      rootDataSourceId,
      wikiBlocksSupported,
      hubs,
      dataSources: Object.values(cachedDataSourcesRecord),
      unplacedDataSourceIds,
      unmatchedUnsupportedHubIds,
      ontology,
      cache,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  /**
   * Notion-wins structural sync: strictly read-only on ontology.yaml;
   * refreshes confirmed data_source_ids and guide_pages timestamps into cache.json.
   */
  async syncWorkspace(options: { noRender?: boolean } = {}): Promise<SyncResult> {
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const prevCache = await this.store.readCache();

    const dataSources: Record<string, CachedDataSource> = {};
    const missingPropertyWarnings: string[] = [];

    for (const [alias, dbOverlay] of Object.entries(ontology.databases)) {
      const ds = await this.notion.getDataSource(dbOverlay.data_source_id);
      const prevParent = prevCache?.data_sources[dbOverlay.data_source_id]?.parent_node_id ?? null;
      const cached = toCachedDataSource(ds, prevParent);
      dataSources[cached.data_source_id] = cached;

      // Verify property_id bindings in ontology.yaml survived Notion edits.
      for (const reqField of dbOverlay.extra_required_fields) {
        if (!cached.properties[reqField.property_id]) {
          missingPropertyWarnings.push(
            `Database "${alias}": required property_id "${reqField.property_id}" (label "${reqField.label}") no longer exists in Notion.`,
          );
        }
      }
    }

    const guidePages: CachedGuidePage[] = [];
    const staleGuidePages: string[] = [];
    for (const pageCfg of ontology.guide.pages) {
      const page = await this.notion.getPage(pageCfg.page_id);
      const prevGuide = prevCache?.guide_pages.find((g) => g.page_id === pageCfg.page_id);
      const summarySyncedAt = prevGuide?.summary_synced_at ?? null;
      const isStale =
        summarySyncedAt !== null && page.last_edited_time > summarySyncedAt;
      if (isStale) staleGuidePages.push(pageCfg.title);
      guidePages.push({
        page_id: pageCfg.page_id,
        title: extractPageTitle(page) || pageCfg.title,
        last_edited_time: page.last_edited_time,
        summary_synced_at: summarySyncedAt,
        summary_stale: isStale,
      });
    }

    const snapshot: CacheSnapshot = {
      schema_version: 1,
      synced_at: new Date().toISOString(),
      root: prevCache?.root ?? {
        id: ontology.workspace.root_id,
        type: ontology.workspace.root_type,
        is_wiki: ontology.workspace.root_type === "wiki_database",
      },
      taxonomy_nodes: prevCache?.taxonomy_nodes ?? [],
      data_sources: dataSources,
      relation_edges: buildRelationEdges(dataSources),
      guide_pages: guidePages,
    };

    await this.store.writeCache(snapshot);
    if (!options.noRender) {
      await this.renderService.renderAllRenderProfiles();
    }

    return {
      syncedDataSources: Object.keys(dataSources).length,
      staleGuidePages,
      missingPropertyWarnings,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  async readPage(
    profileName: string,
    targetInput: string,
    options: { full?: boolean; offset?: number } = {},
  ): Promise<ReadPageResult> {
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();
    const fractals = await this.store.readFractalPointers();

    const guideMatch = this.ontologyEngine.resolveGuidePage(
      ontology,
      profileName,
      targetInput,
    );
    const pageId = guideMatch ? guideMatch.pageId : extractNotionUuid(targetInput);
    if (!pageId) {
      throw new AxiError(
        "INVALID_ARGUMENT",
        `Expected a Notion page UUID, URL, or guide alias for \`wiki read\`, got "${targetInput}".`,
      );
    }

    await this.scopeGuard.verifyUuidInRootScope(
      ontology,
      cache,
      fractals,
      this.notion,
      profileName,
      pageId,
    );

    const mdResp = await this.notion.getPageMarkdown(pageId);
    const sanitized = sanitizeNotionUris(mdResp.markdown);
    const maxChars = options.full ? 6_000 : 1_500;
    const offset = Math.max(0, options.offset ?? 0);
    const slice = sanitized.slice(offset, offset + maxChars);
    const hasMoreLocal = offset + maxChars < sanitized.length;
    const nonce = crypto.randomBytes(8).toString("hex");
    const wrapped = wrapUntrustedContent(slice, nonce);

    return {
      pageId,
      resolvedVia: guideMatch ? "alias" : classifyResolution(targetInput, "alias"),
      content: wrapped,
      truncated: mdResp.truncated || hasMoreLocal,
      totalChars: sanitized.length,
      nextOffset: hasMoreLocal ? offset + maxChars : null,
      unknownBlockIds: mdResp.unknown_block_ids ?? [],
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  async queryDatabase(
    profileName: string,
    databaseQuery: string,
    options: {
      where?: string[];
      fields?: string[];
      limit?: number;
      cursor?: string;
      follow?: string;
    } = {},
  ): Promise<QueryDatabaseResult> {
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    let cache = await this.store.readCache();

    const resolved = this.ontologyEngine.resolveDatabase(
      ontology,
      cache,
      profileName,
      databaseQuery,
    );
    this.scopeGuard.assertDatabaseAccess(ontology, profileName, resolved.alias, "read");

    // Ensure schema is available for filter building and scope filtering (fail closed otherwise).
    if (!cache?.data_sources[resolved.dataSourceId]) {
      const liveDs = await this.notion.getDataSource(resolved.dataSourceId);
      const cachedDs = toCachedDataSource(liveDs, null);
      cache = {
        schema_version: 1,
        synced_at: new Date().toISOString(),
        root: cache?.root ?? {
          id: ontology.workspace.root_id,
          type: ontology.workspace.root_type,
          is_wiki: ontology.workspace.root_type === "wiki_database",
        },
        taxonomy_nodes: cache?.taxonomy_nodes ?? [],
        data_sources: {
          ...(cache?.data_sources ?? {}),
          [cachedDs.data_source_id]: cachedDs,
        },
        relation_edges: buildRelationEdges({
          ...(cache?.data_sources ?? {}),
          [cachedDs.data_source_id]: cachedDs,
        }),
        guide_pages: cache?.guide_pages ?? [],
      };
    }

    const cachedDs = cache.data_sources[resolved.dataSourceId];

    // Enforce Agent Scope on --follow <relation> before querying Notion.
    let followRelationName: string | null = null;
    let followTargetDsId: string | null = null;
    if (options.follow) {
      const followNorm = normalizeNfd(options.follow);
      const relSchema = cachedDs
        ? Object.values(cachedDs.properties).find(
            (p) =>
              p.type === "relation" &&
              (normalizeNfd(p.name) === followNorm || p.id === options.follow),
          )
        : undefined;
      if (!relSchema || !relSchema.relation_target_data_source_id) {
        throw new AxiError(
          "INVALID_ARGUMENT",
          `Property "${options.follow}" on "${resolved.alias}" is not a relation property with a known target.`,
        );
      }
      this.scopeGuard.assertDataSourceAccess(
        ontology,
        profileName,
        relSchema.relation_target_data_source_id,
      );
      followRelationName = relSchema.name;
      followTargetDsId = relSchema.relation_target_data_source_id;
    }

    const filter = this.buildFilter(options.where ?? [], cachedDs);
    const pageSize = Math.min(100, Math.max(1, options.limit ?? 20));

    const resp = await this.notion.queryDataSource(resolved.dataSourceId, {
      ...(filter ? { filter } : {}),
      page_size: pageSize,
      ...(options.cursor ? { start_cursor: options.cursor } : {}),
    });

    const requestedFields = options.fields
      ? new Set(options.fields.map((f) => normalizeNfd(f)))
      : null;

    const followedPageCache = new Map<string, string>();
    const rows: Array<{ id: string; fields: Record<string, string> }> = [];

    for (const item of resp.results) {
      if (item.object !== "page") continue;
      const scopedProps = this.scopeGuard.filterRecordProperties(
        ontology,
        cache,
        profileName,
        resolved.dataSourceId,
        item.properties,
      );
      const formatted: Record<string, string> = {};
      for (const [propName, propVal] of Object.entries(scopedProps)) {
        if (requestedFields && !requestedFields.has(normalizeNfd(propName))) {
          continue;
        }
        const str =
          typeof propVal === "string"
            ? propVal
            : sanitizeNotionUris(formatNotionPropertyValue(propVal));
        if (str !== "") {
          formatted[propName] = str;
        }
      }

      if (followRelationName && followTargetDsId) {
        const relProp = scopedProps[followRelationName];
        if (relProp && typeof relProp !== "string" && relProp.type === "relation") {
          const titles: string[] = [];
          for (const relRef of relProp.relation.slice(0, 5)) {
            let label = followedPageCache.get(relRef.id);
            if (label === undefined) {
              const targetPage = await this.notion.getPage(relRef.id);
              const filteredTarget = this.scopeGuard.filterRecordProperties(
                ontology,
                cache,
                profileName,
                followTargetDsId,
                targetPage.properties,
              );
              const titleProp = Object.values(filteredTarget).find(
                (v): v is Extract<NotionPropertyValue, { type: "title" }> =>
                  typeof v !== "string" && v.type === "title",
              );
              label = titleProp
                ? sanitizeNotionUris(formatNotionPropertyValue(titleProp))
                : relRef.id;
              followedPageCache.set(relRef.id, label);
            }
            titles.push(label);
          }
          if (titles.length > 0) {
            formatted[`${followRelationName}_titles`] = titles.join(", ");
          }
        }
      }

      rows.push({ id: item.id, fields: formatted });
    }

    const nonce = crypto.randomBytes(8).toString("hex");
    const wrappedRows =
      rows.length > 0
        ? wrapUntrustedContent(formatQueryRowLines(rows), nonce)
        : "  (no matching rows)";

    return {
      alias: resolved.alias,
      dataSourceId: resolved.dataSourceId,
      resolvedVia: resolved.resolvedVia,
      nonce,
      rows,
      wrappedRows,
      hasMore: resp.has_more,
      nextCursor: resp.next_cursor,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  private buildFilter(
    whereClauses: string[],
    cachedDs: CachedDataSource | undefined,
  ): Record<string, unknown> | undefined {
    if (whereClauses.length === 0) return undefined;

    const conditions: Array<Record<string, unknown>> = [];
    for (const clause of whereClauses) {
      const eqIdx = clause.indexOf("=");
      if (eqIdx <= 0) {
        throw new AxiError(
          "INVALID_ARGUMENT",
          `Invalid --where expression "${clause}". Expected "Property=Value".`,
        );
      }
      const rawProp = clause.slice(0, eqIdx).trim();
      const rawVal = clause.slice(eqIdx + 1).trim();

      const schema = cachedDs
        ? Object.values(cachedDs.properties).find(
            (p) => normalizeNfd(p.name) === normalizeNfd(rawProp) || p.id === rawProp,
          )
        : undefined;

      const propName = schema?.name ?? rawProp;
      const type = schema?.type ?? "rich_text";

      if (type === "status") {
        const snapped = snapOption(rawVal, schema?.options);
        conditions.push({ property: propName, status: { equals: snapped } });
      } else if (type === "select") {
        const snapped = snapOption(rawVal, schema?.options);
        conditions.push({ property: propName, select: { equals: snapped } });
      } else if (type === "multi_select") {
        const snapped = snapOption(rawVal, schema?.options);
        conditions.push({ property: propName, multi_select: { contains: snapped } });
      } else if (type === "checkbox") {
        conditions.push({
          property: propName,
          checkbox: { equals: rawVal.toLowerCase() === "true" },
        });
      } else if (type === "number") {
        const num = Number(rawVal);
        if (!Number.isFinite(num)) {
          throw new AxiError(
            "VALIDATION_ERROR",
            `Numeric filter on "${propName}" requires a number, got "${rawVal}".`,
          );
        }
        conditions.push({ property: propName, number: { equals: num } });
      } else if (type === "title") {
        conditions.push({ property: propName, title: { contains: rawVal } });
      } else {
        conditions.push({ property: propName, rich_text: { contains: rawVal } });
      }
    }

    return conditions.length === 1 ? conditions[0] : { and: conditions };
  }
}

function snapOption(value: string, validOptions?: string[]): string {
  if (!validOptions || validOptions.length === 0) return value;
  const norm = normalizeNfd(value);
  const match = validOptions.find((o) => normalizeNfd(o) === norm);
  return match ?? value;
}
