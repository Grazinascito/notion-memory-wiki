import type { NotionGateway } from "../core/ports.js";
import type { RawPropertyMutation } from "../core/validation/write-validator.js";
import { WriteService } from "../core/write/write-service.js";
import { AxiError } from "../shared/errors.js";
import { classifyResolution } from "../shared/text.js";
import type { MetricEvent, OntologyConfig } from "../shared/types.js";
import type { AppContainer } from "./bootstrap.js";
import {
  formatAppendToon,
  formatApproveToon,
  formatCreateToon,
  formatProposalToon,
  formatUpdateToon,
} from "./toon.js";

export interface WriteCommandContext {
  app: AppContainer;
  profileName: string;
  tokenRef?: string;
  positionals: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
  startedAt: number;
  setActiveGateway: (gw: NotionGateway) => void;
  setResolvedVia: (via: MetricEvent["resolved_via"]) => void;
}

function parseKeyValueFlags(
  op: "set" | "add" | "remove",
  values: string[] | undefined,
): RawPropertyMutation[] {
  const out: RawPropertyMutation[] = [];
  for (const raw of values ?? []) {
    const eqIdx = raw.indexOf("=");
    if (eqIdx <= 0) {
      throw new AxiError(
        "INVALID_ARGUMENT",
        `Flag --${op} expects "Property=Value", got "${raw}".`,
      );
    }
    out.push({
      op,
      property: raw.slice(0, eqIdx).trim(),
      value: raw.slice(eqIdx + 1).trim(),
    });
  }
  return out;
}

function collectMutations(flags: Map<string, string[]>): RawPropertyMutation[] {
  const mutations: RawPropertyMutation[] = [
    ...parseKeyValueFlags("set", flags.get("--set")),
    ...parseKeyValueFlags("add", flags.get("--add")),
    ...parseKeyValueFlags("remove", flags.get("--remove")),
  ];
  for (const prop of flags.get("--clear") ?? []) {
    mutations.push({ op: "clear", property: prop.trim() });
  }
  return mutations;
}

async function logMetric(params: {
  app: AppContainer;
  profile: string;
  command: string;
  targetAlias: string | null;
  resolvedVia: MetricEvent["resolved_via"];
  outcome: MetricEvent["outcome"];
  notionCalls: number;
  startedAt: number;
}): Promise<void> {
  await params.app.metrics.append({
    ts: new Date().toISOString(),
    profile: params.profile,
    command: params.command,
    target_alias: params.targetAlias,
    resolved_via: params.resolvedVia,
    outcome: params.outcome,
    error_code: null,
    http_status: 200,
    notion_calls: params.notionCalls,
    duration_ms: Date.now() - params.startedAt,
  });
}

export async function handleWriteCommand(ctx: WriteCommandContext): Promise<void> {
  const sub = ctx.positionals[0];
  const target = ctx.positionals[1];
  if (!sub || !target) {
    throw new AxiError(
      "INVALID_ARGUMENT",
      "Usage: wiki write <create|update|append|replace|trash|move> <target> [flags]",
    );
  }

  const { token } = await ctx.app.secrets.resolveToken({
    profile: ctx.profileName,
    tokenRef: ctx.tokenRef,
  });
  const gateway = ctx.app.createNotionGateway(token);
  ctx.setActiveGateway(gateway);
  const writeService = ctx.app.createWriteService(gateway);
  const proposeNewOption = ctx.booleans.has("--propose-new-option");

  if (sub === "create") {
    const mutations = collectMutations(ctx.flags);
    const appendMd = ctx.flags.get("--md")?.[0];
    const res = await writeService.createRecord(
      ctx.profileName,
      target,
      mutations,
      appendMd,
      { proposeNewOption },
    );
    if ("proposal" in res) {
      ctx.setResolvedVia("alias");
      console.log(formatProposalToon(res));
      await logMetric({
        app: ctx.app,
        profile: ctx.profileName,
        command: "write:create",
        targetAlias: res.proposal.target_alias,
        resolvedVia: "alias",
        outcome: "proposal_created",
        notionCalls: res.apiCalls,
        startedAt: ctx.startedAt,
      });
      return;
    }
    ctx.setResolvedVia(res.resolvedVia);
    console.log(formatCreateToon(res));
    await logMetric({
      app: ctx.app,
      profile: ctx.profileName,
      command: "write:create",
      targetAlias: res.alias,
      resolvedVia: res.resolvedVia,
      outcome: "ok",
      notionCalls: res.apiCalls,
      startedAt: ctx.startedAt,
    });
    return;
  }

  if (sub === "update") {
    const resolvedVia = classifyResolution(target);
    ctx.setResolvedVia(resolvedVia);
    const mutations = collectMutations(ctx.flags);
    const res = await writeService.updateRecord(ctx.profileName, target, mutations, {
      proposeNewOption,
    });
    console.log(formatUpdateToon(res));
    await logMetric({
      app: ctx.app,
      profile: ctx.profileName,
      command: "write:update",
      targetAlias: res.applied ? res.alias : res.proposal.target_alias,
      resolvedVia,
      outcome: res.applied ? "ok" : "proposal_created",
      notionCalls: res.apiCalls,
      startedAt: ctx.startedAt,
    });
    return;
  }

  if (sub === "append") {
    const md = ctx.flags.get("--md")?.[0];
    if (!md) {
      throw new AxiError("INVALID_ARGUMENT", 'Usage: wiki write append <page-id> --md "..."');
    }
    const resolvedVia = classifyResolution(target);
    ctx.setResolvedVia(resolvedVia);
    const res = await writeService.appendMarkdown(ctx.profileName, target, md);
    console.log(formatAppendToon(res));
    await logMetric({
      app: ctx.app,
      profile: ctx.profileName,
      command: "write:append",
      targetAlias: null,
      resolvedVia,
      outcome: "ok",
      notionCalls: res.apiCalls,
      startedAt: ctx.startedAt,
    });
    return;
  }

  if (sub === "replace") {
    const md = ctx.flags.get("--md")?.[0];
    if (md === undefined) {
      throw new AxiError("INVALID_ARGUMENT", 'Usage: wiki write replace <page-id> --md "..."');
    }
    const resolvedVia = classifyResolution(target);
    ctx.setResolvedVia(resolvedVia);
    const res = await writeService.replaceMarkdown(
      ctx.profileName,
      target,
      md,
      ctx.booleans.has("--allow-deleting-content"),
    );
    console.log(formatProposalToon(res));
    await logMetric({
      app: ctx.app,
      profile: ctx.profileName,
      command: "write:replace",
      targetAlias: null,
      resolvedVia,
      outcome: "proposal_created",
      notionCalls: res.apiCalls,
      startedAt: ctx.startedAt,
    });
    return;
  }

  if (sub === "trash") {
    const resolvedVia = classifyResolution(target);
    ctx.setResolvedVia(resolvedVia);
    const res = await writeService.trashRecord(ctx.profileName, target);
    console.log(formatProposalToon(res));
    await logMetric({
      app: ctx.app,
      profile: ctx.profileName,
      command: "write:trash",
      targetAlias: null,
      resolvedVia,
      outcome: "proposal_created",
      notionCalls: res.apiCalls,
      startedAt: ctx.startedAt,
    });
    return;
  }

  if (sub === "move") {
    const dest = ctx.flags.get("--to")?.[0];
    if (!dest) {
      throw new AxiError(
        "INVALID_ARGUMENT",
        "Usage: wiki write move <page-id> --to <parent-id-or-alias>",
      );
    }
    const resolvedVia = classifyResolution(target);
    ctx.setResolvedVia(resolvedVia);
    const res = await writeService.moveRecord(ctx.profileName, target, dest);
    console.log(formatProposalToon(res));
    await logMetric({
      app: ctx.app,
      profile: ctx.profileName,
      command: "write:move",
      targetAlias: null,
      resolvedVia,
      outcome: "proposal_created",
      notionCalls: res.apiCalls,
      startedAt: ctx.startedAt,
    });
    return;
  }

  throw new AxiError(
    "INVALID_ARGUMENT",
    `Unknown write subcommand "${sub}". Expected create, update, append, replace, trash, or move.`,
  );
}

export async function handleSchemaCommand(ctx: WriteCommandContext): Promise<void> {
  const sub = ctx.positionals[0];
  const alias = ctx.positionals[1];
  const property = ctx.positionals[2];
  const value = ctx.positionals[3];
  if (sub !== "propose-option" || !alias || !property || !value) {
    throw new AxiError(
      "INVALID_ARGUMENT",
      "Usage: wiki schema propose-option <alias> <property> <value>",
    );
  }

  const { token } = await ctx.app.secrets.resolveToken({
    profile: ctx.profileName,
    tokenRef: ctx.tokenRef,
  });
  const gateway = ctx.app.createNotionGateway(token);
  ctx.setActiveGateway(gateway);
  const writeService = ctx.app.createWriteService(gateway);

  const res = await writeService.proposeSchemaOption(
    ctx.profileName,
    alias,
    property,
    value,
  );
  console.log(formatProposalToon(res));
  await logMetric({
    app: ctx.app,
    profile: ctx.profileName,
    command: "schema:propose-option",
    targetAlias: res.proposal.target_alias,
    resolvedVia: "alias",
    outcome: "proposal_created",
    notionCalls: res.apiCalls,
    startedAt: ctx.startedAt,
  });
}

export async function handleApproveCommand(params: {
  app: AppContainer;
  ontology: OntologyConfig;
  proposalId: string;
  envProfile?: string;
  cliProfile?: string;
  startedAt: number;
  setActiveGateway: (gw: NotionGateway) => void;
  setActiveProfile: (profile: string) => void;
}): Promise<void> {
  const { proposal, profileName, scope } = await WriteService.resolveApprovalProfile(
    params.app.store,
    params.app.scopeGuard,
    params.ontology,
    params.proposalId,
    params.envProfile,
    params.cliProfile,
  );
  params.setActiveProfile(profileName);

  const { token } = await params.app.secrets.resolveToken({
    profile: profileName,
    tokenRef: scope.token_ref,
  });
  const gateway = params.app.createNotionGateway(token);
  params.setActiveGateway(gateway);
  const writeService = params.app.createWriteService(gateway);

  const res = await writeService.approveProposal(params.proposalId, profileName, proposal);
  console.log(formatApproveToon(res));
  await logMetric({
    app: params.app,
    profile: profileName,
    command: "approve",
    targetAlias: proposal.target_alias,
    resolvedVia: "none",
    outcome: "ok",
    notionCalls: gateway.getCallCount(),
    startedAt: params.startedAt,
  });
}
