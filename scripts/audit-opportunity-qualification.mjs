import { DatabaseSync } from "node:sqlite";
import { CONTENT_STRATEGY } from "../src/content-strategy.mjs";

const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
const databasePath = positional[0] || process.env.DATABASE_PATH;
const currentStrategy = positional[1] || process.env.CONTENT_STRATEGY_VERSION || CONTENT_STRATEGY.version;
const enforce = process.argv.includes("--enforce");
if (!databasePath) throw new Error("Database path is required");

const db = new DatabaseSync(databasePath, { readOnly: true });
db.exec("PRAGMA query_only=ON");
const rows = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
const parse = (value, fallback) => {
  try { return JSON.parse(value ?? ""); } catch { return fallback; }
};
const uniq = (values) => [...new Set(values.filter(Boolean))];
const groupCount = (items, key) => Object.fromEntries([...Map.groupBy(items, key)]
  .map(([name, values]) => [String(name), values.length]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const normalizeTitle = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
const contentTypes = new Set(["city_guide","itinerary","attraction_guide","food_guide","transport_guide","neighborhood_guide",
  "hotel_area_guide","shopping_guide","practical_guide","first_time_guide","comparison","listicle","how_to"]);
const publicationModes = new Set(["source_adaptation", "topic_feature", "multi_source_synthesis"]);
const primaryDestinationScopes = new Set(["beijing","shanghai","xian","chengdu","chongqing","hangzhou","suzhou","guilin",
  "guangzhou","shenzhen","yunnan","zhangjiajie"]);
const primaryDestinationScope = (value) => {
  const destination=String(value || "unknown").trim().toLowerCase();
  return [...primaryDestinationScopes].find((scope)=>destination===scope || destination.startsWith(`${scope}-`)) || destination;
};
const normalizeMode = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return ["source_adaptation", "topic_feature", "multi_source_synthesis"].includes(normalized)
    ? normalized : "multi_source_synthesis";
};
const normalizeType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return new Set(["city_guide","itinerary","attraction_guide","food_guide","transport_guide","neighborhood_guide",
    "hotel_area_guide","shopping_guide","practical_guide","first_time_guide","comparison","listicle","how_to"]).has(normalized)
    ? normalized : "practical_guide";
};
const modeFromAnalysis = (value, classification = "UNSURE") => {
  const supplied = String(value || "").trim().toUpperCase();
  return ["SOURCE_ADAPTATION","TOPIC_FEATURE","MULTI_SOURCE_SYNTHESIS"].includes(supplied)
    ? supplied.toLowerCase() : classification === "ARTICLE_CANDIDATE" ? "topic_feature" : "multi_source_synthesis";
};
const signature = (title, contentType, mode) => `${normalizeTitle(title)}|${normalizeType(contentType)}|${normalizeMode(mode)}`;
const safeSample = (items, limit = 20) => items.slice(0, limit).map((item) => ({
  id: item.id, title: item.title, destination: item.destination_slug, sourceId: item.source_id || null,
  strategy: item.strategy_version, inbox: item.inbox_state, processing: item.processing_state,
  readiness: Number(item.readiness_score || 0), topicKey: item.topic_key,
}));

const sourceRows = rows(`SELECT s.id,s.status,s.capture_version,s.completeness_status,s.content_hash,
  (SELECT COUNT(*) FROM current_source_assets a WHERE a.source_id=s.id) AS media_count,
  (SELECT COUNT(*) FROM current_source_assets a WHERE a.source_id=s.id AND a.durability_status='ORIGINAL_STORED') AS original_count,
  (SELECT er.status FROM experience_extraction_runs er WHERE er.source_id=s.id
    ORDER BY CASE er.status WHEN 'succeeded' THEN 0 ELSE 1 END,er.updated_at DESC,er.created_at DESC LIMIT 1) AS experience_status,
  (SELECT er.capture_version FROM experience_extraction_runs er WHERE er.source_id=s.id
    ORDER BY CASE er.status WHEN 'succeeded' THEN 0 ELSE 1 END,er.updated_at DESC,er.created_at DESC LIMIT 1) AS experience_capture_version,
  (SELECT er.degraded FROM experience_extraction_runs er WHERE er.source_id=s.id
    ORDER BY CASE er.status WHEN 'succeeded' THEN 0 ELSE 1 END,er.updated_at DESC,er.created_at DESC LIMIT 1) AS experience_degraded,
  a.strategy_version AS analysis_strategy,a.classification,a.analysis_json,
  r.id AS recommendation_id,r.strategy_version AS recommendation_strategy,r.recommended_action,r.decision
  FROM sources s
  LEFT JOIN content_intake_analyses a ON a.source_id=s.id
  LEFT JOIN content_recommendations r ON r.analysis_id=a.id`);
const sourceMap = new Map(sourceRows.map((source) => [source.id, source]));
const baseCurrent = (source) => Boolean(source && source.completeness_status === "complete"
  && ["processed", "needs_ai"].includes(source.status)
  && Number(source.media_count || 0) === Number(source.original_count || 0)
  && source.experience_status === "succeeded"
  && Number(source.experience_capture_version || 0) === Number(source.capture_version || 0)
  && !Boolean(source.experience_degraded));
const fullyCurrent = (source) => baseCurrent(source) && source.analysis_strategy === currentStrategy;

const opportunities = rows(`SELECT o.*,r.strategy_version AS recommendation_strategy,r.classification,r.recommended_action,
  a.strategy_version AS analysis_strategy,a.analysis_json
  FROM content_opportunities o
  LEFT JOIN content_recommendations r ON r.id=o.recommendation_id
  LEFT JOIN content_intake_analyses a ON a.id=r.analysis_id`);
for (const opportunity of opportunities) {
  opportunity.readiness = parse(opportunity.readiness_json, {});
  opportunity.coverage = parse(opportunity.coverage_json, {});
  opportunity.sourceIds = uniq([opportunity.source_id, ...parse(opportunity.source_ids_json, []), ...(opportunity.coverage.selectedSourceIds || [])]);
}
const actionable = opportunities.filter((item) => item.inbox_state === "ACTIONABLE");
const activeLifecycle = opportunities.filter((item) => ["recommended", "recommended_again", "deferred"].includes(item.lifecycle_state));

const actionableViolations = {
  oldOpportunityStrategy: actionable.filter((o) => o.strategy_version !== currentStrategy),
  oldRecommendationStrategy: actionable.filter((o) => o.recommendation_id && o.recommendation_strategy !== currentStrategy),
  wrongLifecycle: actionable.filter((o) => !["recommended", "recommended_again", "deferred"].includes(o.lifecycle_state)),
  processingGap: actionable.filter((o) => o.processing_state === "PROCESSING_GAP"),
  forbiddenStatus: actionable.filter((o) => ["knowledge_only","cluster","research_required","ignored","suppressed"].includes(o.status)),
  seoSkip: actionable.filter((o) => o.seo_action === "SKIP"),
  mergedPrimarySet: actionable.filter((o) => Boolean(o.primary_opportunity_id)),
  missingCanonicalKey: actionable.filter((o) => !String(o.canonical_intent_key || "").trim()),
  recommendationNotArticleCandidate: actionable.filter((o) => o.recommendation_id
    && !(o.classification === "ARTICLE_CANDIDATE" && o.recommended_action === "CREATE_CONTENT_PLAN")),
  unfinishedEvidenceSource: actionable.filter((o) => o.sourceIds.some((id) => !baseCurrent(sourceMap.get(id)))),
  staleDiagnostic: actionable.filter((o) => o.recommendation_id && !fullyCurrent(sourceMap.get(o.source_id))),
  readinessColumnMismatch: actionable.filter((o) => Number(o.readiness_score) !== Number(o.readiness.score)),
  badReadinessRange: actionable.filter((o) => !Number.isFinite(Number(o.readiness_score)) || Number(o.readiness_score) < 0 || Number(o.readiness_score) > 100),
  currentStateButNotReady: actionable.filter((o) => o.processing_state === "CURRENT" && o.readiness.ready !== true),
  evidenceGapButReady: actionable.filter((o) => o.processing_state === "EVIDENCE_GAP" && o.readiness.ready === true),
  invalidContentType: actionable.filter((o) => !contentTypes.has(String(o.content_type || "").trim().toLowerCase())),
  invalidPublicationMode: actionable.filter((o) => !publicationModes.has(String(o.coverage.publicationMode || "").trim().toLowerCase())),
  missingTitle: actionable.filter((o) => !String(o.title || "").trim()),
  missingReaderPromise: actionable.filter((o) => !String(o.coverage.proposal?.readerPromise || "").trim()),
};

const exactGroups = [...Map.groupBy(actionable, (o) => `${o.destination_slug}|${normalizeTitle(o.title)}|${normalizeType(o.content_type)}|${normalizeMode(o.coverage.publicationMode)}`)]
  .filter(([, values]) => values.length > 1);
const canonicalGroups = [...Map.groupBy(actionable, (o) => o.canonical_intent_key || "")]
  .filter(([key, values]) => key && values.length > 1);
const topicKeyGroups = [...Map.groupBy(opportunities, (o) => o.topic_key)].filter(([, values]) => values.length > 1);
const sourceSignatureGroups = [...Map.groupBy(actionable.filter((o) => o.source_id),
  (o) => `${o.source_id}|${signature(o.title, o.content_type, o.coverage.publicationMode)}`)]
  .filter(([, values]) => values.length > 1);

const expectedSource = [];
for (const source of sourceRows.filter((s) => fullyCurrent(s) && s.classification === "ARTICLE_CANDIDATE" && s.recommended_action === "CREATE_CONTENT_PLAN")) {
  const analysis = parse(source.analysis_json, {});
  const primaryMode = modeFromAnalysis(analysis.production_mode, analysis.classification);
  const expected = new Set([signature(analysis.suggested_article_title || analysis.primary_topic || "Content opportunity",
    analysis.suggested_content_type, primaryMode)]);
  for (const path of Array.isArray(analysis.production_paths) ? analysis.production_paths : []) {
    expected.add(signature(path.title, path.content_type || analysis.suggested_content_type,
      modeFromAnalysis(path.mode, analysis.classification)));
  }
  const stored = opportunities.filter((o) => o.source_id === source.id && o.recommendation_id === source.recommendation_id
    && o.strategy_version === currentStrategy && ["recommended", "recommended_again", "deferred"].includes(o.lifecycle_state));
  const storedSignatures = new Set(stored.map((o) => signature(o.title, o.content_type, o.coverage.publicationMode)));
  expectedSource.push({ sourceId: source.id, expected: expected.size, stored: stored.length,
    actionable: stored.filter((o) => o.inbox_state === "ACTIONABLE").length,
    merged: stored.filter((o) => o.inbox_state === "MERGED").length,
    internal: stored.filter((o) => o.inbox_state === "INTERNAL").length,
    missing: [...expected].filter((key) => !storedSignatures.has(key)),
    unexpected: [...storedSignatures].filter((key) => !expected.has(key)) });
}

const destinationById = new Map(rows("SELECT id,slug FROM destinations").map((d) => [d.id, d.slug]));
const resolutions = new Map(rows("SELECT destination_slug,normalized_key,status,preferred_value FROM knowledge_resolutions")
  .map((r) => [`${r.destination_slug}|${r.normalized_key}`, r]));
const facts = rows(`SELECT id,destination_id,normalized_key,subject,predicate,consensus_status,preferred_value,evidence_json,
  visibility_status,validity_state,consensus_detail_json FROM knowledge_facts`);
const factMap = new Map();
for (const fact of facts) {
  fact.destination_slug = destinationById.get(fact.destination_id);
  fact.evidence = parse(fact.evidence_json, []);
  fact.consensus_detail = parse(fact.consensus_detail_json, {});
  const resolution = resolutions.get(`${fact.destination_slug}|${fact.normalized_key}`);
  if (resolution?.status === "resolved") {
    fact.consensus_status = "corroborated";
    fact.preferred_value = resolution.preferred_value || fact.preferred_value;
  }
  factMap.set(`${fact.destination_slug}|${fact.normalized_key}`, fact);
}
const familyForSource = new Map(rows("SELECT source_id,family_id,relation_type FROM source_family_memberships")
  .map((item) => [item.source_id, item.family_id || `source:${item.source_id}`]));
const independenceKeys = (evidence) => uniq(evidence.map((item) => familyForSource.get(item.source_id) || `source:${item.source_id}`));
const knowledgeClusters = rows("SELECT * FROM topic_clusters");
const knowledgeExpected = new Map();
for (const cluster of knowledgeClusters) {
  const selected = parse(cluster.claim_keys_json, []).map((key) => factMap.get(`${cluster.destination_slug}|${key}`)).filter(Boolean)
    .map((fact) => ({ ...fact, evidence: fact.evidence.filter((e) => baseCurrent(sourceMap.get(e.source_id))) }))
    .filter((fact) => fact.visibility_status === "visible" && fact.evidence.length > 0);
  const usable = selected.filter((fact) => fact.consensus_status !== "conflicted"
    && ["current", "unknown"].includes(fact.validity_state || "unknown") && String(fact.preferred_value || "").trim());
  const rawSourceIds = uniq(usable.flatMap((fact) => fact.evidence.map((e) => e.source_id)));
  const familyIds = independenceKeys(usable.flatMap((fact) => fact.evidence));
  const key = `${cluster.destination_slug}|${normalizeTitle(cluster.title)}`;
  knowledgeExpected.set(key, { clusterId: cluster.id, usableFacts: usable.length, rawSources: rawSourceIds.length,
    independentFamilies: familyIds.length, codeEligible: usable.length >= 2 && rawSourceIds.length >= 2,
    familyEligible: usable.length >= 2 && familyIds.length >= 2 });
}
const knowledgeActionable = actionable.filter((o) => !o.source_id && o.coverage.knowledgeEventGenerated === true);
const knowledgeChecks = knowledgeActionable.map((o) => {
  const clusterTitle = String(o.title || "").replace(/: a practical guide for independent travelers$/i, "");
  const expected = knowledgeExpected.get(`${o.destination_slug}|${normalizeTitle(clusterTitle)}`);
  const selectedFactKeys = uniq(o.coverage.selectedFactKeys || []);
  const selectedFacts = selectedFactKeys.map((key) => factMap.get(`${o.destination_slug}|${key}`)).filter(Boolean);
  const usableSelectedFacts = selectedFacts.filter((fact) => fact.visibility_status === "visible"
    && fact.consensus_status !== "conflicted" && ["current", "unknown"].includes(fact.validity_state || "unknown")
    && String(fact.preferred_value || "").trim());
  const selectedEvidence = usableSelectedFacts.flatMap((fact) => fact.evidence.filter((e) => baseCurrent(sourceMap.get(e.source_id))));
  const selectedFamilies = independenceKeys(selectedEvidence);
  return { id: o.id, title: o.title, destination: o.destination_slug, expected: expected || null,
    storedFactCount: Number(o.readiness.factCount || 0), selectedFactKeyCount: selectedFactKeys.length,
    selectedFactCount: selectedFacts.length, usableSelectedFactCount: usableSelectedFacts.length,
    missingSelectedFactCount: selectedFactKeys.length - selectedFacts.length,
    unusableSelectedFactCount: selectedFacts.length - usableSelectedFacts.length,
    storedFamilyCount: Number(o.readiness.sourceFamilyCount || 0), actualIndependentFamilies: selectedFamilies.length,
    hasUnfinishedSelectedSource: o.sourceIds.some((id) => !baseCurrent(sourceMap.get(id))),
    familyEligibilityFailure: Boolean(expected && !expected.familyEligible),
    storedFactMismatch: Number(o.readiness.factCount || 0) !== usableSelectedFacts.length,
    storedFamilyMismatch: Number(o.readiness.sourceFamilyCount || 0) !== selectedFamilies.length };
});
const knowledgeAdmissionViolations = knowledgeChecks.filter((item) => !item.expected || item.usableSelectedFactCount < 2
  || item.actualIndependentFamilies < 2 || item.familyEligibilityFailure || item.hasUnfinishedSelectedSource
  || item.missingSelectedFactCount || item.unusableSelectedFactCount || item.storedFactMismatch || item.storedFamilyMismatch);
const genericKnowledgeSubjects = new Set(["restaurant","featured restaurant","hotpot restaurant","hotel room","pathway","trail","route",
  "viewpoint","venue","accommodation","hotel","food","attraction","transport","public transport","metro station","railway station"]);
const contextFreeKnowledge = knowledgeActionable.filter((opportunity) => {
  const base=normalizeTitle(String(opportunity.title || "").replace(/:\s*a practical guide for independent travelers$/iu, "").replaceAll("_", " "));
  const destination=normalizeTitle(opportunity.destination_slug).replaceAll(" ", "");
  const withoutDestination=base.split(" ").filter((token)=>token!==destination).join(" ");
  return !base || /\b(?:unnamed|unknown|unspecified)\b/u.test(base) || genericKnowledgeSubjects.has(base)
    || genericKnowledgeSubjects.has(withoutDestination) || /^day \d+ itinerary$/u.test(withoutDestination);
});
const crossScopeKnowledgeGroups = [...Map.groupBy(knowledgeActionable, (opportunity) => {
  const identity=String(opportunity.coverage.knowledgeIntentIdentity || normalizeTitle(opportunity.title));
  return `${primaryDestinationScope(opportunity.destination_slug)}|${normalizeType(opportunity.content_type)}|${normalizeMode(opportunity.coverage.publicationMode)}|${identity}`;
})].filter(([, values]) => new Set(values.map((item) => item.destination_slug)).size > 1);

const merged = activeLifecycle.filter((o) => o.inbox_state === "MERGED");
const primaryMap = new Map(opportunities.map((o) => [o.id, o]));
const migration = {
  opportunityMissingSource: opportunities.filter((o) => o.source_id && !sourceMap.has(o.source_id)),
  opportunityMissingRecommendation: opportunities.filter((o) => o.recommendation_id && !sourceRows.some((s) => s.recommendation_id === o.recommendation_id)),
  sourceJsonMissingSource: opportunities.filter((o) => parse(o.source_ids_json, []).some((id) => !sourceMap.has(id))),
  mergedMissingPrimary: merged.filter((o) => !o.primary_opportunity_id || !primaryMap.has(o.primary_opportunity_id)),
  mergedPrimaryNotActionable: merged.filter((o) => {
    const primary = primaryMap.get(o.primary_opportunity_id); return primary && primary.inbox_state !== "ACTIONABLE";
  }),
  mergedCanonicalMismatch: merged.filter((o) => {
    const primary = primaryMap.get(o.primary_opportunity_id); return primary && primary.canonical_intent_key !== o.canonical_intent_key;
  }),
};

const queuedJobs = rows("SELECT id,type,entity_id,status FROM jobs WHERE status IN ('queued','running')");
const segmentOwners = new Map(rows("SELECT id,source_id FROM source_segments").map((s) => [s.id, s.source_id]));
const activeJobSources = new Set(queuedJobs.map((job) => sourceMap.has(job.entity_id) ? job.entity_id : segmentOwners.get(job.entity_id)).filter(Boolean));
const unfinished = sourceRows.filter((s) => !baseCurrent(s));

const report = {
  generatedAt: new Date().toISOString(), databasePath, currentStrategy,
  integrity: {
    integrityCheck: rows("PRAGMA integrity_check").map((r) => Object.values(r)[0]),
    foreignKeyViolations: rows("PRAGMA foreign_key_check").length,
    schemaVersion: one("SELECT MAX(version) AS version FROM schema_migrations")?.version,
  },
  counts: {
    sources: sourceRows.length, baseCompleteSources: sourceRows.filter(baseCurrent).length,
    fullyCurrentSources: sourceRows.filter(fullyCurrent).length, unfinishedSources: unfinished.length,
    allOpportunities: opportunities.length, activeLifecycle: activeLifecycle.length, actionable: actionable.length,
    sourceBackedActionable: actionable.filter((o) => Boolean(o.source_id)).length,
    knowledgeActionable: knowledgeActionable.length,
    otherActionable: actionable.filter((o) => !o.source_id && o.coverage.knowledgeEventGenerated !== true).length,
    inboxStates: groupCount(opportunities, (o) => o.inbox_state),
    processingStates: groupCount(actionable, (o) => o.processing_state),
    opportunityStrategies: groupCount(opportunities, (o) => o.strategy_version),
    actionableModes: groupCount(actionable, (o) => normalizeMode(o.coverage.publicationMode)),
    actionableTypes: groupCount(actionable, (o) => normalizeType(o.content_type)),
    actionableReadiness: {
      ready: actionable.filter((o) => o.readiness.ready === true).length,
      evidenceGap: actionable.filter((o) => o.readiness.ready !== true).length,
      score0: actionable.filter((o) => Number(o.readiness_score) === 0).length,
      score100: actionable.filter((o) => Number(o.readiness_score) === 100).length,
      min: Math.min(...actionable.map((o) => Number(o.readiness_score))),
      max: Math.max(...actionable.map((o) => Number(o.readiness_score))),
    },
  },
  qualification: Object.fromEntries(Object.entries(actionableViolations).map(([key, values]) => [key, { count: values.length, sample: safeSample(values) }])),
  duplicates: {
    canonicalActionableGroups: canonicalGroups.length,
    exactActionableGroups: exactGroups.length,
    sameSourceSignatureGroups: sourceSignatureGroups.length,
    duplicateTopicKeyGroups: topicKeyGroups.length,
    exactSamples: exactGroups.slice(0, 20).map(([key, values]) => ({ key, count: values.length, rows: safeSample(values, 10) })),
    sourceSignatureSamples: sourceSignatureGroups.slice(0, 20).map(([key, values]) => ({ key, count: values.length, rows: safeSample(values, 10) })),
  },
  sourceGeneration: {
    eligibleArticleSources: expectedSource.length,
    expectedPaths: expectedSource.reduce((sum, item) => sum + item.expected, 0),
    storedPaths: expectedSource.reduce((sum, item) => sum + item.stored, 0),
    actionablePaths: expectedSource.reduce((sum, item) => sum + item.actionable, 0),
    mergedPaths: expectedSource.reduce((sum, item) => sum + item.merged, 0),
    sourcesWithMissingPaths: expectedSource.filter((item) => item.missing.length).length,
    sourcesWithUnexpectedPaths: expectedSource.filter((item) => item.unexpected.length).length,
    mismatchSamples: expectedSource.filter((item) => item.missing.length || item.unexpected.length).slice(0, 30),
  },
  knowledgeGeneration: {
    clusters: knowledgeClusters.length,
    codeEligibleClusters: [...knowledgeExpected.values()].filter((x) => x.codeEligible).length,
    familyEligibleClusters: [...knowledgeExpected.values()].filter((x) => x.familyEligible).length,
    actionableKnowledge: knowledgeChecks.length,
    familyEligibilityFailures: knowledgeChecks.filter((x) => x.familyEligibilityFailure).length,
    missingSelectedFacts: knowledgeChecks.filter((x) => x.missingSelectedFactCount).length,
    unusableSelectedFacts: knowledgeChecks.filter((x) => x.unusableSelectedFactCount).length,
    storedFactMismatches: knowledgeChecks.filter((x) => x.storedFactMismatch).length,
    storedFamilyMismatches: knowledgeChecks.filter((x) => x.storedFamilyMismatch).length,
    unfinishedEvidence: knowledgeChecks.filter((x) => x.hasUnfinishedSelectedSource).length,
    suspectSamples: knowledgeChecks.filter((x) => x.familyEligibilityFailure || x.missingSelectedFactCount
      || x.unusableSelectedFactCount || x.storedFactMismatch || x.storedFamilyMismatch || x.hasUnfinishedSelectedSource).slice(0, 30),
  },
  admissionQuality: {
    knowledgeAdmissionViolations: knowledgeAdmissionViolations.length,
    contextFreeKnowledge: contextFreeKnowledge.length,
    crossScopeKnowledgeDuplicateGroups: crossScopeKnowledgeGroups.length,
    crossScopeKnowledgeDuplicateRows: crossScopeKnowledgeGroups.reduce((sum, [, values]) => sum + values.length - 1, 0),
    samples: {
      knowledgeAdmission: knowledgeAdmissionViolations.slice(0, 20),
      contextFreeKnowledge: safeSample(contextFreeKnowledge),
      crossScopeKnowledge: crossScopeKnowledgeGroups.slice(0, 20).map(([key, values]) => ({key, rows:safeSample(values)})),
    },
  },
  migration: Object.fromEntries(Object.entries(migration).map(([key, values]) => [key, { count: values.length, sample: safeSample(values) }])),
  queue: {
    activeJobs: queuedJobs.length, unfinishedSources: unfinished.length,
    unfinishedWithActiveJob: unfinished.filter((s) => activeJobSources.has(s.id)).length,
    unfinishedWithoutActiveJob: unfinished.filter((s) => !activeJobSources.has(s.id)).length,
    withoutJobSourceIds: unfinished.filter((s) => !activeJobSources.has(s.id)).slice(0, 30).map((s) => s.id),
  },
  semanticInventory: actionable.map((o) => ({
    id: o.id, destination: o.destination_slug, title: o.title, contentType: o.content_type,
    publicationMode: normalizeMode(o.coverage.publicationMode), sourceId: o.source_id || null,
    knowledgeGenerated: o.coverage.knowledgeEventGenerated === true,
    canonicalIntentKey: o.canonical_intent_key,
    selectedFactKeys: o.coverage.selectedFactKeys || [],
    targetEntities: o.coverage.proposal?.targetEntities || [],
    readerPromise: o.coverage.proposal?.readerPromise || "",
    readinessScore: Number(o.readiness_score), ready: o.readiness.ready === true,
  })),
};

const integrityViolationCount = report.integrity.integrityCheck.filter((value) => value !== "ok").length
  + report.integrity.foreignKeyViolations;
const hardViolationCount = integrityViolationCount
  + Object.values(actionableViolations).reduce((sum, values) => sum + values.length, 0)
  + exactGroups.length + canonicalGroups.length + topicKeyGroups.length + sourceSignatureGroups.length
  + crossScopeKnowledgeGroups.length + knowledgeAdmissionViolations.length + contextFreeKnowledge.length
  + expectedSource.filter((item) => item.missing.length || item.unexpected.length).length
  + Object.values(migration).reduce((sum, values) => sum + values.length, 0);
report.enforcement = {
  enforced: enforce,
  passed: hardViolationCount === 0,
  hardViolationCount,
  integrityViolationCount,
  productionHolds: {
    evidenceGap: actionable.filter((o) => o.processing_state === "EVIDENCE_GAP").length,
    readinessScoreZero: actionable.filter((o) => Number(o.readiness_score) === 0).length,
    sourceBackedWithoutSelectedFacts: actionable.filter((o) => o.source_id && !(o.coverage.selectedFactKeys || []).length).length,
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
db.close();
if (enforce && hardViolationCount > 0) process.exitCode = 1;
