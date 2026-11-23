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
} from "../storage/json-metadata-store.js";

const execFileAsync = promisify(execFile);

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
    const tokensDir = path.join(this.wikiHome, "tokens");
    await ensureSecureDir(tokensDir);
    const tokenPath = path.join(tokensDir, `${profile}.token`);
    await atomicWriteFile(tokenPath, `${token.trim()}\n`, 0o600);
    return tokenPath;
  }

  async resolveToken(options: {
    profile: string;
    tokenRef?: string;
    envVar?: string;
  }): Promise<{ token: string; source: "keychain" | "token_file" | "env" }> {
    // 1. OS Keychain (macOS Keychain when tokenRef starts with "keychain:")
    if (options.tokenRef?.startsWith("keychain:")) {
      const service = options.tokenRef.slice("keychain:".length);
      const kc = await this.readMacKeychain(service);
      if (kc) return { token: kc, source: "keychain" };
    }

    // 2. 0o600 token file (explicit token_ref path or default $WIKI_HOME/tokens/<profile>.token)
    const candidateFiles: string[] = [];
    if (options.tokenRef && !options.tokenRef.startsWith("keychain:")) {
      candidateFiles.push(expandUserPath(options.tokenRef));
    }
    candidateFiles.push(
      path.join(this.wikiHome, "tokens", `${options.profile}.token`),
    );
    candidateFiles.push(path.join(this.wikiHome, "tokens", "default.token"));

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

    // 3. Environment variable (headless/cron fallback)
    const envName = options.envVar ?? "NOTION_TOKEN";
    const envToken = process.env[envName]?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }

    throw new AxiError(
      "TOKEN_MISSING",
      `No Notion integration token found for profile "${options.profile}".`,
      [
        `Save a 0o600 token file at ${path.join(this.wikiHome, "tokens", `${options.profile}.token`)}, add macOS Keychain entry, or export ${envName}.`,
      ],
    );
  }
}
