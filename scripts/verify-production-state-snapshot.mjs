import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { Repository } from '../src/repository.mjs';
import { buildProductionState } from '../src/services/production-state.mjs';

const filename=path.resolve(process.argv[2] || '');
if (!/(?:work|replay)/i.test(path.basename(filename)) || !fs.existsSync(filename)) {
  throw new Error('Pass an existing disposable work/replay database.');
}
const db=openDatabase(filename,{migrate:false});
try {
  const repository=new Repository(db);
  const compact=repository.listContent({productionOnly:true,limit:50,compact:true});
  const detail=repository.listContent({productionOnly:true,limit:50,compact:false});
  assert.equal(compact.length,detail.length);
  for (const row of compact) {
    const independentlyComputed=buildProductionState(db,row,{capabilities:repository.productionCapabilities});
    assert.deepEqual(row.production_state,independentlyComputed,
      `Batched status projection mismatch at ${row.opportunity_id}`);
    const detailed=detail.find((item)=>item.opportunity_id===row.opportunity_id);
    assert.deepEqual(row.production_state,detailed.production_state,
      `Compact status differs from on-demand detail at ${row.opportunity_id}`);
  }
  console.log(JSON.stringify({rows:compact.length,statusProjection:'identical',integrity:db.prepare('PRAGMA quick_check').get().quick_check}));
} finally {db.close();}
