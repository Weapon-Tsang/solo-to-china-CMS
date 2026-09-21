import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {createMediaRequestExecutor} from '../src/media-request-executor.mjs';
import {Pipeline} from '../src/pipeline.mjs';
import {evaluatePublicationEligibility} from '../src/publication-eligibility.mjs';

test('exhausted image step resumes only missing visual after an explicit durable grant',async t=>{
  const {db,repository,directory}=repositoryFixture(t);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('media-topic','beijing','media','Media replay','fixture',80,0,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,
    readiness_score,readiness_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES ('media-owner','beijing','media','3.8','media-topic','Media replay',100,'{"ready":true}',
      'producing','now','now','now','producing')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
    VALUES ('media-brief','beijing','Media','[]','informational','drafted','now','now','media-topic')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
    VALUES ('media-draft','media-brief','Media replay','media-replay','Preserved evidence-led body.','{}',
      'drafted','now','now',1,'frozen-body-hash')`).run();
  repository.replaceDraftVisuals('media-draft',[1,2].map(slot=>({placement:slot===1?'hero':'mid_article',
    purpose:`Illustration ${slot}`,alt_text:`Illustration ${slot}`,caption:'',generation_prompt:'Travel scene',
    aspect_ratio:'16:9',image_type:'illustration',image_role:slot===1?'hero':'support',
    image_subject:'Travel scene',acquisition_strategy:'generate_illustration',factual_image_required:false,
    required_in_article:true,media_metadata:{required_visual_obligation:{required:true}},status:'planned'})),'3.8');
  repository.ensureAuthorizedSourceVisuals=()=>repository.listDraftVisuals('media-draft');
  repository.prepareMediaRepair=()=>repository.listDraftVisuals('media-draft');
  let time=100_000;
  let recovered=false;
  const executor=createMediaRequestExecutor(db,{maxDispatches:2,rpm:2,clock:()=>time});
  let activeExecutor=executor;
  const calls=[];
  const visuals={enabled:true,async generate(visual){
    calls.push(visual.slot);
    if (visual.slot===2) {
      const permit=activeExecutor.acquire({provider:'vertex',model:'image-model',accountScope:'project',
        visualId:visual.id,substage:'generate_visual'});
      if (!recovered) {
        const error=Object.assign(new Error('429 capacity'),{code:'RESOURCE_EXHAUSTED',status:429,retryable:true});
        permit.finish({error,responseReceived:true});
        throw error;
      }
      permit.finish();
    }
    const mediaPath=path.join(directory,`visual-${visual.slot}.png`);
    const bytes=Buffer.from(`fixture-${visual.slot}`);
    fs.writeFileSync(mediaPath,bytes);
    const hash=createHash('sha256').update(bytes).digest('hex');
    return {mediaPath,mediaUrl:`https://example.test/visual-${visual.slot}.png`,provider:'mock',model:'offline',
      metadata:{binary_qa:{status:'passed',sha256:hash},quality_qa:{status:'passed',file_hash:hash}}};
  }};
  const pipeline=new Pipeline(repository,{config:{}},{visuals});
  const firstJob=repository.enqueue('generate_visuals','media-draft',{
    dedupeKey:'media-exhaustion',productionOwnerOpportunityId:'media-owner'});
  for (let attempt=0;attempt<3;attempt++) {
    assert.equal(await pipeline.runOne(),false,JSON.stringify({attempt,calls,
      job:db.prepare('SELECT status,last_failure_code FROM jobs WHERE id=?').get(firstJob),
      visuals:db.prepare("SELECT slot,status FROM article_visuals WHERE draft_id='media-draft'").all()}));
    time+=180_000;
    repository.visualBackoffUntil=0;
    db.prepare("UPDATE jobs SET available_at='2000-01-01',next_eligible_at='2000-01-01' WHERE id=? AND status='queued'").run(firstJob);
    db.prepare("UPDATE article_visuals SET retry_at=NULL WHERE draft_id='media-draft' AND status='planned'").run();
  }
  assert.equal(db.prepare('SELECT last_failure_code FROM jobs WHERE id=?').get(firstJob).last_failure_code,
    'MEDIA_BUDGET_EXHAUSTED');
  const saved=db.prepare("SELECT id,media_path FROM article_visuals WHERE draft_id='media-draft' AND slot=1").get();
  const firstHash=createHash('sha256').update(fs.readFileSync(saved.media_path)).digest('hex');
  assert.equal(db.prepare("SELECT status FROM article_drafts WHERE id='media-draft'").get().status,'needs_review');
  assert.equal(evaluatePublicationEligibility(db,'media-draft').code,'MEDIA_INCOMPLETE');
  assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='media-draft'").get().body_markdown,
    'Preserved evidence-led body.');
  const missing=db.prepare("SELECT id FROM article_visuals WHERE draft_id='media-draft' AND slot=2").get();
  assert.deepEqual([executor.budget({visualId:missing.id,substage:'generate_visual'}).spent,
    executor.budget({visualId:missing.id,substage:'generate_visual'}).limit],[2,2]);
  executor.grant({visualId:missing.id,substage:'generate_visual',additionalDispatches:1,
    actor:'editor',reason:'429 recovery reviewed',idempotencyKey:'resume-missing-image'});
  recovered=true;
  const restart=createMediaRequestExecutor(db,{maxDispatches:2,rpm:2,clock:()=>time});
  activeExecutor=restart;
  assert.equal(restart.budget({visualId:missing.id,substage:'generate_visual'}).limit,3);
  repository.enqueue('generate_visuals','media-draft',{
    dedupeKey:'manual-grant-recovery',productionOwnerOpportunityId:'media-owner'});
  assert.equal(await pipeline.runOne(),true);
  assert.equal(db.prepare("SELECT status FROM article_visuals WHERE id=?").get(missing.id).status,'generated');
  assert.equal(evaluatePublicationEligibility(db,'media-draft').passed,true);
  assert.equal(restart.budget({visualId:missing.id,substage:'generate_visual'}).spent,3);
  assert.equal(db.prepare("SELECT media_path FROM article_visuals WHERE id=?").get(saved.id).media_path,saved.media_path);
  assert.equal(createHash('sha256').update(fs.readFileSync(saved.media_path)).digest('hex'),firstHash);
  assert.equal(calls.filter(slot=>slot===1).length,1);
  assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='media-draft'").get().body_markdown,
    'Preserved evidence-led body.');
});

test('a visual Job cannot succeed while a required planned slot remains unfinished',async t=>{
  const {db,repository}=repositoryFixture(t);
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,
    evidence_count,conflict_count,status,created_at,updated_at)
    VALUES ('topic','beijing','media','Media replay','fixture',80,0,0,'drafted','now','now')`).run();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,
    readiness_score,readiness_json,status,approved_at,created_at,updated_at,lifecycle_state)
    VALUES ('owner','beijing','media','3.9','topic','Media replay',100,'{"ready":true}',
      'producing','now','now','now','producing')`).run();
  db.prepare(`INSERT INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,
    updated_at,candidate_id) VALUES ('brief','beijing','Media','[]','informational','drafted','now','now','topic')`).run();
  db.prepare(`INSERT INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,
    created_at,updated_at,revision,content_hash) VALUES ('draft','brief','Media','media','Preserved body','{}',
    'drafted','now','now',1,'body-hash')`).run();
  repository.replaceDraftVisuals('draft',[{placement:'hero',purpose:'Required guide illustration',
    alt_text:'Guide illustration',caption:'',generation_prompt:'Travel scene',aspect_ratio:'16:9',
    image_type:'illustration',image_role:'hero',image_subject:'Travel scene',
    acquisition_strategy:'generate_illustration',factual_image_required:false,required_in_article:true,
    media_metadata:{required_visual_obligation:{required:true}},status:'planned'}],'3.9');
  repository.ensureAuthorizedSourceVisuals=()=>repository.listDraftVisuals('draft');
  repository.plannedVisuals=()=>[]; // Reproduces a transient or stale stage selection.
  const pipeline=new Pipeline(repository,{config:{}},{visuals:{enabled:true,
    async generate(){throw new Error('The missing visual must not be fabricated.');}}});
  const jobId=repository.enqueue('generate_visuals','draft',{
    dedupeKey:'missing-required-slot',productionOwnerOpportunityId:'owner'});
  assert.equal(await pipeline.runOne(),false);
  const job=db.prepare('SELECT status,last_failure_code FROM jobs WHERE id=?').get(jobId);
  assert.equal(job.status,'failed');
  assert.equal(job.last_failure_code,'MEDIA_INCOMPLETE');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE type='compose_frontend_page'").get().n,0);
  assert.equal(db.prepare("SELECT status FROM article_drafts WHERE id='draft'").get().status,'needs_review');
  assert.equal(db.prepare("SELECT body_markdown FROM article_drafts WHERE id='draft'").get().body_markdown,'Preserved body');
});
