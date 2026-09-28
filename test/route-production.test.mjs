import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';
import { seedRouteProduction } from '../test-support/route-production-fixture.mjs';
import { ContentEngine } from '../src/ai/content-engine.mjs';
import { routeReadableMarkdown, normalizeRouteFragments } from '../src/route-bundle.mjs';
import { Pipeline } from '../src/pipeline.mjs';
import { evaluatePublicationEligibility, mediaManifestForDraft, routeMediaDependencyHash, routePageDependencyHash } from '../src/publication-eligibility.mjs';
import { executeContentRecovery } from '../src/services/content-recovery.mjs';
import { createBackup, restoreBackup } from '../src/backup.mjs';
import { DatabaseSync } from 'node:sqlite';
import { explainOperationalFailure } from '../src/services/content-recovery-policy.mjs';
import { buildContentAst } from '../src/content-blocks.mjs';
import { validateMediaDelivery } from '../src/media-delivery.mjs';
import { FrontendContractConsumer } from '../src/frontend-contract.mjs';
import { frontendContractFixture, defaultComponents } from '../test-support/frontend-contract-fixture.mjs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { auditSourcePhoto, closeLocalPhotoAudit } from '../src/local-photo-audit.mjs';

function boundaryEngine(calls) {
  const engine=new ContentEngine({apiKey:'unused',model:'fixture'});
  // The actual ContentEngine request builders, validators and repository run.
  // Only completeJson (the external model boundary) is controlled.
  engine.client={enabled:true,async completeJson(request) {
    const input=JSON.parse(request.content);calls.push({name:request.name,input});
    if(request.name==='article_bundle_v1') {
      const keys=input.facts.map(f=>f.normalized_key);
      const heading=input.route_bundle?'Route':'Visitor information';
      const output={brief:{title:'Beijing one-day itinerary',primary_keyword:'Beijing route',audience:['solo'],search_intent:'informational',
        angle:'Follow the source',reader_promise:'Follow the supported route',outline:[{section_id:'route',heading,purpose:'Follow the source',claim_keys:keys}],
        adaptation_requirements:[],conflict_instructions:[]},
      draft:{title:'Beijing one-day itinerary',slug:'beijing-route',meta_description:'Follow the supported sequence.',
        body_markdown:`## ${heading}\n\n${input.approved_route_table || ''}\n\n${input.facts.map(f=>f.preferred_value).join('\n')}`,
        evidence_ledger:keys.length?[{section_id:'route',section:'Route',content_node_ids:['node-route'],claim_keys:keys,
          source_ids:[...new Set(input.facts.flatMap(f=>f.evidence.map(e=>e.source_id)))]}]:[],unresolved_conflicts:[],verification_notes:[],
        seo:{meta_title:'Beijing route',focus_keyword:'Beijing route',secondary_keywords:[],search_intent:'informational',key_takeaways:[]},faqs:[],visuals:[]}};
      request.validateOutput?.(output);return {output,model:'controlled-writer'};
    }
    if(request.name.startsWith('quality_review')) return {model:'controlled-reviewer',output:{passed:false,score:80,checks:[],issues:[],unsupported_claims:[],
      ...(input.route_bundle?{route_audit:{checked:true,passed:true,differences:[],approved_route_hash:input.route_bundle.approved_route_hash}}:{})}};
    throw new Error(`Unexpected paid stage ${request.name}`);
  }};
  return engine;
}

test('planning and actual writer/reviewer distinguish knowledge from an explicitly approved mixed section',async t=>{
  const {repository,db}=repositoryFixture(t),seed=seedRouteProduction(repository);
  const row=db.prepare('SELECT coverage_json FROM content_opportunities WHERE id=?').get(seed.ownerId);
  const coverage=JSON.parse(row.coverage_json);
  coverage.approval.proposal={content_type:'attraction_guide',title:'East Hall visitor information'};
  db.prepare('UPDATE content_opportunities SET coverage_json=? WHERE id=?').run(JSON.stringify(coverage),seed.ownerId);
  const knowledge=repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId});
  assert.equal(knowledge.route_bundle,null);
  assert.equal(db.prepare('SELECT count(*) n FROM route_bundles').get().n,0);
  const calls=[],engine=boundaryEngine(calls);
  const produce=async research=>{
    const result=await engine.articleBundle(research);
    const briefId=repository.saveBrief(seed.candidateId,result.output.brief,result.model,{deferDraft:true,opportunityId:seed.ownerId,routeBundle:research.route_bundle});
    const draftId=repository.saveDraft(briefId,result.output.draft,result.model,{deferReview:true,opportunityId:seed.ownerId,routeBundle:research.route_bundle});
    const pkg=repository.getDraftPackage(draftId);await engine.review(pkg);return pkg;
  };
  const knowledgeArticle=await produce(knowledge);
  assert.equal(knowledgeArticle.route_bundle,null);
  assert.ok(!knowledgeArticle.draft.visuals.some(v=>v.acquisition_strategy==='render_route_schematic'));
  assert.equal(calls[0].input.approved_route_table,null);assert.equal(calls[1].input.route_bundle,null);
  coverage.approval.proposal.route_scope={mode:'source_route_adaptation'};
  db.prepare('UPDATE content_opportunities SET coverage_json=? WHERE id=?').run(JSON.stringify(coverage),seed.ownerId);
  const mixed=repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId});
  assert.equal(mixed.route_bundle.status,'FROZEN');
  assert.equal(mixed.route_bundle.media_obligations.length,0);
  const mixedArticle=await produce(mixed);
  assert.equal(mixedArticle.route_bundle.approved_route_hash,mixed.route_bundle.approved_route_hash);
  assert.match(calls[2].input.approved_route_table,/Day 1/);
  assert.equal(calls[3].input.route_bundle.approved_route_hash,mixed.route_bundle.approved_route_hash);
  assert.deepEqual(calls.map(c=>c.name),['article_bundle_v1','quality_review_v3','article_bundle_v1','quality_review_v3']);
});

test('optional route renderer failure is omitted durably and continues to independent review without rewriting',async t=>{
  const {repository,db}=repositoryFixture(t),seed=seedRouteProduction(repository);
  db.prepare('DELETE FROM jobs').run();
  const calls=[],pipeline=new Pipeline(repository,{enabled:false},{contentEngine:boundaryEngine(calls)});
  repository.enqueue('plan_content',seed.candidateId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();
  const before=db.prepare('SELECT id,body_markdown,content_hash,revision FROM article_drafts').get();
  await pipeline.runOne();
  const mediaJob=db.prepare("SELECT * FROM jobs WHERE type='generate_visuals'").get();
  assert.equal(mediaJob.status,'succeeded',mediaJob.last_error);
  const visual=repository.listDraftVisuals(before.id)[0];
  assert.equal(visual.status,'skipped');assert.equal(visual.attempt_count,1);
  assert.equal(visual.media_metadata.route_omission.code,'ROUTE_RENDER_STORAGE_MISSING');
  const manifest=mediaManifestForDraft(db,before.id);
  assert.equal(manifest.minimumRequired,0);assert.equal(manifest.slots[0].required,false);
  assert.equal(evaluatePublicationEligibility(db,before.id,{requireRouteReview:false}).passed,true);
  assert.equal(validateMediaDelivery([visual]).valid,true);
  assert.equal(buildContentAst({draft:{body_markdown:before.body_markdown},visuals:[visual]}).media.length,0);
  assert.ok(db.prepare("SELECT 1 FROM jobs WHERE type='review_draft' AND status='queued'").get());
  assert.deepEqual(db.prepare('SELECT id,body_markdown,content_hash,revision FROM article_drafts').get(),before);
  assert.equal(calls.length,1);
  assert.equal(repository.getContentProductionDetail(seed.ownerId).draft.draft.visuals[0].status,'skipped');
  const pkg=repository.getDraftPackage(before.id),review={passed:true,score:100,checks:[],issues:[],unsupported_claims:[],
    route_audit:{checked:true,passed:true,differences:[],approved_route_hash:pkg.route_bundle.approved_route_hash}};
  const expected={revision:pkg.draft.revision,contentHash:pkg.draft.content_hash,routeHash:pkg.route_bundle.approved_route_hash,
    mediaDependencyHash:routeMediaDependencyHash(db,before.id)};
  repository.saveReview(before.id,review,'controlled-independent-review',expected);
  assert.equal(evaluatePublicationEligibility(db,before.id).passed,true);
  db.prepare("UPDATE article_visuals SET caption='Changed after independent review' WHERE id=?").run(visual.id);
  assert.equal(evaluatePublicationEligibility(db,before.id).code,'ROUTE_REVIEW_MISSING_OR_STALE');
  assert.throws(()=>repository.saveReview(before.id,review,'late-review',expected),{code:'ROUTE_VERSION_STALE'});
  assert.equal(db.prepare('SELECT count(*) n FROM quality_reviews').get().n,1);
});

test('real Worker route page composition can upload before text QA, while final delivery still rejects missing QA',async t=>{
  const {repository,db,directory}=repositoryFixture(t);repository.contentConfig.generatedMediaDir=path.join(directory,'media');
  const seed=seedRouteProduction(repository);
  const fixture=frontendContractFixture(t,{components:[...defaultComponents(),{id:'image',category:'media',purpose:'Route image',status:'stable',variants:['context'],
    schema:{type:'object',required:['media_id','alt','role'],properties:{media_id:{type:'integer'},alt:{type:'string'},role:{type:'string'},caption:{type:'string'}}}}]});
  const frontendContracts=new FrontendContractConsumer(repository,{sourceRepository:'https://example.invalid/frontend',registrySource:fixture.registryPath,pageSchemaSource:fixture.pageSchemaPath});
  await frontendContracts.sync();db.prepare('DELETE FROM jobs').run();
  const calls=[];let uploads=0;
  const wordpress={enabled:true,async resolveVisualMedia(visuals,onProgress){
    uploads++;
    const results=visuals.filter(v=>v.status==='generated').map(v=>({visualId:v.id,id:101,url:'https://example.invalid/route.png',
      metadata:{width:1100,height:501,mime:'image/png',bytes:fs.statSync(v.media_path).size,
        sha256:createHash('sha256').update(fs.readFileSync(v.media_path)).digest('hex')}}));
    for(const r of results)onProgress(r);return results;
  }};
  const pipeline=new Pipeline(repository,{enabled:false},{contentEngine:boundaryEngine(calls),frontendContracts,wordpress});
  repository.enqueue('plan_content',seed.candidateId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();await pipeline.runOne();await pipeline.runOne();
  const pageJob=db.prepare("SELECT * FROM jobs WHERE type='compose_frontend_page'").get();
  assert.equal(pageJob.status,'succeeded',pageJob.last_error);assert.equal(uploads,1);
  const draft=db.prepare('SELECT * FROM article_drafts').get();
  assert.equal(evaluatePublicationEligibility(db,draft.id,{phase:'delivery'}).code,'ROUTE_REVIEW_MISSING_OR_STALE');
  assert.ok(db.prepare("SELECT 1 FROM jobs WHERE type='review_draft' AND status='queued'").get());
  assert.equal(calls.length,1);
  const pkg=repository.getDraftPackage(draft.id);
  const expected={revision:draft.revision,contentHash:draft.content_hash,routeHash:pkg.route_bundle.approved_route_hash,
    mediaDependencyHash:routeMediaDependencyHash(db,draft.id),pageDependencyHash:routePageDependencyHash(db,draft.id)};
  const reviewed=await boundaryEngine(calls).review(pkg);
  repository.saveReview(draft.id,{...reviewed.output,passed:true},reviewed.model,expected);
  assert.equal(evaluatePublicationEligibility(db,draft.id,{phase:'delivery'}).passed,true);
  const backup=createBackup({databasePath:path.join(directory,'test.sqlite'),backupDir:path.join(directory,'page-backups'),
    generatedMediaDir:repository.contentConfig.generatedMediaDir,retention:2});
  const restored=restoreBackup(backup.backupPath,path.join(directory,'page-restored'));
  assert.equal(restored.mode,'migration-review');
  const copy=new DatabaseSync(restored.databasePath,{readOnly:true});
  try {
    assert.equal(routePageDependencyHash(copy,draft.id),expected.pageDependencyHash);
    assert.equal(routeMediaDependencyHash(copy,draft.id),expected.mediaDependencyHash);
    assert.deepEqual(copy.prepare("SELECT * FROM route_artifacts WHERE artifact_kind IN ('page','text_review') ORDER BY id").all(),
      db.prepare("SELECT * FROM route_artifacts WHERE artifact_kind IN ('page','text_review') ORDER BY id").all());
    assert.equal(evaluatePublicationEligibility(copy,draft.id,{phase:'delivery'}).passed,true);
    assert.equal(copy.prepare("SELECT count(*) n FROM jobs WHERE status='running'").get().n,0);
  }finally{copy.close();}
  db.exec('SAVEPOINT page_receipt_checks');
  db.prepare("UPDATE frontend_page_compositions SET contract_checksum='changed-after-QA' WHERE draft_id=?").run(draft.id);
  assert.equal(evaluatePublicationEligibility(db,draft.id,{phase:'delivery'}).code,'ROUTE_REVIEW_MISSING_OR_STALE');
  assert.throws(()=>repository.saveReview(draft.id,{...reviewed.output,passed:true},reviewed.model,expected),{code:'ROUTE_VERSION_STALE'});
  // Even a new text receipt cannot bless a page lacking a current composition receipt.
  repository.saveReview(draft.id,{...reviewed.output,passed:true},reviewed.model,
    {...expected,pageDependencyHash:routePageDependencyHash(db,draft.id)});
  assert.equal(evaluatePublicationEligibility(db,draft.id,{phase:'delivery'}).code,'ROUTE_PAGE_MISSING_OR_STALE');
  db.exec('ROLLBACK TO page_receipt_checks; RELEASE page_receipt_checks');
  db.exec('SAVEPOINT late_page_check');
  // Remove only the prior stage cache to exercise an actual new composition,
  // not its successful-result reuse shortcut; restored by the savepoint below.
  db.prepare("DELETE FROM pipeline_artifacts WHERE entity_id=? AND stage='compose_frontend_page'").run(draft.id);
  const originalResolve=frontendContracts.resolveForArticle.bind(frontendContracts);
  const originalComplete=pipeline.contentEngine.client.completeJson;
  const savedPage=db.prepare('SELECT * FROM frontend_page_compositions WHERE draft_id=?').get(draft.id);
  let lateCalls=0;
  frontendContracts.resolveForArticle=(...args)=>{
    const result=originalResolve(...args);return {...result,components:result.components.filter(c=>c.id==='image')};
  };
  pipeline.contentEngine.client.completeJson=async request=>{
    assert.equal(request.name,'frontend_page_payload');lateCalls++;
    await Promise.resolve();
    db.prepare("UPDATE article_visuals SET caption='Concurrent media correction' WHERE draft_id=?").run(draft.id);
    return {model:'controlled-late-page',output:JSON.parse(savedPage.payload_json)};
  };
  repository.enqueue('compose_frontend_page',draft.id,{priority:1,dedupeKey:'late-page-media-race',pipelineVersion:'legacy',productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();
  assert.equal(lateCalls,1,JSON.stringify(db.prepare('SELECT type,status,last_error,pipeline_version FROM jobs').all()));
  const lateJob=db.prepare("SELECT * FROM jobs WHERE dedupe_key='late-page-media-race'").get();
  assert.equal(lateJob.status,'failed');
  assert.equal(lateJob.last_failure_code,'ROUTE_VERSION_STALE',lateJob.last_error);
  assert.deepEqual(db.prepare('SELECT * FROM frontend_page_compositions WHERE draft_id=?').get(draft.id),savedPage);
  frontendContracts.resolveForArticle=originalResolve;pipeline.contentEngine.client.completeJson=originalComplete;
  db.exec('ROLLBACK TO late_page_check; RELEASE late_page_check');
  const callCount=calls.length;
  db.prepare("UPDATE structured_sources SET summary='Changed in same capture' WHERE source_id=?").run(seed.source.id);
  await pipeline.runOne();
  assert.equal(calls.length,callCount,'stale source must be rejected before the reviewer call');
  assert.equal(db.prepare("SELECT last_failure_code FROM jobs WHERE type='review_draft'").get().last_failure_code,'ROUTE_VERSION_STALE');
  await assert.rejects(pipeline.uploadVisualMedia(repository.getDraftPackage(draft.id),{beforeTextReview:true}),{code:'ROUTE_VERSION_STALE'});
  assert.equal(uploads,2,'only the two current-route page attempts reach the controlled upload boundary');
});

test('real planning, writer and independent review carry frozen route; no route/SEO/diagram model calls',async t=>{
  const {repository,db,directory}=repositoryFixture(t);repository.contentConfig.generatedMediaDir=path.join(directory,'media');
  const seed=seedRouteProduction(repository);
  const research=repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId});
  assert.equal(research.route_bundle.status,'FROZEN');
  const calls=[],engine=boundaryEngine(calls);
  const result=await engine.articleBundle(research);
  const briefId=repository.saveBrief(seed.candidateId,result.output.brief,result.model,{deferDraft:true,opportunityId:seed.ownerId,routeBundle:research.route_bundle});
  const draftId=repository.saveDraft(briefId,result.output.draft,result.model,{deferReview:true,opportunityId:seed.ownerId,routeBundle:research.route_bundle});
  const pkg=repository.getDraftPackage(draftId);
  const review=await engine.review(pkg);
  repository.saveReview(draftId,review.output,review.model,{revision:pkg.draft.revision,contentHash:pkg.draft.content_hash,
    evidenceHash:pkg.evidence_hash,routeHash:pkg.route_bundle.approved_route_hash,productionOwnerOpportunityId:seed.ownerId});
  const artifact=await repository.ensureRouteSchematic(pkg.route_bundle);
  assert.equal(await repository.ensureRouteSchematic(pkg.route_bundle),artifact);
  assert.deepEqual(calls.map(x=>x.name),['article_bundle_v1','quality_review_v3']);
  assert.deepEqual(calls[0].input.route_bundle,calls[1].input.route_bundle);
  assert.match(calls[1].input.draft.body_markdown,/about 15 minutes/);
  assert.equal(db.prepare("SELECT count(*) n FROM route_artifacts WHERE artifact_kind='text_review'").get().n,1);
  await assert.rejects(engine.articleBundle({...research,route_bundle:{...research.route_bundle,status:'ROUTE_CONFLICT'}}),{code:'ROUTE_CONFLICT'});
  engine.client.completeJson=async()=>({output:{passed:true,checks:[],issues:[],unsupported_claims:[]}});
  await assert.rejects(engine.review(pkg),{code:'ROUTE_REVIEW_MISSING'});
  const changed=structuredClone(result.output.draft);changed.body_markdown=changed.body_markdown.replace('walk','taxi');
  assert.throws(()=>repository.saveDraft(briefId,changed,'bad',{routeBundle:pkg.route_bundle}),{code:'ROUTE_TEXT_MISMATCH'});
  const before=db.prepare('SELECT body_markdown FROM article_drafts WHERE id=?').get(draftId);
  db.exec('SAVEPOINT same_capture_change');
  db.prepare("UPDATE structured_sources SET summary='Different route evidence' WHERE source_id=?").run(seed.source.id);
  assert.throws(()=>repository.assertCurrentRoute(pkg.route_bundle),{code:'ROUTE_VERSION_STALE'});
  db.exec('ROLLBACK TO same_capture_change; RELEASE same_capture_change');
  db.exec('SAVEPOINT source_route_change');
  const changedFragment=structuredClone(seed.fragment);changedFragment.legs[0].mode='taxi';
  repository.saveExperienceExtraction(seed.source.id,{blocks:[],route_fragments:[changedFragment]},'controlled-source-repair',seed.input);
  assert.throws(()=>repository.assertCurrentRoute(pkg.route_bundle),{code:'ROUTE_VERSION_STALE'});
  db.exec('ROLLBACK TO source_route_change; RELEASE source_route_change');
  db.prepare('UPDATE sources SET capture_version=capture_version+1 WHERE id=?').run(seed.source.id);
  assert.throws(()=>repository.saveDraft(briefId,result.output.draft,'late',{routeBundle:pkg.route_bundle}),{code:'ROUTE_VERSION_STALE'});
  assert.deepEqual(db.prepare('SELECT body_markdown FROM article_drafts WHERE id=?').get(draftId),before);
  if(process.env.A2_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.A2_EVIDENCE_DIR,'request-trace.json'),JSON.stringify({calls,
    actualExternalRequests:0,mainRequests:1,independentReviews:1,diagramRequests:0,routeArtifactId:artifact},null,2));
});

test('actual Worker separates successful writing from local schematic media stage',async t=>{
  const {repository,db,directory}=repositoryFixture(t);repository.contentConfig.generatedMediaDir=path.join(directory,'media');
  const seed=seedRouteProduction(repository);
  // Remove only fixture capture prerequisite queue; do not manufacture successful jobs.
  db.prepare('DELETE FROM jobs').run();
  const calls=[],engine=boundaryEngine(calls);
  const pipeline=new Pipeline(repository,{enabled:false},{contentEngine:engine});
  repository.enqueue('plan_content',seed.candidateId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();
  const job=db.prepare("SELECT * FROM jobs WHERE type='plan_content'").get();
  assert.equal(job.status,'succeeded',job.last_error);
  assert.equal(db.prepare('SELECT count(*) n FROM article_drafts').get().n,1);
  assert.equal(db.prepare("SELECT count(*) n FROM route_artifacts WHERE artifact_kind='schematic'").get().n,0);
  const draft=db.prepare('SELECT * FROM article_drafts').get();
  // Review is queued first when no frontend composer is configured.
  await pipeline.runOne();
  await pipeline.runOne();
  const mediaJob=db.prepare("SELECT * FROM jobs WHERE type='generate_visuals'").get();
  assert.equal(mediaJob.status,'succeeded',mediaJob.last_error);
  assert.equal(db.prepare("SELECT count(*) n FROM route_artifacts WHERE artifact_kind='schematic'").get().n,1);
  const visual=repository.listDraftVisuals(draft.id).find(v=>v.acquisition_strategy==='render_route_schematic');
  assert.equal(visual.status,'generated');
  assert.equal(mediaManifestForDraft(db,draft.id).slots.find(s=>s.slotId===visual.id).factualImageRequired,false);
  assert.equal(evaluatePublicationEligibility(db,draft.id,{requireRouteReview:false}).passed,true);
  assert.deepEqual({...db.prepare('SELECT body_markdown,content_hash,revision FROM article_drafts WHERE id=?').get(draft.id)},
    {body_markdown:draft.body_markdown,content_hash:draft.content_hash,revision:draft.revision});
  assert.equal(calls.filter(c=>c.name==='article_bundle_v1').length,1);
  assert.equal(calls[0].input.route_bundle.status,'FROZEN');
  assert.ok(routeReadableMarkdown(calls[0].input.route_bundle).includes('East Hall'));
});

test('real Worker image-only recovery retains written draft, manifest and cumulative slot budget',async t=>{
  const {repository,db,directory}=repositoryFixture(t),seed=seedRouteProduction(repository,{requiredSchematic:true});
  db.prepare('DELETE FROM jobs').run();
  const calls=[],pipeline=new Pipeline(repository,{enabled:false},{contentEngine:boundaryEngine(calls)});
  repository.enqueue('plan_content',seed.candidateId,{priority:1,pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();
  const draft=db.prepare('SELECT id,body_markdown,content_hash,revision FROM article_drafts').get();
  await pipeline.runOne(); // real renderer lacks its output directory configuration
  const failed=db.prepare("SELECT * FROM jobs WHERE type='generate_visuals'").get();
  assert.equal(failed.status,'failed');assert.match(failed.last_error,/ROUTE_RENDER_STORAGE_MISSING/);
  assert.equal(explainOperationalFailure(failed).action.id,'generate_visuals');
  assert.match(explainOperationalFailure(failed).reason,/输出目录/);
  const visual=repository.listDraftVisuals(draft.id)[0];
  assert.equal(visual.attempt_count,1);
  assert.equal(visual.media_metadata.recovery_budget.deterministic_recovery,1);
  const manifest=mediaManifestForDraft(db,draft.id);
  repository.contentConfig.generatedMediaDir=path.join(directory,'repaired-media');
  const recovery=executeContentRecovery(repository,seed.ownerId,{action:'retry_failed_stage',revision:draft.revision,
    idempotencyKey:'image-only-recovery'},'local-test');
  assert.equal(recovery.resolvedStage,'generate_visuals');
  await pipeline.runOne();
  const recovered=repository.listDraftVisuals(draft.id)[0];
  assert.equal(recovered.status,'generated',JSON.stringify(db.prepare('SELECT type,status,last_error FROM jobs').all()));
  assert.equal(recovered.id,visual.id);assert.equal(recovered.attempt_count,1);
  assert.deepEqual(recovered.media_metadata.recovery_budget,visual.media_metadata.recovery_budget);
  assert.deepEqual(db.prepare('SELECT id,body_markdown,content_hash,revision FROM article_drafts').get(),draft);
  assert.deepEqual(mediaManifestForDraft(db,draft.id),manifest);
  assert.equal(calls.filter(c=>c.name==='article_bundle_v1').length,1);
  const artifacts=db.prepare("SELECT * FROM route_artifacts WHERE artifact_kind='schematic'").all();
  assert.equal(artifacts.length,1);
  repository.enqueue('generate_visuals',draft.id,{priority:1,dedupeKey:'image-idempotency',pipelineVersion:'article_bundle_v1',
    productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();
  assert.deepEqual(db.prepare("SELECT * FROM route_artifacts WHERE artifact_kind='schematic'").all(),artifacts);
  assert.equal(calls.filter(c=>c.name==='article_bundle_v1').length,1);
  fs.renameSync(recovered.media_path,`${recovered.media_path}.preserved-missing-test`);
  repository.enqueue('generate_visuals',draft.id,{priority:1,dedupeKey:'image-missing-file-recovery',pipelineVersion:'article_bundle_v1',
    productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();
  assert.equal(repository.listDraftVisuals(draft.id)[0].status,'generated');
  assert.deepEqual(fs.readFileSync(recovered.media_path),fs.readFileSync(`${recovered.media_path}.preserved-missing-test`));
  assert.deepEqual(db.prepare("SELECT * FROM route_artifacts WHERE artifact_kind='schematic'").all(),artifacts);
  const backup=createBackup({databasePath:path.join(directory,'test.sqlite'),backupDir:path.join(directory,'backups'),
    generatedMediaDir:repository.contentConfig.generatedMediaDir,retention:2});
  const restored=restoreBackup(backup.backupPath,path.join(directory,'restored'));
  assert.equal(restored.mode,'migration-review');
  const copy=new DatabaseSync(restored.databasePath,{readOnly:true});
  try {
    assert.deepEqual(mediaManifestForDraft(copy,draft.id),manifest);
    const restoredVisual=copy.prepare('SELECT * FROM article_visuals WHERE id=?').get(visual.id);
    assert.equal(restoredVisual.attempt_count,1);
    assert.deepEqual(JSON.parse(restoredVisual.media_metadata_json).recovery_budget,visual.media_metadata.recovery_budget);
    assert.equal(evaluatePublicationEligibility(copy,draft.id,{requireRouteReview:false}).passed,true);
    assert.equal(copy.prepare("SELECT count(*) n FROM jobs WHERE status='running'").get().n,0);
  } finally {copy.close();}
  db.prepare("UPDATE article_visuals SET caption='Wrong Day 2' WHERE id=?").run(visual.id);
  const gate=evaluatePublicationEligibility(db,draft.id,{requireRouteReview:false});
  assert.equal(gate.passed,false);assert.ok(gate.missing.some(m=>m.reasons?.includes('route_render_receipt_missing_or_stale')));
});

test('mixed media image-only recovery keeps the completed source photo bytes and receipt intact',async t=>{
  t.after(closeLocalPhotoAudit);
  const {repository,db,directory}=repositoryFixture(t);
  const pixels=Buffer.alloc(1200*800*3);
  for(let i=0;i<pixels.length;i++)pixels[i]=(i*59+(i>>6)*37+17)&255;
  const bytes=await sharp(pixels,{raw:{width:1200,height:800,channels:3}}).png().toBuffer();
  const seed=seedRouteProduction(repository,{requiredSchematic:true,images:[{url:'https://ci.xhscdn.com/route-photo.png',
    alt:'East Hall',originalDataUrl:`data:image/png;base64,${bytes.toString('base64')}`,
    originalSha256:createHash('sha256').update(bytes).digest('hex')}]});
  const asset=repository.getSource(seed.source.id).assets[0];
  repository.saveSourceAssetAnalysis(asset.id,{analysis_status:'ready',asset_kind:'documentary_photo',primary_subjects:['East Hall'],
    text_regions:[],photo_regions:[],entities:['East Hall'],reader_text_present:false,confidence:0.95,analysis_version:'fixture'});
  repository.saveLocalPhotoAudit(asset.id,await auditSourcePhoto(asset.local_path));
  repository.refreshSourceMediaBindings(seed.source.id,{dryRun:false});
  const input=repository.getExperienceExtractionPackage(seed.source.id);
  repository.saveExperienceExtraction(seed.source.id,{blocks:[],route_fragments:[seed.fragment]},'controlled-source',input);
  db.prepare('DELETE FROM jobs').run();
  const calls=[],pipeline=new Pipeline(repository,{enabled:false},{contentEngine:boundaryEngine(calls)});
  repository.enqueue('plan_content',seed.candidateId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();await pipeline.runOne();
  const draft=db.prepare('SELECT id,body_markdown,content_hash,revision FROM article_drafts').get();
  const before=repository.listDraftVisuals(draft.id);
  const photo=before.find(v=>v.source_asset_id===asset.id),route=before.find(v=>v.acquisition_strategy==='render_route_schematic');
  assert.equal(photo?.status,'generated',JSON.stringify(before));assert.equal(route.status,'failed');
  const savedPhoto=db.prepare('SELECT * FROM article_visuals WHERE id=?').get(photo.id);
  const manifest=mediaManifestForDraft(db,draft.id);
  repository.contentConfig.generatedMediaDir=path.join(directory,'repaired-media');
  executeContentRecovery(repository,seed.ownerId,{action:'retry_failed_stage',revision:draft.revision,idempotencyKey:'mixed-recovery'});
  await pipeline.runOne();
  assert.equal(repository.listDraftVisuals(draft.id).find(v=>v.id===route.id).status,'generated');
  const afterPhoto=db.prepare('SELECT * FROM article_visuals WHERE id=?').get(photo.id);
  assert.deepEqual({...afterPhoto,updated_at:savedPhoto.updated_at},{...savedPhoto});
  assert.deepEqual(fs.readFileSync(asset.local_path),bytes);
  assert.deepEqual(mediaManifestForDraft(db,draft.id),manifest);
  assert.deepEqual(db.prepare('SELECT id,body_markdown,content_hash,revision FROM article_drafts').get(),draft);
  assert.equal(calls.length,1);
});

test('actual Worker blocks itinerary without source fragments before a writer/model call',async t=>{
  const {repository,db}=repositoryFixture(t);const seed=seedRouteProduction(repository);
  db.prepare("UPDATE experience_extraction_runs SET route_fragments_json='[]'").run();
  db.prepare('DELETE FROM jobs').run();
  const calls=[],engine=boundaryEngine(calls);
  const pipeline=new Pipeline(repository,{enabled:false},{contentEngine:engine});
  repository.enqueue('plan_content',seed.candidateId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();
  const job=db.prepare("SELECT status,last_error FROM jobs WHERE type='plan_content'").get();
  assert.equal(job.status,'failed');assert.match(job.last_error,/ROUTE_EVIDENCE_PENDING/);
  assert.equal(calls.length,0);assert.equal(db.prepare('SELECT count(*) n FROM article_drafts').get().n,0);
});

test('new recovery jobs cannot reset the local route render budget',async t=>{
  const {repository,db,directory}=repositoryFixture(t),seed=seedRouteProduction(repository,{requiredSchematic:true});
  db.prepare('DELETE FROM jobs').run();
  const calls=[],pipeline=new Pipeline(repository,{enabled:false},{contentEngine:boundaryEngine(calls)});
  repository.enqueue('plan_content',seed.candidateId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:seed.ownerId});
  await pipeline.runOne();await pipeline.runOne();
  const draft=db.prepare('SELECT id,content_hash,revision FROM article_drafts').get();
  for(let attempt=2;attempt<=3;attempt++) {
    executeContentRecovery(repository,seed.ownerId,{action:'retry_failed_stage',revision:draft.revision,idempotencyKey:`render-attempt-${attempt}`});
    await pipeline.runOne();
    const visual=repository.listDraftVisuals(draft.id)[0];
    assert.equal(visual.attempt_count,attempt);assert.equal(visual.media_metadata.recovery_budget.deterministic_recovery,attempt);
  }
  repository.contentConfig.generatedMediaDir=path.join(directory,'late-config');
  executeContentRecovery(repository,seed.ownerId,{action:'retry_failed_stage',revision:draft.revision,idempotencyKey:'beyond-budget'});
  await pipeline.runOne();
  const visual=repository.listDraftVisuals(draft.id)[0];
  assert.equal(visual.attempt_count,3);assert.equal(visual.media_metadata.recovery_budget.deterministic_recovery,3);
  assert.equal(visual.status,'failed');
  assert.equal(db.prepare("SELECT count(*) n FROM route_artifacts WHERE artifact_kind='schematic'").get().n,0);
  assert.ok(db.prepare("SELECT 1 FROM jobs WHERE last_failure_code='ROUTE_RENDER_BUDGET_EXHAUSTED'").get());
  assert.deepEqual(db.prepare('SELECT id,content_hash,revision FROM article_drafts').get(),draft);
  assert.equal(calls.length,1);
});

test('two actual source extractions retain scoped field conflict and block Worker before writing',async t=>{
  const {repository,db}=repositoryFixture(t),first=seedRouteProduction(repository);
  const second=seedRouteProduction(repository,{sourceSuffix:'a2RouteSecond',sourceOnly:true,transportMode:'taxi'});
  assert.notEqual(first.source.id,second.source.id);
  const seeds=[first,second],calls=[];
  const extractor=new ContentEngine({apiKey:'unused',model:'fixture'});
  for(const seed of seeds) {
    const input=repository.getExperienceExtractionPackage(seed.source.id);
    for(const collection of ['days','stops','legs'])for(const item of seed.fragment[collection])item.evidence_span_ids=[input.evidence_spans[0].id];
    seed.fragment.legs[0].field_evidence=[{field:'mode',value:seed.fragment.legs[0].mode,applies_to:'weekday morning route',
      approximate:false,status:'source_assertion',evidence_span_ids:[input.evidence_spans[0].id]}];
    extractor.client={enabled:true,async completeJson(request){
      assert.equal(request.name,'experience_extraction');
      const fieldSchema=request.schema.properties.route_fragments.items.properties.legs.items.properties.field_evidence.items;
      assert.ok(fieldSchema.properties.value);assert.ok(fieldSchema.properties.status.enum.includes('unknown'));
      return {model:'controlled-source-boundary',output:{blocks:[],route_fragments:[seed.fragment]}};
    }};
    const extracted=await extractor.analyzeExperience(input);
    repository.saveExperienceExtraction(seed.source.id,extracted.output,extracted.model,input);
    seed.currentInput=input;
  }
  const assembly=repository.saveEditorialAssembly(first.candidateId,{selected_source_ids:seeds.map(s=>s.source.id),
    selected_fact_keys:[],selected_experience_block_ids:[],selected_blueprint_source_ids:[],exclusions:[],rationale:'explicit composition'},
    'controlled-selection',null,{opportunityId:first.ownerId});
  assert.ok(assembly.selected_source_ids.length>0);
  const fragments=seeds.flatMap(seed=>normalizeRouteFragments([seed.fragment],seed.currentInput));
  const scope={mode:'evidence_composed_route',fragment_ids:fragments.map(f=>f.fragment_id),
    days:fragments.map((f,i)=>({source_day_id:f.days[0].day_id,label:`Day ${i+1}`,stop_ids:f.stops.map(s=>s.stop_id),leg_ids:f.legs.map(l=>l.leg_id)}))};
  const coverage=JSON.parse(db.prepare('SELECT coverage_json FROM content_opportunities WHERE id=?').get(first.ownerId).coverage_json);
  coverage.approval.proposal.route_scope=scope;
  db.prepare('UPDATE content_opportunities SET coverage_json=? WHERE id=?').run(JSON.stringify(coverage),first.ownerId);
  assert.equal(repository.currentRouteFragments(repository.getTopicPackage(first.candidateId,{opportunityId:first.ownerId})).length,2);
  db.prepare('DELETE FROM jobs').run();
  const pipeline=new Pipeline(repository,{enabled:false},{contentEngine:boundaryEngine(calls)});
  repository.enqueue('plan_content',first.candidateId,{pipelineVersion:'article_bundle_v1',productionOwnerOpportunityId:first.ownerId});
  await pipeline.runOne();
  const job=db.prepare("SELECT * FROM jobs WHERE type='plan_content'").get();
  assert.equal(job.last_failure_code,'ROUTE_CONFLICT',job.last_error);assert.equal(calls.length,0);
  assert.equal(db.prepare('SELECT count(*) n FROM article_drafts').get().n,0);
  assert.ok(fragments.every(f=>f.legs[0].field_evidence[0].value===f.legs[0].mode));
});

test('actual planning consumes stored composition scope and excludes old extraction inputs',async t=>{
  const {repository,db}=repositoryFixture(t),seed=seedRouteProduction(repository);
  const second=structuredClone(seed.fragment);second.occurrence_key='second-explicit-route';
  repository.saveExperienceExtraction(seed.source.id,{blocks:[],route_fragments:[seed.fragment,second]},'controlled-source',seed.input);
  const fragments=normalizeRouteFragments([seed.fragment,second],seed.input);
  const scope={mode:'evidence_composed_route',day_count:2,fragment_ids:fragments.map(f=>f.fragment_id),
    days:fragments.map((f,i)=>({source_day_id:f.days[0].day_id,label:`Day ${i+1}`,
      stop_ids:f.stops.map(s=>s.stop_id),leg_ids:f.legs.map(l=>l.leg_id)}))};
  const coverage=JSON.parse(db.prepare('SELECT coverage_json FROM content_opportunities WHERE id=?').get(seed.ownerId).coverage_json);
  coverage.approval.proposal.route_scope=scope;
  db.prepare('UPDATE content_opportunities SET coverage_json=? WHERE id=?').run(JSON.stringify(coverage),seed.ownerId);
  const research=repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId});
  assert.equal(research.route_bundle.mode,'evidence_composed_route');assert.equal(research.route_bundle.days.length,2);
  const calls=[],engine=boundaryEngine(calls);await engine.articleBundle(research);
  assert.equal(calls.length,1);assert.equal(calls[0].input.route_bundle.stops.length,6);
  assert.match(calls[0].input.approved_route_table,/Day 2/);
  db.prepare("UPDATE structured_sources SET summary='changed evidence' WHERE source_id=?").run(seed.source.id);
  assert.throws(()=>repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId}),{code:'ROUTE_EVIDENCE_PENDING'});
});

test('route visual late results are rejected and changing a plan preserves its cumulative slot recovery budget',async t=>{
  const {repository,db}=repositoryFixture(t),seed=seedRouteProduction(repository);
  const research=repository.getPlanningPackage(seed.candidateId,{opportunityId:seed.ownerId});
  const result=await boundaryEngine([]).articleBundle(research);
  const brief=repository.saveBrief(seed.candidateId,result.output.brief,result.model,{deferDraft:true,opportunityId:seed.ownerId,routeBundle:research.route_bundle});
  const draft=repository.saveDraft(brief,result.output.draft,result.model,{deferReview:true,opportunityId:seed.ownerId,routeBundle:research.route_bundle});
  const visual={placement:'mid_article',purpose:'Route',alt_text:'Route',caption:'Route',generation_prompt:'',aspect_ratio:'3:2',
    image_type:'map_or_route',image_role:'support',image_subject:'Route',acquisition_strategy:'recompose_map_or_route',
    factual_image_required:true,status:'planned',media_metadata:{route_contract:{route_id:research.route_bundle.route_id,
      revision:research.route_bundle.revision,approved_route_hash:research.route_bundle.approved_route_hash}}};
  repository.replaceDraftVisuals(draft,[visual],'3.9');
  const row=repository.listDraftVisuals(draft)[0];
  repository.failVisual(row.id,Object.assign(new Error('bounded revision'),{code:'VISUAL_QUALITY_QA_FAILED',retryable:true}));
  repository.replaceDraftVisuals(draft,[{...visual,aspect_ratio:'4:3'}],'3.9');
  const changed=repository.listDraftVisuals(draft)[0];
  assert.equal(changed.id,row.id);assert.equal(changed.attempt_count,1);
  assert.equal(changed.media_metadata.recovery_budget.visual_revision,1);
  assert.throws(()=>repository.saveGeneratedVisual(row.id,{metadata:{}}),{code:'ROUTE_VISUAL_QA_FAILED'});
  db.prepare('UPDATE sources SET capture_version=capture_version+1 WHERE id=?').run(seed.source.id);
  assert.throws(()=>repository.saveGeneratedVisual(row.id,{metadata:{quality_qa:{semantic:{route_audit:{checked:true,passed:true,
    differences:[],approved_route_hash:research.route_bundle.approved_route_hash}}}}}),{code:'ROUTE_VERSION_STALE'});
  assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
});
