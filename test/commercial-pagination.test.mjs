import assert from 'node:assert/strict';
import test from 'node:test';
import { repositoryFixture } from '../test-support/repository-fixture.mjs';

test('commercial asset pages are SQL bounded and filtered across all records', (t) => {
  const { db, repository } = repositoryFixture(t);
  const stamp = '2026-09-21T00:00:00.000Z';
  db.prepare(`INSERT INTO affiliate_provider_accounts(id,provider_key,display_name,connection_mode,site_name,
    default_language,default_disclosure,status,created_at,updated_at)
    VALUES ('provider','provider','Provider','MANUAL','Site','en','','CONFIGURED',?,?)`).run(stamp,stamp);
  const insert = db.prepare(`INSERT INTO affiliate_assets(id,provider_account_id,provider,asset_type,product_category,
    scope_type,scope_key,title,active,created_at,updated_at,lifecycle_state,valid_until)
    VALUES (?,'provider','Provider','DEEP_LINK','HOTEL','GLOBAL','','Asset',?,?,?,'operational',?)`);
  for (let index=0;index<55;index++) insert.run(`asset-${String(index).padStart(3,'0')}`,index===42?0:1,stamp,stamp,
    index===42?'2020-01-01T00:00:00.000Z':null);
  const first=repository.listAffiliateAssets({lifecycleState:'operational',limit:21,cursor:0});
  const second=repository.listAffiliateAssets({lifecycleState:'operational',limit:21,cursor:20});
  const third=repository.listAffiliateAssets({lifecycleState:'operational',limit:21,cursor:40});
  assert.equal(first.length,21);
  assert.equal(second.length,21);
  assert.equal(third.length,15);
  assert.equal(new Set([...first.slice(0,20),...second.slice(0,20),...third].map((row)=>row.id)).size,55);
  assert.deepEqual(repository.listAffiliateAssets({lifecycleState:'operational',statusFilter:'expired',limit:21})
    .map((row)=>row.id),['asset-042']);
});
