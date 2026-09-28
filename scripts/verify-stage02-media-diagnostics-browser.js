async page => {
  const dialog=page.getByRole('dialog');
  const area=dialog.getByRole('region',{name:'来源关系修复'});
  const rows=[];
  for(const width of [320,390,768,1024,1440]) {
    await page.setViewportSize({width,height:1000});
    await area.getByRole('button',{name:'检查文件与缺图原因'}).click();
    const diagnostics=area.locator('[aria-label="媒体诊断"]');
    await diagnostics.getByText(/当前不支持自动分离单图/).waitFor();
    if(await area.getByRole('button',{name:'上传图片补齐'}).count()) throw new Error('Unimplemented D upload advertised');
    if(await dialog.evaluate(element=>element.scrollWidth>element.clientWidth+1)) throw new Error(`Overflow ${width}`);
    await diagnostics.scrollIntoViewIfNeeded();
    await page.screenshot({path:`output/playwright/phase02-media-diagnostics-${width}.png`});
    rows.push({width,pdfCapability:true,fallbackTruthful:true,overflow:false});
  }
  await dialog.getByRole('button',{name:'上一组图片'}).click();
  await dialog.getByRole('button',{name:'图片 1',exact:true}).click();
  await area.getByRole('button',{name:'检查文件与缺图原因'}).click();
  const diagnostics=area.locator('[aria-label="媒体诊断"]');
  await diagnostics.getByText(/没有本地原件引用/).waitFor();
  if(await diagnostics.getByText(/当前不支持自动分离单图/).count()) throw new Error('Old PDF diagnosis leaked to next image');
  return {rows,realLocalApi:true,missingOriginal:true,modelCalls:0};
}
