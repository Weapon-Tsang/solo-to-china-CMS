async (page) => {
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  const started=Date.now();await page.setViewportSize({width:1440,height:900});await page.goto('http://127.0.0.1:59200');
  if(await page.getByRole('textbox',{name:'用户名',exact:true}).count()){await page.getByRole('textbox',{name:'用户名',exact:true}).fill('cover-test');
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('cover-local-test-only');
  await page.getByRole('button',{name:'登录',exact:true}).click();}
  const content=page.getByRole('tab',{name:'内容',exact:true}),sources=page.getByRole('tab',{name:'来源',exact:true});
  await sources.waitFor({timeout:10000});
  const draft=page.getByRole('button',{name:'Cover selection fixture Draft'}),cold=[],warm=[];
  for(let i=0;i<30;i++){
    await page.reload({waitUntil:'domcontentloaded'});await sources.waitFor();
    const start=Date.now();await content.click();await draft.waitFor({timeout:10000});cold.push(Date.now()-start);
    await sources.click();await page.getByRole('heading',{name:'研究来源'}).first().waitFor();
    const cached=Date.now();await content.click();await draft.waitFor({timeout:10000});warm.push(Date.now()-cached);
  }
  const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,p50_ms:sorted[14],p95_ms:sorted[28],max_ms:sorted[29]};};
  const api=await page.evaluate(async()=>{const times=[];for(let i=0;i<30;i++){const t=performance.now();const r=await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'});const data=await r.json();if(data.total<101||data.items.length!==25)throw new Error('Nonempty media page mismatch');times.push(performance.now()-t);}return {times,heap_bytes:performance.memory?.usedJSHeapSize || null};});
  const result={status:'PASS',started,ended:Date.now(),dataset:'existing isolated fixture, at least 101 real completed upload sessions',cold_menu:stats(cold),cached_menu:stats(warm),media_list:stats(api.times),browser_heap_bytes:api.heap_bytes,
    targets:{cold_le_1000_ms:stats(cold).p95_ms<=1000,cached_le_200_ms:stats(warm).p95_ms<=200,list_le_300_ms:stats(api.times).p95_ms<=300},page_errors:errors};
  if(errors.length)throw new Error(JSON.stringify(result));
  return result;
}
