import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {Repository} from '../src/repository.mjs';

const filename=path.resolve(process.argv[2] || '');
const relative=path.relative(path.resolve('output'),filename);
if(!/^interruption-history-[^\\/]+[\\/]/.test(relative) || !filename.endsWith('work.sqlite'))
  throw new Error('Use only an isolated output/interruption-history-*/...work.sqlite.');
const db=openDatabase(filename),repository=new Repository(db);
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidence=()=>db.prepare(`SELECT id,source_id,subject,predicate,value_text,source_quote,qualifiers_json,
  evidence_span_ids_json,extraction_run_id,lifecycle_status,knowledge_eligible FROM claims ORDER BY id`).all();
const protectedDigest=()=>digest(['claims','knowledge_facts','article_drafts','wordpress_publications','jobs','pipeline_step_receipts']
  .map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
const before=protectedDigest(),beforeEvidence=digest(evidence());
const receipts=db.prepare(`SELECT p.*,j.status job_status,j.last_failure_code FROM pipeline_step_receipts p
  LEFT JOIN jobs j ON j.id=p.job_id WHERE p.stage='resolve_entities' ORDER BY p.created_at`).all();
assert.ok(receipts.length,'Retained production receipts required.');
const report={version:'interruption-replay-1',providerCalls:0,productionWrites:0,wordpressWrites:0,receipts:[]};
try {
  for(const receipt of receipts) {
    const result=JSON.parse(receipt.result_json);
    db.exec('BEGIN');
    try {
      repository.applyEntityResolution(receipt.entity_id,result.output,result.model);
      assert.equal(digest(evidence()),beforeEvidence,'No source evidence may be removed or overwritten.');
      repository.applyEntityResolution(receipt.entity_id,result.output,result.model);
      assert.equal(digest(evidence()),beforeEvidence);
      report.receipts.push({jobId:receipt.job_id,destination:receipt.entity_id,historicalStatus:receipt.job_status,
        historicalCode:receipt.last_failure_code,updates:result.output.claim_updates?.length || 0,status:'PASS'});
    } catch(error) {
      report.receipts.push({jobId:receipt.job_id,status:'FAIL',error:error.message});throw error;
    } finally {db.exec('ROLLBACK');}
  }
  assert.equal(protectedDigest(),before);
  report.rollbackPreserved=true;report.beforeFingerprint=before;report.afterFingerprint=protectedDigest();
  report.status='PASS';
} catch(error) {report.status='FAIL';report.error=error.message;process.exitCode=1;}
finally {
  db.close();const target=path.join(path.dirname(filename),'entity-replay.json');
  fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,receipts:report.receipts.length,
    historicalSqlFailures:report.receipts.filter(r=>r.historicalCode==='ERR_SQLITE_ERROR').length,
    rollbackPreserved:report.rollbackPreserved,report:target,error:report.error}));
}
