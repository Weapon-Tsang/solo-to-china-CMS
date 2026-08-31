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
        <TableCell><div className="max-w-md font-medium text-slate-900">{item.title || "未命名笔记"}</div><div className="mt-1 text-[11px] text-slate-400">{item.author_name || "未知作者"} · v{item.capture_version}</div></TableCell>
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
  if (!items.length) return <EmptyState icon="content" title="暂时没有内容建议" description="AI 完成来源提取后，系统会在这里建议：沉淀为知识、归入专题、补充研究，或进入文章候选。" action={() => onNavigate("sources")} actionLabel="查看研究来源" />;
  return <div className="space-y-4">
    <SummaryBar title="“建议”如何使用"><span>它是人工审批关口：系统只推荐下一步，不会自动发布文章。</span><span>“补充研究”表示现有证据不足，优先核验官方信息。</span></SummaryBar>
    {opportunities.length > 0 && <SummaryBar title={`${opportunities.length} 个内容机会`}><span>文章就绪度以证据为准，不等于会自动发布。</span><span>{opportunities.filter((item) => item.status === "research_required").length} 个需要补充研究</span></SummaryBar>}
    <TableShell><Table><TableHeader><TableRow><TableHead>来源与建议</TableHead><TableHead>信号</TableHead><TableHead className="hidden lg:table-cell">缺失信息 / 专题</TableHead><TableHead>你的决定</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="max-w-md font-medium text-slate-900">{item.source_title || item.primary_topic}</div><div className="mt-1 flex flex-wrap gap-1.5"><StatusPill status={item.classification} /><span className="text-[10px] text-slate-400">策略 v{item.strategy_version}</span></div><p className="mt-2 max-w-xl text-[11px] leading-relaxed text-slate-500">{item.reasoning_summary}</p>{item.suggested_article_title && <p className="mt-1 text-[11px] font-medium text-slate-700">建议标题：{item.suggested_article_title}</p>}</TableCell><TableCell><div className="text-xs text-slate-700">文章潜力 {Math.round(item.article_potential)} / 100</div><div className="mt-1 text-[10px] text-slate-400">信息密度 {Math.round(item.information_density)} · 完整度 {Math.round(item.topic_completeness)} · 可信度 {Math.round(item.confidence * 100)}%</div></TableCell><TableCell className="hidden max-w-sm lg:table-cell"><div className="text-[11px] text-slate-600">{item.missing_information?.join(" · ") || "未记录关键缺口"}</div><div className="mt-1 text-[10px] text-slate-400">{item.possible_cluster_topics?.join(" · ") || "暂无专题归类建议"}</div></TableCell><TableCell>{item.decision === "pending" ? <div className="flex max-w-44 flex-wrap gap-1"><Button size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "approved_article", "已批准文章候选；证据就绪后将开始规划。")}>批准文章</Button><Button variant="secondary" size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "knowledge_only", "已标记为仅进入知识库")}>仅入知识库</Button><Button variant="secondary" size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "cluster", "已加入专题机会")}>归入专题</Button><Button variant="secondary" size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "research_first", "已标记为优先补充研究")}>补充研究</Button><Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" disabled={actionBusy} onClick={() => decide(item.id, "ignored", "已忽略此建议")}>忽略</Button></div> : <><StatusPill status={item.decision} /><div className="mt-1 text-[10px] text-slate-400">{item.approved_candidate_id ? "内容规划已排队" : "决定已记录"}</div></>}</TableCell></TableRow>)}</TableBody></Table></TableShell>
  </div>;
}

function KnowledgeView({ data, onNavigate }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="knowledge" title="知识库正在建立" description="已保存来源完成信息主张提取后，经过结构化整理的事实会显示在这里。" action={() => onNavigate("sources")} actionLabel="查看研究来源" />;
  return <><SummaryBar title="知识库说明"><span>这里是可复用的结构化事实，不是原始笔记的翻译。</span><span>证据数表示支撑该事实的来源记录；冲突和时效状态会提示你是否需要复核。</span></SummaryBar><TableShell><Table><TableHeader><TableRow><TableHead>目的地</TableHead><TableHead>事实</TableHead><TableHead className="hidden lg:table-cell">当前结论</TableHead><TableHead>证据</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell className="font-medium text-slate-900">{item.destination_name || "—"}</TableCell><TableCell><div className="font-medium text-slate-800">{item.subject || "—"} · {item.predicate || "—"}</div><div className="mt-1 max-w-sm truncate text-[10px] text-slate-400">{item.normalized_key || "—"}</div></TableCell><TableCell className="hidden max-w-md lg:table-cell">{item.preferred_value || "—"}</TableCell><TableCell>{Array.isArray(item.evidence) ? item.evidence.length : 0}</TableCell><TableCell><StatusPill status={item.consensus_status} /><div className="mt-1 text-[10px] text-slate-400">{label(item.freshness_state)} · {label(item.verification_priority)}</div></TableCell></TableRow>)}</TableBody></Table></TableShell></>;
}

function BlueprintsView({ data, onNavigate }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="blueprint" title="暂无编辑蓝图" description="系统会从已提取来源中归纳可复用的选题角度、写作形式和章节结构。" action={() => onNavigate("sources")} actionLabel="查看研究来源" />;
  return <><SummaryBar title="编辑蓝图说明"><span>蓝图记录“怎么写更有帮助”，不是把来源内容直接翻译成文章。</span><span>它会在后续内容规划时提供结构和角度参考。</span></SummaryBar><TableShell><Table><TableHeader><TableRow><TableHead>写作模式</TableHead><TableHead>形式</TableHead><TableHead>样本数</TableHead><TableHead className="hidden md:table-cell">常见章节</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell className="font-medium text-slate-900">{item.angle}</TableCell><TableCell>{item.format}</TableCell><TableCell>{item.sample_count}</TableCell><TableCell className="hidden max-w-xl md:table-cell">{Array.isArray(item.section_patterns) ? item.section_patterns.slice(0, 4).map((entry) => entry?.value).filter(Boolean).join(" · ") || "—" : "—"}</TableCell></TableRow>)}</TableBody></Table></TableShell></>;
}

function ContentView({ data, onNavigate, onOpenDraft }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="content" title="暂无可生产的选题" description="当一个目的地具备足够的独立证据并通过建议页审批后，选题会自动出现在这里。" action={() => onNavigate("knowledge")} actionLabel="查看目的地知识" />;
  return <><SummaryBar title="内容生产说明"><span>这里管理已批准选题的规划、英文草稿、质量审核和 WordPress 草稿投递。</span><span>点击已有草稿的行可查看详情。</span></SummaryBar><TableShell><Table><TableHeader><TableRow><TableHead>选题</TableHead><TableHead>覆盖度</TableHead><TableHead className="hidden md:table-cell">证据</TableHead><TableHead>流程状态</TableHead><TableHead className="hidden lg:table-cell">质检 / WordPress</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id} tabIndex={item.draft_id ? 0 : undefined} role={item.draft_id ? "button" : undefined} className={cn(item.draft_id && "cursor-pointer")} onClick={() => item.draft_id && onOpenDraft(item.draft_id)} onKeyDown={(event) => event.key === "Enter" && item.draft_id && onOpenDraft(item.draft_id)}><TableCell><div className="max-w-md font-medium text-slate-900">{item.draft_title || item.proposed_title}</div><div className="mt-1 max-w-lg text-[11px] leading-relaxed text-slate-400">{item.rationale}</div>{item.suppression_reason && <div className="mt-1 text-[10px] font-medium text-amber-600">已抑制：{item.suppression_reason}</div>}</TableCell><TableCell className="font-medium tabular-nums">{Math.round(item.coverage_score)}%</TableCell><TableCell className="hidden md:table-cell">{item.evidence_count} 个来源 · {item.conflict_count} 项冲突<div className="mt-1 text-[10px] text-slate-400">{item.stale_fact_count || 0} 项过期 · {item.verification_fact_count || 0} 项待核验</div></TableCell><TableCell><StatusPill status={item.draft_status || item.brief_status || item.status} />{item.status === "candidate" && <div className="mt-1 text-[10px] text-slate-400">请先在“建议”中审批</div>}</TableCell><TableCell className="hidden lg:table-cell">{item.qa_score == null ? "—" : `${Math.round(item.qa_score)} · ${item.qa_passed ? "通过" : "未通过"}`}<div className="mt-1 text-[10px] text-slate-400">商品：{label(item.commercial_status || "pending")}（{item.commercial_offer_count || 0}）· WP：{label(item.wordpress_status || "not_synced")}</div></TableCell></TableRow>)}</TableBody></Table></TableShell></>;
}

function WordPressView({ data, onGuide }) {
  if (!data?.configured) return <EmptyState icon="wordpress" title="请连接 WordPress" description="配置站点地址和 Application Password 后，系统会先以只读方式同步现有文章库存，避免选题重复。" action={() => onGuide("wordpress")} actionLabel="查看配置说明" />;
  const items = data.items || [];
  const summary = <SummaryBar title={`已追踪 ${items.length} 篇文章`}><span>同步：{label(data.sync?.status || "pending")}</span>{data.sync?.last_succeeded_at && <span>最近成功：{formatDate(data.sync.last_succeeded_at)}</span>}{data.sync?.last_error && <span className="text-red-600">{data.sync.last_error}</span>}</SummaryBar>;
  if (!items.length) return <>{summary}<EmptyState icon="wordpress" title="文章库存为空" description="首次同步仍在等待，或者该 WordPress 站点目前没有文章。" /></>;
  return <>{summary}<TableShell><Table><TableHeader><TableRow><TableHead>文章</TableHead><TableHead>状态</TableHead><TableHead className="hidden md:table-cell">固定链接</TableHead><TableHead className="hidden lg:table-cell">修改时间</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="flex items-center gap-1.5 font-medium text-slate-900">{item.post_url ? <a className="inline-flex items-center gap-1 hover:text-blue-600" href={item.post_url} target="_blank" rel="noreferrer">{item.title || "未命名文章"}<ExternalLink className="size-3" /></a> : item.title || "未命名文章"}</div><div className="mt-1 text-[10px] text-slate-400">WordPress #{item.post_id}</div></TableCell><TableCell><StatusPill status={item.status} /></TableCell><TableCell className="hidden md:table-cell">{item.slug}</TableCell><TableCell className="hidden whitespace-nowrap lg:table-cell">{formatDate(item.modified_at)}</TableCell></TableRow>)}</TableBody></Table></TableShell></>;
}

function CommercialView({ data, onGuide }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="offer" title="暂无启用商品" description="商品层独立于研究知识库。即使未配置联盟商品，研究和 WordPress 草稿流程也可正常运行。" action={() => onGuide("commercial")} actionLabel="查看商品 API 说明" />;
  return <><SummaryBar title="商品层说明"><span>这里维护酒店、门票、交通等可用的联盟商品，不会反向改写研究事实。</span></SummaryBar><TableShell><Table><TableHeader><TableRow><TableHead>商品</TableHead><TableHead>目的地</TableHead><TableHead>类别</TableHead><TableHead className="hidden md:table-cell">提供商</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="font-medium text-slate-900">{item.title || item.offer_key || item.id}</div><div className="mt-1 text-[10px] text-slate-400">优先级 {item.priority} · {item.price_text || "暂无价格文案"}</div></TableCell><TableCell>{item.destination_slug}</TableCell><TableCell>{label(item.category)}</TableCell><TableCell className="hidden md:table-cell">{item.provider}</TableCell><TableCell><StatusPill status={item.active ? "active" : "inactive"} /><div className="mt-1 text-[10px] text-slate-400">{item.valid_until ? `有效至 ${formatDate(item.valid_until)}` : "未设置截止时间"}</div></TableCell></TableRow>)}</TableBody></Table></TableShell></>;
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
