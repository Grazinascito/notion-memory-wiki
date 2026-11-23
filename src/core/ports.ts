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
  NotionPagePropertyItem,
  NotionView,
  OntologyConfig,
  ProposalRecord,
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
  listPagePropertyItems(
    pageId: string,
    propertyId: string,
    startCursor?: string,
  ): Promise<NotionListResponse<NotionPagePropertyItem>>;
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
  createPage(body: {
    parent: { type: "data_source_id"; data_source_id: string };
    properties: Record<string, Record<string, unknown>>;
  }): Promise<NotionPage>;
  updatePageProperties(
    pageId: string,
    properties: Record<string, Record<string, unknown>>,
  ): Promise<NotionPage>;
  trashPage(pageId: string): Promise<NotionPage>;
  movePage(
    pageId: string,
    parent:
      | { type: "page_id"; page_id: string }
      | { type: "data_source_id"; data_source_id: string },
  ): Promise<NotionPage>;
  patchPageMarkdown(
    pageId: string,
    body:
      | {
          type: "insert_content";
          insert_content: { content: string; position: { type: "end" } };
        }
      | {
          type: "replace_content";
          replace_content: { new_str: string; allow_deleting_content: boolean };
        },
  ): Promise<NotionMarkdownResponse>;
  updateDataSource(
    dataSourceId: string,
    body: { properties: Record<string, Record<string, unknown>> },
  ): Promise<NotionDataSource>;
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
  writeProposal(proposal: ProposalRecord): Promise<void>;
  readProposal(proposalId: string): Promise<ProposalRecord>;
  withProposalLock<T>(proposalId: string, fn: () => Promise<T>): Promise<T>;
}

export interface RateLimiter {
  acquire(endpointKey: string, trafficClass: "interactive" | "maintenance"): Promise<void>;
  release(trafficClass: "interactive" | "maintenance"): void;
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
  }): Promise<{ token: string; source: "keychain" | "token_file" | "env" }>;
  storeTokenFile(profile: string, token: string): Promise<string>;
}

export interface MetricsLogger {
  append(event: MetricEvent): Promise<void>;
}
