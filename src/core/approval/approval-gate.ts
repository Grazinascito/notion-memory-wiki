import crypto from "node:crypto";
import { AxiError } from "../../shared/errors.js";
import type {
  ProposalActionType,
  ProposalCategory,
  ProposalPayload,
  ProposalRecord,
} from "../../shared/types.js";
import type { MetadataStore, NotionGateway } from "../ports.js";
import type { ValidatedPropertyChange } from "../validation/write-validator.js";

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

const ROUTINE_NON_EMPTY_SCALAR_TYPES = new Set([
  "status",
  "select",
  "date",
  "checkbox",
  "number",
  "url",
  "email",
  "phone_number",
  "verification",
]);

export interface ClassificationResult {
  requiresApproval: boolean;
  reasons: string[];
}

export interface ApprovalExecutionResult {
  proposalId: string;
  category: ProposalCategory;
  actionType: ProposalActionType;
  targetId: string;
  summary: string;
}

/**
 * Deterministic canonical JSON serialization with sorted keys so SHA-256
 * hashes remain identical regardless of property insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function computeContentHash(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

/**
 * Default-approval destructive/schema action gate (DESIGN-DOC.md §3.2.4).
 * Any mutation not on the explicit non-destructive allowlist halts into a proposal.
 */
export class ApprovalGate {
  constructor(
    private readonly notion: NotionGateway,
    private readonly store: MetadataStore,
  ) {}

  classifyPropertyChanges(changes: ValidatedPropertyChange[]): ClassificationResult {
    const reasons: string[] = [];

    for (const ch of changes) {
      const prev = (ch.previousFormatted ?? "").trim();
      const hasPrevious = prev.length > 0;

      // 1. Clearing any currently populated property -> halt.
      if (ch.op === "clear") {
        if (hasPrevious) {
          reasons.push(`clears populated property "${ch.schema.name}" (was "${prev}")`);
        }
        continue;
      }

      // 2. Populating an empty rich_text property -> allow; overwriting non-empty title/rich_text -> halt.
      if (ch.schema.type === "rich_text") {
        if (ch.op === "set" && !hasPrevious) continue;
        reasons.push(`overwrites non-empty rich_text "${ch.schema.name}"`);
        continue;
      }
      if (ch.schema.type === "title") {
        if (ch.op === "set" && !hasPrevious) continue;
        reasons.push(`overwrites non-empty title "${ch.schema.name}"`);
        continue;
      }

      // 3. Routine non-empty scalar updates -> allow.
      if (ch.op === "set" && ROUTINE_NON_EMPTY_SCALAR_TYPES.has(ch.schema.type)) {
        continue;
      }

      // 4. relation and multi_select array semantics:
      //    - --add is always non-destructive (additive union).
      //    - --remove of a single named item leaving >= 1 item is routine.
      //    - Emptying the array or --set dropping >= 1 existing item halts for approval.
      if (ch.schema.type === "relation" || ch.schema.type === "multi_select") {
        const prevItems = ch.previousItems ?? [];
        const nextItems = ch.nextItems ?? [];

        if (ch.op === "add") {
          continue;
        }
        if (ch.op === "remove") {
          const removedCount = prevItems.filter((item) => !nextItems.includes(item)).length;
          if (nextItems.length >= 1 && removedCount <= 1) {
            continue;
          }
          if (prevItems.length > 0 && nextItems.length === 0) {
            reasons.push(`empties populated ${ch.schema.type} "${ch.schema.name}"`);
          } else if (removedCount > 1) {
            reasons.push(
              `removes ${removedCount} existing items from ${ch.schema.type} "${ch.schema.name}"`,
            );
          }
          continue;
        }
        if (ch.op === "set") {
          const dropped = prevItems.filter((item) => !nextItems.includes(item));
          if (dropped.length === 0) {
            continue;
          }
          reasons.push(
            `replaces ${ch.schema.type} "${ch.schema.name}" dropping ${dropped.length} existing item(s)`,
          );
          continue;
        }
      }

      // 5. Default-approval rule: anything not explicitly allowlisted halts.
      reasons.push(
        `operation "${ch.op}" on "${ch.schema.name}" (${ch.schema.type}) is not on the non-destructive allowlist`,
      );
    }

    return {
      requiresApproval: reasons.length > 0,
      reasons,
    };
  }

  async createProposal(params: {
    category: ProposalCategory;
    profile: string;
    actionType: ProposalActionType;
    targetId: string;
    targetAlias: string | null;
    expectedContentHash: string;
    expectedLastEditedTime: string;
    summary: string;
    diff: string;
    payload: ProposalPayload;
  }): Promise<ProposalRecord> {
    const now = Date.now();
    const proposal: ProposalRecord = {
      proposal_id: `prop_${crypto.randomBytes(6).toString("hex")}`,
      category: params.category,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + PROPOSAL_TTL_MS).toISOString(),
      profile: params.profile,
      action_type: params.actionType,
      target_id: params.targetId,
      target_alias: params.targetAlias,
      expected_content_hash: params.expectedContentHash,
      expected_last_edited_time: params.expectedLastEditedTime,
      summary: params.summary,
      diff: params.diff,
      payload: params.payload,
      status: "pending",
    };

    await this.store.writeProposal(proposal);
    return proposal;
  }

  /**
   * Execute a pending destructive or schema proposal after verifying TTL
   * and recomputing SHA-256 content hash against live Notion state.
   */
  async approveProposal(proposalId: string): Promise<ApprovalExecutionResult> {
    const proposal = await this.store.readProposal(proposalId);

    if (proposal.status !== "pending") {
      throw new AxiError(
        "VALIDATION_ERROR",
        `Proposal "${proposalId}" is already "${proposal.status}".`,
      );
    }
    if (Date.now() > Date.parse(proposal.expires_at)) {
      proposal.status = "expired";
      await this.store.writeProposal(proposal);
      throw new AxiError(
        "CONFLICT_STALE_TARGET",
        `Proposal "${proposalId}" expired at ${proposal.expires_at}. Re-run the write command to create a fresh proposal.`,
      );
    }

    const payload = proposal.payload;

    if (
      payload.kind === "update_properties" ||
      payload.kind === "trash_page" ||
      payload.kind === "move_page"
    ) {
      const livePage = await this.notion.getPage(payload.page_id);
      const liveHash = computeContentHash({
        parent: livePage.parent,
        in_trash: Boolean(livePage.in_trash),
        properties: livePage.properties,
      });
      if (liveHash !== proposal.expected_content_hash) {
        throw new AxiError(
          "CONFLICT_STALE_TARGET",
          `Target page "${payload.page_id}" changed in Notion after proposal "${proposalId}" was created (content hash mismatch).`,
          ["Re-read the page and re-generate the proposal before approving."],
        );
      }

      if (payload.kind === "update_properties") {
        await this.notion.updatePageProperties(payload.page_id, payload.properties);
      } else if (payload.kind === "trash_page") {
        await this.notion.trashPage(payload.page_id);
      } else {
        await this.notion.movePage(payload.page_id, payload.parent);
      }
    } else if (payload.kind === "replace_markdown") {
      const liveMd = await this.notion.getPageMarkdown(payload.page_id);
      const liveHash = computeContentHash({ markdown: liveMd.markdown });
      if (liveHash !== proposal.expected_content_hash) {
        throw new AxiError(
          "CONFLICT_STALE_TARGET",
          `Target page "${payload.page_id}" Markdown changed in Notion after proposal "${proposalId}" was created.`,
          ["Re-read the page and re-generate the proposal before approving."],
        );
      }

      await this.notion.patchPageMarkdown(payload.page_id, {
        type: "replace_content",
        replace_content: {
          new_str: payload.new_str,
          allow_deleting_content: payload.allow_deleting_content,
        },
      });
    } else if (payload.kind === "schema_add_option") {
      const liveDs = await this.notion.getDataSource(payload.data_source_id);
      const liveHash = computeContentHash({ properties: liveDs.properties });
      if (liveHash !== proposal.expected_content_hash) {
        throw new AxiError(
          "CONFLICT_STALE_TARGET",
          `Target data source "${payload.data_source_id}" schema changed in Notion after proposal "${proposalId}" was created.`,
          ["Run `wiki sync` and re-generate the schema proposal."],
        );
      }

      await this.notion.updateDataSource(payload.data_source_id, {
        properties: {
          [payload.property_name]: {
            [payload.property_type]: {
              options: payload.all_options,
            },
          },
        },
      });
    }

    proposal.status = "applied";
    await this.store.writeProposal(proposal);

    return {
      proposalId: proposal.proposal_id,
      category: proposal.category,
      actionType: proposal.action_type,
      targetId: proposal.target_id,
      summary: proposal.summary,
    };
  }
}
