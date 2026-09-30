import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentEngine } from '../src/ai/content-engine.mjs';

const fact = { normalized_key:'metro.access',subject:'Metro',predicate:'access',preferred_value:'Use the metro',
  evidence:[{source_id:'source-1',value:'Use the metro',quote:'Use the metro'}] };
const bundle = () => ({
  brief:{ title:'Metro guide',outline:[{section_id:'section_metro',heading:'Metro access',claim_keys:['metro.access']}],
    reader_promise:'Plan transport' },
  draft:{ title:'Metro guide',slug:'metro-guide',meta_description:'A metro guide.',
    body_markdown:'## Metro access\n\nUse the metro for this route.',
    evidence_ledger:[{section_id:'section_metro',section:'Metro access',content_node_ids:['node_metro'],
      claim_keys:['metro.access'],source_ids:['source-1']}],unresolved_conflicts:[],verification_notes:[],
    seo:{meta_title:'Metro guide',focus_keyword:'metro',secondary_keywords:[],search_intent:'informational',key_takeaways:[]},
    faqs:[],visuals:[] },
});

test('article bundle uses one structured request and keeps evidence scoped to the plan', async () => {
  const engine = new ContentEngine({apiKey:'unused',model:'unused'});
  const calls=[];
  engine.respond = async (request) => {
    calls.push(request);
    const output=bundle();
    request.options.validateOutput(output);
    return {model:'fixture',output};
  };
  const result=await engine.articleBundle({facts:[fact]});
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'article_bundle_v1');
  assert.deepEqual(calls[0].schema.required,['brief','draft']);
  assert.equal(result.output.draft.evidence_ledger[0].source_ids[0],'source-1');
});

test('article bundle rejects an unsupported claim before persistence', async () => {
  const engine = new ContentEngine({apiKey:'unused',model:'unused'});
  engine.respond = async (request) => {
    const output=bundle();
    output.draft.evidence_ledger[0].claim_keys=['invented.claim'];
    request.options.validateOutput(output);
    return {model:'fixture',output};
  };
  await assert.rejects(engine.articleBundle({facts:[fact]}),{code:'DRAFT_EVIDENCE_SCOPE_INVALID'});
});

test('zoo bundle corrects missing protected times once and keeps the evidence guard', async () => {
  const times = [
    {normalized_key:'attraction.chongqing_zoo.best_viewing_time',predicate:'best_viewing_time',preferred_value:'08:30-09:50'},
    {normalized_key:'attraction.chongqing_zoo.panda_feeding_time',predicate:'panda_feeding_time',preferred_value:'15:00'},
  ];
  const engine = new ContentEngine({apiKey:'unused',model:'unused'});
  const calls=[];
  engine.respond=async request=>{
    calls.push(request);
    const output=bundle();
    output.brief.outline[0].claim_keys=times.map(f=>f.normalized_key);
    output.draft.evidence_ledger[0].claim_keys=times.map(f=>f.normalized_key);
    output.draft.body_markdown='## Metro access\n\nVisit the pandas in the morning.';
    if(calls.length===2) output.draft.body_markdown+=' The best viewing window is 08:30-09:50; feeding is at 15:00.';
    request.options.validateOutput(output);
    return {model:'fixture',output};
  };
  const result=await engine.articleBundle({facts:times});
  assert.equal(calls.length,2);
  assert.deepEqual(JSON.parse(calls[1].input).revision_feedback.missing_protected_values,
    times.map(f=>({claim_key:f.normalized_key,required_value:f.preferred_value})));
  assert.match(result.output.draft.body_markdown,/08:30-09:50/);
  assert.match(result.output.draft.body_markdown,/15:00/);
});

test('bundle correction stops at two calls when protected evidence is still missing', async () => {
  const engine=new ContentEngine({apiKey:'unused',model:'unused'});
  let calls=0;
  engine.respond=async request=>{
    calls++;
    const output=bundle();
    request.options.validateOutput(output);
    return {model:'fixture',output};
  };
  await assert.rejects(engine.articleBundle({facts:[{...fact,preferred_value:'15:00',predicate:'feeding_time'}]}),
    {code:'DRAFT_EVIDENCE_VALUE_INVALID'});
  assert.equal(calls,2);
});

test('bundle transport errors do not enter content correction', async () => {
  const engine=new ContentEngine({apiKey:'unused',model:'unused'});
  let calls=0;
  engine.respond=async()=>{calls++;throw Object.assign(new Error('Forbidden'),{code:'PROVIDER_REQUEST_FAILED',status:403});};
  await assert.rejects(engine.articleBundle({facts:[fact]}),{status:403});
  assert.equal(calls,1);
});
