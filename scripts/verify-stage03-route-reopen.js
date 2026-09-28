async page => {
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:/Three-day historical itinerary Draft/}).click();
  const panel=page.getByTestId('article-media');
  if(!await panel.evaluate(el=>el.open))await panel.getByText('上传图片补齐',{exact:true}).click();
  const difference=panel.getByText('正文需要 Day 2，图片标注 Day 3',{exact:true});
  await difference.waitFor();await difference.scrollIntoViewIfNeeded();
  await page.screenshot({path:'output/playwright/phase03-route-reopened.png'});
  return {status:'PASS',conflict_preserved_after_reopen:true,scope:'persisted administrator-declared Day mismatch; not image pixel QA'};
}
