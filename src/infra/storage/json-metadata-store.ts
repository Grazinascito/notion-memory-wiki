import fs from "node:fs/promises";
import path from "node:path";
import {
  type Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import type { MetadataStore } from "../../core/ports.js";
import { AxiError } from "../../shared/errors.js";
import type {
  CacheSnapshot,
  FractalPointers,
  OntologyConfig,
  ProposalRecord,
} from "../../shared/types.js";

const VALID_PROPOSAL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
import {
  atomicWriteFile,
  ensureSecureDir,
  expandUserPath,
  withAdvisoryLock,
} from "../fs/posix-fs.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function syncYamlSeq(doc: Document, seqNode: YAMLSeq, updated: unknown[]): void {
  // Preserve unchanged sequence nodes and their inline item comments verbatim.
  if (
    seqNode.items.length === updated.length &&
    JSON.stringify(seqNode.toJSON()) === JSON.stringify(updated)
  ) {
    return;
  }

  for (let i = 0; i < updated.length; i += 1) {
    const nextItem = updated[i];
    if (i < seqNode.items.length) {
      const existingItem = seqNode.items[i];
      if (isMap(existingItem) && isPlainRecord(nextItem)) {
        syncYamlMap(doc, existingItem, nextItem);
      } else if (isSeq(existingItem) && Array.isArray(nextItem)) {
        syncYamlSeq(doc, existingItem, nextItem);
      } else if (
        isScalar(existingItem) &&
        (nextItem === null || typeof nextItem !== "object")
      ) {
        if (existingItem.value !== nextItem) {
          existingItem.value = nextItem;
        }
      } else {
        const existingJs = isNode(existingItem) ? existingItem.toJSON() : existingItem;
        if (JSON.stringify(existingJs) !== JSON.stringify(nextItem)) {
          seqNode.items[i] = doc.createNode(nextItem);
        }
      }
    } else {
      seqNode.add(doc.createNode(nextItem));
    }
  }

  if (seqNode.items.length > updated.length) {
    seqNode.items.length = updated.length;
  }
}

function syncYamlMap(
  doc: Document,
  mapNode: YAMLMap,
  updated: Record<string, unknown>,
): void {
  for (const pair of [...mapNode.items]) {
    const keyName = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    if (
      !Object.prototype.hasOwnProperty.call(updated, keyName) ||
      updated[keyName] === undefined
    ) {
      mapNode.delete(pair.key);
    }
  }

  for (const [key, value] of Object.entries(updated)) {
    if (value === undefined) continue;
    const existingNode = mapNode.get(key, true);
    if (isPlainRecord(value)) {
      if (isMap(existingNode)) {
        syncYamlMap(doc, existingNode, value);
      } else {
        mapNode.set(key, doc.createNode(value));
      }
    } else if (Array.isArray(value)) {
      if (isSeq(existingNode)) {
        syncYamlSeq(doc, existingNode, value);
      } else {
        mapNode.set(key, doc.createNode(value));
      }
    } else if (isScalar(existingNode)) {
      if (existingNode.value !== value) {
        existingNode.value = value;
      }
    } else {
      mapNode.set(key, doc.createNode(value));
    }
  }
}

/**
 * Recursively synchronize a parsed YAML Document AST with an updated JS object
 * so existing user comments, array item comments, and key ordering stay intact.
 */
function applyObjectToYamlDoc(
  doc: Document,
  updated: Record<string, unknown>,
): void {
  if (isMap(doc.contents)) {
    syncYamlMap(doc, doc.contents, updated);
  } else {
    doc.contents = doc.createNode(updated);
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

  private proposalPath(proposalId: string): string {
    if (!VALID_PROPOSAL_ID_RE.test(proposalId)) {
      throw new AxiError(
        "INVALID_ARGUMENT",
        `Invalid proposal_id "${proposalId}". Expected 1-64 alphanumeric, "_" or "-" characters.`,
      );
    }
    return path.join(this.wikiHome, "proposals", `${proposalId}.json`);
  }

  async writeProposal(proposal: ProposalRecord): Promise<void> {
    const proposalsDir = path.join(this.wikiHome, "proposals");
    await ensureSecureDir(proposalsDir);
    const targetPath = this.proposalPath(proposal.proposal_id);
    await atomicWriteFile(
      targetPath,
      `${JSON.stringify(proposal, null, 2)}\n`,
      0o600,
    );
  }

  async readProposal(proposalId: string): Promise<ProposalRecord> {
    const targetPath = this.proposalPath(proposalId);
    try {
      const raw = await fs.readFile(targetPath, "utf8");
      return JSON.parse(raw) as ProposalRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AxiError(
          "NOT_FOUND",
          `Proposal "${proposalId}" not found in ${path.join(this.wikiHome, "proposals")}.`,
        );
      }
      throw err;
    }
  }

  async listProposals(): Promise<ProposalRecord[]> {
    const proposalsDir = path.join(this.wikiHome, "proposals");
    try {
      const entries = await fs.readdir(proposalsDir);
      const records: ProposalRecord[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(proposalsDir, entry), "utf8");
        records.push(JSON.parse(raw) as ProposalRecord);
      }
      return records.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}
