async (page) => {
  await page.setViewportSize({width:1440,height:1000});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const content=page.getByRole('tab',{name:'内容',exact:true}),sources=page.getByRole('tab',{name:'来源',exact:true});
  const cold=[],warm=[],memory=[],windows=[];const startedAt=Date.now();
  await content.click();await page.getByRole('button',{name:/Guide /}).first().waitFor();await sources.click();
  for(let i=0;i<30;i++){
    const sampleStart=Date.now();
    await page.reload({waitUntil:'domcontentloaded'});await sources.waitFor();
    let start=Date.now();await content.click();await page.getByRole('button',{name:/Guide /}).first().waitFor();cold.push(Date.now()-start);
    await sources.click();await page.getByRole('heading',{name:'研究来源',exact:true}).waitFor();
    start=Date.now();await content.click();await page.getByRole('button',{name:/Guide /}).first().waitFor();warm.push(Date.now()-start);
    windows.push({start:sampleStart,end:Date.now()});
    memory.push(await page.evaluate(()=>performance.memory?{at:Date.now(),usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:null));
  }
  const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values,p50_ms:sorted[14],p95_ms:sorted[28],target_met:sorted[28] <= (values===cold?1000:200)};};
  const result={status:'PASS',scope:'PERF-005 standard synthetic dataset: 1000 sources, 10000 claims, 300 drafts, 3000 media metadata; actual load mode and overlap require companion API report',startedAt,endedAt:Date.now(),windows,memory,cold:stats(cold),warm:stats(warm),errors};
  if(errors.length||!result.cold.target_met||!result.warm.target_met)result.status='FAIL';
  return result;
}
