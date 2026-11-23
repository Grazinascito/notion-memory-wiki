import fs from "node:fs/promises";
import path from "node:path";
import type { MetricsLogger } from "../../core/ports.js";
import type { MetricEvent } from "../../shared/types.js";
import {
  ensureSecureDir,
  expandUserPath,
} from "../storage/json-metadata-store.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export class JsonlMetricsLogger implements MetricsLogger {
  private readonly wikiHome: string;

  constructor(wikiHome: string) {
    this.wikiHome = expandUserPath(wikiHome);
  }

  private logPath(): string {
    return path.join(this.wikiHome, "metrics.jsonl");
  }

  async append(event: MetricEvent): Promise<void> {
    await ensureSecureDir(this.wikiHome);
    const filePath = this.logPath();
    try {
      const stat = await fs.stat(filePath);
      if (stat.size >= MAX_LOG_BYTES) {
        await fs.rename(filePath, `${filePath}.1`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
