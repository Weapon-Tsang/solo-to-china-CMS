import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

const post=(url,body)=>api(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const roles={unknown:'尚未确认类型',documentary_photo:'独立实拍照片',editorial_infographic:'信息图',screenshot:'整页或界面截图',map_or_route:'地图或路线图'};
const relationshipStates={confirmed:'来源证据支持',candidate:'候选关系',ambiguous:'关系不明确',conflict:'存在冲突',revoked:'已撤销',stale:'已过期'};

export function PdfSourceSupplement({ assetId }) {
  const [context,setContext]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const [files,setFiles]=useState([]),[forms,setForms]=useState({});
  const active=useRef(false);
  const endpoint=`/api/source-assets/${encodeURIComponent(assetId)}/pdf-supplements`;
  const reload=async()=>{const next=await api(endpoint);setContext(next);return next;};
  useEffect(()=>{void reload().catch(e=>setError(e.message));},[assetId]);
  const run=async work=>{
    if(active.current)return;active.current=true;setBusy(true);setError('');
    try {await work();} catch(e){setError(e.message);} finally {active.current=false;setBusy(false);}
  };
  const upload=()=>run(async()=>{
    for(const entry of files) {
      if(entry.saved)continue;
      const file=entry.file;
      setMessage(`正在上传 ${file.name}`);
      if(!entry.session) {
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
        entry.session=await post('/api/source-supplement-uploads',{size:file.size,sha256:hash,mimeType:file.type,kind:'image',protocolVersion:2});
      }
      const session=entry.session,base=`/api/source-supplement-uploads/${session.uploadId}`;
      const headers={'x-upload-token':session.uploadToken};
      if(!entry.receipt) {
        const status=session.receipt ? session : await api(base,{headers});
        if(status.receipt) entry.receipt=status.receipt;
        else {
          for(let i=0;i<session.chunkCount;i++) if(!status.receivedChunks.includes(i)) {
            await api(`${base}/chunks/${i}`,{method:'PUT',headers:{...headers,'content-type':'application/octet-stream'},
              body:file.slice(i*session.chunkBytes,(i+1)*session.chunkBytes)});
            setMessage(`${file.name}：上传 ${Math.round(Math.min(file.size,(i+1)*session.chunkBytes)/file.size*100)}%，等待服务端确认`);
          }
          entry.receipt=await api(`${base}/complete`,{method:'POST',headers});
        }
      }
      await post(endpoint,{context_hash:entry.contextHash,idempotency_key:entry.key,receipt:entry.receipt,filename:file.name});
      entry.saved=true;await reload();
      setMessage('原件已保存，待确认来源对应关系。');
    }
    setFiles(current=>current.filter(item=>!item.saved));
  });
  const update=(id,key,value)=>setForms(previous=>({...previous,[id]:{...previous[id],[key]:value}}));
  const confirm=item=>run(async()=>{
    const form=forms[item.id] || {};
    await post(`${endpoint}/${encodeURIComponent(item.id)}/confirm`,{context_hash:context.context_hash,
      page:form.page || null,caption:form.caption || '',role:form.role || 'unknown'});
    await reload();setMessage('已加入来源素材，尚未替换文章配图。');
  });
  return <div className="my-3 min-w-0 space-y-3" aria-label="PDF 来源补图" aria-busy={busy}>
    <p>当前 PDF 不支持自动分离单图。独立补图保留人工来源，不改变原 PDF；文章采用仍需单独确认。</p>
    <p>未知页码可留空，仅作为来源话题补充。图注填写有依据的对应关系，不会根据 PDF 标题自动认定地点。</p>
    <label className="block">选择独立图片
      <input className="block max-w-full" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple disabled={busy || !context}
        onChange={event=>{const selected=Array.from(event.target.files || []).map(file=>({file,key:crypto.randomUUID(),contextHash:context.context_hash}));
          setFiles(current=>[...current,...selected]);event.target.value='';}} />
    </label>
    {files.length>0 && <><ul>{files.map(item=><li key={item.key}>{item.file.name}：{item.saved ? '已保存' : item.receipt ? '原件回执已收到，待入库' : '等待上传或重试'}</li>)}</ul>
      <Button type="button" disabled={busy} onClick={upload}>上传并保存原件 / 重试</Button></>}
    {error && <p role="alert" className="break-words text-rose-700">{error}</p>}
    <p role="status">{message}</p>
    {context?.supplements.map(item=><div key={item.id} className="space-y-2 border-t border-slate-200 pt-2">
      <a href={`/api/source-assets/${encodeURIComponent(item.id)}/preview`} target="_blank" rel="noreferrer">{item.original_filename} · {item.width} × {item.height} · 打开图片</a>
      {item.supplement.state==='confirmed' && <p>{item.relationships?.length ? item.relationships.map(row=>`${row.canonical_subject}：${relationshipStates[row.status] || row.status}`).join('；') : '仅来源候选，尚无明确实体关系'}</p>}
      {item.supplement.state==='confirmed' ? <p>已加入来源素材，尚未替换文章配图。{item.supplement.page ? `对应第 ${item.supplement.page} 页` : '对应页未确认'} · {roles[item.supplement.declared_role]} · {item.supplement.caption || '仅来源话题补充'}</p> : <>
        <p>原件已保存，待确认</p>
        <label className="block">对应页码（可留空）<input className="ml-2 w-20 border" type="number" min="1" max={context.page_count} disabled={busy} onChange={e=>update(item.id,'page',e.target.value)} /></label>
        <label className="block">有依据的图注 / 来源对应说明<textarea className="block w-full border" maxLength={12000} disabled={busy} onChange={e=>update(item.id,'caption',e.target.value)} /></label>
        <label className="block">图片实际类型<select className="ml-2 max-w-full border" disabled={busy} onChange={e=>update(item.id,'role',e.target.value)}>{Object.entries(roles).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <Button type="button" disabled={busy} onClick={()=>confirm(item)}>确认来源对应关系</Button>
      </>}
    </div>)}
  </div>;
}
