import type {
  CacheSnapshot,
  CachedDataSource,
  CachedGuidePage,
} from "../../shared/types.js";
import type { RenderService } from "../ontology/render-service.js";
import type { MetadataStore, NotionGateway } from "../ports.js";
import {
  buildRelationEdges,
  extractPageTitle,
  toCachedDataSource,
} from "./notion-mapper.js";

export interface SyncResult {
  syncedDataSources: number;
  staleGuidePages: string[];
  missingPropertyWarnings: string[];
  apiCalls: number;
}

export class SyncService {
  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
    private readonly renderService: RenderService,
  ) {}

  getApiCallCount(): number {
    return this.notion.getCallCount();
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
      const isStale = summarySyncedAt !== null && page.last_edited_time > summarySyncedAt;
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
}
