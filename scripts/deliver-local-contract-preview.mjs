import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WordPressDraftAdapter } from "../src/wordpress.mjs";
import { openDatabase } from "../src/db.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.resolve(root, "..", "solo-to-china");
const localSecret = path.join(frontend, "output", "v3-preview", "wp-application-password.txt");
const localDatabase = path.join(root, "output", "v3-preview", "cms-preview.sqlite");
const registryPath = path.join(frontend, "wp-content", "themes", "solo-to-china", "content-contract", "component-registry.generated.json");
const pageSchemaPath = path.join(frontend, "wp-content", "themes", "solo-to-china", "content-contract", "page-schema.generated.json");
const publishSchemaPath = path.join(frontend, "wp-content", "themes", "solo-to-china", "content-contract", "cms-publish-package.generated.json");
if (process.argv[2] !== "--isolated-fixture" || !fs.existsSync(localSecret)) {
  throw new Error("This delivery only accepts the isolated local WordPress fixture credential.");
}
const registryText = fs.readFileSync(registryPath, "utf8").replace(/\r\n/g, "\n");
const registry = JSON.parse(registryText);
const checksum = crypto.createHash("sha256").update(registryText).digest("hex");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const version = registry.contractVersion || registry.version;
assert.equal(version, "1.4.1");
const legacyDisclosure = "SoloToChina may earn a commission from eligible bookings, at no extra cost to you.";
const blocks = [
  { type: "heading", variant: "section", data: { text: "Local CMS to WordPress delivery", level: 2 } },
  { type: "paragraph", variant: "default", data: { content: "This is clearly labeled local test content. It checks the actual cross-repository draft delivery and preview identity without a model call or a production write." } },
  { type: "heading", variant: "section", data: { text: "Check the two commercial paths", level: 2 } },
  { type: "affiliate_cta", variant: "default", data: { category: "Attraction", provider: "Trip.com", title: "TEST DATA · Legacy offer",
    description: "Check current listing details and provider terms.", cta_label: "View provider", target_url: "https://www.trip.com/", disclosure: legacyDisclosure } },
  { type: "affiliate_booking_card", variant: "default", data: { affiliate_asset_id: "v3-local-cms-offer", provider: "Trip.com", asset_type: "DEEP_LINK",
    product_category: "ATTRACTION", title: "TEST DATA · Structured offer", description: "Review provider terms before booking.",
    cta_label: "Review listing", target_url: "https://www.trip.com/", disclosure: legacyDisclosure, scope_type: "ENTITY",
    scope_key: "forbidden-city", slot_key: "v3-local-cms-booking", placement: "contextual", strategy_version: "commercial-v1" } },
];
const packageData = {
  contract: { componentContractVersion: version, pageSchemaVersion: version, contractChecksum: checksum },
  page: { metadata: { pageId: "v3-local-contract-page", title: "TEST DATA · Local CMS delivery preview",
    slug: "v3-local-cms-delivery-preview", contentType: "attraction-guide",
    excerpt: "Isolated local cross-repository delivery fixture.", presentation: { article_hero: { variant: "compact" }, share_this_page: true, table_of_contents: true } }, blocks },
  seo: { meta_title: "Local CMS delivery preview", meta_description: "Isolated local cross-repository delivery fixture.", strategy_version: "v3-local-fixture" },
  schema_jsonld: { "@context": "https://schema.org", "@type": "Article", headline: "Local CMS delivery preview", inLanguage: "en" },
  media: [], publication: { status: "draft", existing_post_id: null, cms_draft_id: "v3-local-cms-draft" },
};
const adapter = new WordPressDraftAdapter({ siteUrl: "http://127.0.0.1:9400", username: "admin",
  applicationPassword: fs.readFileSync(localSecret, "utf8").trim() });
let routeReady=false;
for (let attempt=0;attempt<30;attempt+=1) {
  const index=await fetch("http://127.0.0.1:9400/wp-json/").then((response)=>response.json()).catch(()=>null);
  if (index?.routes?.["/stc/v1/cms-articles"]?.methods?.includes("POST")) {routeReady=true;break;}
  await new Promise((resolve)=>setTimeout(resolve,1000));
}
if (!routeReady) throw new Error("Local WordPress CMS Article route did not become ready within 30 seconds.");
const delivered = await adapter.upsertContractDraft(packageData, { idempotencyKey: "v3-local-cross-repo-draft" });
assert.equal(delivered.status, "draft");
assert.ok(new URL(delivered.previewUrl).origin === "http://127.0.0.1:9400");
assert.deepEqual(delivered.deliveryManifest.commercial_slots.map((slot) => slot.slot_key), ["v3-local-cms-booking"]);
// Mirror this *actual local HTTP delivery* into an explicitly synthetic CMS
// production record so the real CMS final-preview action can be exercised.
// No production database or upstream editorial draft is opened here.
const db = openDatabase(localDatabase);
try {
  const stamp = new Date().toISOString();
  const draftId = "v3-local-cms-draft";
  const body = "## Local CMS to WordPress delivery\n\nThis is clearly labeled local test content.\n\n## Check the two commercial paths\n\nLegacy and structured fixture cards follow.";
  const bodyHash = hash(body);
  const pageHash = hash(JSON.stringify(packageData.page));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT OR IGNORE INTO frontend_contract_snapshots(id,source_repository,registry_source,page_schema_source,
      contract_version,schema_version,checksum,registry_json,page_schema_json,diff_json,status,synced_at,
      publish_package_schema_source,publish_package_version,publish_package_schema_json,artifact_checksum)
      VALUES ('v3-local-contract',?,?,?,?,?,?,?,?,'{}','active',?,?,?,?,?)`).run(frontend,registryPath,pageSchemaPath,
      version,version,checksum,registryText,fs.readFileSync(pageSchemaPath,"utf8"),stamp,publishSchemaPath,
      "1.0.0",fs.readFileSync(publishSchemaPath,"utf8"),checksum);
    db.prepare(`INSERT OR IGNORE INTO topic_candidates(id,destination_slug,topic_key,proposed_title,rationale,coverage_score,evidence_count,conflict_count,status,created_at,updated_at)
      VALUES ('v3-local-cms-candidate','beijing','v3-local-cms-preview','TEST DATA · Local CMS delivery preview','Isolated local cross-repository fixture',80,1,0,'drafted',?,?)`).run(stamp,stamp);
    db.prepare(`INSERT OR IGNORE INTO content_opportunities(id,destination_slug,topic_key,strategy_version,candidate_id,title,content_type,readiness_score,readiness_json,coverage_json,status,approved_at,created_at,updated_at,lifecycle_state)
      VALUES ('v3-local-cms-opportunity','beijing','v3-local-cms-preview','v3-local-fixture','v3-local-cms-candidate','TEST DATA · Local CMS delivery preview','practical_guide',80,'{"ready":true}','{}','wordpress_draft',?,?,?,'finished')`).run(stamp,stamp,stamp);
    db.prepare(`INSERT OR IGNORE INTO content_briefs(id,destination_slug,topic,audience,search_intent,status,created_at,updated_at,candidate_id)
      VALUES ('v3-local-cms-brief','beijing','TEST DATA · Local CMS delivery preview','local test','informational','ready',?,?,'v3-local-cms-candidate')`).run(stamp,stamp);
    db.prepare(`INSERT OR IGNORE INTO article_drafts(id,brief_id,title,slug,body_markdown,quality_report_json,status,created_at,updated_at,revision,content_hash)
      VALUES (?, 'v3-local-cms-brief','TEST DATA · Local CMS delivery preview','v3-local-cms-delivery-preview',?,'{}','wordpress_draft',?,?,1,?)`).run(draftId,body,stamp,stamp,bodyHash);
    for (const [table,id] of [["frontend_contract_snapshots","v3-local-contract"],
      ["topic_candidates","v3-local-cms-candidate"],["content_opportunities","v3-local-cms-opportunity"],
      ["content_briefs","v3-local-cms-brief"],["article_drafts",draftId]]) {
      if (!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id)) throw new Error(`Local fixture insert failed: ${table}`);
    }
    const currentDraft=db.prepare("SELECT revision,content_hash FROM article_drafts WHERE id=?").get(draftId);
    if (currentDraft.revision !== 1 || currentDraft.content_hash !== bodyHash) throw new Error("Local preview fixture changed; refusing to attach a stale delivery.");
    db.prepare(`INSERT INTO frontend_page_compositions(id,draft_id,snapshot_id,contract_version,schema_version,contract_checksum,payload_json,validation_json,status,model,generated_at,updated_at,draft_revision,draft_content_hash)
      VALUES ('v3-local-page',?,'v3-local-contract',?,?,?,?,'{"valid":true}','valid','local-fixture',?,?,1,?)
      ON CONFLICT(draft_id) DO UPDATE SET contract_checksum=excluded.contract_checksum,payload_json=excluded.payload_json,
        updated_at=excluded.updated_at,draft_revision=excluded.draft_revision,draft_content_hash=excluded.draft_content_hash`).run(draftId,version,version,checksum,JSON.stringify(packageData.page),stamp,stamp,bodyHash);
    db.prepare(`INSERT INTO commercial_compositions(id,draft_id,publishable_body_markdown,slots_json,offer_ids_json,disclosure_text,status,created_at,updated_at,
        asset_ids_json,commercial_blocks_json,content_blocks_json,strategy_version,draft_revision,draft_content_hash,editorial_page_hash,refresh_required)
      VALUES ('v3-local-commercial',?,?,?,'[]','Paid link','composed',?,?,'[]',?,'[]','v3-local-fixture',1,?,?,0)
      ON CONFLICT(draft_id) DO UPDATE SET slots_json=excluded.slots_json,commercial_blocks_json=excluded.commercial_blocks_json,
        editorial_page_hash=excluded.editorial_page_hash,refresh_required=0,updated_at=excluded.updated_at`).run(draftId,body,
      JSON.stringify(delivered.deliveryManifest.commercial_slots),stamp,stamp,JSON.stringify(blocks.slice(3)),bodyHash,pageHash);
    db.prepare(`INSERT INTO frontend_publish_compositions(id,draft_id,frontend_page_composition_id,commercial_composition_id,snapshot_id,publish_package_version,
        contract_version,page_schema_version,contract_checksum,commercial_strategy_version,publish_package_json,validation_json,status,wordpress_post_id,
        generated_at,updated_at,draft_revision,draft_content_hash,page_content_hash,seo_artifact_hash)
      VALUES ('v3-local-publish',?,'v3-local-page','v3-local-commercial','v3-local-contract','1.0.0',?,?,?,'v3-local-fixture',?,'{"valid":true}','delivered',?,?,?,1,?,?,?)
      ON CONFLICT(draft_id) DO UPDATE SET publish_package_json=excluded.publish_package_json,status='delivered',wordpress_post_id=excluded.wordpress_post_id,
        contract_checksum=excluded.contract_checksum,updated_at=excluded.updated_at,draft_content_hash=excluded.draft_content_hash`).run(
      draftId,version,version,checksum,JSON.stringify(packageData),delivered.postId,stamp,stamp,bodyHash,pageHash,
      hash(JSON.stringify(packageData.seo)));
    db.prepare(`INSERT INTO wordpress_publications(id,draft_id,site_url,post_id,post_url,status,created_at,updated_at,strategy_version,
        preview_url,edit_url,response_json,delivery_mode,delivery_manifest_json)
      VALUES ('v3-local-wordpress',?,'http://127.0.0.1:9400',?,?,'synced',?,?,'v3-local-fixture',?,?,?,'contract',?)
      ON CONFLICT(draft_id) DO UPDATE SET post_id=excluded.post_id,post_url=excluded.post_url,status='synced',updated_at=excluded.updated_at,
        preview_url=excluded.preview_url,edit_url=excluded.edit_url,response_json=excluded.response_json,delivery_manifest_json=excluded.delivery_manifest_json`).run(
      draftId,delivered.postId,delivered.postUrl,stamp,stamp,delivered.previewUrl,delivered.editUrl,JSON.stringify(delivered),
      JSON.stringify(delivered.deliveryManifest));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
} finally { db.close(); }
const ticket = await adapter.createScopedPreviewTicket({ postId: delivered.postId, draftId: "v3-local-cms-draft", revision: 1,
  pagePayloadHash: delivered.deliveryManifest.page_payload_hash });
assert.equal(new URL(ticket.url).origin, "http://127.0.0.1:9400");
process.stdout.write(`${JSON.stringify({ status: delivered.status, postId: delivered.postId, previewUrl: delivered.previewUrl,
  editUrl: delivered.editUrl, contractVersion: delivered.contractVersion, checksum,
  commercialSlots: delivered.deliveryManifest.commercial_slots.length, scopedPreviewOrigin: new URL(ticket.url).origin }, null, 2)}\n`);
