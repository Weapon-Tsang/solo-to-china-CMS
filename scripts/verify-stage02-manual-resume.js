async (page) => {
  const panel=page.getByTestId('article-media');let release,seen,finished,completeAborted=false;const completion=new Promise(resolve=>finished=resolve);
  const reached=new Promise(resolve=>seen=resolve),gate=new Promise(resolve=>release=resolve);
  await page.route('**/article-media/uploads/*/chunks/0',async route=>{await route.fetch().then(async response=>{seen();await gate;await route.fulfill({response});});});
  const filename='C:/Users/Mloong/AppData/Local/Temp/cms-c-cover-browser-ttoV6D/large-resume-pass.png';
  await panel.getByLabel('补图文件',{exact:true}).setInputFiles(filename);await reached;
  await panel.getByRole('button',{name:'暂停当前上传',exact:true}).click();release();
  await page.waitForFunction(async()=>{const data=await(await fetch('/api/drafts/cover-draft/article-media')).json();return data.items.some(x=>x.filename==='large-resume-pass.png'&&x.state==='paused');});
  await page.unroute('**/article-media/uploads/*/chunks/0');
  await page.reload();await page.getByRole('tab',{name:'内容',exact:true}).click();await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();await page.getByText('上传图片补齐',{exact:true}).click();
  const before=await page.evaluate(async()=>{const data=await(await fetch('/api/drafts/cover-draft/article-media')).json();const item=data.items.find(x=>x.filename==='large-resume-pass.png');return await(await fetch(`/api/drafts/cover-draft/article-media/uploads/${item.id}`)).json();});
  if(JSON.stringify(before.progress.receivedChunks)!=='[0]')throw new Error('Confirmed chunk lost after reload');
  await page.route('**/article-media/uploads/*/complete',async route=>{await route.fetch();completeAborted=true;await route.abort('connectionfailed');finished();});
  await panel.getByLabel('重新选择此原件以续传').setInputFiles(filename);
  await page.waitForFunction(async()=>{const data=await(await fetch('/api/drafts/cover-draft/article-media')).json();return data.items.some(x=>x.filename==='large-resume-pass.png'&&x.asset_id);});
  await page.unroute('**/article-media/uploads/*/complete');
  await panel.getByRole('button',{name:'刷新上传状态',exact:true}).click();await panel.getByText('已保存，待确认采用',{exact:true}).first().waitFor();
  await completion;
  const after=await page.evaluate(async()=>await(await fetch('/api/drafts/cover-draft/article-media')).json());
  const items=after.items.filter(x=>x.filename==='large-resume-pass.png');if(items.length!==1||!completeAborted||items[0].id!==before.id)throw new Error(JSON.stringify({message:'Lost response duplicated original',items,before,completeAborted}));
  await panel.getByText('撤销当前批次采用',{exact:true}).click();await panel.getByLabel('撤销原因',{exact:true}).fill('Local browser regression: restore previous selection.');await panel.getByRole('checkbox',{name:'确认撤销此批次的全部采用',exact:true}).check();await panel.getByRole('button',{name:'撤销采用',exact:true}).click();
  await page.waitForFunction(async()=>{const d=await(await fetch('/api/drafts/cover-draft/article-media')).json();return d.recovery.state==='revoked'&&d.media_revision===2;});
  await page.screenshot({path:'output/playwright/d-manual-resume.png'});
  return {status:'PASS',valid_png_bytes:items[0].upload.size,paused_confirmed_chunks:before.progress.receivedChunks,refresh_reselection:true,finish_response_aborted:true,stable_upload:items[0].id,stored_asset:items[0].asset_id,revocation_media_revision:2,provider_calls:0};
}
