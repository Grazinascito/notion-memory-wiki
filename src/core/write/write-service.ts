import { AxiError } from "../../shared/errors.js";
import {
  extractNotionUuid,
  normalizeNfd,
  sanitizeNotionUris,
} from "../../shared/text.js";
import type {
  AgentScopeConfig,
  NotionPage,
  OntologyConfig,
  ProposalRecord,
} from "../../shared/types.js";
import type {
  ApprovalExecutionResult,
  ApprovalGate,
} from "../approval/approval-gate.js";
import {
  hashDataSourceSchema,
  hashMarkdown,
  hashPageState,
} from "../approval/approval-gate.js";
import type { OntologyEngine } from "../ontology/ontology-engine.js";
import type { MetadataStore, NotionGateway } from "../ports.js";
import type { ScopeGuard } from "../scope/scope-guard.js";
import { extractPageTitle } from "../sync/notion-mapper.js";
import {
  type RawPropertyMutation,
  UnknownOptionError,
  type ValidationResult,
  type WriteValidator,
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

function isNotionValidation400(err: unknown): boolean {
  return (
    err instanceof AxiError &&
    err.httpStatus === 400 &&
    err.message.toLowerCase().includes("validation_error")
  );
}

export class WriteService {
  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
    private readonly scopeGuard: ScopeGuard,
    private readonly ontologyEngine: OntologyEngine,
    private readonly validator: WriteValidator,
    private readonly approvalGate: ApprovalGate,
  ) {}

  static async resolveApprovalProfile(
    store: MetadataStore,
    scopeGuard: ScopeGuard,
    ontology: OntologyConfig,
    proposalId: string,
    envProfile?: string,
    cliProfile?: string,
  ): Promise<{
    proposal: ProposalRecord;
    profileName: string;
    scope: AgentScopeConfig;
  }> {
    const proposal = await store.readProposal(proposalId);
    // If WIKI_AGENT_PROFILE is set, enforce environment lock; otherwise use proposal's profile
    // so out-of-band terminal `wiki approve <proposal_id>` works cleanly in multi-profile workspaces.
    const { profileName, scope } = scopeGuard.resolveProfile(
      ontology,
      envProfile,
      cliProfile ?? (envProfile ? undefined : proposal.profile),
    );
    return { proposal, profileName, scope };
  }

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

  private async executeCreateWithRecovery(
    dataSourceId: string,
    validated: ValidationResult,
  ): Promise<{ createdPage: NotionPage; recovered: boolean }> {
    const startedMs = Date.now();
    try {
      const createdPage = await this.notion.createPage({
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: validated.notionProperties,
      });
      return { createdPage, recovered: false };
    } catch (err) {
      if (
        err instanceof AxiError &&
        err.code === "AMBIGUOUS_WRITE_OUTCOME" &&
        validated.titleValue
      ) {
        const titleProp = Object.values(validated.cachedDs.properties).find(
          (p) => p.type === "title",
        );
        if (titleProp) {
          const check = await this.notion.queryDataSource(dataSourceId, {
            filter: {
              property: titleProp.name,
              title: { equals: validated.titleValue },
            },
            sorts: [{ timestamp: "created_time", direction: "descending" }],
            page_size: 5,
          });
          const cutoffMs =
            Math.floor((startedMs - AMBIGUOUS_CREATE_WINDOW_MS) / 60_000) * 60_000;
          const match = check.results.find((item): item is NotionPage => {
            if (item.object !== "page" || !item.created_time) return false;
            const createdMs = Date.parse(item.created_time);
            return Number.isFinite(createdMs) && createdMs >= cutoffMs;
          });
          if (match) {
            return { createdPage: match, recovered: true };
          }
        }
      }
      throw err;
    }
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
  ): Promise<CreateRecordResult>;
  async createRecord(
    profileName: string,
    databaseQuery: string,
    mutations: RawPropertyMutation[],
    appendMd: string | undefined,
    options: { proposeNewOption?: boolean },
  ): Promise<CreateRecordResult | ProposalCreatedResult>;
  async createRecord(
    profileName: string,
    databaseQuery: string,
    mutations: RawPropertyMutation[],
    appendMd?: string,
    options?: { proposeNewOption?: boolean },
  ): Promise<CreateRecordResult | ProposalCreatedResult> {
    const startCalls = this.notion.getCallCount();
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();

    const resolved = this.ontologyEngine.resolveDatabase(
      ontology,
      cache,
      profileName,
      databaseQuery,
    );

    let validated: ValidationResult;
    try {
      validated = await this.validator.validate({
        ontology,
        profileName,
        alias: resolved.alias,
        mode: "create",
        mutations,
      });
    } catch (err) {
      if (err instanceof UnknownOptionError && options?.proposeNewOption) {
        const proposalRes = await this.proposeSchemaOption(
          profileName,
          resolved.alias,
          err.propertyName,
          err.optionValue,
        );
        return {
          proposal: proposalRes.proposal,
          apiCalls: this.notion.getCallCount() - startCalls,
        };
      }
      throw err;
    }

    let createdPage: NotionPage;
    let recovered = false;

    try {
      const attempt = await this.executeCreateWithRecovery(resolved.dataSourceId, validated);
      createdPage = attempt.createdPage;
      recovered = attempt.recovered;
    } catch (err) {
      if (!isNotionValidation400(err)) throw err;

      await this.validator.refreshDataSourceSchema(ontology, resolved.dataSourceId);
      const revalidated = await this.validator.validate({
        ontology,
        profileName,
        alias: resolved.alias,
        mode: "create",
        mutations,
        skipDriftRefresh: true,
      });
      if (
        JSON.stringify(revalidated.notionProperties) ===
        JSON.stringify(validated.notionProperties)
      ) {
        throw err;
      }
      const retryAttempt = await this.executeCreateWithRecovery(
        resolved.dataSourceId,
        revalidated,
      );
      createdPage = retryAttempt.createdPage;
      recovered = retryAttempt.recovered;
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

  private async buildUpdateProposal(params: {
    profileName: string;
    pageId: string;
    alias: string;
    page: NotionPage;
    validated: ValidationResult;
    reasons: string[];
    startCalls: number;
  }): Promise<UpdateRecordResult> {
    const { profileName, pageId, alias, page, validated, reasons, startCalls } = params;
    const safeReasons = reasons.map((r) => sanitizeNotionUris(r));
    const diffLines = validated.changes.map(
      (c) =>
        `  ${sanitizeNotionUris(c.schema.name)}: "${sanitizeNotionUris(c.previousFormatted ?? "")}" -> "${sanitizeNotionUris(c.nextFormatted ?? "")}"`,
    );
    const proposal = await this.approvalGate.createProposal({
      category: "destructive",
      profile: profileName,
      actionType: "update_properties",
      targetId: pageId,
      targetAlias: alias,
      expectedContentHash: hashPageState(page),
      expectedLastEditedTime: page.last_edited_time,
      summary: `Update "${sanitizeNotionUris(extractPageTitle(page))}" (${alias}): ${safeReasons.join("; ")}`,
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
      reasons: safeReasons,
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
    options?: { proposeNewOption?: boolean },
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

    let validated: ValidationResult;
    try {
      validated = await this.validator.validate({
        ontology,
        profileName,
        alias,
        mode: "update",
        mutations,
        currentPage: page,
      });
    } catch (err) {
      if (err instanceof UnknownOptionError && options?.proposeNewOption) {
        const proposalRes = await this.proposeSchemaOption(
          profileName,
          alias,
          err.propertyName,
          err.optionValue,
        );
        return {
          applied: false,
          proposal: proposalRes.proposal,
          reasons: [
            `Option "${err.optionValue}" does not exist on "${err.propertyName}"; created schema proposal`,
          ],
          apiCalls: this.notion.getCallCount() - startCalls,
        };
      }
      throw err;
    }

    const classification = this.approvalGate.classifyPropertyChanges(validated.changes);
    if (classification.requiresApproval) {
      return this.buildUpdateProposal({
        profileName,
        pageId,
        alias,
        page,
        validated,
        reasons: classification.reasons,
        startCalls,
      });
    }

    try {
      await this.notion.updatePageProperties(pageId, validated.notionProperties);
      return {
        applied: true,
        pageId,
        alias,
        updatedFields: validated.changes.map((c) => c.schema.name),
        apiCalls: this.notion.getCallCount() - startCalls,
      };
    } catch (err) {
      if (!isNotionValidation400(err)) throw err;

      await this.validator.refreshDataSourceSchema(ontology, parentDsId);
      const revalidated = await this.validator.validate({
        ontology,
        profileName,
        alias,
        mode: "update",
        mutations,
        currentPage: page,
        skipDriftRefresh: true,
      });
      const recheck = this.approvalGate.classifyPropertyChanges(revalidated.changes);
      if (recheck.requiresApproval) {
        return this.buildUpdateProposal({
          profileName,
          pageId,
          alias,
          page,
          validated: revalidated,
          reasons: recheck.reasons,
          startCalls,
        });
      }
      if (
        JSON.stringify(revalidated.notionProperties) ===
        JSON.stringify(validated.notionProperties)
      ) {
        throw err;
      }
      await this.notion.updatePageProperties(pageId, revalidated.notionProperties);
      return {
        applied: true,
        pageId,
        alias,
        updatedFields: revalidated.changes.map((c) => c.schema.name),
        apiCalls: this.notion.getCallCount() - startCalls,
      };
    }
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
    const safeTitle = sanitizeNotionUris(extractPageTitle(page));
    const safeExcerpt = sanitizeNotionUris(liveMd.markdown.slice(0, 400));

    const proposal = await this.approvalGate.createProposal({
      category: "destructive",
      profile: profileName,
      actionType: "replace_markdown",
      targetId: pageId,
      targetAlias: null,
      expectedContentHash: hashMarkdown(liveMd.markdown),
      expectedLastEditedTime: page.last_edited_time,
      summary: `Replace Markdown prose on "${safeTitle}" (${liveMd.markdown.length} -> ${newMarkdown.length} chars)`,
      diff: `--- existing (${liveMd.markdown.length} chars)\n+++ proposed (${newMarkdown.length} chars)\n${safeExcerpt}`,
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
    const safeTitle = sanitizeNotionUris(extractPageTitle(page));

    const proposal = await this.approvalGate.createProposal({
      category: "destructive",
      profile: profileName,
      actionType: "trash_page",
      targetId: pageId,
      targetAlias: null,
      expectedContentHash: hashPageState(page),
      expectedLastEditedTime: page.last_edited_time,
      summary: `Move page "${safeTitle}" (${pageId}) to Notion Trash`,
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
      let matchedAlias = this.findAliasByDataSourceId(ontology, destUuid);
      let matchedDataSourceId: string | null = matchedAlias ? destUuid : null;

      if (!matchedAlias && cache) {
        const matchedByDb = Object.values(cache.data_sources).find(
          (ds) => ds.database_id === destUuid,
        );
        if (matchedByDb) {
          matchedDataSourceId = matchedByDb.data_source_id;
          matchedAlias = this.findAliasByDataSourceId(ontology, matchedDataSourceId);
          if (!matchedAlias) {
            throw new AxiError(
              "SCOPE_DENIED",
              `Database "${destUuid}" (data_source_id: "${matchedDataSourceId}") is not mapped in ontology.yaml.`,
            );
          }
        }
      }

      if (matchedAlias && matchedDataSourceId) {
        this.scopeGuard.assertDatabaseAccess(ontology, profileName, matchedAlias, "write");
        destParent = { type: "data_source_id", data_source_id: matchedDataSourceId };
        destLabel = `${matchedAlias} (${matchedDataSourceId})`;
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

    const safeTitle = sanitizeNotionUris(extractPageTitle(page));
    const proposal = await this.approvalGate.createProposal({
      category: "destructive",
      profile: profileName,
      actionType: "move_page",
      targetId: pageId,
      targetAlias: null,
      expectedContentHash: hashPageState(page),
      expectedLastEditedTime: page.last_edited_time,
      summary: `Move page "${safeTitle}" (${pageId}) to ${sanitizeNotionUris(destLabel)}`,
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
    const liveEntry =
      (Object.prototype.hasOwnProperty.call(liveDs.properties, propertyInput)
        ? ([propertyInput, liveDs.properties[propertyInput]!] as const)
        : undefined) ??
      Object.entries(liveDs.properties).find(
        ([key, schema]) =>
          schema.id === propertyInput ||
          normalizeNfd(schema.name ?? key) === normalizeNfd(propertyInput),
      );

    if (!liveEntry) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Unknown property "${propertyInput}" on database "${resolved.alias}".`,
      );
    }
    const [liveKey, liveProp] = liveEntry;
    const propName = liveProp.name ?? liveKey;
    if (liveProp.type !== "select" && liveProp.type !== "multi_select") {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Adding schema options is only supported for select and multi_select (got "${propName}" of type ${liveProp.type}).`,
      );
    }

    const rawOptions =
      liveProp.type === "select" ? liveProp.select.options : liveProp.multi_select.options;
    if (rawOptions.some((o) => normalizeNfd(o.name) === normalizeNfd(cleanVal))) {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Option "${cleanVal}" already exists on "${propName}" in "${resolved.alias}".`,
      );
    }

    const allOptions = [
      ...rawOptions.map((o) => ({
        ...(o.id ? { id: o.id } : {}),
        name: o.name,
        ...(o.color ? { color: o.color } : {}),
      })),
      { name: cleanVal },
    ];
    const safePropName = sanitizeNotionUris(propName);
    const safeNewVal = sanitizeNotionUris(cleanVal);

    const proposal = await this.approvalGate.createProposal({
      category: "schema",
      profile: profileName,
      actionType: "schema_add_option",
      targetId: resolved.dataSourceId,
      targetAlias: resolved.alias,
      expectedContentHash: hashDataSourceSchema(liveDs),
      expectedLastEditedTime: liveDs.last_edited_time,
      summary: `Add ${liveProp.type} option "${safeNewVal}" to "${safePropName}" on "${resolved.alias}"`,
      diff: `  ${safePropName} (${liveProp.type}): + "${safeNewVal}" (preserving ${rawOptions.length} existing options)`,
      payload: {
        kind: "schema_add_option",
        data_source_id: resolved.dataSourceId,
        property_name: propName,
        property_type: liveProp.type,
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
    preloadedProposal?: ProposalRecord,
  ): Promise<ApprovalExecutionResult> {
    const ontology = await this.store.readOntology();
    const proposal = preloadedProposal ?? (await this.store.readProposal(proposalId));
    const profileToCheck = actingProfile ?? proposal.profile;
    this.assertWritableProfile(ontology, profileToCheck);
    if (actingProfile && actingProfile !== proposal.profile) {
      throw new AxiError(
        "SCOPE_DENIED",
        `Profile "${actingProfile}" cannot approve proposal "${proposalId}" owned by profile "${proposal.profile}".`,
      );
    }

    const cache = await this.store.readCache();
    const fractals = await this.store.readFractalPointers();
    const payload = proposal.payload;

    if (
      payload.kind === "update_properties" ||
      payload.kind === "trash_page" ||
      payload.kind === "replace_markdown" ||
      payload.kind === "move_page"
    ) {
      await this.scopeGuard.verifyUuidInRootScope(
        ontology,
        cache,
        fractals,
        this.notion,
        profileToCheck,
        payload.page_id,
        { bypassCache: true },
      );
      if (proposal.target_alias) {
        this.scopeGuard.assertDatabaseAccess(
          ontology,
          profileToCheck,
          proposal.target_alias,
          "write",
        );
      }
      if (payload.kind === "move_page") {
        if (payload.parent.type === "data_source_id") {
          this.scopeGuard.assertDataSourceAccess(
            ontology,
            profileToCheck,
            payload.parent.data_source_id,
          );
          const destAlias = this.findAliasByDataSourceId(
            ontology,
            payload.parent.data_source_id,
          );
          if (!destAlias) {
            throw new AxiError(
              "SCOPE_DENIED",
              `Destination data source "${payload.parent.data_source_id}" is no longer mapped in ontology.yaml.`,
            );
          }
          this.scopeGuard.assertDatabaseAccess(ontology, profileToCheck, destAlias, "write");
        } else {
          await this.scopeGuard.verifyUuidInRootScope(
            ontology,
            cache,
            fractals,
            this.notion,
            profileToCheck,
            payload.parent.page_id,
            { bypassCache: true },
          );
        }
      }
    } else if (payload.kind === "schema_add_option") {
      const schemaAlias = this.findAliasByDataSourceId(ontology, payload.data_source_id);
      if (!schemaAlias) {
        throw new AxiError(
          "SCOPE_DENIED",
          `Data source "${payload.data_source_id}" is no longer mapped in ontology.yaml.`,
        );
      }
      this.scopeGuard.assertDatabaseAccess(ontology, profileToCheck, schemaAlias, "write");
    }

    return this.approvalGate.approveProposal(proposalId);
  }
}
