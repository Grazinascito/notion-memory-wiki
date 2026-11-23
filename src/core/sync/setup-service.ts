import { AxiError } from "../../shared/errors.js";
import { extractNotionUuid, slugifyAlias } from "../../shared/text.js";
import type {
  CacheSnapshot,
  CachedDataSource,
  CachedTaxonomyNode,
  NotionBlock,
  NotionDataSource,
  OntologyConfig,
} from "../../shared/types.js";
import type { RenderService } from "../ontology/render-service.js";
import type { MetadataStore, NotionGateway } from "../ports.js";
import {
  buildRelationEdges,
  extractPageTitle,
  makeUniqueSlug,
  richTextToPlain,
  toCachedDataSource,
} from "./notion-mapper.js";

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

function recordUnsupported(map: Map<string, Set<string>>, hubId: string, blockId: string): void {
  let set = map.get(hubId);
  if (!set) {
    set = new Set<string>();
    map.set(hubId, set);
  }
  set.add(blockId);
}

export class SetupService {
  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
    private readonly renderService: RenderService,
  ) {}

  getApiCallCount(): number {
    return this.notion.getCallCount();
  }

  /**
   * Bounded 2-level workspace discovery combining root blocks/wiki query,
   * paginated POST /v1/search, and paginated GET /v1/views reconciliation.
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

    await this.assertBotIntegration(options.allowPat);
    const root = await this.detectRoot(rootId, options.workspaceName);
    const discovery = await this.discoverHubs(rootId, root.rootType, root.rootDataSourceId);
    const discoveredDs = await this.discoverSharedDataSources(
      root.rootDataSourceId,
      discovery.directWikiDataSources,
    );
    const reconciled = await this.reconcileLinkedViews(
      discoveredDs,
      discovery.directDbContainerToParent,
      discovery.unsupportedBlockIdsByHub,
      [rootId, ...discovery.hubs.map((h) => h.page_id)],
    );

    const cachedDataSources: Record<string, CachedDataSource> = {};
    const unplacedDataSourceIds: string[] = [];
    for (const ds of discoveredDs) {
      const parentHub = reconciled.dsToParentHub.get(ds.id) ?? null;
      if (!parentHub) unplacedDataSourceIds.push(ds.id);
      cachedDataSources[ds.id] = toCachedDataSource(ds, parentHub);
    }

    const unmatchedUnsupportedHubIds = [...discovery.unsupportedBlockIdsByHub.entries()]
      .filter(([, unsup]) => [...unsup].some((id) => !reconciled.matchedUnsupportedBlocks.has(id)))
      .map(([hubId]) => hubId);

    const profileName = options.profileName ?? "default";
    const ontology = this.buildStarterOntology({
      rootId,
      rootType: root.rootType,
      rootTitle: root.rootTitle,
      profileName,
      renderTarget: options.renderTarget,
      hubs: discovery.hubs,
      cachedDataSources,
      approvedLinkedViewIds: reconciled.approvedLinkedViewIds,
    });

    const cache: CacheSnapshot = {
      schema_version: 1,
      synced_at: new Date().toISOString(),
      root: {
        id: rootId,
        type: root.rootType,
        is_wiki: root.rootType === "wiki_database",
        ...(root.rootDataSourceId ? { root_data_source_id: root.rootDataSourceId } : {}),
      },
      taxonomy_nodes: discovery.hubs,
      data_sources: cachedDataSources,
      relation_edges: buildRelationEdges(cachedDataSources),
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
      rootType: root.rootType,
      rootDataSourceId: root.rootDataSourceId,
      wikiBlocksSupported: discovery.wikiBlocksSupported,
      hubs: discovery.hubs,
      dataSources: Object.values(cachedDataSources),
      unplacedDataSourceIds,
      unmatchedUnsupportedHubIds,
      ontology,
      cache,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  private async assertBotIntegration(allowPat?: boolean): Promise<void> {
    const me = await this.notion.getMe();
    if (me.type !== "bot" && !allowPat) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Refusing setup with non-bot token type "${me.type}" (Personal Access Tokens carry full user permissions).`,
        [
          "Use a Notion internal integration token (type=bot) scoped to shared pages, or pass --allow-pat to override explicitly.",
        ],
      );
    }
  }

  private async detectRoot(
    rootId: string,
    workspaceName?: string,
  ): Promise<{ rootType: "page" | "wiki_database"; rootTitle: string; rootDataSourceId?: string }> {
    try {
      const db = await this.notion.getDatabase(rootId);
      return {
        rootType: "wiki_database",
        rootTitle: workspaceName ?? (richTextToPlain(db.title) || "notion-wiki"),
        rootDataSourceId: db.data_sources?.[0]?.id,
      };
    } catch (err) {
      if (!(err instanceof AxiError) || (err.httpStatus !== 404 && err.httpStatus !== 400)) {
        throw err;
      }
      const page = await this.notion.getPage(rootId);
      return {
        rootType: "page",
        rootTitle: workspaceName ?? (extractPageTitle(page) || "notion-wiki"),
      };
    }
  }

  private async discoverHubs(
    rootId: string,
    rootType: "page" | "wiki_database",
    rootDataSourceId?: string,
  ) {
    const hubs: CachedTaxonomyNode[] = [];
    const directDbContainerToParent = new Map<string, string>();
    const directWikiDataSources: NotionDataSource[] = [];
    const unsupportedBlockIdsByHub = new Map<string, Set<string>>();
    let wikiBlocksSupported: boolean | null = null;

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
            hubs.push({ page_id: item.id, title: extractPageTitle(item), parent_id: rootId });
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

      try {
        await this.scanContainerBlocks(rootId, {
          hubs,
          directDbContainerToParent,
          unsupportedBlockIdsByHub,
          collectChildPages: true,
          recordUnsupportedBlocks: false,
        });
        wikiBlocksSupported = true;
      } catch {
        wikiBlocksSupported = false;
      }
    } else {
      await this.scanContainerBlocks(rootId, {
        hubs,
        directDbContainerToParent,
        unsupportedBlockIdsByHub,
        collectChildPages: true,
        recordUnsupportedBlocks: true,
      });
    }

    for (const hub of hubs) {
      await this.scanContainerBlocks(hub.page_id, {
        hubs,
        directDbContainerToParent,
        unsupportedBlockIdsByHub,
        collectChildPages: false,
        recordUnsupportedBlocks: true,
      });
    }

    return {
      hubs,
      directDbContainerToParent,
      directWikiDataSources,
      unsupportedBlockIdsByHub,
      wikiBlocksSupported,
    };
  }

  private async discoverSharedDataSources(
    rootDataSourceId: string | undefined,
    directWikiDataSources: NotionDataSource[],
  ): Promise<NotionDataSource[]> {
    const byId = new Map<string, NotionDataSource>();
    for (const ds of directWikiDataSources) byId.set(ds.id, ds);
    let cursor: string | undefined;
    do {
      const resp = await this.notion.search({
        filter: { property: "object", value: "data_source" },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const item of resp.results) {
        if (item.object === "data_source" && item.id !== rootDataSourceId) {
          byId.set(item.id, item);
        }
      }
      cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return [...byId.values()];
  }

  private async reconcileLinkedViews(
    discoveredDs: NotionDataSource[],
    directDbContainerToParent: Map<string, string>,
    unsupportedBlockIdsByHub: Map<string, Set<string>>,
    hubIds: string[],
  ) {
    const matchedUnsupportedBlocks = new Set<string>();
    const dsToParentHub = new Map<string, string>();
    const approvedViewIds = new Set<string>();
    const knownHubIds = new Set<string>(hubIds);

    for (const ds of discoveredDs) {
      const dbId = ds.parent.type === "database_id" ? ds.parent.database_id : ds.id;
      const directHub =
        directDbContainerToParent.get(dbId) ?? directDbContainerToParent.get(ds.id);
      if (directHub) dsToParentHub.set(ds.id, directHub);

      try {
        let viewCursor: string | undefined;
        do {
          const viewsResp = await this.notion.listViews({
            data_source_id: ds.id,
            ...(viewCursor ? { start_cursor: viewCursor } : {}),
          });
          for (const view of viewsResp.results) {
            if (view.parent.type !== "database_id") continue;
            const viewDbId = view.parent.database_id;
            let matched = false;
            for (const [hubId, unsupSet] of unsupportedBlockIdsByHub.entries()) {
              if (!unsupSet.has(viewDbId)) continue;
              matchedUnsupportedBlocks.add(viewDbId);
              if (!dsToParentHub.has(ds.id)) dsToParentHub.set(ds.id, hubId);
              approvedViewIds.add(view.id);
              matched = true;
            }
            if (!matched && !dsToParentHub.has(ds.id)) {
              try {
                const viewDb = await this.notion.getDatabase(viewDbId);
                const parentPageId =
                  viewDb.parent.type === "page_id" ? viewDb.parent.page_id : null;
                if (parentPageId && knownHubIds.has(parentPageId)) {
                  dsToParentHub.set(ds.id, parentPageId);
                  approvedViewIds.add(view.id);
                }
              } catch {
                // Linked view container database inaccessible; leave unplaced for confirmation.
              }
            }
          }
          viewCursor = viewsResp.has_more ? (viewsResp.next_cursor ?? undefined) : undefined;
        } while (viewCursor);
      } catch {
        // If Views API returns 404/403 on a data source, search reconciliation still surfaces it.
      }
    }

    return {
      dsToParentHub,
      approvedLinkedViewIds: [...approvedViewIds],
      matchedUnsupportedBlocks,
    };
  }

  private buildStarterOntology(params: {
    rootId: string;
    rootType: "page" | "wiki_database";
    rootTitle: string;
    profileName: string;
    renderTarget?: string;
    hubs: CachedTaxonomyNode[];
    cachedDataSources: Record<string, CachedDataSource>;
    approvedLinkedViewIds: string[];
  }): OntologyConfig {
    const usedAreaIds = new Set<string>();
    const hubIdToAreaId = new Map<string, string>();
    const taxonomy = params.hubs.map((hub) => {
      const areaId = makeUniqueSlug(hub.title, usedAreaIds);
      hubIdToAreaId.set(hub.page_id, areaId);
      return { id: areaId, label: hub.title, alt_labels: [], hub_page_id: hub.page_id };
    });

    const usedDbAliases = new Set<string>();
    const databases: OntologyConfig["databases"] = {};
    for (const ds of Object.values(params.cachedDataSources)) {
      const alias = makeUniqueSlug(ds.title, usedDbAliases);
      databases[alias] = {
        data_source_id: ds.data_source_id,
        area: ds.parent_node_id ? (hubIdToAreaId.get(ds.parent_node_id) ?? "") : "",
        purpose: `Store and query ${ds.title} records`,
        alt_labels: [],
        pinned_level0: false,
        extra_required_fields: [],
        numeric_bounds: {},
        stale_after_days: 30,
        allow_wiki_verification: false,
      };
    }

    return {
      version: 1,
      workspace: {
        name: slugifyAlias(params.rootTitle),
        root_id: params.rootId,
        root_type: params.rootType,
        approved_linked_view_ids: params.approvedLinkedViewIds,
      },
      taxonomy,
      databases,
      excluded_data_source_ids: [],
      guide: { enabled: false, summary_file: "guide-summary.md", user_pinned: false, pages: [] },
      agent_scopes: {
        [params.profileName]: {
          injection_mode: params.renderTarget ? "render" : "wakeup_on_demand",
          ...(params.renderTarget ? { render_target: params.renderTarget } : {}),
          allow_areas: ["*"],
          allow_databases: ["*"],
          deny_databases: [],
          allow_guide_pages: "all",
          read_only: false,
        },
      },
      maintenance: { enabled: false, mode: "deterministic", max_pages: 200, report_page_id: null },
    };
  }

  private async scanContainerBlocks(
    containerId: string,
    opts: {
      hubs: CachedTaxonomyNode[];
      directDbContainerToParent: Map<string, string>;
      unsupportedBlockIdsByHub: Map<string, Set<string>>;
      collectChildPages: boolean;
      recordUnsupportedBlocks: boolean;
    },
  ): Promise<void> {
    for (const block of await this.listAllBlocksInContainer(containerId, 2)) {
      if (block.type === "child_database") {
        opts.directDbContainerToParent.set(block.id, containerId);
      } else if (
        opts.collectChildPages &&
        block.type === "child_page" &&
        !opts.hubs.some((h) => h.page_id === block.id)
      ) {
        opts.hubs.push({
          page_id: block.id,
          title: block.child_page?.title ?? "Untitled",
          parent_id: containerId,
        });
      } else if (opts.recordUnsupportedBlocks && block.type === "unsupported") {
        recordUnsupported(opts.unsupportedBlockIdsByHub, containerId, block.id);
      }
    }
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
        if (depth < maxDepth && block.has_children && LAYOUT_CONTAINER_BLOCKS.has(block.type)) {
          collected.push(...(await this.listAllBlocksInContainer(block.id, maxDepth, depth + 1)));
        }
      }
      cursor = resp.has_more ? (resp.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return collected;
  }
}
