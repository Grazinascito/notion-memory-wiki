export type RootType = "page" | "wiki_database";
export type InjectionMode = "render" | "hook" | "wakeup_on_demand";
export type MaintenanceMode = "deterministic" | "llm_assisted";

export interface TaxonomyAreaConfig {
  id: string;
  label: string;
  alt_labels: string[];
  hub_page_id: string;
}

export interface ExtraRequiredFieldConfig {
  property_id: string;
  label: string;
}

export interface NumericBoundConfig {
  label: string;
  min?: number;
  max?: number;
}

export interface DatabaseOverlayConfig {
  data_source_id: string;
  area: string;
  purpose: string;
  alt_labels: string[];
  pinned_level0: boolean;
  extra_required_fields: ExtraRequiredFieldConfig[];
  numeric_bounds: Record<string, NumericBoundConfig>;
  stale_after_days: number;
  allow_wiki_verification: boolean;
}

export interface GuidePageConfig {
  page_id: string;
  title: string;
  open_when: string;
}

export interface GuideConfig {
  enabled: boolean;
  summary_file: string;
  user_pinned: boolean;
  pages: GuidePageConfig[];
}

export interface CaptureInboxConfig {
  id: string;
  type: "page" | "database";
}

export interface AgentScopeConfig {
  injection_mode: InjectionMode;
  render_target?: string;
  token_ref?: string;
  allow_areas: string[];
  allow_databases: string[];
  deny_databases: string[];
  allow_guide_pages: "all" | string[];
  read_only: boolean;
}

export interface MaintenanceConfig {
  enabled: boolean;
  mode: MaintenanceMode;
  max_pages: number;
  report_page_id: string | null;
}

export interface OntologyConfig {
  version: 1;
  workspace: {
    name: string;
    root_id: string;
    root_type: RootType;
    approved_linked_view_ids: string[];
  };
  taxonomy: TaxonomyAreaConfig[];
  databases: Record<string, DatabaseOverlayConfig>;
  excluded_data_source_ids: string[];
  guide: GuideConfig;
  capture_inbox?: CaptureInboxConfig;
  agent_scopes: Record<string, AgentScopeConfig>;
  maintenance: MaintenanceConfig;
}

export interface CachedProperty {
  id: string;
  name: string;
  type: string;
  read_only: boolean;
  options?: string[];
  relation_target_data_source_id?: string;
  rollup_relation_property_name?: string;
  formula_expression?: string;
}

export interface CachedDataSource {
  data_source_id: string;
  database_id: string;
  title: string;
  parent_node_id: string | null;
  last_edited_time: string;
  schema_hash: string;
  properties: Record<string, CachedProperty>;
}

export interface CachedRelationEdge {
  from_data_source_id: string;
  property_id: string;
  property_name: string;
  to_data_source_id: string;
}

export interface CachedGuidePage {
  page_id: string;
  title: string;
  last_edited_time: string;
  summary_synced_at: string | null;
  summary_stale: boolean;
}

export interface CachedTaxonomyNode {
  page_id: string;
  title: string;
  parent_id: string | null;
}

export interface CacheSnapshot {
  schema_version: 1;
  synced_at: string;
  root: {
    id: string;
    type: RootType;
    is_wiki: boolean;
    root_data_source_id?: string;
  };
  taxonomy_nodes: CachedTaxonomyNode[];
  data_sources: Record<string, CachedDataSource>;
  relation_edges: CachedRelationEdge[];
  guide_pages: CachedGuidePage[];
}

export interface FractalPointer {
  child_database_id: string;
  child_data_source_id: string;
  title: string;
  discovered_at: string;
  last_verified_at: string;
}

export interface FractalPointers {
  schema_version: 1;
  by_parent_page_id: Record<string, FractalPointer[]>;
}

export interface RateLimitBucketState {
  tokens: number;
  last_refill_ms: number;
}

export interface RateLimitEndpointState {
  tokens: number;
  last_refill_ms: number;
  retry_after_until: number;
}

export interface RateLimitState {
  updated_at: number;
  retry_after_until: number;
  last_reason: string | null;
  last_active_chat_at: number;
  global?: RateLimitBucketState;
  endpoints: Record<string, RateLimitEndpointState>;
}

export interface MetricEvent {
  ts: string;
  profile: string;
  command: string;
  target_alias: string | null;
  resolved_via: "alias" | "search" | "raw_url" | "fractal" | "none";
  outcome:
    | "ok"
    | "validation_error"
    | "scope_denied"
    | "proposal_created"
    | "http_429"
    | "error";
  error_code: string | null;
  http_status: number | null;
  notion_calls: number;
  duration_ms: number;
}

// --- Notion REST API 2026-03-11 wire shapes ---

export interface NotionRichText {
  plain_text: string;
  href?: string | null;
}

export type NotionParent =
  | { type: "page_id"; page_id: string }
  | { type: "database_id"; database_id: string }
  | { type: "data_source_id"; data_source_id: string; database_id?: string }
  | { type: "block_id"; block_id: string }
  | { type: "workspace"; workspace: true };

export interface NotionDatabase {
  object: "database";
  id: string;
  title: NotionRichText[];
  parent: NotionParent;
  is_inline?: boolean;
  wiki?: boolean | Record<string, unknown>;
  last_edited_time: string;
  data_sources?: Array<{ id: string; name?: string }>;
}

export interface NotionSelectOptionSchema {
  id?: string;
  name: string;
  color?: string;
}

export interface NotionPropertySchemaBase {
  id: string;
  name?: string;
}

export type NotionPropertySchema =
  | (NotionPropertySchemaBase & { type: "title"; title?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "rich_text"; rich_text?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "number"; number?: { format?: string } })
  | (NotionPropertySchemaBase & { type: "checkbox"; checkbox?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "url"; url?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "email"; email?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "phone_number"; phone_number?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "date"; date?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "created_time"; created_time?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "last_edited_time"; last_edited_time?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "created_by"; created_by?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "last_edited_by"; last_edited_by?: Record<string, unknown> })
  | (NotionPropertySchemaBase & { type: "unique_id"; unique_id?: { prefix?: string | null } })
  | (NotionPropertySchemaBase & {
      type: "select";
      select: { options: NotionSelectOptionSchema[] };
    })
  | (NotionPropertySchemaBase & {
      type: "multi_select";
      multi_select: { options: NotionSelectOptionSchema[] };
    })
  | (NotionPropertySchemaBase & {
      type: "status";
      status: { options: NotionSelectOptionSchema[] };
    })
  | (NotionPropertySchemaBase & {
      type: "relation";
      relation: { data_source_id?: string; database_id?: string };
    })
  | (NotionPropertySchemaBase & {
      type: "rollup";
      rollup: {
        relation_property_name?: string;
        relation_property_id?: string;
        function?: string;
      };
    })
  | (NotionPropertySchemaBase & {
      type: "formula";
      formula: { expression?: string };
    })
  | (NotionPropertySchemaBase & {
      type: "verification";
      verification?: Record<string, unknown>;
    })
  | (NotionPropertySchemaBase & { type: "unsupported" });

export interface NotionDataSource {
  object: "data_source";
  id: string;
  title?: NotionRichText[];
  name?: string;
  parent: NotionParent;
  last_edited_time: string;
  properties: Record<string, NotionPropertySchema>;
}

export type NotionFormulaValue =
  | { type: "string"; string: string | null }
  | { type: "number"; number: number | null }
  | { type: "boolean"; boolean: boolean | null }
  | { type: "date"; date: { start: string; end?: string | null } | null };

export type NotionRollupValue =
  | { type: "number"; number: number | null }
  | { type: "date"; date: { start: string; end?: string | null } | null }
  | { type: "array"; array: NotionPropertyValue[] }
  | { type: "unsupported"; unsupported?: Record<string, unknown> }
  | { type: "incomplete"; incomplete?: Record<string, unknown> };

export interface NotionVerificationValue {
  state: "verified" | "unverified" | "expired";
  verified_by?: { id: string; name?: string } | null;
  date?: { start: string; end?: string | null } | null;
}

export type NotionPropertyValue =
  | { id?: string; type: "title"; title: NotionRichText[] }
  | { id?: string; type: "rich_text"; rich_text: NotionRichText[] }
  | { id?: string; type: "status"; status: { id?: string; name: string; color?: string } | null }
  | { id?: string; type: "select"; select: { id?: string; name: string; color?: string } | null }
  | {
      id?: string;
      type: "multi_select";
      multi_select: Array<{ id?: string; name: string; color?: string }>;
    }
  | { id?: string; type: "number"; number: number | null }
  | { id?: string; type: "checkbox"; checkbox: boolean }
  | { id?: string; type: "url"; url: string | null }
  | { id?: string; type: "email"; email: string | null }
  | { id?: string; type: "phone_number"; phone_number: string | null }
  | { id?: string; type: "date"; date: { start: string; end?: string | null } | null }
  | { id?: string; type: "relation"; relation: Array<{ id: string }>; has_more?: boolean }
  | { id?: string; type: "formula"; formula: NotionFormulaValue }
  | { id?: string; type: "rollup"; rollup: NotionRollupValue }
  | { id?: string; type: "created_time"; created_time: string }
  | { id?: string; type: "last_edited_time"; last_edited_time: string }
  | { id?: string; type: "verification"; verification: NotionVerificationValue | null }
  | { id?: string; type: "unsupported" };

export interface NotionPage {
  object: "page";
  id: string;
  url?: string;
  parent: NotionParent;
  last_edited_time: string;
  in_trash?: boolean;
  properties: Record<string, NotionPropertyValue>;
}

export interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children: boolean;
  parent?: NotionParent;
  child_page?: { title: string };
  child_database?: { title: string };
}

export interface NotionView {
  object: "view";
  id: string;
  name: string;
  type: string;
  parent: NotionParent;
  data_source_id: string | null;
}

export interface NotionMarkdownResponse {
  object?: "page_markdown";
  id?: string;
  markdown: string;
  truncated: boolean;
  unknown_block_ids: string[];
}

export interface NotionListResponse<T> {
  object: "list";
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}
