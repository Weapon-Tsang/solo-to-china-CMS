import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusPill } from "@/components/dashboard";

const TITLES = {
  content_quality: "内容质量",
  seo_technical: "SEO 技术检查",
  geo_content_consistency: "GEO 内容一致性",
  production_cost: "生产开销",
};

export function ContentQualityStatus({ operation, actionBusy = false, onRetry = null, onAction = null, compact = false }) {
  const [inspection, setInspection] = useState("");
  if (!operation?.dimensions) return <span className="text-[10px] text-slate-400">检查尚未建立</span>;
  const entries = Object.entries(operation.dimensions);
  if (compact) return <div className="mt-2 flex flex-wrap gap-1.5">{entries.map(([key, item]) => <span key={key} title={item.reason} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[9px] text-slate-600"><span>{TITLES[key]}</span><StatusPill status={item.status} /></span>)}</div>;
  const compare = async () => {
    const action = operation.actions?.find((item) => item.id === "compare_revisions");
    if (!action?.endpoint) return setInspection("当前还没有可比较的稿件修订。");
    const history = await api(action.endpoint);
    if ((history.items || []).length < 2) return setInspection("至少保留两个稿件修订后才能比较。");
    const [to, from] = history.items;
    const result = await api(`${action.endpoint}?from=${from.revision}&to=${to.revision}`);
    setInspection(`修订 ${from.revision} → ${to.revision}：${result.changedFields.join("、") || "可见字段无变化"}`);
  };
  const cancel = async () => {
    const action = operation.actions?.find((item) => item.id === "cancel");
    if (!action?.previewEndpoint || !onAction) return;
    const preview = await api(action.previewEndpoint);
    const jobs = preview.affectedJobs?.map((item) => item.type).join("、") || "无排队任务";
    if (!window.confirm(`取消预览：将停止 ${jobs}；来源、证据、稿件修订和商业事件会保留。继续吗？`)) return;
    await onAction(action.executeEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewId: preview.id }) }, "内容任务已取消，历史产物已保留");
  };
  return <Card className="mb-3 border-slate-200 p-4 shadow-none">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-xs font-semibold text-slate-900">生产就绪状态</h3><p className="mt-1 text-[10px] text-slate-500">四项独立结论不会互相抵消；这是技术与内容准备状态，不是排名、流量或 AI 引用预测。</p></div><StatusPill status={operation.status} /></div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">{entries.map(([key, item]) => <section key={key} className="rounded-lg border border-slate-100 bg-slate-50 p-3"><div className="flex items-center justify-between gap-2"><strong className="text-[11px] text-slate-800">{TITLES[key]}</strong><StatusPill status={item.status} /></div><p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">{item.reason}</p><p className="mt-1 text-[9px] text-slate-400">位置：{item.target} · 运行版本：{item.runVersion}</p><p className="mt-1 text-[10px] text-slate-600">修复：{item.fix}</p></section>)}</div>
    <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/60 p-3 text-[10px] text-blue-900"><strong>下一步：</strong>{operation.nextAction?.label} · {operation.nextAction?.reason}<br /><strong>额外调用：</strong>{operation.estimatedAdditionalCalls?.status} {operation.estimatedAdditionalCalls?.stages?.join(", ")}</div>
    {onRetry && operation.retry && <Button className="mt-3" size="sm" variant="secondary" disabled={actionBusy} onClick={() => onRetry(operation.retry)}>只重试失败阶段：{operation.retry.stage}</Button>}
    <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={actionBusy} onClick={compare}>比较修订</Button>{onAction && <Button size="sm" variant="outline" disabled={actionBusy} onClick={cancel}>预览并取消</Button>}<span className="self-center text-[10px] text-slate-500">缩小命题：回到命题工作区 · 补证据：进入来源工作区</span></div>
    {inspection && <p className="mt-2 rounded-md bg-slate-50 px-2 py-1.5 text-[10px] text-slate-600">{inspection}</p>}
  </Card>;
}
import { useState } from "react";
import { api } from "@/lib/api";
