async page => {
  const base = 'http://127.0.0.1:4311';
  const report = { passed: [], errors: [] };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    report.passed.push(message);
  };
  page.on('pageerror', error => report.errors.push(error.message));

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(base);
    await page.getByRole('heading', { name: '研究来源', exact: true }).waitFor();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal overflow at ${width}px`);
    check(await page.getByText('应用 v2.0.42 · 策略 v3.8 · 仅处理人工选定来源', { exact: true }).isVisible(), `Current app and strategy versions are visible at ${width}px`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /策略 v3\.8/ }).click();
  const strategyDialog = page.getByRole('dialog');
  await strategyDialog.waitFor();
  check((await strategyDialog.textContent()).includes('不变的安全边界'), 'Strategy dialog preserves the immutable safety boundary');
  check((await strategyDialog.textContent()).includes('working_title'), 'Strategy dialog exposes the explicit editorial planning contract');
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: '内容', exact: true }).click();
  check(await page.getByText(/内容工作台|暂无.*内容|尚无.*内容/).first().isVisible(), 'Content workspace remains usable with an empty disposable database');
  await page.getByRole('tab', { name: '商品', exact: true }).click();
  check(await page.getByText(/联盟商品|商品/).first().isVisible(), 'Commercial workspace remains reachable without configured inventory');
  await page.screenshot({ path: 'output/unified-upgrade-cms-mobile.png', fullPage: true });

  check(report.errors.length === 0, 'No uncaught browser errors');
  return report;
}
