async page => {
  // Run after signing into the isolated fixture; pass its PNG via PDF_FIXTURE_IMAGE replacement.
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const open=async()=>{
    await page.getByRole('button',{name:/1.PDF supplement fixture/}).click();
    await page.getByRole('button',{name:'图片 1',exact:true}).click();
    await page.getByRole('button',{name:'检查文件与缺图原因'}).click();
    await page.getByRole('button',{name:'为这份PDF补充图片'}).click();
    await page.locator('[aria-label="PDF 来源补图"] input[type="file"]:enabled').waitFor();
  };
  await open();
  for(let i=0;i<2;i++) {
    await page.getByLabel('选择独立图片').setInputFiles('PDF_FIXTURE_IMAGE');
    await page.getByRole('button',{name:'上传并保存原件 / 重试'}).click();
    await page.getByText('原件已保存，待确认',{exact:true}).waitFor();
    await page.getByRole('spinbutton',{name:'对应页码（可留空）'}).fill(i ? '' : '1');
    await page.getByRole('textbox',{name:'有依据的图注 / 来源对应说明'}).fill(i ? '' : 'Photo depicts Huguang Guild Hall.');
    await page.getByRole('combobox',{name:'图片实际类型'}).selectOption(i ? 'unknown' : 'documentary_photo');
    await page.getByRole('button',{name:'确认来源对应关系'}).focus();
    await page.keyboard.press('Enter');
    await page.getByText('已加入来源素材，尚未替换文章配图。',{exact:true}).waitFor();
  }
  const area=page.locator('[aria-label="PDF 来源补图"]');
  await area.getByText('Huguang Guild Hall：来源证据支持',{exact:true}).waitFor();
  await area.getByText('仅来源候选，尚无明确实体关系',{exact:true}).waitFor();
  if(await area.getByRole('link').count()!==2)throw new Error('Append lost an earlier receipt');
  const [preview]=await Promise.all([page.waitForEvent('popup'),area.getByRole('link').first().click()]);
  await preview.waitForLoadState();
  if(!await preview.locator('img').evaluate(image=>image.naturalWidth===640))throw new Error('Preview unavailable');
  await preview.close();
  const widths=[];
  for(const width of [320,768,1024,1440]) {
    await page.setViewportSize({width,height:1000});await area.scrollIntoViewIfNeeded();
    if(await area.evaluate(element=>element.scrollWidth>element.clientWidth+1))throw new Error(`Overflow ${width}`);
    await page.screenshot({path:`output/playwright/a1-pdf-final-${width}.png`});widths.push(width);
  }
  await page.reload();await open();
  await area.getByText('Huguang Guild Hall：来源证据支持',{exact:true}).waitFor();
  if(await area.getByRole('link').count()!==2)throw new Error('Reload lost supplements');
  if(errors.length)throw new Error(errors.join('\n'));
  return {case:'T02-46g',realApi:true,uploads:2,confirmed:2,unknownPagePreserved:true,
    candidateAndSupportedDistinct:true,preview:true,keyboardConfirmation:true,widths,reloadPersists:true,pageErrors:errors};
}
