import { sha256 } from './utils.mjs';
import { resolveStagePolicy } from './ai/stage-policy.mjs';

export const PIPELINE_CONTRACT_VERSION = 'pipeline-dependencies-2';
export function semanticMaterial(value) {
  if (Array.isArray(value)) return value.map(semanticMaterial);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !['updated_at','created_at','recovered_at'].includes(key)).map(key => [key, semanticMaterial(value[key])]));
  if (typeof value === 'string' && /^[\[{]/.test(value)) {
    try { return semanticMaterial(JSON.parse(value)); } catch { /* Plain text remains text. */ }
  }
  return value;
}
export const dependencyHash = value => sha256(JSON.stringify(semanticMaterial(value)));
export function stageConfiguration(pipeline, stage) {
  const extraction = ['extract_segment_claims','audit_segment_coverage','retry_segment_extraction','analyze_source_blueprint'].includes(stage);
  const delivery = ['compose_publish_page','push_wordpress_draft'].includes(stage);
  const commercial = stage === 'compose_commercial';
  const engine = extraction ? pipeline.extractor : delivery ? pipeline.wordpress : commercial ? pipeline.commercialComposer : pipeline.contentEngine;
  const contract = engine?.artifactContract?.(stage) || { stage };
  const config = engine?.config || {};
  return dependencyHash({ version: PIPELINE_CONTRACT_VERSION, contract,
    retryCoverage: stage === 'retry_segment_extraction' ? {
      contract: engine?.artifactContract?.('audit_segment_coverage'),
      stagePolicy: resolveStagePolicy('segment_claim_coverage_audit', config),
    } : null,
    provider: config.provider, model: config.model,
    delivery: delivery ? {siteUrl:config.siteUrl,contractAware:Boolean(pipeline.frontendContracts?.configured)} : null,
    commercial: commercial ? Object.fromEntries(['maxOffersPerDraft','maxContextualUnits','maxEndResourceUnits','minBlockDistance','minimumContentBlocks','opportunityThreshold','disclosure'].map(key=>[key,config[key] ?? null])) : null,
    parameters: Object.fromEntries(['temperature','maxCompletionTokens','thinking','imageBatchSize','imageMaxBytes','textSegmentMaxChars']
      .map(key => [key, config[key] ?? null])),
    stagePolicy: resolveStagePolicy(contract.name || stage, config),
    frontend: stage.startsWith('compose_frontend_') || delivery || commercial ? pipeline.frontendContracts?.active?.artifact_checksum || pipeline.frontendContracts?.active?.checksum : null,
  });
}
