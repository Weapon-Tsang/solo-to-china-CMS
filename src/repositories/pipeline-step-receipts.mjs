import { sha256 } from '../utils.mjs';
import { dependencyHash, PIPELINE_CONTRACT_VERSION } from '../pipeline-contract.mjs';

// Durable returned model outputs, never full input prompts or request headers.
// A receipt covers an exact stage input/configuration; it does not claim that
// the external provider and SQLite participate in one transaction.
export function stepIdentity(job, artifact, stepKey, input, configHash) {
  const identity={stage:job.type,entity_id:job.entity_id,step_key:String(stepKey),
    input_hash:dependencyHash({version:PIPELINE_CONTRACT_VERSION,stageInput:artifact?.input_hash || null,input}),config_hash:configHash};
  return {...identity,request_hash:dependencyHash(identity)};
}

export function readStepReceipt(db, identity) {
  const row=db.prepare('SELECT * FROM pipeline_step_receipts WHERE request_hash=?').get(identity.request_hash);
  if(!row||row.input_hash!==identity.input_hash||row.config_hash!==identity.config_hash||row.output_hash!==sha256(row.result_json))return null;
  try{return {value:JSON.parse(row.result_json),requestHash:row.request_hash};}catch{return null;}
}

export function saveStepReceipt(db, identity, value, job, timestamp) {
  const result=JSON.stringify(value);
  if(result===undefined)throw new Error('Model step returned no serializable result');
  db.prepare(`INSERT INTO pipeline_step_receipts(request_hash,stage,entity_id,step_key,input_hash,config_hash,output_hash,result_json,job_id,lease_generation,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_hash) DO UPDATE SET output_hash=excluded.output_hash,result_json=excluded.result_json,
      job_id=excluded.job_id,lease_generation=excluded.lease_generation,created_at=excluded.created_at`)
    .run(identity.request_hash,identity.stage,identity.entity_id,identity.step_key,identity.input_hash,identity.config_hash,
      sha256(result),result,job.id,job.lease_generation||0,timestamp);
  return value;
}
