async page => {
  const base = page.url();
  const browser = page.context().browser();
  const targets = [
    { key: 'sources', tab: '来源', heading: '研究来源', data: 'Benchmark source 999', alternate: '知识库' },
    { key: 'knowledge', tab: '知识库', heading: '目的地知识', data: 'Benchmark place 0', alternate: '来源' },
    { key: 'content', tab: '内容', heading: '内容生产', data: 'Draft draft-', alternate: '来源' },
  ];
  const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  const ready = async (targetPage, target) => {
    await targetPage.getByRole('heading', { name: target.heading, level: 1, exact: true }).waitFor();
    await targetPage.getByText(target.data, { exact: false }).filter({ visible: true }).first().waitFor();
  };
  const results = [];
  for (const target of targets) {
    const cold = [];
    for (let index = 0; index < 30; index++) {
      const context = await browser.newContext();
      const fresh = await context.newPage();
      const started = Date.now();
      await fresh.goto(base, { waitUntil: 'domcontentloaded' });
      if (target.tab !== '来源') await fresh.getByRole('tab', { name: target.tab, exact: true }).click();
      await ready(fresh, target);
      cold.push(Date.now() - started);
      await context.close();
    }
    const warm = [];
    for (let index = 0; index < 30; index++) {
      await page.getByRole('tab', { name: target.alternate, exact: true }).click();
      await ready(page, targets.find((item) => item.tab === target.alternate));
      const started = Date.now();
      await page.getByRole('tab', { name: target.tab, exact: true }).click();
      await ready(page, target);
      warm.push(Date.now() - started);
    }
    results.push({ tab: target.key, cold: { samplesMs: cold, p50Ms: percentile(cold, 0.5), p95Ms: percentile(cold, 0.95) },
      warm: { samplesMs: warm, p50Ms: percentile(warm, 0.5), p95Ms: percentile(warm, 0.95) } });
  }
  return { format: 'cms-phase01-browser-benchmark-1', createdAt: new Date().toISOString(),
    browser: browser.version(), dataset: 'synthetic_phase01', samplesPerTabAndCondition: 30,
    coldDefinition: 'new browser context and page, navigation through visible data',
    warmDefinition: 'switch from another tab in the existing page through visible data',
    clockResolutionMs: 1, percentileMethod: 'nearest-rank', results };
}
