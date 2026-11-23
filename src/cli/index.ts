#!/usr/bin/env node
import readline from "node:readline/promises";
import type { NotionGateway } from "../core/ports.js";
import { AxiError } from "../shared/errors.js";
import { classifyResolution } from "../shared/text.js";
import type { MetricEvent } from "../shared/types.js";
import { bootstrapApp } from "./bootstrap.js";
import {
  formatCatalogToon,
  formatQueryToon,
  formatReadToon,
  formatSetupToon,
  formatSyncToon,
} from "./toon.js";
import {
  handleApproveCommand,
  handleSchemaCommand,
  handleWriteCommand,
} from "./write-commands.js";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string[]>;
  booleans: Set<string>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();

  const VALUE_FLAGS = new Set([
    "--profile",
    "--area",
    "--where",
    "--fields",
    "--follow",
    "--limit",
    "--cursor",
    "--offset",
    "--name",
    "--render-target",
    "--set",
    "--add",
    "--remove",
    "--clear",
    "--md",
    "--to",
  ]);

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(0, eqIdx);
        const val = arg.slice(eqIdx + 1);
        const list = flags.get(key) ?? [];
        list.push(val);
        flags.set(key, list);
      } else if (VALUE_FLAGS.has(arg)) {
        const next = args[i + 1];
        if (!next || next.startsWith("--")) {
          throw new AxiError("INVALID_ARGUMENT", `Flag ${arg} requires a value.`);
        }
        const list = flags.get(arg) ?? [];
        list.push(next);
        flags.set(arg, list);
        i += 1;
      } else {
        booleans.add(arg);
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags, booleans };
}

function firstFlag(parsed: ParsedArgs, name: string): string | undefined {
  return parsed.flags.get(name)?.[0];
}

function printHelp(): void {
  console.log(
    [
      "Notion Memory Wiki CLI (Slices 1 & 2)",
      "",
      "Commands:",
      "  wiki auth set [--profile <name>]                   Save Notion token into 0o600 token file",
      "  wiki setup <root-url-or-id> [--name <w>] [--render-target <path>] [--scan-only] [--allow-pat]",
      "  wiki sync [--no-render]                            Refresh cache.json from Notion (Notion wins)",
      "  wiki render [--profile <name>]                     Write bounded Level 0 Push block to render_target",
      "  wiki wakeup [--profile <name>]                     Print Level 0 context to stdout (for hooks/on-demand)",
      "  wiki catalog [--area <id>] [--profile <name>]      List permitted databases (Level 1a)",
      "  wiki query <alias> [--where K=V] [--fields a,b] [--follow <rel>] [--limit 20] [--profile <name>]",
      "  wiki read <page-id-url-or-alias> [--full] [--offset N] [--profile <name>]",
      "  wiki write create <alias> --set K=V [--md \"...\"] [--profile <name>]",
      "  wiki write update <page-id> [--set K=V] [--add K=V] [--remove K=V] [--clear K] [--profile <name>]",
      "  wiki write append <page-id> --md \"...\" [--profile <name>]",
      "  wiki write replace <page-id> --md \"...\" [--profile <name>]   (halted into proposal)",
      "  wiki write trash <page-id> [--profile <name>]                (halted into proposal)",
      "  wiki write move <page-id> --to <parent-id-or-alias>          (halted into proposal)",
      "  wiki schema propose-option <alias> <property> <value>        (halted into proposal)",
      "  wiki approve <proposal_id>                         Execute pending proposal after SHA-256 verification",
    ].join("\n"),
  );
}

function mapErrorOutcome(axi: AxiError | null): MetricEvent["outcome"] {
  if (!axi) return "error";
  if (
    axi.code === "SCOPE_DENIED" ||
    axi.code === "SCOPE_LOCKED" ||
    axi.code === "OUT_OF_ROOT_SCOPE"
  ) {
    return "scope_denied";
  }
  if (axi.code === "RATE_LIMITED") return "http_429";
  if (axi.code === "VALIDATION_ERROR") return "validation_error";
  return "error";
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  const app = bootstrapApp();
  const parsed = parseArgv(process.argv);

  const envProfile = process.env.WIKI_AGENT_PROFILE;
  const cliProfile = firstFlag(parsed, "--profile");

  if (parsed.command === "help" || parsed.booleans.has("--help")) {
    printHelp();
    return;
  }

  let activeProfile = cliProfile?.trim() || envProfile?.trim() || "unresolved";
  let activeGateway: NotionGateway | null = null;
  let activeResolvedVia: MetricEvent["resolved_via"] = "none";

  try {
    if (parsed.command === "auth") {
      const sub = parsed.positionals[0];
      if (sub !== "set") {
        throw new AxiError("INVALID_ARGUMENT", "Usage: wiki auth set [--profile <name>]");
      }
      const profile = cliProfile ?? envProfile ?? "default";
      activeProfile = profile;
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const token = (
          await rl.question(`Notion internal integration token for "${profile}": `)
        ).trim();
        if (!token) {
          throw new AxiError("INVALID_ARGUMENT", "Token cannot be empty.");
        }
        const savedPath = await app.secrets.storeTokenFile(profile, token);
        console.log(`auth ok profile=${profile} file=${savedPath} mode=0600`);
      } finally {
        rl.close();
      }
      return;
    }

    if (parsed.command === "setup") {
      const rootArg = parsed.positionals[0];
      if (!rootArg) {
        throw new AxiError("INVALID_ARGUMENT", "Usage: wiki setup <root-url-or-id>");
      }
      const profileName = cliProfile ?? envProfile ?? "default";
      activeProfile = profileName;
      activeResolvedVia = classifyResolution(rootArg);
      const { token } = await app.secrets.resolveToken({ profile: profileName });
      const gateway = app.createNotionGateway(token);
      activeGateway = gateway;
      const setupService = app.createSetupService(gateway);
      const scanOnly = parsed.booleans.has("--scan-only");
      const result = await setupService.setupWorkspace({
        rootUrlOrId: rootArg,
        workspaceName: firstFlag(parsed, "--name"),
        profileName,
        renderTarget: firstFlag(parsed, "--render-target"),
        apply: !scanOnly,
        allowPat: parsed.booleans.has("--allow-pat"),
      });
      console.log(formatSetupToon(result, !scanOnly));
      await app.metrics.append({
        ts: new Date().toISOString(),
        profile: profileName,
        command: "setup",
        target_alias: null,
        resolved_via: activeResolvedVia,
        outcome: "ok",
        error_code: null,
        http_status: 200,
        notion_calls: result.apiCalls,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    // All remaining commands require an initialized ontology.yaml.
    const ontology = await app.store.readOntology();

    if (parsed.command === "approve") {
      const proposalId = parsed.positionals[0];
      if (!proposalId) {
        throw new AxiError("INVALID_ARGUMENT", "Usage: wiki approve <proposal_id>");
      }
      if (parsed.booleans.has("--force")) {
        throw new AxiError(
          "INVALID_ARGUMENT",
          "No --force bypass flag exists; approvals always verify live content hash and TTL.",
        );
      }
      await handleApproveCommand({
        app,
        ontology,
        proposalId,
        envProfile,
        cliProfile,
        startedAt,
        setActiveGateway: (gw) => {
          activeGateway = gw;
        },
        setActiveProfile: (p) => {
          activeProfile = p;
        },
      });
      return;
    }

    // All non-approve commands require fail-closed profile resolution.
    const { profileName, scope } = app.scopeGuard.resolveProfile(
      ontology,
      envProfile,
      cliProfile,
    );
    activeProfile = profileName;

    if (parsed.command === "catalog") {
      const areaFilter = firstFlag(parsed, "--area");
      const entries = await app.renderService.listCatalog(profileName, areaFilter);
      console.log(formatCatalogToon(entries));
      await app.metrics.append({
        ts: new Date().toISOString(),
        profile: profileName,
        command: "catalog",
        target_alias: areaFilter ?? null,
        resolved_via: "none",
        outcome: "ok",
        error_code: null,
        http_status: null,
        notion_calls: 0,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (parsed.command === "wakeup") {
      const rendered = await app.renderService.wakeupProfile(profileName);
      console.log(rendered.text);
      await app.metrics.append({
        ts: new Date().toISOString(),
        profile: profileName,
        command: "wakeup",
        target_alias: null,
        resolved_via: "none",
        outcome: "ok",
        error_code: null,
        http_status: null,
        notion_calls: 0,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (parsed.command === "render") {
      const rendered = await app.renderService.renderProfile(profileName);
      console.log(
        `render ok profile=${rendered.profileName} target=${rendered.renderTarget} tokens=${rendered.totalTokens} overflow=${rendered.overflowActive}`,
      );
      for (const w of rendered.warnings) {
        console.log(`  warn: ${w}`);
      }
      await app.metrics.append({
        ts: new Date().toISOString(),
        profile: profileName,
        command: "render",
        target_alias: null,
        resolved_via: "none",
        outcome: "ok",
        error_code: null,
        http_status: null,
        notion_calls: 0,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (parsed.command === "sync") {
      const { token } = await app.secrets.resolveToken({
        profile: profileName,
        tokenRef: scope.token_ref,
      });
      const gateway = app.createNotionGateway(token);
      activeGateway = gateway;
      const syncService = app.createSyncService(gateway);
      const res = await syncService.syncWorkspace({
        noRender: parsed.booleans.has("--no-render"),
      });
      console.log(formatSyncToon(res));
      await app.metrics.append({
        ts: new Date().toISOString(),
        profile: profileName,
        command: "sync",
        target_alias: null,
        resolved_via: "none",
        outcome: "ok",
        error_code: null,
        http_status: 200,
        notion_calls: res.apiCalls,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (parsed.command === "query") {
      const target = parsed.positionals[0];
      if (!target) {
        throw new AxiError(
          "INVALID_ARGUMENT",
          "Usage: wiki query <alias> [--where Prop=Val] [--fields a,b] [--follow <rel>] [--limit 20]",
        );
      }
      const { token } = await app.secrets.resolveToken({
        profile: profileName,
        tokenRef: scope.token_ref,
      });
      const gateway = app.createNotionGateway(token);
      activeGateway = gateway;
      const queryService = app.createQueryService(gateway);
      const fieldsRaw = firstFlag(parsed, "--fields");
      const limitRaw = firstFlag(parsed, "--limit");
      const res = await queryService.queryDatabase(profileName, target, {
        where: parsed.flags.get("--where") ?? [],
        fields: fieldsRaw
          ? fieldsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
        cursor: firstFlag(parsed, "--cursor"),
        follow: firstFlag(parsed, "--follow"),
      });
      console.log(formatQueryToon(res));
      await app.metrics.append({
        ts: new Date().toISOString(),
        profile: profileName,
        command: "query",
        target_alias: res.alias,
        resolved_via: res.resolvedVia,
        outcome: "ok",
        error_code: null,
        http_status: 200,
        notion_calls: res.apiCalls,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (parsed.command === "read") {
      const target = parsed.positionals[0];
      if (!target) {
        throw new AxiError(
          "INVALID_ARGUMENT",
          "Usage: wiki read <page-id-url-or-alias> [--full] [--offset N]",
        );
      }
      activeResolvedVia = classifyResolution(target);
      const { token } = await app.secrets.resolveToken({
        profile: profileName,
        tokenRef: scope.token_ref,
      });
      const gateway = app.createNotionGateway(token);
      activeGateway = gateway;
      const queryService = app.createQueryService(gateway);
      const offsetRaw = firstFlag(parsed, "--offset");
      const res = await queryService.readPage(profileName, target, {
        full: parsed.booleans.has("--full"),
        offset: offsetRaw ? Number(offsetRaw) : undefined,
      });
      console.log(formatReadToon(res));
      await app.metrics.append({
        ts: new Date().toISOString(),
        profile: profileName,
        command: "read",
        target_alias: null,
        resolved_via: res.resolvedVia,
        outcome: "ok",
        error_code: null,
        http_status: 200,
        notion_calls: res.apiCalls,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    if (parsed.command === "write") {
      await handleWriteCommand({
        app,
        ontology,
        profileName,
        tokenRef: scope.token_ref,
        positionals: parsed.positionals,
        flags: parsed.flags,
        booleans: parsed.booleans,
        startedAt,
        setActiveGateway: (gw) => {
          activeGateway = gw;
        },
        setResolvedVia: (via) => {
          activeResolvedVia = via;
        },
      });
      return;
    }

    if (parsed.command === "schema") {
      await handleSchemaCommand({
        app,
        ontology,
        profileName,
        tokenRef: scope.token_ref,
        positionals: parsed.positionals,
        flags: parsed.flags,
        booleans: parsed.booleans,
        startedAt,
        setActiveGateway: (gw) => {
          activeGateway = gw;
        },
        setResolvedVia: (via) => {
          activeResolvedVia = via;
        },
      });
      return;
    }

    throw new AxiError(
      "INVALID_ARGUMENT",
      `Unknown command "${parsed.command}".`,
      ["Run `wiki help` to list available commands."],
    );
  } catch (err) {
    const axi = err instanceof AxiError ? err : null;
    await app.metrics
      .append({
        ts: new Date().toISOString(),
        profile: activeProfile,
        command: parsed.command,
        target_alias: parsed.positionals[0] ?? null,
        resolved_via: activeResolvedVia,
        outcome: mapErrorOutcome(axi),
        error_code: axi?.code ?? "UNEXPECTED",
        http_status: axi?.httpStatus ?? null,
        notion_calls: activeGateway?.getCallCount() ?? 0,
        duration_ms: Date.now() - startedAt,
      })
      .catch(() => undefined);
    throw err;
  }
}

run().catch((err: unknown) => {
  if (err instanceof AxiError) {
    console.error(err.toCompactString());
  } else {
    console.error(`ERROR [UNEXPECTED]: ${(err as Error).message}`);
  }
  process.exit(1);
});
