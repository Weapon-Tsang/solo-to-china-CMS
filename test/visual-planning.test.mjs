import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { decideVisualAsset, normalizeVisuals, visualQualityQaStatus } from "../src/repository.mjs";

test("a source guide card cannot lend an unrelated legacy caption to a travel article",()=>{
  const asset={id:"chongqing-card",asset_kind:"editorial_infographic",analysis_status:"ready",
    analysis_version:"media-analysis-2",reader_text_present:true,language_status:"chinese",
    alt_text:"Chongqing accommodation options",caption_text:"Guanyinqiao pedestrian avenues and cultural spots",
    primary_subjects:["Chongqing accommodation options"],
    text_regions:[{region_id:"copy",text:"住宿选择",role:"editorial_text",language:"zh",readable:true,preserve:false}],
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const selected=normalizeVisuals([{source_asset_id:asset.id,image_type:"infographic",
    image_subject:"Chongqing accommodation options",purpose:"Compare accommodation options",
    caption:"Guanyinqiao offers broad pedestrian avenues"}],
    {title:"Chongqing accommodation guide",body_markdown:"Compare accommodation options."},
    {destination_slug:"chongqing"},[asset],{visuals:{target:1,maximum:5}});
  assert.equal(selected.length,1);
  assert.equal(selected[0].caption,"Chongqing accommodation options");
  assert.doesNotMatch(selected[0].caption,/Guanyinqiao/);
});

test("an analyzed Chongqing advisory card cannot match a Hong Kong scene through nearby prose",()=>{
  const asset={id:"travel-advisory",asset_kind:"editorial_infographic",analysis_status:"ready",
    analysis_version:"media-analysis-2",reader_text_present:true,language_status:"chinese",
    alt_text:"Hong Kong street",caption_text:"Hong Kong streetscape",nearby_text:"Hong Kong street towers",
    evidence_subject:"Hong Kong street towers",primary_subjects:["Chongqing travel advisory tips"],
    entities:["Hong Kong street towers","Chongqing"],
    text_regions:[{region_id:"copy",text:"重庆旅行提示",role:"editorial_text",language:"zh",readable:true,preserve:false}],
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const result=normalizeVisuals([{source_asset_id:asset.id,image_type:"real_world_photo",
    image_subject:"Hong Kong street towers",purpose:"Show Hong Kong street towers"}],
    {title:"Hong Kong walking guide",body_markdown:"Walk below Hong Kong towers."},
    {destination_slug:"hong-kong"},[asset],{visuals:{target:1,maximum:5}});
  assert.deepEqual(result,[]);
});

const draft = { title: "A Practical Beijing Guide", body_markdown: "Useful body text.", strategy_version:"3.8" };
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
    title:"Chongqing Landmarks",body_markdown:"Visit Guotai Arts Center on a Chongqing landmarks route.",strategy_version:"3.8",
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
  const required=normalizeVisuals([{image_type:"map_or_route",image_subject:"Verified station transfer map",
    required_in_article:true}],draft,brief,[],policy);
  assert.equal(required.length,1);
  assert.equal(required[0].status,"failed");
  assert.equal(required[0].image_type,"map_or_route");
  assert.equal(required[0].media_metadata.required_visual_obligation.required,true);
});

test("a late required visual survives the presentation limit and displaces an optional illustration",()=>{
  const items=[
    {image_type:"illustration",image_subject:"Opening scene"},
    {image_type:"illustration",image_subject:"Decorative transition"},
    {image_type:"map_or_route",image_subject:"Required station transfer",required_in_article:true},
  ];
  const selected=normalizeVisuals(items,draft,brief,[],{visuals:{target:0,maximum:2}});
  assert.deepEqual(selected.map((item)=>item.image_subject),["Opening scene","Required station transfer"]);
  assert.equal(selected[1].status,"failed");
  assert.equal(selected[1].media_metadata.required_visual_gap.reason,"no_relevant_authorized_source");
  const overflow=normalizeVisuals(items.map((item,index)=>({image_type:"map_or_route",
    image_subject:`Required route ${index}`,required_in_article:true})),draft,brief,[],
    {visuals:{target:0,maximum:2}});
  assert.equal(overflow.length,3,"even an over-limit obligation must remain visible to delivery validation");
});

test("a real-world photo is selected only when an original authorized source asset matches and unknown image content is analyzed", () => {
  const requested = [{ image_type:"real_world_photo",image_subject:"Forbidden City gate" }];
  assert.deepEqual(normalizeVisuals(requested,draft,brief,[],policy),[],"optional factual photos may be omitted");
  const required=[{...requested[0],required_in_article:true}];
  const missing=normalizeVisuals(required,draft,brief,[],policy);
  assert.equal(missing.length,1);
  assert.equal(missing[0].status,"failed");
  assert.equal(missing[0].acquisition_strategy,"await_authorized_source_image");
  assert.equal(missing[0].factual_image_required,true);
  assert.equal(missing[0].media_metadata.required_visual_obligation.required,true);
  assert.equal(missing[0].source_asset_id,null);
  assert.equal(missing[0].media_metadata.required_visual_gap.reason,"no_relevant_authorized_source");
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
  const recovered=normalizeVisuals(missing,draft,brief,[asset],policy);
  assert.equal(recovered[0].source_asset_id,"asset-1");
  assert.equal(recovered[0].media_metadata.required_visual_gap,null);
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
  const required=normalizeVisuals([{...requested[0],required_in_article:true}],
    {title:"Ciqikou Ancient Town",body_markdown:"Walk Ciqikou's flagstone lanes."},
    {destination_slug:"chongqing"},assets,{visuals:{target:1,maximum:5}});
  assert.equal(required[0].status,"failed");
  assert.equal(required[0].media_metadata.required_visual_gap.requested_source_asset_id,"broad-map");
});

test("incomplete visual normalization converges on the best asset and remains idempotent",()=>{
  const requested=[{source_asset_id:"broad",image_type:"infographic",image_role:"hero",status:"planned",
    image_subject:"Ciqikou ancient town food guide",purpose:"Ciqikou ancient town food guide"}];
  const common={remote_url:"https://media.example/card.webp",mime_type:"image/webp",analysis_status:"ready",
    asset_kind:"editorial_infographic",analysis_version:"media-analysis-2",reader_text_present:true,language_status:"chinese",
    text_regions:[{region_id:"copy",text:"磁器口美食",role:"editorial_text",language:"zh",readable:true,preserve:false}],
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const assets=[
    {...common,id:"broad",alt_text:"Ciqikou town map",primary_subjects:["Ciqikou town map"]},
    {...common,id:"specific",alt_text:"Ciqikou ancient town food guide",primary_subjects:["Ciqikou ancient town food guide"]},
  ];
  const first=normalizeVisuals(requested,{title:"Ciqikou food guide",body_markdown:"Ciqikou ancient town food."},
    {destination_slug:"chongqing"},assets,{visuals:{target:1,maximum:5}});
  const second=normalizeVisuals(first,{title:"Ciqikou food guide",body_markdown:"Ciqikou ancient town food."},
    {destination_slug:"chongqing"},assets,{visuals:{target:1,maximum:5}});
  assert.equal(first[0].source_asset_id,"specific");
  assert.deepEqual(first[0].media_metadata.authorized_asset_match.displaced_asset_ids,["broad"]);
  assert.equal(second[0].source_asset_id,"specific");
  assert.equal(second[0].acquisition_strategy,first[0].acquisition_strategy);
  assert.equal(second[0].media_metadata.authorized_asset_match.request_hash,
    first[0].media_metadata.authorized_asset_match.request_hash);
});

test("article-level fallback cannot erase an unrelated required photo obligation",()=>{
  const requested=[{source_asset_id:"stale",image_type:"real_world_photo",image_role:"hero",status:"failed",
    image_subject:"Unrelated stale scene",purpose:"Unrelated stale scene",required_in_article:true}];
  const asset={id:"ciqikou-card",remote_url:"https://media.example/ciqikou.webp",mime_type:"image/webp",
    alt_text:"Ciqikou Ancient Town practical guide",primary_subjects:["Ciqikou Ancient Town practical guide"],
    analysis_status:"ready",asset_kind:"editorial_infographic",analysis_version:"media-analysis-2",
    reader_text_present:true,language_status:"chinese",
    text_regions:[{region_id:"copy",text:"磁器口实用指南",role:"editorial_text",language:"zh",readable:true,preserve:false}],
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const draft={title:"Ciqikou Ancient Town practical guide",body_markdown:"Plan a visit to Ciqikou Ancient Town."};
  const brief={destination_slug:"chongqing",topic:"Ciqikou Ancient Town"};
  const first=normalizeVisuals(requested,draft,brief,[asset],{visuals:{target:1,maximum:5}});
  const second=normalizeVisuals(first,draft,brief,[asset],{visuals:{target:1,maximum:5}});
  assert.equal(first[0].status,"failed");
  assert.equal(first[0].media_metadata.required_visual_gap.requested_source_asset_id,"stale");
  assert.equal(second[0].status,"failed");
  assert.equal(second[0].source_asset_id,null);
});

test("a weak article fallback cannot bootstrap its own relevance on retry",()=>{
  const asset={id:"broad-collage",remote_url:"https://media.example/chongqing-collage.webp",mime_type:"image/webp",
    alt_text:"Eling Park in a broad Chongqing attractions collage",primary_subjects:["Chongqing travel guide","Eling Park"],
    analysis_status:"ready",asset_kind:"photo_collage",analysis_version:"media-analysis-2",reader_text_present:true,
    language_status:"chinese",text_regions:[{region_id:"copy",text:"鹅岭公园",role:"author_overlay",language:"zh",readable:true,preserve:false}],
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const requested=[{source_asset_id:asset.id,image_type:"infographic",image_role:"support",status:"failed",
    image_subject:"Eling Park in Chongqing",purpose:"Evidence-linked view supporting Ciqikou Ancient Town",
    media_metadata:{authorized_asset_match:{version:"visual-match-2",mode:"article_fallback",score:0.18,
      request_hash:"legacy-low-coverage"}}}];
  const output=normalizeVisuals(requested,{title:"Ciqikou Ancient Town",body_markdown:"Walk Ciqikou's old lanes."},
    {destination_slug:"chongqing",topic:"Ciqikou Ancient Town"},[asset],{visuals:{target:1,maximum:5}});
  assert.deepEqual(output,[],"a broad failed fallback must be removed instead of becoming relevant through its own alt text");
});

test("fresh pixel analysis preserves a recoverable visual and its pending QA candidate identity",()=>{
  const asset={id:"baixiangju-card",remote_url:"https://media.example/baixiangju.webp",mime_type:"image/webp",
    alt_text:"Old generic visitor card",primary_subjects:["Baixiangju residential complex architecture and staircases in Chongqing"],
    analysis_status:"ready",asset_kind:"handwritten_card",analysis_version:"media-analysis-2",
    prompt_version:"media-analysis-prompt-3",reader_text_present:true,language_status:"chinese",
    text_regions:[{region_id:"copy",text:"Baixiangju",role:"author_overlay",language:"zh",readable:true,preserve:false}],
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const requested=[{source_asset_id:asset.id,image_type:"infographic",image_role:"hero",status:"failed",
    image_subject:"Baixiangju residential complex architecture",purpose:"Show Baixiangju staircases",
    media_metadata:{authorized_asset_match:{version:"visual-match-2",mode:"article_fallback",score:0.18,
      request_hash:"legacy-low-coverage"}}}];
  const output=normalizeVisuals(requested,{title:"Baixiangju: Practical Visitor Guide",
    body_markdown:"Explore Baixiangju residential complex architecture and staircases."},
    {destination_slug:"chongqing",topic:"Baixiangju visitor guide"},[asset],{visuals:{target:1,maximum:5}});
  assert.equal(output.length,1);
  assert.equal(output[0].source_asset_id,asset.id);
  assert.ok(output[0].media_metadata.authorized_asset_match.score>=0.34);
});

test("an obsolete qualified fallback releases assets displaced by its superseded decision",()=>{
  const common={remote_url:"https://media.example/source.webp",mime_type:"image/webp",analysis_status:"ready",
    asset_kind:"editorial_infographic",analysis_version:"media-analysis-2",reader_text_present:true,
    language_status:"chinese",text_regions:[{region_id:"copy",text:"磁器口",role:"author_overlay",language:"zh",readable:true,preserve:false}],
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const broad={...common,id:"broad-collage",alt_text:"Chongqing attractions collage",
    primary_subjects:["Chongqing attractions collage"]};
  const focused={...common,id:"focused-card",alt_text:"Ciqikou Ancient Town independent travel guide",
    primary_subjects:["Ciqikou Ancient Town","independent travel guide"]};
  const requested=[{source_asset_id:broad.id,image_type:"infographic",image_role:"hero",status:"generated",
    image_subject:"Chongqing attractions collage",purpose:"Evidence-linked view supporting Ciqikou Ancient Town",
    media_url:"/media/broad.png",media_metadata:{
      quality_qa:{language:{status:"passed"},completeness:{status:"passed"},style:{status:"passed"},semantic:{status:"passed"}},
      authorized_asset_match:{version:"visual-match-2",mode:"article_fallback",score:0.30,
        request_hash:"obsolete-selection",displaced_asset_ids:[focused.id]}}}];
  const output=normalizeVisuals(requested,{title:"Ciqikou Ancient Town: A Practical Guide for Independent Travelers",
    body_markdown:"Walk Ciqikou Ancient Town's old lanes.",strategy_version:"3.8"},{destination_slug:"chongqing",topic:"Ciqikou Ancient Town"},
    [broad,focused],{visuals:{target:1,maximum:5}});
  assert.equal(output.length,1);
  assert.equal(output[0].source_asset_id,focused.id);
  assert.equal(output[0].status,"planned");
  assert.deepEqual(output[0].media_metadata.authorized_asset_match.displaced_asset_ids,[broad.id]);
});

test("derivative QA cannot override a source card that depicts an unrelated place",()=>{
  const asset={id:"qualified-source",remote_url:"https://media.example/qualified.webp",mime_type:"image/webp",
    alt_text:"General Chongqing visitor notes",primary_subjects:["Chongqing visitor notes"],analysis_status:"ready",
    asset_kind:"editorial_infographic",analysis_version:"media-analysis-2",reader_text_present:true,language_status:"english",
    text_regions:[{region_id:"copy",text:"Visitor notes",role:"editorial_text",language:"en",readable:true,preserve:false}],
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const requested=[{source_asset_id:asset.id,image_type:"infographic",image_role:"hero",status:"generated",
    image_subject:"Ciqikou Ancient Town lanes",purpose:"Show Ciqikou Ancient Town lanes",media_url:"/media/qualified.webp",
    media_metadata:{quality_qa:{language:{status:"passed"},completeness:{status:"passed"},style:{status:"passed"},
      semantic:{status:"passed"}}}}];
  const output=normalizeVisuals(requested,{title:"Ciqikou Ancient Town",body_markdown:"Walk the old lanes."},
    {destination_slug:"chongqing"},[asset],{visuals:{target:1,maximum:5}});
  assert.deepEqual(output,[]);
});

test("a focused attraction guide rejects previously qualified multi-place visuals and does not reselect them as fallback",()=>{
  const passed=Object.fromEntries(["language","completeness","style","semantic"]
    .map((field)=>[field,{status:"passed",reason:"source derivative matched"}]));
  const common={remote_url:"https://media.example/chongqing.webp",mime_type:"image/webp",
    analysis_status:"ready",analysis_version:"media-analysis-2",reader_text_present:true,
    language_status:"chinese",storage_status:"saved",original_bytes_status:"saved_original",
    durability_status:"ORIGINAL_STORED"};
  const assets=[
    {...common,id:"city-collage",asset_kind:"photo_collage",
      primary_subjects:["Chongqing travel guide","Scenic tourist spots collage"],
      entities:["Huguang Guild Hall","Chongqing Zoo","Eling Park","Ciqikou"],
      nearby_text:"Huguang Guild Hall yellow walls and visitor tips"},
    {...common,id:"route-card",asset_kind:"editorial_infographic",
      primary_subjects:["Travel itinerary","Chongqing"],
      entities:["Huguang Guild Hall","Yangtze River Cableway","Longmenhao Old Street","Nanbin Road"],
      nearby_text:"Huguang Guild Hall, Longmenhao Old Street and other route stops"},
  ];
  const current=assets.map((asset,index)=>({source_asset_id:asset.id,image_type:"infographic",
    image_role:index ? "support" : "hero",placement:index ? "after_intro" : "hero",
    image_subject:index ? "Longmenhao Old Street" : "Huguang Guild Hall yellow walls",
    purpose:index ? "Photo of Longmenhao Old Street" : "Panoramic view of Huguang Guild Hall",
    status:"generated",media_url:`/media/${asset.id}.png`,media_metadata:{quality_qa:passed}}));
  const output=normalizeVisuals(current,{title:"Huguang Guild Hall Chongqing: Independent Visitor Guide",
    body_markdown:"Visit Huguang Guild Hall and walk to Longmenhao Old Street."},
    {destination_slug:"chongqing",topic:"Huguang Guild Hall"},assets,
    {content_type:"attraction_guide",visuals:{target:2,maximum:5}});
  assert.deepEqual(output,[]);
});

test("a two-stop route map is eligible only for its evidenced non-hero route section",()=>{
  const asset={id:"huguang-longmenhao-route",remote_url:"https://media.example/route.webp",mime_type:"image/webp",
    asset_kind:"map_or_route",analysis_status:"ready",analysis_version:"media-analysis-2",
    language_status:"english",reader_text_present:true,storage_status:"saved",
    original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED",
    primary_subjects:["Walking route from Huguang Guild Hall to Longmenhao Old Street"],
    caption_text:"Outdated general Chongqing city poster",
    entities:["Huguang Guild Hall","Longmenhao Old Street","Nanbin Road"],
    text_regions:[{region_id:"route_stop_1",text:"Huguang Guild Hall",language:"en",role:"editorial_text"},
      {region_id:"route_stop_2",text:"Longmenhao Old Street",language:"en",role:"editorial_text"}]};
  const article={title:"Huguang Guild Hall guide",body_markdown:"Visit Huguang Guild Hall, then walk to Longmenhao Old Street."};
  const focused={destination_slug:"chongqing",topic:"Huguang Guild Hall"};
  const route={source_asset_id:asset.id,image_type:"map_or_route",image_role:"support",placement:"mid_article",
    image_subject:"Walking route from Huguang Guild Hall to Longmenhao Old Street",
    purpose:"Map the walking route from Huguang Guild Hall to Longmenhao Old Street"};
  const policy={content_type:"attraction_guide",visuals:{target:1,maximum:5}};
  const selected=normalizeVisuals([route],article,focused,[asset],policy);
  assert.equal(selected.length,1);
  assert.equal(selected[0].source_asset_id,asset.id);
  assert.equal(selected[0].placement,"mid_article");
  assert.equal(selected[0].media_metadata.authorized_asset_match.mode,"section_route");
  assert.match(selected[0].alt_text,/^Map of Walking route from Huguang Guild Hall/);
  assert.match(selected[0].caption,/^Route map: Walking route from Huguang Guild Hall/);
  assert.doesNotMatch(`${selected[0].alt_text} ${selected[0].caption}`,/Outdated general/);
  assert.deepEqual(normalizeVisuals(selected,article,focused,[asset],policy).map((item)=>item.source_asset_id),[asset.id]);
  assert.deepEqual(normalizeVisuals([{...route,placement:"hero",image_role:"hero"}],article,focused,[asset],policy),[]);
  const wrongType=normalizeVisuals([{...route,image_type:"real_world_photo",purpose:"Photo of Huguang Guild Hall"}],
    article,focused,[asset],policy);
  assert.deepEqual(wrongType,[]);
  assert.deepEqual(normalizeVisuals([route],{...article,body_markdown:"Visit Huguang Guild Hall."},focused,[asset],policy),[]);
  assert.deepEqual(normalizeVisuals([route],article,focused,[{...asset,primary_subjects:["Chongqing city map"]}],policy),[]);
});

test("a two-place collage cannot borrow an inaccurate old caption as image-subject evidence",()=>{
  const asset={id:"mis-captioned",asset_kind:"photo_collage",remote_url:"https://media.example/collage.webp",
    mime_type:"image/webp",analysis_status:"ready",analysis_version:"media-analysis-2",
    primary_subjects:["Chongqing highlights collage"],entities:["Huguang Guild Hall","Chongqing Zoo"],
    alt_text:"Huguang Guild Hall",caption_text:"Huguang Guild Hall visitor photo",
    language_status:"english",storage_status:"saved",original_bytes_status:"saved_original",
    durability_status:"ORIGINAL_STORED"};
  const visual={source_asset_id:asset.id,image_type:"real_world_photo",image_role:"hero",placement:"hero",
    image_subject:"Huguang Guild Hall",purpose:"Show the Huguang Guild Hall buildings"};
  const output=normalizeVisuals([visual],{title:"Huguang Guild Hall",body_markdown:"Visit Huguang Guild Hall."},
    {destination_slug:"chongqing",topic:"Huguang Guild Hall"},[asset],
    {content_type:"attraction_guide",visuals:{target:1,maximum:5}});
  assert.deepEqual(output,[]);
  const required=normalizeVisuals([{...visual,required_in_article:true}],
    {title:"Huguang Guild Hall",body_markdown:"Visit Huguang Guild Hall."},
    {destination_slug:"chongqing",topic:"Huguang Guild Hall"},[asset],
    {content_type:"attraction_guide",visuals:{target:1,maximum:5}});
  assert.equal(required[0].status,"failed");
  assert.equal(required[0].media_metadata.required_visual_gap.requested_source_asset_id,"mis-captioned");
});

test("an attraction guide may use an image whose own subject identifies the attraction",()=>{
  const asset={id:"focused-photo",remote_url:"https://media.example/huguang.webp",mime_type:"image/webp",
    analysis_status:"ready",analysis_version:"media-analysis-2",asset_kind:"documentary_photo",
    reader_text_present:false,language_status:"no_text",primary_subjects:["Huguang Guild Hall yellow walls"],
    alt_text:"Yellow walls of Huguang Guild Hall",
    entities:["Huguang Guild Hall"],storage_status:"saved",original_bytes_status:"saved_original",
    durability_status:"ORIGINAL_STORED"};
  const output=normalizeVisuals([],{title:"Huguang Guild Hall Chongqing: Independent Visitor Guide",
    body_markdown:"Visit the yellow-walled Huguang Guild Hall.",strategy_version:"3.8"},
    {destination_slug:"chongqing",topic:"Huguang Guild Hall: A Practical Guide"},[asset],
    {content_type:"attraction_guide",visuals:{target:1,maximum:5}});
  assert.equal(output.length,1);
  assert.equal(output[0].source_asset_id,asset.id);
});

test("a multi-place itinerary may retain a qualified multi-place source visual",()=>{
  const asset={id:"route-card",asset_kind:"editorial_infographic",remote_url:"https://media.example/route.webp",
    primary_subjects:["Chongqing itinerary"],entities:["Huguang Guild Hall","Ciqikou","Hongyadong"],
    analysis_status:"ready",analysis_version:"media-analysis-2",reader_text_present:true,
    language_status:"english",storage_status:"saved",original_bytes_status:"saved_original",
    durability_status:"ORIGINAL_STORED"};
  const quality_qa=Object.fromEntries(["language","completeness","style","semantic"]
    .map((field)=>[field,{status:"passed",reason:"ok"}]));
  const output=normalizeVisuals([{source_asset_id:asset.id,image_type:"infographic",image_role:"hero",
    placement:"hero",image_subject:"Chongqing itinerary",purpose:"Show the multi-stop Chongqing route",
    status:"generated",media_url:"/media/route.png",media_metadata:{quality_qa}}],
    {title:"Chongqing 3-Day Itinerary",body_markdown:"Visit three route stops."},
    {destination_slug:"chongqing"},[asset],{content_type:"itinerary",visuals:{target:1,maximum:5}});
  assert.equal(output[0].source_asset_id,asset.id);
  assert.equal(output[0].status,"generated");
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

test("strategy 3.9 combines free audited photos with paid Chinese infographic translation",()=>{
  const infographic={id:"chinese-map",remote_url:"https://media.example/map.webp",mime_type:"image/webp",
    alt_text:"Beijing metro transfer station route map",asset_kind:"editorial_infographic",
    analysis_status:"ready",analysis_version:"media-analysis-2",reader_text_present:true,
    language_status:"chinese",primary_subjects:["Beijing metro transfer station route map"],
    text_regions:[{region_id:"route",text:"换乘路线",role:"editorial_text",language:"zh",readable:true,preserve:false}],
    original_sha256:"map-hash",local_photo_audit:{status:"needs_review",sha256:"map-hash"},
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const photograph={id:"station-photo",remote_url:"https://media.example/station.webp",mime_type:"image/webp",
    alt_text:"Beijing metro transfer station ticket entrance photograph",asset_kind:"documentary_photo",
    analysis_status:"ready",analysis_version:"media-analysis-2",reader_text_present:false,
    language_status:"no_text",original_sha256:"photo-hash",
    local_photo_audit:{status:"eligible",sha256:"photo-hash",providerCalls:0},
    storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED"};
  const visuals=normalizeVisuals([{source_asset_id:infographic.id,image_type:"infographic",image_role:"support",
    placement:"mid_article",image_subject:"Beijing metro transfer station route map",purpose:"Explain the station route",
    required_in_article:true,status:"planned"}],
    {title:"Beijing metro transfer station guide",body_markdown:"Use the metro transfer station route and ticket entrance.",strategy_version:"3.9"},
    {destination_slug:"beijing",topic:"Metro transfer station"},[infographic,photograph],
    {content_type:"transport_guide",visuals:{target:2,maximum:5}});
  assert.equal(visuals.length,2);
  assert.equal(visuals[0].source_asset_id,"chinese-map");
  assert.notEqual(visuals[0].acquisition_strategy,"use_authorized_source_image");
  assert.equal(visuals[0].status,"planned");
  assert.equal(visuals[1].source_asset_id,"station-photo");
  assert.equal(visuals[1].acquisition_strategy,"use_authorized_source_image");
  assert.equal(visuals[1].media_metadata.local_photo_audit.providerCalls,0);
});

test('audited source photo can reuse a prior English image subject as alt without a new model call',()=>{
  const photograph={id:'old-street',alt_text:'洪崖洞街景',caption_text:'重庆夜景',
    primary_subjects:['Hongyadong street stairs at night'],asset_kind:'documentary_photo',
    original_sha256:'street-hash',local_photo_audit:{status:'eligible',sha256:'street-hash',providerCalls:0},
    storage_status:'saved',original_bytes_status:'saved_original',durability_status:'ORIGINAL_STORED'};
  const visuals=normalizeVisuals([], {title:'Hongyadong Street Guide',body_markdown:'Climb the Hongyadong street stairs at night.',
    strategy_version:'3.9'}, {destination_slug:'chongqing'},[photograph],{visuals:{target:1,maximum:12}});
  assert.equal(visuals.length,1);
  assert.equal(visuals[0].alt_text,'Hongyadong street stairs at night');
  assert.equal(visuals[0].acquisition_strategy,'use_authorized_source_image');
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

test('strategy 3.9 uses qualified originals and still plans relevant Chinese information graphics for English localization',()=>{
  const photoHash='a'.repeat(64);
  const common={remote_url:'https://media.test/asset.png',mime_type:'image/png',
    storage_status:'saved',original_bytes_status:'saved_original',durability_status:'ORIGINAL_STORED',
    width:1600,height:1200,evidence_text:'Chongqing food guide hotpot restaurant menu',
    nearby_text:'Chongqing food guide hotpot restaurant menu'};
  const assets=[{...common,id:'photo',alt_text:'Chongqing hotpot restaurant dining room',
    caption_text:'Chongqing hotpot restaurant dining room',language_status:'no_text',
    asset_kind:'documentary_photo',analysis_status:'ready',analysis_version:'media-analysis-2',
    original_sha256:photoHash,local_photo_audit:{status:'eligible',sha256:photoHash}},
  {...common,id:'card',alt_text:'Chongqing hotpot restaurant menu guide',
    caption_text:'Chongqing hotpot restaurant menu guide',language_status:'chinese',
    asset_kind:'editorial_infographic',analysis_status:'ready',analysis_version:'media-analysis-2',
    reader_text_present:true,text_regions:[{region_id:'menu',role:'editorial_text',language:'zh',
      text:'重庆火锅菜单',readable:true,preserve:false}]}];
  const output=normalizeVisuals([],{title:'Chongqing food guide',body_markdown:'Chongqing hotpot restaurant menu guide',
    strategy_version:'3.9'},{destination_slug:'chongqing'},assets,{visuals:{target:2,maximum:5}});
  assert.deepEqual(new Set(output.map((visual)=>visual.source_asset_id)),new Set(['photo','card']));
  assert.equal(output.find((visual)=>visual.source_asset_id==='photo').acquisition_strategy,'use_authorized_source_image');
  assert.equal(output.find((visual)=>visual.source_asset_id==='card').acquisition_strategy,'recompose_editorial_card');
  assert.equal(output.find((visual)=>visual.source_asset_id==='card').status,'planned');
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
    editor_ui_regions:[],photo_regions:[],entities:[],primary_subjects:["Chongqing route card"],analysis_version:"media-analysis-1",
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
  const output=normalizeVisuals([],{title:"Chongqing food guide",body_markdown:"Choose a Chongqing hotpot meal.",strategy_version:"3.8"},
    {destination_slug:"chongqing"},assets,{visuals:{target:1,maximum:5}});
  assert.equal(output[0].source_asset_id,"asset-29");
});

test('a previously QA-passed guide card cannot remain a Guanyinqiao street photo',()=>{
  const passed=Object.fromEntries(['language','completeness','style','semantic']
    .map((field)=>[field,{status:'passed',reason:'derivative matches its source'}]));
  const base={remote_url:'https://media.test/source.png',mime_type:'image/png',storage_status:'saved',
    original_bytes_status:'saved_original',durability_status:'ORIGINAL_STORED',language_status:'no_text',
    analysis_status:'ready',analysis_version:'media-analysis-2',width:1200,height:800};
  const assets=[{...base,id:'old-card',asset_kind:'handwritten_card',
    primary_subjects:['Travel','Chongqing','Accommodation'],alt_text:'Guanyinqiao pedestrian avenue',
    caption_text:'Guanyinqiao pedestrian avenue'},
  {...base,id:'actual-street',asset_kind:'documentary_photo',
    primary_subjects:['Guanyinqiao pedestrian avenue in Chongqing'],
    alt_text:'Guanyinqiao pedestrian avenue in Chongqing'}];
  const existing=[{id:'visual',source_asset_id:'old-card',image_type:'infographic',image_role:'hero',
    image_subject:'Guanyinqiao pedestrian avenue',purpose:'Show the Guanyinqiao pedestrian avenue',
    placement:'hero',acquisition_strategy:'recompose_editorial_card',status:'generated',
    media_url:'https://media.test/old-card.png',media_metadata:{quality_qa:passed,binary_qa:{status:'passed'}}}];
  const output=normalizeVisuals(existing,{title:'Chongqing walking itinerary',
    body_markdown:'Walk along the Guanyinqiao pedestrian avenue.'},{destination_slug:'chongqing'},assets,
    {visuals:{target:1,maximum:3}});
  assert.equal(output.length,1);
  assert.equal(output[0].source_asset_id,'actual-street');
  assert.match(output[0].caption,/Guanyinqiao pedestrian avenue/);
  assert.notEqual(output[0].media_url,'https://media.test/old-card.png');
});

test('a QA-passed travel-preparation card cannot remain a Chongqing public-bus photo',()=>{
  const quality_qa=Object.fromEntries(['language','completeness','style','semantic']
    .map((field)=>[field,{status:'passed',reason:'derivative matches its source'}]));
  const asset={id:'preparation-card',asset_kind:'editorial_infographic',analysis_status:'needs_review',
    primary_subjects:['Travel preparation guide for Chongqing'],alt_text:'Photo of Chongqing Public Bus',
    caption_text:'Photo of Chongqing Public Bus',remote_url:'https://media.test/preparation.webp',
    mime_type:'image/webp',storage_status:'saved',original_bytes_status:'saved_original',
    durability_status:'ORIGINAL_STORED',language_status:'english',width:1200,height:800};
  const current=[{source_asset_id:asset.id,image_type:'infographic',image_role:'hero',placement:'hero',
    image_subject:'Photo of Chongqing Public Bus',purpose:'Show a Chongqing public bus in use',
    status:'generated',media_url:'https://media.test/old-bus.png',media_metadata:{quality_qa}}];
  const output=normalizeVisuals(current,{title:'Chongqing 3-Day Route',body_markdown:'Use local buses for the route.'},
    {destination_slug:'chongqing'},[asset],{visuals:{target:1,maximum:3}});
  assert.ok(output.every((visual)=>visual.status!=='generated' || visual.media_url!=='https://media.test/old-bus.png'));
});

test('a QA-passed person photo cannot masquerade as Eling Second Factory',()=>{
  const quality_qa=Object.fromEntries(['language','completeness','style','semantic']
    .map((field)=>[field,{status:'passed',reason:'derivative matches its source'}]));
  const asset={id:'person-photo',asset_kind:'documentary_photo',analysis_status:'ready',
    primary_subjects:['person','street art / pavement marking'],alt_text:'Eling Second Factory',
    remote_url:'https://media.test/person.webp',mime_type:'image/webp',storage_status:'saved',
    original_bytes_status:'saved_original',durability_status:'ORIGINAL_STORED',language_status:'no_text',
    local_photo_audit:{status:'eligible',sha256:'hash'},original_sha256:'hash',width:1200,height:800};
  const current=[{source_asset_id:asset.id,image_type:'real_world_photo',image_role:'hero',placement:'hero',
    image_subject:'Photo of Eling Second Factory in Chongqing',purpose:'Show Eling Second Factory',
    status:'generated',media_url:'https://media.test/old-eling.png',media_metadata:{quality_qa}}];
  const output=normalizeVisuals(current,{title:'Eling Second Factory visitor guide',strategy_version:'3.9',
    body_markdown:'Visit Eling Second Factory.'},{destination_slug:'chongqing'},[asset],
    {visuals:{target:1,maximum:3}});
  assert.ok(output.every((visual)=>visual.status!=='generated' || visual.media_url!=='https://media.test/old-eling.png'));
});

test('a broad walking itinerary may use a pixel-verified photo of a named stop',()=>{
  const asset={id:'raffles-photo',asset_kind:'documentary_photo',analysis_status:'ready',
    primary_subjects:['Raffles City Chongqing','cityscape'],alt_text:'Raffles City Chongqing',
    remote_url:'https://media.test/raffles.webp',mime_type:'image/webp',storage_status:'saved',
    original_bytes_status:'saved_original',durability_status:'ORIGINAL_STORED',language_status:'no_text',
    local_photo_audit:{status:'eligible',sha256:'raffles-hash'},original_sha256:'raffles-hash',width:1200,height:800};
  const output=normalizeVisuals([],{title:'Chongqing 3-Day Walking Itinerary',strategy_version:'3.9',
    body_markdown:'The walking route includes Raffles City Chongqing and its cityscape.'},
    {destination_slug:'chongqing',content_type:'itinerary'},[asset],{visuals:{target:1,maximum:3}});
  assert.equal(output[0]?.source_asset_id,asset.id);
  assert.match(output[0].caption,/Raffles City/);
});
