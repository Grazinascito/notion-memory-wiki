import type { CatalogEntry } from "../core/ontology/ontology-engine.js";
import type {
  QueryDatabaseResult,
  ReadPageResult,
  SetupDiscoveryResult,
  SyncResult,
} from "../core/sync/sync-service.js";

/**
 * Compact TOON (Token-Oriented Object Notation) formatters for AXI CLI output.
 */
export function formatCatalogToon(entries: CatalogEntry[]): string {
  if (entries.length === 0) return "catalog[0]: (empty)";
  const lines = [`catalog[${entries.length}]{alias,area,title,purpose}:`];
  for (const e of entries) {
    lines.push(`  ${e.alias} | ${e.area} | ${e.title} | ${e.purpose}`);
  }
  return lines.join("\n");
}

export function formatQueryToon(res: QueryDatabaseResult): string {
  const header = `query[${res.rows.length}] alias=${res.alias} via=${res.resolvedVia} calls=${res.apiCalls}${res.hasMore ? ` next_cursor=${res.nextCursor}` : ""}`;
  if (res.rows.length === 0) return `${header}\n  (no matching rows)`;

  const lines = [header];
  for (const row of res.rows) {
    const pairs = Object.entries(row.fields)
      .map(([k, v]) => `${k}=${v.replace(/\s+/g, " ").trim()}`)
      .join(" | ");
    lines.push(`  ${row.id} | ${pairs}`);
  }
  return lines.join("\n");
}

export function formatReadToon(res: ReadPageResult): string {
  const meta = [
    `page id=${res.pageId} chars=${res.totalChars} truncated=${res.truncated} calls=${res.apiCalls}`,
    ...(res.nextOffset !== null ? [`next: wiki read ${res.pageId} --full --offset ${res.nextOffset}`] : []),
    ...(res.unknownBlockIds.length > 0
      ? [`unknown_block_ids[${res.unknownBlockIds.length}]: ${res.unknownBlockIds.join(", ")}`]
      : []),
  ];
  return `${meta.join("\n")}\n${res.content}`;
}

export function formatSetupToon(res: SetupDiscoveryResult, saved: boolean): string {
  const lines = [
    `setup workspace=${res.workspaceName} root_type=${res.rootType} saved=${saved} calls=${res.apiCalls}`,
    `  root_id: ${res.rootId}`,
    ...(res.rootDataSourceId ? [`  root_data_source_id: ${res.rootDataSourceId}`] : []),
    ...(res.wikiBlocksSupported !== null
      ? [`  wiki_blocks_children_supported: ${res.wikiBlocksSupported}`]
      : []),
    `  hubs[${res.hubs.length}]: ${res.hubs.slice(0, 12).map((h) => h.title).join(", ")}${res.hubs.length > 12 ? ", ..." : ""}`,
    `  data_sources[${res.dataSources.length}]: ${res.dataSources.slice(0, 15).map((d) => d.title).join(", ")}${res.dataSources.length > 15 ? ", ..." : ""}`,
  ];
  if (res.unplacedDataSourceIds.length > 0) {
    lines.push(
      `  unplaced_data_sources[${res.unplacedDataSourceIds.length}]: review area assignment in ontology.yaml`,
    );
  }
  if (res.unmatchedUnsupportedHubIds.length > 0) {
    lines.push(
      `  unmatched_unsupported_hubs[${res.unmatchedUnsupportedHubIds.length}]: some hubs contain linked views not matched automatically`,
    );
  }
  return lines.join("\n");
}

export function formatSyncToon(res: SyncResult): string {
  const lines = [
    `sync ok data_sources=${res.syncedDataSources} calls=${res.apiCalls}`,
  ];
  for (const title of res.staleGuidePages) {
    lines.push(`  stale_guide: "${title}" changed in Notion since last summary sync`);
  }
  for (const warn of res.missingPropertyWarnings) {
    lines.push(`  warn: ${warn}`);
  }
  return lines.join("\n");
}
