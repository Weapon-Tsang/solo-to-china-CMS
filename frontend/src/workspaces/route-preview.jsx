import { Card } from '@/components/ui/card';
import { useState } from 'react';
import { RouteDecisions } from './route-decisions';

const reasons={ROUTE_EVIDENCE_PENDING:'路线证据待补充',ROUTE_CONFLICT:'路线证据存在冲突',
  REQUIRED_ROUTE_MEDIA_MISSING:'必需实拍素材缺失',ROUTE_MEDIA_MISMATCH:'图片与批准路线不符',FROZEN:'路线已冻结'};
export function RoutePreview({bundle:initialBundle,render,ownerId,visuals=[]}) {
  const [liveBundle,setLiveBundle]=useState(null);
  const bundle=liveBundle || initialBundle;
  if(!bundle) return ownerId?<Card className="mb-3 p-4"><RouteDecisions ownerId={ownerId} onCurrent={setLiveBundle}/></Card>:null;
  return <Card className="mb-3 p-4" aria-label="批准路线">
    <h3 className="text-sm font-semibold text-slate-900">批准路线 · 版本 {bundle.revision}</h3>
    <p className="mt-1 text-xs text-slate-700">{reasons[bundle.status] || bundle.status}</p>
    <p className="mt-1 text-xs text-slate-500">依据来源整理；尚未核实当前交通、开放时间及现实可行性。缺少普通站点照片不等于缺少路线证据。</p>
    {visuals.some(v=>v.status==='skipped' && v.media_metadata?.route_omission) && <div role="status" className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs">
      <p>已省略未完成或冲突的可选路线图，正文与批准路线保持不变。必需实拍仍单独检查。</p>
      <ul>{visuals.filter(v=>v.status==='skipped' && v.media_metadata?.route_omission).map(v=><li key={v.id} className="mt-1 break-words">
        {v.image_subject || '路线示意图'}：{v.media_metadata.route_omission.code==='ROUTE_MEDIA_MISMATCH'?'图片与批准路线不符，原件仍保留。':'本地示意图未完成，已保留错误和累计尝试记录。'}
        <details><summary>查看省略原因</summary><p>{v.media_metadata.route_omission.code}</p>
          <p>可补充相符图片或在修复渲染条件后处理该图片；不会自动重写正文。</p></details>
      </li>)}</ul>
    </div>}
    <ol className="mt-3 space-y-3 text-xs">{bundle.days.map(day=><li key={day.day_id}>
      <strong>{day.label}</strong>
      <ol className="mt-1 list-decimal space-y-1 pl-5">{bundle.stops.filter(s=>s.day_id===day.day_id).map(stop=>{
        const legs=bundle.legs.filter(l=>l.from_stop_id===stop.stop_id);
        return <li key={stop.stop_id} className="break-words"><span>{stop.name_en || stop.name_zh || '地点身份待确认'}</span>
          {legs.map(leg=><p key={leg.leg_id} className="text-slate-500">前往 {bundle.stops.find(s=>s.stop_id===leg.to_stop_id)?.name_en || '下一站'}：{leg.mode || '交通方式未注明'}
            {leg.duration && ` · ${leg.duration.approximate?'约 ':''}${leg.duration.value} ${leg.duration.unit}`}
            {leg.conditions.length>0 && ` · ${leg.conditions.join('；')}`}</p>)}</li>;
      })}</ol></li>)}</ol>
    {bundle.diagnostics.length>0 && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs" role="status">
      <p>{bundle.diagnostics.every(issue=>issue.severity==='warning')?'非关键说明待核实，已省略不确定数值；路线仍可继续，原始来源证据保留。':'请补充对应证据或提出明确的路线修订；不会自动删天数或重写正文。'}</p>
      <ul className="mt-2 space-y-1">{bundle.diagnostics.map((issue,index)=><li key={index} className="break-all">{issue.severity==='warning'?'非关键说明已省略':reasons[issue.code] || issue.code} · {issue.field}</li>)}</ul>
    </div>}
    <details className="mt-3 text-xs"><summary className="cursor-pointer text-slate-600">查看路线版本与来源证据</summary>
      <p className="mt-2 break-all text-slate-500">路线指纹：{bundle.approved_route_hash}</p>
      <ul className="mt-2 space-y-2">{bundle.source_snapshot.map(source=><li key={source.fragment_id} className="break-words">
        <p>来源 {source.source_id} · 采集版本 {source.capture_version}</p>
        {[...new Map(source.days.flatMap(day=>day.evidence).map(e=>[e.span_id,e])).values()].map(e=><blockquote key={e.span_id} className="mt-1 border-l-2 border-slate-200 pl-2 text-slate-600">{e.quote}</blockquote>)}
      </li>)}</ul>
    </details>
    {render && render.manifest?.approved_route_hash===bundle.approved_route_hash && <details className="mt-3 text-xs"><summary className="cursor-pointer text-slate-600">查看本地路线示意图</summary>
      <figure className="mt-2"><img src={render.url} alt="批准路线的顺序示意图，文字路线见上方列表" className="h-auto w-full rounded-lg" />
        <figcaption className="mt-1 text-slate-500">非地理比例，不提供实时导航。示意图来自当前冻结路线。</figcaption></figure>
    </details>}
    {ownerId && <RouteDecisions ownerId={ownerId} onCurrent={setLiveBundle}/>}
  </Card>;
}
