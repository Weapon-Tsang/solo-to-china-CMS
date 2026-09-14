import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncSemaphore } from '../extension/sync-core.js';
import { CaptureMediaUploadManager } from '../src/capture-media-upload.mjs';
import { ContentEngine } from '../src/ai/content-engine.mjs';
import { boundedNarrativePackage, NARRATIVE_INPUT_BUDGET } from '../src/repository.mjs';
import { png } from '../test-support/media-fixtures.mjs';
import { DerivativeCache } from '../extension/derivative-cache.js';
import { indexedDB } from 'fake-indexeddb';

test('small work bypasses a blocked large reservation; resizing and cancellation release waiting budgets',async()=>{
  const pool=new AsyncSemaphore(10,{maxBypasses:2});const active=await pool.acquire(6);
  const large=pool.acquire(6);const small=await pool.acquire(4);assert.equal(pool.active,10);
  small();active();const releaseLarge=await large;assert.equal(pool.active,6);
  const queued=pool.acquire(6);const rejected=assert.rejects(queued,{code:'MEDIA_MEMORY_BUDGET_CHANGED'});
  pool.setLimit(4);await rejected;releaseLarge();assert.equal(pool.active,0);
  const held=await pool.acquire(4);const controller=new AbortController();
  const cancelled=pool.acquire(1,controller.signal);controller.abort();await assert.rejects(cancelled);held();
  assert.equal(pool.waiters.length,0);const last=await pool.acquire(4);last();assert.equal(pool.active,0);
});

test('derived media cache separates original hashes, transform parameters and converter versions and evicts only cached derivatives',async()=>{
  const cache=new DerivativeCache({name:'cache-budget-fixture',maxBytes:100,factory:indexedDB});
  const transform={converterVersion:'v1',width:2048};
  const key=cache.key('original-a',transform);
  assert.equal(key,cache.key('original-a',{width:2048,converterVersion:'v1'}));
  assert.notEqual(key,cache.key('original-a',{...transform,converterVersion:'v2'}));
  assert.notEqual(key,cache.key('original-b',transform));
  await cache.save(key,{bytes:new Uint8Array(80),sha256:'fixture'});
  assert.equal((await new DerivativeCache({name:cache.name,maxBytes:100,factory:indexedDB}).get(key)).bytes.length,80);
  const next=cache.key('original-b',transform);await cache.save(next,{bytes:new Uint8Array(80)});
  assert.equal(await cache.get(key),null);assert.equal((await cache.get(next)).bytes.length,80);
});

test('temporary cleanup previews expired fragments, skips active sessions and retains originals and receipts',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stc-upload-cleanup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const manager=new CaptureMediaUploadManager({uploadDir:path.join(root,'chunks'),storageDir:path.join(root,'stored')});
  const input={protocolVersion:2,kind:'image',mimeType:'image/png',size:png.length,sha256:createHash('sha256').update(png).digest('hex')};
  const pending=await manager.create(input);await manager.writeChunk(pending.uploadId,0,png,pending.uploadToken);
  const metadataFile=path.join(manager.directory(pending.uploadId),'upload.json');const metadata=JSON.parse(fs.readFileSync(metadataFile));metadata.createdAt='2020-01-01';fs.writeFileSync(metadataFile,JSON.stringify(metadata));
  await assert.rejects(manager.status(pending.uploadId,pending.uploadToken),{code:'MEDIA_UPLOAD_EXPIRED'});
  assert.equal((await manager.cleanupExpired({activeUploadIds:[pending.uploadId]})).expiredUploads,0);
  const preview=await manager.cleanupExpired();assert.equal(preview.expiredUploads,1);assert.ok(preview.bytes>=png.length);assert.equal(fs.existsSync(metadataFile),true);
  const complete=await manager.create(input);await manager.writeChunk(complete.uploadId,0,png,complete.uploadToken);const receipt=await manager.complete(complete.uploadId,complete.uploadToken);
  assert.equal((await manager.cleanupExpired({dryRun:false})).removedUploads,1);
  assert.deepEqual(await manager.complete(complete.uploadId,complete.uploadToken),receipt);assert.equal(fs.existsSync(path.join(manager.storageRoot,receipt.storageRef)),true);
});

test('narrative planning keeps the approved scope but never sends the complete destination evidence history',()=>{
  const facts=Array.from({length:48},(_,index)=>({
    normalized_key:`route.fact_${index}`,subject:`Landmark ${index}`,predicate:'route_step',
    preferred_value:`Use landmark ${index} in the route. `.repeat(80),consensus_status:'corroborated',
    evidence:Array.from({length:8},(_item,evidenceIndex)=>({claim_id:`claim-${index}-${evidenceIndex}`,
      source_id:`source-${evidenceIndex}`,value:`Step ${index}`.repeat(100),quote:'Authorized grounded route evidence. '.repeat(100),
      confidence:1-evidenceIndex/100,qualifiers:Array(20).fill('condition')})),
  }));
  const input=boundedNarrativePackage({
    brief:{id:'brief',destination_slug:'chongqing',topic:'Route',strategy_version:'3.3',
      evidence_ledger:facts.map((fact)=>fact.normalized_key),plan:{title:'Route',reader_promise:'Plan the route',
        outline:Array.from({length:8},(_,index)=>({section_id:`day-${index}`,heading:`Day ${index}`,purpose:'Choose the next stop',
          claim_keys:facts.slice(index*6,index*6+6).map((fact)=>fact.normalized_key)}))}},
    editorial_assembly:{id:'assembly',selected_fact_keys:facts.map((fact)=>fact.normalized_key),
      selected_experience_block_ids:['experience-1'],exclusions:[],rationale:'Use the approved route.'},
    approved_proposal:{readerPromise:'Plan the route'},production_mode:'source_adaptation',facts,
    experiences:[{id:'experience-1',title:'Grounded route',sequence:Array(30).fill('Long step '.repeat(100))}],
    sources:Array(100).fill({raw_text:'This unrelated source history must not enter narrative planning.'}),
    authorized_source_assets:Array(100).fill({preview_url:'data:image/png;base64,not-for-this-stage'}),
  });
  assert.equal(input.facts.length,48);
  assert.ok(input.facts.every((fact)=>fact.evidence.length>=1 && fact.evidence.length<=2));
  assert.equal(input.narrative_input_manifest.requested_fact_count,48);
  assert.ok(input.narrative_input_manifest.input_bytes<=NARRATIVE_INPUT_BUDGET.maxInputBytes);
  assert.ok(input.narrative_input_manifest.estimated_tokens<=NARRATIVE_INPUT_BUDGET.maxEstimatedTokens);
  assert.doesNotMatch(JSON.stringify(input),/unrelated source history|data:image/);
  assert.match(JSON.stringify(input),/claim-0-0/);
});

test('an empty v2 Writing Packet cannot leak unselected live facts, sources, media or narrative into the writer',async()=>{
  let request;
  const engine=new ContentEngine({apiKey:'test',model:'test',baseUrl:'https://api.example.test/v1'},async(_url,options)=>{
    request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'Test',slug:'test',body_markdown:'A useful evidence-limited observation.',meta_description:'Test',evidence_ledger:[],unresolved_conflicts:[],verification_notes:[],visuals:[],faqs:[],seo:{meta_title:'Test',focus_keyword:'test',secondary_keywords:[],search_intent:'informational',key_takeaways:[]}})}}]}),{headers:{'content-type':'application/json'}});
  });
  await engine.draft({brief:{strategy_version:'3.1'},writing_packet:{packet_text:'Selected grounded observations only.',selected_fact_keys:[],evidence_ledger:[],context:{version:2,narrative_plan:{throughline:'frozen route'},reader_sources:[],authorized_source_assets:[],internal_link_inventory:[]}},
    facts:[{normalized_key:'unselected',preferred_value:'LIVE_PRIVATE_FACT'}],source_reference:{raw_text:'LIVE_SOURCE'},authorized_source_assets:[{alt_text:'LIVE_MEDIA'}],narrative_plan:{throughline:'LIVE_NARRATIVE'}});
  assert.doesNotMatch(JSON.stringify(request),/LIVE_PRIVATE_FACT|LIVE_SOURCE|LIVE_MEDIA|LIVE_NARRATIVE|frozen route/);
  assert.match(JSON.stringify(request),/structure, never factual evidence/);
});

test('draft structured output is constrained to frozen fact keys and planned section ids',async()=>{
  let request;
  const output={title:'Museum guide',slug:'museum-guide',body_markdown:'## Visit\n\nAdmission costs CNY 20.',meta_description:'Visit guide',
    evidence_ledger:[{section_id:'visit',section:'Visit',content_node_ids:[],claim_keys:['museum.fee'],source_ids:['source-1']}],
    unresolved_conflicts:[],verification_notes:[],visuals:[],faqs:[],seo:{meta_title:'Museum guide',focus_keyword:'museum guide',secondary_keywords:[],search_intent:'informational',key_takeaways:[]}};
  const engine=new ContentEngine({apiKey:'test',model:'test',baseUrl:'https://api.example.test/v1'},async(_url,options)=>{
    request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}),{headers:{'content-type':'application/json'}});
  });
  await engine.draft({brief:{strategy_version:'3.3',plan:{outline:[{section_id:'visit',heading:'Visit',claim_keys:['museum.fee']}]}},
    writing_packet:{packet_text:'Use only the fee.',selected_fact_keys:['museum.fee'],evidence_ledger:[{fact_snapshot:{
      normalized_key:'museum.fee',subject:'Museum',predicate:'admission_fee',preferred_value:'CNY 20',evidence:[{source_id:'source-1',value:'CNY 20'}]}}],
    context:{version:2,content_policy:{faq:{maximum:0},visuals:{maximum:0}},narrative_plan:{},reader_sources:[],authorized_source_assets:[],internal_link_inventory:[]}}});
  const ledgerSchema=request.response_format.json_schema.schema.properties.evidence_ledger;
  assert.deepEqual(ledgerSchema.items.properties.claim_keys.items.enum,['museum.fee']);
  assert.deepEqual(ledgerSchema.items.properties.section_id.enum,['visit']);
  assert.equal(ledgerSchema.maxItems,24);
  assert.equal(ledgerSchema.items.properties.claim_keys.maxItems,12);
});

test('draft retries once when an evidence-bearing planned section is missing from the ledger',async()=>{
  let calls=0;const inputs=[];
  const base={title:'Route guide',slug:'route-guide',body_markdown:'## Start\n\nUse the metro.\n\n## Finish\n\nWalk to the river.',meta_description:'Route guide',
    unresolved_conflicts:[],verification_notes:[],visuals:[],faqs:[],seo:{meta_title:'Route guide',focus_keyword:'route guide',secondary_keywords:[],search_intent:'informational',key_takeaways:[]}};
  const engine=new ContentEngine({apiKey:'test',model:'test',baseUrl:'https://api.example.test/v1'},async(_url,options)=>{
    const request=JSON.parse(options.body);inputs.push(JSON.parse(request.messages.at(-1).content));calls++;
    const evidence_ledger=calls===1
      ? [{section_id:'start',section:'Start',content_node_ids:[],claim_keys:['route.start'],source_ids:['source-1']}]
      : [{section_id:'start',section:'Start',content_node_ids:[],claim_keys:['route.start'],source_ids:['source-1']},
        {section_id:'finish',section:'Finish',content_node_ids:[],claim_keys:['route.finish'],source_ids:['source-1']}];
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...base,evidence_ledger})}}]}),{headers:{'content-type':'application/json'}});
  });
  const fact=(normalized_key)=>({fact_snapshot:{normalized_key,subject:'Route',predicate:'step',preferred_value:normalized_key,evidence:[{source_id:'source-1',value:normalized_key}]}});
  await engine.draft({brief:{strategy_version:'3.3',plan:{outline:[
    {section_id:'start',heading:'Start',claim_keys:['route.start']},{section_id:'finish',heading:'Finish',claim_keys:['route.finish']},
  ]}},writing_packet:{packet_text:'Use only the route facts.',selected_fact_keys:['route.start','route.finish'],evidence_ledger:[fact('route.start'),fact('route.finish')],
    context:{version:2,content_policy:{faq:{maximum:0},visuals:{maximum:0}},narrative_plan:{},reader_sources:[],authorized_source_assets:[],internal_link_inventory:[]}}});
  assert.equal(calls,2);
  assert.deepEqual(inputs[1].revision_feedback.missing_evidence_section_ids,['finish']);
});

test('draft rejects a factual claim mapped into a planned non-factual section even when that section has no allowed keys',async()=>{
  let calls=0;const inputs=[];
  const base={title:'Museum guide',slug:'museum-guide',body_markdown:'## Visit\n\nAdmission costs CNY 20.\n\n## Closing\n\nChoose the timing that works for you.',meta_description:'Museum guide',
    unresolved_conflicts:[],verification_notes:[],visuals:[],faqs:[],seo:{meta_title:'Museum guide',focus_keyword:'museum guide',secondary_keywords:[],search_intent:'informational',key_takeaways:[]}};
  const engine=new ContentEngine({apiKey:'test',model:'test',baseUrl:'https://api.example.test/v1'},async(_url,options)=>{
    const request=JSON.parse(options.body);inputs.push(JSON.parse(request.messages.at(-1).content));calls++;
    const evidence_ledger=calls===1
      ? [{section_id:'closing',section:'Closing',content_node_ids:[],claim_keys:['museum.fee'],source_ids:['source-1']}]
      : [{section_id:'visit',section:'Visit',content_node_ids:[],claim_keys:['museum.fee'],source_ids:['source-1']}];
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...base,evidence_ledger})}}]}),{headers:{'content-type':'application/json'}});
  });
  await engine.draft({brief:{strategy_version:'3.3',plan:{outline:[
    {section_id:'visit',heading:'Visit',claim_keys:['museum.fee']},{section_id:'closing',heading:'Closing',claim_keys:[]},
  ]}},writing_packet:{packet_text:'Use only the fee.',selected_fact_keys:['museum.fee'],evidence_ledger:[{fact_snapshot:{
    normalized_key:'museum.fee',subject:'Museum',predicate:'admission_fee',preferred_value:'CNY 20',evidence:[{source_id:'source-1',value:'CNY 20'}]}}],
    context:{version:2,content_policy:{faq:{maximum:0},visuals:{maximum:0}},narrative_plan:{},reader_sources:[],authorized_source_assets:[],internal_link_inventory:[]}}});
  assert.equal(calls,2);
  assert.deepEqual(inputs[1].revision_feedback.invalid_section_claim_mappings,[{section_id:'closing',claim_key:'museum.fee'}]);
});

test('draft refuses a legacy page plan that exceeds its frozen Writing Packet before calling the provider',async()=>{
  let calls=0;
  const engine=new ContentEngine({apiKey:'test',model:'test',baseUrl:'https://api.example.test/v1'},async()=>{calls++;return new Response();});
  await assert.rejects(engine.draft({brief:{strategy_version:'3.3',plan:{outline:[
    {section_id:'covered',heading:'Covered',claim_keys:['fact.covered']},
    {section_id:'missing',heading:'Missing',claim_keys:['fact.not_frozen']},
  ]}},writing_packet:{packet_text:'Legacy unsafe route.',selected_fact_keys:['fact.covered'],evidence_ledger:[{fact_snapshot:{
    normalized_key:'fact.covered',subject:'Place',predicate:'name',preferred_value:'Place',evidence:[{source_id:'source-1',value:'Place'}]}}],
    context:{version:2,content_policy:{faq:{maximum:0},visuals:{maximum:0}},narrative_plan:{conditional_branches:['Unsupported fare CNY 99']},reader_sources:[],authorized_source_assets:[],internal_link_inventory:[]}}}),
  {code:'FROZEN_WRITING_SCOPE_INVALID'});
  assert.equal(calls,0);
});
