// Read-only release probes. No content mutation, queue action or model invocation.
const base = process.env.STC_DIAGNOSTIC_URL || 'https://engine.solotochina.com';
const token = process.env.STC_DIAGNOSTIC_TOKEN;
async function get(path) {
  const started=Date.now();
  const response = await fetch(base + path, {headers:token ? {Authorization:'Bearer '+token} : {}, signal:AbortSignal.timeout(45000)});
  if(!response.ok) throw new Error(path+': HTTP '+response.status);
  const result=await response.json();
  console.log(JSON.stringify({probe:'request',path,status:response.status,durationMs:Date.now()-started}));
  return result;
}
const health=await get('/api/health');
console.log(JSON.stringify({probe:'health',version:health.version,strategy:health.contentStrategy?.version,queueActive:health.queueActive,vertexBatchActive:health.vertexBatchActive,frontendContract:health.frontendContract}));
console.log(JSON.stringify({probe:'ready',result:await get('/api/ready')}));
if(token) {
  const dashboard=await get('/api/dashboard');
  console.log(JSON.stringify({probe:'dashboard',actions:dashboard.actionCounts,totals:dashboard.totals}));
  const sources=await get('/api/sources?limit=500');
  const sourceRows=sources.items || [];
  const sum=(key)=>sourceRows.reduce((total,row)=>total+Number(row[key] || 0),0);
  console.log(JSON.stringify({probe:'sources',count:sourceRows.length,
    statuses:Object.fromEntries(Object.entries(Object.groupBy(sourceRows,row=>row.status)).map(([key,rows])=>[key,rows.length])),
    media:{discovered:sum('discovered_media_count'),originals:sum('stored_original_count'),browserRepair:sum('browser_repair_count'),serverRepair:sum('server_repair_count')},
    experience:Object.fromEntries(Object.entries(Object.groupBy(sourceRows,row=>row.experience_status || 'missing')).map(([key,rows])=>[key,rows.length]))}));
  const rec=await get('/api/recommendations?limit=500');
  console.log(JSON.stringify({probe:'recommendations',count:rec.items?.length,summary:rec.summary,comparisonGroups:rec.comparisonGroups?.length}));
  const content=await get('/api/content');
  console.log(JSON.stringify({probe:'content',count:content.items?.length,rows:content.items?.map(r=>({id:r.id,draftId:r.draft_id,status:r.draft_status,score:r.qa_score}))}));
  const exceptions=await get('/api/exceptions?limit=500');
  console.log(JSON.stringify({probe:'exceptions',count:exceptions.items?.length,pagination:exceptions.pagination,summary:exceptions.summary}));
  const maintenance=await get('/api/maintenance');
  console.log(JSON.stringify({probe:'maintenance',summary:maintenance.summary,cards:maintenance.cards,mediaDurability:maintenance.mediaDurability,experienceBackfill:maintenance.experienceBackfill,recommendationBackfill:maintenance.recommendationBackfill,failedProductionCleanup:maintenance.failedProductionCleanup}));
  const commercial=await get('/api/commercial');
  console.log(JSON.stringify({probe:'commercial',providers:commercial.providers?.length,assets:commercial.items?.length,opportunities:commercial.opportunities?.length,queue:commercial.queue?.length}));
  if(process.argv.includes('--recovery')) for(const row of content.items || []) {
    const report=await get('/api/topics/'+encodeURIComponent(row.id)+'/recovery');
    console.log(JSON.stringify({probe:'recovery',candidateId:row.id,revision:report.revision,sourceCount:report.sources?.length,assetCount:report.assets?.length,canCorrectDestination:report.canCorrectDestination}));
  }
}
