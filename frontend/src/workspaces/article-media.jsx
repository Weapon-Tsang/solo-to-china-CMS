import {useEffect,useRef,useState} from 'react';
import {api} from '@/lib/api';
import {Button} from '@/components/ui/button';

const post=(url,data)=>api(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data || {})});
const words={LOCAL_ROUTE_RECOMPOSITION:'按批准骨架本地重编完整示意图',selected:'已选择',uploading:'上传中',paused:'已暂停',verifying:'校验中',pending_confirmation:'已保存，待确认采用',ready:'本地就绪，未交付',failed:'失败，可重试',cancelled:'已取消',
  local_ready:'本地处理完成',waiting_attention:'等待处理',WAITING_AUTH:'等待付费处理授权',COVER_GEOMETRY_REQUIRED:'等待封面裁剪确认',ROUTE_EVIDENCE_PENDING:'等待路线证据核对',ROUTE_MEDIA_CONFLICT:'图片标注与批准路线冲突',ROUTE_PHOTO_BINDING_REQUIRED:'请核对照片对应站点和槽位用途',ROUTE_SNAPSHOT_REQUIRED:'缺少可验证的文章路线',LOCAL_VALIDATION_AND_WEB_DERIVATIVE:'本地质量校验与网页转码'};
function workerHash(file,workers,mode='file'){return new Promise((resolve,reject)=>{const worker=new Worker(new URL('../lib/file-hash-worker.js',import.meta.url),{type:'module'});workers.add(worker);
  const finish=()=>{worker.terminate();workers.delete(worker);};worker.onmessage=({data})=>{if(data.hash){finish();resolve(data.hash);}if(data.error){finish();reject(new Error(data.error));}};worker.onerror=event=>{finish();reject(new Error(event.message));};worker.postMessage({file,mode});});}

export function ArticleMedia({draftId,initialSlot=null}) {
  const [data,setData]=useState(null),[offset,setOffset]=useState(0),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [busy,setBusy]=useState(false),[choices,setChoices]=useState({}),[plan,setPlan]=useState(null),[confirmed,setConfirmed]=useState(false);
  const [revokeReason,setRevokeReason]=useState(''),[revokeConfirmed,setRevokeConfirmed]=useState(false);
  const files=useRef(new Map()),paused=useRef(new Set()),workers=useRef(new Set()),alive=useRef(false),queue=useRef(Promise.resolve()),active=useRef(null);
  const base=`/api/drafts/${encodeURIComponent(draftId || '')}/article-media`;
  const load=async()=>{const next=await api(`${base}?offset=${offset}`);if(alive.current)setData(next);return next;};
  useEffect(()=>{alive.current=true;paused.current.delete('*');return()=>{
    alive.current=false;for(const worker of workers.current)worker.terminate();paused.current.add('*');
    if(active.current)void post(`${base}/uploads/${active.current}/pause`).catch(()=>{});
  };},[draftId]);
  useEffect(()=>{load().catch(e=>setError(e.message));},[draftId,offset]);
  const update=(id,values)=>{setChoices(previous=>({...previous,[id]:{...previous[id],...values}}));setPlan(null);setConfirmed(false);};
  const upload=async(file,resume=null)=>{
    if(!alive.current)return;setBusy(true);setError('');let id=resume?.id;
    try {
      setMessage(`${file.name}：正在校验文件身份`);
      const hash=await workerHash(file,workers.current);if(!alive.current)return;
      const state=await load();
      if(resume&&(resume.upload.sha256!==hash || resume.upload.size!==file.size))throw new Error('重新选择的文件与会话原件不一致。');
      const created=resume || await post(`${base}/uploads`,{name:file.name,size:file.size,sha256:hash,mimeType:file.type,expected_revision:state.draft_revision});
      id=created.id;active.current=id;files.current.set(id,file);paused.current.delete(id);
      if(resume)await post(`${base}/uploads/${id}/resume`);
      const status=await api(`${base}/uploads/${id}`),received=new Set(status.progress.receivedChunks || []),chunkBytes=created.upload.chunkBytes;
      if(!status.progress.receipt)for(let i=0;i<created.upload.chunkCount;i++){
        if(paused.current.has(id)||paused.current.has('*')||!alive.current){await post(`${base}/uploads/${id}/pause`);return;}
        if(received.has(i))continue;
        const blob=file.slice(i*chunkBytes,(i+1)*chunkBytes),chunkHash=await workerHash(blob,workers.current,'chunk');
        await api(`${base}/uploads/${id}/chunks/${i}`,{method:'PUT',headers:{'content-type':'application/octet-stream','x-chunk-sha256':chunkHash},body:blob});
        setMessage(`${file.name}：服务端已收到 ${Math.round(Math.min(file.size,(i+1)*chunkBytes)/file.size*100)}%，尚未完成保存`);
      }
      setMessage(`${file.name}：原件校验和落库中`);await post(`${base}/uploads/${id}/complete`);setMessage(`${file.name}：已保存，等待明确采用`);
      files.current.delete(id);await load();
    }catch(e){if(!alive.current){if(id)await post(`${base}/uploads/${id}/pause`).catch(()=>{});}
    else {
      const current=id?await api(`${base}/uploads/${id}`).catch(()=>null):null;
      if(current?.asset_id){files.current.delete(id);setError('');setMessage(`${file.name}：服务端已保存，等待明确采用`);}
      else {
        const paused=id?await post(`${base}/uploads/${id}/pause`).catch(()=>null):null;
        setError(`${e.message} ${paused?.state==='paused'?'此文件已暂停，可重新选择同一文件续传。':'上传结果未确认，请刷新状态后再续传。'}413 表示链路或应用单块限制。`);
      }
      await load().catch(()=>{});
    }}
    finally{active.current=null;if(alive.current)setBusy(false);}
  };
  const enqueue=(list,resume)=>{for(const file of Array.from(list || [])){queue.current=queue.current.then(()=>upload(file,resume));}};
  const selected=Object.entries(choices).filter(([,value])=>value.selected).map(([id,value])=>({upload_id:id,...value,quality_confirmed:true,approved_route_hash:data?.route?.approved_route_hash}));
  const prepare=async()=>{setBusy(true);setError('');try{const next=await load();const result=await post(`${base}/plan`,{expected_revision:next.draft_revision,expected_media_revision:next.media_revision,selections:selected});setPlan(result);setConfirmed(false);}catch(e){setError(e.message);}finally{setBusy(false);}};
  const adopt=async()=>{setBusy(true);setError('');try{const result=await post(`${base}/confirm`,{expected_revision:plan.draft_revision,expected_media_revision:plan.media_revision,selections:selected,plan_hash:plan.plan_hash,confirmed,idempotency_key:`manual_${plan.plan_hash}`});setMessage(`已确认：${result.items.map(x=>words[x.state] || x.state).join('、')}。正文保持，WordPress 尚未交付。`);setPlan(null);setChoices({});await load();}catch(e){setError(e.message);}finally{setBusy(false);}};
  if(!draftId)return null;
  return <details className="min-w-0 rounded-lg border p-4" data-testid="article-media"><summary className="cursor-pointer font-semibold">{data?.approved_no_image&&!data?.slots.length?'添加配图（可选）':'上传图片补齐'}</summary>
    <div className="mt-4 space-y-4 min-w-0"><p className="text-sm text-slate-600">上传后选择正文或封面，再确认采用即可。英文说明由系统提供，无需填写；普通照片在本地处理，文字图和路线图按所选类型处理。</p>
      {(data?.slots || []).filter(slot=>slot.error).map(slot=><details key={slot.id} className="rounded border p-2 text-sm"><summary>槽位 {slot.slot}：{slot.caption || '需要处理的图片'}</summary><p className="break-words">{slot.error}</p>{slot.route&&<p>此图绑定已批准路线；补充图片不能替代交通事实或路线差异核对。</p>}</details>)}
      <div className="rounded border border-dashed p-4" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();enqueue(e.dataTransfer.files);}}>
        <label className="block text-sm">选择或拖入 JPG / PNG / WebP（支持多张）<input aria-label="补图文件" className="mt-2 block w-full text-sm" type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={e=>{enqueue(e.target.files);e.target.value='';}} /></label>
        <p className="mt-2 text-xs">未完成分块保留30天；刷新后重新选择同一文件即可核对续传。单次仅上传一个分块。</p>
      </div>
      <div role="status" aria-live="polite" className="break-words text-sm">{message}</div>{error&&<p role="alert" className="break-words text-sm text-red-700">{error}</p>}
      {busy&&<Button variant="outline" onClick={()=>{if(active.current)paused.current.add(active.current);}}>暂停当前上传</Button>}
      <Button variant="outline" onClick={()=>load().catch(e=>setError(e.message))}>刷新上传状态</Button>
      <p className="text-xs">已存会话 {data?.total || 0} · 媒体版本 {data?.media_revision || 0}</p>
      {(data?.items || []).map(item=>{const choice=choices[item.id] || {};return <article key={item.id} className="min-w-0 space-y-3 rounded border p-3">
        <p className="break-all text-sm font-medium">{item.filename} · {(item.upload.size/1024/1024).toFixed(2)} MB</p><p className="text-xs">{item.delivery_confirmed?'接收端已确认此图片':words[item.state] || item.state}</p><p className="text-xs">{item.replacement?'原件保留；本槽位改用批准路线示意图':item.adoption_status==='selected'?'当前已采用并锁定':'候选原件，未在当前文章采用'}</p>
        {item.preview_url&&<img src={item.preview_url} alt={choice.caption || '待人工核对的上传图片'} loading="lazy" className="max-h-36 max-w-full object-contain"/>}
        {item.replacement?.preview_url&&<figure className="rounded border p-2"><img src={item.replacement.preview_url} alt="按批准骨架生成的路线顺序示意图" className="max-h-96 max-w-full object-contain"/><figcaption className="mt-2 text-xs">{item.replacement.caption} <a className="underline" href={item.replacement.preview_url} target="_blank" rel="noreferrer">打开完整示意图</a></figcaption></figure>}
        {item.error&&<p className="break-words text-xs text-red-700">{item.error}</p>}
        {!item.asset_id&&item.state!=='cancelled'&&<><label className="block text-sm">重新选择此原件以续传<input type="file" className="block w-full" onChange={e=>enqueue(e.target.files,item)}/></label><Button variant="outline" onClick={()=>post(`${base}/uploads/${item.id}/cancel`).then(load).catch(e=>setError(e.message))}>取消此会话</Button></>}
        {item.asset_id&&<><label className="flex gap-2 text-sm"><input type="checkbox" checked={Boolean(choice.selected)} onChange={e=>{const target=data?.slots.find(s=>s.id===initialSlot) || data?.slots.find(s=>s.purpose==='body'&&s.status!=='generated'&&!s.locked&&!Object.values(choices).some(c=>c.selected&&c.slot_id===s.id));update(item.id,{selected:e.target.checked,slot_id:choice.slot_id ?? target?.id ?? '',purpose:choice.purpose || target?.purpose || 'body',kind:choice.kind || 'photo',relationship:choice.relationship || 'article_subject'});}}/>选择采用</label>
          {choice.selected&&<div className="grid min-w-0 gap-3 md:grid-cols-2">
            {data?.slots?.find(s=>s.id===choice.slot_id)?.locked&&<label className="flex gap-2 text-sm"><input type="checkbox" checked={Boolean(choice.replace_selection_id)} onChange={e=>update(item.id,{replace_selection_id:e.target.checked?data.slots.find(s=>s.id===choice.slot_id).selection_id:null})}/>明确替换该槽位已锁定的图片</label>}
            <label className="text-sm">用途<select aria-label="图片用途" className="block w-full border p-2" value={choice.purpose || 'body'} onChange={e=>update(item.id,{purpose:e.target.value,slot_id:'',replace_selection_id:null})}><option value="body">正文</option><option value="cover">独立封面</option></select></label>
            <label className="text-sm">放在哪里<select aria-label="目标槽位" className="block w-full border p-2" value={choice.slot_id || ''} onChange={e=>update(item.id,{slot_id:e.target.value,replace_selection_id:null})}><option value="">{choice.purpose==='cover'?'新增独立封面':'新增正文配图'}</option>{(data?.slots || []).filter(s=>s.purpose===(choice.purpose || 'body')).map(s=><option key={s.id} value={s.id}>{s.status==='generated'?'替换':'补齐'}第 {s.slot} 张 · {s.caption || '待补图片'}</option>)}</select></label>
            <label className="text-sm">图片类型<select aria-label="图片类型" className="block w-full border p-2" value={choice.kind || 'photo'} onChange={e=>update(item.id,{kind:e.target.value})}><option value="photo">实拍</option><option value="text">文字信息图</option><option value="route">路线图</option><option value="illustration">编辑插画</option></select></label>
            {data?.route&&choice.kind==='photo'&&<label className="text-sm">照片对应路线站点<select aria-label="照片对应路线站点" className="block w-full border p-2" value={choice.route_entity_id || ''} onChange={e=>update(item.id,{route_entity_id:e.target.value})}><option value="">请选择实际拍摄对象</option>{Array.from(new Map(data.route.stops.map(s=>[s.entity_id,s])).values()).map(s=><option key={s.entity_id} value={s.entity_id}>{s.name_zh || s.name_en} · {s.name_en}</option>)}</select></label>}
            {data?.route&&choice.kind==='route'&&<><label className="text-sm">要配图的路线日<select aria-label="要配图的路线日" className="block w-full border p-2" value={choice.route_day_id || ''} onChange={e=>update(item.id,{route_day_id:e.target.value})}><option value="">请选择批准的路线日</option>{data.route.days.map(d=><option key={d.day_id} value={d.day_id}>{d.label}</option>)}</select></label><label className="text-sm">图片实际标注的 Day<input aria-label="图片实际标注的 Day" className="block w-full border p-2" value={choice.embedded_day_label || ''} onChange={e=>update(item.id,{embedded_day_label:e.target.value})}/></label></>}
            <label className="text-sm">图片与文章的关系<select aria-label="图片与文章的关系" className="block w-full border p-2" value={choice.relationship || 'article_subject'} onChange={e=>update(item.id,{relationship:e.target.value})}><option value="article_subject">文章对象的图片</option><option value="context">相关环境或背景</option><option value="illustration">示意或装饰</option></select></label>
            {choice.purpose!=='cover'&&!choice.slot_id&&<label className="text-sm">新增位置<select aria-label="新增位置" className="block w-full border p-2" value={choice.anchor || 'after_intro'} onChange={e=>update(item.id,{anchor:e.target.value})}><option value="after_intro">引言后</option><option value="mid_article">正文中</option><option value="before_faq">问答前</option><option value="closing">结尾</option></select></label>}
          </div>}</>}
      </article>;})}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={offset===0||busy} onClick={()=>setOffset(Math.max(0,offset-25))}>上一页</Button><Button variant="outline" disabled={offset+25>=(data?.total || 0)||busy} onClick={()=>setOffset(offset+25)}>下一页</Button></div>
      <Button disabled={busy||!selected.length} onClick={prepare}>预览采用差异</Button>
      {(plan?.selections || data?.recovery?.receipt?.plan?.selections || []).filter(s=>s.route_decision?.blocked&&s.kind==='route'&&s.purpose==='body').map(s=><Button key={`recompose-${s.slot_id}`} variant="outline" disabled={busy} onClick={()=>update(s.upload_id,{selected:true,kind:'route',purpose:'body',slot_id:data?.slots.some(slot=>slot.id===s.slot_id)?s.slot_id:'',route_day_id:s.route_day_id,embedded_day_label:s.embedded_day_label,replace_selection_id:data?.slots.find(slot=>slot.id===s.slot_id)?.selection_id,route_action:'recompose_approved',caption:s.caption,description:s.description})}>按批准骨架重编示意图（保留原图）</Button>)}
      {(plan?.selections || []).filter(s=>s.render_preview).map(s=><div key={`preview-${s.slot_id}`} className="rounded border p-3 text-sm"><p>将采用完整批准路线示意图；上传原图仅保留，不作为相符路线图交付。</p><ol className="list-decimal pl-5">{s.render_preview.days.map(day=><li key={day.day_id}>{day.label}：{day.stops.map(stop=>stop.label).join(' → ')}<ul>{day.legs.map(leg=><li key={leg.leg_id}>{leg.mode || '交通未说明'} · {leg.duration?`${leg.duration.approximate?'约 ':''}${leg.duration.value} ${leg.duration.unit}`:'时长未知'}{leg.conditions.length?` · ${leg.conditions.join('；')}`:''}</li>)}</ul></li>)}</ol><p>{s.render_preview.disclaimer}</p></div>)}
      {(plan?.selections || data?.recovery?.receipt?.plan?.selections || []).filter(s=>s.route_decision?.blocked).map(s=><div key={s.slot_id} role="alert" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm"><p>{words[s.route_decision.code] || s.route_decision.code}。原件已保存，正文与批准路线保持。</p><ul className="mt-2 space-y-1">{s.route_decision.differences.map((d,i)=><li key={i}>{d.field==='embedded_day_label'?`正文需要 ${d.expected}，图片标注 ${d.actual}`:d.field==='pixel_route_evidence'?'站点、箭头方向与交通仍需图像证据核对。':d.field==='media_use'?'此槽位要求路线图，普通实拍请新增照片槽位。':'路线关联尚未匹配当前批准版本。'}</li>)}</ul><ul className="mt-2 space-y-1">{s.route_decision.actions.map(action=><li key={action}>{action}</li>)}</ul></div>)}
      {plan&&<div className="space-y-3 rounded border p-3"><p className="text-sm">将采用 {plan.selections.length} 张；未补齐槽位 {plan.remaining_slots.length} 个。正文不变。</p>{Boolean(plan.capacity?.excess)&&<p role="alert" className="text-sm text-red-700">本篇展示合同最多 {plan.capacity.maximum} 张，目前 {plan.capacity.displayed} 张。请减少 {plan.capacity.excess} 张采用项；已上传原件全部保留。</p>}<ul className="break-words text-xs">{plan.steps.map(s=><li key={s.slot_id}>{words[s.status] || s.status} · {s.paid_steps.length?'需要授权的付费处理，当前不执行':'本地处理'}</li>)}</ul><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>确认图片与所选对象相关、清晰度可用，并按所选用途采用</label><Button disabled={!confirmed||busy||Boolean(plan.capacity?.excess)} onClick={adopt}>确认采用并继续</Button></div>}
      {data?.recovery&&data.recovery.state!=='revoked'&&<div className="space-y-3 text-sm"><p>局部恢复：{words[data.recovery.state] || data.recovery.state} · {data.recovery.receipt?.delivery==='confirmed'?'接收端回执已确认':data.recovery.receipt?.delivery_attempt?'接收结果待核对':'外部交付待授权'}</p><Button variant="outline" disabled={busy} onClick={()=>post(`${base}/recoveries/${data.recovery.id}/resume`).then(load).catch(e=>setError(e.message))}>重试未完成的本地步骤</Button>
        <details className="rounded border p-3"><summary>撤销当前批次采用</summary><p className="my-2 text-xs">恢复该批次替换前的图片，保留原件和审计历史。不会修改线上文章。</p><label>撤销原因<input aria-label="撤销原因" className="block w-full border p-2" value={revokeReason} onChange={e=>setRevokeReason(e.target.value)}/></label><label className="my-2 flex gap-2"><input type="checkbox" checked={revokeConfirmed} onChange={e=>setRevokeConfirmed(e.target.checked)}/>确认撤销此批次的全部采用</label><Button variant="outline" disabled={busy||!revokeConfirmed||!revokeReason.trim()} onClick={async()=>{setBusy(true);try{await post(`${base}/revoke`,{expected_revision:data.draft_revision,expected_media_revision:data.media_revision,selection_id:data.recovery.id,fingerprint:data.fingerprint,confirmed:revokeConfirmed,reason:revokeReason});setRevokeConfirmed(false);await load();}catch(e){setError(e.message);}finally{setBusy(false);}}}>撤销采用</Button></details>
      </div>}
    </div></details>;
}
