import fs from "node:fs/promises";
import path from "node:path";
import type { RateLimiter } from "../../core/ports.js";
import type { RateLimitState } from "../../shared/types.js";
import {
  atomicWriteFile,
  ensureSecureDir,
  expandUserPath,
  withAdvisoryLock,
} from "../fs/posix-fs.js";

export interface RateLimiterOptions {
  wikiHome: string;
  interactiveRatePerSec?: number;
  maintenanceRatePerSec?: number;
  burst?: number;
  maxInFlightInteractive?: number;
  maxInFlightMaintenance?: number;
  activeChatYieldMs?: number;
}

const DEFAULT_INTERACTIVE_RATE = 2.5;
const QUERY_ENDPOINT_MAX_RATE = 3.0;
const DEFAULT_MAINTENANCE_RATE = 1.0;
const DEFAULT_BURST = 3;
const DEFAULT_MAX_IN_FLIGHT_INTERACTIVE = 3;
const DEFAULT_MAX_IN_FLIGHT_MAINTENANCE = 1;
const DEFAULT_ACTIVE_CHAT_YIELD_MS = 60_000;

function emptyState(now: number): RateLimitState {
  return {
    updated_at: now,
    retry_after_until: 0,
    last_reason: null,
    last_active_chat_at: 0,
    global: {
      tokens: DEFAULT_BURST,
      last_refill_ms: now,
    },
    endpoints: {},
  };
}

export class CrossProcessRateLimiter implements RateLimiter {
  private readonly wikiHome: string;
  private readonly interactiveRate: number;
  private readonly maintenanceRate: number;
  private readonly burst: number;
  private readonly maxInFlightInteractive: number;
  private readonly maxInFlightMaintenance: number;
  private readonly activeChatYieldMs: number;

  private inFlightInteractive = 0;
  private inFlightMaintenance = 0;
  private readonly inFlightWaiters: Array<() => void> = [];

  constructor(options: RateLimiterOptions) {
    this.wikiHome = expandUserPath(options.wikiHome);
    this.interactiveRate = options.interactiveRatePerSec ?? DEFAULT_INTERACTIVE_RATE;
    this.maintenanceRate = options.maintenanceRatePerSec ?? DEFAULT_MAINTENANCE_RATE;
    this.burst = options.burst ?? DEFAULT_BURST;
    this.maxInFlightInteractive =
      options.maxInFlightInteractive ?? DEFAULT_MAX_IN_FLIGHT_INTERACTIVE;
    this.maxInFlightMaintenance =
      options.maxInFlightMaintenance ?? DEFAULT_MAX_IN_FLIGHT_MAINTENANCE;
    this.activeChatYieldMs =
      options.activeChatYieldMs ?? DEFAULT_ACTIVE_CHAT_YIELD_MS;
  }

  private statePath(): string {
    return path.join(this.wikiHome, "rate-limit-state.json");
  }

  private async acquireInFlightSlot(
    trafficClass: "interactive" | "maintenance",
  ): Promise<void> {
    for (;;) {
      if (
        trafficClass === "interactive" &&
        this.inFlightInteractive < this.maxInFlightInteractive
      ) {
        this.inFlightInteractive += 1;
        return;
      }
      if (
        trafficClass === "maintenance" &&
        this.inFlightMaintenance < this.maxInFlightMaintenance
      ) {
        this.inFlightMaintenance += 1;
        return;
      }
      await new Promise<void>((resolve) => {
        this.inFlightWaiters.push(resolve);
      });
    }
  }

  release(trafficClass: "interactive" | "maintenance"): void {
    if (trafficClass === "interactive") {
      this.inFlightInteractive = Math.max(0, this.inFlightInteractive - 1);
    } else {
      this.inFlightMaintenance = Math.max(0, this.inFlightMaintenance - 1);
    }
    const waiters = this.inFlightWaiters.splice(0, this.inFlightWaiters.length);
    for (const wake of waiters) {
      wake();
    }
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
    await this.acquireInFlightSlot(trafficClass);
    try {
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

            const globalRate =
              trafficClass === "maintenance"
                ? this.maintenanceRate
                : this.interactiveRate;
            const globalCapacity = trafficClass === "maintenance" ? 1 : this.burst;

            const globalBucket = state.global ?? {
              tokens: globalCapacity,
              last_refill_ms: now,
            };
            const globalElapsedSec = Math.max(0, (now - globalBucket.last_refill_ms) / 1000);
            const globalRefilled = Math.min(
              globalCapacity,
              globalBucket.tokens + globalElapsedSec * globalRate,
            );

            if (globalRefilled < 1) {
              const neededSec = (1 - globalRefilled) / globalRate;
              return Math.max(25, Math.ceil(neededSec * 1000));
            }

            // Enforce standalone <= 3.0 req/s cap on query-data-source even on Business/Enterprise.
            const endpointRate =
              endpointKey === "query-data-source"
                ? Math.min(globalRate, QUERY_ENDPOINT_MAX_RATE)
                : globalRate;
            const endpointCapacity =
              endpointKey === "query-data-source"
                ? Math.min(globalCapacity, QUERY_ENDPOINT_MAX_RATE)
                : globalCapacity;

            const endpointBucket = state.endpoints[endpointKey] ?? {
              tokens: endpointCapacity,
              last_refill_ms: now,
              retry_after_until: 0,
            };
            const epElapsedSec = Math.max(0, (now - endpointBucket.last_refill_ms) / 1000);
            const epRefilled = Math.min(
              endpointCapacity,
              endpointBucket.tokens + epElapsedSec * endpointRate,
            );

            if (endpointKey === "query-data-source" && epRefilled < 1) {
              const neededSec = (1 - epRefilled) / endpointRate;
              return Math.max(25, Math.ceil(neededSec * 1000));
            }

            state.global = {
              tokens: globalRefilled - 1,
              last_refill_ms: now,
            };
            state.endpoints[endpointKey] = {
              tokens: Math.max(0, epRefilled - 1),
              last_refill_ms: now,
              retry_after_until: endpointBucket.retry_after_until,
            };
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
    } catch (err) {
      this.release(trafficClass);
      throw err;
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
        if (state.global) {
          state.global.tokens = 0;
        }
      }

      await this.writeStateUnlocked(state);
    });
  }
}
