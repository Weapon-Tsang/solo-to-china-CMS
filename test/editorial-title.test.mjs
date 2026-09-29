import assert from 'node:assert/strict';
import test from 'node:test';
import { evidenceTitle, boilerplateTitleSubject, opportunityTitleSubject } from '../src/editorial-title.mjs';
import { previewTitleRepair, applyTitleRepair } from '../scripts/repair-editorial-titles.mjs';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';

const old = 'Museum: a practical guide for independent travelers';
function opportunity(db, id = 'opp', coverage = {}) {
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,title,content_type,
    readiness_score,coverage_json,status,created_at,updated_at) VALUES (?,'beijing',?,'3.7',?,'attraction_guide',80,?,'recommended','2026-09-29','2026-09-29')`)
    .run(id, `beijing:${id}`, old, JSON.stringify(coverage));
}
function draftFixture(t, status = 'review') {
  const fixture = repositoryFixture(t), { db } = fixture;
  opportunity(db);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,created_at,updated_at,opportunity_id)
    VALUES ('candidate','beijing','beijing:candidate',?,'test',80,2,0,'2026-09-29','2026-09-29','opp')`).run(old);
  db.prepare("UPDATE content_opportunities SET candidate_id='candidate',approved_at='2026-09-29',status='drafted',lifecycle_state='producing' WHERE id='opp'").run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('brief','beijing',?,'[]','informational','drafted','2026-09-29','2026-09-29','candidate')`).run(old);
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,content_hash,seo_json)
    VALUES ('draft','brief',?,'museum','## Visit\n\nTake the metro.','{}',?,'2026-09-29','2026-09-29','old',?)`)
    .run(old, status, JSON.stringify({ meta_title: old, seo_title: old, og_title: old }));
  return fixture;
}

test('titles express supported facets and never manufacture unsupported promises', () => {
  assert.equal(evidenceTitle('Museum', [{predicate:'reservation'}, {predicate:'opening_hours'}]), 'Museum: Booking, Opening Hours');
  assert.equal(evidenceTitle('Metro', [{predicate:'route'}, {predicate:'payment'}]), 'Metro: Route, Payment');
  assert.equal(evidenceTitle('火锅店', [{predicate:'signature_dish'}, {predicate:'price'}]), '火锅店：费用、点餐');
  assert.equal(evidenceTitle('Zoo', [{predicate:'unknown'}, {predicate:'ticket_price',consensus_status:'conflicted'}]), 'Zoo');
  for (const title of [old, 'Museum: Practical Visitor Guide for Independent Travelers', 'Museum: Practical Guide for Independent and Solo Travelers',
    'Museum: Independent Visitor Guide', 'Museum: Complete Independent Traveler Guide (2026)'])
    assert.equal(boilerplateTitleSubject(title), 'Museum');
  assert.equal(boilerplateTitleSubject('Museum: Opening Hours and Tickets'), null);
  assert.equal(opportunityTitleSubject({title:'Museum: Booking, Opening Hours',coverage:{proposal:{targetEntities:['Museum']}}}), 'Museum');
  assert.equal(opportunityTitleSubject({title:old}), 'Museum');
  assert.equal(evidenceTitle('Museum', [{predicate:'ticket_price',visibility_status:'hidden'}, {predicate:'opening_hours',validity_state:'expired'}]), 'Museum');
});

test('historical repair changes only unapproved titles and is repeatable without changing identity or approval', t => {
  const { db } = repositoryFixture(t);
  opportunity(db); opportunity(db, 'approved');
  db.prepare("UPDATE content_opportunities SET approved_at='2026-09-29' WHERE id='approved'").run();
  const before = db.prepare('SELECT * FROM content_opportunities ORDER BY id').all();
  const result = applyTitleRepair(db, previewTitleRepair(db));
  assert.equal(result.changed.length, 1);
  const after = db.prepare('SELECT * FROM content_opportunities ORDER BY id').all();
  assert.deepEqual(after.map(row => ({...row})), before.map(row => row.id === 'opp'
    ? {...row,title:'Museum',coverage_json:JSON.stringify({titlePolicy:'evidence-v1'})} : {...row}));
  assert.equal(applyTitleRepair(db, previewTitleRepair(db)).changed.length, 0);
});

test('a new owner job invalidates a repair preview before any write', t => {
  const { db, repository } = repositoryFixture(t); opportunity(db);
  const preview = previewTitleRepair(db);
  repository.enqueue('assemble_editorial', 'unknown-candidate', {productionOwnerOpportunityId:'opp'});
  assert.throws(() => applyTitleRepair(db, preview), /Stale/);
  assert.equal(db.prepare("SELECT title FROM content_opportunities WHERE id='opp'").get().title, old);
});

for (const link of ['draft', 'brief', 'candidate', 'owner']) test(`active production at ${link} protects the entire historical article`, t => {
  const { db, repository } = draftFixture(t);
  repository.enqueue('review_draft', link === 'owner' ? 'unrelated-entity' : link,
    link === 'owner' ? {productionOwnerOpportunityId:'opp'} : {});
  const before = db.prepare("SELECT * FROM article_drafts WHERE id='draft'").get();
  assert.equal(applyTitleRepair(db, previewTitleRepair(db)).changed.length, 0);
  assert.deepEqual(db.prepare("SELECT * FROM article_drafts WHERE id='draft'").get(), before);
});

test('any WordPress association is protected, even if local publication status is stale', t => {
  const { db } = draftFixture(t);
  db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,status,created_at,updated_at)
    VALUES ('publication','draft','https://example.invalid',42,'failed','2026-09-29','2026-09-29')`).run();
  assert.equal(previewTitleRepair(db).changed, 0);
});

test('idle draft repair updates metadata and revision without changing body, slug or creating jobs', t => {
  const { db } = draftFixture(t);
  const before = db.prepare("SELECT * FROM article_drafts WHERE id='draft'").get();
  const result = applyTitleRepair(db, previewTitleRepair(db));
  assert.equal(result.changed.length, 1);
  const after = db.prepare("SELECT * FROM article_drafts WHERE id='draft'").get();
  assert.equal(after.title, 'Museum');
  assert.equal(after.body_markdown, before.body_markdown);
  assert.equal(after.slug, before.slug);
  assert.equal(after.revision, before.revision + 1);
  assert.notEqual(after.content_hash, before.content_hash);
  assert.equal(after.status, 'review');
  for (const key of ['meta_title','seo_title','og_title']) assert.equal(JSON.parse(after.seo_json)[key], 'Museum');
  assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM draft_revisions').get().n, 1);
});

test('new title policy removes generic model output while existing production owners stay untouched', t => {
  const { db, repository } = draftFixture(t);
  const generated = {title:old,slug:'museum',body_markdown:'## Visit\n\nTake the metro.',meta_description:'Visit the museum.',
    evidence_ledger:[],unresolved_conflicts:[],seo:{meta_title:old,og_title:old},visuals:[],faqs:[]};
  repository.saveDraft('brief', {...generated}, 'test', {deferReview:true});
  assert.equal(db.prepare("SELECT title FROM article_drafts WHERE id='draft'").get().title, old);
  db.prepare("UPDATE content_opportunities SET coverage_json=? WHERE id='opp'").run(JSON.stringify({titlePolicy:'evidence-v1'}));
  repository.saveDraft('brief', {...generated}, 'test', {deferReview:true});
  assert.equal(db.prepare("SELECT title FROM article_drafts WHERE id='draft'").get().title, 'Museum');
  repository.saveDraft('brief', {...generated,title:'Museum: Choosing an Entry Slot'}, 'test', {deferReview:true});
  const final=db.prepare("SELECT title,seo_json FROM article_drafts WHERE id='draft'").get();
  assert.equal(final.title,'Museum: Choosing an Entry Slot');
  assert.equal(JSON.parse(final.seo_json).meta_title,final.title);
});
