import fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AxiError } from "../../shared/errors.js";

const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 6_500;

/**
 * Expand "~/" paths or validate absolute paths, rejecting relative paths.
 */
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

/**
 * Create directory with 0o700 POSIX permissions.
 */
export async function ensureSecureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dirPath, 0o700);
  } catch {
    // Ignore chmod failures on non-owned parent mounts.
  }
}

/**
 * Write content atomically via temp file in target directory and POSIX rename.
 */
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

/**
 * Execute callback under a short-lived POSIX O_EXCL advisory lockfile.
 * Reclaims stale locks (> 5s) using JSON acquired_at or stat.mtimeMs fallback,
 * verifying inode & mtime before unlinking to prevent TOCTOU races.
 */
export async function withAdvisoryLock<T>(
  wikiHome: string,
  lockName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locksDir = path.join(wikiHome, "locks");
  await ensureSecureDir(locksDir);
  const lockPath = path.join(locksDir, `${lockName}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  let myIno: number | null = null;
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
        const stat = await handle.stat();
        myIno = stat.ino;
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Reclaim stale lock older than LOCK_STALE_MS, including 0-byte or corrupted locks.
      try {
        const fh = await fs.open(lockPath, fsConstants.O_RDONLY);
        let fstat: Stats;
        let raw: string;
        try {
          fstat = await fh.stat();
          raw = await fh.readFile("utf8");
        } finally {
          await fh.close();
        }

        let acquiredAt = fstat.mtimeMs;
        if (raw.trim().length > 0) {
          try {
            const parsed = JSON.parse(raw) as { acquired_at?: unknown };
            if (typeof parsed.acquired_at === "number") {
              acquiredAt = parsed.acquired_at;
            }
          } catch {
            // Corrupted lockfile falls back to fstat.mtimeMs.
          }
        }

        if (Date.now() - acquiredAt > LOCK_STALE_MS) {
          const current = await fs.stat(lockPath);
          if (current.ino === fstat.ino && current.mtimeMs === fstat.mtimeMs) {
            await fs.unlink(lockPath).catch(() => undefined);
            continue;
          }
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
    try {
      const current = await fs.stat(lockPath);
      if (myIno === null || current.ino === myIno) {
        await fs.unlink(lockPath).catch(() => undefined);
      }
    } catch {
      // Lock already removed.
    }
  }
}
