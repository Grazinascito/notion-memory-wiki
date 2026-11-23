import { AxiError } from "../../shared/errors.js";
import type { CacheSnapshot, OntologyConfig } from "../../shared/types.js";
import type { MetadataStore } from "../ports.js";
import type { CatalogEntry, OntologyEngine, RenderedLevel0 } from "./ontology-engine.js";

export interface RenderProfileResult {
  profileName: string;
  renderTarget: string;
  totalTokens: number;
  overflowActive: boolean;
  warnings: string[];
}

export class RenderService {
  constructor(
    private readonly store: MetadataStore,
    private readonly ontologyEngine: OntologyEngine,
  ) {}

  private async renderSingleProfile(
    ontology: OntologyConfig,
    cache: CacheSnapshot | null,
    guide: string | null,
    profileName: string,
  ): Promise<RenderProfileResult> {
    const scope = ontology.agent_scopes[profileName];
    if (!scope) {
      throw new AxiError("SCOPE_DENIED", `Unknown agent profile "${profileName}".`);
    }
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

    const rendered = this.ontologyEngine.renderLevel0(
      ontology,
      cache,
      guide,
      profileName,
    );
    const existing = await this.store.readExternalFile(scope.render_target);
    const updated = this.ontologyEngine.upsertRenderBlock(
      existing,
      ontology.workspace.name,
      profileName,
      rendered.text,
    );
    await this.store.writeExternalFile(scope.render_target, updated);

    return {
      profileName,
      renderTarget: scope.render_target,
      totalTokens: rendered.totalTokens,
      overflowActive: rendered.overflowActive,
      warnings: rendered.warnings,
    };
  }

  async renderProfile(profileName: string): Promise<RenderProfileResult> {
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();
    const guide = ontology.guide.enabled
      ? await this.store.readGuideSummary(ontology.guide.summary_file)
      : null;
    return this.renderSingleProfile(ontology, cache, guide, profileName);
  }

  async renderAllRenderProfiles(): Promise<RenderProfileResult[]> {
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();
    const guide = ontology.guide.enabled
      ? await this.store.readGuideSummary(ontology.guide.summary_file)
      : null;

    const results: RenderProfileResult[] = [];
    for (const [profileName, scope] of Object.entries(ontology.agent_scopes)) {
      if (scope.injection_mode === "render" && scope.render_target) {
        results.push(
          await this.renderSingleProfile(ontology, cache, guide, profileName),
        );
      }
    }
    return results;
  }

  async wakeupProfile(profileName: string): Promise<RenderedLevel0> {
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();
    const guide = ontology.guide.enabled
      ? await this.store.readGuideSummary(ontology.guide.summary_file)
      : null;
    return this.ontologyEngine.renderLevel0(ontology, cache, guide, profileName);
  }

  async listCatalog(
    profileName: string,
    areaFilter?: string,
  ): Promise<CatalogEntry[]> {
    const ontology = await this.store.readOntology();
    const cache = await this.store.readCache();
    return this.ontologyEngine.listCatalog(ontology, cache, profileName, areaFilter);
  }
}
