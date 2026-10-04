// Compare only per-image versus source-batched validation on identical read-only
// retained production data. No warm process cache crosses a measured run.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Repository} from '../src/repository.mjs';
import {readMediaBindings,readMediaBindingIssues} from '../src/repositories/media-bindings.mjs';
const filename=process.argv[2],output=process.argv[3];
if(!filename||!output)throw new Error('Pass a retained database copy and JSON report path.');
const results=[];
for(const mode of ['individual','batched','batched','individual']){
  const db=new DatabaseSync(filename,{readOnly:true});db.exec('PRAGMA query_only=ON');
  const repo=new Repository(db,{sourceUploadsDir:'C:/s01-restore-20260927/source-uploads'});
  const original=repo.authorizedSourceAssetsForBrief.bind(repo);
  if(mode==='individual'){
    class IndividualBindings extends Map{
      has(id){if(!super.has(id))super.set(id,{bindings:readMediaBindings(db,id),issues:readMediaBindingIssues(db,id)});return true;}
    }
    repo.authorizedSourceAssetsForBrief=(brief,options)=>original(brief,{...options,bindingCache:new IndividualBindings()});
  }
  const start=performance.now(),pack=repo.getDraftPackage('draft_0ff3fa83e3c844fc807f8c8f1e1ffe88'),ms=performance.now()-start;
  const serialized=JSON.stringify(pack),hash=crypto.createHash('sha256').update(serialized).digest('hex');
  results.push({mode,ms,bytes:Buffer.byteLength(serialized),hash});db.close();
  console.error(`${mode}: ${Math.round(ms)} ms`);
}
assert.equal(new Set(results.map(r=>r.hash)).size,1,'all article/media/provenance outputs must be identical');
const mean=mode=>results.filter(r=>r.mode===mode).reduce((sum,r)=>sum+r.ms,0)/2;
const report={scope:'One retained production draft, same queries and data, per-image versus batched binding validation, ABBA order',
  results,beforeMeanMs:mean('individual'),afterMeanMs:mean('batched'),reductionPercent:100*(1-mean('batched')/mean('individual')),
  identicalOutputs:true,providerCalls:0,productionWrites:0};
fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
