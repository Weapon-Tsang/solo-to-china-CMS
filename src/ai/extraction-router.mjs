import { KimiExtractor } from "./kimi.mjs";
import { ContentEngine } from "./content-engine.mjs";

// A routing decision is resolved once per method invocation from the immutable
// profile stored on the Job. Updating dashboard settings only affects Jobs
// enqueued afterwards; an in-flight invocation keeps its own client bundle.
export class ExtractionRouter {
  constructor({ currentProfile, resolveConfig }) {
    this.currentProfile = currentProfile;
    this.resolveConfig = resolveConfig;
  }

  profile(context = {}) {
    const value = context?.telemetryContext?.modelProfile || context?.modelProfile;
    if (value && typeof value === "object" && value.provider) return value;
    return this.currentProfile();
  }

  bundle(context = {}) {
    const profile = this.profile(context);
    const config = this.resolveConfig(profile);
    return { profile, config, extractor: new KimiExtractor(config), content: new ContentEngine(config) };
  }

  get config() { return this.resolveConfig(this.currentProfile()); }
  get enabled() { return this.bundle().extractor.enabled; }
  get batchEnabled() { return this.bundle().extractor.batchEnabled; }
  configFor(options = {}) { return this.bundle(options).config; }
  enabledFor(options = {}) { return this.bundle(options).extractor.enabled; }

  extract(input, options = {}) { return this.bundle(options).extractor.extract(input, options); }
  auditCoverage(input, options = {}) { return this.bundle(options).extractor.auditCoverage(input, options); }
  analyzeBlueprint(input, options = {}) { return this.bundle(options).extractor.analyzeBlueprint(input, options); }
  analyzeMediaAsset(input, options = {}) { return this.bundle(options).extractor.analyzeMediaAsset(input, options); }
  analyzeExperience(input, options = {}) { return this.bundle(options).content.analyzeExperience(input, options); }
  analyzeIntake(input, options = {}) { return this.bundle(options).content.analyzeIntake(input, options); }
  resolveEntities(input, options = {}) { return this.bundle(options).content.resolveEntities(input, options); }
  reviewDispute(input, options = {}) { return this.bundle(options).content.reviewDispute(input, options); }
  testConnection(options = {}) { return this.bundle(options).extractor.testConnection(options); }
  testImageConnection(options = {}) { return this.bundle(options).extractor.testImageConnection(options); }

  batchConfigSnapshot(type) { return this.bundle().extractor.batchConfigSnapshot(type); }
  prepareBatchCoverage(input, id, run) { return this.bundle({ modelProfile: profileFromRun(run) }).extractor.prepareBatchCoverage(input, id, run); }
  prepareBatchExtraction(input, id, run) { return this.bundle({ modelProfile: profileFromRun(run) }).extractor.prepareBatchExtraction(input, id, run); }
  createExtractionBatch(input, options) { return this.bundle({ modelProfile: profileFromRun(options?.runConfig) }).extractor.createExtractionBatch(input, options); }
  getExtractionBatch(name, run) { return this.bundle({ modelProfile: profileFromRun(run) }).extractor.getExtractionBatch(name, run); }
  readExtractionBatch(run) { return this.bundle({ modelProfile: profileFromRun(run) }).extractor.readExtractionBatch(run); }
  parseBatchCoverage(output, options) { return this.bundle({ modelProfile: profileFromRun(options?.runConfig) }).extractor.parseBatchCoverage(output, options); }
  parseBatchExtraction(output, options) { return this.bundle({ modelProfile: profileFromRun(options?.runConfig) }).extractor.parseBatchExtraction(output, options); }
  cleanupExtractionBatch(run) { return this.bundle({ modelProfile: profileFromRun(run) }).extractor.cleanupExtractionBatch(run); }
}

function profileFromRun(run = {}) {
  return { role: "extraction", provider: run.provider || "legacy", model: run.model || "", routingRevision: run.model_routing_revision || null };
}
