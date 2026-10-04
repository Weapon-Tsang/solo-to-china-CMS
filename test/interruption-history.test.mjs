import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentEngine} from '../src/ai/content-engine.mjs';
import {explainOperationalFailure} from '../src/services/content-recovery-policy.mjs';

const pack={policy:'editorial-v2',opportunities:[{id:'opportunity-real-shape',subject:'Airport Metro',
  facts:[{key:'airport.route',value:'Line 18 serves the airport'},{key:'airport.payment',value:'Mobile payment is accepted'}]}]};
const valid={proposals:[{id:pack.opportunities[0].id,title:'Taking Line 18 From the Airport With Mobile Payment',
  angle:'Airport metro',reader_promise:'Plan the airport ride with the supplied payment option.',evidence_keys:['airport.route','airport.payment']}]};
const config={provider:'vertex',projectId:'test',model:'gemini-test',accessToken:'test',maxCompletionTokens:4096};
function response(output){return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(output)}]}}]});}

for(const [reason,invalid] of [['missing proposal',{proposals:[]}],['foreign evidence',{proposals:[{...valid.proposals[0],evidence_keys:['other.article.fact']}]}],
  ['facet title',{proposals:[{...valid.proposals[0],title:'Airport Metro: Booking, Costs, Opening Hours'}]}]]) {
  test(`production title interruption corrects ${reason} once with feedback`,async()=>{
    const requests=[];
    const engine=new ContentEngine(config,async(_url,init)=>{requests.push(JSON.parse(init.body));return response(requests.length===1?invalid:valid);});
    const result=await engine.composeOpportunityTitles(pack);
    assert.deepEqual(result.output,valid);assert.equal(requests.length,2);
    assert.match(JSON.stringify(requests[1]),/validation_feedback/);
    await engine.composeOpportunityTitles(pack);
    assert.equal(requests.length,2,'validated repair should remain reusable, not buy another response');
  });
}
test('title correction has a hard two-response bound and keeps invalid output out of cache',async()=>{
  let calls=0;const engine=new ContentEngine(config,async()=>{calls++;return response({proposals:[]});});
  await assert.rejects(engine.composeOpportunityTitles(pack),e=>e.code==='INVALID_OPPORTUNITY_TITLE'&&e.retryable===false);
  assert.equal(calls,2);
});
test('concurrent title requests share one validated correction instead of doubling paid calls',async()=>{
  let calls=0,release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const engine=new ContentEngine(config,async()=>{
    calls++;
    if(calls===1){await blocked;return response({proposals:[]});}
    return response(valid);
  });
  const first=engine.composeOpportunityTitles(pack);
  const second=engine.composeOpportunityTitles(pack);
  release();
  const results=await Promise.all([first,second]);
  assert.equal(calls,2);
  for(const result of results)assert.deepEqual(result.output,valid);
});
test('title billing and transport failures never enter content correction',async()=>{
  let calls=0;const engine=new ContentEngine(config,async()=>{calls++;return Response.json({error:{message:'Insufficient Balance'}},{status:402});});
  await assert.rejects(engine.composeOpportunityTitles(pack),e=>e.status===402);
  assert.equal(calls,1);
});

test('historical explicit insufficient balance is configuration, not a retryable generation failure',()=>{
  const result=explainOperationalFailure({type:'resolve_entities',last_failure_code:'PROVIDER_REQUEST_FAILED',
    last_error:'DeepSeek request failed (402): Insufficient Balance (request_id: retained-history)'});
  assert.equal(result.category,'configuration');
  assert.equal(result.action.id,'configure_ai');
  assert.match(result.reason,/余额|计费/);
  const quota=explainOperationalFailure({type:'resolve_entities',last_error:'Vertex request failed (429): quota exceeded'});
  assert.equal(quota.category,'capacity','do not infer insufficient funds from a generic 429');
});
