async (page) => {
  const errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.unroute('**/*');
  await page.route('**/*',route=>/^http:\/\/127\.0\.0\.1:\d+\//.test(route.request().url())?route.continue():route.abort());
  await page.reload();
  await page.getByRole('textbox',{name:'用户名'}).fill('a2-test');
  await page.getByRole('textbox',{name:'密码'}).fill('a2-local-test-only');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Beijing one-day itinerary'}).click();
  const panel=page.getByLabel('批准路线',{exact:true});
  await panel.getByRole('heading',{name:'批准路线 · 版本 1'}).waitFor();
  const evidence=panel.locator('summary').filter({hasText:'查看路线版本与来源证据'});
  await evidence.focus();await page.keyboard.press('Enter');
  await panel.getByText('路线指纹：',{exact:false}).waitFor({state:'visible'});
  await panel.getByText('查看本地路线示意图',{exact:true}).click();
  const image=panel.getByRole('img');
  await image.waitFor({state:'visible'});
  await image.evaluate(img=>img.decode());
  const width=await image.evaluate(img=>img.naturalWidth);
  if(width!==1100)throw new Error(`Actual route PNG failed to decode: ${width}`);
  await page.setViewportSize({width:390,height:844});
  const overflow=await panel.evaluate(node=>node.scrollWidth>node.clientWidth+1);
  if(overflow)throw new Error('Route panel overflows at 390px');
  await page.screenshot({path:'output/playwright/a2-route-final-390.png'});
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:'output/playwright/a2-route-final-1440.png'});
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.reload();
  await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Beijing one-day itinerary'}).click();
  await page.getByRole('heading',{name:'批准路线 · 版本 1'}).waitFor();
  if(errors.length)throw new Error(errors.join('\n'));
  return {login:true,realContentDetail:true,keyboardEvidenceExpansion:true,pngDecoded:width,overflow:false,
    reloadPreserved:true,pageErrors:errors,scope:'Route preview only; adoption, revision and recovery NOT TESTED'};
}
