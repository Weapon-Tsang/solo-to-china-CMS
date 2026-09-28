async (page) => {
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.route('**/*',route=>/^http:\/\/127\.0\.0\.1:\d+\//.test(route.request().url())?route.continue():route.abort());
  const before=await page.evaluate(async()=>await(await fetch('/api/content/cover-owner/production-state')).json());
  for(const [name,value] of [['主体左边界 %','40'],['主体上边界 %','40'],['主体宽度 %','20'],['主体高度 %','20'],['焦点横向 %','50'],['焦点纵向 %','50']])
    await page.getByRole('spinbutton',{name,exact:true}).fill(value);
  await page.getByRole('button',{name:'生成封面预览',exact:true}).click();
  const img=page.getByRole('img',{name:'16:9封面预览：Synthetic Hall',exact:true});
  await img.waitFor();await img.evaluate(node=>node.decode());
  const dimensions=await img.evaluate(node=>[node.naturalWidth,node.naturalHeight]);
  if(JSON.stringify(dimensions)!=='[1200,675]')throw new Error('Wrong decoded cover dimensions');
  if(await page.getByRole('button',{name:'确认保存封面'}).isEnabled())throw new Error('Confirmation bypass');
  const layouts=[];
  for(const width of [320,768,1024,1440]) {
    await page.setViewportSize({width,height:1000});
    const overflow=await page.getByRole('dialog').evaluate(node=>node.scrollWidth>node.clientWidth+1);
    if(overflow)throw new Error(`Dialog overflow at ${width}`);
    layouts.push({width,overflow});
  }
  await page.getByRole('checkbox',{name:'已检查预览，主体完整且清晰',exact:true}).focus();
  await page.keyboard.press('Space');
  await page.getByRole('button',{name:'确认保存封面'}).click();
  await page.getByText('封面已保存到本地。接收端能力待验证，新交付保持阻断。',{exact:true}).waitFor();
  const after=await page.evaluate(async()=>await(await fetch('/api/content/cover-owner/production-state')).json());
  for(const key of ['body_markdown','title','slug','revision','content_hash'])
    if(before.draft.draft[key]!==after.draft.draft[key])throw new Error(`Draft changed: ${key}`);
  const selection=await page.evaluate(async()=>await(await fetch('/api/drafts/cover-draft/cover')).json());
  if(!selection.selection?.locked)throw new Error('Selection did not persist');
  await page.screenshot({path:'output/playwright/c-cover-confirmed.png',fullPage:true});
  await page.reload();await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();
  await page.getByText('独立封面 · 本地预览与选择',{exact:true}).click();
  await page.getByText('当前封面：cover-visual · 已锁定 · 仅本地保存',{exact:true}).waitFor();
  if(errors.length)throw new Error(errors.join('\n'));
  return {realBrowser:true,selectionId:selection.selection.id,bodyPreserved:true,dimensions,layouts,
    keyboardConfirmation:true,reloadPersistence:true,providerCalls:0,errors};
}
