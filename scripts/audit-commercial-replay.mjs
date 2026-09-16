import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.mjs";
import { Repository } from "../src/repository.mjs";
import { CommercialComposer } from "../src/commercial.mjs";
import { loadConfig } from "../src/config.mjs";

const args=process.argv.slice(2);
const value=(name)=>args.includes(name) ? args[args.indexOf(name)+1] || "" : "";
const requestedDrafts=[...new Set(args.filter((item,index)=>args[index-1] === "--draft"))];
const expectedCount=Number(value("--expected-count") || requestedDrafts.length);
if (!value("--baseline") || !value("--work") || !args.includes("--development-copy")) {
  throw new Error("--baseline <read-only sqlite> --work <disposable sqlite> --development-copy are required.");
}
if (!requestedDrafts.length || requestedDrafts.length > 20) throw new Error("Pass an explicit 1-20 item whitelist with repeated --draft <id> arguments.");
if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount !== requestedDrafts.length) throw new Error("--expected-count must equal the explicit draft whitelist length.");
const baselinePath=path.resolve(value("--baseline"));
const workPath=path.resolve(value("--work"));
if (baselinePath === workPath) throw new Error("Baseline and work database must be different files.");
if (!fs.existsSync(baselinePath) || !fs.existsSync(workPath)) throw new Error("Baseline and disposable work database must already exist; this audit never creates a target database.");
const baseline=new DatabaseSync(baselinePath,{readOnly:true});
const work=openDatabase(workPath);
try {
  const repository=new Repository(work);
  const composer=new CommercialComposer(loadConfig().commercial);
  const foundRows=work.prepare(`SELECT id FROM article_drafts WHERE id IN (${requestedDrafts.map(()=>"?").join(",")}) ORDER BY id`).all(...requestedDrafts);
  const ids=foundRows.map((row)=>row.id);
  if (ids.length !== requestedDrafts.length) {
    const found=new Set(ids); throw new Error(`Explicit audit whitelist mismatch; missing: ${requestedDrafts.filter((id)=>!found.has(id)).join(", ")}`);
  }
  const providers=repository.listAffiliateProviderAccounts();
  const allAssets=repository.listAffiliateAssets();
  const items=[];
  for (const draftId of ids) {
    const before=snapshot(baseline,draftId);
    const pack=repository.getDraftPackage(draftId);
    if (!pack?.review?.passed || !pack?.frontend_page?.current) {
      items.push({draft_id:draftId,status:"blocked",reason:!pack?.review?.passed ? "qa_not_passed" : "editorial_page_not_current"});
      continue;
    }
    const inventory=repository.activeOffersForDestination(pack.brief.destination_slug);
    const composition=composer.compose(pack,inventory);
    const demandCategories=Object.fromEntries([...new Set(composition.intents.map((item)=>item.productCategory))].sort()
      .map((category)=>[category,composition.intents.filter((item)=>item.productCategory===category).length]));
    repository.saveCommercialComposition(draftId,composition);
    const after=snapshot(work,draftId);
    items.push({draft_id:draftId,title:pack.draft.title,revision:pack.draft.revision,wordpress_post_id:pack.publication?.post_id || null,
      page_hash:hash(JSON.stringify(pack.frontend_page.payload || {})),contract_checksum:pack.frontend_page.contract_checksum || null,
      demand_categories:demandCategories,status:"replayed",funnel:{inventory:inventory.length,intents:composition.intents.length,
        eligible:composition.diagnostics?.intents?.reduce((sum,item)=>sum + Number(item.eligibleCount || 0),0) || 0,
        selected:composition.slots.length,composition:composition.commercialBlocks.length,
        publish:null,wordpress_saved:null,visible_dom:null},outcome:composition.outcome,reason_code:composition.reasonCode,
      inventory_diagnostics:{provider_total:providers.length,provider_configured:providers.filter((row)=>row.status === "CONFIGURED").length,
        asset_total:allAssets.length,asset_operational:allAssets.filter((row)=>row.active && row.lifecycle_state === "operational").length,
        candidate_total:composition.diagnostics?.intents?.reduce((sum,item)=>sum+Number(item.candidateCount || 0),0) || 0,
        eligible_total:composition.diagnostics?.intents?.reduce((sum,item)=>sum+Number(item.eligibleCount || 0),0) || 0,
        exclusions:mergeExclusions(composition.diagnostics?.intents || [])},
      first_unverified_layer:composition.slots.length ? "publish_package" : ["asset_not_configured","eligibility_rejected"].includes(composition.outcome) ? "asset_eligibility" : "no_relevant_intent",
      protection:{body_hash_unchanged:before.body_hash===after.body_hash,visual_hash_unchanged:before.visual_hash===after.visual_hash,
        post_id_unchanged:before.post_id===after.post_id,draft_status_before:before.status,draft_status_after:after.status}});
  }
  const report={mode:"deterministic_commercial_replay_on_disposable_copy",baseline:baselinePath,work:workPath,
    whitelist:{requested:requestedDrafts.length,found:ids.length,audited:items.length,draft_ids:requestedDrafts},
    inventory:{provider_total:providers.length,asset_total:allAssets.length,source:"operator_supplied_database_copy",currentness:"not_asserted"},
    external_model_calls:0,external_wordpress_calls:0,items,summary:{replayed:items.filter((item)=>item.status==="replayed").length,
      protected:items.filter((item)=>item.protection?.body_hash_unchanged&&item.protection?.visual_hash_unchanged&&item.protection?.post_id_unchanged).length}};
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
} finally { baseline.close(); work.close(); }

function snapshot(db,draftId) {
  const row=db.prepare(`SELECT ad.body_markdown,ad.status,wp.post_id,
    (SELECT group_concat(asset_fingerprint,'|') FROM article_visuals v WHERE v.draft_id=ad.id ORDER BY slot) visual_fingerprints
    FROM article_drafts ad LEFT JOIN wordpress_publications wp ON wp.draft_id=ad.id WHERE ad.id=?`).get(draftId) || {};
  return {body_hash:hash(row.body_markdown || ""),visual_hash:hash(row.visual_fingerprints || ""),post_id:row.post_id || null,status:row.status || null};
}
function hash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function mergeExclusions(items){const output={};for(const item of items){for(const [key,count] of Object.entries(item.exclusions || {}))output[key]=(output[key] || 0)+Number(count || 0);}return output;}
