async (page) => {
  await page.goto('http://127.0.0.1:60362');
  await page.getByRole('textbox',{name:'用户名',exact:true}).fill('cover-test');
  await page.getByRole('textbox',{name:'密码',exact:true}).fill('cover-local-test-only');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('tab',{name:'内容',exact:true}).click();
  await page.getByRole('button',{name:'Cover selection fixture Draft'}).waitFor();
  const uploader=await page.context().newPage();
  try{
    await uploader.goto('http://127.0.0.1:60362');
    await uploader.getByRole('tab',{name:'内容',exact:true}).click();
    await uploader.getByRole('button',{name:'Cover selection fixture Draft'}).click();
    await uploader.getByText('上传图片补齐',{exact:true}).click();
    const before=await page.evaluate(async()=>await(await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'})).json());
    let chunks=0,finishes=0;uploader.on('request',request=>{if(request.url().includes('/article-media/uploads/')&&request.url().includes('/chunks/'))chunks++;});
    uploader.on('response',response=>{if(response.url().includes('/article-media/uploads/')&&response.url().endsWith('/complete')&&response.status()===200)finishes++;});
    const path='C:/Users/Mloong/AppData/Local/Temp/cms-c-cover-browser-tYSlha/benchmark-valid.png';
    const started=Date.now();await uploader.getByTestId('article-media').getByLabel('补图文件',{exact:true}).setInputFiles([path,path]);await page.bringToFront();
    const content=page.getByRole('tab',{name:'内容',exact:true}),sources=page.getByRole('tab',{name:'来源',exact:true});
    const draft=page.getByRole('button',{name:'Cover selection fixture Draft'}),warm=[];
    for(let i=0;i<30;i++){
      await sources.click();await page.getByRole('heading',{name:'研究来源'}).first().waitFor();
      const t=Date.now();await content.click();await draft.waitFor();warm.push(Date.now()-t);
    }
    const chunksDuringMenu=chunks,finishesDuringMenu=finishes,menuEnded=Date.now();
    const list=await page.evaluate(async()=>{const times=[];for(let i=0;i<30;i++){const t=performance.now();const r=await fetch('/api/drafts/cover-draft/article-media?offset=0',{cache:'no-store'});const data=await r.json();if(data.total<101)throw new Error('Original dataset lost');times.push(performance.now()-t);}return {times,heap:performance.memory?.usedJSHeapSize || null};});
    let status,created=[];for(let attempt=0;attempt<300;attempt++){
      status=await uploader.evaluate(async(offset)=>await(await fetch(`/api/drafts/cover-draft/article-media?offset=${offset}`,{cache:'no-store'})).json(),before.total);
      created=status.items.slice(0,2);if(created.length===2&&created.every(x=>x.asset_id))break;
      if(created.some(x=>x.state==='failed'||x.state==='paused'))throw new Error(JSON.stringify({message:'Upload did not complete',created}));
      await uploader.waitForTimeout(100);
    }
    if(created.length!==2||created.some(x=>!x.asset_id)||chunks<6||finishes!==2)throw new Error(JSON.stringify({message:'Missing verified upload receipts',created,chunks,finishes}));
    const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:30,p50_ms:sorted[14],p95_ms:sorted[28],max_ms:sorted[29]};};
    return {status:'PASS',dataset_before:before.total,dataset_after:status.total,valid_png_bytes_each:23079275,upload_chunks:chunks,upload_finishes:finishes,
      chunks_during_menu:chunksDuringMenu,finishes_during_menu:finishesDuringMenu,menu_window_ms:menuEnded-started,
      warm_menu:stats(warm),warm_samples_ms:warm,list_during_or_after_upload:stats(list.times),browser_heap_bytes:list.heap,
      targets:{warm_le_200_ms:stats(warm).p95_ms<=200,list_le_300_ms:stats(list.times).p95_ms<=300}};
  }finally{await uploader.close();}
}
