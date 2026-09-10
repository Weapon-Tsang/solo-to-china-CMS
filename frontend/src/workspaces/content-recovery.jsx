import { useState } from 'react';
import { api } from '@/lib/api';
import { label } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function ContentRecovery({candidateId,onAction,actionBusy=false}) {
  const [report,setReport]=useState(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [destination,setDestination]=useState('');
  const [assets,setAssets]=useState({});
  if(!candidateId) return null;
  const endpoint=`/api/topics/${encodeURIComponent(candidateId)}/recovery`;
  const refresh=async()=>{ setBusy(true);setError('');try{const r=await api(endpoint);setReport(r);setDestination(r.destination);}catch(e){setError(e.message);}finally{setBusy(false);} };
  const execute=async(action,extra={})=>{
    const instructions={compose_frontend_page:'只重新编排当前正文，不改写文章。可能调用编排模型及上传媒体；不会自动启动质检。',review_draft:'只审核当前版本，可能产生模型费用；不会自动重写、投递或发布。',revise_draft:'只修订失败部分，可能产生模型费用；不会自动编排、质检或发布。',plan_content:'将启动规划及后续已确认的内容生产，可能产生模型和媒体费用。',correct_destination:'只更正目的地并重新核算证据，不立即启动生产。',bind_asset:'请确认这张图片真实对应当前描述且你有发布权限。会保存新修订并使旧质检失效，不自动生产。'};
    if(!window.confirm(instructions[action] || '保存人工修订？旧版保留，当前质检失效；不会自动启动模型任务。')) return;
    if(await onAction(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,revision:report.revision,...extra})},'恢复操作已保存，请查看实际任务状态。')) await refresh();
  };
  const disabled=actionBusy||busy||Boolean(report?.activeJobs?.length);
  return <div className="mt-2 text-xs font-normal" onClick={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>{report?'刷新恢复状态':'查看原因 / 处理入口'}</Button>
    {report&&<section className="mt-2 max-w-3xl space-y-3 rounded-lg border border-blue-200 bg-white p-3 text-slate-700">
      <div className="flex justify-between"><strong>内容恢复工作台</strong><button onClick={()=>setReport(null)}>收起</button></div>
      <p>素材准备度 {report.coverage.score}%：{report.coverage.explanation}</p>
      <p>当前版本：{report.revision??'尚无草稿'}；{report.activeJobs.length?report.activeJobs.map(j=>`${label(j.type)}：${label(j.status)}`).join('；'):'没有排队或运行中的生产任务。'}</p>
      {report.canCorrectDestination&&<div><p>当前目的地：{report.destination}；{report.destinationCheck.valid?'标题归属检查无冲突':'标题与目的地不一致，必须先修正'}</p><select className="my-1 rounded border p-1" value={destination} onChange={e=>setDestination(e.target.value)}>{report.destinations.map(d=><option key={d.slug} value={d.slug}>{d.name} ({d.slug})</option>)}</select><Button size="sm" disabled={disabled||destination===report.destination} onClick={()=>execute('correct_destination',{destination})}>保存归属并核对证据</Button></div>}
      <div className="flex flex-wrap gap-2">{report.draftId?<><Button size="sm" disabled={disabled} onClick={()=>execute('compose_frontend_page')}>仅重新编排页面</Button><Button size="sm" disabled={disabled} onClick={()=>execute('review_draft')}>仅重新质检</Button><Button size="sm" variant="outline" disabled={disabled} onClick={()=>execute('revise_draft')}>仅修订失败内容</Button></>:<Button size="sm" disabled={disabled||!report.destinationCheck.valid} onClick={()=>execute('plan_content')}>从规划继续生产</Button>}</div>
      <p className="text-amber-800">按钮不会代替授权或降低质量门槛。失败阶段修好后请刷新；重新编排 → 重新质检分开执行。</p>
      {report.editorial&&<EditorialCorrection key={report.revision} value={report.editorial} disabled={disabled} onSave={extra=>execute('save_editorial_correction',extra)}/>}
      <details><summary>本机规则复核（不收费，不替代正式质检）</summary><p>以下是当前代码重新检查的结果，原审核历史仍保留。</p><ul>{report.localCheck?.issues?.map((i,n)=><li key={n} className="mt-2 break-words">{label(i.severity)} · {i.code}：{i.message}</li>)}</ul></details>
      <details><summary>原文与图片恢复（{report.visuals.length} 个槽位）</summary><p className="my-2">{report.recaptureMessage}</p>
        {report.visuals.map(v=><div key={v.id} className="my-2 rounded border p-2"><strong>图片 {v.slot+1}：{v.alt}</strong><p>{v.delivered?'已交付图片':label(v.status)} · {v.acquisition}</p>
          {v.source&&report.sources.filter(s=>s.id===v.source).map(s=><SourceLink key={s.id} source={s}/>)}
          <select aria-label={`为图片 ${v.slot+1} 选择授权原图`} className="my-2 w-full rounded border p-1" value={assets[v.id]||''} onChange={e=>setAssets({...assets,[v.id]:e.target.value})}><option value="">请选择对应的已采集原图（不得凭标题猜图）</option>{report.assets.filter(a=>a.authorized&&a.has_bytes).map(a=><option key={a.id} value={a.id}>{a.source_title} · 原图 {a.position+1} · {a.alt_text||a.id}</option>)}</select>
          {assets[v.id]&&<img className="my-2 max-h-64 max-w-full rounded" src={`/api/source-assets/${encodeURIComponent(assets[v.id])}/preview`} alt="所选授权素材预览；请核对是否对应上方描述"/>}
          <Button size="sm" disabled={disabled||!assets[v.id]} onClick={()=>execute('bind_asset',{visualId:v.id,assetId:assets[v.id]})}>确认对应并绑定原图</Button></div>)}
        <p>以下为本篇关联原文；只有绑定槽位显示的原文才是该图片的确定来源。</p>{report.sources.map(s=><SourceLink key={s.id} source={s}/>)}
      </details>
      <p className="text-slate-500">Not Tested＝尚未完成验证；注意＝提醒，不等于失败；阻塞＝当前不能进入交付。素材准备度不代表质检一定通过。</p>
    </section>}{error&&<p className="text-red-700">{error}</p>}
  </div>;
}
function SourceLink({source}) { return /^https?:\/\//i.test(source.url||'')?<a className="my-1 block break-all text-blue-700 underline" href={source.url} target="_blank" rel="noreferrer">打开原文：{source.title} — {source.url}</a>:<p>{source.title}：未保存可打开的原文链接，请在来源工作区按 ID {source.id} 查找。</p>; }

function EditorialCorrection({value,disabled,onSave}) {
  const [body,setBody]=useState(value.body);
  const [ledger,setLedger]=useState(JSON.stringify(value.evidenceLedger,null,2));
  const [notes,setNotes]=useState(JSON.stringify(value.verificationNotes,null,2));
  const [error,setError]=useState('');
  const save=()=>{try{setError('');onSave({body,evidenceLedger:JSON.parse(ledger),verificationNotes:JSON.parse(notes)});}catch(e){setError(`JSON 格式错误：${e.message}`);}};
  return <details><summary>人工修正正文 / 台账 / 核验备注（不调用模型）</summary>
    <p className="my-2">用于删除无证据细节、补齐已确认的大纲、纠正错配台账或填写真实时效说明。不要虚构事实或核验日期。保存后先编排，再质检。</p>
    <label className="block">英文正文<textarea className="mt-1 h-64 w-full rounded border p-2" value={body} onChange={e=>setBody(e.target.value)}/></label>
    <label className="block">证据台账（JSON）<textarea className="mt-1 h-32 w-full rounded border p-2 font-mono" value={ledger} onChange={e=>setLedger(e.target.value)}/></label>
    <label className="block">时效核验备注（JSON 字符串数组，可用“证据编号：说明”）<textarea className="mt-1 h-24 w-full rounded border p-2" value={notes} onChange={e=>setNotes(e.target.value)}/></label>
    <Button size="sm" disabled={disabled} onClick={save}>保存人工修订，保留旧版本</Button>{error&&<p className="text-red-700">{error}</p>}
  </details>;
}

const ISSUE_HELP={missing_temporal_disclosure:'动态或旧证据缺少核验说明。填写真实日期或“日期未知、出发前核对”，不要把采集日期冒充事实生效日期。',
 required_visual_missing:'要求实景图的槽位还没有可交付的已核验图片。请在图片恢复区补图；AI 示意图不能替代实景证据。',
 visual_renderer_incomplete:'地图或信息图只规划了，渲染器尚未产出有效图片；重写正文不能解决。',
 final_page_invalid:'最终页面尚未成功生成、版本已过期或不符合组件契约。先重新编排页面。',
 final_page_content_missing:'最终页面没有完整保留正文的关键章节。先核对编排结果，不要直接重写整篇。',
 final_page_evidence_invalid:'最终页面的事实内容与证据映射不一致。展开可看到具体组件位置、证据编号和缺失值；先排除映射/校验问题，再修正真正错误的正文。',
 protected_evidence_mismatch:'文章或对应章节没有保留证据中的金额、日期、出口编号或适用条件。核对原证据后定点修正。',
 invalid_evidence_key:'台账使用了本篇证据集里不存在的编号。请修正台账，不能新造编号。',
 confirmed_topic_coverage_missing:'已确认的大纲要点没有完整覆盖；用现有证据补齐，或回到人工命题重新确认范围。'};
export function QualityIssue({issue}) {
  const help=ISSUE_HELP[issue.code];
  return <div className="break-words"><strong>{label(issue.severity)}：</strong>{help||issue.message}
    {help&&<details className="mt-1 text-[11px]"><summary>查看具体证据与错误位置</summary><p>{issue.message}</p></details>}
  </div>;
}
