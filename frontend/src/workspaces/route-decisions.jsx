import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

const errors={ROUTE_VERSION_STALE:'批准路线已变化，请刷新后重新提出修订。',ROUTE_SOURCE_STALE:'来源证据已变化，请重新生成提案。',
  ROUTE_ALREADY_DECIDED:'此提案已有决策，请刷新查看。',ROUTE_PROPOSAL_STALE:'提案已变化，请刷新后再决定。',
  ROUTE_REVISION_PERMISSION_REQUIRED:'媒体修复许可不能批准路线变更。',ROUTE_EVIDENCE_PENDING:'所选路线证据不完整，请检查来源和连接。',
  ROUTE_CONFLICT:'所选路线存在冲突，不能批准。'};
const statuses={pending:'待决定',stale:'版本已过期',approve_route_revision:'已批准',reject_route_revision:'已拒绝'};
const display=value=>typeof value==='string'?value:JSON.stringify(value);

export function RouteDecisions({ownerId,onCurrent}) {
  const [state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [mode,setMode]=useState('source_route_adaptation'),[fragmentId,setFragmentId]=useState(''),[days,setDays]=useState([]),[reason,setReason]=useState('');
  const alive=useRef(false),key=useRef(null);
  const endpoint=`/api/content/${encodeURIComponent(ownerId)}/route-decisions`;
  const adopt=next=>{setState(next);onCurrent?.(next.current);};
  useEffect(()=>{
    alive.current=true;const controller=new AbortController();
    api(endpoint,{signal:controller.signal}).then(next=>{if(!controller.signal.aborted)adopt(next);})
      .catch(e=>{if(!controller.signal.aborted)setError(errors[e.code] || e.message);});
    return ()=>{alive.current=false;controller.abort();};
  },[endpoint]);
  const run=async(path,payload,message)=>{
    setBusy(true);setError('');setNotice('');
    try {
      if(payload)await api(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const next=await api(endpoint);
      if(alive.current){adopt(next);setNotice(message);key.current=null;}
    } catch(e){if(alive.current)setError(errors[e.code] || e.message);}
    finally{if(alive.current)setBusy(false);}
  };
  const available=(state?.fragments || []).flatMap(fragment=>fragment.days.map(day=>({fragment,day})));
  const propose=event=>{
    event.preventDefault();key.current ||= crypto.randomUUID();
    const route_scope=mode==='source_route_adaptation'?{mode,fragment_ids:[fragmentId]}:{mode,day_count:days.length,
      fragment_ids:[...new Set(days.map(selection=>selection.fragment.fragment_id))],
      days:days.map((selection,i)=>({source_day_id:selection.day.day_id,label:selection.label || `Day ${i+1}`,
        stop_ids:selection.fragment.stops.filter(s=>s.day_id===selection.day.day_id).sort((a,b)=>a.sequence-b.sequence).map(s=>s.stop_id),
        leg_ids:selection.fragment.legs.filter(l=>selection.fragment.stops.some(s=>s.stop_id===l.from_stop_id && s.day_id===selection.day.day_id)).map(l=>l.leg_id)}))};
    void run(endpoint,{expected_hash:state.current.content_hash,idempotency_key:key.current,reason,route_scope},'提案已保存，请核对差异后再决定。');
  };
  const decide=(proposal,decision)=>void run(`${endpoint}/${encodeURIComponent(proposal.id)}`,{decision,authority:'route_revision',
    expected_hash:state.current.content_hash,proposal_hash:proposal.proposal_hash},
    decision==='approve_route_revision'?'新版路线已批准。现有正文和发布内容保持原样；尚未启动重写或媒体任务。':'已拒绝提案，现有路线和正文保持原样。');
  const move=(index,step)=>{const next=[...days];[next[index],next[index+step]]=[next[index+step],next[index]];setDays(next);key.current=null;};
  return <section className="mt-4 border-t border-slate-200 pt-3 text-xs" aria-label="路线修订" aria-busy={busy}>
    <h4 className="font-semibold text-slate-900">路线修订</h4>
    <p className="mt-1 text-slate-600">先保存提案，再核对和批准。只修图片不会修改路线；批准路线也不会自动重写或发布正文。</p>
    {error && <p role="alert" className="mt-2 break-words text-rose-700">{error}</p>}
    {notice && <p role="status" className="mt-2 text-emerald-800">{notice}</p>}
    <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={()=>run(endpoint,null,'已刷新路线与提案。')}>刷新路线与提案</Button>
    {!state && !error && <p role="status" className="mt-2">正在读取路线提案…</p>}
    {state?.article_route && <details className="mt-3"><summary className="cursor-pointer">现有正文使用的路线 · 版本 {state.article_route.revision}</summary>
      <p className="mt-1">此快照只读；{state.article_route.approved_route_hash===state.current?.approved_route_hash?'与当前批准路线一致。':'与新批准路线不同，正文仍保留原版本。'}</p>
      <ol className="mt-1 space-y-1">{state.article_route.days.map(day=><li key={day.day_id}>{day.label}：{state.article_route.stops.filter(s=>s.day_id===day.day_id).map(s=>s.name_en || s.name_zh).join(' → ')}</li>)}</ol>
    </details>}
    {state && !state.current && <p className="mt-2">此历史记录没有可验证的路线快照。保留原正文；不能根据新图片自动建立或覆盖路线。</p>}
    {state?.can_propose && <details className="mt-3"><summary className="cursor-pointer font-medium">提出路线修订</summary>
      <form onSubmit={propose} className="mt-2 space-y-3" onChange={()=>{key.current=null;}}>
        <label className="block">路线方式<select className="mt-1 block w-full rounded border p-2" value={mode} disabled={busy} onChange={e=>setMode(e.target.value)}>
          <option value="source_route_adaptation">沿用一份来源路线</option><option value="evidence_composed_route">组合已有证据支持的行程</option></select></label>
        {mode==='source_route_adaptation'?<label className="block">来源路线<select className="mt-1 block w-full rounded border p-2" value={fragmentId} disabled={busy} onChange={e=>setFragmentId(e.target.value)}>
          <option value="">请选择来源路线</option>{state.fragments.map((fragment,i)=><option key={fragment.fragment_id} value={fragment.fragment_id}>
            来源路线 {i+1}：{fragment.days.map(d=>d.label).join('、')} · {fragment.stops.map(s=>s.name_en || s.name_zh).join(' → ')}</option>)}</select></label>:
          <div><p>依次加入有证据的行程日，再调整分天顺序。</p><div className="mt-1 flex flex-wrap gap-2">{available.map((selection,i)=><Button type="button" key={selection.day.day_id} size="sm" variant="outline"
            disabled={busy || days.some(d=>d.day.day_id===selection.day.day_id)} onClick={()=>{setDays([...days,{...selection,label:`Day ${days.length+1}`}]);key.current=null;}}>加入来源行程 {i+1} · {selection.day.label}</Button>)}</div>
            <ol className="mt-2 space-y-2">{days.map((selection,i)=><li key={selection.day.day_id} className="rounded border p-2">
              <label className="block">第 {i+1} 天标题<input className="mt-1 w-full rounded border p-2" maxLength={80} required disabled={busy} value={selection.label} onChange={e=>setDays(days.map((d,n)=>n===i?{...d,label:e.target.value}:d))}/></label>
              <div className="mt-2 flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={busy || i===0} onClick={()=>move(i,-1)}>上移第 {i+1} 天</Button>
                <Button type="button" size="sm" variant="outline" disabled={busy || i===days.length-1} onClick={()=>move(i,1)}>下移第 {i+1} 天</Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>{setDays(days.filter((_,n)=>n!==i));key.current=null;}}>移除第 {i+1} 天</Button></div></li>)}</ol></div>}
        <label className="block">修订原因<textarea className="mt-1 block w-full rounded border p-2" rows={2} maxLength={1000} required disabled={busy} value={reason} onChange={e=>setReason(e.target.value)}/></label>
        <Button type="submit" size="sm" disabled={busy || !reason.trim() || (mode==='source_route_adaptation'?!fragmentId:!days.length)}>保存路线提案</Button>
      </form></details>}
    {state && !state.proposals.length && <p className="mt-3 text-slate-500">暂无路线变更提案。</p>}
    <ul className="mt-3 space-y-3">{state?.proposals.map(proposal=><li key={proposal.id} className="rounded border border-slate-200 p-3">
      <p className="font-medium">{statuses[proposal.status]} · 基于版本 {proposal.base_revision}</p><p className="mt-1 break-words">{proposal.reason}</p>
      <p className="mt-1">提议行程：{proposal.target.days.map(d=>d.label).join('、')} · {proposal.target.stops.length} 个站次</p>
      {!!proposal.target.diagnostics.length && <p role="status" className="mt-1 text-amber-800">证据仍有缺口，不能批准：{proposal.target.diagnostics.map(d=>`${errors[d.code] || d.code} ${d.field}`).join('；')}</p>}
      <details className="mt-2"><summary className="cursor-pointer">查看 {proposal.differences.length} 项字段差异</summary>
        <ul className="mt-2 space-y-2">{proposal.differences.map((change,i)=><li key={i} className="break-all"><strong>{change.field}</strong><p>原值：{display(change.before)}</p><p>提案：{display(change.after)}</p></li>)}</ul>
      </details>
      {proposal.status==='pending' && <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={busy || proposal.target.status!=='FROZEN'} onClick={()=>decide(proposal,'approve_route_revision')}>批准路线变更</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={()=>decide(proposal,'reject_route_revision')}>拒绝提案</Button></div>}
    </li>)}</ul>
  </section>;
}
