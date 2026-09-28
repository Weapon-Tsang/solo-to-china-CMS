import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readMediaBindings, refreshSourceMediaBindings } from '../src/repositories/media-bindings.mjs';

// Read-only audit of a disposable replay database, never a live data root.
const file=fs.realpathSync(process.argv[2] || '');
if(path.basename(file)!=='work.sqlite' || !path.basename(path.dirname(file)).startsWith('cms-phase02-media-replay-'))
  throw new Error('Pass a disposable phase02 replay work.sqlite.');
const db=new DatabaseSync(file,{readOnly:true});
try {
  const ids=db.prepare("SELECT DISTINCT asset_id FROM media_bindings WHERE status='confirmed' ORDER BY asset_id").all();
  const samples=[];let accepted=0;
  for(let i=0;i<30;i++) {
    const start=performance.now();let count=0;
    for(const {asset_id} of ids)count+=readMediaBindings(db,asset_id).length;
    samples.push(Number((performance.now()-start).toFixed(3)));
    if(i && count!==accepted)throw new Error('Read-only relation results changed.');
    accepted=count;
  }
  const sorted=[...samples].sort((a,b)=>a-b);
  let comparedBindings=0;let mismatches=0;
  for (const source of db.prepare('SELECT id FROM sources ORDER BY id').all()) {
    const plan=refreshSourceMediaBindings(db,source.id);
    for (const asset of plan.assets) for (const binding of asset.bindings) {
      comparedBindings++;
      const saved=db.prepare('SELECT status,evidence_json FROM media_bindings WHERE id=?').get(binding.id);
      if (!saved || saved.status!==binding.status || saved.evidence_json!==JSON.stringify(binding.evidence)) mismatches++;
    }
  }
  console.log(JSON.stringify({scope:'Read-only binding validation; not an API/menu benchmark',assets:ids.length,accepted,
    dryRunComparedBindings:comparedBindings,dryRunMismatches:mismatches,
    samplesMs:samples,p50Ms:sorted[14],p95Ms:sorted[28],
    foreignKeyViolations:db.prepare('PRAGMA foreign_key_check').all().length,
    orphanBindings:db.prepare('SELECT COUNT(*) n FROM media_bindings mb LEFT JOIN media_occurrences mo ON mo.id=mb.occurrence_id WHERE mo.id IS NULL').get().n,
    staleConfirmedBindings:db.prepare("SELECT COUNT(*) n FROM media_bindings mb JOIN media_occurrences mo ON mo.id=mb.occurrence_id WHERE mb.status='confirmed' AND mo.status='stale'").get().n},null,2));
  if (mismatches) process.exitCode=1;
} finally {db.close();}
