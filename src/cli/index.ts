#!/usr/bin/env node
import readline from "node:readline/promises";
import { AxiError } from "../shared/errors.js";
import { bootstrapApp } from "./bootstrap.js";
import {
  formatCatalogToon,
  formatQueryToon,
  formatReadToon,
  formatSetupToon,
  formatSyncToon,
} from "./toon.js";

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
    "--limit",
    "--cursor",
    "--offset",
    "--name",
    "--render-target",
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
      "Notion Memory Wiki CLI (Slice 1)",
      "",
      "Commands:",
      "  wiki auth set [--profile <name>]                   Save Notion token into 0o600 token file",
      "  wiki setup <root-url-or-id> [--name <w>] [--render-target <path>] [--scan-only]",
      "  wiki sync [--no-render]                            Refresh cache.json from Notion (Notion wins)",
      "  wiki render [--profile <name>]                     Write bounded Level 0 Push block to render_target",
      "  wiki wakeup [--profile <name>]                     Print Level 0 context to stdout (for hooks/on-demand)",
      "  wiki catalog [--area <id>] [--profile <name>]      List permitted databases (Level 1a)",
      "  wiki query <alias> [--where K=V] [--fields a,b] [--limit 20] [--profile <name>]",
      "  wiki read <page-id-or-url> [--full] [--offset N] [--profile <name>]",
    ].join("\n"),
  );
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  const parsed = parseArgv(process.argv);
  const app = bootstrapApp();

  const envProfile = process.env.WIKI_AGENT_PROFILE;
  const cliProfile = firstFlag(parsed, "--profile");

  if (parsed.command === "help" || parsed.booleans.has("--help")) {
    printHelp();
    return;
  }

  if (parsed.command === "auth") {
    const sub = parsed.positionals[0];
    if (sub !== "set") {
      throw new AxiError("INVALID_ARGUMENT", "Usage: wiki auth set [--profile <name>]");
    }
    const profile = cliProfile ?? envProfile ?? "default";
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const token = (await rl.question(`Notion internal integration token for "${profile}": `)).trim();
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
    const { token } = await app.secrets.resolveToken({ profile: profileName });
    const syncService = app.createSyncService(token);
    const scanOnly = parsed.booleans.has("--scan-only");
    const result = await syncService.setupWorkspace({
      rootUrlOrId: rootArg,
      workspaceName: firstFlag(parsed, "--name"),
      profileName,
      renderTarget: firstFlag(parsed, "--render-target"),
      apply: !scanOnly,
    });
    console.log(formatSetupToon(result, !scanOnly));
    await app.metrics.append({
      ts: new Date().toISOString(),
      profile: profileName,
      command: "setup",
      target_alias: null,
      resolved_via: "none",
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
  const { profileName, scope } = app.scopeGuard.resolveProfile(
    ontology,
    envProfile,
    cliProfile,
  );

  try {
    if (parsed.command === "catalog") {
      const cache = await app.store.readCache();
      const entries = app.ontologyEngine.listCatalog(
        ontology,
        cache,
        profileName,
        firstFlag(parsed, "--area"),
      );
      console.log(formatCatalogToon(entries));
      return;
    }

    if (parsed.command === "wakeup") {
      const cache = await app.store.readCache();
      const guide = ontology.guide.enabled
        ? await app.store.readGuideSummary(ontology.guide.summary_file)
        : null;
      const rendered = app.ontologyEngine.renderLevel0(
        ontology,
        cache,
        guide,
        profileName,
      );
      console.log(rendered.text);
      return;
    }

    if (parsed.command === "render") {
      if (scope.injection_mode !== "render") {
        throw new AxiError(
          "DUPLICATE_INJECTION_MODE",
          `Profile "${profileName}" uses injection_mode="${scope.injection_mode}", not "render".`,
          ['Update injection_mode to "render" in ontology.yaml or use `wiki wakeup`.'],
        );
      }
      if (!scope.render_target) {
        throw new AxiError(
          "CONFIG_INVALID",
          `Profile "${profileName}" has injection_mode="render" but no render_target set.`,
        );
      }
      const cache = await app.store.readCache();
      const guide = ontology.guide.enabled
        ? await app.store.readGuideSummary(ontology.guide.summary_file)
        : null;
      const rendered = app.ontologyEngine.renderLevel0(
        ontology,
        cache,
        guide,
        profileName,
      );
      const existing = await app.store.readExternalFile(scope.render_target);
      const updated = app.ontologyEngine.upsertRenderBlock(
        existing,
        ontology.workspace.name,
        profileName,
        rendered.text,
      );
      await app.store.writeExternalFile(scope.render_target, updated);
      console.log(
        `render ok profile=${profileName} target=${scope.render_target} tokens=${rendered.totalTokens} overflow=${rendered.overflowActive}`,
      );
      for (const w of rendered.warnings) {
        console.log(`  warn: ${w}`);
      }
      return;
    }

    if (parsed.command === "sync") {
      const { token } = await app.secrets.resolveToken({
        profile: profileName,
        tokenRef: scope.token_ref,
        envVar: scope.notion_token_env,
      });
      const syncService = app.createSyncService(token);
      const res = await syncService.syncWorkspace();
      console.log(formatSyncToon(res));

      if (!parsed.booleans.has("--no-render")) {
        const cache = await app.store.readCache();
        const guide = ontology.guide.enabled
          ? await app.store.readGuideSummary(ontology.guide.summary_file)
          : null;
        for (const [pName, pScope] of Object.entries(ontology.agent_scopes)) {
          if (pScope.injection_mode === "render" && pScope.render_target) {
            const rendered = app.ontologyEngine.renderLevel0(
              ontology,
              cache,
              guide,
              pName,
            );
            const existing = await app.store.readExternalFile(pScope.render_target);
            const updated = app.ontologyEngine.upsertRenderBlock(
              existing,
              ontology.workspace.name,
              pName,
              rendered.text,
            );
            await app.store.writeExternalFile(pScope.render_target, updated);
          }
        }
      }

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
          "Usage: wiki query <alias> [--where Prop=Val] [--fields a,b] [--limit 20]",
        );
      }
      const { token } = await app.secrets.resolveToken({
        profile: profileName,
        tokenRef: scope.token_ref,
        envVar: scope.notion_token_env,
      });
      const syncService = app.createSyncService(token);
      const fieldsRaw = firstFlag(parsed, "--fields");
      const limitRaw = firstFlag(parsed, "--limit");
      const res = await syncService.queryDatabase(profileName, target, {
        where: parsed.flags.get("--where") ?? [],
        fields: fieldsRaw
          ? fieldsRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
        cursor: firstFlag(parsed, "--cursor"),
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
        throw new AxiError("INVALID_ARGUMENT", "Usage: wiki read <page-id-or-url> [--full] [--offset N]");
      }
      const { token } = await app.secrets.resolveToken({
        profile: profileName,
        tokenRef: scope.token_ref,
        envVar: scope.notion_token_env,
      });
      const syncService = app.createSyncService(token);
      const offsetRaw = firstFlag(parsed, "--offset");
      const res = await syncService.readPage(profileName, target, {
        full: parsed.booleans.has("--full"),
        offset: offsetRaw ? Number(offsetRaw) : undefined,
      });
      console.log(formatReadToon(res));
      await app.metrics.append({
        ts: new Date().toISOString(),
        profile: profileName,
        command: "read",
        target_alias: null,
        resolved_via: target.includes("notion.so") ? "raw_url" : "alias",
        outcome: "ok",
        error_code: null,
        http_status: 200,
        notion_calls: res.apiCalls,
        duration_ms: Date.now() - startedAt,
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
        profile: profileName,
        command: parsed.command,
        target_alias: parsed.positionals[0] ?? null,
        resolved_via: "none",
        outcome:
          axi?.code === "SCOPE_DENIED" || axi?.code === "SCOPE_LOCKED" || axi?.code === "OUT_OF_ROOT_SCOPE"
            ? "scope_denied"
            : axi?.code === "RATE_LIMITED"
              ? "http_429"
              : axi?.code === "VALIDATION_ERROR"
                ? "validation_error"
                : "error",
        error_code: axi?.code ?? "UNEXPECTED",
        http_status: axi?.httpStatus ?? null,
        notion_calls: 0,
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
