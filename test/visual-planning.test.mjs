import assert from "node:assert/strict";
import test from "node:test";
import { decideVisualAsset, normalizeVisuals } from "../src/repository.mjs";

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

test("a real-world photo is retained only when an original authorized source asset matches", () => {
  const requested = [{ image_type:"real_world_photo",image_subject:"Forbidden City gate" }];
  assert.deepEqual(normalizeVisuals(requested,draft,brief,[],policy),[]);
  const asset = { id:"asset-1",remote_url:"https://example.test/original.jpg",mime_type:"image/jpeg",
    alt_text:"Forbidden City gate",caption_text:"Forbidden City gate",nearby_text:"Forbidden City gate",evidence_text:"Forbidden City gate",
    language_status:"chinese",storage_status:"saved",original_bytes_status:"saved_original",durability_status:"ORIGINAL_STORED",
    source_authorization_status:"legacy",source_publishable:0,asset_authorization_status:"legacy",asset_publishable:0 };
  const output = normalizeVisuals(requested,draft,brief,[asset],policy);
  assert.equal(output.length,1);
  assert.equal(output[0].acquisition_strategy,"use_authorized_source_image");
  assert.equal(output[0].source_asset_id,"asset-1");
  assert.equal(output[0].media_metadata.source_provenance.original_stored,true);
  assert.equal(output[0].media_metadata.source_provenance.project_owner_confirmed,true);
});

test("the shared visual decision blocks unclassified text while preserving authentic signs", () => {
  assert.deepEqual(decideVisualAsset({ language_status:"unknown", visual_class:"text_overlay", width:1200, height:800 }), {
    visualClass:"text_overlay", language:"unknown", authenticityCritical:false, action:"reject",
    reason:"language_analysis_required",
  });
  assert.equal(decideVisualAsset({ language_status:"chinese", visual_class:"text_overlay", width:1200, height:800 }).action, "localize");
  assert.equal(decideVisualAsset({ language_status:"chinese", visual_class:"handwritten", width:1200, height:800 }).action, "localize");
  assert.equal(decideVisualAsset({ language_status:"chinese", visual_class:"text_overlay", alt_text:"Historic station name sign", width:1200, height:800 }).action, "retain");
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
