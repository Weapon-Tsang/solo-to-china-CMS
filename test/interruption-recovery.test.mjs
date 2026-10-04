import test from 'node:test';
import assert from 'node:assert/strict';
import {splitExperiencePackage,extractExperienceWithRecovery,mergeExperienceParts} from '../src/experience-recovery.mjs';
import {blockingMediaDispatchSql,createMediaRequestExecutor} from '../src/media-request-executor.mjs';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {normalizeVisuals} from '../src/repository.mjs';
import {compactExperienceReferences,validateExperienceReferences} from '../src/ai/experience-references.mjs';
import {normalizeXiaohongshuCapture} from '../src/adapters/xiaohongshu.mjs';

const pack=(n=8)=>({source:{id:'source',capture_version:2},segments:[{id:'panel',asset_id:'image'}],
  claims:Array.from({length:n},(_,i)=>({id:`claim${i}`,evidence_span_ids:[`span${i}`]})),
  evidence_spans:Array.from({length:n},(_,i)=>({id:`span${i}`,segment_id:'panel',asset_id:'image'})),media:[{id:'image'}]});
test('Experience rejects shortened or foreign evidence IDs before caching model output',()=>{
  const wire=compactExperienceReferences(pack());
  const valid={blocks:[{segment_ids:[wire.input.segments[0].id],supporting_claim_ids:[wire.input.claims[0].id],
    evidence_span_ids:[wire.input.evidence_spans[0].id]}]};
  assert.equal(validateExperienceReferences(valid,wire.input),valid);
  assert.throws(()=>validateExperienceReferences({blocks:[{...valid.blocks[0],supporting_claim_ids:['claim-shortened']}]},wire.input),
    {code:'EXPERIENCE_REFERENCE_INVALID',retryable:false});
  assert.equal(wire.restore(valid).blocks[0].supporting_claim_ids[0],'claim0');
});
test('Experience partitions preserve every claim and anchor, including orphan and cross-panel evidence',()=>{
  const p=pack();p.segments.push({id:'extra',asset_id:'extra-image'});p.media.push({id:'extra-image'});
  p.evidence_spans.push({id:'orphan',segment_id:'missing'});p.claims[0].evidence_span_ids.push('orphan');
  p.claims[7].evidence_span_ids.push('span0');
  const parts=splitExperiencePackage(p);
  assert.deepEqual(parts.flatMap(x=>x.claims).map(c=>c.id).sort(),p.claims.map(c=>c.id).sort());
  for(const part of parts)for(const c of part.claims)for(const span of c.evidence_span_ids)
    assert.ok(part.evidence_spans.some(s=>s.id===span));
  for(const field of ['segments','evidence_spans','media'])assert.deepEqual(
    [...new Set(parts.flatMap(p=>p[field]).map(x=>x.id))].sort(),p[field].map(x=>x.id).sort());
  assert.ok(parts.every(x=>x.claims.length<p.claims.length));
});
test('an indivisible cross-panel claim never multiplies identical paid inputs',()=>{
  const p=pack(1);p.segments.push({id:'panel2',asset_id:'image2'});
  p.media.push({id:'image2'});p.evidence_spans.push({id:'span2',segment_id:'panel2',asset_id:'image2'});
  p.claims[0].evidence_span_ids.push('span2');
  assert.equal(splitExperiencePackage(p),null);
  p.claims[0].evidence_span_ids=['orphan'];p.evidence_spans.push({id:'orphan',segment_id:'missing'});
  assert.equal(splitExperiencePackage(p),null,'unclaimed context is retained; an unchanged partition must run once');
});
test('completed Experience children and overflow decisions survive a later child failure',async()=>{
  const receipts=new Map(),calls=[];let crash=true;
  const options={runStep:async(k,_input,fn)=>{if(receipts.has(k))return receipts.get(k);const v=await fn();receipts.set(k,v);return v;},
    analyze:async(input)=>{calls.push(input.claims.map(c=>c.id));
      if(input.claims.length>4)throw Object.assign(new Error('overflow'),{code:'MODEL_OUTPUT_LIMIT'});
      if(input.claims[0].id==='claim4'&&crash){crash=false;throw new Error('transport');}
      return {model:'test',output:{blocks:[{title:input.claims[0].id}],route_fragments:[]}};}};
  await assert.rejects(extractExperienceWithRecovery(pack(),options),/transport/);
  const result=await extractExperienceWithRecovery(pack(),options);
  assert.equal(result.output.blocks.length,2);assert.equal(calls.length,4);
  assert.equal(calls.filter(x=>x.length===8).length,1);
  assert.equal(calls.filter(x=>x[0]==='claim0'&&x.length===4).length,1);
});
test('large sources partition before a paid request, have a bounded tree and never split provider billing failures',async()=>{
  let calls=0;const options={runStep:(_k,_p,fn)=>fn(),analyze:async p=>{calls++;assert.ok(p.claims.length<=120);return {output:{blocks:[]}};}};
  await extractExperienceWithRecovery(pack(263),options);assert.equal(calls,4);
  calls=0;
  await assert.rejects(extractExperienceWithRecovery(pack(),{...options,analyze:async()=>{calls++;throw Object.assign(new Error('overflow'),{code:'MODEL_OUTPUT_LIMIT'});}}),{code:'MODEL_OUTPUT_LIMIT'});
  assert.equal(calls,4,'depth bound stops the first unrecoverable leaf');
  calls=0;
  await assert.rejects(extractExperienceWithRecovery(pack(),{...options,analyze:async()=>{calls++;throw Object.assign(new Error('billing'),{status:402});}}),{status:402});
  assert.equal(calls,1);
});
test('route fragment merge namespaces internal references and preserves source evidence ids',()=>{
  const part={output:{blocks:[],route_fragments:[{occurrence_key:'route',days:[{key:'day'}],stops:[{key:'stop',day_key:'day',evidence_span_ids:['span']}],legs:[{key:'leg',from_key:'stop',to_key:'stop'}]}]}};
  const result=mergeExperienceParts([part]);const route=result.output.route_fragments[0];
  assert.equal(route.stops[0].key,'p1:stop');assert.equal(route.stops[0].day_key,'p1:day');
  assert.equal(route.legs[0].from_key,'p1:stop');assert.deepEqual(route.stops[0].evidence_span_ids,['span']);
});
test('the recovery guard permits finished recognition but still blocks QA, generation and crashed recognition',t=>{
  const {db}=repositoryFixture(t);
  const insert=db.prepare(`INSERT INTO media_dispatches(id,scope_key,visual_id,substage,started_at_ms,state,completed_at_ms,created_at)
    VALUES (?,'scope','visual',?,1,'outcome_unknown',?,'now')`);
  insert.run('finished','analyze_source_image',2);insert.run('crashed','analyze_source_image',null);
  insert.run('generation','generate_visual',2);insert.run('qa','visual_quality_qa',2);
  const read=()=>db.prepare(`SELECT md.id FROM media_dispatches md WHERE ${blockingMediaDispatchSql()} ORDER BY md.id`).all().map(r=>r.id);
  assert.deepEqual(read(),['crashed','generation','qa']);
  db.prepare("UPDATE media_visual_lane SET owner_token='finished' WHERE id=1").run();
  assert.deepEqual(read(),['crashed','finished','generation','qa']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM media_dispatches').get().n,4,'budget ledger is preserved');
});
test('source recognition timeout is recorded as failed immediately',t=>{
  const {db}=repositoryFixture(t),executor=createMediaRequestExecutor(db);
  const permit=executor.acquire({visualId:'photo',substage:'analyze_source_image',provider:'vertex',model:'test'});
  assert.equal(permit.finish({error:{code:'TIMEOUT'}}),'failed');
  assert.equal(executor.budget({visualId:'photo',substage:'analyze_source_image'}).spent,1);
});
test('source Experience failures are visible, active recovery replaces them, and old captures cannot leak',t=>{
  const {db,repository}=repositoryFixture(t);
  const source=repository.saveCapture(normalizeXiaohongshuCapture({
    url:'https://www.xiaohongshu.com/explore/111111111111111111111111',title:'Experience status regression',
    text:'A complete travel note for checking Experience failure and recovery status.',images:[]}));
  db.prepare("UPDATE sources SET status='processed' WHERE id=?").run(source.id);
  const jobId=repository.enqueue('extract_source_experience',source.id);
  db.prepare("UPDATE jobs SET status='failed',last_failure_code='MODEL_OUTPUT_LIMIT' WHERE id=?").run(jobId);
  const read=()=>repository.listSources(1,{ids:[source.id]})[0];
  assert.equal(read().experience_status,'failed');assert.equal(read().experience_error,'MODEL_OUTPUT_LIMIT');
  assert.equal(repository.listSourceStatusProjection({ids:[source.id]})[0].experience_status,'failed');
  db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(jobId);
  assert.equal(read().experience_status,'queued');assert.equal(read().experience_error,null);
  db.prepare("UPDATE jobs SET created_at='2000-01-01',status='failed' WHERE id=?").run(jobId);
  assert.equal(read().experience_status,null);
});
const photo={id:'hall',asset_kind:'documentary_photo',analysis_status:'ready',language_status:'no_text',
  original_sha256:'bytes',local_photo_audit:{status:'eligible',sha256:'bytes'},
  primary_subjects:['traditional circular pavilion','stone balustrade','Great Hall of the People'],
  entities:["Chongqing People's Auditorium"],text_regions:[],mime_type:'image/webp',
  durability_status:'ORIGINAL_STORED',original_bytes_status:'saved_original'};
test('a long visual purpose cannot conceal a verified matching original from a required slot',()=>{
  const results=normalizeVisuals([{image_type:'real_world_photo',image_subject:"Chongqing People's Auditorium exterior architecture",
    purpose:'Show the traditional circular rotunda with green glazed tiled roof red columns and stone balustrade.',required_in_article:true}],
    {title:"Chongqing People's Great Hall",strategy_version:'3.9'},{destination_slug:'chongqing'},[photo],{visuals:{maximum:1}});
  assert.equal(results[0].source_asset_id,'hall');assert.equal(results[0].status,'generated');
  assert.equal(results[0].media_metadata.required_visual_gap,null);
});
test('automatic paid itinerary fallback is retired while explicit editorial requirements remain visible',()=>{
  const card={image_type:'map_or_route',image_subject:'Chongqing three day map',source_asset_id:'card',acquisition_strategy:'recompose_map_or_route',
    media_metadata:{authorized_asset_match:{version:'visual-match-2',mode:'article_fallback',score:0.9}}};
  const draft={title:'Chongqing walk',strategy_version:'3.9'};
  assert.deepEqual(normalizeVisuals([card],draft,{},[],{}),[]);
  const required=normalizeVisuals([{...card,required_in_article:true}],draft,{},[],{});
  assert.equal(required[0].media_metadata.required_visual_obligation.required,true);
  assert.equal(required[0].status,'failed','an explicit required map must never silently disappear');
});
