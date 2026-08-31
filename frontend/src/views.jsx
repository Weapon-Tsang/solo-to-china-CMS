import { useEffect, useState } from "react";
import {
  Activity, CheckCircle2, Clock3, ExternalLink, Gauge, RefreshCw, RotateCcw, Webhook,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, SectionTitle, StatusPill, SummaryBar, TableShell } from "@/components/dashboard";
import { cn, formatDate, formatDuration, label } from "@/lib/utils";

export function ViewRenderer(props) {
  const components = {
    sources: SourcesView,
    recommendations: RecommendationsView,
    knowledge: KnowledgeView,
    blueprints: BlueprintsView,
    content: ContentView,
    wordpress: WordPressView,
    commercial: CommercialView,
    exceptions: ExceptionsView,
    maintenance: MaintenanceView,
    settings: SettingsView,
  };
  const Component = components[props.view];
  return <Component {...props} />;
}

function SettingsView({ data, health, onAction, actionBusy }) {
  const [model, setModel] = useState(data?.id || "kimi-k2.7-code");
  useEffect(() => setModel(data?.id || "kimi-k2.7-code"), [data?.id]);
  const save = () => onAction("/api/settings/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  }, `已切换到 ${data?.models?.find((item) => item.id === model)?.label || model}`);
  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,.75fr)]">
    <Card className="p-5"><div className="flex items-start justify-between gap-4"><div><div className="text-sm font-semibold text-slate-900">AI 模型</div><p className="mt-1 text-xs leading-relaxed text-slate-500">用于排队中的来源提取、内容规划、写作和质量审核。每次输出都会记录实际使用的模型。</p></div><StatusPill status={data?.configured ? "configured" : "needs_ai"} /></div>
      <div className="mt-5 space-y-2">{(data?.models || []).map((item) => <label key={item.id} className={cn("flex cursor-pointer gap-3 rounded-xl border p-3 transition", model === item.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300")}><input className="mt-1 accent-slate-900" type="radio" name="ai-model" value={item.id} checked={model === item.id} onChange={() => setModel(item.id)} /><span><span className="block text-xs font-semibold text-slate-900">{item.label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{item.description}</span><span className="mt-1 block text-[10px] text-emerald-600">支持图文多模态输入{item.preview ? " · 预览版" : ""}</span></span></label>)}</div>
      <div className="mt-5 flex items-center gap-3"><Button size="sm" disabled={actionBusy || !data?.configured || model === data?.id} onClick={save}><CheckCircle2 /> 保存模型</Button><span className="text-[11px] text-slate-400">来源：{data?.source === "dashboard" ? "后台设置" : "环境配置"}</span></div>
    </Card>
    <Card className="p-5"><div className="text-sm font-semibold text-slate-900">System information</div><div className="mt-4 space-y-3 text-xs text-slate-600"><div className="flex items-center justify-between gap-3"><span>Application version</span><span className="font-medium text-slate-900">{data?.appVersion || health?.version || "—"}</span></div><div className="flex items-center justify-between gap-3"><span>Content Strategy</span><span className="font-medium text-slate-900">v{data?.contentStrategy?.version || health?.contentStrategy?.version || "—"}</span></div><div className="flex items-center justify-between gap-3"><span>Strategy status</span><StatusPill status={data?.contentStrategy?.status || health?.contentStrategy?.status} /></div><div className="flex items-center justify-between gap-3"><span>SEO / GEO metadata</span><StatusPill status="ready" /></div><div className="flex items-center justify-between gap-3"><span>Structured data package</span><StatusPill status="ready" /></div><div className="flex items-center justify-between gap-3"><span>Cloud visual generation</span><StatusPill status={health?.visualGenerationConfigured ? "ready" : "pending"} /></div></div><p className="mt-5 text-[11px] leading-relaxed text-slate-400">{data?.contentStrategy?.document || "Strategy specification pending"}. Visual plans are always created with drafts; only safe illustrations are rendered automatically.</p></Card>
  </div>;
}

function SourcesView({ data, onGuide, onOpenSource }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="source" title="尚无来源" description="在电脑端打开一篇小红书笔记，然后点击 Chrome 扩展中的“保存当前笔记”。" action={() => onGuide("capture")} actionLabel="查看采集说明" />;
  return (
    <><SummaryBar title="处理状态说明"><span><b>处理中：</b>笔记已安全保存，系统正在进行多模态提取、结构化来源、Claims 和内容蓝图。</span><span><b>提取完成：</b>结构化研究已可用，并不代表文章已生成。</span><span><b>需要处理：</b>打开来源查看原因后可重新执行提取。</span></SummaryBar><TableShell><Table><TableHeader><TableRow><TableHead>来源</TableHead><TableHead>状态</TableHead><TableHead className="hidden md:table-cell">目的地</TableHead><TableHead>Claims</TableHead><TableHead className="hidden lg:table-cell">采集时间</TableHead></TableRow></TableHeader>
      <TableBody>{items.map((item) => <TableRow key={item.id} tabIndex={0} role="button" className="cursor-pointer focus-visible:bg-slate-50 focus-visible:outline-none" onClick={() => onOpenSource(item.id)} onKeyDown={(event) => event.key === "Enter" && onOpenSource(item.id)}>
        <TableCell><div className="max-w-md font-medium text-slate-900">{item.title || "Untitled note"}</div><div className="mt-1 text-[11px] text-slate-400">{item.author_name || "Unknown author"} · v{item.capture_version}</div></TableCell>
        <TableCell><StatusPill status={item.status} /></TableCell><TableCell className="hidden md:table-cell">{item.destination_name || "—"}</TableCell><TableCell className="tabular-nums">{item.claim_count}</TableCell><TableCell className="hidden whitespace-nowrap lg:table-cell">{formatDate(item.captured_at)}</TableCell>
      </TableRow>)}</TableBody></Table></TableShell></>
  );
}

function RecommendationsView({ data, onAction, actionBusy, onNavigate }) {
  const items = data?.items || [];
  const opportunities = data?.opportunities || [];
  const decide = (id, decision, message) => onAction(`/api/recommendations/${id}/decision`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
  }, message);
  if (!items.length) return <EmptyState icon="content" title="No recommendations yet" description="After Kimi finishes source extraction, the engine will recommend Knowledge, a cluster, research, or an article candidate here." action={() => onNavigate("sources")} actionLabel="View research sources" />;
  return <div className="space-y-4">
    {opportunities.length > 0 && <SummaryBar title={`${opportunities.length} content opportunities`}><span>Readiness is evidence-based, not a promise to publish.</span><span>{opportunities.filter((item) => item.status === "research_required").length} need research</span></SummaryBar>}
    <TableShell><Table><TableHeader><TableRow><TableHead>Source & recommendation</TableHead><TableHead>Signal</TableHead><TableHead className="hidden lg:table-cell">Missing / cluster</TableHead><TableHead>Decision</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="max-w-md font-medium text-slate-900">{item.source_title || item.primary_topic}</div><div className="mt-1 flex flex-wrap gap-1.5"><StatusPill status={item.classification} /><span className="text-[10px] text-slate-400">Strategy v{item.strategy_version}</span></div><p className="mt-2 max-w-xl text-[11px] leading-relaxed text-slate-500">{item.reasoning_summary}</p>{item.suggested_article_title && <p className="mt-1 text-[11px] font-medium text-slate-700">Suggested: {item.suggested_article_title}</p>}</TableCell><TableCell><div className="text-xs text-slate-700">Potential {Math.round(item.article_potential)} / 100</div><div className="mt-1 text-[10px] text-slate-400">Density {Math.round(item.information_density)} · Complete {Math.round(item.topic_completeness)} · Confidence {Math.round(item.confidence * 100)}%</div></TableCell><TableCell className="hidden max-w-sm lg:table-cell"><div className="text-[11px] text-slate-600">{item.missing_information?.join(" · ") || "No material gaps recorded"}</div><div className="mt-1 text-[10px] text-slate-400">{item.possible_cluster_topics?.join(" · ") || "No cluster suggestion"}</div></TableCell><TableCell>{item.decision === "pending" ? <div className="flex max-w-44 flex-wrap gap-1"><Button size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "approved_article", "Article approval recorded; planning will start when evidence readiness allows.")}>Approve article</Button><Button variant="secondary" size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "knowledge_only", "Marked as Knowledge only")}>Knowledge</Button><Button variant="secondary" size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "cluster", "Added to a cluster opportunity")}>Cluster</Button><Button variant="secondary" size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "research_first", "Marked for research first")}>Research</Button><Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "ignored", "Recommendation ignored")}>Ignore</Button></div> : <><StatusPill status={item.decision} /><div className="mt-1 text-[10px] text-slate-400">{item.approved_candidate_id ? "Content planning queued" : "Decision recorded"}</div></>}</TableCell></TableRow>)}</TableBody></Table></TableShell>
  </div>;
}

function KnowledgeView({ data, onNavigate }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="knowledge" title="Knowledge is building" description="Structured facts will appear after claims have been extracted from saved sources." action={() => onNavigate("sources")} actionLabel="View research sources" />;
  return <TableShell><Table><TableHeader><TableRow><TableHead>Destination</TableHead><TableHead>Claim</TableHead><TableHead className="hidden lg:table-cell">Value</TableHead><TableHead>Evidence</TableHead><TableHead>State</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell className="font-medium text-slate-900">{item.destination_name}</TableCell><TableCell><div className="font-medium text-slate-800">{item.subject} · {item.predicate}</div><div className="mt-1 max-w-sm truncate text-[10px] text-slate-400">{item.normalized_key}</div></TableCell><TableCell className="hidden max-w-md lg:table-cell">{item.preferred_value}</TableCell><TableCell>{item.evidence.length}</TableCell><TableCell><StatusPill status={item.consensus_status} /><div className="mt-1 text-[10px] text-slate-400">{label(item.freshness_state)} · {label(item.verification_priority)}</div></TableCell></TableRow>)}</TableBody></Table></TableShell>;
}

function BlueprintsView({ data, onNavigate }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="blueprint" title="No editorial patterns yet" description="Reusable angles, formats, and section patterns appear after source blueprint extraction." action={() => onNavigate("sources")} actionLabel="View research sources" />;
  return <TableShell><Table><TableHeader><TableRow><TableHead>Pattern</TableHead><TableHead>Format</TableHead><TableHead>Samples</TableHead><TableHead className="hidden md:table-cell">Top sections</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell className="font-medium text-slate-900">{item.angle}</TableCell><TableCell>{item.format}</TableCell><TableCell>{item.sample_count}</TableCell><TableCell className="hidden max-w-xl md:table-cell">{item.section_patterns.slice(0, 4).map((entry) => entry.value).join(" · ") || "—"}</TableCell></TableRow>)}</TableBody></Table></TableShell>;
}

function ContentView({ data, onNavigate, onOpenDraft }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="content" title="No topics are ready" description="Candidates appear automatically when a destination reaches the required independent evidence threshold." action={() => onNavigate("knowledge")} actionLabel="Review destination knowledge" />;
  return <TableShell><Table><TableHeader><TableRow><TableHead>Topic</TableHead><TableHead>Coverage</TableHead><TableHead className="hidden md:table-cell">Evidence</TableHead><TableHead>Pipeline</TableHead><TableHead className="hidden lg:table-cell">QA / WordPress</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id} tabIndex={item.draft_id ? 0 : undefined} role={item.draft_id ? "button" : undefined} className={cn(item.draft_id && "cursor-pointer")} onClick={() => item.draft_id && onOpenDraft(item.draft_id)} onKeyDown={(event) => event.key === "Enter" && item.draft_id && onOpenDraft(item.draft_id)}><TableCell><div className="max-w-md font-medium text-slate-900">{item.draft_title || item.proposed_title}</div><div className="mt-1 max-w-lg text-[11px] leading-relaxed text-slate-400">{item.rationale}</div>{item.suppression_reason && <div className="mt-1 text-[10px] font-medium text-amber-600">Suppressed: {item.suppression_reason}</div>}</TableCell><TableCell className="font-medium tabular-nums">{Math.round(item.coverage_score)}%</TableCell><TableCell className="hidden md:table-cell">{item.evidence_count} sources · {item.conflict_count} conflicts<div className="mt-1 text-[10px] text-slate-400">{item.stale_fact_count || 0} stale · {item.verification_fact_count || 0} verify</div></TableCell><TableCell><StatusPill status={item.draft_status || item.brief_status || item.status} />{item.status === "candidate" && <div className="mt-1 text-[10px] text-slate-400">Approval required in Recommendations</div>}</TableCell><TableCell className="hidden lg:table-cell">{item.qa_score == null ? "—" : `${Math.round(item.qa_score)} · ${item.qa_passed ? "Passed" : "Failed"}`}<div className="mt-1 text-[10px] text-slate-400">Commercial: {label(item.commercial_status || "pending")} ({item.commercial_offer_count || 0}) · WP: {label(item.wordpress_status || "not_synced")}</div></TableCell></TableRow>)}</TableBody></Table></TableShell>;
}

function WordPressView({ data, onGuide }) {
  if (!data?.configured) return <EmptyState icon="wordpress" title="Connect WordPress" description="Add your site URL and an Application Password to enable automatic read-only inventory sync." action={() => onGuide("wordpress")} actionLabel="Open setup guide" />;
  const items = data.items || [];
  const summary = <SummaryBar title={`${items.length} posts tracked`}><span>Sync: {label(data.sync?.status || "pending")}</span>{data.sync?.last_succeeded_at && <span>Last success {formatDate(data.sync.last_succeeded_at)}</span>}{data.sync?.last_error && <span className="text-red-600">{data.sync.last_error}</span>}</SummaryBar>;
  if (!items.length) return <>{summary}<EmptyState icon="wordpress" title="Inventory is empty" description="The first sync is still pending, or this WordPress site has no posts." /></>;
  return <>{summary}<TableShell><Table><TableHeader><TableRow><TableHead>Post</TableHead><TableHead>Status</TableHead><TableHead className="hidden md:table-cell">Slug</TableHead><TableHead className="hidden lg:table-cell">Modified</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="flex items-center gap-1.5 font-medium text-slate-900">{item.post_url ? <a className="inline-flex items-center gap-1 hover:text-blue-600" href={item.post_url} target="_blank" rel="noreferrer">{item.title || "Untitled"}<ExternalLink className="size-3" /></a> : item.title || "Untitled"}</div><div className="mt-1 text-[10px] text-slate-400">WordPress #{item.post_id}</div></TableCell><TableCell><StatusPill status={item.status} /></TableCell><TableCell className="hidden md:table-cell">{item.slug}</TableCell><TableCell className="hidden whitespace-nowrap lg:table-cell">{formatDate(item.modified_at)}</TableCell></TableRow>)}</TableBody></Table></TableShell></>;
}

function CommercialView({ data, onGuide }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="offer" title="No active offers" description="Research drafts remain complete and can reach WordPress even when the commercial layer is empty." action={() => onGuide("commercial")} actionLabel="View offer API guide" />;
  return <TableShell><Table><TableHeader><TableRow><TableHead>Offer</TableHead><TableHead>Destination</TableHead><TableHead>Category</TableHead><TableHead className="hidden md:table-cell">Provider</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="font-medium text-slate-900">{item.title || item.offer_key || item.id}</div><div className="mt-1 text-[10px] text-slate-400">Priority {item.priority} · {item.price_text || "No price copy"}</div></TableCell><TableCell>{item.destination_slug}</TableCell><TableCell>{label(item.category)}</TableCell><TableCell className="hidden md:table-cell">{item.provider}</TableCell><TableCell><StatusPill status={item.active ? "active" : "inactive"} /><div className="mt-1 text-[10px] text-slate-400">{item.valid_until ? `Until ${formatDate(item.valid_until)}` : "No expiry"}</div></TableCell></TableRow>)}</TableBody></Table></TableShell>;
}

function ExceptionsView({ data, onAction, actionBusy }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="check" title="Everything looks good" description="The pipeline has no operational exceptions that require your attention." healthy />;
  return <TableShell><Table><TableHeader><TableRow><TableHead>Issue</TableHead><TableHead>Kind</TableHead><TableHead>Severity</TableHead><TableHead className="hidden md:table-cell">Updated</TableHead><TableHead>Action</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.key}><TableCell><div className="font-medium text-slate-900">{item.title}</div><div className="mt-1 text-xs text-slate-600">{item.subject}</div><div className="mt-1 max-w-xl text-[10px] leading-relaxed text-slate-400">{item.detail}</div></TableCell><TableCell>{label(item.kind)}</TableCell><TableCell><StatusPill status={item.severity} /></TableCell><TableCell className="hidden whitespace-nowrap md:table-cell">{formatDate(item.updatedAt)}</TableCell><TableCell>{item.retryable ? <Button variant="secondary" size="sm" disabled={actionBusy} onClick={() => onAction(`/api/exceptions/${encodeURIComponent(item.key)}/retry`, { method: "POST" }, "Retry queued")}><RotateCcw /> Retry</Button> : <span className="text-[10px] text-slate-400">New evidence required</span>}</TableCell></TableRow>)}</TableBody></Table></TableShell>;
}

function MaintenanceView({ data, onAction, actionBusy }) {
  const telemetry = data?.telemetry || { active: 0, oldestQueuedAgeSeconds: 0, windowHours: 24, recent: { completed: 0, failed: 0, successRate: null, queueLatencyMs: {}, durationMs: {} }, types: [] };
  const recent = telemetry.recent;
  const notifications = data?.notifications || { configured: false, failed: 0, repeatHours: 24, minimumSeverity: "blocker" };
  const wordpress = data?.wordpressSync;
  const searchConsole = data?.searchConsoleSync;
  const cards = [
    [Activity, "Active queue", telemetry.active, telemetry.oldestQueuedAgeSeconds ? `Oldest ${formatDuration(telemetry.oldestQueuedAgeSeconds * 1000)}` : "No waiting jobs", telemetry.active ? "warning" : "success"],
    [CheckCircle2, "Success rate", recent.successRate == null ? "—" : `${recent.successRate}%`, `${recent.completed} completed in ${telemetry.windowHours}h`, recent.failed ? "warning" : "success"],
    [Clock3, "Queue p95", formatDuration(recent.queueLatencyMs?.p95), `${recent.queueLatencyMs?.samples || 0} measured jobs`, "info"],
    [Gauge, "Processing p95", formatDuration(recent.durationMs?.p95), `${recent.durationMs?.samples || 0} measured jobs`, "info"],
    [Webhook, "Exception alerts", notifications.configured ? notifications.failed ? "Delivery issue" : notifications.lastSentAt ? "Connected" : "Ready" : "Not configured", notifications.configured ? `Repeat ${notifications.repeatHours}h · ${notifications.minimumSeverity}+` : "Optional HTTPS webhook", notifications.failed ? "danger" : notifications.configured ? "success" : "default"],
  ];
  return <>
    <section aria-label="Operational health" className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
      {cards.map(([Icon, title, value, detail, tone]) => <OperationCard key={title} icon={Icon} title={title} value={value} detail={detail} tone={tone} className={title === "Exception alerts" ? "col-span-2 lg:col-span-1" : ""} />)}
    </section>
    <SummaryBar title={data?.enabled ? "Automatic maintenance enabled" : "Automatic maintenance disabled"} action={<Button size="sm" disabled={!data?.enabled || actionBusy} onClick={() => onAction("/api/maintenance/run", { method: "POST" }, "Maintenance run completed")}><RefreshCw className={cn(actionBusy && "animate-spin")} /> Run now</Button>}><span>Checks every {data?.intervalMinutes || 15} minutes</span><span>{label(data?.logging?.format || "json")} logs</span></SummaryBar>
    <SectionTitle title="Maintenance tasks" description="Durable schedules survive restarts" />
    <TableShell><Table><TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Status</TableHead><TableHead className="hidden md:table-cell">Last success</TableHead><TableHead>Items</TableHead><TableHead className="hidden lg:table-cell">Result</TableHead></TableRow></TableHeader><TableBody>{(data?.runs || []).map((run) => <TableRow key={run.task_key}><TableCell className="font-medium text-slate-900">{label(run.task_key)}</TableCell><TableCell><StatusPill status={run.status} /></TableCell><TableCell className="hidden whitespace-nowrap md:table-cell">{formatDate(run.last_succeeded_at)}</TableCell><TableCell>{run.item_count}</TableCell><TableCell className="hidden max-w-xl text-[11px] lg:table-cell">{run.last_error || maintenanceResult(run.metadata)}</TableCell></TableRow>)}<IntegrationRow title="WordPress inventory" state={wordpress} result="Read-only post synchronization" /><IntegrationRow title="Search Console queries" state={searchConsole} result="Read-only cannibalization protection" /></TableBody></Table></TableShell>
    {telemetry.types?.length > 0 && <><SectionTitle title="Job performance" description={`Rolling ${telemetry.windowHours}-hour window`} /><TableShell><Table><TableHeader><TableRow><TableHead>Job type</TableHead><TableHead>Queued</TableHead><TableHead>Running</TableHead><TableHead>Completed</TableHead><TableHead>Success</TableHead><TableHead className="hidden md:table-cell">p95 duration</TableHead></TableRow></TableHeader><TableBody>{telemetry.types.map((item) => <TableRow key={item.type}><TableCell className="font-medium text-slate-900">{label(item.type)}</TableCell><TableCell>{item.queued}</TableCell><TableCell>{item.running}</TableCell><TableCell>{item.completed}</TableCell><TableCell>{item.completed ? `${Math.round(item.succeeded / item.completed * 100)}%` : "—"}</TableCell><TableCell className="hidden md:table-cell">{formatDuration(item.durationP95Ms)}</TableCell></TableRow>)}</TableBody></Table></TableShell></>}
  </>;
}

function IntegrationRow({ title, state, result }) {
  return <TableRow><TableCell className="font-medium text-slate-900">{title}</TableCell><TableCell><StatusPill status={state?.status || "not_configured"} /></TableCell><TableCell className="hidden md:table-cell">{formatDate(state?.last_succeeded_at)}</TableCell><TableCell>{state?.item_count || 0}</TableCell><TableCell className="hidden lg:table-cell">{state?.last_error || result}</TableCell></TableRow>;
}

function OperationCard({ icon: Icon, title, value, detail, tone, className }) {
  const iconTone = { success: "bg-emerald-50 text-emerald-600", warning: "bg-amber-50 text-amber-600", danger: "bg-red-50 text-red-600", info: "bg-blue-50 text-blue-600", default: "bg-slate-100 text-slate-500" }[tone] || "bg-slate-100 text-slate-500";
  return <Card className={cn("flex min-w-0 items-start gap-3 p-3.5", className)}><span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", iconTone)}><Icon className="size-4" /></span><div className="min-w-0"><div className="text-[10px] font-medium text-slate-500">{title}</div><div className="mt-1 truncate text-lg font-semibold tracking-tight text-slate-900">{value}</div><div className="mt-0.5 truncate text-[9px] text-slate-400">{detail}</div></div></Card>;
}

function maintenanceResult(metadata) {
  if (metadata?.backup) return `${metadata.backup} · schema ${metadata.schemaVersion} · ${metadata.bytes} bytes · SHA ${metadata.sha256?.slice(0, 12) || "—"}`;
  if (metadata?.retentionDays) return `${metadata.retentionDays}-day retention`;
  return "Completed";
}
