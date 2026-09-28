async (page) => {
  const panel=page.getByLabel('批准路线',{exact:true});
  const text=await panel.innerText();
  if(!text.includes('非关键说明待核实，已省略不确定数值'))throw new Error('Missing nonblocking warning');
  if(text.includes('15 minutes'))throw new Error('Uncertain duration leaked into the approved preview');
  await page.getByText('查看路线版本与来源证据',{exact:true}).click();
  const detail=await page.evaluate(async()=>await(await fetch('/api/content/route-owner/production-state')).json());
  const bundle=detail.route_bundle || detail.draft.route_bundle;
  if(bundle.status!=='FROZEN' || bundle.legs[0].duration!==null || bundle.source_snapshot[0].legs[0].duration.value!==15)
    throw new Error('Omission lost source evidence or incorrectly blocked the route');
  await page.screenshot({path:'output/playwright/a2-route-conditions.png',fullPage:true});
  return {realBrowser:true,status:bundle.status,approvedDuration:bundle.legs[0].duration,
    retainedSourceDuration:bundle.source_snapshot[0].legs[0].duration,diagnostics:bundle.diagnostics,
    stage:detail.production_state.current_stage,realProviderRequests:0};
}
