import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { selectedFamilyProjection, FAMILY_EVIDENCE_VERSION } from '../src/opportunity-family-evidence.mjs';
import { evaluateCoverage } from '../src/research-strategy.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const allowedFields = ['readiness_json.sourceFamilyCount','coverage_json.readiness.sourceFamilyCount'];
export function previewRepair(db, ids, identity) {
  if (!ids.length || ids.length>20 || new Set(ids).size!==ids.length) throw new Error('Supply 1..20 unique exact IDs');
  const records = ids.map(id => {
    const row = db.prepare('SELECT * FROM content_opportunities WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown opportunity: ${id}`);
    const coverage=JSON.parse(row.coverage_json),readiness=JSON.parse(row.readiness_json);
    if (!coverage.knowledgeEventGenerated || row.source_id) throw new Error(`Not a knowledge opportunity: ${id}`);
    const p=selectedFamilyProjection(db,row);
    const expected=evaluateCoverage({topicKey:row.topic_key,contentType:row.content_type,facts:p.facts,
      sourceFamilyCount:p.families.length,publicationMode:coverage.publicationMode}).readiness;
    const linkedProduction=Boolean(db.prepare('SELECT 1 FROM topic_candidates WHERE opportunity_id=? LIMIT 1').get(id)
      || db.prepare('SELECT 1 FROM editorial_assemblies WHERE opportunity_id=? LIMIT 1').get(id));
    const protectedDecision=Boolean(linkedProduction || row.approved_at || row.candidate_id || coverage.approval
      || !['recommended','recommended_again','deferred'].includes(row.lifecycle_state));
    const eligibilityChanged=['ready','editoriallySufficient','score','factCount'].some(k=>expected[k]!==readiness[k]);
    const blocked=protectedDecision || eligibilityChanged || p.missing>0 || p.unusable>0
      || p.facts.length<2 || p.families.length<2 || Number(readiness.sourceFamilyCount)<2;
    const afterReadiness={...readiness,sourceFamilyCount:p.families.length};
    const afterCoverage={...coverage,readiness:{...coverage.readiness,sourceFamilyCount:p.families.length}};
    if (!coverage.readiness || Number(coverage.readiness.sourceFamilyCount)!==Number(readiness.sourceFamilyCount))
      throw new Error(`Inconsistent stored readiness copies: ${id}`);
    return {id,before:Number(readiness.sourceFamilyCount),after:p.families.length,
      reason:'Count only usable selected facts, not excluded cluster facts',families:p.families,
      dependencyFingerprint:p.dependencyFingerprint,recordFingerprint:hash(row),blocked,
      protectedDecision,linkedProduction,eligibilityChanged,missing:p.missing,unusable:p.unusable,
      changed:Number(readiness.sourceFamilyCount)!==p.families.length,
      afterReadiness:JSON.stringify(afterReadiness),afterCoverage:JSON.stringify(afterCoverage),
      postFingerprint:hash({...row,readiness_json:JSON.stringify(afterReadiness),coverage_json:JSON.stringify(afterCoverage)})};
  });
  const plan={version:FAMILY_EVIDENCE_VERSION,identity,ids,allowedFields,records};
  return {...plan,previewFingerprint:hash(plan)};
}

export function applyRepair(db, preview, identity, {afterUpdate=()=>{}}={}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current=previewRepair(db,preview.ids,identity);
    if (JSON.stringify(identity)!==JSON.stringify(preview.identity)) throw new Error('Database identity mismatch');
    if (current.previewFingerprint!==preview.previewFingerprint) {
      // A repeated exact plan is a no-op only if dependencies and full postimages still match.
      const idempotent=current.records.every((r,i)=>{
        const old=preview.records[i],row=db.prepare('SELECT * FROM content_opportunities WHERE id=?').get(r.id);
        return !r.changed && !r.blocked && r.dependencyFingerprint===old.dependencyFingerprint
          && r.recordFingerprint===old.postFingerprint
          && row.readiness_json===old.afterReadiness && row.coverage_json===old.afterCoverage;
      });
      if (!idempotent) throw new Error('Stale preview; dependency or record changed');
      db.exec('ROLLBACK');return {changed:0,idempotent:true};
    }
    if(current.records.some(r=>r.blocked)) throw new Error('Protected decision, invalid evidence or eligibility change requires a separate proposal');
    let changed=0;
    for(const r of current.records.filter(r=>r.changed)) {
      db.prepare('UPDATE content_opportunities SET readiness_json=?,coverage_json=? WHERE id=?')
        .run(r.afterReadiness,r.afterCoverage,r.id);
      changed++;afterUpdate(r);
    }
    db.exec('COMMIT');return {changed,idempotent:false};
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
  if(!args.includes('--database') || !args.includes('--ids')) throw new Error('--database and --ids are required');
  const filename=fs.realpathSync(value('--database')),stat=fs.statSync(filename);
  const identity={path:filename,device:String(stat.dev),inode:String(stat.ino)};
  const apply=args.includes('--apply');
  if(apply) {
    if(!args.includes('--isolation-manifest') || !args.includes('--preview')) throw new Error('Apply requires an isolation manifest and saved preview');
    const manifest=JSON.parse(fs.readFileSync(value('--isolation-manifest'),'utf8'));
    if(manifest.kind!=='disposable-family-replay' || JSON.stringify(manifest.identity)!==JSON.stringify(identity))
      throw new Error('Apply is permitted only on the explicitly identified disposable database');
  }
  const db=new DatabaseSync(filename,{readOnly:!apply});
  try {
    if(apply) {
      const preview=JSON.parse(fs.readFileSync(value('--preview'),'utf8'));
      if(JSON.stringify(value('--ids').split(','))!==JSON.stringify(preview.ids)) throw new Error('Exact IDs do not match preview');
      console.log(JSON.stringify(applyRepair(db,preview,identity),null,2));
    } else {
      db.exec('PRAGMA query_only=ON; BEGIN');
      console.log(JSON.stringify(previewRepair(db,value('--ids').split(','),identity),null,2));
      db.exec('ROLLBACK');
    }
  } finally {db.close();}
}
