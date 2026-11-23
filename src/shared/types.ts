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
  notion_token_env?: string;
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

export interface NotionPropertySchema {
  id: string;
  name?: string;
  type: string;
  select?: { options: Array<{ id?: string; name: string; color?: string }> };
  multi_select?: { options: Array<{ id?: string; name: string; color?: string }> };
  status?: { options: Array<{ id?: string; name: string; color?: string }> };
  relation?: { data_source_id?: string; database_id?: string };
  rollup?: { relation_property_name?: string; relation_property_id?: string };
  formula?: { expression?: string };
}

export interface NotionDataSource {
  object: "data_source";
  id: string;
  title?: NotionRichText[];
  name?: string;
  parent: NotionParent;
  last_edited_time: string;
  properties: Record<string, NotionPropertySchema>;
}

export interface NotionPage {
  object: "page";
  id: string;
  url?: string;
  parent: NotionParent;
  last_edited_time: string;
  in_trash?: boolean;
  properties: Record<string, Record<string, unknown>>;
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
