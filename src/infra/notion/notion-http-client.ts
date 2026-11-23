import type {
  NotionGateway,
  QueryDataSourceRequest,
  RateLimiter,
  SearchRequest,
} from "../../core/ports.js";
import { AxiError } from "../../shared/errors.js";
import type {
  NotionBlock,
  NotionDatabase,
  NotionDataSource,
  NotionListResponse,
  NotionMarkdownResponse,
  NotionPage,
  NotionView,
} from "../../shared/types.js";

const ALLOWED_ORIGIN = "https://api.notion.com";
const NOTION_VERSION = "2026-03-11";
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 20_000;

export interface NotionHttpClientOptions {
  token: string;
  rateLimiter: RateLimiter;
  trafficClass?: "interactive" | "maintenance";
  fetchFn?: typeof fetch;
}

interface NotionErrorPayload {
  code?: string;
  message?: string;
  additional_data?: {
    rate_limit_reason?: string;
  };
}

export class NotionHttpClient implements NotionGateway {
  private readonly token: string;
  private readonly rateLimiter: RateLimiter;
  private readonly trafficClass: "interactive" | "maintenance";
  private readonly fetchFn: typeof fetch;
  private callCount = 0;

  constructor(options: NotionHttpClientOptions) {
    this.token = options.token;
    this.rateLimiter = options.rateLimiter;
    this.trafficClass = options.trafficClass ?? "interactive";
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  getCallCount(): number {
    return this.callCount;
  }

  private buildAllowedUrl(apiPath: string): string {
    const url = new URL(apiPath, ALLOWED_ORIGIN);
    if (url.origin !== ALLOWED_ORIGIN) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Blocked outbound request to disallowed origin "${url.origin}".`,
        ["NotionHttpClient allows https://api.notion.com only."],
      );
    }
    return url.toString();
  }

  private parseRetryAfterMs(headerVal: string | null, attempt: number): number {
    if (headerVal) {
      const seconds = Number(headerVal);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(60_000, Math.ceil(seconds * 1000));
      }
    }
    const baseMs = Math.min(60_000, 2_000 * 2 ** attempt);
    const jitter = Math.floor(Math.random() * 500);
    return baseMs + jitter;
  }

  private async request<T>(params: {
    method: "GET" | "POST" | "PATCH";
    path: string;
    endpointKey: string;
    body?: unknown;
    isWrite: boolean;
  }): Promise<T> {
    const url = this.buildAllowedUrl(params.path);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      await this.rateLimiter.acquire(params.endpointKey, this.trafficClass);
      this.callCount += 1;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let status = 0;
      let statusText = "";
      let ok = false;
      let retryAfterHeader: string | null = null;
      let bodyText = "";
      try {
        const response = await this.fetchFn(url, {
          method: params.method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
          redirect: "error",
          signal: controller.signal,
        });
        status = response.status;
        statusText = response.statusText;
        ok = response.ok;
        retryAfterHeader = response.headers.get("retry-after");
        bodyText = await response.text();
      } catch (err) {
        if (params.isWrite) {
          throw new AxiError(
            "AMBIGUOUS_WRITE_OUTCOME",
            `Write request ${params.method} ${params.path} timed out or failed over network; not retrying to prevent duplicates.`,
            ["Check target in Notion before re-issuing this write."],
          );
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
          continue;
        }
        throw new AxiError(
          "NOTION_API_ERROR",
          `Network error calling Notion API: ${(err as Error).message}`,
        );
      } finally {
        clearTimeout(timer);
        this.rateLimiter.release(this.trafficClass);
      }

      if (ok) {
        return JSON.parse(bodyText) as T;
      }

      let errorBody: NotionErrorPayload = {};
      try {
        errorBody = JSON.parse(bodyText) as NotionErrorPayload;
      } catch {
        // Non-JSON error body.
      }

      if (status === 429) {
        const waitMs = this.parseRetryAfterMs(retryAfterHeader, attempt);
        const reason = errorBody.additional_data?.rate_limit_reason ?? null;
        await this.rateLimiter.recordRateLimit(params.endpointKey, waitMs, reason);
        if (attempt < MAX_RETRIES) {
          continue;
        }
        throw new AxiError(
          "RATE_LIMITED",
          `Notion API rate limit exceeded (${reason ?? "429"}) after ${MAX_RETRIES} retries.`,
          ["Wait for cooldown in rate-limit-state.json or reduce request rate."],
          429,
        );
      }

      if (status >= 500) {
        if (params.isWrite) {
          throw new AxiError(
            "AMBIGUOUS_WRITE_OUTCOME",
            `Notion returned HTTP ${status} on write ${params.method} ${params.path}; aborted without blind retry to prevent duplicates.`,
            ["Verify whether the write succeeded in Notion before retrying."],
            status,
          );
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
          continue;
        }
      }

      const code = status === 404 ? "NOT_FOUND" : "NOTION_API_ERROR";
      throw new AxiError(
        code,
        `Notion API HTTP ${status} (${errorBody.code ?? "error"}): ${errorBody.message ?? statusText}`,
        status === 404
          ? ["Verify that the target page or database is shared with your Notion integration."]
          : [],
        status,
      );
    }

    throw new AxiError("NOTION_API_ERROR", "Exhausted Notion API retry attempts.");
  }

  async getMe(): Promise<{ id: string; name?: string; type: string }> {
    return this.request({
      method: "GET",
      path: "/v1/users/me",
      endpointKey: "users-me",
      isWrite: false,
    });
  }

  async getPage(pageId: string): Promise<NotionPage> {
    return this.request({
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(pageId)}`,
      endpointKey: "pages-get",
      isWrite: false,
    });
  }

  async getDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.request({
      method: "GET",
      path: `/v1/databases/${encodeURIComponent(databaseId)}`,
      endpointKey: "databases-get",
      isWrite: false,
    });
  }

  async getDataSource(dataSourceId: string): Promise<NotionDataSource> {
    return this.request({
      method: "GET",
      path: `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
      endpointKey: "data-sources-get",
      isWrite: false,
    });
  }

  async listBlockChildren(
    blockId: string,
    startCursor?: string,
    pageSize = 100,
  ): Promise<NotionListResponse<NotionBlock>> {
    const qs = new URLSearchParams({ page_size: String(pageSize) });
    if (startCursor) qs.set("start_cursor", startCursor);
    return this.request({
      method: "GET",
      path: `/v1/blocks/${encodeURIComponent(blockId)}/children?${qs.toString()}`,
      endpointKey: "blocks-children",
      isWrite: false,
    });
  }

  async queryDataSource(
    dataSourceId: string,
    body: QueryDataSourceRequest = {},
  ): Promise<NotionListResponse<NotionPage | NotionDataSource>> {
    return this.request({
      method: "POST",
      path: `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      endpointKey: "query-data-source",
      body,
      isWrite: false,
    });
  }

  async search(
    body: SearchRequest,
  ): Promise<NotionListResponse<NotionPage | NotionDataSource>> {
    return this.request({
      method: "POST",
      path: "/v1/search",
      endpointKey: "search",
      body,
      isWrite: false,
    });
  }

  async listViews(params: {
    data_source_id?: string;
    database_id?: string;
    start_cursor?: string;
  }): Promise<NotionListResponse<NotionView>> {
    const qs = new URLSearchParams({ page_size: "100" });
    if (params.data_source_id) qs.set("data_source_id", params.data_source_id);
    if (params.database_id) qs.set("database_id", params.database_id);
    if (params.start_cursor) qs.set("start_cursor", params.start_cursor);
    return this.request({
      method: "GET",
      path: `/v1/views?${qs.toString()}`,
      endpointKey: "views-list",
      isWrite: false,
    });
  }

  async getPageMarkdown(pageId: string): Promise<NotionMarkdownResponse> {
    return this.request({
      method: "GET",
      path: `/v1/pages/${encodeURIComponent(pageId)}/markdown`,
      endpointKey: "pages-markdown-get",
      isWrite: false,
    });
  }
}
