// Read-only audit of source code; all database mutations use in-memory SQLite.
// Run from CMS root: node docs/audit/2026-09-07-reproduce.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/db.mjs';
import { Repository } from '../../src/repository.mjs';
import { FrontendContractConsumer } from '../../src/frontend-contract.mjs';
import { evaluateCoverage, segmentSource, classifySourceFamily } from '../../src/research-strategy.mjs';
import { ContentEngine } from '../../src/ai/content-engine.mjs';
import { KimiExtractor } from '../../src/ai/kimi.mjs';
import { WordPressDraftAdapter } from '../../src/wordpress.mjs';
import { createAuth } from '../../src/auth.mjs';
import { normalizeXiaohongshuCapture } from '../../src/adapters/xiaohongshu.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = path.resolve(root, '../solo-to-china');
const db = openDatabase(':memory:');
const repository = new Repository(db, { publicSiteUrl: 'https://example.test' });
const results = [];
const record = (id, evidence) => results.push({ id, reproduced: true, evidence });
try {
  const consumer = new FrontendContractConsumer(repository, {
    registrySource: path.join(frontend, 'contracts/component-registry.json'),
    pageSchemaSource: path.join(frontend, 'contracts/page-schema.json'),
    publishPackageSchemaSource: path.join(frontend, 'contracts/cms-publish-package.schema.json'),
  });
  await consumer.sync();
  const metadata = { pageId: 'audit', title: 'Audit', slug: 'audit', contentType: 'attraction_guide' };
  const registry = JSON.parse(fs.readFileSync(path.join(frontend, 'contracts/component-registry.json'), 'utf8'));
  const heading = registry.components.find(c => c.id === 'heading');
  const validHeading = consumer.validatePagePayload({ metadata, blocks: [heading.example] });
  assert.equal(validHeading.valid, false);
  record('A01-heading-contract', { enum: heading.inputSchema.properties.level.enum, exampleErrors: validHeading.errors });
  record('A01-published-examples', registry.components.map(c => ({ component: c.id, valid: consumer.validatePagePayload({ metadata, blocks: [c.example] }).valid })));
  const heroPlan = consumer.validateCompositionPlan({ blocks: [{ type: 'article_hero', variant: 'attraction' }] });
  assert.equal(heroPlan.valid, true);
  assert(consumer.resolveForArticle({ draft: { title: 'Article hero' } }).components.some(c => c.id === 'article_hero'));
  record('A19-presentation-interface', { planAccepted: heroPlan.valid, pageAccepted: consumer.validatePagePayload({ metadata, blocks: [registry.components.find(c => c.id === 'article_hero').example] }).valid });
  const emptyPage = consumer.validatePagePayload({ metadata, blocks: [] });
  assert.equal(emptyPage.valid, true);
  record('A05-empty-final-page', { valid: emptyPage.valid });
  const unsafeHtml = consumer.validatePagePayload({ metadata, blocks: [{ type: 'paragraph', variant: 'default', data: { content: '<script>alert(1)</script>' } }] });
  assert.equal(unsafeHtml.valid, true);
  record('A12-validator-parity', { cmsAcceptsExecutableInlineHtml: unsafeHtml.valid, note: 'Frontend PHP rejects this via wp_kses; this is not demonstrated public XSS.' });

  const facts = ['entry', 'opening_time', 'reservation', 'transport'].map(predicate => ({
    normalized_key: `summer_palace.${predicate}`, subject: 'Summer Palace', predicate,
    consensus_status: 'corroborated', freshness_state: 'current', verification_priority: 'normal',
  }));
  const coverage = evaluateCoverage({ topicKey: 'beijing:attraction_guide:forbidden-city', contentType: 'attraction_guide', facts, sourceFamilyCount: 2 });
  assert.equal(coverage.readiness.ready, true);
  record('A03-topic-scope', { ready: coverage.readiness.ready, factSubjects: [...new Set(facts.map(f => f.subject))] });

  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,created_at,updated_at) VALUES ('audit-topic','beijing','audit-topic','Audit','Audit',100,2,0,?,?)").run(timestamp, timestamp);
  const briefId = repository.saveBrief('audit-topic', { title: 'Audit', audience: ['solo'], search_intent: 'informational', outline: [], canonical: { quick_answer: 'Audit answer', answer_blocks: [] } }, 'mock', { deferDraft: true });
  const draft = { title: 'Audit', slug: 'audit', meta_description: 'Audit description', body_markdown: '## Key takeaways\n' + 'Useful travel guidance. '.repeat(280) + '\n## Frequently asked questions\nRead the guidance.', evidence_ledger: [], unresolved_conflicts: [], verification_notes: [], seo: { meta_title: 'Audit', focus_keyword: 'audit' }, faqs: [], visuals: [] };
  const draftId = repository.saveDraft(briefId, draft, 'mock', { deferReview: true });
  const engine = new ContentEngine({ apiKey: 'mock', baseUrl: 'https://unused.test', model: 'mock' });
  engine.respond = async () => ({ model: 'mock', output: { passed: true, score: 100, checks: [], issues: [], unsupported_claims: [] } });
  const pack = repository.getDraftPackage(draftId);
  pack.frontend_page = { payload: { metadata, blocks: [] } };
  const reviewed = await engine.review(pack);
  assert.equal(reviewed.output.passed, true);
  record('A05-qa-ledger-and-page', { passed: reviewed.output.passed, ledger: pack.draft.evidence_ledger, finalBlocks: pack.frontend_page.payload.blocks.length });

  repository.saveReview(draftId, reviewed.output, 'mock');
  repository.saveDraft(briefId, { ...draft, body_markdown: 'Entirely replaced and not reviewed.' }, 'mock', { deferReview: true });
  const revised = repository.getDraftPackage(draftId);
  assert.equal(revised.review.passed, true);
  record('A06-stale-review', { revision: revised.draft.revision, draftStatus: revised.draft.status, returnedReviewPassed: revised.review.passed });
  const visual = repository.plannedVisuals(draftId)[0];
  repository.failVisual(visual.id, new Error('temporary 503'));
  assert(!repository.plannedVisuals(draftId).some(v => v.id === visual.id));
  record('A07-image-retry-skips-failure', { failedVisual: visual.id, retrySelection: repository.plannedVisuals(draftId).map(v => v.id) });

  let coverageInput;
  const extractor = new KimiExtractor({ apiKey: 'mock', provider: 'kimi' });
  extractor.client = { enabled: true, completeJson: async input => { coverageInput = input; return { output: { uncovered_spans: [] }, model: 'mock' }; } };
  await extractor.auditCoverage({ segment: { raw_text: '', asset_id: 'image-with-material-facts', segment_type: 'image' }, extraction: { claims: [] } });
  assert(coverageInput.content.every(p => p.type === 'text'));
  record('A04-multimodal-audit', { content: coverageInput.content });

  const longText = 'x'.repeat(130000);
  const segments = segmentSource({ id: 'long', raw_text: longText, assets: [] });
  assert.equal(segments.length, 1);
  record('A13-long-paragraph', { segments: segments.length, firstSegmentChars: segments[0].rawText.length, extractionInputLimit: 120000 });
  const family = classifySourceFamily({ raw_text: '北京故宫需要预约，携带护照。' }, { raw_text: '北京故宫必须预约，携带护照。' });
  record('A14-chinese-family', family);

  const auth = createAuth(db, { username: 'audit-admin', password: 'audit-old-password', sessionSecret: 'audit-secret', forcePasswordChange: false });
  const oldCookie = auth.login('audit-admin', 'audit-old-password').cookie.split(';')[0];
  auth.changePassword({ headers: { cookie: oldCookie } }, 'audit-old-password', 'audit-new-password');
  assert.equal(auth.status({ headers: { cookie: oldCookie } }).authenticated, true);
  record('A15-session-revocation', { oldCookieValidAfterPasswordChange: true });

  const jobId = repository.enqueue('audit_job', 'audit_entity');
  repository.claimJob();
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status, 'running');
  new Repository(db);
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id=?').get(jobId).status, 'queued');
  record('A16-repository-lock-reset', { runningJobAfterSecondRepository: 'queued' });

  let uploads = 0;
  const adapter = new WordPressDraftAdapter({ siteUrl: 'https://unused.test', username: 'mock', applicationPassword: 'mock' });
  adapter.uploadMedia = async v => { uploads++; if (v.id === 'second') throw new Error('temporary upload error'); return { id: 100 + uploads, url: 'https://unused.test/image.jpg' }; };
  const media = ['first','second'].map(id => ({ id, status: 'generated', source_asset_id: id, source_remote_url: 'https://ci.xhscdn.com/example.jpg' }));
  await assert.rejects(adapter.resolveVisualMedia(media));
  await assert.rejects(adapter.resolveVisualMedia(media));
  assert.equal(uploads, 4);
  record('A08-partial-upload', { uploadCallsAcrossTwoAttempts: uploads, firstAssetUploadedTwice: true });

  const capture = normalizeXiaohongshuCapture({ url: 'https://www.xiaohongshu.com/explore/audit-old-source', title: 'Beijing tickets', text: 'Old source about ticket prices for a Beijing museum.', images: [], publishedAt: '2020-01-01T00:00:00.000Z' });
  const source = repository.saveCapture(capture);
  db.prepare("UPDATE sources SET published_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(source.id);
  repository.saveExtraction(source.id, { source: { language: 'en', summary: 'Old prices', destination_name: 'Beijing', destination_slug: 'beijing', traveler_fit: [], practical_tips: [], warnings: [], confidence: 0.9 }, claims: [{ key: 'museum.ticket.price', subject: 'Museum', predicate: 'ticket_price', value: '60 yuan', qualifiers: [], source_quote: 'A fabricated quote not present in the source.', confidence: 0.9 }], blueprint: { format: 'guide', hook: '', angle: '', sections: [], strengths: [], gaps: [] } }, 'mock', 'mock');
  repository.rebuildKnowledge('beijing');
  const saved = repository.knowledgeForDestination('beijing').find(f => f.normalized_key === 'museum.ticket.price');
  assert(saved && saved.freshness_state !== 'stale');
  record('A09-source-age-and-quote', { sourcePublishedAt: '2020-01-01', freshnessState: saved.freshness_state, inventedQuotePersisted: saved.evidence[0].quote });
  record('A18-official-evidence', { capturedSourceAuthority: db.prepare('SELECT authority_level FROM sources WHERE id=?').get(source.id).authority_level, resultingVerification: saved.verification_priority });
  console.log(JSON.stringify(results, null, 2));
} finally {
  db.close();
}
