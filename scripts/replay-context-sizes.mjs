#!/usr/bin/env node
// Read-only L3 measurement of model input sizes on a production database copy:
// intake packages (current compact projection vs. the previous 80-fact projection)
// and the entity-resolution pages a daily pass would send (incremental watermark aware).
// Usage: node scripts/replay-context-sizes.mjs <database.sqlite>
import { DatabaseSync } from "node:sqlite";
import { Repository } from "../src/repository.mjs";
if (!process.argv[2]) { console.error("Usage: node scripts/replay-context-sizes.mjs <database.sqlite>"); process.exit(2); }
const db = new DatabaseSync(process.argv[2], { readOnly: true });
db.exec("PRAGMA query_only=ON");
const repository = new Repository(db, { entityFullReviewDays: Number(process.env.ENTITY_FULL_REVIEW_DAYS || 7) });
const tokens = (value) => Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 3.5);
const pct = (list, p) => list.sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(p * list.length))];
// Intake: new compact package vs. the previous projection (80 facts with evidence quotes).
const intakeNew = [], intakeOld = [];
for (const { id } of db.prepare("SELECT s.id FROM sources s JOIN structured_sources ss ON ss.source_id=s.id").all()) {
  const pack = repository.getIntakePackage(id);
  if (!pack) continue;
  intakeNew.push(tokens(pack));
  const slug = repository.getSource(id).structured.destination_slug;
  const oldKnowledge = repository.knowledgeForDestination(slug).slice(0, 80).map((fact) => ({ key: fact.normalized_key, subject: fact.subject,
    predicate: fact.predicate, preferred_value: fact.preferred_value, consensus_status: fact.consensus_status, confidence: fact.consensus_confidence,
    freshness: fact.freshness_state, evidence: (fact.evidence || []).slice(0, 2).map((item) => ({ source_id: item.source_id,
      quote: String(item.quote || "").slice(0, 200), confidence: item.confidence, observed_at: item.observed_at || item.published_at || null })) }));
  intakeOld.push(tokens({ ...pack, existing_destination_coverage: undefined, existing_knowledge: oldKnowledge }));
}
// Entity resolution: pages that would be sent now, claims pre-linked away.
const entity = [];
for (const { slug } of db.prepare("SELECT DISTINCT destination_slug AS slug FROM structured_sources WHERE destination_slug NOT IN ('','unknown')").all()) {
  let cursor = null, pages = 0, claims = 0, prelinked = 0, total = 0;
  const since = repository.entityReviewSince(slug);
  do {
    const page = repository.getEntityResolutionPackage(slug, 80, cursor, { since });
    if (page.claims.length) { pages += 1; total += tokens(page); }
    claims += page.claims.length; prelinked += page.prelinked_claims || 0; cursor = page.nextCursor;
  } while (cursor);
  const unresolved = db.prepare(`SELECT COUNT(*) n FROM claims c JOIN structured_sources ss ON ss.source_id=c.source_id
    WHERE ss.destination_slug=? AND c.knowledge_eligible=1 AND c.lifecycle_status='active' AND c.entity_resolution_status<>'resolved'`).get(slug).n;
  entity.push({ slug, since, unresolved, sentToModel: claims, prelinked, pages, tokens: total });
}
console.log(JSON.stringify({
  intake: { sources: intakeNew.length, oldP50: pct(intakeOld, .5), oldP95: pct(intakeOld, .95), newP50: pct(intakeNew, .5), newP95: pct(intakeNew, .95),
    oldTotal: intakeOld.reduce((a, b) => a + b, 0), newTotal: intakeNew.reduce((a, b) => a + b, 0) },
  entity: { destinations: entity.length, unresolved: entity.reduce((a, b) => a + b.unresolved, 0),
    sentToModel: entity.reduce((a, b) => a + b.sentToModel, 0), prelinked: entity.reduce((a, b) => a + b.prelinked, 0),
    pages: entity.reduce((a, b) => a + b.pages, 0), tokens: entity.reduce((a, b) => a + b.tokens, 0),
    top: entity.sort((a, b) => b.unresolved - a.unresolved).slice(0, 5) },
}, null, 2));
