// Final guarded continuation for WordPress #69 after version 2.0.64 made the
// frozen Writing Packet authoritative downstream. Rehearse on a fresh current
// production copy first. This queues the normal independent QA and never
// bypasses review or the guarded WordPress receipt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Repository} from '../src/repository.mjs';
import {transaction} from '../src/db.mjs';
import {freezeRequiredMediaManifest,evaluatePublicationEligibility} from '../src/publication-eligibility.mjs';
import {wordpressReceiptFingerprint} from '../src/services/delivery-refresh.mjs';

const DRAFT_ID='draft_ac2559c3c4c24d0bbee23daf89a2ddf0';
const BRIEF_ID='brief_5821e33a25534c3c8f12884ee3aee41a';
const FAILED_REVIEW_ID='review_a46eaf11b8504168942bd07c7cba0233';
const OWNER='opportunity_7c882eef78edb2ffb874e06a';
const WORDPRESS_BASELINE={status:'publish',cms_draft_id:DRAFT_ID,
  modified_gmt:'2026-09-21 17:47:55',
  page_payload_hash:'cb87ead1d6e11fc6cc5bb50ddbc6743ad10b1052a94b1a2270f032328b5f807d'};
const ROUTE_KEYS=[
  'itinerary.chongqing.day1_sequence',
  'itinerary.chongqing.day2_sequence',
  'itinerary.chongqing.day3_sequence',
];
const EXPECTED_DAY2='Huangjueya Old Street -> Huangge Ancient Road -> Longmenhao Old Street -> Xiahaoli -> Clock Tower Square -> Liangjiang Xiao Ferry';

const [mode,databaseArg,inputArg,confirmation,productionToken]=process.argv.slice(2);
if (!['plan','apply'].includes(mode) || !databaseArg || !inputArg) {
  throw new Error('usage: script plan|apply DB INPUT_DIR [CONFIRMATION] [PRODUCTION_TOKEN]');
}
const databasePath=path.resolve(databaseArg),inputDir=path.resolve(inputArg);
const livePath='/var/lib/solo-to-china/solo-to-china.sqlite';
const isLive=databasePath===livePath;
if (mode==='apply' && !isLive && !/three-day-final-work\.sqlite$/.test(databasePath)) {
  throw new Error('Apply requires the exact disposable final work DB or live DB.');
}
if (mode==='apply' && isLive && productionToken!=='THREE_DAY_FROZEN_PACKET_PRODUCTION') {
  throw new Error('Live apply requires THREE_DAY_FROZEN_PACKET_PRODUCTION.');
}
const hash=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const markdown=fs.readFileSync(path.join(inputDir,'post69-revised.md'),'utf8');
if (!markdown.includes('Pay attention not to board the train in the wrong direction')
  || !markdown.includes('Liangjiang Xiao Ferry (两江小渡)')) {
  throw new Error('Final route prose is missing its frozen evidence wording.');
}
const body=markdown.replace(/^# [^\n]+\n/,'')
  .replace(/^!\[[^\n]+\]\(day[123]-en\.png\)\s*$/gm,'')
  .replace(/^\*Day [123] visual route,[^\n]+\*\s*$/gm,'')
  .replace(/\n{3,}/g,'\n\n').trim();

const db=new DatabaseSync(databasePath,{readOnly:mode==='plan'});
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode==='plan') db.exec('PRAGMA query_only=ON');
const repo=new Repository(db);
try {
  const draft=db.prepare('SELECT id,brief_id,revision,status,content_hash FROM article_drafts WHERE id=?').get(DRAFT_ID);
  const review=db.prepare('SELECT id,passed,score,issues_json,draft_revision,draft_content_hash FROM quality_reviews WHERE id=?').get(FAILED_REVIEW_ID);
  const publication=db.prepare('SELECT post_id,status FROM wordpress_publications WHERE draft_id=?').get(DRAFT_ID);
  const active=db.prepare("SELECT COUNT(*) n FROM jobs WHERE entity_id=? AND status IN ('queued','running')").get(DRAFT_ID).n;
  const visuals=db.prepare('SELECT slot,status,wordpress_media_id FROM article_visuals WHERE draft_id=? ORDER BY slot').all(DRAFT_ID);
  const pkg=repo.getDraftPackage(DRAFT_ID);
  const factsByKey=new Map((pkg?.facts || []).map((fact)=>[fact.normalized_key,fact]));
  if (!draft || draft.brief_id!==BRIEF_ID || draft.revision!==5 || draft.status!=='qa_failed'
    || draft.content_hash!=='7078f5ea423fff18ac57533300546c111f439ff6e6435aeafd64b51d57024000'
    || !review || review.passed!==0 || review.score!==86 || active!==0
    || publication?.post_id!==69 || publication?.status!=='synced'
    || visuals.length!==3 || visuals.some((visual,index)=>visual.slot!==index+1
      || visual.status!=='generated' || !visual.wordpress_media_id)
    || factsByKey.get(ROUTE_KEYS[1])?.preferred_value!==EXPECTED_DAY2) {
    throw new Error('Final route continuation preconditions changed; stop and re-audit.');
  }
  const outline=pkg.brief.plan.outline || [];
  const ledger=outline.map((section)=>({section_id:section.section_id,section:section.heading,
    content_node_ids:[],claim_keys:section.claim_keys || [],source_ids:[...new Set((section.claim_keys || [])
      .flatMap((key)=>factsByKey.get(key)?.evidence || []).map((item)=>item.source_id).filter(Boolean))]}));
  const evidenceSections=outline.filter((section)=>(section.claim_keys || []).length);
  if (evidenceSections.some((section)=>!ledger.find((entry)=>entry.section_id===section.section_id)?.source_ids.length)) {
    throw new Error('A planned route section has no frozen source evidence.');
  }
  const snapshot={draft,failedReview:{id:review.id,score:review.score,issuesHash:hash(review.issues_json)},
    bodyHash:hash(body),packetFacts:ROUTE_KEYS.map((key)=>({key,value:factsByKey.get(key)?.preferred_value,
      sources:(factsByKey.get(key)?.evidence || []).map((item)=>item.source_id)})),visuals,
    wordpressBaseline:wordpressReceiptFingerprint(WORDPRESS_BASELINE)};
  const digest=hash(JSON.stringify(snapshot));
  if (mode==='plan') {
    console.log(JSON.stringify({mode,isLive,confirmation:digest,snapshot,
      ledger:ledger.map(({section_id,claim_keys,source_ids})=>({section_id,claim_keys,source_ids})),expectedModelCalls:1},null,2));
  } else {
    if (confirmation!==digest) throw new Error('Confirmed final route plan changed; re-plan.');
    const result=transaction(db,()=>{
      const saved=repo.saveDraft(BRIEF_ID,{...pkg.draft,body_markdown:body,evidence_ledger:ledger,
        verification_notes:[...(pkg.draft.verification_notes || []),
          'Revision 6 was rebased onto the exact frozen Writing Packet after the 2.0.64 evidence-authority fix.']},
      'operator_frozen_packet_authority_rebase',{deferReview:true,opportunityId:OWNER,preserveVisuals:true});
      if (saved!==DRAFT_ID) throw new Error('Unexpected final route draft ID.');
      const current=repo.getDraftPackage(DRAFT_ID);
      const currentLedger=new Map(current.draft.evidence_ledger.map((entry)=>[entry.section_id,entry]));
      const missing=evidenceSections.filter((section)=>!(currentLedger.get(section.section_id)?.claim_keys || [])
        .some((key)=>(section.claim_keys || []).includes(key)));
      if (current.draft.revision!==6 || missing.length) {
        throw new Error(`Frozen evidence was not retained for: ${missing.map((item)=>item.section_id).join(',')}`);
      }
      freezeRequiredMediaManifest(db,DRAFT_ID);
      const gate=evaluatePublicationEligibility(db,DRAFT_ID);
      if (!gate.passed || gate.ready!==3) throw new Error(`Final route media gate failed: ${JSON.stringify(gate)}`);
      const baseline=wordpressReceiptFingerprint(WORDPRESS_BASELINE);
      const jobId=repo.enqueue('compose_frontend_page',DRAFT_ID,{dedupeKey:`delivery-refresh:editorial:${DRAFT_ID}:r6:${baseline}`,
        workloadClass:'historical_recovery',productionOwnerOpportunityId:OWNER,pipelineVersion:'article_bundle_v1'});
      return {draftId:DRAFT_ID,revision:current.draft.revision,contentHash:current.draft.content_hash,
        evidenceHash:current.evidence_hash,ledger:current.draft.evidence_ledger,gate,jobId};
    });
    console.log(JSON.stringify({mode,isLive,confirmation:digest,result},null,2));
  }
} finally { db.close(); }
