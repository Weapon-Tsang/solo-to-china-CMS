async (page) => {
  const errors=[],outbound=[],requests=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.route('**/*',route=>{const url=route.request().url();if(!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)){outbound.push(url);return route.abort();}return route.continue();});
  page.on('request',request=>{if(request.url().includes('/article-media'))requests.push({method:request.method(),url:request.url().replace(/^http:\/\/[^/]+/,'')});});
  await page.goto('http://127.0.0.1:50510');
  await page.getByRole('textbox',{name:'用户名',exact:true}).fill('cover-test');await page.getByRole('textbox',{name:'密码',exact:true}).fill('cover-local-test-only');
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();
  await page.getByText('上传图片补齐',{exact:true}).click();const panel=page.getByTestId('article-media');
  const before=await page.evaluate(async()=>await(await fetch('/api/content/cover-owner/production-state')).json());
  await panel.getByLabel('补图文件',{exact:true}).setInputFiles('C:/Users/Mloong/AppData/Local/Temp/cms-c-cover-browser-ttoV6D/media/cover-test-master.png');
  await panel.getByText('已保存，待确认采用',{exact:true}).waitFor({timeout:30000});
  await panel.getByRole('checkbox',{name:'选择采用',exact:true}).check();
  await panel.getByLabel('目标槽位',{exact:true}).selectOption('cover-visual');
  await panel.getByLabel('准确英文说明',{exact:true}).fill('Synthetic East Hall fixture for local testing.');
  await panel.getByLabel('与文章对象的关系',{exact:true}).fill('Controlled local fixture; not historical photo suitability.');
  await panel.getByRole('checkbox',{name:'我已核对为对应对象的真实照片',exact:true}).check();
  await panel.getByRole('checkbox',{name:'无须翻译的读者文字，主体清晰且非界面截图',exact:true}).check();
  await panel.getByRole('checkbox',{name:'已查看原图并确认清晰度（小图不放大）',exact:true}).check();
  await panel.getByRole('button',{name:'预览采用差异',exact:true}).click();
  await panel.getByRole('button',{name:'确认采用并继续',exact:true}).waitFor();
  if(await panel.getByRole('button',{name:'确认采用并继续',exact:true}).isEnabled())throw new Error('Confirmation bypass');
  const layouts=[];
  for(const width of [390,768,1440]){await page.setViewportSize({width,height:1050});const overflow=await page.getByRole('dialog').evaluate(el=>el.scrollWidth>el.clientWidth+1);if(overflow)throw new Error(`Overflow at ${width}`);layouts.push({width,overflow});}
  await panel.getByRole('checkbox',{name:'已核对图片、替换范围和说明',exact:true}).focus();await page.keyboard.press('Space');
  await panel.getByRole('button',{name:'确认采用并继续',exact:true}).click();await panel.getByText('本地就绪，未交付',{exact:true}).waitFor({timeout:30000});
  const after=await page.evaluate(async()=>await(await fetch('/api/content/cover-owner/production-state')).json());
  for(const key of ['body_markdown','title','slug','revision','content_hash'])if(before.draft.draft[key]!==after.draft.draft[key])throw new Error(`Draft changed: ${key}`);
  await page.screenshot({path:'output/playwright/d-manual-confirmed.png'});
  const persisted=await page.evaluate(async()=>await(await fetch('/api/drafts/cover-draft/article-media')).json());
  if(persisted.media_revision!==1||persisted.recovery.state!=='local_ready')throw new Error('Missing durable media revision');
  await page.reload();await page.getByRole('tab',{name:'内容',exact:true}).click();await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();await page.getByText('上传图片补齐',{exact:true}).click();
  await page.getByTestId('article-media').getByText('本地就绪，未交付',{exact:true}).waitFor();
  const img=page.getByTestId('article-media').locator('img').first();await img.evaluate(el=>el.decode());
  if(errors.length||outbound.length)throw new Error(JSON.stringify({errors,outbound}));
  return ({status:'PASS',layouts,requests,body_preserved:true,media_revision:persisted.media_revision,page_errors:errors,outbound,preview:await img.evaluate(el=>[el.naturalWidth,el.naturalHeight])});
}
