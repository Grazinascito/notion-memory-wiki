import { AxiError } from "../../shared/errors.js";
import { normalizeNfd, slugifyAlias, trigramScore } from "../../shared/text.js";
import { estimateTokens, TOKEN_CAPS } from "../../shared/tokens.js";
import type { CacheSnapshot, GuidePageConfig, OntologyConfig } from "../../shared/types.js";
import type { ScopeGuard } from "../scope/scope-guard.js";

export interface ResolvedDatabase {
  alias: string;
  dataSourceId: string;
  area: string;
  purpose: string;
  score: number;
  resolvedVia: "alias" | "search";
}

export interface ResolvedGuidePage {
  pageId: string;
  alias: string;
  title: string;
}

export interface RenderedLevel0 {
  text: string;
  catalogText: string;
  guideText: string;
  catalogTokens: number;
  guideTokens: number;
  totalTokens: number;
  overflowActive: boolean;
  warnings: string[];
}

export interface CatalogEntry {
  alias: string;
  area: string;
  purpose: string;
  title: string;
  pinned: boolean;
}

const CLI_MICRO_CARD = [
  "CLI: `wiki catalog [--area <id>]` | `wiki query <alias> [--where Prop=Val] [--fields a,b] [--limit 20]` | `wiki read <id> [--full]` | `wiki sync`",
].join("\n");

function buildGuideIndexEntries(
  pages: GuidePageConfig[],
): Array<{ alias: string; page: GuidePageConfig }> {
  const used = new Set<string>();
  return pages.map((page) => {
    const base = slugifyAlias(page.title);
    let alias = base;
    let suffix = 2;
    while (used.has(alias)) {
      alias = `${base}_${suffix++}`;
    }
    used.add(alias);
    return { alias, page };
  });
}

function buildOverflowCatalogText(
  workspaceName: string,
  profileName: string,
  areaSummaryLines: string[],
  pinned: CatalogEntry[],
): string {
  const lines = [
    `## Notion Memory Wiki (${workspaceName} | profile: ${profileName})`,
    CLI_MICRO_CARD,
    "### Areas (run `wiki catalog --area <id>` to expand)",
    ...areaSummaryLines,
  ];
  if (pinned.length > 0) {
    lines.push("### Pinned Databases");
    for (const p of pinned) {
      lines.push(`- ${p.alias} | ${p.area} | ${p.purpose}`);
    }
  }
  return lines.join("\n");
}

export class OntologyEngine {
  constructor(private readonly scopeGuard: ScopeGuard) {}

  resolveDatabase(
    ontology: OntologyConfig,
    cache: CacheSnapshot | null,
    profileName: string,
    input: string,
  ): ResolvedDatabase {
    const permitted = this.scopeGuard.getPermittedAliases(ontology, profileName);
    const normInput = normalizeNfd(input);

    // 1. Exact alias match
    for (const alias of permitted) {
      if (normalizeNfd(alias) === normInput) {
        const db = ontology.databases[alias]!;
        return {
          alias,
          dataSourceId: db.data_source_id,
          area: db.area,
          purpose: db.purpose,
          score: 1,
          resolvedVia: "alias",
        };
      }
    }

    // Check if input matches a denied/out-of-scope alias explicitly so we return SCOPE_DENIED.
    for (const alias of Object.keys(ontology.databases)) {
      if (normalizeNfd(alias) === normInput && !permitted.has(alias)) {
        throw new AxiError(
          "SCOPE_DENIED",
          `Profile "${profileName}" is not authorized to access database "${alias}".`,
        );
      }
    }

    // 2. Accent-insensitive NFD + trigram offline search across alias, alt_labels, and Notion title.
    let best: ResolvedDatabase | null = null;
    for (const alias of permitted) {
      const db = ontology.databases[alias]!;
      const cached = cache?.data_sources[db.data_source_id];
      const candidates = [alias, ...db.alt_labels, ...(cached?.title ? [cached.title] : [])];
      let maxScore = 0;
      for (const candidate of candidates) {
        const s = trigramScore(input, candidate);
        if (s > maxScore) maxScore = s;
      }
      if (maxScore >= 0.35 && (!best || maxScore > best.score)) {
        best = {
          alias,
          dataSourceId: db.data_source_id,
          area: db.area,
          purpose: db.purpose,
          score: maxScore,
          resolvedVia: "search",
        };
      }
    }

    if (!best) {
      throw new AxiError(
        "NOT_FOUND",
        `No permitted database matched "${input}" for profile "${profileName}".`,
        [`Run \`wiki catalog --profile ${profileName}\` to list permitted databases.`],
      );
    }

    return best;
  }

  /**
   * Resolve a guide short alias (or page UUID) from ontology.yaml outside the LLM prompt,
   * enforcing allow_guide_pages scope for the active profile.
   */
  resolveGuidePage(
    ontology: OntologyConfig,
    profileName: string,
    aliasOrId: string,
  ): ResolvedGuidePage | null {
    const normInput = normalizeNfd(aliasOrId);
    const entries = buildGuideIndexEntries(ontology.guide.pages);
    for (const entry of entries) {
      if (
        normalizeNfd(entry.alias) === normInput ||
        entry.page.page_id.toLowerCase() === aliasOrId.trim().toLowerCase()
      ) {
        if (!this.scopeGuard.isGuidePageAllowed(ontology, profileName, entry.page.page_id)) {
          throw new AxiError(
            "SCOPE_DENIED",
            `Profile "${profileName}" is not authorized to read guide page "${entry.page.title}".`,
          );
        }
        return {
          pageId: entry.page.page_id,
          alias: entry.alias,
          title: entry.page.title,
        };
      }
    }
    return null;
  }

  listCatalog(
    ontology: OntologyConfig,
    cache: CacheSnapshot | null,
    profileName: string,
    areaFilter?: string,
  ): CatalogEntry[] {
    const permitted = this.scopeGuard.getPermittedAliases(ontology, profileName);
    const entries: CatalogEntry[] = [];
    for (const alias of [...permitted].sort()) {
      const db = ontology.databases[alias]!;
      if (areaFilter && db.area !== areaFilter) continue;
      const title = cache?.data_sources[db.data_source_id]?.title ?? alias;
      entries.push({
        alias,
        area: db.area || "general",
        purpose: db.purpose,
        title,
        pinned: db.pinned_level0,
      });
    }
    return entries;
  }

  /**
   * Render Level 0 Push block / wakeup text strictly under Section 4.1 & 4.2 caps,
   * with zero raw Notion UUIDs in the output.
   */
  renderLevel0(
    ontology: OntologyConfig,
    cache: CacheSnapshot | null,
    guideSummary: string | null,
    profileName: string,
  ): RenderedLevel0 {
    const warnings: string[] = [];
    const entries = this.listCatalog(ontology, cache, profileName);

    const flatLines = [
      `## Notion Memory Wiki (${ontology.workspace.name} | profile: ${profileName})`,
      CLI_MICRO_CARD,
      "### Databases (alias | area | purpose)",
      ...entries.map((e) => `- ${e.alias} | ${e.area} | ${e.purpose}`),
    ];
    let catalogText = flatLines.join("\n");
    let catalogTokens = estimateTokens(catalogText);
    let overflowActive = false;

    if (
      entries.length > TOKEN_CAPS.CATALOG_OVERFLOW_DB_COUNT ||
      catalogTokens > TOKEN_CAPS.CATALOG_HARD
    ) {
      overflowActive = true;
      const byArea = new Map<string, CatalogEntry[]>();
      for (const e of entries) {
        const list = byArea.get(e.area) ?? [];
        list.push(e);
        byArea.set(e.area, list);
      }
      const areaMeta = new Map(ontology.taxonomy.map((t) => [t.id, t]));
      const areaSummaryLines = [...byArea.entries()].map(([areaId, list]) => {
        const label = areaMeta.get(areaId)?.label ?? areaId;
        const sample = list
          .slice(0, 3)
          .map((x) => x.alias)
          .join(", ");
        return `- ${areaId} | ${label} | ${list.length} DBs | ${sample}`;
      });
      const pinned = entries.filter((e) => e.pinned).slice(0, 5);

      catalogText = buildOverflowCatalogText(
        ontology.workspace.name,
        profileName,
        areaSummaryLines,
        pinned,
      );
      catalogTokens = estimateTokens(catalogText);

      // Trim pinned databases first to satisfy CATALOG_HARD post-overflow.
      while (pinned.length > 0 && catalogTokens > TOKEN_CAPS.CATALOG_HARD) {
        pinned.pop();
        catalogText = buildOverflowCatalogText(
          ontology.workspace.name,
          profileName,
          areaSummaryLines,
          pinned,
        );
        catalogTokens = estimateTokens(catalogText);
      }

      if (catalogTokens > TOKEN_CAPS.CATALOG_HARD) {
        throw new AxiError(
          "BUDGET_EXCEEDED",
          `Catalog is ${catalogTokens} tok after overflow summary, exceeding hard cap of ${TOKEN_CAPS.CATALOG_HARD} tok.`,
          ["Shorten taxonomy area labels or reduce pinned_level0 databases in ontology.yaml."],
        );
      }
    }

    if (catalogTokens > TOKEN_CAPS.CATALOG_WARN) {
      warnings.push(
        `Catalog estimated at ${catalogTokens} tok (warn threshold ${TOKEN_CAPS.CATALOG_WARN} tok).`,
      );
    }

    // Guide section filtered by allow_guide_pages, using short aliases with zero UUIDs.
    let guideText = "";
    if (ontology.guide.enabled) {
      const allowedEntries = buildGuideIndexEntries(ontology.guide.pages).filter((e) =>
        this.scopeGuard.isGuidePageAllowed(ontology, profileName, e.page.page_id),
      );
      const parts: string[] = [];
      if (guideSummary?.trim()) {
        parts.push("### Operating Guide Summary");
        parts.push(guideSummary.trim());
      }
      if (allowedEntries.length > 0) {
        parts.push("### Guide Pages (open on demand via `wiki read <alias>`)");
        for (const entry of allowedEntries) {
          const cached = cache?.guide_pages.find((g) => g.page_id === entry.page.page_id);
          const staleTag = cached?.summary_stale ? " [stale]" : "";
          parts.push(`- ${entry.alias} | ${entry.page.title}${staleTag}: ${entry.page.open_when}`);
        }
      }
      guideText = parts.join("\n");
    }

    const guideTokens = estimateTokens(guideText);
    if (guideTokens > TOKEN_CAPS.GUIDE_HARD) {
      throw new AxiError(
        "BUDGET_EXCEEDED",
        `Guide summary + index is ${guideTokens} tok, exceeding hard cap of ${TOKEN_CAPS.GUIDE_HARD} tok.`,
        ["Trim guide-summary.md or shorten open_when lines in ontology.yaml."],
      );
    }

    const combinedText = guideText ? `${catalogText}\n\n${guideText}` : catalogText;
    const totalTokens = estimateTokens(combinedText);
    if (totalTokens >= TOKEN_CAPS.LEVEL0_TOTAL_HARD) {
      throw new AxiError(
        "BUDGET_EXCEEDED",
        `Rendered Level 0 context is ${totalTokens} tok, exceeding hard ceiling < ${TOKEN_CAPS.LEVEL0_TOTAL_HARD} tok.`,
      );
    }

    return {
      text: combinedText,
      catalogText,
      guideText,
      catalogTokens,
      guideTokens,
      totalTokens,
      overflowActive,
      warnings,
    };
  }

  /**
   * Insert or replace the workspace+profile bounded marker block inside a host file
   * while preserving all surrounding text (e.g. YAML frontmatter or user rules).
   */
  upsertRenderBlock(
    existingContent: string | null,
    workspaceName: string,
    profileName: string,
    blockBody: string,
  ): string {
    const startMarker = `<!-- notion-memory-wiki:start workspace=${workspaceName} profile=${profileName} -->`;
    const endMarker = `<!-- notion-memory-wiki:end workspace=${workspaceName} profile=${profileName} -->`;
    const wrapped = `${startMarker}\n${blockBody.trim()}\n${endMarker}`;

    if (!existingContent || existingContent.length === 0) {
      return `${wrapped}\n`;
    }

    const startIdx = existingContent.indexOf(startMarker);
    const endIdx = existingContent.indexOf(endMarker);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const before = existingContent.slice(0, startIdx);
      const after = existingContent.slice(endIdx + endMarker.length);
      return `${before}${wrapped}${after}`;
    }

    const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
    return `${existingContent}${separator}${wrapped}\n`;
  }
}
