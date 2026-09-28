import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryFixture} from '../test-support/repository-fixture.mjs';
import {publishedRouteFixture} from '../test-support/route-decision-fixture.mjs';
import {editorialSeoContext} from '../src/services/editorial-seo-context.mjs';

test('T03-13/14 saved entity identity and anonymous access reach the package without model or network calls',t=>{
  const {db,repository}=repositoryFixture(t,{publicSiteUrl:'https://example.invalid'}),seed=publishedRouteFixture(repository);
  const coverage=JSON.parse(db.prepare('SELECT coverage_json FROM content_opportunities WHERE id=?').get(seed.ownerId).coverage_json);
  coverage.approval.proposal.targetEntities=['East Hall'];coverage.approval.proposal.readerPromise='How to visit East Hall?';
  db.prepare('UPDATE content_opportunities SET coverage_json=? WHERE id=?').run(JSON.stringify(coverage),seed.ownerId);
  const url='https://example.invalid/east-hall/';
  db.prepare('UPDATE wordpress_content_inventory SET post_url=?').run(url);
  const inventory=repository.listWordPressInventory();
  const args={proposal:{targetEntities:['east'],readerPromise:'How to visit East Hall?'},destination:'beijing',siteUrl:'https://example.invalid',
    topic:'East Hall',facts:[{}],inventory,now:Date.parse('2026-09-28T10:00:00Z')};
  const pending=editorialSeoContext(db,args);
  assert.equal(pending.disposition.action,'update');assert.equal(pending.links.length,0);
  assert.equal(pending.unverified_targets.length,1);
  const draft=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(seed.draft);
  const observation={checked_at:'2026-09-28T09:59:00Z',page_revision:draft.revision,content_hash:draft.content_hash,url,
    result:{finalUrl:url,requests:[{url,status:'observed'}]}};
  const save=()=>db.prepare(`INSERT INTO runtime_settings(setting_key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json`).run(`seo_observation:${seed.draft}`,JSON.stringify(observation),'now');
  save();const available=editorialSeoContext(db,args);
  assert.deepEqual(available.links[0].relationship.entity_ids,['east']);
  assert.equal(available.links[0].public_accessibility,'confirmed');
  assert.equal(editorialSeoContext(db,{...args,proposal:{...args.proposal,readerPromise:'How to book?'}}).disposition.action,'new');
  assert.equal(editorialSeoContext(db,{...args,facts:[]}).disposition.action,'keep-as-claim');
  assert.equal(editorialSeoContext(db,{...args,now:args.now+300_000}).links.length,0);
  observation.result.requests[0].status='unknown';save();assert.equal(editorialSeoContext(db,args).links.length,0);
  const unknown=editorialSeoContext(db,{...args,inventory:[{...inventory[0],post_id:99}]});
  assert.equal(unknown.disposition.action,'needs-review');
  const pkg=repository.getBriefPackage(draft.brief_id);
  assert.deepEqual(pkg.editorial_seo.context.entities,['east']);
  assert.equal(pkg.editorial_seo.disposition.action,'new','the current article does not recommend updating itself');
  const owner=db.prepare('SELECT * FROM content_opportunities WHERE id=?').get(seed.ownerId);
  const columns=Object.keys(owner);
  db.prepare(`INSERT INTO content_opportunities (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`)
    .run(...columns.map(key=>['id','topic_key'].includes(key)?'ambiguous-owner':owner[key]));
  const ambiguous=editorialSeoContext(db,args);
  assert.equal(ambiguous.disposition.action,'needs-review','multiple approved owners cannot silently borrow the latest question');
  assert.equal(ambiguous.links.length,0);
  assert.equal(db.prepare('SELECT count(*) n FROM model_call_metrics').get().n,0);
});
