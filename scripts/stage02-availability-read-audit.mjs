import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { draftInputDto } from '../src/ai/content-engine.mjs';

const file=fs.realpathSync(process.argv[2] || '');
if(path.basename(file)!=='work.sqlite' || !path.basename(path.dirname(file)).startsWith('cms-phase02-media-replay-'))
  throw new Error('Pass a disposable phase02 replay work.sqlite.');
const db=new DatabaseSync(file,{readOnly:true});
try {
  const repository=new Repository(db);
  let packages=0;let frozen=0;let candidates=0;
  for (const {id} of db.prepare('SELECT id FROM content_briefs ORDER BY id').all()) {
    const value=repository.getBriefPackage(id);
    if (!value) continue;
    packages++;
    assert.equal(value.media_availability.version,2);
    const inventoryIds=new Set(value.media_availability.assets.map(asset=>asset.asset_id));
    assert.ok(value.authorized_source_assets.every(asset=>inventoryIds.has(asset.id)));
    candidates+=value.media_availability.assets.length;
    const dto=draftInputDto(value);
    if(value.writing_packet?.context?.version===2) {
      frozen++;
      assert.deepEqual(dto.media_availability.assets.map(asset=>asset.asset_id),
        (value.writing_packet.context.authorized_source_assets || []).map(asset=>asset.id || asset.source_asset_id));
    }
  }
  console.log(JSON.stringify({scope:'Read-only historical brief packages and writer DTO, no generation or media semantic audit',
    packages,frozenPackets:frozen,liveCandidateEntries:candidates,passed:true,modelCalls:0},null,2));
} finally {db.close();}
