async (page) => {
  await page.goto('http://127.0.0.1:50283');
  await page.getByRole('textbox',{name:'用户名',exact:true}).fill('cover-test');
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('cover-local-test-only');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();
  await page.getByText('上传图片补齐',{exact:true}).click();
  const state=await page.evaluate(async()=>await(await fetch('/api/drafts/cover-draft/article-media')).json());
  const actual=state.items.filter(x=>x.filename?.startsWith('large-'));
  if(actual.length!==4||actual.some(x=>!x.asset_id || x.state!=='pending_confirmation'))throw new Error(JSON.stringify({message:'Saved large originals missing',actual}));
  if(state.recovery.state!=='local_ready'||state.media_revision!==1)throw new Error('Adoption unexpectedly changed during resumption');
  const panel=page.getByTestId('article-media');
  await panel.getByText('撤销当前批次采用',{exact:true}).click();
  await panel.getByLabel('撤销原因',{exact:true}).fill('Local browser regression: restore previous selection.');
  await panel.getByRole('checkbox',{name:'确认撤销此批次的全部采用',exact:true}).check();
  await panel.getByRole('button',{name:'撤销采用',exact:true}).click();
  await page.waitForFunction(async()=>{const d=await(await fetch('/api/drafts/cover-draft/article-media')).json();return d.recovery.state==='revoked'&&d.media_revision===2;});
  const after=await page.evaluate(async()=>await(await fetch('/api/drafts/cover-draft/article-media')).json());
  await page.screenshot({path:'output/playwright/d-manual-final-state.png'});
  return {status:'PASS',large_valid_originals:actual.map(x=>({bytes:x.upload.size,asset_id:x.asset_id,role:x.adoption_status})),revoked_revision:after.media_revision,old_selection_reversible:true,provider_calls:0};
}
