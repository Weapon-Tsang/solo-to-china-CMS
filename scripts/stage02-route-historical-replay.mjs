import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, SCHEMA_VERSION } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';
import { freezeRequiredMediaManifest } from '../src/publication-eligibility.mjs';

const file=fs.realpathSync(process.argv[2] || '');
if(path.basename(file)!=='work.sqlite' || !path.basename(path.dirname(file)).startsWith('cms-phase02-media-replay-'))
  throw new Error('Use the already authorized disposable phase02 work database.');
const db=new DatabaseSync(file);
const tables=['sources','source_assets','article_drafts','article_visuals','writing_packets','jobs','model_call_metrics','wordpress_publications','experience_extraction_runs'];
const fingerprint=table=>{const hash=crypto.createHash('sha256');let count=0;
  const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name).filter(x=>x!=='route_fragments_json');
  for(const row of db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).iterate()){hash.update(JSON.stringify(row));count++;}
  return {count,sha256:hash.digest('hex')};};
const baseline=Object.fromEntries(tables.map(table=>[table,fingerprint(table)]));
const version=db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v;
assert.equal(version,81,'This narrow replay only tests the existing schema81 work copy.');
const report={scope:'Existing authorized disposable historical DB; real migration in a rolled-back transaction; no production reads',schemaFrom:version,
  baseline,externalRequests:0};
try {
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  migrate(db);
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,SCHEMA_VERSION);
  for(const table of tables) assert.deepEqual(fingerprint(table),baseline[table]);
  assert.equal(db.prepare('SELECT count(*) n FROM route_bundles').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM route_artifacts').get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM experience_extraction_runs WHERE route_fragments_json<>'[]'").get().n,0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  const repository=new Repository(db,{});
  if(process.argv.includes('--schematic')) {
    report.schematicCompatibility=[];
    for(const draft of db.prepare('SELECT id FROM article_drafts ORDER BY id').all()) {
      db.exec('SAVEPOINT legacy_manifest_read');
      try {
        const manifest=freezeRequiredMediaManifest(db,draft.id);
        assert.ok(!manifest?.slots.some(slot=>slot.routeContract),'Historical unknown routes must not be fabricated');
        report.schematicCompatibility.push({draft_id:draft.id,slots:manifest?.slots.length || 0,route_contracts:0});
      } finally {db.exec('ROLLBACK TO legacy_manifest_read; RELEASE legacy_manifest_read');}
    }
    assert.equal(db.prepare("SELECT count(*) n FROM article_visuals WHERE acquisition_strategy='render_route_schematic'").get().n,0);
  }
  if(process.argv.includes('--decisions')) {
    report.routeDecisionReplay=[];
    for(const owner of db.prepare('SELECT id FROM content_opportunities WHERE approved_at IS NOT NULL ORDER BY id').all()) {
      const state=repository.routeDecisionState(owner.id);
      assert.equal(state.current,null);assert.equal(state.article_route_status,'unknown');assert.equal(state.can_propose,false);
      assert.deepEqual(state.proposals,[]);
      assert.throws(()=>repository.proposeRouteRevision(owner.id,{idempotency_key:'historical-replay',reason:'Must not backfill',
        route_scope:{mode:'source_route_adaptation',fragment_ids:['unproven']}},'replay'),{code:'ROUTE_SNAPSHOT_REQUIRED'});
      report.routeDecisionReplay.push({owner_id:owner.id,status:state.article_route_status,can_propose:state.can_propose});
    }
    assert.ok(report.routeDecisionReplay.length>0);
  }
  report.mediaReadReplay=[];
  for(const draft of process.argv.includes('--decisions') || process.argv.includes('--schematic')?[]:db.prepare('SELECT id FROM article_drafts ORDER BY id LIMIT 3').all()) {
    console.error(`Read-only media plan: ${draft.id}`);
    const plan=repository.mediaRepairPlan(draft.id);
    report.mediaReadReplay.push({draft_id:draft.id,slots:plan.slots.length,
      dispositions:plan.slots.map(slot=>slot.disposition),route_backfilled:false});
  }
  for(const table of tables) assert.deepEqual(fingerprint(table),baseline[table]);
  assert.equal(db.prepare('SELECT count(*) n FROM route_bundles').get().n,0);
  report.migration='PASS';report.schemaTo=SCHEMA_VERSION;report.legacyRoutes='Remain unknown; not fabricated or backfilled';
  report.invariants={protectedRowsUnchanged:true,noAutomaticJobs:true,noBudgetReset:true,noInventedHistoricalRoute:true,foreignKeysValid:true};
} finally {
  if(db.isTransaction)db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,version);
  for(const table of tables)assert.deepEqual(fingerprint(table),baseline[table]);
  db.close();
}
report.rollback='PASS';console.log(JSON.stringify(report,null,2));
