import type {
  CacheSnapshot,
  FractalPointers,
  MetricEvent,
  NotionBlock,
  NotionDatabase,
  NotionDataSource,
  NotionListResponse,
  NotionMarkdownResponse,
  NotionPage,
  NotionView,
  OntologyConfig,
  RateLimitState,
} from "../shared/types.js";

export interface QueryDataSourceRequest {
  filter?: Record<string, unknown>;
  sorts?: Array<Record<string, unknown>>;
  page_size?: number;
  start_cursor?: string;
  result_type?: "page" | "data_source";
}

export interface SearchRequest {
  query?: string;
  filter?: { property: "object"; value: "page" | "data_source" };
  page_size?: number;
  start_cursor?: string;
}

export interface NotionGateway {
  getCallCount(): number;
  getMe(): Promise<{ id: string; name?: string; type: string }>;
  getPage(pageId: string): Promise<NotionPage>;
  getDatabase(databaseId: string): Promise<NotionDatabase>;
  getDataSource(dataSourceId: string): Promise<NotionDataSource>;
  listBlockChildren(
    blockId: string,
    startCursor?: string,
    pageSize?: number,
  ): Promise<NotionListResponse<NotionBlock>>;
  queryDataSource(
    dataSourceId: string,
    body?: QueryDataSourceRequest,
  ): Promise<NotionListResponse<NotionPage | NotionDataSource>>;
  search(body: SearchRequest): Promise<NotionListResponse<NotionPage | NotionDataSource>>;
  listViews(
    params: { data_source_id?: string; database_id?: string; start_cursor?: string },
  ): Promise<NotionListResponse<NotionView>>;
  getPageMarkdown(pageId: string): Promise<NotionMarkdownResponse>;
}

export interface MetadataStore {
  getWikiHome(): string;
  ontologyExists(): Promise<boolean>;
  readOntology(): Promise<OntologyConfig>;
  writeOntology(config: OntologyConfig): Promise<void>;
  /**
   * Edit ontology.yaml via CST (preserving user comments and formatting)
   * using a callback over a mutable plain object or document updater.
   */
  patchOntology(updater: (current: OntologyConfig) => OntologyConfig): Promise<void>;
  readCache(): Promise<CacheSnapshot | null>;
  writeCache(snapshot: CacheSnapshot): Promise<void>;
  readGuideSummary(filename: string): Promise<string | null>;
  writeGuideSummary(filename: string, content: string): Promise<void>;
  readFractalPointers(): Promise<FractalPointers>;
  writeFractalPointers(pointers: FractalPointers): Promise<void>;
  readExternalFile(filePath: string): Promise<string | null>;
  writeExternalFile(filePath: string, content: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
}

export interface RateLimiter {
  acquire(endpointKey: string, trafficClass: "interactive" | "maintenance"): Promise<void>;
  recordRateLimit(
    endpointKey: string,
    waitMs: number,
    reason: string | null,
  ): Promise<void>;
  readState(): Promise<RateLimitState>;
}

export interface SecretStore {
  resolveToken(options: {
    profile: string;
    tokenRef?: string;
    envVar?: string;
  }): Promise<{ token: string; source: "keychain" | "token_file" | "env" }>;
  storeTokenFile(profile: string, token: string): Promise<string>;
}

export interface MetricsLogger {
  append(event: MetricEvent): Promise<void>;
}
