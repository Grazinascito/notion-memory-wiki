import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OntologyEngine } from "../../src/core/ontology/ontology-engine.js";
import { ScopeGuard } from "../../src/core/scope/scope-guard.js";
import { AxiError } from "../../src/shared/errors.js";
import { classifyResolution, extractNotionUuid } from "../../src/shared/text.js";
import { estimateTokens, TOKEN_CAPS } from "../../src/shared/tokens.js";
import type { OntologyConfig } from "../../src/shared/types.js";

function buildOntologyWithDbs(count: number): OntologyConfig {
  const databases: OntologyConfig["databases"] = {};
  for (let i = 1; i <= count; i += 1) {
    databases[`db_${i}`] = {
      data_source_id: `ds-${i}`,
      area: i % 2 === 0 ? "saude" : "trabalho",
      purpose: `Gerenciar registros de número ${i} com ações rápidas`,
      alt_labels: i === 1 ? ["projetos", "ações"] : [],
      pinned_level0: i <= 3,
      extra_required_fields: [],
      numeric_bounds: {},
      stale_after_days: 30,
      allow_wiki_verification: false,
    };
  }
  return {
    version: 1,
    workspace: {
      name: "wiki-pessoal",
      root_id: "00000000-0000-0000-0000-000000000000",
      root_type: "wiki_database",
      approved_linked_view_ids: [],
    },
    taxonomy: [
      { id: "trabalho", label: "Gestão de Projetos", alt_labels: [], hub_page_id: "h1" },
      { id: "saude", label: "Saúde e Bem-Estar", alt_labels: [], hub_page_id: "h2" },
    ],
    databases,
    excluded_data_source_ids: [],
    guide: { enabled: false, summary_file: "guide-summary.md", user_pinned: false, pages: [] },
    agent_scopes: {
      default: {
        injection_mode: "render",
        render_target: "~/AGENTS.md",
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

describe("OntologyEngine", () => {
  it("resolves accented Portuguese queries offline using NFD + trigrams", () => {
    const guard = new ScopeGuard();
    const engine = new OntologyEngine(guard);
    const onto = buildOntologyWithDbs(4);

    const resolved = engine.resolveDatabase(onto, null, "default", "acoes");
    assert.equal(resolved.alias, "db_1");
    assert.equal(resolved.resolvedVia, "search");
  });

  it("switches Level 0 automatically to two-tier area summary above 30 databases", () => {
    const guard = new ScopeGuard();
    const engine = new OntologyEngine(guard);
    const onto = buildOntologyWithDbs(35);

    const rendered = engine.renderLevel0(onto, null, null, "default");
    assert.equal(rendered.overflowActive, true);
    assert.match(rendered.text, /### Areas/);
    assert.match(rendered.text, /### Pinned Databases/);
    assert.ok(rendered.totalTokens < TOKEN_CAPS.LEVEL0_TOTAL_HARD);
  });

  it("estimates accented Portuguese safely with chars / 2.8 divisor", () => {
    const ptSample =
      "Acompanhamento semanal de projetos estratégicos, metas prioritárias, revisão de hábitos e decisões técnicas.";
    const est = estimateTokens(ptSample);
    assert.equal(est, Math.ceil(ptSample.length / 2.8));
    // Must strictly exceed English 4 chars/token estimate.
    assert.ok(est > Math.ceil(ptSample.length / 4));
  });

  it("preserves surrounding YAML frontmatter and user instructions on upsertRenderBlock", () => {
    const guard = new ScopeGuard();
    const engine = new OntologyEngine(guard);
    const existing = [
      "---",
      "description: Custom rules",
      "alwaysApply: true",
      "---",
      "",
      "# My Rules",
      "Keep responses concise.",
    ].join("\n");

    const first = engine.upsertRenderBlock(existing, "wiki-pessoal", "work_agent", "BODY_V1");
    assert.match(first, /alwaysApply: true/);
    assert.match(first, /<!-- notion-memory-wiki:start workspace=wiki-pessoal profile=work_agent -->/);
    assert.match(first, /BODY_V1/);

    const second = engine.upsertRenderBlock(first, "wiki-pessoal", "work_agent", "BODY_V2");
    assert.equal(second.includes("BODY_V1"), false);
    assert.equal(second.includes("BODY_V2"), true);
    assert.equal(second.includes("Keep responses concise."), true);
  });

  it("extracts database/page UUIDs ignoring query strings and fragments, and classifies resolutions", () => {
    const dbHex = "1234567890abcdef1234567890abcdef";
    const viewHex = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pageHex = "fedcba0987654321fedcba0987654321";

    assert.equal(
      extractNotionUuid(`https://www.notion.so/Projects-${dbHex}?v=${viewHex}`),
      "12345678-90ab-cdef-1234-567890abcdef",
    );
    assert.equal(
      extractNotionUuid(`https://my.notion.site/Page-${pageHex}#section`),
      "fedcba09-8765-4321-fedc-ba0987654321",
    );
    assert.equal(
      extractNotionUuid(`https://my.notion.site/Page-${pageHex}#${viewHex}`),
      "fedcba09-8765-4321-fedc-ba0987654321",
    );

    assert.equal(classifyResolution(`https://my.notion.site/Page-${pageHex}`), "raw_url");
    assert.equal(classifyResolution(`https://www.notion.so/Projects-${dbHex}?v=${viewHex}`), "raw_url");
    assert.equal(classifyResolution("12345678-90ab-cdef-1234-567890abcdef"), "raw_url");
    assert.equal(classifyResolution(dbHex), "raw_url");
    assert.equal(classifyResolution("processes_sops"), "alias");
  });

  it("omits raw UUIDs from Level 0 guide index and resolves guide aliases out-of-prompt", () => {
    const guard = new ScopeGuard();
    const engine = new OntologyEngine(guard);
    const onto = buildOntologyWithDbs(3);
    onto.guide = {
      enabled: true,
      summary_file: "guide-summary.md",
      user_pinned: false,
      pages: [
        {
          page_id: "11111111-2222-3333-4444-555555555555",
          title: "Processes (SOPs)",
          open_when: "Before recurring workflows",
        },
        {
          page_id: "66666666-7777-8888-9999-aaaaaaaaaaaa",
          title: "Secret Admin Guide",
          open_when: "Admin only",
        },
      ],
    };
    onto.agent_scopes.restricted = {
      injection_mode: "wakeup_on_demand",
      allow_areas: ["trabalho"],
      allow_databases: [],
      deny_databases: [],
      allow_guide_pages: ["11111111-2222-3333-4444-555555555555"],
      read_only: true,
    };

    const rendered = engine.renderLevel0(onto, null, "Keep entries concise.", "restricted");
    assert.equal(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(rendered.text),
      false,
    );
    assert.match(rendered.text, /processes_sops \| Processes \(SOPs\): Before recurring workflows/);
    assert.equal(rendered.text.includes("Secret Admin Guide"), false);

    const resolved = engine.resolveGuidePage(onto, "restricted", "processes_sops");
    assert.equal(resolved?.pageId, "11111111-2222-3333-4444-555555555555");

    assert.throws(
      () => engine.resolveGuidePage(onto, "restricted", "secret_admin_guide"),
      (err: unknown) => err instanceof AxiError && err.code === "SCOPE_DENIED",
    );
  });

  it("enforces CATALOG_HARD (<= 420 tokens) after overflow switch", () => {
    const guard = new ScopeGuard();
    const engine = new OntologyEngine(guard);

    // Case 1: Overflow trims pinned databases so catalogTokens stays <= 420.
    const ontoTrimmable = buildOntologyWithDbs(35);
    for (let i = 1; i <= 5; i += 1) {
      ontoTrimmable.databases[`db_${i}`]!.pinned_level0 = true;
      ontoTrimmable.databases[`db_${i}`]!.purpose =
        "Long descriptive purpose repeated to push pinned database block beyond catalog hard cap limit";
    }
    const trimmed = engine.renderLevel0(ontoTrimmable, null, null, "default");
    assert.equal(trimmed.overflowActive, true);
    assert.ok(trimmed.catalogTokens <= TOKEN_CAPS.CATALOG_HARD);

    // Case 2: Too many areas exceeding 420 tokens even with 0 pinned throws BUDGET_EXCEEDED.
    const ontoTooManyAreas = buildOntologyWithDbs(32);
    ontoTooManyAreas.taxonomy = [];
    for (let i = 1; i <= 32; i += 1) {
      const areaId = `area_with_long_name_${i}`;
      ontoTooManyAreas.taxonomy.push({
        id: areaId,
        label: `Area Number ${i} With Extended Description`,
        alt_labels: [],
        hub_page_id: `h-${i}`,
      });
      ontoTooManyAreas.databases[`db_${i}`]!.area = areaId;
      ontoTooManyAreas.databases[`db_${i}`]!.pinned_level0 = false;
    }
    assert.throws(
      () => engine.renderLevel0(ontoTooManyAreas, null, null, "default"),
      (err: unknown) => err instanceof AxiError && err.code === "BUDGET_EXCEEDED",
    );
  });
});
