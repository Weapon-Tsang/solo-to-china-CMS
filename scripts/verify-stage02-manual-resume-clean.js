async (page) => {
  const root='http://127.0.0.1:55532';
  const filename='C:/Users/Mloong/AppData/Local/Temp/cms-c-cover-browser-I5npp0/resume-valid-final.png';
  const errors=[],outbound=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',route=>{if(!route.request().url().startsWith(`${root}/`)){outbound.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(root);
  await page.getByRole('textbox',{name:'用户名',exact:true}).fill('cover-test');
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('cover-local-test-only');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();
  await page.getByText('上传图片补齐',{exact:true}).click();
  let releaseFirst,firstSaved;
  const first=new Promise(resolve=>firstSaved=resolve),gate=new Promise(resolve=>releaseFirst=resolve);
  await page.route('**/article-media/uploads/*/chunks/0',async route=>{
    const response=await route.fetch();firstSaved();await gate;await route.fulfill({response});
  },{times:1});
  const panel=page.getByTestId('article-media');
  await panel.getByLabel('补图文件',{exact:true}).setInputFiles(filename);
  await first;
  await panel.getByRole('button',{name:'暂停当前上传',exact:true}).click();releaseFirst();
  await page.waitForFunction(async()=>{const data=await(await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'})).json();return data.items.some(x=>x.filename==='resume-valid-final.png'&&x.state==='paused');});
  const prior=await page.evaluate(async()=>{const data=await(await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'})).json();const item=data.items.find(x=>x.filename==='resume-valid-final.png');return await(await fetch(`/api/drafts/cover-draft/article-media/uploads/${item.id}`,{cache:'no-store'})).json();});
  if(JSON.stringify(prior.progress.receivedChunks)!=='[0]')throw new Error('First chunk was not preserved before reload.');
  await page.reload();await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();
  await page.getByText('上传图片补齐',{exact:true}).click();
  const resent=[];page.on('request',request=>{if(request.url().includes('/chunks/'))resent.push(request.url().split('/').at(-1));});
  let finishIntercepts=0;
  await page.route('**/article-media/uploads/*/complete',async route=>{
    finishIntercepts++;await route.fetch();await route.abort('connectionfailed');
  },{times:1});
  await page.getByTestId('article-media').locator('article').filter({hasText:'resume-valid-final.png'}).getByLabel('重新选择此原件以续传').setInputFiles(filename);
  await page.getByTestId('article-media').locator('article').filter({hasText:'resume-valid-final.png'}).getByText('已保存，待确认采用',{exact:true}).waitFor({timeout:60000});
  await page.waitForFunction(async()=>{const data=await(await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'})).json();return data.items.some(x=>x.filename==='resume-valid-final.png'&&x.asset_id);});
  const after=await page.evaluate(async()=>await(await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'})).json());
  const matches=after.items.filter(x=>x.filename==='resume-valid-final.png');
  if(matches.length!==1||matches[0].id!==prior.id||!matches[0].asset_id||finishIntercepts!==1||resent.includes('0')||!resent.includes('1')||!resent.includes('2'))throw new Error(JSON.stringify({matches,prior_id:prior.id,finishIntercepts,resent}));
  await page.getByTestId('article-media').getByRole('button',{name:'刷新上传状态',exact:true}).click();
  await page.getByTestId('article-media').getByText('已保存，待确认采用',{exact:true}).first().waitFor();
  await page.screenshot({path:'output/playwright/stage02-resume-clean.png'});
  if(errors.length||outbound.length)throw new Error(JSON.stringify({errors,outbound}));
  return {status:'PASS',bytes:matches[0].upload.size,received_before_reload:prior.progress.receivedChunks,resumed_chunk_requests:resent,finish_response_lost:true,stable_upload_id:prior.id,stored_asset_id:matches[0].asset_id,duplicates:matches.length-1,page_errors:errors,outbound};
}
