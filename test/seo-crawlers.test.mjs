import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCrawlerPolicies} from '../src/seo-crawlers.mjs';

test('T03-04/21 search, training and user-triggered requests remain independent observations',()=>{
  const rows=inspectCrawlerPolicies('User-agent: *\nAllow: /\nUser-agent: GPTBot\nDisallow: /\nUser-agent: Google-Extended\nDisallow: /',
    {url:'https://example.invalid/guide/'});
  const byAgent=Object.fromEntries(rows.map(row=>[row.agent,row]));
  assert.equal(byAgent.Googlebot.policy.allowed,true);assert.equal(byAgent['OAI-SearchBot'].policy.allowed,true);
  assert.equal(byAgent.GPTBot.policy.allowed,false);assert.equal(byAgent['Google-Extended'].policy.allowed,false);
  assert.equal(byAgent['ChatGPT-User'].policy.allowed,null);
  assert.ok(rows.every(row=>row.actual_access==='not_observed'&&row.search_outcome==='unknown'&&!row.settings_changed));
  assert.ok(inspectCrawlerPolicies(null,{httpStatus:403}).every(row=>row.policy.allowed===null));
});
