import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OntologyEngine } from "../../src/core/ontology/ontology-engine.js";
import { ScopeGuard } from "../../src/core/scope/scope-guard.js";
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
});
