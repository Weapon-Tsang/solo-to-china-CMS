import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { decideVisualAsset, normalizeVisuals, visualQualityQaStatus } from "../src/repository.mjs";

const draft = { title: "A Practical Beijing Guide", body_markdown: "Useful body text." };
const brief = { destination_slug: "beijing" };
const policy = { visuals: { minimum: 3, target: 4, maximum: 5 } };

test("visual planning preserves the writer count when no relevant authorized source asset exists", () => {
  const one = normalizeVisuals([{ image_type:"illustration",image_subject:"Beijing street" }],draft,brief,[],policy);
  assert.equal(one.length,1);
  assert.equal(one[0].acquisition_strategy,"generate_illustration");
  assert.deepEqual(normalizeVisuals([],draft,brief,[],policy),[]);
});

test("a missing writer visual plan deterministically uses relevant project-authorized source originals", () => {
  const assets = [
    { id:"asset-relevant",remote_url:"https://media.example/china.jpg",mime_type:"image/jpeg",
      alt_text:"Beijing hutong street",caption_text:"Walking through a Beijing hutong",nearby_text:"Beijing street route",
      evidence_text:"Beijing walking route",language_status:"no_text",width:1600,height:900,storage_status:"saved",
      original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED" },
    { id:"asset-unrelated",remote_url:"https://media.example/food.jpg",mime_type:"image/jpeg",
      alt_text:"Shanghai restaurant dish",caption_text:"Dinner",nearby_text:"Shanghai food",evidence_text:"restaurant",
      language_status:"no_text",width:800,height:800,storage_status:"saved",
      original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED" },
  ];
  const output = normalizeVisuals([], { ...draft, body_markdown:"Walk a Beijing hutong route." }, brief, assets, policy);
  assert.equal(output.length,1);
  assert.equal(output[0].source_asset_id,"asset-relevant");
  assert.equal(output[0].status,"generated");
  assert.equal(output[0].acquisition_strategy,"use_authorized_source_image");
  assert.equal(output[0].aspect_ratio,"16:9");
  assert.equal(output[0].media_metadata.authorization_policy,"project_source_media_full_authorization");
});

test("article fallback rejects a destination-wide asset that shares only one generic word",()=>{
  const assets=[
    {id:"duck",remote_url:"https://media.example/duck.jpg",mime_type:"image/jpeg",
      alt_text:"Baishiyi pressed duck",caption_text:"",nearby_text:"",evidence_text:"Chongqing food",
      language_status:"no_text",width:1600,height:900,storage_status:"saved",
      original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"},
    {id:"other-old-street",remote_url:"https://media.example/other.jpg",mime_type:"image/jpeg",
      alt_text:"",caption_text:"",nearby_text:"",evidence_subject:"Danzishi Old Street",
      language_status:"no_text",width:1600,height:900,storage_status:"saved",
      original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"},
  ];
  const output=normalizeVisuals([],{title:"Ciqikou Ancient Town",body_markdown:"Walk the old lanes and try local food."},
    {destination_slug:"chongqing"},assets,{visuals:{target:1,maximum:5}});
  assert.deepEqual(output,[]);
});

test("authorized fallback photos never expose raw Claim keys as reader alt text", () => {
  const assets = [{ id:"asset-claim-dump",remote_url:"https://media.example/chongqing.jpg",mime_type:"image/jpeg",
    alt_text:"",caption_text:"",nearby_text:"",evidence_subject:"Guotai Arts Center",
    evidence_text:"Guotai Arts Center admission_fee free Guotai Arts Center opening_hours 09:00-17:00",
    language_status:"no_text",width:1600,height:900,storage_status:"saved",
    original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED" }];
  const output = normalizeVisuals([], {
    title:"Chongqing Landmarks",body_markdown:"Visit Guotai Arts Center on a Chongqing landmarks route.",
  }, { destination_slug:"chongqing" }, assets, policy);
  assert.equal(output.length,1);
  assert.equal(output[0].alt_text,"Photo of Guotai Arts Center in Chongqing.");
  assert.doesNotMatch(output[0].alt_text,/admission_fee|opening_hours/);
});

test("unsupported map and infographic renderers create no fake visual plan", () => {
  const output = normalizeVisuals([
    { image_type:"map_or_route",image_subject:"Subway route" },
    { image_type:"infographic",image_subject:"Ticket steps" },
  ],draft,brief,[],policy);
  assert.deepEqual(output,[]);
});

test("a real-world photo is selected only when an original authorized source asset matches and unknown image content is analyzed", () => {
  const requested = [{ image_type:"real_world_photo",image_subject:"Forbidden City gate" }];
  assert.deepEqual(normalizeVisuals(requested,draft,brief,[],policy),[]);
  const asset = { id:"asset-1",remote_url:"https://example.test/original.jpg",mime_type:"image/jpeg",
    alt_text:"Forbidden City gate",caption_text:"Forbidden City gate",nearby_text:"Forbidden City gate",evidence_text:"Forbidden City gate",
    language_status:"chinese",storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED",
    source_authorization_status:"legacy",source_publishable:0,asset_authorization_status:"legacy",asset_publishable:0 };
  const output = normalizeVisuals(requested,draft,brief,[asset],policy);
  assert.equal(output.length,1);
  assert.equal(output[0].acquisition_strategy,"analyze_source_image");
  assert.equal(output[0].source_asset_id,"asset-1");
  assert.equal(output[0].media_metadata.source_provenance.original_stored,true);
  assert.equal(output[0].media_metadata.source_provenance.project_owner_confirmed,true);
});

test("an explicit source id cannot bypass subject relevance for a factual hero",()=>{
  const requested=[{source_asset_id:"broad-map",image_type:"real_world_photo",image_role:"hero",
    image_subject:"Steep flagstone lane in Ciqikou Ancient Town with Bayu stilt houses and lanterns",
    purpose:"Show the historic Ciqikou streets and traditional hillside architecture"}];
  const assets=[{id:"broad-map",remote_url:"https://media.example/chongqing-itinerary.webp",mime_type:"image/webp",
    alt_text:"",caption_text:"",nearby_text:"",evidence_text:"",analysis_status:"ready",
    asset_kind:"editorial_infographic",analysis_version:"media-analysis-2",reader_text_present:true,
    primary_subjects:["Chongqing travel guide infographic","Tourist map of Chongqing"],
    entities:["Ciqikou Ancient Town","Hongyadong","Dazu Rock Carvings"],language_status:"chinese",
    text_regions:[{region_id:"map_poi_1",text:"磁器口",role:"editorial_text",language:"zh",readable:true,preserve:false}],
    photo_regions:[],storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"}];
  const output=normalizeVisuals(requested,{title:"Ciqikou Ancient Town",body_markdown:"Walk Ciqikou's flagstone lanes."},
    {destination_slug:"chongqing"},assets,{visuals:{target:1,maximum:5}});
  assert.deepEqual(output,[]);
});

test("a complex itinerary classified as an editorial infographic is routed as a map",()=>{
  const decision=decideVisualAsset({analysis_status:"ready",asset_kind:"editorial_infographic",
    analysis_version:"media-analysis-2",reader_text_present:true,language_status:"chinese",
    primary_subjects:["Tourist map of Chongqing"],photo_regions:[],text_regions:[
      {region_id:"map_poi_1",text:"磁器口",role:"editorial_text",language:"zh",readable:true,preserve:false},
      {region_id:"route_stop_2",text:"洪崖洞",role:"editorial_text",language:"zh",readable:true,preserve:false},
    ]});
  assert.equal(decision.visualClass,"map_or_route");
  assert.equal(decision.transformKind,"MAP_OR_ROUTE");
  assert.equal(decision.reason,"route_structure_requires_map_recomposition");
});

test("the shared visual decision blocks unclassified text while preserving authentic signs", () => {
  assert.equal(decideVisualAsset({ language_status:"unknown", visual_class:"text_overlay", width:1200, height:800 }).action,"analyze");
  assert.equal(decideVisualAsset({ language_status:"chinese", visual_class:"text_overlay", width:1200, height:800 }).action, "analyze");
  assert.equal(decideVisualAsset({ language_status:"chinese", visual_class:"handwritten", width:1200, height:800 }).action, "analyze");
  assert.equal(decideVisualAsset({ analysis_status:"ready",language_status:"chinese", asset_kind:"documentary_photo",
    analysis_version:"media-analysis-2",reader_text_present:true,
    text_regions:[{region_id:"sign",text:"重庆站",language:"zh-CN",role:"real_world_signage",readable:true,preserve:true}],
    alt_text:"Historic station name sign", width:1200, height:800 }).action, "retain");
});

test("unanalysed high-resolution source images never default to text-free documentary photos", () => {
  const decision = decideVisualAsset({
    language_status:"unknown", width:2400, height:3200, alt_text:"Chongqing travel guide design",
  });
  assert.equal(decision.action, "analyze");
  assert.equal(decision.reason, "image_analysis_required");
  assert.equal(decision.visualClass, "unknown");
});

test("sign matching is token bounded and a storefront collage localizes only author overlays", () => {
  assert.equal(decideVisualAsset({
    analysis_status:"ready", asset_kind:"editorial_infographic", reader_text_present:true,
    analysis_version:"media-analysis-2",
    text_regions:[{ region_id:"copy", text:"开放时间",language:"zh-CN", role:"author_overlay",readable:true,preserve:false }],
    alt_text:"A red and black travel design",
  }).transformKind, "EDITORIAL_CARD_RECOMPOSE");
  const collage = decideVisualAsset({
    analysis_status:"ready", asset_kind:"photo_collage", reader_text_present:true,
    analysis_version:"media-analysis-2",text_regions:[
      { region_id:"sign", text:"重庆站",language:"zh-CN", role:"real_world_signage",readable:true,preserve:true },
      { region_id:"caption", text:"步行3分钟",language:"zh-CN", role:"author_overlay",readable:true,preserve:false },
    ],
    primary_subjects:["storefronts"], alt_text:"Three storefronts with author captions",
  });
  assert.equal(collage.action, "localize");
  assert.equal(collage.transformKind, "COLLAGE_RECOMPOSE");
  assert.deepEqual(collage.preserveRegionIds, ["sign"]);
  assert.deepEqual(collage.translateRegionIds, ["caption"]);
});

test("legacy or incomplete text analysis is re-run before any English recomposition",()=>{
  for (const asset of [
    {analysis_status:"ready",asset_kind:"handwritten_card",reader_text_present:true,analysis_version:"media-analysis-1",
      text_regions:[{}],language_status:"chinese"},
    {analysis_status:"needs_review",asset_kind:"editorial_infographic",reader_text_present:true,analysis_version:"media-analysis-2",
      text_regions:[{region_id:"one",text:"营业时间",role:"editorial_text",language:"zh",readable:true,preserve:false}],language_status:"chinese"},
  ]) {
    const decision=decideVisualAsset(asset);
    assert.equal(decision.action,"analyze");
    assert.equal(decision.transformKind,"ANALYZE_SOURCE_IMAGE");
  }
  const complete=decideVisualAsset({analysis_status:"ready",asset_kind:"photo_collage",reader_text_present:true,
    analysis_version:"media-analysis-2",language_status:"mixed",text_regions:[
      {region_id:"caption",text:"步行3分钟",role:"author_overlay",language:"zh",readable:true,preserve:false},
      {region_id:"sign",text:"重庆",role:"real_world_signage",language:"zh",readable:true,preserve:true},
    ]});
  assert.equal(complete.transformKind,"COLLAGE_RECOMPOSE");
  assert.deepEqual(complete.translateRegionIds,["caption"]);
  assert.deepEqual(complete.preserveRegionIds,["sign"]);
});

test("four-field visual QA is aggregated instead of trusting a cosmetic top-level label",()=>{
  const passed=Object.fromEntries(["language","completeness","style","semantic"].map((field)=>[field,{status:"passed",reason:"ok"}]));
  assert.equal(visualQualityQaStatus(passed),"passed");
  assert.equal(visualQualityQaStatus({...passed,semantic:{status:"failed",reason:"omitted a stop"}}),"failed");
  assert.equal(visualQualityQaStatus({status:"not_tested"}),"not_tested");
});

test("an existing visual plan can be topped up with additional relevant source photos", () => {
  const assets=["one","two","three"].map((name,index)=>({id:`asset-${name}`,remote_url:`https://media.example/${name}.jpg`,mime_type:"image/jpeg",
    alt_text:`Beijing hutong route view ${name}`,caption_text:`Beijing hutong detail ${name}`,nearby_text:"Beijing hutong walking route",
    evidence_text:"Beijing hutong route",language_status:"no_text",width:1600-index*100,height:900,storage_status:"saved",
    original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"}));
  const existing=[{image_type:"illustration",image_subject:"Beijing route orientation",placement:"hero"}];
  const output=normalizeVisuals(existing,{...draft,body_markdown:"A Beijing hutong walking route with several useful stops."},brief,assets,
    {visuals:{target:3,maximum:5}});
  assert.equal(output.length,3);
  assert.equal(output.filter((item)=>item.source_asset_id).length,2);
});

test("an equal-count media plan repairs only the stale source slot and preserves successful metadata",()=>{
  const current=[
    {source_asset_id:"card",image_type:"real_world_photo",image_subject:"Chongqing route card",placement:"hero",
      acquisition_strategy:"use_authorized_source_image",status:"generated",media_url:"https://cms.test/old-card.png",
      media_metadata:{custom_analysis_note:"preserve-me",quality_qa:{status:"not_tested"}}},
    {image_type:"illustration",image_subject:"Chongqing skyline",placement:"mid_article",acquisition_strategy:"generate_illustration",
      status:"generated",media_url:"https://cms.test/good.png",media_metadata:{binary_qa:{status:"passed"}}},
  ];
  const assets=[{id:"card",remote_url:"https://media.test/card.png",mime_type:"image/png",alt_text:"Chongqing route card",
    caption_text:"Route card",nearby_text:"Chongqing route",evidence_text:"Chongqing route",storage_status:"saved",
    original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED",analysis_status:"ready",
    asset_kind:"editorial_infographic",reader_text_present:true,language_status:"chinese",
    language_by_region:[{region_id:"body",language:"zh-CN",role:"author_overlay"}],text_regions:[{region_id:"body",text:"09:00–17:00",role:"author_overlay"}],
    editor_ui_regions:[],photo_regions:[],entities:[],primary_subjects:["route"],analysis_version:"media-analysis-1",
    original_sha256:"abc",capture_version:2,width:1200,height:1600}];
  const output=normalizeVisuals(current,{title:"Chongqing route",body_markdown:"A Chongqing route card."},{destination_slug:"chongqing"},assets,
    {visuals:{target:2,maximum:5}});
  assert.equal(output.length,2);
  assert.equal(output[0].source_asset_id,"card");
  assert.equal(output[0].acquisition_strategy,"analyze_source_image");
  assert.equal(output[0].aspect_ratio,"3:4");
  assert.equal(output[0].status,"planned");
  assert.equal(output[0].media_metadata.custom_analysis_note,"preserve-me");
  assert.equal(output[1].media_url,"https://cms.test/good.png");
});

test("source-shaped ratio repair does not invalidate an already qualified transformed image",()=>{
  const passed=Object.fromEntries(["language","completeness","style","semantic"].map((field)=>[field,{status:"passed",reason:"ok"}]));
  const current=[{source_asset_id:"card",image_type:"infographic",image_subject:"Chongqing guide card",
    placement:"hero",acquisition_strategy:"recompose_editorial_card",aspect_ratio:"9:16",status:"generated",
    media_url:"https://cms.test/qualified.png",media_metadata:{quality_qa:passed,binary_qa:{status:"passed"}}}];
  const assets=[{id:"card",remote_url:"https://media.test/card.png",mime_type:"image/png",alt_text:"Chongqing guide card",
    caption_text:"Guide card",nearby_text:"Chongqing guide",evidence_text:"Chongqing guide",storage_status:"saved",
    original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED",analysis_status:"ready",
    asset_kind:"editorial_infographic",reader_text_present:true,language_status:"chinese",analysis_version:"media-analysis-2",
    text_regions:[{region_id:"body",text:"Guide",role:"editorial_text",language:"zh",readable:true,preserve:false}],
    width:1200,height:1600}];
  const output=normalizeVisuals(current,{title:"Chongqing guide",body_markdown:"A Chongqing guide card."},
    {destination_slug:"chongqing"},assets,{visuals:{target:1,maximum:5}});
  assert.equal(output[0].aspect_ratio,"9:16");
});

test("legacy source assets with zero SQL dimensions recover their ratio from the stored original",async (t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"visual-source-ratio-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const filename=path.join(directory,"portrait.webp");
  await sharp({create:{width:1200,height:1600,channels:3,background:"#f7f3eb"}}).webp().toFile(filename);
  const current=[{
    placement:"hero",purpose:"Translate the complete Chongqing route card",alt_text:"Chongqing route card",
    caption:"Chongqing route",generation_prompt:"",aspect_ratio:"3:2",image_type:"infographic",image_role:"hero",
    image_subject:"Chongqing route",factual_image_required:true,source_asset_id:"asset-legacy-zero-dimensions",
    acquisition_strategy:"recompose_editorial_card",status:"failed",media_metadata:{quality_qa:{
      language:{status:"passed"},completeness:{status:"failed"},style:{status:"passed"},semantic:{status:"failed"},
    }},
  }];
  const assets=[{
    id:"asset-legacy-zero-dimensions",source_id:"source-1",local_path:filename,mime_type:"image/webp",
    width:0,height:0,alt_text:"Chongqing route card",evidence_text:"Chongqing route",
    language_status:"chinese",analysis_status:"ready",asset_kind:"editorial_infographic",
    text_regions:[{region_id:"r1",text:"Chongqing route",role:"editorial_text",language:"zh",readable:true,preserve:false}],
    analysis_version:"media-analysis-2",reader_text_present:true,storage_status:"saved",
    original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED",
  }];
  const output=normalizeVisuals(current,{id:"draft-1",title:"Chongqing route",body_markdown:"Chongqing route card"},
    {destination_slug:"chongqing"},assets,{visuals:{maximum:5,target:1}});
  assert.equal(output.length,1);
  assert.equal(output[0].aspect_ratio,"3:4");
});

test("relevant food media beyond the former first-24 candidate window can be selected",()=>{
  const assets=Array.from({length:30},(_,index)=>({id:`asset-${index}`,remote_url:`https://media.test/${index}.jpg`,mime_type:"image/jpeg",
    alt_text:index===29 ? "Chongqing hotpot meal" : `Unrelated generic view ${index}`,caption_text:"",nearby_text:"",evidence_text:"",
    language_status:"no_text",width:1600,height:900,storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"}));
  const output=normalizeVisuals([],{title:"Chongqing food guide",body_markdown:"Choose a Chongqing hotpot meal."},
    {destination_slug:"chongqing"},assets,{visuals:{target:1,maximum:5}});
  assert.equal(output[0].source_asset_id,"asset-29");
});
