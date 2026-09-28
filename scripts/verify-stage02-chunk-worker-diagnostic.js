async (page) => {
  await page.goto('http://127.0.0.1:60362');
  await page.getByRole('textbox',{name:'用户名',exact:true}).fill('cover-test');
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('cover-local-test-only');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Cover selection fixture Draft'}).click();await page.getByText('上传图片补齐',{exact:true}).click();
  const panel=page.getByTestId('article-media');
  await panel.getByLabel('补图文件',{exact:true}).setInputFiles('C:/Users/Mloong/AppData/Local/Temp/cms-c-cover-browser-tYSlha/chunk-worker-fixed.png');
  await panel.getByRole('status').getByText(/校验|保存/).first().waitFor();
  await page.waitForTimeout(1000);
  return {message:await panel.getByRole('status').first().innerText(),alert:await panel.getByRole('alert').allInnerTexts()};
}
