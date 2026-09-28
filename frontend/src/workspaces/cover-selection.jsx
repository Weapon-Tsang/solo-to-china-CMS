import {useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {api} from '@/lib/api';

const labels={x:'主体左边界 %',y:'主体上边界 %',width:'主体宽度 %',height:'主体高度 %',fx:'焦点横向 %',fy:'焦点纵向 %'};
const reasons={COVER_ANALYSIS_REQUIRED:'缺少有效图片分析',COVER_NON_PHOTO_REQUIRES_SEPARATE_REVIEW:'非实拍素材需单独审查',
  COVER_TEXT_OR_COLLAGE_DOMINANT:'密集文字或多宫格不能作为封面',COVER_INTERFACE_SCREENSHOT:'界面截图不能作为封面',
  COVER_OVERLAY_REVIEW_REQUIRED:'叠加文字需要审查',COVER_ENTITY_RELATION_UNCONFIRMED:'当前实体关系未确认',
  COVER_MASTER_QA_REQUIRED:'母图质量审核缺失或过期',COVER_SUBJECT_CONFIRMATION_REQUIRED:'请标定需要保留的主体和焦点',
  COVER_MASTER_UNAVAILABLE_OR_INVALID:'母图文件不可用',COVER_DIMENSIONS_INVALID:'图片尺寸不可用',
  COVER_SMALL_IMAGE_CONFIRMATION_REQUIRED:'小图需要确认清晰度',COVER_SUBJECT_WOULD_BE_CROPPED:'裁剪会切掉主体'};
const blank=()=>Object.fromEntries(Object.keys(labels).map(key=>[key,'']));

export function CoverSelection({draftId}) {
  const [audit,setAudit]=useState(null),[selection,setSelection]=useState(null),[chosen,setChosen]=useState('');
  const [values,setValues]=useState(blank),[preview,setPreview]=useState(null),[locked,setLocked]=useState(true);
  const [small,setSmall]=useState(false),[replaceLock,setReplaceLock]=useState(false),[confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [offset,setOffset]=useState(0);
  const [inventory,setInventory]=useState(null),[inventoryOffset,setInventoryOffset]=useState(0);
  const [abstractTopic,setAbstractTopic]=useState('packing');
  const alive=useRef(false),endpoint=`/api/drafts/${encodeURIComponent(draftId || '')}`;
  const load=async(signal)=>{
    const [next,current]=await Promise.all([api(`${endpoint}/cover-audit?offset=${offset}`,{signal}),api(`${endpoint}/cover`,{signal})]);
    if(alive.current && !signal?.aborted){setAudit(next);setSelection(current.selection);}
  };
  useEffect(()=>{
    if(!draftId)return;
    alive.current=true;const controller=new AbortController();setAudit(null);setPreview(null);setChosen('');
    load(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>{alive.current=false;controller.abort();};
  },[endpoint,draftId,offset]);
  if(!draftId)return null;
  const candidate=audit?.candidates.find(c=>c.id===chosen);
  const update=(key,value)=>{setValues(old=>({...old,[key]:value}));setPreview(null);setConfirmed(false);};
  const input=()=>({visual_id:chosen,expected_revision:audit.revision,expected_fingerprint:audit.input_fingerprint,
    master_hash:candidate.master_hash,safe_region:Object.fromEntries(['x','y','width','height'].map(key=>[key,Number(values[key])/100])),
    focal_point:{x:Number(values.fx)/100,y:Number(values.fy)/100},quality_confirmed:small,locked,
    expected_selection_id:selection?.id || null,replace_locked_id:replaceLock?selection?.id:null});
  const run=async(save)=>{
    setBusy(true);setError('');setNotice('');
    try {
      const result=await api(`${endpoint}/cover${save?'':'/preview'}`,{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...input(),...(save?{confirmed,preview_hash:preview.derivative.sha256}:{})})});
      if(!alive.current)return;
      if(save){await load();setPreview(null);setConfirmed(false);setNotice('封面已保存到本地。接收端能力待验证，新交付保持阻断。');}
      else setPreview(result);
    } catch(e){if(alive.current){setError((e.details || []).map?.(code=>reasons[code] || code).join('；') || e.message);setPreview(null);}}
    finally{if(alive.current)setBusy(false);}
  };
  return <details className="mb-4 rounded-lg border p-3">
    <summary className="cursor-pointer font-medium">独立封面 · 本地预览与选择</summary>
    <p className="mt-2 text-sm text-slate-600">选择适合横幅的图片。主体范围与焦点按归一方向的原图填写；先核对预览，再确认保存。当前接收端尚未验证，保存后会阻断新交付，线上文章不变。</p>
    {selection && <p className="mt-2 text-sm">当前封面：{selection.visual_id} · {selection.locked?'已锁定':'未锁定'} · {selection.delivery_state==='confirmed'?'接收端回执已确认':!selection.delivery_state||selection.delivery_state==='local_only'?'仅本地保存':'接收结果待核对'}</p>}
    {selection?.preview_url && <figure className="mt-2"><img src={selection.preview_url} alt="已保存的独立封面" className="max-h-64 w-full rounded object-contain" />
      <figcaption className="mt-1 text-xs text-slate-600">当前保存的 16:9 封面，正文图片不变。</figcaption></figure>}
    {error && <p role="alert" className="mt-2 text-sm text-rose-700">{error} <Button size="sm" variant="outline" disabled={busy} onClick={()=>{setError('');load().catch(e=>setError(e.message));}}>刷新状态</Button></p>}
    {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
    <details className="mt-3 rounded border p-2"><summary className="cursor-pointer text-sm">抽象主题插画方案</summary><p className="my-2 text-xs">仅适用于抽象准备主题，不生成假景点实拍。当前只保存方案，模型调用仍待授权；同一封面最多两个不同候选。</p><label className="text-sm">抽象主题<select className="mx-2 border p-1" value={abstractTopic} onChange={e=>setAbstractTopic(e.target.value)}><option value="packing">行李准备</option><option value="payments">支付准备</option><option value="travel_preparation">出行准备</option></select></label><Button size="sm" variant="outline" disabled={busy||!audit} onClick={async()=>{setBusy(true);try{await api(`${endpoint}/cover-illustration`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:audit.revision,abstract_topic:abstractTopic})});setNotice('插画方案已保存，待授权；未调用模型。');await load();}catch(e){setError(e.message);}finally{setBusy(false);}}}>保存插画方案</Button></details>
    <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-25))}>上一页候选</Button><Button size="sm" variant="outline" disabled={busy||audit?.pagination?.next_offset==null} onClick={()=>setOffset(audit.pagination.next_offset)}>下一页候选</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>api(`${endpoint}/cover-inventory?offset=${inventoryOffset}`).then(setInventory).catch(e=>setError(e.message))}>查看同对象已存素材</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>load().catch(e=>setError(e.message))}>重新检查候选</Button></div>
    {inventory&&<div className="mt-3 space-y-2">{inventory.items.map(item=><div key={item.source_asset_id} className="rounded border p-2 text-sm"><p>{item.alt || item.source_asset_id}</p><p>{item.reasons.map(r=>reasons[r] || r).join('；')}</p><Button size="sm" variant="outline" disabled={busy||!item.eligible} onClick={async()=>{setBusy(true);try{await api(`${endpoint}/cover-inventory`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...item,offset:inventoryOffset,expected_revision:inventory.draft_revision})});setInventory(null);await load();setNotice('已存素材加入独立封面候选，请预览裁剪。');}catch(e){setError(e.message);}finally{setBusy(false);}}}>加入封面候选</Button></div>)}{!inventory.items.length&&<p className="text-sm">当前页没有同对象素材。</p>}{inventory.next_offset!=null&&<Button variant="outline" onClick={()=>{setInventoryOffset(inventory.next_offset);api(`${endpoint}/cover-inventory?offset=${inventory.next_offset}`).then(setInventory).catch(e=>setError(e.message));}}>下一页已存素材</Button>}</div>}
    {!audit?<p role="status" className="mt-2 text-sm">正在检查候选图片…</p>:!audit.candidates.length?<p className="mt-2 text-sm">当前稿件没有可审查的图片。</p>:
      <ul className="mt-3 space-y-2">{audit.candidates.map(c=><li key={c.id} className="rounded border p-2 text-sm">
        <p>{c.alt || c.id}</p><p className="text-slate-600">{c.reasons.map(reason=>reasons[reason] || reason).join('；') || '可预览封面'}</p>
        <Button size="sm" variant="outline" className="mt-2" disabled={busy || !c.master_preview_url || c.reasons.some(r=>!['COVER_SUBJECT_CONFIRMATION_REQUIRED','COVER_SMALL_IMAGE_CONFIRMATION_REQUIRED'].includes(r))}
          onClick={()=>{setChosen(c.id);setValues(blank());setPreview(null);setConfirmed(false);setReplaceLock(false);setError('');}}>选择此图</Button>
      </li>)}</ul>}
    {candidate && <div className="mt-3 space-y-3" aria-busy={busy}>
      <figure><img src={candidate.master_preview_url} alt={`待裁剪母图：${candidate.alt}`} className="max-h-80 w-full object-contain" /><figcaption className="text-xs text-slate-600">母图保留，不覆盖正文图。百分比范围 0–100。</figcaption></figure>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{Object.entries(labels).map(([key,label])=><label key={key} className="text-sm">{label}<input type="number" min="0" max="100" step="0.1" required value={values[key]}
        disabled={busy} onChange={e=>update(key,e.target.value)} className="mt-1 w-full rounded border p-2" /></label>)}</div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={small} disabled={busy} onChange={e=>{setSmall(e.target.checked);setPreview(null);}}/>小图清晰度已确认（不放大）</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={locked} disabled={busy} onChange={e=>setLocked(e.target.checked)}/>锁定此封面选择</label>
      {selection?.locked && selection.visual_id!==chosen && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={replaceLock} disabled={busy} onChange={e=>setReplaceLock(e.target.checked)}/>明确替换当前锁定封面</label>}
      <Button size="sm" variant="outline" disabled={busy || Object.values(values).some(v=>v==='') || (selection?.locked && selection.visual_id!==chosen && !replaceLock)} onClick={()=>run(false)}>生成封面预览</Button>
      {preview && <figure><img src={preview.preview_url} alt={`16:9封面预览：${candidate.alt}`} className="w-full rounded" />
        <figcaption className="mt-1 text-sm">{preview.derivative.width} × {preview.derivative.height} · {Math.round(preview.derivative.bytes/1024)} KB</figcaption>
        <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>已检查预览，主体完整且清晰</label>
        <Button size="sm" className="mt-2" disabled={busy || !confirmed} onClick={()=>run(true)}>确认保存封面</Button></figure>}
    </div>}
  </details>;
}
