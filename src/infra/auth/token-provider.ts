import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SecretStore } from "../../core/ports.js";
import { AxiError } from "../../shared/errors.js";
import {
  atomicWriteFile,
  ensureSecureDir,
  expandUserPath,
} from "../fs/posix-fs.js";

const execFileAsync = promisify(execFile);
const VALID_PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function assertValidProfile(profile: string): void {
  if (!VALID_PROFILE_RE.test(profile)) {
    throw new AxiError(
      "INVALID_ARGUMENT",
      `Invalid profile name "${profile}". Expected 1-64 alphanumeric, "_" or "-" characters.`,
    );
  }
}

export class TokenProvider implements SecretStore {
  private readonly wikiHome: string;

  constructor(wikiHome: string) {
    this.wikiHome = expandUserPath(wikiHome);
  }

  private async readMacKeychain(service: string): Promise<string | null> {
    if (process.platform !== "darwin") return null;
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        service,
        "-w",
      ]);
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  async storeTokenFile(profile: string, token: string): Promise<string> {
    assertValidProfile(profile);
    const tokensDir = path.join(this.wikiHome, "tokens");
    await ensureSecureDir(tokensDir);
    const tokenPath = path.join(tokensDir, `${profile}.token`);
    await atomicWriteFile(tokenPath, `${token.trim()}\n`, 0o600);
    return tokenPath;
  }

  async resolveToken(options: {
    profile: string;
    tokenRef?: string;
  }): Promise<{ token: string; source: "keychain" | "token_file" | "env" }> {
    assertValidProfile(options.profile);

    // 1. OS Keychain (macOS Keychain when tokenRef starts with "keychain:")
    if (options.tokenRef?.startsWith("keychain:")) {
      const service = options.tokenRef.slice("keychain:".length);
      const kc = await this.readMacKeychain(service);
      if (kc) return { token: kc, source: "keychain" };
    }

    // 2. 0o600 token file: explicit token_ref path, or profile-scoped file when no token_ref is set.
    // Never fall back to default.token for non-default profiles or profiles with an explicit token_ref.
    const candidateFiles: string[] = [];
    if (options.tokenRef) {
      if (!options.tokenRef.startsWith("keychain:")) {
        candidateFiles.push(expandUserPath(options.tokenRef));
      }
    } else {
      candidateFiles.push(
        path.join(this.wikiHome, "tokens", `${options.profile}.token`),
      );
    }

    for (const filePath of candidateFiles) {
      try {
        const raw = (await fs.readFile(filePath, "utf8")).trim();
        if (raw.length > 0) {
          return { token: raw, source: "token_file" };
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }

    // If an explicit token_ref was declared for this profile (e.g. a read_only integration token),
    // fail closed immediately instead of silently falling back to process.env.NOTION_TOKEN.
    if (options.tokenRef) {
      throw new AxiError(
        "TOKEN_MISSING",
        `Explicit token_ref "${options.tokenRef}" for profile "${options.profile}" could not be resolved (refusing to fall back to NOTION_TOKEN).`,
        [
          `Populate "${options.tokenRef}" or remove token_ref from profile "${options.profile}" in ontology.yaml.`,
        ],
      );
    }

    // 3. Environment variable (headless/cron fallback when no explicit token_ref is configured)
    const envToken = process.env.NOTION_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }

    throw new AxiError(
      "TOKEN_MISSING",
      `No Notion integration token found for profile "${options.profile}".`,
      [
        `Save a 0o600 token file at ${path.join(this.wikiHome, "tokens", `${options.profile}.token`)}, add macOS Keychain entry, or export NOTION_TOKEN.`,
      ],
    );
  }
}
