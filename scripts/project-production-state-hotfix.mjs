import fs from "node:fs";
import path from "node:path";

const [beforePath="output/production-state-hotfix/production-state-before.json",outputPath="output/production-state-hotfix/production-state-after-dry-run.json"]=process.argv.slice(2);
const before=JSON.parse(fs.readFileSync(beforePath,"utf8"));
const approved=(before.classification?.rows || []).filter((row)=>row.approved_at);
const owners=new Map();
for (const row of approved) {
  if (owners.has(row.opportunity_id)) throw new Error(`Duplicate production owner ${row.opportunity_id}`);
  owners.set(row.opportunity_id,row);
}
const jobOwners=new Map();
for (const row of owners.values()) for (const jobId of row.all_visible_job_ids || []) {
  if (jobOwners.has(jobId) && jobOwners.get(jobId)!==row.opportunity_id) throw new Error(`Job ${jobId} has duplicate owners`);
  jobOwners.set(jobId,row.opportunity_id);
}
const items=[...owners.values()].map((row)=>({
  production_instance_id:row.opportunity_id,
  production_owner_opportunity_id:row.opportunity_id,
  title:row.title,
  approved_at:row.approved_at,
  projected_lifecycle:"needs_attention",
  projected_stage_status:row.category==="3_approved_ready_not_started" ? "interrupted" : "failed",
  owned_job_ids:row.all_visible_job_ids || [],
}));
const report={
  audit_contract:"production-state-hotfix-after-dry-run-v1",
  generated_at:new Date().toISOString(),
  source_before_report:path.resolve(beforePath),
  dry_run:true,
  production_database_modified:false,
  projection:{
    app_version:"2.0.13",schema_version:69,production_state_version:"1.1",
    current_production:items.length,pending_start:0,in_progress:0,
    needs_attention:items.filter((item)=>item.projected_lifecycle==="needs_attention").length,
    completed:0,history:0,
    excluded_unapproved:Number(before.classification?.counts?.["1_never_approved_false_positive"] || 0)
      + Number(before.classification?.counts?.["7_duplicate_projection_shared_candidate_job"] || 0),
    duplicate_owner_count:0,duplicate_job_ownership_count:0,
  },
  invariants:{
    approved_decisions_unchanged:true,model_calls_enqueued:0,jobs_enqueued:0,wordpress_writes:0,
    model_call_metrics_baseline:before.baselines?.model_call_metrics_total,
    active_production_jobs_baseline:before.baselines?.active_production_jobs?.length || 0,
  },
  items,
};
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
fs.writeFileSync(outputPath,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({output:path.resolve(outputPath),...report.projection}));
