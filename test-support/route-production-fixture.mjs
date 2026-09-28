import { normalizeXiaohongshuCapture } from '../src/adapters/xiaohongshu.mjs';
import { routeFixture } from './route-fixture.mjs';

// Only initial source/approval inputs are seeded. Production jobs and artifacts
// are created by the repository/Pipeline, never marked successful by fixture SQL.
export function seedRouteProduction(repository,{dayCount=1,requiredSchematic=false,images=[],unknownDuration=false,
  sourceSuffix='a2-route-fixture',sourceOnly=false,transportMode='walk'}={}) {
  const db=repository.db;
  const {fragment,input:raw}=routeFixture();
  if(unknownDuration)fragment.legs[0].field_evidence=[{field:'duration',value:null,status:'unknown',evidence_span_ids:[]}];
  let quote=raw.evidence_spans[0].quote;
  if(transportMode!=='walk'){fragment.legs[0].mode=transportMode;quote=quote.replace(/Walk/i,transportMode);}
  if(dayCount>1) {
    const template=structuredClone(fragment);
    fragment.days=[];fragment.stops=[];fragment.legs=[];
    quote=Array.from({length:dayCount},(_,i)=>raw.evidence_spans[0].quote.replace('Day 1',`Day ${i+1}`)).join('\n');
    for(let i=1;i<=dayCount;i++) {
      fragment.days.push({...template.days[0],key:String(i),sequence:i,label:`Day ${i}`});
      fragment.stops.push(...template.stops.map(stop=>({...stop,key:`${i}-${stop.key}`,day_key:String(i)})));
      fragment.legs.push(...template.legs.map(leg=>({...leg,key:`${i}-${leg.key}`,from_key:`${i}-${leg.from_key}`,to_key:`${i}-${leg.to_key}`})));
    }
  }
  if(images.length)quote+='\nPhoto 1 depicts East Hall.';
  const source=repository.saveCapture(normalizeXiaohongshuCapture({url:`https://www.xiaohongshu.com/explore/${sourceSuffix}`,
    title:'Beijing one-day route',text:quote,images}));
  const extraction={source:{language:'en',summary:quote,destination_name:'Beijing',destination_slug:'beijing',
    traveler_fit:['solo'],practical_tips:[],warnings:[],confidence:0.9},
    claims:[{key:'beijing.route.sequence',subject:'Beijing route',predicate:'route sequence',value:quote,qualifiers:[],source_quote:quote,confidence:0.9}],
    blueprint:{format:'itinerary',hook:'Route',angle:'Route',sections:[],strengths:[],gaps:[]}};
  const segments=repository.prepareSourceSegments(source.id);
  for(const segment of segments) {
    const stored=db.prepare('SELECT * FROM source_segments WHERE id=?').get(segment.id);
    const modality=stored.asset_id?'image':'text';
    const result=stored.asset_id?extraction:{...extraction,claims:extraction.claims.map(c=>({...c,source_quote:stored.raw_text,value:stored.raw_text}))};
    repository.saveSegmentExtraction(segment.id,{method:'fixture',model:'controlled-source',result,
      inputManifest:{version:1,expectedModality:modality,receivedModality:modality,provider:'controlled-source',model:'fixture',
        capabilities:{text:true,image:true},assets:stored.asset_id?[{assetId:stored.asset_id,kind:'image',status:'submitted',requestReference:'local-fixture'}]:[]}});
    repository.auditSegmentCoverage(segment.id,{uncovered_spans:[],modality:{received:modality,attempted:1}});
  }
  repository.finalizeSegmentedExtraction(source.id);
  repository.rebuildKnowledge('beijing');
  const input=repository.getExperienceExtractionPackage(source.id);
  if(!input?.evidence_spans.length) throw new Error('Fixture requires actual source evidence spans.');
  for(const collection of ['days','stops','legs'])for(const item of fragment[collection]) item.evidence_span_ids=[input.evidence_spans[0].id];
  repository.saveExperienceExtraction(source.id,{blocks:[],route_fragments:[fragment]},'controlled-source',input);
  for(const [id,name] of [['east','East Hall'],['west','West Hall']]) db.prepare(`INSERT OR IGNORE INTO entity_aliases
    (id,destination_slug,alias_normalized,entity_key,canonical_subject,aliases_json,resolution_source,confidence,created_at,updated_at,entity_type,granularity)
    VALUES (?,'beijing',?,?,?,'[]','manual',1,'now','now','attraction','specific_entity')`).run(`route-${id}`,name.toLowerCase(),id,name);
  if(sourceOnly)return {source,input,fragment};
  db.prepare(`INSERT INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,created_at,updated_at)
    VALUES ('route-candidate','beijing','a2-route','Beijing one-day itinerary','fixture',1,1,0,'now','now')`).run();
  db.prepare(`INSERT INTO content_opportunities(id,destination_slug,topic_key,strategy_version,source_id,candidate_id,title,content_type,readiness_score,
    coverage_json,status,approved_at,created_at,updated_at) VALUES ('route-owner','beijing','a2-route','3.9',?,'route-candidate',
    'Beijing one-day itinerary','itinerary',100,?,'approved_ready','2026-09-28','now','now')`)
    .run(source.id,JSON.stringify({publicationMode:'source_adaptation',approval:{proposal:{content_type:'itinerary',title:'Beijing one-day itinerary'},
      route_media_obligations:requiredSchematic?[{slot_id:'route-schematic',kind:'schematic',use:'route_overview',required:true}]:[]}}));
  return {source,input,fragment,candidateId:'route-candidate',ownerId:'route-owner'};
}
