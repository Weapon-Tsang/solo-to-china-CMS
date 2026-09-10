import { useState } from 'react';
import { api } from '@/lib/api';
import { label } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const ACTION_LABELS = {
  compose_frontend_page: '仅重新编排页面',
  review_draft: '仅重新质检',
  revise_draft: '仅修订失败内容',
  plan_content: '从规划继续生产',
};

export function ContentRecovery({ candidateId,onAction,actionBusy=false }) {
  const [report,setReport] = useState(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [destination,setDestination] = useState('');
  const [assets,setAssets] = useState({});
  if (!candidateId) return null;
  const endpoint = `/api/topics/${encodeURIComponent(candidateId)}/recovery`;
  const refresh = async () => {
    setBusy(true); setError('');
    try { const next = await api(endpoint); setReport(next); setDestination(next.destination); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const execute = async (action,extra={}) => {
    const prompt = action === 'compose_frontend_page' ? '只重建页面，不重写正文；成功后会自动重新质检。'
      : action === 'revise_draft' ? '只修订质量失败涉及的内容；成功后会自动编排并质检。'
        : action === 'bind_asset' ? '请确认所选原图与图片说明相符，并且已有发布授权。绑定后会自动继续页面编排。'
          : '系统会从所选的最小阶段继续，并保留当前版本历史。';
    if (!window.confirm(prompt)) return;
    if (await onAction(endpoint,{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ action,revision:report.revision,...extra }) },'恢复动作已提交。')) await refresh();
  };
  const disabled = actionBusy || busy || Boolean(report?.activeJobs?.length);
  const diagnosis = report?.diagnosis;
  const recommended = diagnosis?.recommendedAction;
  const canExecuteRecommended = recommended?.id && ACTION_LABELS[recommended.id];
  return <div className="mt-2 text-xs font-normal" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>{report ? '刷新处理状态' : '查看原因 / 处理入口'}</Button>
    {report && <section className="mt-2 max-w-3xl space-y-3 rounded-xl border border-blue-200 bg-white p-3 text-slate-700 sm:p-4">
      <div className="flex items-center justify-between gap-3"><strong className="text-sm text-slate-950">系统判断与处理入口</strong><button className="min-h-10 px-2 text-slate-500" onClick={() => setReport(null)}>收起</button></div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700">异常原因</p>
        <h3 className="mt-1 text-sm font-semibold text-slate-950">{diagnosis?.headline}</h3>
        <p className="mt-1 leading-relaxed text-slate-700">{diagnosis?.reason}</p>
        {recommended && <p className="mt-2 leading-relaxed"><strong>建议怎么处理：</strong>{recommended.label}。{recommended.why}</p>}
        {canExecuteRecommended && <Button className="mt-3 min-h-11 w-full sm:w-auto" size="sm" disabled={disabled} onClick={() => execute(recommended.id)}>{recommended.label}</Button>}
        {recommended?.id === 'recapture_media' && <p className="mt-3 font-medium text-amber-900">请展开下方“原文与图片恢复”，系统已列出这篇草稿用到的具体原文链接。</p>}
        {diagnosis?.technicalDetail && <details className="mt-3 text-[11px] text-slate-500"><summary className="cursor-pointer">查看技术明细（排查人员使用）</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2">{diagnosis.technicalDetail}</pre></details>}
      </div>

      <div className="rounded-lg bg-blue-50 p-3 leading-relaxed">
        <strong>自动处理状态：</strong>{automaticText(diagnosis?.automatic,report.activeJobs)}
        <p className="mt-1 text-slate-600">最多自动修复 {diagnosis?.automatic?.maxAttempts ?? 2} 次；超过次数、缺原图或需要编辑判断时才转人工，避免无限重跑和重复费用。</p>
      </div>

      <p>素材准备度 {report.coverage.score}%：{report.coverage.explanation}</p>
      <p>当前版本：{report.revision ?? '尚无草稿'}；{report.activeJobs.length ? report.activeJobs.map((job) => `${label(job.type)}（${label(job.status)}）`).join('、') : '当前没有排队或运行中的生产任务。'}</p>

      {report.canCorrectDestination && <div className="rounded-lg border p-3">
        <p><strong>目的地归属：</strong>{report.destination}。{report.destinationCheck.valid ? '当前证据没有发现跨城市冲突。' : '检测到归属与证据不一致，请在这里改正。'}</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <select className="min-h-11 flex-1 rounded border bg-white p-2" value={destination} onChange={(event) => setDestination(event.target.value)}>{report.destinations.map((item) => <option key={item.slug} value={item.slug}>{item.name} ({item.slug})</option>)}</select>
          <Button size="sm" className="min-h-11" disabled={disabled || destination === report.destination} onClick={() => execute('correct_destination',{destination})}>更正归属并重算证据</Button>
        </div>
      </div>}

      <details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold text-slate-800">其他高级操作</summary>
        <p className="mt-2 text-slate-500">通常只需要使用上面的建议按钮。下面入口用于明确知道要重跑哪个阶段时手动处理。</p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {report.draftId ? <>
            <Button className="min-h-11" size="sm" variant="outline" disabled={disabled} onClick={() => execute('compose_frontend_page')}>仅重新编排页面</Button>
            <Button className="min-h-11" size="sm" variant="outline" disabled={disabled} onClick={() => execute('review_draft')}>仅重新质检</Button>
            <Button className="min-h-11" size="sm" variant="outline" disabled={disabled} onClick={() => execute('revise_draft')}>仅修订失败内容</Button>
          </> : <Button className="min-h-11" size="sm" disabled={disabled || !report.destinationCheck.valid} onClick={() => execute('plan_content')}>从规划继续生产</Button>}
        </div>
      </details>

      {report.editorial && <EditorialCorrection key={report.revision} value={report.editorial} disabled={disabled} onSave={(extra) => execute('save_editorial_correction',extra)} />}

      <details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold text-slate-800">本机规则复核：{diagnosis?.issues?.blockerCount || 0} 个阻塞，{diagnosis?.issues?.warningCount || 0} 个提醒</summary>
        <p className="mt-2 text-slate-500">这里先说人话；内部证据编号只放在每项的“技术明细”里，平时不需要看。</p>
        <div className="mt-3 space-y-2">{diagnosis?.issues?.blockers?.map((issue) => <QualityIssue key={issue.code} issue={issue} />)}{diagnosis?.issues?.warnings?.map((issue) => <QualityIssue key={issue.code} issue={issue} />)}</div>
      </details>

      <details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold text-slate-800">原文与图片恢复（{report.visuals.length} 个图片槽位）</summary>
        <p className="my-2 leading-relaxed">{report.recaptureMessage}</p>
        <div className="rounded-lg bg-slate-50 p-2"><strong>这篇草稿对应的原文：</strong>{report.sources.map((source) => <SourceLink key={source.id} source={source} />)}</div>
        {report.visuals.map((visual) => <div key={visual.id} className="my-3 rounded-lg border p-3"><strong>图片 {visual.slot + 1}：{visual.alt}</strong><p>{visual.delivered ? '已交付图片' : label(visual.status)} · {visual.acquisition}</p>
          <select aria-label={`为图片 ${visual.slot + 1} 选择授权原图`} className="my-2 min-h-11 w-full rounded border bg-white p-2" value={assets[visual.id] || ''} onChange={(event) => setAssets({...assets,[visual.id]:event.target.value})}><option value="">请选择对应的已授权、已留存原图</option>{report.assets.filter((asset) => asset.authorized && asset.has_bytes).map((asset) => <option key={asset.id} value={asset.id}>{asset.source_title} · 原图 {asset.position + 1} · {asset.alt_text || asset.id}</option>)}</select>
          {assets[visual.id] && <img className="my-2 max-h-64 max-w-full rounded" src={`/api/source-assets/${encodeURIComponent(assets[visual.id])}/preview`} alt="待绑定授权素材预览" />}
          <Button className="min-h-11 w-full sm:w-auto" size="sm" disabled={disabled || !assets[visual.id]} onClick={() => execute('bind_asset',{visualId:visual.id,assetId:assets[visual.id]})}>确认绑定这张原图并继续</Button>
        </div>)}
      </details>
      <p className="text-slate-500">Not Tested＝还没有完成验证；注意＝提醒，不等于失败；阻塞＝当前不能交付。素材准备度不代表质检通过。</p>
    </section>}
    {error && <p className="mt-2 text-red-700">{error}</p>}
  </div>;
}

function automaticText(automatic,activeJobs) {
  if (activeJobs?.length) return `任务正在队列中：${activeJobs.map((job) => label(job.type)).join('、')}。`;
  if (automatic?.reason === 'attempt_limit_reached') return `已达到自动修复上限（${automatic.attempts}/${automatic.maxAttempts}），需要人工判断。`;
  if (automatic?.reason === 'operation_must_be_resolved_first') return '当前先处理上面的流程、配置或图片故障；正文自修复不会与它同时启动。';
  if (automatic?.reason === 'manual_media_or_no_blocker') return '缺图片等问题无法凭空自动修复，需要重新采集原图；如果没有阻塞项则无需处理。';
  if (automatic?.eligible) return `系统可自动执行“${ACTION_LABELS[automatic.stage] || label(automatic.stage)}”，已尝试 ${automatic.attempts}/${automatic.maxAttempts} 次。`;
  return '当前没有可自动执行的修复动作。';
}

function SourceLink({source}) {
  return /^https?:\/\//i.test(source.url || '')
    ? <a className="my-1 block break-all text-blue-700 underline" href={source.url} target="_blank" rel="noreferrer">打开原文：{source.title} · {source.url}</a>
    : <p className="my-1">{source.title}：没有可打开链接，请在来源菜单按 ID {source.id} 查找。</p>;
}

function EditorialCorrection({value,disabled,onSave}) {
  const [body,setBody] = useState(value.body);
  const [ledger,setLedger] = useState(JSON.stringify(value.evidenceLedger,null,2));
  const [notes,setNotes] = useState(JSON.stringify(value.verificationNotes,null,2));
  const [error,setError] = useState('');
  const save = () => { try { setError(''); onSave({body,evidenceLedger:JSON.parse(ledger),verificationNotes:JSON.parse(notes)}); } catch (cause) { setError(`JSON 格式错误：${cause.message}`); } };
  return <details className="rounded-lg border p-3"><summary className="cursor-pointer font-semibold text-slate-800">人工修正文稿 / 台账 / 核验备注（高级）</summary>
    <p className="my-2">大多数问题会自动进入有界修复队列。只有系统达到重试上限或需要编辑判断时才使用这里。</p>
    <label className="block">英文正文<textarea className="mt-1 h-64 w-full rounded border p-2" value={body} onChange={(event) => setBody(event.target.value)} /></label>
    <label className="mt-2 block">证据台账（JSON）<textarea className="mt-1 h-32 w-full rounded border p-2 font-mono" value={ledger} onChange={(event) => setLedger(event.target.value)} /></label>
    <label className="mt-2 block">时效核验备注（JSON 字符串数组）<textarea className="mt-1 h-24 w-full rounded border p-2" value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    <Button className="mt-2 min-h-11" size="sm" disabled={disabled} onClick={save}>保存修订并自动继续</Button>{error && <p className="text-red-700">{error}</p>}
  </details>;
}

export function QualityIssue({issue}) {
  return <article className={`rounded-lg border p-3 ${issue.severity === 'warning' ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
    <strong>{issue.severity === 'warning' ? '提醒' : '阻塞'}：{issue.title}</strong>
    <p className="mt-1">{issue.reason}</p><p className="mt-1"><strong>怎么处理：</strong>{issue.action}</p>
    {issue.technicalDetail && <details className="mt-2 text-[11px] text-slate-500"><summary className="cursor-pointer">查看技术明细（给开发排查用）</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-white p-2">{issue.code}: {issue.technicalDetail}</pre></details>}
  </article>;
}
