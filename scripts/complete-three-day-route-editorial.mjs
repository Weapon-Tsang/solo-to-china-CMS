// Completes the guarded post-apply repair when the original three-day route
// migration reached QA with its pre-migration Writing Packet still frozen.
// This aligns the brief, frozen route evidence, narrative plan and prose before
// rerunning the normal quality and delivery pipeline. It never bypasses QA.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../src/repository.mjs';
import { transaction } from '../src/db.mjs';
import { freezeRequiredMediaManifest, evaluatePublicationEligibility } from '../src/publication-eligibility.mjs';
import { wordpressReceiptFingerprint } from '../src/services/delivery-refresh.mjs';
import { now } from '../src/utils.mjs';

const DRAFT_ID='draft_ac2559c3c4c24d0bbee23daf89a2ddf0';
const BRIEF_ID='brief_5821e33a25534c3c8f12884ee3aee41a';
const SOURCE_ID='src_83c65a1b23d34657a5cb259d4a68b092';
const POST_ID=69;
const FAILED_REVIEW_ID='review_beba342346d74851a68c3a2825fb31c2';
const WORDPRESS_BASELINE={status:'publish',cms_draft_id:DRAFT_ID,
  modified_gmt:'2026-09-21 17:47:55',
  page_payload_hash:'cb87ead1d6e11fc6cc5bb50ddbc6743ad10b1052a94b1a2270f032328b5f807d'};
const ROUTES=[
  {day:1,key:'itinerary.chongqing.day1_sequence',assetId:'asset_c3fbf1ff39ae41159a3a11e190f2cc7b',
    subject:'Chongqing 3-Day Itinerary Day 1',predicate:'route_sequence',
    stops:['Mountain City Trail','Jiefangbei','Baixiangju','Raffles City Chongqing / Chaotianmen','Hongyadong','Jiangtan Park'],
    quote:'Day 1: Mountain City Trail to Jiefangbei to Baixiangju to Raffles City to Hongyadong to Jiangtan Park.'},
  {day:2,key:'itinerary.chongqing.day2_sequence',assetId:'asset_121b47861c4b457bbc4d7345b9fcdf88',
    subject:'Chongqing 3-Day Itinerary Day 2',predicate:'route_sequence',
    stops:['Huangjueya Old Street','Huangge Ancient Road','Longmenhao Old Street','Xiahaoli','Clock Tower Square','Liangjiang Xiao Ferry'],
    quote:'Day 2: Huangjueya Old Street to Huangge Ancient Road to Longmenhao Old Street to Xiahaoli to Clock Tower Square to Liangjiang Xiao Ferry.'},
  {day:3,key:'itinerary.chongqing.day3_sequence',assetId:'asset_7f632cc12f274730a70429b8c41466c7',
    subject:'Chongqing 3-Day Itinerary Day 3',predicate:'route_sequence',
    stops:['Eling Park','Liziba',"Chongqing People's Great Hall",'Three Gorges Museum','Guanyinqiao','Beicang Cultural Park'],
    quote:"Day 3: Eling Park to Liziba to Chongqing People's Great Hall to Three Gorges Museum to Guanyinqiao to Beicang Cultural Park."},
];
const OUTLINE=[
  {section_id:'vertical-navigation-realities',heading:'Navigating the 3D Mountain City: Maps and Stair Traps',
    purpose:'Explain vertical map traps and practical help for visitors who do not read Chinese.',
    claim_keys:['destination.chongqing.navigation','destination.navigation.reliability']},
  {section_id:'transit-tactics-subway-vs-taxis',heading:'Transit Tactics: Metro for Distance, Taxis for Steep Connections',
    purpose:'Explain rail-direction checks and when a short taxi can conserve energy.',
    claim_keys:['destination.transport.metro.navigation_tip']},
  {section_id:'day-1-yuzhong-riverfront',heading:'Day 1: Mountain City Trail to the Riverfront',
    purpose:'Follow the first user-supplied route map without treating its arrows as guaranteed times.',
    claim_keys:['itinerary.chongqing.day1_sequence']},
  {section_id:'day-2-south-bank-ferry',heading:'Day 2: South-Bank Heritage, Then Liangjiang Xiao Ferry',
    purpose:'Follow the south-bank route and keep the ferry conditional on same-day operations.',
    claim_keys:['itinerary.chongqing.day2_sequence']},
  {section_id:'day-3-eling-jiangbei',heading:'Day 3: Eling, Liziba, Civic Landmarks and Jiangbei',
    purpose:'Follow the third route map from Eling through the civic landmarks to Jiangbei.',
    claim_keys:['itinerary.chongqing.day3_sequence']},
  {section_id:'solo-dining-pacing',heading:'Solo Dining, Pacing and Practical Decisions',
    purpose:'Close with pacing, spice-level language and same-day verification decisions.',
    claim_keys:[]},
];

const [mode,databaseArg,inputArg,confirmation,productionToken]=process.argv.slice(2);
if (!['plan','apply'].includes(mode) || !databaseArg || !inputArg) {
  throw new Error('usage: script plan|apply DB INPUT_DIR [CONFIRMATION] [PRODUCTION_TOKEN]');
}
const databasePath=path.resolve(databaseArg),inputDir=path.resolve(inputArg);
const livePath='/var/lib/solo-to-china/solo-to-china.sqlite';
const isLive=databasePath===livePath;
if (mode==='apply' && !isLive && !/three-day-followup-work\.sqlite$/.test(databasePath)) {
  throw new Error('Apply requires the exact disposable follow-up work DB or live DB.');
}
if (mode==='apply' && isLive && productionToken!=='THREE_DAY_EDITORIAL_FOLLOWUP_PRODUCTION') {
  throw new Error('Live apply requires THREE_DAY_EDITORIAL_FOLLOWUP_PRODUCTION.');
}
const sha=(value)=>crypto.createHash('sha256').update(value).digest('hex');
const sourceMarkdown=fs.readFileSync(path.join(inputDir,'post69-revised.md'),'utf8');
if (!sourceMarkdown.includes('## Transit Tactics: Metro for Distance, Taxis for Steep Connections')
  || !sourceMarkdown.includes('20–30 RMB') || !sourceMarkdown.includes('微微辣')
  || !sourceMarkdown.includes('两江小渡')) throw new Error('Revised route prose is incomplete or mis-encoded.');
const body=sourceMarkdown.replace(/^# [^\n]+\n/,'')
  .replace(/^!\[[^\n]+\]\(day[123]-en\.png\)\s*$/gm,'')
  .replace(/^\*Day [123] visual route,[^\n]+\*\s*$/gm,'')
  .replace(/\n{3,}/g,'\n\n').trim();
for (const section of OUTLINE) {
  if (!body.includes(`## ${section.heading}`)) {
    throw new Error(`Article body and repaired writing-packet outline diverge at ${section.section_id}.`);
  }
}
for (const route of ROUTES) {
  if (!body.includes(`## Day ${route.day}:`) || route.stops.some((stop)=>!body.includes(stop))) {
    throw new Error(`Day ${route.day} prose does not match the confirmed route.`);
  }
}

const db=new DatabaseSync(databasePath,{readOnly:mode==='plan'});
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
if (mode==='plan') db.exec('PRAGMA query_only=ON');
const repo=new Repository(db);
try {
  const draft=db.prepare('SELECT * FROM article_drafts WHERE id=?').get(DRAFT_ID);
  const publication=db.prepare('SELECT post_id,status FROM wordpress_publications WHERE draft_id=?').get(DRAFT_ID);
  const review=db.prepare('SELECT * FROM quality_reviews WHERE id=?').get(FAILED_REVIEW_ID);
  const active=db.prepare("SELECT COUNT(*) n FROM jobs WHERE entity_id=? AND status IN ('queued','running')").get(DRAFT_ID).n;
  const source=db.prepare('SELECT id,raw_text,canonical_url,title,captured_at FROM sources WHERE id=?').get(SOURCE_ID);
  const visuals=db.prepare(`SELECT id,slot,status,source_asset_id,media_path,wordpress_media_id
    FROM article_visuals WHERE draft_id=? ORDER BY slot`).all(DRAFT_ID);
  const owner=db.prepare(`SELECT production_owner_opportunity_id id FROM jobs WHERE entity_id=?
    AND production_owner_opportunity_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(DRAFT_ID)?.id;
  if (!draft || draft.brief_id!==BRIEF_ID || draft.revision!==4 || draft.status!=='qa_failed'
    || draft.content_hash!=='5fca32ad13c4544648bcc7b07d17f8ce885fec186b6bb22ea409b6a2f3ea565d'
    || !review || review.passed!==0 || active!==0 || !source || !owner
    || publication?.post_id!==POST_ID || publication?.status!=='synced'
    || visuals.length!==3 || visuals.some((visual,index)=>visual.status!=='generated'
      || visual.source_asset_id!==ROUTES[index].assetId || !visual.media_path || !visual.wordpress_media_id)) {
    throw new Error('Route follow-up preconditions changed; stop and re-audit.');
  }
  const snapshot={draftId:DRAFT_ID,revision:draft.revision,contentHash:draft.content_hash,
    failedReviewId:review.id,failedReviewHash:sha(review.issues_json),sourceId:source.id,
    sourceHash:sha(source.raw_text),bodyHash:sha(body),owner,postId:publication.post_id,
    visuals:visuals.map(({slot,source_asset_id,wordpress_media_id})=>({slot,source_asset_id,wordpress_media_id})),
    wordpressBaseline:wordpressReceiptFingerprint(WORDPRESS_BASELINE)};
  const digest=sha(JSON.stringify(snapshot));
  if (mode==='plan') {
    console.log(JSON.stringify({mode,isLive,confirmation:digest,snapshot,outline:OUTLINE,
      routeEvidence:ROUTES.map(({day,key,assetId,stops})=>({day,key,assetId,stops})),expectedModelCalls:1},null,2));
  } else {
    if (confirmation!==digest) throw new Error('Confirmed follow-up plan changed; re-plan.');
    const result=transaction(db,()=>{
      const timestamp=now();
      repo.saveExtraction(SOURCE_ID,{
        source:{language:'mixed',summary:'Three user-supplied route collages for the approved Chongqing three-day article.',
          destination_name:'Chongqing',destination_slug:'chongqing',traveler_fit:['solo travelers','first-time visitors'],
          practical_tips:['Treat transfer labels as estimates and verify ferry operations on the day.'],warnings:[],confidence:1},
        claims:ROUTES.map((route)=>({key:route.key,subject:route.subject,predicate:route.predicate,
          value:route.stops.join(' -> '),qualifiers:[`Day ${route.day}`,'user-supplied route collage'],
          source_quote:route.quote,confidence:1,claim_role:'editorial_metadata',knowledge_eligible:false,
          _asset_id:route.assetId})),
        blueprint:{format:'three-day route collage',hook:'Three illustrated day routes',
          angle:'A flexible route framework with explicit timing and ferry caveats',sections:OUTLINE.map((item)=>item.heading),
          strengths:['Explicit stop order','Visual route context'],gaps:['Transfer times and operations require same-day checks']},
      },'operator_assisted_editorial','user_supplied_route_maps',{deferDownstream:true});

      const brief=db.prepare('SELECT plan_json,canonical_json FROM content_briefs WHERE id=?').get(BRIEF_ID);
      const plan=JSON.parse(brief.plan_json || '{}'),canonical=JSON.parse(brief.canonical_json || '{}');
      plan.outline=OUTLINE;
      plan.reader_promise='Follow three user-supplied Chongqing day routes with realistic vertical-navigation, transit, pacing and same-day verification advice.';
      plan.angle='A flexible three-day route that follows the supplied day maps while treating transfer times and ferry operations as conditional.';
      plan.adaptation_requirements=[
        'Explain that pedestrian bridges, underpasses and stacked roads can make a 2D map misleading, especially for visitors who do not read Chinese.',
        'Use the source benchmark of 20–30 RMB only as a variable intra-district taxi estimate, not a guaranteed fare.',
        'Tell readers to verify the terminal direction shown on the rail platform before boarding.',
        "Explain that Chongqing's standard 微辣 can be hotter than mild elsewhere and suggest 微微辣 for spice-sensitive readers.",
      ];
      plan.verification_instructions=[
        'Treat every walking, taxi and metro duration printed in a route image as an estimate.',
        'Verify Liangjiang Xiao Ferry operations, boarding point and ticket availability on the travel day.',
        'Verify venue opening hours before entering an indoor attraction.',
      ];
      plan.canonical={...(plan.canonical || {}),content_type:'itinerary',
        summary:'A flexible three-day Chongqing route following Yuzhong on Day 1, the south-bank heritage corridor and optional ferry on Day 2, then Eling, civic landmarks and Jiangbei on Day 3.',
        quick_answer:'Use the three supplied day routes as geographic frameworks, not strict timetables; conserve energy with selective taxi hops and verify the ferry and venue hours on the day.',
        entities:[...new Set(ROUTES.flatMap((route)=>route.stops))]};
      canonical.summary=plan.canonical.summary;
      canonical.quick_answer=plan.canonical.quick_answer;
      canonical.entities=plan.canonical.entities;
      db.prepare('UPDATE content_briefs SET plan_json=?,canonical_json=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(plan),JSON.stringify(canonical),timestamp,BRIEF_ID);

      const routeSequence=OUTLINE.map((item)=>item.section_id);
      db.prepare(`UPDATE narrative_plans SET opening_job=?,throughline=?,route_sequence_json=?,
        supporting_fact_keys_json=?,conditional_branches_json=?,tradeoffs_json=?,updated_at=? WHERE brief_id=?`)
        .run('Set expectations for a flexible route through a vertically layered city.',
          'Follow the three supplied day maps while distinguishing route order from guaranteed travel times.',
          JSON.stringify(routeSequence),JSON.stringify(OUTLINE.flatMap((item)=>item.claim_keys)),
          JSON.stringify(['Skip a stop when terrain, weather, queues or ferry operations make the full route impractical.']),
          JSON.stringify(['Use a short taxi to conserve energy when a map-convenient link requires a steep vertical transfer.']),timestamp,BRIEF_ID);

      const packet=db.prepare('SELECT * FROM writing_packets WHERE brief_id=?').get(BRIEF_ID);
      const packetFacts=JSON.parse(packet.evidence_ledger_json || '[]');
      const sourceRow=db.prepare('SELECT canonical_url,title,captured_at FROM sources WHERE id=?').get(SOURCE_ID);
      const claims=new Map(db.prepare(`SELECT id,normalized_key,subject,predicate,value_text,qualifiers_json,
        source_quote,confidence,created_at FROM claims WHERE source_id=?`).all(SOURCE_ID).map((row)=>[row.normalized_key,row]));
      const replacement=new Map(ROUTES.map((route)=>{
        const claim=claims.get(route.key);
        if (!claim) throw new Error(`Route Claim missing after extraction: ${route.key}`);
        const evidence={claim_id:claim.id,source_id:SOURCE_ID,value:claim.value_text,
          quote:claim.source_quote,qualifiers:JSON.parse(claim.qualifiers_json || '[]'),confidence:claim.confidence,
          canonical_url:sourceRow.canonical_url,source_title:sourceRow.title,captured_at:sourceRow.captured_at,
          publication_usability:'usable',evidence_coverage:'complete',coverage_limitations:[],
          evidence_role:'current',verified_at:timestamp};
        const factSnapshot={normalized_key:route.key,subject:route.subject,canonical_subject:route.subject,
          predicate:route.predicate,preferred_value:claim.value_text,consensus_status:'operator_confirmed_source',
          freshness_state:'current',verification_priority:'normal',latest_evidence_at:timestamp,
          consensus_method:'USER_PROVIDED_EDITORIAL_SOURCE',consensus_confidence:1,validity_state:'current',
          selection_frozen:true,evidence:[evidence]};
        return [route.key,{version:2,key:route.key,subject:route.subject,predicate:route.predicate,
          value:claim.value_text,status:'operator_confirmed_source',fact_snapshot:factSnapshot,
          sources:[{claim_id:claim.id,source_id:SOURCE_ID,quote:claim.source_quote,
            url:sourceRow.canonical_url,qualifiers:evidence.qualifiers,valid_from:null,valid_to:null}]}];
      }));
      const nextFacts=packetFacts.map((entry)=>replacement.get(entry.key) || entry);
      for (const route of ROUTES) if (!nextFacts.some((entry)=>entry.key===route.key)) nextFacts.push(replacement.get(route.key));
      const context=JSON.parse(packet.context_json || '{}');
      const narrative=repo.getNarrativePlan(BRIEF_ID);
      context.narrative_plan=narrative;
      context.authorized_source_assets=[...(context.authorized_source_assets || []).filter((asset)=>
        !ROUTES.some((route)=>route.assetId===(asset.id || asset.source_asset_id))),
        ...ROUTES.map((route)=>({id:route.assetId,source_id:SOURCE_ID,asset_kind:'editorial_infographic',
          alt_text:`Chongqing Day ${route.day} route collage`,primary_subjects:route.stops,
          entities:route.stops.map((name)=>({name})),language_status:'mixed',
          original_bytes_status:'saved_original',durability_status:'ORIGINAL_STORED'}))];
      const selectedKeys=[...new Set(nextFacts.map((entry)=>entry.key))];
      const packetText=['ARTICLE GOAL',plan.reader_promise,'','EVIDENCE-BOUND SECTION ORDER',
        ...OUTLINE.map((item,index)=>`${index+1}. ${item.heading}`),'','ROUTE EVIDENCE',
        ...ROUTES.map((route)=>`- Day ${route.day}: ${route.stops.join(' -> ')}`),'',
        'Treat image transfer times as estimates and preserve the ferry qualification.'].join('\n');
      const inputHash=sha(JSON.stringify({narrative,packetText,nextFacts,context}));
      db.prepare(`UPDATE writing_packets SET packet_text=?,evidence_ledger_json=?,selected_fact_keys_json=?,
        input_hash=?,context_json=?,updated_at=? WHERE brief_id=?`)
        .run(packetText,JSON.stringify(nextFacts),JSON.stringify(selectedKeys),inputHash,
          JSON.stringify(context),timestamp,BRIEF_ID);

      const pkg=repo.getDraftPackage(DRAFT_ID);
      const sourceIdsFor=(keys)=>[...new Set(nextFacts.filter((entry)=>keys.includes(entry.key))
        .flatMap((entry)=>entry.fact_snapshot?.evidence || []).map((item)=>item.source_id).filter(Boolean))];
      const evidenceLedger=OUTLINE.map((section)=>({section_id:section.section_id,section:section.heading,
        content_node_ids:[],claim_keys:section.claim_keys,source_ids:sourceIdsFor(section.claim_keys)}));
      const savedId=repo.saveDraft(BRIEF_ID,{...pkg.draft,body_markdown:body,evidence_ledger:evidenceLedger,
        verification_notes:[...(pkg.draft.verification_notes || []),
          'The brief, narrative plan and frozen day-route evidence were aligned to the three user-supplied route collages after a stale-plan QA failure.']},
      'operator_route_packet_alignment',{deferReview:true,opportunityId:owner,preserveVisuals:true});
      if (savedId!==DRAFT_ID) throw new Error('Unexpected route draft ID.');
      const current=db.prepare('SELECT revision,content_hash,body_markdown FROM article_drafts WHERE id=?').get(DRAFT_ID);
      if (current.revision!==5 || current.body_markdown!==body) throw new Error('Route follow-up did not create revision 5.');
      freezeRequiredMediaManifest(db,DRAFT_ID);
      const gate=evaluatePublicationEligibility(db,DRAFT_ID);
      if (!gate.passed || gate.ready!==3) throw new Error(`Route follow-up media gate failed: ${JSON.stringify(gate)}`);
      const baseline=wordpressReceiptFingerprint(WORDPRESS_BASELINE);
      const jobId=repo.enqueue('compose_frontend_page',DRAFT_ID,{dedupeKey:`delivery-refresh:editorial:${DRAFT_ID}:r5:${baseline}`,
        workloadClass:'historical_recovery',productionOwnerOpportunityId:owner,pipelineVersion:'article_bundle_v1'});
      return {draftId:DRAFT_ID,revision:current.revision,contentHash:current.content_hash,
        routeClaims:[...claims.values()].map((claim)=>({id:claim.id,key:claim.normalized_key})),gate,jobId};
    });
    console.log(JSON.stringify({mode,isLive,confirmation:digest,result},null,2));
  }
} finally { db.close(); }
