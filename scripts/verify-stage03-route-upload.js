async (page) => {
  const errors = [], requests = [], outbound = [], serverErrors = [];
  await page.unrouteAll(); page.removeAllListeners('request'); page.removeAllListeners('pageerror');
  const origin = page.url().match(/^https?:\/\/[^/]+/)[0];
  page.on('response', response => { if(response.url().startsWith(origin + '/') && response.status() >= 500) serverErrors.push({url:response.url(),status:response.status()}); });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => {
    if (!route.request().url().startsWith(origin + '/')) { outbound.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  page.on('request', request => { if (request.url().includes('/article-media')) requests.push({method:request.method(),path:request.url().slice(origin.length).split('?')[0]}); });
  const panel = page.getByTestId('article-media');
  if (!await panel.evaluate(el=>el.open)) await panel.getByText('上传图片补齐',{exact:true}).click();
  // Created by stage03-browser-fixture, never a real-world photo assertion.
  const photo = 'output/playwright/phase03-synthetic.png';
  const before = await page.evaluate(async () => (await (await fetch('/api/content/route-owner/production-state')).json()).draft.draft);
  async function upload() {
    const count = await panel.locator('article').count();
    await panel.getByLabel('补图文件',{exact:true}).setInputFiles(photo);
    await panel.locator('article').nth(count).getByText('已保存，待确认采用',{exact:true}).waitFor({timeout:30000});
    const item = panel.locator('article').last();
    await item.getByRole('checkbox',{name:'选择采用',exact:true}).check();
    await item.getByLabel('准确英文说明',{exact:true}).fill('East Hall in the approved route.');
    await item.getByLabel('与文章对象的关系',{exact:true}).fill('Synthetic local fixture; administrator identifies this article scene.');
    return item;
  }
  let item = await upload();
  await item.getByLabel('照片对应路线站点').selectOption('east');
  for (const name of ['我已核对为对应对象的真实照片','无须翻译的读者文字，主体清晰且非界面截图','已查看原图并确认清晰度（小图不放大）']) await item.getByRole('checkbox',{name,exact:true}).check();
  for (const name of ['我已核对为对应对象的真实照片','无须翻译的读者文字，主体清晰且非界面截图','已查看原图并确认清晰度（小图不放大）']) if(!await item.getByRole('checkbox',{name,exact:true}).isChecked()) throw new Error('Missing checkbox: '+name);
  const planning = page.waitForResponse(response=>response.url().endsWith('/article-media/plan'));
  await panel.getByRole('button',{name:'预览采用差异',exact:true}).click();
  const planned = await (await planning).json();
  if (!planned.selections?.[0]?.local_photo) throw new Error('Photo assertions not received: '+JSON.stringify(planned));
  await panel.getByRole('checkbox',{name:'已核对图片、替换范围和说明',exact:true}).check();
  await panel.getByRole('button',{name:'确认采用并继续',exact:true}).click();
  await panel.getByText('本地就绪，未交付',{exact:true}).waitFor({timeout:30000});
  item = await upload();
  await item.getByLabel('图片类型').selectOption('route');
  await item.getByLabel('要配图的路线日').selectOption({label:'Day 2'});
  await item.getByLabel('图片实际标注的 Day').fill('Day 3');
  await panel.getByRole('button',{name:'预览采用差异',exact:true}).click();
  await panel.getByText('正文需要 Day 2，图片标注 Day 3',{exact:true}).waitFor();
  const layouts=[];
  for(const width of [320,768,1024,1440]) {
    await page.setViewportSize({width,height:1000});
    layouts.push({width,overflow:await panel.evaluate(el=>el.scrollWidth>el.clientWidth+1)});
  }
  await panel.screenshot({path:'output/playwright/phase03-route-conflict.png'});
  await panel.getByRole('checkbox',{name:'已核对图片、替换范围和说明',exact:true}).focus(); await page.keyboard.press('Space');
  await panel.getByRole('button',{name:'确认采用并继续',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'图片标注与批准路线冲突'}).waitFor();
  const after = await page.evaluate(async () => (await (await fetch('/api/content/route-owner/production-state')).json()).draft.draft);
  for(const key of ['body_markdown','content_hash','revision','title','slug']) if(before[key]!==after[key]) throw new Error(`Protected content changed: ${key}`);
  const saved = await page.evaluate(async id => (await fetch(`/api/drafts/${id}/article-media`)).json(),before.id);
  await page.reload();
  await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:/Three-day historical itinerary Draft/}).click();
  await page.getByTestId('article-media').getByText('上传图片补齐',{exact:true}).click();
  await page.getByTestId('article-media').getByText('已存会话 2 · 媒体版本 2',{exact:true}).waitFor();
  const audit = await page.evaluate(async id=>{const response=await fetch(`/api/drafts/${id}/cover-audit`);return {status:response.status,body:await response.json()};},before.id);
  if(audit.status!==200)throw new Error(`Cover audit HTTP ${audit.status}: ${JSON.stringify(audit.body)}`);
  if(errors.length||outbound.length||serverErrors.length||layouts.some(x=>x.overflow)) throw new Error(JSON.stringify({errors,outbound,serverErrors,layouts}));
  return {status:'PASS',scope:'real browser, upload API, SQLite and local PNG/WebP; synthetic declared Day conflict; no pixel QA or WordPress claim',
    requests,layouts,errors,outbound,serverErrors,cover_audit_status:audit.status,body_preserved:true,content_hash:after.content_hash,media_revision:saved.media_revision,
    recovery:saved.recovery,originals:saved.items.map(x=>({id:x.id,receipt:x.receipt}))};
}
