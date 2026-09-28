import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { friendlyError } from '@/lib/utils';

const names = { content: '正文', media: '图片', canonical: '规范链接', indexability: '索引设置', schema: '结构化数据',
  'internal-links': '内链', sitemap: '站点地图', crawler: '爬虫访问', 'field-data': '真实用户性能' };
const states = { passed: '通过', failed: '发现问题', pending: '待核查', unknown: '未知', not_measured: '未测量',
  not_observed: '尚未检查', checking: '检查中', stale: '结果已过期' };
const reasons = { PUBLIC_SITE_NOT_CONFIGURED: '尚未配置公开站点地址。', PUBLICATION_NOT_PUBLIC: '当前稿件尚未确认为公开文章。',
  CONFIRMED_PUBLIC_URL_REQUIRED: '需要接收端确认的同站公开永久链接。' };

export function SeoInspection({ draftId, revision, editorial, times }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const endpoint = `/api/drafts/${encodeURIComponent(draftId)}/seo-inspection`;
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError('');
    api(endpoint, { signal: controller.signal }).then(setData).catch(e => { if (!controller.signal.aborted) setError(friendlyError(e.message)); });
    return () => controller.abort();
  }, [endpoint, revision]);
  async function inspect(refresh) {
    setBusy(true); setError('');
    try { setData(await api(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: data.page_revision, input_fingerprint: data.input_fingerprint, refresh }) })); }
    catch (e) { setError(friendlyError(e.message)); }
    finally { setBusy(false); }
  }
  const result = data?.observation?.result;
  return <Card className="mb-3 min-w-0 p-4" data-testid="seo-inspection" aria-busy={busy}>
    <h3 className="text-sm font-semibold text-slate-900">公开页面检查</h3>
    {times&&<details className="my-2 text-xs"><summary>内容与媒体时间依据</summary><dl className="mt-2 space-y-1">{[['published_at','首次发布'],['substantive_edit_at','正文实质修改'],['facts_verified_at','整篇事实核实'],['media_optimized_at','媒体优化']].map(([key,label])=><div key={key}><dt className="inline font-medium">{label}：</dt><dd className="inline">{times[key] || '无已存确认记录'}</dd></div>)}</dl><p className="mt-2">来源核实仅适用于对应证据；上传、换图和转码不更新整篇事实核实时间。</p></details>}
    {editorial&&<div className="my-3 rounded border p-3 text-xs" data-testid="editorial-seo"><p>文章关系建议：{{new:'独立成文',update:'评估更新已有文章',merge:'评估合并重复问题','keep-as-claim':'保留为知识点','needs-review':'实体或读者问题待核对'}[editorial.disposition.action]}</p><p className="mt-1">{editorial.context.question || '读者问题尚未明确'}</p><p className="mt-1">仅供编辑决定；不会自动合并、删除、改写或重定向。</p><ul className="mt-2">{editorial.disposition.candidates.map(target=><li key={target.post_id}>已有文章 #{target.post_id} · {target.question}</li>)}</ul><p className="mt-2">可用相关内链 {editorial.links.length} 条；访问待核目标 {editorial.unverified_targets.length} 条。</p></div>}
    <p className="mt-1 text-xs text-slate-600">手动读取公开页面、robots 和站点地图。检查结果不代表已收录、排名或 AI 引用。</p>
    <p role="status" className="mt-2 text-xs">{busy ? '正在检查公开页面…' : states[data?.state] || (error ? '读取失败' : '正在读取已保存结果…')}</p>
    {error && <p role="alert" className="mt-2 break-words text-xs text-rose-700">{error}</p>}
    {data?.reason && <p className="mt-2 text-xs text-slate-600">{reasons[data.reason] || data.reason}</p>}
    {data?.url && <p className="mt-2 break-all text-xs text-slate-600">{data.url}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!data?.available || busy} onClick={() => inspect(false)}>检查公开页面</Button>
      <Button size="sm" variant="outline" disabled={!data?.available || !result || busy} onClick={() => inspect(true)}>重新抓取检查</Button>
    </div>
    {data?.stale && <p className="mt-2 text-xs text-amber-800">以下为历史结果；文章或接收信息已变更，或检查时间已过期。</p>}
    {result && <>
      {result.crawler_policies&&<details className="mt-3 text-xs"><summary>搜索抓取与训练使用分别检查</summary><ul className="mt-2 space-y-2">{result.crawler_policies.map(item=><li key={item.agent}><strong>{item.agent}</strong>：{item.purpose} · 规则{item.policy.allowed===true?'允许':item.policy.allowed===false?'限制':'未知'}。<a className="underline" href={item.source} target="_blank" rel="noreferrer">官方用途说明</a>（核对于 {item.reviewed_at}）</li>)}</ul><p className="mt-2">这是规则观察，不证明爬虫实际访问、收录或引用；没有修改任何站点设置。</p></details>}
      <p className="mt-3 break-words text-xs text-slate-500">检查时间 {data.observation.checked_at} · 修订版 {data.observation.page_revision} · 证据 {result.health?.content?.source || '未知'}</p>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">{Object.entries(names).map(([key, name]) =>
        <div key={key} className="rounded-md bg-slate-50 p-2"><dt className="font-medium">{name}</dt><dd>{states[result.health?.[key]?.status] || '未知'}</dd></div>)}</dl>
      <ul className="mt-3 space-y-1 break-words text-xs text-slate-700">{[...(result.errors || []), ...(result.warnings || [])].map((item, i) =>
        <li key={i}>{item.severity === 'blocker' ? '需修复' : '提示'}：{item.code}{item.path ? ` · ${item.path}` : ''}</li>)}</ul>
    </>}
  </Card>;
}

export function SearchObservation() {
  const [data, setData] = useState(null), [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController();
    api('/api/search-console', { signal: controller.signal }).then(setData).catch(e => { if (!controller.signal.aborted) setError(friendlyError(e.message)); });
    return () => controller.abort();
  }, []);
  const labels = { not_configured: '未配置', not_observed: '尚未同步', no_data: '已同步，暂无数据', available: '有已保存数据', request_failed: '最近同步失败', stale: '数据已过期' };
  const observation = data?.observation;
  return <Card className="mt-3 min-w-0 p-4" data-testid="search-observation">
    <h3 className="text-sm font-semibold">搜索效果数据</h3>
    <p role="status" className="mt-2 text-xs">{labels[observation?.status] || (error ? '读取失败' : '正在读取…')}</p>
    {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
    {observation?.hasSnapshot && <p className="mt-2 break-words text-xs text-slate-600">上次成功 {observation.lastSucceededAt} · {observation.rowCount} 条查询与页面记录</p>}
    <p className="mt-2 text-xs text-slate-600">收录证据、AI 引荐、AI 引用与转化：未知。暂无查询数据不表示排名为零；爬虫访问不等于 AI 引用。</p>
  </Card>;
}
