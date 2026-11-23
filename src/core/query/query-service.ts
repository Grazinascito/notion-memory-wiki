import crypto from "node:crypto";
import { AxiError } from "../../shared/errors.js";
import {
  classifyResolution,
  extractNotionUuid,
  normalizeNfd,
  sanitizeNotionUris,
  wrapUntrustedContent,
} from "../../shared/text.js";
import type {
  CacheSnapshot,
  CachedDataSource,
  NotionPropertyValue,
  OntologyConfig,
} from "../../shared/types.js";
import type { OntologyEngine } from "../ontology/ontology-engine.js";
import type { MetadataStore, NotionGateway } from "../ports.js";
import type { ScopeGuard } from "../scope/scope-guard.js";
import {
  buildRelationEdges,
  formatNotionPropertyValue,
  formatQueryRowLines,
  toCachedDataSource,
} from "../sync/notion-mapper.js";

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

interface FollowTarget {
  relationName: string;
  targetDataSourceId: string;
}

function snapOption(value: string, validOptions?: string[]): string {
  if (!validOptions || validOptions.length === 0) return value;
  const norm = normalizeNfd(value);
  return validOptions.find((o) => normalizeNfd(o) === norm) ?? value;
}

export class QueryService {
  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
    private readonly scopeGuard: ScopeGuard,
    private readonly ontologyEngine: OntologyEngine,
  ) {}

  getApiCallCount(): number {
    return this.notion.getCallCount();
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

    const guideMatch = this.ontologyEngine.resolveGuidePage(ontology, profileName, targetInput);
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

    return {
      pageId,
      resolvedVia: guideMatch ? "alias" : classifyResolution(targetInput, "alias"),
      content: wrapUntrustedContent(slice, nonce),
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
    const initialCache = await this.store.readCache();

    const resolved = this.ontologyEngine.resolveDatabase(
      ontology,
      initialCache,
      profileName,
      databaseQuery,
    );
    this.scopeGuard.assertDatabaseAccess(ontology, profileName, resolved.alias, "read");

    const { cache, cachedDs } = await this.ensureDataSourceCached(
      ontology,
      initialCache,
      resolved.dataSourceId,
    );

    const followTarget = options.follow
      ? this.resolveFollowTarget(ontology, profileName, resolved.alias, cachedDs, options.follow)
      : null;

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
        if (requestedFields && !requestedFields.has(normalizeNfd(propName))) continue;
        const str =
          typeof propVal === "string"
            ? propVal
            : sanitizeNotionUris(formatNotionPropertyValue(propVal));
        if (str !== "") formatted[propName] = str;
      }
      if (followTarget) {
        const titles = await this.resolveFollowedRelations(
          ontology,
          cache,
          profileName,
          followTarget,
          scopedProps,
          followedPageCache,
        );
        if (titles.length > 0) formatted[`${followTarget.relationName}_titles`] = titles.join(", ");
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

  private async ensureDataSourceCached(
    ontology: OntologyConfig,
    cache: CacheSnapshot | null,
    dataSourceId: string,
  ): Promise<{ cache: CacheSnapshot; cachedDs: CachedDataSource | undefined }> {
    const existing = cache?.data_sources[dataSourceId];
    if (cache && existing) {
      return { cache, cachedDs: existing };
    }
    const liveDs = await this.notion.getDataSource(dataSourceId);
    const cachedDs = toCachedDataSource(liveDs, null);
    const nextDataSources = {
      ...(cache?.data_sources ?? {}),
      [cachedDs.data_source_id]: cachedDs,
    };
    const nextCache: CacheSnapshot = {
      schema_version: 1,
      synced_at: new Date().toISOString(),
      root: cache?.root ?? {
        id: ontology.workspace.root_id,
        type: ontology.workspace.root_type,
        is_wiki: ontology.workspace.root_type === "wiki_database",
      },
      taxonomy_nodes: cache?.taxonomy_nodes ?? [],
      data_sources: nextDataSources,
      relation_edges: buildRelationEdges(nextDataSources),
      guide_pages: cache?.guide_pages ?? [],
    };
    return { cache: nextCache, cachedDs };
  }

  private resolveFollowTarget(
    ontology: OntologyConfig,
    profileName: string,
    alias: string,
    cachedDs: CachedDataSource | undefined,
    follow: string,
  ): FollowTarget {
    const followNorm = normalizeNfd(follow);
    const relSchema = cachedDs
      ? Object.values(cachedDs.properties).find(
          (p) =>
            p.type === "relation" &&
            (normalizeNfd(p.name) === followNorm || p.id === follow),
        )
      : undefined;
    if (!relSchema || !relSchema.relation_target_data_source_id) {
      throw new AxiError(
        "INVALID_ARGUMENT",
        `Property "${follow}" on "${alias}" is not a relation property with a known target.`,
      );
    }
    this.scopeGuard.assertDataSourceAccess(
      ontology,
      profileName,
      relSchema.relation_target_data_source_id,
    );
    return {
      relationName: relSchema.name,
      targetDataSourceId: relSchema.relation_target_data_source_id,
    };
  }

  private async resolveFollowedRelations(
    ontology: OntologyConfig,
    cache: CacheSnapshot,
    profileName: string,
    target: FollowTarget,
    scopedProps: Record<string, NotionPropertyValue | string>,
    followedPageCache: Map<string, string>,
  ): Promise<string[]> {
    const relProp = scopedProps[target.relationName];
    if (!relProp || typeof relProp === "string" || relProp.type !== "relation") {
      return [];
    }
    const titles: string[] = [];
    for (const relRef of relProp.relation.slice(0, 5)) {
      let label = followedPageCache.get(relRef.id);
      if (label === undefined) {
        const targetPage = await this.notion.getPage(relRef.id);
        const filteredTarget = this.scopeGuard.filterRecordProperties(
          ontology,
          cache,
          profileName,
          target.targetDataSourceId,
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
    return titles;
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

      if (type === "status" || type === "select") {
        conditions.push({
          property: propName,
          [type]: { equals: snapOption(rawVal, schema?.options) },
        });
      } else if (type === "multi_select") {
        conditions.push({
          property: propName,
          multi_select: { contains: snapOption(rawVal, schema?.options) },
        });
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
      } else {
        const key = type === "title" ? "title" : "rich_text";
        conditions.push({ property: propName, [key]: { contains: rawVal } });
      }
    }

    return conditions.length === 1 ? conditions[0] : { and: conditions };
  }
}
