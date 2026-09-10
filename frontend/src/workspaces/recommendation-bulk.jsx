import { useState } from 'react';
import { Button } from '@/components/ui/button';

const ACTIONS={approved_article:'批准所选创作路径',knowledge_only:'仅入知识库',cluster:'归入专题',research_first:'补充研究',ignored:'忽略'};
export function RecommendationBulk({items,selected,setSelected,onAction,actionBusy}) {
  const [decision,setDecision]=useState('knowledge_only');
  const [paths,setPaths]=useState({});
  const [result,setResult]=useState(null);
  const [confirmation,setConfirmation]=useState(null);
  const pending=items.filter(item=>item.decision==='pending');
  const chosen=items.filter(item=>selected.includes(item.id));
  const opportunityFor=item=>paths[item.id] || item.opportunity_id || '';
  const validPaths=chosen.every(item=>(item.opportunities||[]).some(p=>p.id===opportunityFor(item)));
  const preview=()=>{
    const approve=decision==='approved_article';
    setConfirmation({decision,titles:chosen.map(item=>approve?(item.opportunities||[]).find(p=>p.id===opportunityFor(item))?.title:item.source_title || item.primary_topic),
      items:chosen.map(item=>({recommendationId:item.id,updatedAt:item.updated_at,...(approve?{opportunityId:opportunityFor(item),proposalFingerprint:(item.opportunities||[]).find(p=>p.id===opportunityFor(item))?.proposalFingerprint}:{})}))});
  };
  const submit=async()=>{
    if(!confirmation)return;
    const response=await onAction('/api/recommendations/bulk-decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:confirmation.decision,items:confirmation.items})},r=>`批量完成：成功 ${r.processed}，跳过 ${r.skipped}，失败 ${r.failed}，已排队 ${r.queued}。`);
    if(response){setResult(response);setSelected(response.results.filter(r=>r.status==='failed').map(r=>r.recommendationId));}
    setConfirmation(null);
  };
  return <section className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs text-slate-700">
    <div className="flex flex-wrap items-center gap-2"><strong>批量处理 · 已选 {chosen.length} 条</strong><Button size="sm" variant="outline" disabled={actionBusy} onClick={()=>setSelected(pending.slice(0,100).map(i=>i.id))}>全选当前页待处理</Button><Button size="sm" variant="ghost" disabled={actionBusy} onClick={()=>setSelected([])}>清空选择</Button>
      <select aria-label="批量处理方式" className="rounded border bg-white p-2" value={decision} disabled={actionBusy} onChange={e=>setDecision(e.target.value)}>{Object.entries(ACTIONS).map(([key,title])=><option key={key} value={key}>{title}</option>)}</select>
      <Button size="sm" disabled={actionBusy||!chosen.length||chosen.length>100||(decision==='approved_article'&&!validPaths)} onClick={preview}>{actionBusy?'处理中…':'确认批量处理'}</Button></div>
    <p className="mt-2">只处理勾选的待处理建议，最多100条。一次提交、一次刷新；失败项会保留选择，可核对后重试，成功项不会再次执行。</p>
    {decision==='approved_article'&&chosen.length>0&&<div className="mt-3 max-h-72 space-y-2 overflow-auto">{chosen.map(item=><label key={item.id} className="block rounded border bg-white p-2">{item.source_title || item.primary_topic}<select aria-label={`创作路径：${item.source_title || item.primary_topic}`} className="mt-1 w-full rounded border p-1" disabled={actionBusy} value={opportunityFor(item)} onChange={e=>setPaths({...paths,[item.id]:e.target.value})}><option value="">请选择一条创作路径</option>{(item.opportunities||[]).map(p=><option key={p.id} value={p.id}>{p.id===item.opportunity_id?'默认：':''}{p.title}</option>)}</select></label>)}</div>}
    {confirmation&&<div role="dialog" aria-label="批量决定确认清单" className="mt-3 rounded-lg border border-amber-300 bg-white p-3">
      <strong>确认：{ACTIONS[confirmation.decision]} · {confirmation.items.length} 项</strong>
      <ul className="my-2 max-h-48 list-inside list-disc overflow-auto">{confirmation.titles.map((title,index)=><li key={index}>{title}</li>)}</ul>
      <p>{confirmation.decision==='approved_article'?'每条只批准清单中的一个创作方向。证据就绪后可能产生模型与媒体费用；不会公开发布。':'不会删除原始来源或现有文章。'}</p>
      <div className="mt-2 flex gap-2"><Button size="sm" disabled={actionBusy} onClick={submit}>执行清单中的决定</Button><Button size="sm" variant="outline" disabled={actionBusy} onClick={()=>setConfirmation(null)}>返回修改</Button></div>
    </div>}
    {result&&<div className="mt-2" role="status"><p>成功 {result.processed} · 跳过 {result.skipped} · 失败 {result.failed} · 新入队 {result.queued}</p>{result.results.filter(r=>r.status!=='processed').map((r,n)=><p key={`${r.recommendationId}-${n}`} className="mt-1 text-amber-800">{items.find(i=>i.id===r.recommendationId)?.source_title || r.recommendationId}：{r.reason}</p>)}</div>}
  </section>;
}
export function RecommendationSelect({item,selected,setSelected,disabled}) {
  return <label className="mb-2 inline-flex items-center gap-2 text-[11px] text-slate-500"><input type="checkbox" aria-label={`选择建议：${item.source_title || item.primary_topic}`} disabled={disabled||item.decision!=='pending'} checked={selected.includes(item.id)} onChange={e=>setSelected(e.target.checked?[...new Set([...selected,item.id])]:selected.filter(id=>id!==item.id))}/>选择此建议</label>;
}
