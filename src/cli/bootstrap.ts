import os from "node:os";
import path from "node:path";
import type {
  MetadataStore,
  MetricsLogger,
  NotionGateway,
  RateLimiter,
  SecretStore,
} from "../core/ports.js";
import { OntologyEngine } from "../core/ontology/ontology-engine.js";
import { RenderService } from "../core/ontology/render-service.js";
import { ScopeGuard } from "../core/scope/scope-guard.js";
import { SyncService } from "../core/sync/sync-service.js";
import { TokenProvider } from "../infra/auth/token-provider.js";
import { JsonlMetricsLogger } from "../infra/metrics/jsonl-metrics-logger.js";
import { NotionHttpClient } from "../infra/notion/notion-http-client.js";
import { CrossProcessRateLimiter } from "../infra/ratelimit/cross-process-rate-limiter.js";
import { JsonMetadataStore } from "../infra/storage/json-metadata-store.js";

export interface AppContainer {
  wikiHome: string;
  store: MetadataStore;
  rateLimiter: RateLimiter;
  secrets: SecretStore;
  metrics: MetricsLogger;
  scopeGuard: ScopeGuard;
  ontologyEngine: OntologyEngine;
  renderService: RenderService;
  createNotionGateway(token: string): NotionGateway;
  createSyncService(token: string): SyncService;
}

export function resolveWikiHome(): string {
  const envHome = process.env.WIKI_HOME?.trim();
  if (envHome) return envHome;
  return path.join(os.homedir(), ".config", "notion-memory-wiki", "default");
}

export function bootstrapApp(wikiHome = resolveWikiHome()): AppContainer {
  const store = new JsonMetadataStore(wikiHome);
  const rateLimiter = new CrossProcessRateLimiter({ wikiHome });
  const secrets = new TokenProvider(wikiHome);
  const metrics = new JsonlMetricsLogger(wikiHome);
  const scopeGuard = new ScopeGuard();
  const ontologyEngine = new OntologyEngine(scopeGuard);
  const renderService = new RenderService(store, ontologyEngine);

  const createNotionGateway = (token: string): NotionGateway =>
    new NotionHttpClient({
      token,
      rateLimiter,
      trafficClass: "interactive",
    });

  const createSyncService = (token: string): SyncService =>
    new SyncService(
      createNotionGateway(token),
      store,
      scopeGuard,
      ontologyEngine,
      renderService,
    );

  return {
    wikiHome,
    store,
    rateLimiter,
    secrets,
    metrics,
    scopeGuard,
    ontologyEngine,
    renderService,
    createNotionGateway,
    createSyncService,
  };
}
