async (page) => {
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.getByText('查看省略原因',{exact:true}).click();
  const feedback=page.getByLabel('批准路线',{exact:true});
  const text=await feedback.innerText();
  if(!text.includes('ROUTE_RENDER_STORAGE_MISSING') || !text.includes('已省略'))throw new Error('Missing actionable omission feedback');
  const detail=await page.evaluate(async()=>await(await fetch('/api/content/route-owner/production-state')).json());
  const visual=detail.draft.draft.visuals.find(v=>v.acquisition_strategy==='render_route_schematic');
  if(visual.status!=='skipped' || visual.attempt_count!==1 || !visual.media_metadata.route_omission)
    throw new Error('UI omission does not match persisted Worker result');
  await page.screenshot({path:'output/playwright/a2-optional-route-feedback.png',fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  return {realBrowser:true,realWorker:true,status:visual.status,attempts:visual.attempt_count,
    omission:visual.media_metadata.route_omission,bodyHash:detail.draft.draft.content_hash,
    stage:detail.production_state.current_stage,pageErrors:errors,realProviderRequests:0};
}
