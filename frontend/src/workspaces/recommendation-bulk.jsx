import { useState } from 'react';
import { Button } from '@/components/ui/button';

const ACTIONS = {
  approved_article:'批准文章方案',
  knowledge_only:'仅入知识库',
  cluster:'归入专题',
  research_first:'补充研究',
  ignored:'忽略',
};

export function RecommendationBulk({items,selected,setSelected,onAction,actionBusy}) {
  const [decision,setDecision] = useState('knowledge_only');
  const [paths,setPaths] = useState({});
  const [result,setResult] = useState(null);
  const [confirmation,setConfirmation] = useState(null);
  const pending = items.filter((item) => item.decision === 'pending');
  const chosen = items.filter((item) => selected.includes(item.id));
  const opportunityFor = (item) => paths[item.id] || item.opportunity_id || '';
  const validPaths = chosen.every((item) => (item.opportunities || []).some((path) => path.id === opportunityFor(item)));
  const preview = () => {
    const approve = decision === 'approved_article';
    setConfirmation({
      decision,
      titles:chosen.map((item) => approve ? (item.opportunities || []).find((path) => path.id === opportunityFor(item))?.title : item.source_title || item.primary_topic),
      items:chosen.map((item) => ({ recommendationId:item.id,updatedAt:item.updated_at,...(approve ? {
        opportunityId:opportunityFor(item),
        proposalFingerprint:(item.opportunities || []).find((path) => path.id === opportunityFor(item))?.proposalFingerprint,
      } : {}) })),
    });
  };
  const submit = async () => {
    if (!confirmation) return;
    const response = await onAction('/api/recommendations/bulk-decision',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({decision:confirmation.decision,items:confirmation.items}),
    },(payload) => `批量完成：成功 ${payload.processed}，跳过 ${payload.skipped}，失败 ${payload.failed}，已排队 ${payload.queued}。`);
    if (response) {
      setResult(response);
      setSelected(response.results.filter((item) => item.status === 'failed').map((item) => item.recommendationId));
    }
    setConfirmation(null);
  };
  return <section className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs text-slate-700">
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
      <strong>批量处理 · 已选 {chosen.length} 条</strong>
      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button className="min-h-11" size="sm" variant="outline" disabled={actionBusy} onClick={() => setSelected(pending.slice(0,100).map((item) => item.id))}>全选当前页</Button>
        <Button className="min-h-11" size="sm" variant="ghost" disabled={actionBusy} onClick={() => setSelected([])}>清空选择</Button>
      </div>
      <select aria-label="批量处理方式" className="min-h-11 rounded border bg-white p-2" value={decision} disabled={actionBusy} onChange={(event) => setDecision(event.target.value)}>{Object.entries(ACTIONS).map(([key,title]) => <option key={key} value={key}>{title}</option>)}</select>
      <Button className="min-h-11" size="sm" disabled={actionBusy || !chosen.length || chosen.length > 100 || (decision === 'approved_article' && !validPaths)} onClick={preview}>{actionBusy ? '处理中…' : '确认批量处理'}</Button>
    </div>
    <p className="mt-2 leading-relaxed"><strong>“文章方案”就是原来卡片里的“创作方向”。</strong>批准文章方案＝从系统提出的方向中选定一篇进入生产，不是第二层审批。单条来源仍只提供 Claims 和知识；未批准方案不计入内容机会。</p>
    {decision === 'approved_article' && chosen.length > 0 && <div className="mt-3 max-h-72 space-y-2 overflow-auto">{chosen.map((item) => <label key={item.id} className="block rounded border bg-white p-2">{item.source_title || item.primary_topic}<select aria-label={`文章方案：${item.source_title || item.primary_topic}`} className="mt-1 min-h-11 w-full rounded border p-2" disabled={actionBusy} value={opportunityFor(item)} onChange={(event) => setPaths({...paths,[item.id]:event.target.value})}><option value="">请选择一篇文章方案</option>{(item.opportunities || []).map((path) => <option key={path.id} value={path.id}>{path.id === item.opportunity_id ? '默认：' : ''}{path.title}</option>)}</select></label>)}</div>}
    {confirmation && <div role="dialog" aria-label="批量决定确认清单" className="mt-3 rounded-lg border border-amber-300 bg-white p-3">
      <strong>确认：{ACTIONS[confirmation.decision]} · {confirmation.items.length} 项</strong>
      <ul className="my-2 max-h-48 list-inside list-disc overflow-auto">{confirmation.titles.map((title,index) => <li key={index}>{title}</li>)}</ul>
      <p>{confirmation.decision === 'approved_article' ? '每条只批准清单中的一篇文章方案。满足证据门槛后进入生产，仍须经过质量和发布保护。' : '不会删除原始来源或已有内容。'}</p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row"><Button className="min-h-11" size="sm" disabled={actionBusy} onClick={submit}>执行清单中的决定</Button><Button className="min-h-11" size="sm" variant="outline" disabled={actionBusy} onClick={() => setConfirmation(null)}>返回修改</Button></div>
    </div>}
    {result && <div className="mt-2" role="status"><p>成功 {result.processed} · 跳过 {result.skipped} · 失败 {result.failed} · 新入队 {result.queued}</p>{result.results.filter((item) => item.status !== 'processed').map((item,index) => <p key={`${item.recommendationId}-${index}`} className="mt-1 text-amber-800">{items.find((source) => source.id === item.recommendationId)?.source_title || item.recommendationId}：{item.reason}</p>)}</div>}
  </section>;
}

export function RecommendationSelect({item,selected,setSelected,disabled}) {
  const checked = selected.includes(item.id);
  return <label className={`mb-3 flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-xs sm:w-fit ${checked ? 'border-blue-400 bg-blue-50 text-blue-900' : 'border-slate-200 bg-white text-slate-600'}`}>
    <input className="h-5 w-5 shrink-0 accent-blue-600" type="checkbox" aria-label={`选择来源建议：${item.source_title || item.primary_topic}`} disabled={disabled || item.decision !== 'pending'} checked={checked} onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected,item.id])] : selected.filter((id) => id !== item.id))} />
    <span className="font-medium">{checked ? '已选择这条建议' : '选择这条建议'}</span>
  </label>;
}
