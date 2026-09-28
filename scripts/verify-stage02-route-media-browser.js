async (page) => {
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',route=>/^http:\/\/127\.0\.0\.1:\d+\//.test(route.request().url())?route.continue():route.abort());
  const read=()=>page.evaluate(async()=>await(await fetch('/api/content/route-owner/production-state')).json());
  const before=await read();
  if(before.production_state.recovery_target!=='generate_visuals')throw new Error('Wrong recovery target');
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'重试失败步骤',exact:true}).click();
  await page.getByRole('button',{name:'重新执行',exact:true}).click();
  let complete=false;
  for(let attempt=0;attempt<30;attempt++) {
    const state=await read();
    if(state.draft.draft.visuals.some(v=>v.acquisition_strategy==='render_route_schematic' && v.status==='generated')){complete=true;break;}
    await page.waitForTimeout(300);
  }
  if(!complete)throw new Error('Actual Worker did not recover the route image');
  const after=await read(),a=before.draft.draft,b=after.draft.draft;
  if(a.body_markdown!==b.body_markdown || a.content_hash!==b.content_hash || a.revision!==b.revision)throw new Error('Draft changed');
  const old=a.visuals.find(v=>v.acquisition_strategy==='render_route_schematic');
  const image=b.visuals.find(v=>v.acquisition_strategy==='render_route_schematic');
  if(old.id!==image.id || old.attempt_count!==image.attempt_count
    || JSON.stringify(old.media_metadata.recovery_budget)!==JSON.stringify(image.media_metadata.recovery_budget))throw new Error('Budget/slot changed');
  await page.reload();await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Beijing one-day itinerary'}).click();
  await page.getByText('查看本地路线示意图',{exact:true}).click();
  const img=page.getByLabel('批准路线',{exact:true}).getByRole('img');
  await img.evaluate(node=>node.decode());
  if(await img.evaluate(node=>node.naturalWidth)!==1100)throw new Error('PNG decode failed');
  await page.screenshot({path:'output/playwright/a2-media-recovered.png',fullPage:true});
  if(errors.length)throw new Error(errors.join('\n'));
  return {realBrowserRecovery:true,realWorker:true,bodyPreserved:true,slotId:image.id,attempts:image.attempt_count,
    budget:image.media_metadata.recovery_budget,manifest:image.media_metadata.route_render_manifest,
    stageAfter:after.production_state.current_stage,realProviderRequests:0,pageErrors:errors};
}
