import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVisuals } from "../src/repository.mjs";

const draft = { title: "A Practical Beijing Guide", body_markdown: "Useful body text." };
const brief = { destination_slug: "beijing" };
const policy = { visuals: { minimum: 3, target: 4, maximum: 5 } };

test("visual planning preserves the writer count and never pads target slots", () => {
  const one = normalizeVisuals([{ image_type:"illustration",image_subject:"Beijing street" }],draft,brief,[],policy);
  assert.equal(one.length,1);
  assert.equal(one[0].acquisition_strategy,"generate_illustration");
  assert.deepEqual(normalizeVisuals([],draft,brief,[],policy),[]);
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
    source_authorization_status:"owner_confirmed",source_publishable:1,asset_authorization_status:"owner_confirmed",asset_publishable:1 };
  const output = normalizeVisuals(requested,draft,brief,[asset],policy);
  assert.equal(output.length,1);
  assert.equal(output[0].acquisition_strategy,"localize_source_image");
  assert.equal(output[0].source_asset_id,"asset-1");
  assert.equal(output[0].media_metadata.source_provenance.original_stored,true);
});
