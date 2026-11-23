import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ApprovalGate } from "../../src/core/approval/approval-gate.js";
import { OntologyEngine } from "../../src/core/ontology/ontology-engine.js";
import type { NotionGateway } from "../../src/core/ports.js";
import { ScopeGuard } from "../../src/core/scope/scope-guard.js";
import { WriteValidator } from "../../src/core/validation/write-validator.js";
import { WriteService } from "../../src/core/write/write-service.js";
import { JsonMetadataStore } from "../../src/infra/storage/json-metadata-store.js";
import { AxiError } from "../../src/shared/errors.js";
import type {
  CacheSnapshot,
  NotionDataSource,
  NotionPage,
  OntologyConfig,
} from "../../src/shared/types.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "nmw-write-test-"));
}

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
        data_source_id: "00000000-0000-0000-0000-000000000010",
        area: "work",
        purpose: "Track active projects",
        alt_labels: ["projetos"],
        pinned_level0: false,
        extra_required_fields: [
          { property_id: "prop_status_id", label: "Status" },
        ],
        numeric_bounds: {
          prop_score_id: { label: "Score", min: 1, max: 10 },
        },
        stale_after_days: 30,
        allow_wiki_verification: false,
      },
      resources: {
        data_source_id: "00000000-0000-0000-0000-000000000020",
        area: "work",
        purpose: "Store links and articles",
        alt_labels: [],
        pinned_level0: false,
        extra_required_fields: [],
        numeric_bounds: {},
        stale_after_days: 30,
        allow_wiki_verification: false,
      },
      health_db: {
        data_source_id: "00000000-0000-0000-0000-000000000030",
        area: "health",
        purpose: "Private health log",
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
        injection_mode: "wakeup_on_demand",
        allow_areas: ["work"],
        allow_databases: [],
        deny_databases: [],
        allow_guide_pages: "all",
        read_only: false,
      },
      reader_agent: {
        injection_mode: "wakeup_on_demand",
        allow_areas: ["*"],
        allow_databases: [],
        deny_databases: [],
        allow_guide_pages: "all",
        read_only: true,
      },
    },
    maintenance: { enabled: false, mode: "deterministic", max_pages: 200, report_page_id: null },
  };
}

function makeCache(): CacheSnapshot {
  return {
    schema_version: 1,
    synced_at: "2026-11-23T00:00:00.000Z",
    root: { id: "00000000-0000-0000-0000-000000000000", type: "wiki_database", is_wiki: true },
    taxonomy_nodes: [],
    relation_edges: [],
    guide_pages: [],
    data_sources: {
      "00000000-0000-0000-0000-000000000010": {
        data_source_id: "00000000-0000-0000-0000-000000000010",
        database_id: "db-projects",
        title: "Projects",
        parent_node_id: "00000000-0000-0000-0000-000000000001",
        last_edited_time: "2026-11-23T00:00:00.000Z",
        schema_hash: "h1",
        properties: {
          title: { id: "title", name: "Name", type: "title", read_only: false },
          // Renamed in Notion from "Status" to "Estado", same immutable property_id!
          prop_status_id: {
            id: "prop_status_id",
            name: "Estado",
            type: "status",
            read_only: false,
            options: ["In progress", "Done"],
          },
          prop_tags_id: {
            id: "prop_tags_id",
            name: "Tags",
            type: "multi_select",
            read_only: false,
            options: ["AI", "Infra", "Docs"],
          },
          prop_notes_id: { id: "prop_notes_id", name: "Notes", type: "rich_text", read_only: false },
          prop_score_id: { id: "prop_score_id", name: "Score", type: "number", read_only: false },
          prop_url_id: { id: "prop_url_id", name: "Link", type: "url", read_only: false },
          prop_res_rel: {
            id: "prop_res_rel",
            name: "Resources",
            type: "relation",
            read_only: false,
            relation_target_data_source_id: "00000000-0000-0000-0000-000000000020",
          },
          prop_health_rel: {
            id: "prop_health_rel",
            name: "HealthRef",
            type: "relation",
            read_only: false,
            relation_target_data_source_id: "00000000-0000-0000-0000-000000000030",
          },
          prop_formula_id: { id: "prop_formula_id", name: "Computed", type: "formula", read_only: true },
        },
      },
    },
  };
}

function createHarness(store: JsonMetadataStore, overrides: Partial<NotionGateway> = {}) {
  let calls = 0;
  let livePage: NotionPage = {
    object: "page",
    id: "11111111-1111-1111-1111-111111111111",
    parent: {
      type: "data_source_id",
      data_source_id: "00000000-0000-0000-0000-000000000010",
    },
    last_edited_time: "2026-11-23T01:00:00.000Z",
    in_trash: false,
    properties: {
      Name: { type: "title", title: [{ plain_text: "Alpha Project" }] },
      Estado: { type: "status", status: { name: "In progress" } },
      Tags: { type: "multi_select", multi_select: [{ name: "AI" }, { name: "Infra" }] },
      Notes: { type: "rich_text", rich_text: [{ plain_text: "Existing user prose." }] },
      Resources: {
        type: "relation",
        relation: [{ id: "22222222-2222-2222-2222-222222222222" }],
      },
    },
  };

  let liveMarkdown = "Original markdown body.";
  const recordedUpdates: Array<Record<string, Record<string, unknown>>> = [];
  const recordedSchemaUpdates: Array<Record<string, Record<string, unknown>>> = [];
  const trashedIds: string[] = [];
  const movedCalls: Array<{ pageId: string; parent: unknown }> = [];
  const markdownPatches: unknown[] = [];

  const liveDataSource: NotionDataSource = {
    object: "data_source",
    id: "00000000-0000-0000-0000-000000000010",
    title: [{ plain_text: "Projects" }],
    parent: { type: "database_id", database_id: "db-projects" },
    last_edited_time: "2026-11-23T01:00:00.000Z",
    properties: {
      Name: { id: "title", name: "Name", type: "title" },
      Estado: {
        id: "prop_status_id",
        name: "Estado",
        type: "status",
        status: { options: [{ name: "In progress" }, { name: "Done" }] },
      },
      Tags: {
        id: "prop_tags_id",
        name: "Tags",
        type: "multi_select",
        multi_select: { options: [{ name: "AI" }, { name: "Infra" }, { name: "Docs" }] },
      },
      Notes: { id: "prop_notes_id", name: "Notes", type: "rich_text" },
      Score: { id: "prop_score_id", name: "Score", type: "number" },
      Link: { id: "prop_url_id", name: "Link", type: "url" },
      Resources: {
        id: "prop_res_rel",
        name: "Resources",
        type: "relation",
        relation: { data_source_id: "00000000-0000-0000-0000-000000000020" },
      },
      HealthRef: {
        id: "prop_health_rel",
        name: "HealthRef",
        type: "relation",
        relation: { data_source_id: "00000000-0000-0000-0000-000000000030" },
      },
      Computed: { id: "prop_formula_id", name: "Computed", type: "formula", formula: { expression: "1" } },
    },
  };

  const notion: NotionGateway = {
    getCallCount: () => calls,
    getMe: async () => ({ id: "bot-1", type: "bot" }),
    getPage: async () => {
      calls += 1;
      return livePage;
    },
    getDatabase: async (id) => {
      calls += 1;
      return {
        object: "database",
        id,
        title: [{ plain_text: "Projects" }],
        parent: { type: "page_id", page_id: "00000000-0000-0000-0000-000000000001" },
        last_edited_time: "2026-11-23T01:00:00.000Z",
      };
    },
    getDataSource: async () => {
      calls += 1;
      return liveDataSource;
    },
    listBlockChildren: async () => ({ object: "list", results: [], has_more: false, next_cursor: null }),
    queryDataSource: async () => {
      calls += 1;
      return { object: "list", results: [], has_more: false, next_cursor: null };
    },
    search: async () => ({ object: "list", results: [], has_more: false, next_cursor: null }),
    listViews: async () => ({ object: "list", results: [], has_more: false, next_cursor: null }),
    getPageMarkdown: async () => {
      calls += 1;
      return { markdown: liveMarkdown, truncated: false, unknown_block_ids: [] };
    },
    createPage: async (body) => {
      calls += 1;
      return {
        object: "page",
        id: "33333333-3333-3333-3333-333333333333",
        parent: body.parent,
        last_edited_time: new Date().toISOString(),
        properties: {},
      };
    },
    updatePageProperties: async (_pageId, props) => {
      calls += 1;
      recordedUpdates.push(props);
      return livePage;
    },
    trashPage: async (pageId) => {
      calls += 1;
      trashedIds.push(pageId);
      return { ...livePage, in_trash: true };
    },
    movePage: async (pageId, parent) => {
      calls += 1;
      movedCalls.push({ pageId, parent });
      return livePage;
    },
    patchPageMarkdown: async (_pageId, body) => {
      calls += 1;
      markdownPatches.push(body);
      return { markdown: liveMarkdown, truncated: false, unknown_block_ids: [] };
    },
    updateDataSource: async (_dsId, body) => {
      calls += 1;
      recordedSchemaUpdates.push(body.properties);
      return liveDataSource;
    },
    ...overrides,
  };

  const guard = new ScopeGuard();
  const engine = new OntologyEngine(guard);
  const validator = new WriteValidator(notion, store, guard);
  const gate = new ApprovalGate(notion, store);
  const service = new WriteService(notion, store, guard, engine, validator, gate);

  return {
    service,
    setLivePage: (next: NotionPage) => {
      livePage = next;
    },
    getLivePage: () => livePage,
    setLiveMarkdown: (md: string) => {
      liveMarkdown = md;
    },
    recordedUpdates,
    recordedSchemaUpdates,
    trashedIds,
    movedCalls,
    markdownPatches,
  };
}

describe("Slice 2: WriteValidator + ApprovalGate + WriteService", () => {
  it("enforces read_only scope, property_id required fields across Notion column renames, numeric bounds, read-only fields, and unknown options", async () => {
    const dir = await makeTempDir();
    try {
      const store = new JsonMetadataStore(dir);
      await store.writeOntology(makeOntology());
      await store.writeCache(makeCache());
      const { service } = createHarness(store);

      // 1. read_only profile rejected immediately.
      await assert.rejects(
        () =>
          service.createRecord("reader_agent", "projects", [
            { op: "set", property: "Name", value: "Test" },
            { op: "set", property: "Estado", value: "In progress" },
          ]),
        (err: unknown) => err instanceof AxiError && err.code === "SCOPE_DENIED",
      );

      // 2. Missing extra_required_field matched by immutable property_id even though column was renamed Status -> Estado.
      await assert.rejects(
        () =>
          service.createRecord("work_agent", "projects", [
            { op: "set", property: "Name", value: "Missing Estado" },
          ]),
        (err: unknown) =>
          err instanceof AxiError &&
          err.code === "VALIDATION_ERROR" &&
          err.message.includes("Estado"),
      );

      // 3. Numeric bounds enforced by immutable property_id.
      await assert.rejects(
        () =>
          service.createRecord("work_agent", "projects", [
            { op: "set", property: "Name", value: "Bad Score" },
            { op: "set", property: "Estado", value: "in progress" },
            { op: "set", property: "Score", value: "99" },
          ]),
        (err: unknown) => err instanceof AxiError && err.code === "VALIDATION_ERROR",
      );

      // 4. Read-only formula property rejected.
      await assert.rejects(
        () =>
          service.createRecord("work_agent", "projects", [
            { op: "set", property: "Name", value: "Bad Formula" },
            { op: "set", property: "Estado", value: "In progress" },
            { op: "set", property: "Computed", value: "123" },
          ]),
        (err: unknown) => err instanceof AxiError && err.code === "VALIDATION_ERROR",
      );

      // 5. Unknown multi_select option rejected (prevents silent Notion schema drift).
      await assert.rejects(
        () =>
          service.createRecord("work_agent", "projects", [
            { op: "set", property: "Name", value: "Bad Tag" },
            { op: "set", property: "Estado", value: "In progress" },
            { op: "set", property: "Tags", value: "HallucinatedTag" },
          ]),
        (err: unknown) =>
          err instanceof AxiError &&
          err.code === "VALIDATION_ERROR" &&
          err.help.some((h) => h.includes("propose-option")),
      );

      // 6. Relation targeting out-of-scope database (health_db) rejected with SCOPE_DENIED.
      await assert.rejects(
        () =>
          service.createRecord("work_agent", "projects", [
            { op: "set", property: "Name", value: "Cross Scope" },
            { op: "set", property: "Estado", value: "In progress" },
            {
              op: "set",
              property: "HealthRef",
              value: "44444444-4444-4444-4444-444444444444",
            },
          ]),
        (err: unknown) => err instanceof AxiError && err.code === "SCOPE_DENIED",
      );

      // 7. Valid create with case-insensitive option snap succeeds.
      const created = await service.createRecord("work_agent", "projects", [
        { op: "set", property: "Name", value: "New Project" },
        { op: "set", property: "Estado", value: "in progress" },
        { op: "set", property: "Score", value: "8" },
      ]);
      assert.equal(created.pageId, "33333333-3333-3333-3333-333333333333");
      assert.equal(created.recoveredFromAmbiguous, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers created record on AMBIGUOUS_WRITE_OUTCOME via 1 exact-title query instead of duplicating", async () => {
    const dir = await makeTempDir();
    try {
      const store = new JsonMetadataStore(dir);
      await store.writeOntology(makeOntology());
      await store.writeCache(makeCache());

      const { service } = createHarness(store, {
        createPage: async () => {
          throw new AxiError("AMBIGUOUS_WRITE_OUTCOME", "HTTP 502 timeout", [], 502);
        },
        queryDataSource: async () => ({
          object: "list",
          has_more: false,
          next_cursor: null,
          results: [
            {
              object: "page",
              id: "55555555-5555-5555-5555-555555555555",
              parent: {
                type: "data_source_id",
                data_source_id: "00000000-0000-0000-0000-000000000010",
              },
              last_edited_time: new Date().toISOString(),
              properties: {
                Name: { type: "title", title: [{ plain_text: "Timeout Project" }] },
              },
            },
          ],
        }),
      });

      const res = await service.createRecord("work_agent", "projects", [
        { op: "set", property: "Name", value: "Timeout Project" },
        { op: "set", property: "Estado", value: "Done" },
      ]);
      assert.equal(res.pageId, "55555555-5555-5555-5555-555555555555");
      assert.equal(res.recoveredFromAmbiguous, true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("allows routine scalar updates, --add union, and single non-emptying --remove, while halting destructive updates into SHA-256 proposals", async () => {
    const dir = await makeTempDir();
    try {
      const store = new JsonMetadataStore(dir);
      await store.writeOntology(makeOntology());
      await store.writeCache(makeCache());
      const h = createHarness(store);

      // Routine scalar + --add on multi_select + single non-emptying --remove -> applied immediately.
      const okUpdate = await h.service.updateRecord(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
        [
          { op: "set", property: "Estado", value: "done" },
          { op: "add", property: "Tags", value: "Docs" },
        ],
      );
      assert.equal(okUpdate.applied, true);
      assert.equal(h.recordedUpdates.length, 1);
      assert.deepEqual(h.recordedUpdates[0]!.Tags, {
        multi_select: [{ name: "AI" }, { name: "Infra" }, { name: "Docs" }],
      });

      // Single-item --remove keeping >= 1 item -> applied immediately.
      const okRemove = await h.service.updateRecord(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
        [{ op: "remove", property: "Tags", value: "Infra" }],
      );
      assert.equal(okRemove.applied, true);

      // Overwriting populated rich_text -> halted into proposal!
      const proseOverwrite = await h.service.updateRecord(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
        [{ op: "set", property: "Notes", value: "Completely replaced prose" }],
      );
      assert.equal(proseOverwrite.applied, false);
      assert.equal(proseOverwrite.proposal.category, "destructive");
      assert.equal(proseOverwrite.proposal.status, "pending");

      // Replacing multi_select via --set dropping existing items -> halted into proposal!
      const dropTags = await h.service.updateRecord(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
        [{ op: "set", property: "Tags", value: "Docs" }],
      );
      assert.equal(dropTags.applied, false);

      // Clearing populated property -> halted into proposal!
      const cleared = await h.service.updateRecord(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
        [{ op: "clear", property: "Estado" }],
      );
      assert.equal(cleared.applied, false);

      // Same-minute edit collision detection via SHA-256 content hash (identical last_edited_time!).
      const current = h.getLivePage();
      h.setLivePage({
        ...current,
        // Identical minute-rounded timestamp, different Notes content!
        last_edited_time: current.last_edited_time,
        properties: {
          ...current.properties,
          Notes: { type: "rich_text", rich_text: [{ plain_text: "Edited 20 seconds later by user!" }] },
        },
      });
      await assert.rejects(
        () => h.service.approveProposal(proseOverwrite.proposal.proposal_id),
        (err: unknown) => err instanceof AxiError && err.code === "CONFLICT_STALE_TARGET",
      );

      // Restore livePage and approve a fresh trash proposal cleanly.
      const trashProp = await h.service.trashRecord(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
      );
      // A read_only or different profile cannot approve another profile's proposal.
      await assert.rejects(
        () => h.service.approveProposal(trashProp.proposal.proposal_id, "reader_agent"),
        (err: unknown) => err instanceof AxiError && err.code === "SCOPE_DENIED",
      );
      const approved = await h.service.approveProposal(
        trashProp.proposal.proposal_id,
        "work_agent",
      );
      assert.equal(approved.actionType, "trash_page");
      assert.deepEqual(h.trashedIds, ["11111111-1111-1111-1111-111111111111"]);

      // Re-approving an applied proposal fails.
      await assert.rejects(
        () => h.service.approveProposal(trashProp.proposal.proposal_id),
        (err: unknown) => err instanceof AxiError && err.code === "VALIDATION_ERROR",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("gates move (blocking out-of-scope destination), replaceMarkdown, and schema option proposals", async () => {
    const dir = await makeTempDir();
    try {
      const store = new JsonMetadataStore(dir);
      await store.writeOntology(makeOntology());
      await store.writeCache(makeCache());
      const h = createHarness(store);

      // Moving to an out-of-scope database (health_db) is blocked by ScopeGuard BEFORE proposal creation.
      await assert.rejects(
        () =>
          h.service.moveRecord(
            "work_agent",
            "11111111-1111-1111-1111-111111111111",
            "health_db",
          ),
        (err: unknown) => err instanceof AxiError && err.code === "SCOPE_DENIED",
      );

      // Moving to an in-scope database (resources) halts into a proposal and executes on approve.
      const moveProp = await h.service.moveRecord(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
        "resources",
      );
      assert.equal(moveProp.proposal.action_type, "move_page");
      await h.service.approveProposal(moveProp.proposal.proposal_id);
      assert.equal(h.movedCalls.length, 1);

      // appendMarkdown runs directly; replaceMarkdown halts into proposal and checks Markdown SHA-256.
      await h.service.appendMarkdown(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
        "\n- Appended note",
      );
      assert.equal(h.markdownPatches.length, 1);

      const replaceProp = await h.service.replaceMarkdown(
        "work_agent",
        "11111111-1111-1111-1111-111111111111",
        "New body",
      );
      h.setLiveMarkdown("User edited markdown 10s later");
      await assert.rejects(
        () => h.service.approveProposal(replaceProp.proposal.proposal_id),
        (err: unknown) => err instanceof AxiError && err.code === "CONFLICT_STALE_TARGET",
      );

      // Schema option proposal preserves all existing options + adds the new option on approve.
      const schemaProp = await h.service.proposeSchemaOption(
        "work_agent",
        "projects",
        "Tags",
        "Security",
      );
      assert.equal(schemaProp.proposal.category, "schema");
      await h.service.approveProposal(schemaProp.proposal.proposal_id);
      assert.equal(h.recordedSchemaUpdates.length, 1);
      assert.deepEqual(h.recordedSchemaUpdates[0]!.Tags, {
        multi_select: {
          options: [
            { name: "AI" },
            { name: "Infra" },
            { name: "Docs" },
            { name: "Security" },
          ],
        },
      });

      // Path traversal in proposal_id is rejected.
      await assert.rejects(
        () => store.readProposal("../ontology"),
        (err: unknown) => err instanceof AxiError && err.code === "INVALID_ARGUMENT",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
