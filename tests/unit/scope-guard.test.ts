import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REDACTED_MARKER, ScopeGuard } from "../../src/core/scope/scope-guard.js";
import type { NotionGateway } from "../../src/core/ports.js";
import { AxiError } from "../../src/shared/errors.js";
import type { CacheSnapshot, OntologyConfig } from "../../src/shared/types.js";

function makeOntology(): OntologyConfig {
  return {
    version: 1,
    workspace: {
      name: "test-wiki",
      root_id: "00000000-0000-0000-0000-000000000000",
      root_type: "wiki_database",
      approved_linked_view_ids: [],
    },
    taxonomy: [
      { id: "work", label: "Work", alt_labels: [], hub_page_id: "00000000-0000-0000-0000-000000000001" },
      { id: "health", label: "Health", alt_labels: [], hub_page_id: "00000000-0000-0000-0000-000000000002" },
    ],
    databases: {
      projects: {
        data_source_id: "ds-projects",
        area: "work",
        purpose: "Track projects",
        alt_labels: [],
        pinned_level0: false,
        extra_required_fields: [],
        numeric_bounds: {},
        stale_after_days: 30,
        allow_wiki_verification: false,
      },
      tasks: {
        data_source_id: "ds-tasks",
        area: "work",
        purpose: "Track tasks",
        alt_labels: [],
        pinned_level0: false,
        extra_required_fields: [],
        numeric_bounds: {},
        stale_after_days: 30,
        allow_wiki_verification: false,
      },
      daily_log: {
        data_source_id: "ds-health",
        area: "health",
        purpose: "Daily health notes",
        alt_labels: [],
        pinned_level0: false,
        extra_required_fields: [],
        numeric_bounds: {},
        stale_after_days: 30,
        allow_wiki_verification: false,
      },
    },
    excluded_data_source_ids: [],
    guide: { enabled: false, summary_file: "guide-summary.md", user_pinned: false, pages: [] },
    agent_scopes: {
      work_agent: {
        injection_mode: "render",
        render_target: "~/AGENTS.md",
        allow_areas: ["work"],
        allow_databases: [],
        deny_databases: ["tasks"],
        allow_guide_pages: "all",
        read_only: false,
      },
      health_agent: {
        injection_mode: "hook",
        allow_areas: ["health"],
        allow_databases: ["projects"],
        deny_databases: [],
        allow_guide_pages: "all",
        read_only: true,
      },
    },
    maintenance: { enabled: false, mode: "deterministic", max_pages: 200, report_page_id: null },
  };
}

describe("ScopeGuard", () => {
  it("fails closed when multiple profiles exist and none is provided", () => {
    const guard = new ScopeGuard();
    const onto = makeOntology();
    assert.throws(
      () => guard.resolveProfile(onto, undefined, undefined),
      (err: unknown) => err instanceof AxiError && err.code === "PROFILE_REQUIRED",
    );
  });

  it("rejects conflicting --profile when WIKI_AGENT_PROFILE is set", () => {
    const guard = new ScopeGuard();
    const onto = makeOntology();
    assert.throws(
      () => guard.resolveProfile(onto, "work_agent", "health_agent"),
      (err: unknown) => err instanceof AxiError && err.code === "SCOPE_LOCKED",
    );
  });

  it("applies exact set algebra (DatabasesIn(allow_areas) U allow_databases) \\ deny_databases", () => {
    const guard = new ScopeGuard();
    const onto = makeOntology();

    const workPermitted = guard.getPermittedAliases(onto, "work_agent");
    assert.deepEqual([...workPermitted].sort(), ["projects"]);

    const healthPermitted = guard.getPermittedAliases(onto, "health_agent");
    assert.deepEqual([...healthPermitted].sort(), ["daily_log", "projects"]);
  });

  it("strips rollups and redacts formulas/relations leaking out-of-scope data sources", () => {
    const guard = new ScopeGuard();
    const onto = makeOntology();
    const cache: CacheSnapshot = {
      schema_version: 1,
      synced_at: new Date().toISOString(),
      root: { id: onto.workspace.root_id, type: "wiki_database", is_wiki: true },
      taxonomy_nodes: [],
      relation_edges: [],
      guide_pages: [],
      data_sources: {
        "ds-projects": {
          data_source_id: "ds-projects",
          database_id: "db-projects",
          title: "Projects",
          parent_node_id: null,
          last_edited_time: "2026-11-23T00:00:00.000Z",
          schema_hash: "abc",
          properties: {
            p_title: { id: "p_title", name: "Name", type: "title", read_only: false },
            p_rel: {
              id: "p_rel",
              name: "HealthLink",
              type: "relation",
              read_only: false,
              relation_target_data_source_id: "ds-health",
            },
            p_roll: {
              id: "p_roll",
              name: "HealthScoreRollup",
              type: "rollup",
              read_only: true,
              rollup_relation_property_name: "HealthLink",
            },
            p_form: {
              id: "p_form",
              name: "SummaryFormula",
              type: "formula",
              read_only: true,
              formula_expression: 'prop("HealthScoreRollup") + 1',
            },
          },
        },
      },
    };

    const filtered = guard.filterRecordProperties(
      onto,
      cache,
      "work_agent",
      "ds-projects",
      {
        Name: { type: "title", title: [{ plain_text: "Alpha" }] },
        HealthLink: { type: "relation", relation: [{ id: "secret-health-page" }] },
        HealthScoreRollup: { type: "rollup", rollup: { type: "number", number: 99 } },
        SummaryFormula: { type: "formula", formula: { type: "number", number: 100 } },
      },
    );

    assert.ok("Name" in filtered);
    assert.equal("HealthScoreRollup" in filtered, false);
    assert.equal(filtered.HealthLink, REDACTED_MARKER);
    assert.equal(filtered.SummaryFormula, REDACTED_MARKER);
  });

  it("rejects loose UUIDs outside Root Page after max 4 upward hops", async () => {
    const guard = new ScopeGuard();
    const onto = makeOntology();
    let getPageCalls = 0;
    const fakeNotion = {
      getPage: async (id: string) => {
        getPageCalls += 1;
        return {
          object: "page" as const,
          id,
          parent: { type: "page_id" as const, page_id: `parent-${getPageCalls}` },
          last_edited_time: "2026-11-23T00:00:00.000Z",
          properties: {},
        };
      },
    } as unknown as NotionGateway;

    await assert.rejects(
      () =>
        guard.verifyUuidInRootScope(
          onto,
          null,
          { schema_version: 1, by_parent_page_id: {} },
          fakeNotion,
          "work_agent",
          "11111111-1111-1111-1111-111111111111",
        ),
      (err: unknown) => err instanceof AxiError && err.code === "OUT_OF_ROOT_SCOPE",
    );
    assert.equal(getPageCalls, 4);
  });

  it("excludes ungrouped (area: '') databases when allow_areas is ['*'] and allow_databases is []", () => {
    const guard = new ScopeGuard();
    const onto = makeOntology();
    onto.databases.ungrouped_db = {
      data_source_id: "ds-ungrouped",
      area: "",
      purpose: "Ungrouped DB",
      alt_labels: [],
      pinned_level0: false,
      extra_required_fields: [],
      numeric_bounds: {},
      stale_after_days: 30,
      allow_wiki_verification: false,
    };
    onto.agent_scopes.areas_only = {
      injection_mode: "wakeup_on_demand",
      allow_areas: ["*"],
      allow_databases: [],
      deny_databases: [],
      allow_guide_pages: "all",
      read_only: true,
    };
    const permitted = guard.getPermittedAliases(onto, "areas_only");
    assert.equal(permitted.has("ungrouped_db"), false);
    assert.deepEqual([...permitted].sort(), ["daily_log", "projects", "tasks"]);

    onto.agent_scopes.areas_only.allow_databases = ["*"];
    const withAllDbs = guard.getPermittedAliases(onto, "areas_only");
    assert.equal(withAllDbs.has("ungrouped_db"), true);
  });

  it("fails closed in filterRecordProperties when cache is null or dataSourceId is missing", () => {
    const guard = new ScopeGuard();
    const onto = makeOntology();
    const filtered = guard.filterRecordProperties(
      onto,
      null,
      "work_agent",
      "ds-projects",
      {
        Name: { type: "title", title: [{ plain_text: "Alpha" }] },
        HealthLink: { type: "relation", relation: [{ id: "secret-health-page" }] },
        HealthScoreRollup: { type: "rollup", rollup: { type: "number", number: 99 } },
        SummaryFormula: { type: "formula", formula: { type: "number", number: 100 } },
      },
    );

    assert.ok("Name" in filtered);
    assert.equal("HealthScoreRollup" in filtered, false);
    assert.equal(filtered.HealthLink, REDACTED_MARKER);
    assert.equal(filtered.SummaryFormula, REDACTED_MARKER);
  });

  it("isolates verifyUuidInRootScope session cache per profile and enforces max 4 total GET calls", async () => {
    const guard = new ScopeGuard();
    const onto = makeOntology();
    const workOnlyPageId = "22222222-2222-2222-2222-222222222222";
    const healthOnlyHubId = onto.taxonomy[1]!.hub_page_id;
    const unlinkedPageId = "33333333-3333-3333-3333-333333333333";

    let totalGets = 0;
    const fakeNotion = {
      getPage: async (id: string) => {
        totalGets += 1;
        if (id === workOnlyPageId) {
          return {
            object: "page" as const,
            id,
            parent: { type: "data_source_id" as const, data_source_id: "ds-projects" },
            last_edited_time: "2026-11-23T00:00:00.000Z",
            properties: {},
          };
        }
        return {
          object: "page" as const,
          id,
          parent: { type: "database_id" as const, database_id: `db-hop-${totalGets}` },
          last_edited_time: "2026-11-23T00:00:00.000Z",
          properties: {},
        };
      },
      getDatabase: async (id: string) => {
        totalGets += 1;
        return {
          object: "database" as const,
          id,
          title: [{ plain_text: "Nested" }],
          parent: { type: "page_id" as const, page_id: `page-hop-${totalGets}` },
          last_edited_time: "2026-11-23T00:00:00.000Z",
          data_sources: [],
        };
      },
    } as unknown as NotionGateway;

    // 1. Blocked hub is denied even though rootId is in workspace.
    await assert.rejects(
      () =>
        guard.verifyUuidInRootScope(
          onto,
          null,
          { schema_version: 1, by_parent_page_id: {} },
          fakeNotion,
          "work_agent",
          healthOnlyHubId,
        ),
      (err: unknown) => err instanceof AxiError && err.code === "SCOPE_DENIED",
    );

    // 2. Cross-profile cache isolation: verify workOnlyPageId under work_agent, then add restricted profile.
    await guard.verifyUuidInRootScope(
      onto,
      null,
      { schema_version: 1, by_parent_page_id: {} },
      fakeNotion,
      "work_agent",
      workOnlyPageId,
    );
    onto.agent_scopes.health_only = {
      injection_mode: "hook",
      allow_areas: ["health"],
      allow_databases: [],
      deny_databases: [],
      allow_guide_pages: "all",
      read_only: true,
    };
    await assert.rejects(
      () =>
        guard.verifyUuidInRootScope(
          onto,
          null,
          { schema_version: 1, by_parent_page_id: {} },
          fakeNotion,
          "health_only",
          workOnlyPageId,
        ),
      (err: unknown) => err instanceof AxiError && err.code === "SCOPE_DENIED",
    );

    // 3. Alternating getPage + getDatabase chain never exceeds 4 total GET calls.
    totalGets = 0;
    await assert.rejects(
      () =>
        guard.verifyUuidInRootScope(
          onto,
          null,
          { schema_version: 1, by_parent_page_id: {} },
          fakeNotion,
          "work_agent",
          unlinkedPageId,
        ),
      (err: unknown) => err instanceof AxiError && err.code === "OUT_OF_ROOT_SCOPE",
    );
    assert.equal(totalGets, 4);
  });
});
