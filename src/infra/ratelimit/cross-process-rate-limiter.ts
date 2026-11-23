import fs from "node:fs/promises";
import path from "node:path";
import type { RateLimiter } from "../../core/ports.js";
import type { RateLimitState } from "../../shared/types.js";
import {
  atomicWriteFile,
  ensureSecureDir,
  expandUserPath,
  withAdvisoryLock,
} from "../storage/json-metadata-store.js";

export interface RateLimiterOptions {
  wikiHome: string;
  interactiveRatePerSec?: number;
  maintenanceRatePerSec?: number;
  burst?: number;
  activeChatYieldMs?: number;
}

const DEFAULT_INTERACTIVE_RATE = 2.5;
const QUERY_ENDPOINT_MAX_RATE = 3.0;
const DEFAULT_MAINTENANCE_RATE = 1.0;
const DEFAULT_BURST = 3;
const DEFAULT_ACTIVE_CHAT_YIELD_MS = 60_000;

function emptyState(now: number): RateLimitState {
  return {
    updated_at: now,
    retry_after_until: 0,
    last_reason: null,
    last_active_chat_at: 0,
    endpoints: {},
  };
}

export class CrossProcessRateLimiter implements RateLimiter {
  private readonly wikiHome: string;
  private readonly interactiveRate: number;
  private readonly maintenanceRate: number;
  private readonly burst: number;
  private readonly activeChatYieldMs: number;

  constructor(options: RateLimiterOptions) {
    this.wikiHome = expandUserPath(options.wikiHome);
    this.interactiveRate = options.interactiveRatePerSec ?? DEFAULT_INTERACTIVE_RATE;
    this.maintenanceRate = options.maintenanceRatePerSec ?? DEFAULT_MAINTENANCE_RATE;
    this.burst = options.burst ?? DEFAULT_BURST;
    this.activeChatYieldMs =
      options.activeChatYieldMs ?? DEFAULT_ACTIVE_CHAT_YIELD_MS;
  }

  private statePath(): string {
    return path.join(this.wikiHome, "rate-limit-state.json");
  }

  async readState(): Promise<RateLimitState> {
    try {
      const raw = await fs.readFile(this.statePath(), "utf8");
      return JSON.parse(raw) as RateLimitState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyState(Date.now());
      }
      throw err;
    }
  }

  private async writeStateUnlocked(state: RateLimitState): Promise<void> {
    await ensureSecureDir(this.wikiHome);
    await atomicWriteFile(
      this.statePath(),
      `${JSON.stringify(state, null, 2)}\n`,
      0o600,
    );
  }

  async acquire(
    endpointKey: string,
    trafficClass: "interactive" | "maintenance",
  ): Promise<void> {
    for (;;) {
      const sleepMs = await withAdvisoryLock(
        this.wikiHome,
        "rate-limit-state",
        async () => {
          const now = Date.now();
          const state = await this.readState();

          const endpointCooldown = state.endpoints[endpointKey]?.retry_after_until ?? 0;
          const blockedUntil = Math.max(state.retry_after_until, endpointCooldown);
          if (blockedUntil > now) {
            return blockedUntil - now;
          }

          if (
            trafficClass === "maintenance" &&
            state.last_active_chat_at > 0 &&
            now - state.last_active_chat_at < this.activeChatYieldMs
          ) {
            return this.activeChatYieldMs - (now - state.last_active_chat_at);
          }

          let rate =
            trafficClass === "maintenance"
              ? this.maintenanceRate
              : this.interactiveRate;
          if (endpointKey === "query-data-source") {
            rate = Math.min(rate, QUERY_ENDPOINT_MAX_RATE);
          }
          const capacity = trafficClass === "maintenance" ? 1 : this.burst;

          const bucket = state.endpoints[endpointKey] ?? {
            tokens: capacity,
            last_refill_ms: now,
            retry_after_until: 0,
          };

          const elapsedSec = Math.max(0, (now - bucket.last_refill_ms) / 1000);
          const refilled = Math.min(capacity, bucket.tokens + elapsedSec * rate);

          if (refilled < 1) {
            const neededSec = (1 - refilled) / rate;
            return Math.max(25, Math.ceil(neededSec * 1000));
          }

          bucket.tokens = refilled - 1;
          bucket.last_refill_ms = now;
          state.endpoints[endpointKey] = bucket;
          state.updated_at = now;
          if (trafficClass === "interactive") {
            state.last_active_chat_at = now;
          }
          await this.writeStateUnlocked(state);
          return 0;
        },
      );

      if (sleepMs <= 0) return;
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  async recordRateLimit(
    endpointKey: string,
    waitMs: number,
    reason: string | null,
  ): Promise<void> {
    await withAdvisoryLock(this.wikiHome, "rate-limit-state", async () => {
      const now = Date.now();
      const targetUntil = now + Math.max(1_000, waitMs);
      const state = await this.readState();
      state.updated_at = now;
      state.last_reason = reason;

      if (reason === "public_api_endpoint_rate_limit") {
        const bucket = state.endpoints[endpointKey] ?? {
          tokens: 0,
          last_refill_ms: now,
          retry_after_until: 0,
        };
        bucket.retry_after_until = Math.max(bucket.retry_after_until, targetUntil);
        bucket.tokens = 0;
        state.endpoints[endpointKey] = bucket;
      } else {
        // Space-wide or integration-wide limit broadcasts globally to sibling CLI processes.
        state.retry_after_until = Math.max(state.retry_after_until, targetUntil);
      }

      await this.writeStateUnlocked(state);
    });
  }
}
