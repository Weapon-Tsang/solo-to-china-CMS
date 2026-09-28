import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const evidence=path.resolve('docs/codex-cms-upgrade/evidence/phase-02-pre-extension');
const browser=JSON.parse(fs.readFileSync(path.join(evidence,'browser-full.json'),'utf8'));
const root=path.resolve(browser.root);
assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
assert.ok(path.basename(root).startsWith('stc-02pre-'));
const database=path.resolve(browser.cms.database);
assert.ok(database.startsWith(root+path.sep));
const db=new DatabaseSync(database,{readOnly:true});
try {
  const sources=db.prepare('SELECT id,external_id,status,capture_version FROM sources ORDER BY external_id').all();
  const assets=db.prepare(`SELECT a.source_id,a.media_identity,a.position,a.caption_text,a.nearby_text,
    a.original_sha256,a.local_path,a.stored_size_bytes,a.original_bytes_status,a.durability_status
    FROM source_assets a JOIN sources s ON s.id=a.source_id AND s.capture_version=a.capture_version ORDER BY a.source_id,a.position`).all();
  const checked=assets.map(asset=>{
    const filename=path.resolve(asset.local_path);assert.ok(filename.startsWith(root+path.sep));
    const bytes=fs.readFileSync(filename);const hash=createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash,asset.original_sha256);assert.equal(bytes.length,asset.stored_size_bytes);
    assert.equal(asset.original_bytes_status,'saved_original');assert.equal(asset.durability_status,'ORIGINAL_STORED');
    assert.ok(asset.caption_text&&asset.nearby_text);
    return {...asset,local_path:path.relative(root,filename),hashVerified:true};
  });
  const jobs=db.prepare('SELECT entity_id,type,status,count(*) n FROM jobs GROUP BY entity_id,type,status').all();
  assert.ok(jobs.every(j=>j.type==='extract_source'&&j.status==='queued'&&j.n===1));
  assert.equal(new Set(sources.map(s=>s.external_id)).size,sources.length);
  assert.equal(sources.length,4);assert.equal(checked.length,8);
  const foreignKeys=db.prepare('PRAGMA foreign_key_check').all();assert.equal(foreignKeys.length,0);
  const output={status:'PASS',scope:'Read-only audit of synthetic browser fixture only',database,
    sources,assets:checked,jobs,foreignKeyViolations:foreignKeys.length,
    note:'Exactly one queued extract_source per captured source. Queued is expected: no model Worker was started. Historical provisional assets are not confused with current capture version.'};
  fs.writeFileSync(path.join(evidence,'post-fix-audit.json'),JSON.stringify(output,null,2));
  console.log(JSON.stringify({status:output.status,sources:sources.length,currentAssets:checked.length,jobs:jobs.length,foreignKeyViolations:0}));
} finally {db.close();}
