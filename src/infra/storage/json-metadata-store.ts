import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parseDocument, stringify } from "yaml";
import type { MetadataStore } from "../../core/ports.js";
import { AxiError } from "../../shared/errors.js";
import type {
  CacheSnapshot,
  FractalPointers,
  OntologyConfig,
} from "../../shared/types.js";

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 3_000;

export function expandUserPath(rawPath: string): string {
  if (rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  throw new AxiError(
    "CONFIG_INVALID",
    `Path "${rawPath}" must be absolute or start with "~/" (relative paths are forbidden).`,
    ['Example: "~/workspace/AGENTS.md" or "/Users/you/workspace/AGENTS.md"'],
  );
}

export async function ensureSecureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dirPath, 0o700);
  } catch {
    // Ignore chmod failures on non-owned parent mounts.
  }
}

export async function atomicWriteFile(
  targetPath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpName = `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf8", mode });
    await fs.chmod(tmpPath, mode);
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export async function withAdvisoryLock<T>(
  wikiHome: string,
  lockName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locksDir = path.join(wikiHome, "locks");
  await ensureSecureDir(locksDir);
  const lockPath = path.join(locksDir, `${lockName}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  let acquired = false;
  while (!acquired) {
    try {
      const handle = await fs.open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, acquired_at: Date.now() }),
          "utf8",
        );
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Reclaim stale lock older than LOCK_STALE_MS.
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { acquired_at?: number };
        if (
          typeof parsed.acquired_at === "number" &&
          Date.now() - parsed.acquired_at > LOCK_STALE_MS
        ) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // Lock file may have disappeared or been mid-write; retry.
      }

      if (Date.now() >= deadline) {
        throw new AxiError(
          "CONFIG_INVALID",
          `Timed out waiting for advisory lock "${lockName}".`,
          [`Remove stale lock at ${lockPath} if no other wiki process is running.`],
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Recursively synchronize a parsed YAML Document AST with an updated JS object
 * so existing user comments and key ordering stay intact on unchanged nodes.
 */
function applyObjectToYamlDoc(
  doc: ReturnType<typeof parseDocument>,
  updated: Record<string, unknown>,
  prefix: string[] = [],
): void {
  for (const [key, value] of Object.entries(updated)) {
    const keyPath = [...prefix, key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      doc.hasIn(keyPath)
    ) {
      const existing = doc.getIn(keyPath, true);
      if (existing && typeof existing === "object" && "items" in existing) {
        applyObjectToYamlDoc(doc, value as Record<string, unknown>, keyPath);
        continue;
      }
    }
    doc.setIn(keyPath, value);
  }
}

export class JsonMetadataStore implements MetadataStore {
  private readonly wikiHome: string;

  constructor(wikiHome: string) {
    this.wikiHome = expandUserPath(wikiHome);
  }

  getWikiHome(): string {
    return this.wikiHome;
  }

  private ontologyPath(): string {
    return path.join(this.wikiHome, "ontology.yaml");
  }

  private cachePath(): string {
    return path.join(this.wikiHome, "cache.json");
  }

  private fractalPath(): string {
    return path.join(this.wikiHome, "fractal-pointers.json");
  }

  async ontologyExists(): Promise<boolean> {
    return this.fileExists(this.ontologyPath());
  }

  async readOntology(): Promise<OntologyConfig> {
    try {
      const raw = await fs.readFile(this.ontologyPath(), "utf8");
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) {
        throw new AxiError(
          "CONFIG_INVALID",
          `Failed to parse ontology.yaml: ${doc.errors[0]!.message}`,
          [`Check YAML syntax in ${this.ontologyPath()}`],
        );
      }
      const parsed = doc.toJS() as OntologyConfig | null;
      if (!parsed || typeof parsed !== "object" || !parsed.workspace?.root_id) {
        throw new AxiError(
          "CONFIG_INVALID",
          "ontology.yaml is missing required workspace.root_id.",
          ["Run `wiki setup <root-url>` to initialize the workspace."],
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof AxiError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AxiError(
          "NOT_FOUND",
          `Workspace ontology not found at ${this.ontologyPath()}.`,
          ["Run `wiki setup <root-url>` first."],
        );
      }
      throw err;
    }
  }

  async writeOntology(config: OntologyConfig): Promise<void> {
    await ensureSecureDir(this.wikiHome);
    const yamlText = stringify(config, { lineWidth: 100 });
    await atomicWriteFile(this.ontologyPath(), yamlText, 0o600);
  }

  async patchOntology(
    updater: (current: OntologyConfig) => OntologyConfig,
  ): Promise<void> {
    await ensureSecureDir(this.wikiHome);
    const exists = await this.ontologyExists();
    if (!exists) {
      throw new AxiError(
        "NOT_FOUND",
        `Cannot patch missing ontology.yaml at ${this.ontologyPath()}.`,
      );
    }
    const raw = await fs.readFile(this.ontologyPath(), "utf8");
    const doc = parseDocument(raw);
    const current = doc.toJS() as OntologyConfig;
    const next = updater(current);
    applyObjectToYamlDoc(doc, next as unknown as Record<string, unknown>);
    await atomicWriteFile(this.ontologyPath(), doc.toString(), 0o600);
  }

  async readCache(): Promise<CacheSnapshot | null> {
    try {
      const raw = await fs.readFile(this.cachePath(), "utf8");
      return JSON.parse(raw) as CacheSnapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeCache(snapshot: CacheSnapshot): Promise<void> {
    await ensureSecureDir(this.wikiHome);
    await atomicWriteFile(
      this.cachePath(),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      0o600,
    );
  }

  async readGuideSummary(filename: string): Promise<string | null> {
    const filePath = path.join(this.wikiHome, path.basename(filename));
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeGuideSummary(filename: string, content: string): Promise<void> {
    await ensureSecureDir(this.wikiHome);
    const filePath = path.join(this.wikiHome, path.basename(filename));
    await atomicWriteFile(filePath, content, 0o600);
  }

  async readFractalPointers(): Promise<FractalPointers> {
    try {
      const raw = await fs.readFile(this.fractalPath(), "utf8");
      return JSON.parse(raw) as FractalPointers;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { schema_version: 1, by_parent_page_id: {} };
      }
      throw err;
    }
  }

  async writeFractalPointers(pointers: FractalPointers): Promise<void> {
    await ensureSecureDir(this.wikiHome);
    await withAdvisoryLock(this.wikiHome, "fractal-pointers", async () => {
      await atomicWriteFile(
        this.fractalPath(),
        `${JSON.stringify(pointers, null, 2)}\n`,
        0o600,
      );
    });
  }

  async readExternalFile(filePath: string): Promise<string | null> {
    const resolved = expandUserPath(filePath);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        throw new AxiError(
          "CONFIG_INVALID",
          `render_target "${filePath}" points to a directory instead of a regular file.`,
          ["Point render_target to a concrete file such as ~/workspace/AGENTS.md."],
        );
      }
      return await fs.readFile(resolved, "utf8");
    } catch (err) {
      if (err instanceof AxiError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeExternalFile(filePath: string, content: string): Promise<void> {
    const resolved = expandUserPath(filePath);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        throw new AxiError(
          "CONFIG_INVALID",
          `render_target "${filePath}" points to a directory instead of a regular file.`,
          ["Point render_target to a concrete file such as ~/workspace/AGENTS.md."],
        );
      }
    } catch (err) {
      if (err instanceof AxiError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await atomicWriteFile(resolved, content, 0o644);
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
