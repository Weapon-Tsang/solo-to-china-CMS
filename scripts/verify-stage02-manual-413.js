async (page) => {
  await page.goto('http://127.0.0.1:55532');await page.getByRole('textbox',{name:'用户名',exact:true}).fill('cover-test');await page.getByRole('textbox',{name:'密码',exact:true}).fill('cover-local-test-only');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();await page.getByText('上传图片补齐',{exact:true}).click();
  let intercepted=0;
  await page.route('**/article-media/uploads/*/chunks/0',route=>{intercepted++;return route.fulfill({status:413,contentType:'application/json',body:JSON.stringify({error:'Proxy rejects this upload chunk',code:'PROXY_CHUNK_LIMIT'})});},{times:1});
  const panel=page.getByTestId('article-media'),filename='C:/Users/Mloong/AppData/Local/Temp/cms-c-cover-browser-I5npp0/proxy-413-accepted.png';
  await panel.getByLabel('补图文件',{exact:true}).setInputFiles(filename);
  await panel.getByRole('alert').getByText(/413/).waitFor();
  const before=await page.evaluate(async()=>{const data=await(await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'})).json();const item=data.items.find(x=>x.filename==='proxy-413-accepted.png');return await(await fetch(`/api/drafts/cover-draft/article-media/uploads/${item.id}`,{cache:'no-store'})).json();});
  if(before.asset_id||before.state!=='paused'||before.progress.receivedChunks.length||intercepted!==1)throw new Error('413 falsely stored original.');
  await panel.locator('article').filter({hasText:'proxy-413-accepted.png'}).getByLabel('重新选择此原件以续传').setInputFiles(filename);
  await panel.locator('article').filter({hasText:'proxy-413-accepted.png'}).getByText('已保存，待确认采用',{exact:true}).waitFor({timeout:30000});
  const after=await page.evaluate(async()=>await(await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'})).json());
  const originals=after.items.filter(x=>x.filename==='proxy-413-accepted.png');
  if(originals.length!==1||originals[0].id!==before.id||!originals[0].asset_id)throw new Error(JSON.stringify({message:'Retry duplicated session',originals,before_id:before.id}));
  return {status:'PASS',proxy_413_displayed:true,server_chunk_before_retry:before.progress.receivedChunks,stable_upload_id:before.id,
    original_stored_after_retry:true,duplicates:originals.length-1};
}
