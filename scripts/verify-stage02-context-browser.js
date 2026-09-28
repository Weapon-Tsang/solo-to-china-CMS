async page => {
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const report=[];
  await page.getByRole('button',{name:'1.Context readback fixture'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('heading',{name:'图片与来源文字'}).waitFor();
  for (const width of [320,390,768,1024,1440]) {
    await page.setViewportSize({width,height:1000});
    const previous=dialog.getByRole('button',{name:'上一组图片'});
    if (await previous.isEnabled()) await previous.click();
    await dialog.getByRole('button',{name:'图片 1',exact:true}).click();
    await dialog.getByText('字符 0–4000 / 53000',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'下一段证据'}).click();
    await dialog.getByText('字符 4000–8000 / 53000',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'上一段证据'}).click();
    await dialog.getByText('字符 0–4000 / 53000',{exact:true}).waitFor();
    await dialog.getByRole('combobox',{name:'证据类型'}).selectOption('caption');
    await dialog.getByText('Caption for image 1',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'下一组图片'}).click();
    const thirteenth=dialog.getByRole('button',{name:'图片 13',exact:true});
    await thirteenth.focus();await page.keyboard.press('Enter');
    await dialog.getByRole('combobox',{name:'证据类型'}).selectOption('caption');
    await dialog.getByText('Caption for image 13',{exact:true}).waitFor();
    const overflow=await dialog.evaluate(element=>element.scrollWidth>element.clientWidth+1);
    if (overflow) throw new Error(`Dialog overflow at ${width}px`);
    await dialog.getByRole('heading',{name:'图片与来源文字'}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`output/playwright/phase02-context-${width}.png`});
    report.push({width,caption:true,prosePagination:true,image13:true,keyboardActivation:true,dialogOverflow:false});
  }
  // Browser error display is fault-injected. Actual server staleness is tested
  // separately by media-context-api.test.mjs against a changed database row.
  await page.route('**/api/source-assets/*/context?*',route=>route.fulfill({status:409,contentType:'application/json',
    body:JSON.stringify({error:'Source context changed',code:'CONTEXT_STALE'})}));
  await dialog.getByRole('button',{name:'重新读取上下文'}).click();
  await dialog.getByRole('alert').filter({hasText:'来源文字已更新'}).waitFor();
  if (await dialog.getByText('Caption for image 13',{exact:true}).count()) throw new Error('Stale excerpt remained visible');
  await page.unroute('**/api/source-assets/*/context?*');
  await dialog.getByRole('button',{name:'重新读取上下文'}).click();
  await dialog.getByText('Caption for image 13',{exact:true}).waitFor();
  if (errors.length) throw new Error(JSON.stringify(errors));
  return {scope:'Synthetic local source context UI',report,staleErrorInjection:true,reloadRecovery:true,pageErrors:errors};
}
