async page => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const requests=[];page.on('request',request=>{
    if (request.url().includes('/binding-repair')) requests.push({method:request.method(),path:request.url().split('/api/')[1]});
  });
  await page.getByRole('button',{name:'1.Context readback fixture'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'图片 1',exact:true}).click();
  const area=dialog.getByRole('region',{name:'来源关系修复'});
  const report=[];
  for (const width of [320,390,768,1024,1440]) {
    await page.setViewportSize({width,height:1000});
    const inspect=area.getByRole('button',{name:'检查来源关系'});
    await inspect.focus();await page.keyboard.press('Enter');
    await area.getByText('Huguang Guild Hall',{exact:true}).waitFor();
    await area.getByRole('button',{name:'按此预览修复关系'}).click();
    await area.getByRole('status').filter({hasText:'来源关系已修复'}).waitFor();
    if (await area.getByRole('button',{name:'按此预览修复关系'}).isEnabled()) throw new Error('Completed action remained enabled');
    const overflow=await dialog.evaluate(element=>element.scrollWidth>element.clientWidth+1);
    if (overflow) throw new Error(`Overflow at ${width}`);
    await area.scrollIntoViewIfNeeded();
    await page.screenshot({path:`output/playwright/phase02-binding-repair-${width}.png`});
    report.push({width,preview:true,apply:true,keyboard:true,overflow:false});
  }
  // Only browser error rendering is injected; DB stale-CAS is a real HTTP test.
  await area.getByRole('button',{name:'检查来源关系'}).click();
  await area.getByRole('button',{name:'按此预览修复关系'}).waitFor();
  await page.route('**/api/source-assets/*/binding-repair',route=>route.request().method()==='POST'
    ? route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'CONTEXT_STALE',error:'Preview stale'})}) : route.continue());
  await area.getByRole('button',{name:'按此预览修复关系'}).click();
  await area.getByRole('alert').filter({hasText:'关系预览已过期'}).waitFor();
  if (await area.getByRole('button',{name:'按此预览修复关系'}).count()) throw new Error('Stale preview remained actionable');
  await page.unroute('**/api/source-assets/*/binding-repair');
  await area.getByRole('button',{name:'检查来源关系'}).click();
  await area.getByText('Huguang Guild Hall',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'下一组图片'}).click();
  await dialog.getByRole('button',{name:'图片 13',exact:true}).click();
  await area.getByRole('button',{name:'检查来源关系'}).click();
  await area.getByRole('alert').filter({hasText:'此项是 PDF 页面证据'}).waitFor();
  if (await area.getByRole('button',{name:'按此预览修复关系'}).count()) throw new Error('PDF was offered photo repair');
  if (errors.length) throw new Error(JSON.stringify(errors));
  return {scope:'Local synthetic source binding preview/apply UI, no adoption or provider',report,
    staleErrorInjection:true,reloadRecovery:true,pdfNotMaterialized:true,requests,pageErrors:errors};
}
