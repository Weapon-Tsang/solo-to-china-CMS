// Reconcile the exact optional AI jobs accidentally fanned out from the
// user-supplied three-day route collages. The provider failure diagnostics and
// model-call telemetry remain durable; only the current Job projection becomes
// a successful no-op because these stages were never applicable to this source.
import crypto from 'node:crypto';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const SOURCE_ID='src_83c65a1b23d34657a5cb259d4a68b092';
const PARENT_JOB_ID='job_fe09eae7806941c5b0f978622a202cef';
const JOBS=[
  {id:'job_bb25e406dac14a37ab134ff39e7279d5',type:'resolve_entities',entityId:'chongqing',code:'MODEL_OUTPUT_LIMIT'},
  {id:'job_8fbe0e9119f14493b7b9333933dee820',type:'analyze_source_diagnostic',entityId:SOURCE_ID,code:'INVALID_MODEL_OUTPUT'},
  {id:'job_75bbefe6409d4b508e9e6f90e085a672',type:'analyze_source_blueprint',entityId:SOURCE_ID,code:'INVALID_MODEL_OUTPUT'},
];

const [mode,databaseArg,confirmation,productionToken]=process.argv.slice(2);
if (!['plan','apply'].includes(mode) || !databaseArg) {
  throw new Error('usage: script plan|apply DB [CONFIRMATION] [PRODUCTION_TOKEN]');
}
const databasePath=path.resolve(databaseArg);
const livePath='/var/lib/solo-to-china/solo-to-china.sqlite';
const isLive=databasePath===livePath;
if (mode==='apply' && !isLive && !/editorial-media-only-replay-20260923-work\.sqlite$/.test(databasePath)) {
  throw new Error('Apply requires the exact disposable work DB or live DB.');
}
if (mode==='apply' && isLive && productionToken!=='EDITORIAL_MEDIA_ONLY_RECONCILIATION_PRODUCTION') {
  throw new Error('Live apply requires EDITORIAL_MEDIA_ONLY_RECONCILIATION_PRODUCTION.');
}
const hash=(value)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const db=new DatabaseSync(databasePath,{readOnly:mode==='plan'});
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode==='plan') db.exec('PRAGMA query_only=ON');
try {
  const source=db.prepare(`SELECT id,title,status,acquisition_origin,submission_metadata_json,
    capture_version,last_error FROM sources WHERE id=?`).get(SOURCE_ID);
  if (!source) throw new Error('Expected editorial media source is missing.');
  const metadata=JSON.parse(source.submission_metadata_json || '{}');
  if (source.title!=='User-supplied three-day Chongqing itinerary collages'
    || source.acquisition_origin!=='user_supplied_editorial_media'
    || metadata.editorialMediaOnly!==true || source.capture_version!==1) {
    throw new Error('Editorial media source identity or classification changed.');
  }
  const rows=JOBS.map((expected)=>{
    const row=db.prepare(`SELECT id,type,entity_id,status,attempts,max_attempts,last_failure_code,
      failure_class,parent_job_id,dedupe_key,created_at,updated_at FROM jobs WHERE id=?`).get(expected.id);
    if (!row || row.type!==expected.type || row.entity_id!==expected.entityId || row.status!=='failed'
      || row.attempts!==3 || row.max_attempts!==3 || row.last_failure_code!==expected.code
      || row.parent_job_id!==PARENT_JOB_ID) {
      throw new Error(`Unexpected accidental Job state: ${expected.id}`);
    }
    return row;
  });
  const parent=db.prepare('SELECT id,type,entity_id,status FROM jobs WHERE id=?').get(PARENT_JOB_ID);
  if (!parent || parent.type!=='extract_source_experience' || parent.entity_id!==SOURCE_ID || parent.status!=='succeeded') {
    throw new Error('The accidental fan-out parent changed.');
  }
  const active=Number(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')").get().n || 0);
  if (active!==0) throw new Error('Production queue is not quiescent.');
  const diagnosticCount=Number(db.prepare(`SELECT COUNT(*) n FROM production_failure_diagnostics
    WHERE job_id IN (${JOBS.map(()=>'?').join(',')})`).get(...JOBS.map((job)=>job.id)).n || 0);
  if (diagnosticCount!==9) throw new Error(`Expected nine retained attempt diagnostics, found ${diagnosticCount}.`);
  const snapshot={source:{id:source.id,title:source.title,status:source.status,
    acquisitionOrigin:source.acquisition_origin,captureVersion:source.capture_version},parent,jobs:rows,
    active,diagnosticCount};
  const digest=hash(snapshot);
  if (mode==='plan') {
    console.log(JSON.stringify({mode,isLive,confirmation:digest,snapshot,
      action:'Preserve diagnostics and model metrics; classify source as media_only and reconcile three non-applicable Jobs as successful no-ops.'},null,2));
  } else {
    if (confirmation!==digest) throw new Error('Confirmed reconciliation plan changed; re-plan.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const timestamp=new Date().toISOString();
      const diagnostic={...JSON.parse(db.prepare('SELECT diagnostic_json FROM sources WHERE id=?').get(SOURCE_ID)?.diagnostic_json || '{}'),
        editorialMediaOnlyReconciliation:{at:timestamp,reason:'general_source_ai_not_applicable',
          retainedFailureDiagnostics:diagnosticCount,jobIds:JOBS.map((job)=>job.id)}};
      db.prepare(`UPDATE sources SET status='media_only',last_error=NULL,diagnostic_json=?,updated_at=? WHERE id=?`)
        .run(JSON.stringify(diagnostic),timestamp,SOURCE_ID);
      const reconcile=db.prepare(`UPDATE jobs SET status='succeeded',completed_at=COALESCE(completed_at,?),
        failure_class='',last_failure_code='',last_error=NULL,next_eligible_at=NULL,updated_at=?
        WHERE id=? AND status='failed'`);
      for (const job of JOBS) {
        if (reconcile.run(timestamp,timestamp,job.id).changes!==1) throw new Error(`Could not reconcile ${job.id}.`);
      }
      db.exec('COMMIT');
      const result={source:db.prepare('SELECT id,status,last_error FROM sources WHERE id=?').get(SOURCE_ID),
        jobs:JOBS.map((job)=>db.prepare(`SELECT id,type,entity_id,status,attempts,last_failure_code,last_error
          FROM jobs WHERE id=?`).get(job.id)),
        retainedFailureDiagnostics:Number(db.prepare(`SELECT COUNT(*) n FROM production_failure_diagnostics
          WHERE job_id IN (${JOBS.map(()=>'?').join(',')})`).get(...JOBS.map((job)=>job.id)).n || 0),
        active:Number(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')").get().n || 0)};
      console.log(JSON.stringify({mode,isLive,confirmation:digest,result},null,2));
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
} finally {
  db.close();
}
