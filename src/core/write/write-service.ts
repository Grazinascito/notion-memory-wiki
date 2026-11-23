import { AxiError } from "../../shared/errors.js";
import { extractNotionUuid, normalizeNfd } from "../../shared/text.js";
import type {
  NotionPage,
  OntologyConfig,
  ProposalRecord,
} from "../../shared/types.js";
import type {
  ApprovalExecutionResult,
  ApprovalGate,
} from "../approval/approval-gate.js";
import { computeContentHash } from "../approval/approval-gate.js";
import type { OntologyEngine } from "../ontology/ontology-engine.js";
import type { MetadataStore, NotionGateway } from "../ports.js";
import type { ScopeGuard } from "../scope/scope-guard.js";
import { extractPageTitle, toCachedDataSource } from "../sync/notion-mapper.js";
import type {
  RawPropertyMutation,
  WriteValidator,
} from "../validation/write-validator.js";

export interface CreateRecordResult {
  pageId: string;
  alias: string;
  resolvedVia: "alias" | "search";
  recoveredFromAmbiguous: boolean;
  apiCalls: number;
}

export type UpdateRecordResult =
  | {
      applied: true;
      pageId: string;
      alias: string;
      updatedFields: string[];
      apiCalls: number;
    }
  | {
      applied: false;
      proposal: ProposalRecord;
      reasons: string[];
      apiCalls: number;
    };

export interface ProposalCreatedResult {
  proposal: ProposalRecord;
  apiCalls: number;
}

export interface AppendMarkdownResult {
  pageId: string;
  appendedChars: number;
  apiCalls: number;
}

const AMBIGUOUS_CREATE_WINDOW_MS = 2 * 60 * 1000;

export class WriteService {
  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
    private readonly scopeGuard: ScopeGuard,
    private readonly ontologyEngine: OntologyEngine,
    private readonly validator: WriteValidator,
    private readonly approvalGate: ApprovalGate,
  ) {}

  private findAliasByDataSourceId(
    ontology: OntologyConfig,
    dataSourceId: string,
  ): string | null {
    for (const [alias, cfg] of Object.entries(ontology.databases)) {
      if (cfg.data_source_id === dataSourceId) return alias;
    }
    return null;
  }

  private assertWritableProfile(ontology: OntologyConfig, profileName: string): void {
    const scope = ontology.agent_scopes[profileName];
    if (!scope) {
      throw new AxiError("SCOPE_DENIED", `Unknown profile "${profileName}".`);
    }
    if (scope.read_only) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Profile "${profileName}" is read_only and cannot perform write operations.`,
      );
    }
  }

  private async verifyPageWritable(
    ontology: OntologyConfig,
    profileName: string,
    pageInput: string,
  ): Promise<{ pageId: string; page: NotionPage }> {
    this.assertWritableProfile(ontology, profileName);
    const pageId = extractNotionUuid(pageInput);
    if (!pageId) {
      throw new AxiError(
        "INVALID_ARGUMENT",
        `Expected a valid Notion page UUID or URL, got "${pageInput}".`,
      );
    }
    const cache = await this.store.readCache();
    const fractals = await this.store.readFractalPointers();
    await this.scopeGuard.verifyUuidInRootScope(
      ontology,
      cache,
      fractals,
      this.notion,
      profileName,
      pageId,
    );
    const page = await this.notion.getPage(pageId);
    return { pageId, page };
  }

  /**
   * Create a new database record (additive, allowed without approval after WriteValidator).
   * On 5xx/timeout (AMBIGUOUS_WRITE_OUTCOME), runs one read-only verification query by exact
   * title created within the last 2 minutes to avoid duplicating records (DESIGN-DOC.md §4.3).
   */
  async createRecord(
    profileName: string,
    databaseQuery: string,
    mutations: RawPropertyMutation[],
    appendMd?: string,
  ): Promise<CreateRecordResult> {
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();

    const resolved = this.ontologyEngine.resolveDatabase(
      ontology,
      cache,
      profileName,
      databaseQuery,
    );

    const validated = await this.validator.validate({
      ontology,
      profileName,
      alias: resolved.alias,
      mode: "create",
      mutations,
    });

    let createdPage: NotionPage;
    let recovered = false;

    try {
      createdPage = await this.notion.createPage({
        parent: {
          type: "data_source_id",
          data_source_id: resolved.dataSourceId,
        },
        properties: validated.notionProperties,
      });
    } catch (err) {
      if (err instanceof AxiError && err.code === "AMBIGUOUS_WRITE_OUTCOME" && validated.titleValue) {
        const titleProp = Object.values(validated.cachedDs.properties).find(
          (p) => p.type === "title",
        );
        if (titleProp) {
          const check = await this.notion.queryDataSource(resolved.dataSourceId, {
            filter: {
              property: titleProp.name,
              title: { equals: validated.titleValue },
            },
            page_size: 5,
          });
          const cutoff = Date.now() - AMBIGUOUS_CREATE_WINDOW_MS;
          const match = check.results.find(
            (item): item is NotionPage =>
              item.object === "page" && Date.parse(item.last_edited_time) >= cutoff,
          );
          if (match) {
            createdPage = match;
            recovered = true;
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    if (appendMd && appendMd.trim().length > 0) {
      await this.notion.patchPageMarkdown(createdPage.id, {
        type: "insert_content",
        insert_content: { content: appendMd, position: { type: "end" } },
      });
    }

    return {
      pageId: createdPage.id,
      alias: resolved.alias,
      resolvedVia: resolved.resolvedVia,
      recoveredFromAmbiguous: recovered,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  /**
   * Update properties on an existing database record.
   * Executes immediately if all mutations pass WriteValidator and ApprovalGate allowlist;
   * otherwise writes a pending proposal with SHA-256 content hash.
   */
  async updateRecord(
    profileName: string,
    pageInput: string,
    mutations: RawPropertyMutation[],
  ): Promise<UpdateRecordResult> {
    if (mutations.length === 0) {
      throw new AxiError(
        "INVALID_ARGUMENT",
        "At least one --set, --add, --remove, or --clear mutation is required.",
      );
    }

    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const { pageId, page } = await this.verifyPageWritable(ontology, profileName, pageInput);

    const cache = await this.store.readCache();
    let parentDsId: string | null = null;
    if (page.parent.type === "data_source_id") {
      parentDsId = page.parent.data_source_id;
    } else if (page.parent.type === "database_id" && cache) {
      const parentDbId = page.parent.database_id;
      const matchedDs = Object.values(cache.data_sources).find(
        (ds) => ds.database_id === parentDbId,
      );
      parentDsId = matchedDs?.data_source_id ?? null;
    }
    if (!parentDsId) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Page "${pageId}" does not belong to a known database data source; property updates require a database record.`,
      );
    }

    const alias = this.findAliasByDataSourceId(ontology, parentDsId);
    if (!alias) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Page "${pageId}" belongs to unmapped data_source_id "${parentDsId}".`,
      );
    }

    const validated = await this.validator.validate({
      ontology,
      profileName,
      alias,
      mode: "update",
      mutations,
      currentPage: page,
    });

    const classification = this.approvalGate.classifyPropertyChanges(validated.changes);
    if (!classification.requiresApproval) {
      await this.notion.updatePageProperties(pageId, validated.notionProperties);
      return {
        applied: true,
        pageId,
        alias,
        updatedFields: validated.changes.map((c) => c.schema.name),
        apiCalls: this.notion.getCallCount() - startCalls,
      };
    }

    const diffLines = validated.changes.map(
      (c) => `  ${c.schema.name}: "${c.previousFormatted ?? ""}" -> "${c.nextFormatted ?? ""}"`,
    );
    const proposal = await this.approvalGate.createProposal({
      category: "destructive",
      profile: profileName,
      actionType: "update_properties",
      targetId: pageId,
      targetAlias: alias,
      expectedContentHash: computeContentHash({
        parent: page.parent,
        in_trash: Boolean(page.in_trash),
        properties: page.properties,
      }),
      expectedLastEditedTime: page.last_edited_time,
      summary: `Update "${extractPageTitle(page)}" (${alias}): ${classification.reasons.join("; ")}`,
      diff: diffLines.join("\n"),
      payload: {
        kind: "update_properties",
        page_id: pageId,
        properties: validated.notionProperties,
      },
    });

    return {
      applied: false,
      proposal,
      reasons: classification.reasons,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  /**
   * Append Markdown to an existing page (additive, allowed without approval).
   */
  async appendMarkdown(
    profileName: string,
    pageInput: string,
    markdown: string,
  ): Promise<AppendMarkdownResult> {
    if (!markdown.trim()) {
      throw new AxiError("INVALID_ARGUMENT", "Markdown content to append cannot be empty.");
    }
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const { pageId } = await this.verifyPageWritable(ontology, profileName, pageInput);

    await this.notion.patchPageMarkdown(pageId, {
      type: "insert_content",
      insert_content: { content: markdown, position: { type: "end" } },
    });

    return {
      pageId,
      appendedChars: markdown.length,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  /**
   * Replace full page Markdown (always halted into an approval proposal).
   */
  async replaceMarkdown(
    profileName: string,
    pageInput: string,
    newMarkdown: string,
    allowDeletingContent = false,
  ): Promise<ProposalCreatedResult> {
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const { pageId, page } = await this.verifyPageWritable(ontology, profileName, pageInput);
    const liveMd = await this.notion.getPageMarkdown(pageId);

    const proposal = await this.approvalGate.createProposal({
      category: "destructive",
      profile: profileName,
      actionType: "replace_markdown",
      targetId: pageId,
      targetAlias: null,
      expectedContentHash: computeContentHash({ markdown: liveMd.markdown }),
      expectedLastEditedTime: page.last_edited_time,
      summary: `Replace Markdown prose on "${extractPageTitle(page)}" (${liveMd.markdown.length} -> ${newMarkdown.length} chars)`,
      diff: `--- existing (${liveMd.markdown.length} chars)\n+++ proposed (${newMarkdown.length} chars)\n${newMarkdown.slice(0, 400)}`,
      payload: {
        kind: "replace_markdown",
        page_id: pageId,
        new_str: newMarkdown,
        allow_deleting_content: allowDeletingContent,
      },
    });

    return {
      proposal,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  /**
   * Trash / archive a page (in_trash: true, always halted into an approval proposal).
   */
  async trashRecord(
    profileName: string,
    pageInput: string,
  ): Promise<ProposalCreatedResult> {
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const { pageId, page } = await this.verifyPageWritable(ontology, profileName, pageInput);

    const proposal = await this.approvalGate.createProposal({
      category: "destructive",
      profile: profileName,
      actionType: "trash_page",
      targetId: pageId,
      targetAlias: null,
      expectedContentHash: computeContentHash({
        parent: page.parent,
        in_trash: Boolean(page.in_trash),
        properties: page.properties,
      }),
      expectedLastEditedTime: page.last_edited_time,
      summary: `Move page "${extractPageTitle(page)}" (${pageId}) to Notion Trash`,
      diff: `  in_trash: ${Boolean(page.in_trash)} -> true`,
      payload: {
        kind: "trash_page",
        page_id: pageId,
      },
    });

    return {
      proposal,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  /**
   * Move a page to a new parent page or database alias (POST /v1/pages/{id}/move).
   * Enforces ScopeGuard on BOTH source and destination before creating an approval proposal.
   */
  async moveRecord(
    profileName: string,
    pageInput: string,
    destinationInput: string,
  ): Promise<ProposalCreatedResult> {
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();
    const fractals = await this.store.readFractalPointers();
    const { pageId, page } = await this.verifyPageWritable(ontology, profileName, pageInput);

    let destParent:
      | { type: "page_id"; page_id: string }
      | { type: "data_source_id"; data_source_id: string };
    let destLabel: string;

    const destUuid = extractNotionUuid(destinationInput);
    if (destUuid) {
      // Check if UUID matches a configured data_source_id or an authorized page inside Root Page.
      const matchedAlias = this.findAliasByDataSourceId(ontology, destUuid);
      if (matchedAlias) {
        this.scopeGuard.assertDatabaseAccess(ontology, profileName, matchedAlias, "write");
        destParent = { type: "data_source_id", data_source_id: destUuid };
        destLabel = `${matchedAlias} (${destUuid})`;
      } else {
        await this.scopeGuard.verifyUuidInRootScope(
          ontology,
          cache,
          fractals,
          this.notion,
          profileName,
          destUuid,
        );
        destParent = { type: "page_id", page_id: destUuid };
        destLabel = destUuid;
      }
    } else {
      // Destination specified as a database alias.
      const resolved = this.ontologyEngine.resolveDatabase(
        ontology,
        cache,
        profileName,
        destinationInput,
      );
      this.scopeGuard.assertDatabaseAccess(ontology, profileName, resolved.alias, "write");
      destParent = { type: "data_source_id", data_source_id: resolved.dataSourceId };
      destLabel = `${resolved.alias} (${resolved.dataSourceId})`;
    }

    const proposal = await this.approvalGate.createProposal({
      category: "destructive",
      profile: profileName,
      actionType: "move_page",
      targetId: pageId,
      targetAlias: null,
      expectedContentHash: computeContentHash({
        parent: page.parent,
        in_trash: Boolean(page.in_trash),
        properties: page.properties,
      }),
      expectedLastEditedTime: page.last_edited_time,
      summary: `Move page "${extractPageTitle(page)}" (${pageId}) to ${destLabel}`,
      diff: `  parent: ${JSON.stringify(page.parent)} -> ${JSON.stringify(destParent)}`,
      payload: {
        kind: "move_page",
        page_id: pageId,
        parent: destParent,
      },
    });

    return {
      proposal,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  /**
   * Propose adding a new select or multi_select option (always halted as a schema proposal).
   */
  async proposeSchemaOption(
    profileName: string,
    databaseQuery: string,
    propertyInput: string,
    optionValue: string,
  ): Promise<ProposalCreatedResult> {
    const cleanVal = optionValue.trim();
    if (!cleanVal || cleanVal.includes(",")) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Option name "${optionValue}" must be non-empty and cannot contain commas.`,
      );
    }

    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();
    const resolved = this.ontologyEngine.resolveDatabase(
      ontology,
      cache,
      profileName,
      databaseQuery,
    );
    this.scopeGuard.assertDatabaseAccess(ontology, profileName, resolved.alias, "write");

    const liveDs = await this.notion.getDataSource(resolved.dataSourceId);
    const cached = toCachedDataSource(liveDs, null);
    const prop =
      cached.properties[propertyInput] ??
      Object.values(cached.properties).find(
        (p) => normalizeNfd(p.name) === normalizeNfd(propertyInput),
      );

    if (!prop) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Unknown property "${propertyInput}" on database "${resolved.alias}".`,
      );
    }
    if (prop.type !== "select" && prop.type !== "multi_select") {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Adding schema options is only supported for select and multi_select (got "${prop.name}" of type ${prop.type}).`,
      );
    }

    const existing = prop.options ?? [];
    if (existing.some((o) => normalizeNfd(o) === normalizeNfd(cleanVal))) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Option "${cleanVal}" already exists on "${prop.name}" in "${resolved.alias}".`,
      );
    }

    const allOptions = [...existing, cleanVal].map((name) => ({ name }));
    const proposal = await this.approvalGate.createProposal({
      category: "schema",
      profile: profileName,
      actionType: "schema_add_option",
      targetId: resolved.dataSourceId,
      targetAlias: resolved.alias,
      expectedContentHash: computeContentHash({ properties: liveDs.properties }),
      expectedLastEditedTime: liveDs.last_edited_time,
      summary: `Add ${prop.type} option "${cleanVal}" to "${prop.name}" on "${resolved.alias}"`,
      diff: `  ${prop.name} (${prop.type}): + "${cleanVal}" (preserving ${existing.length} existing options)`,
      payload: {
        kind: "schema_add_option",
        data_source_id: resolved.dataSourceId,
        property_name: prop.name,
        property_type: prop.type,
        new_option: cleanVal,
        all_options: allOptions,
      },
    });

    return {
      proposal,
      apiCalls: this.notion.getCallCount() - startCalls,
    };
  }

  async approveProposal(
    proposalId: string,
    actingProfile?: string,
  ): Promise<ApprovalExecutionResult> {
    const ontology = await this.store.readOntology();
    const proposal = await this.store.readProposal(proposalId);
    const profileToCheck = actingProfile ?? proposal.profile;
    this.assertWritableProfile(ontology, profileToCheck);
    if (actingProfile && actingProfile !== proposal.profile) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Profile "${actingProfile}" cannot approve proposal "${proposalId}" owned by profile "${proposal.profile}".`,
      );
    }
    return this.approvalGate.approveProposal(proposalId);
  }
}
