import { useEffect, useMemo, useState } from "react";
import {
  Activity, CheckCircle2, ChevronDown, ChevronRight, Clock3, Database, ExternalLink, Gauge, MapPin, RefreshCw, RotateCcw, Webhook,
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

function SettingsView({ data, health, auth, onAction, onAuthRefresh, actionBusy }) {
  const [model, setModel] = useState(data?.id || "kimi-k3");
  const [visualModel, setVisualModel] = useState(data?.visual?.id || "vertex-gemini-3.1-flash-image");
  useEffect(() => setModel(data?.id || "kimi-k3"), [data?.id]);
  useEffect(() => setVisualModel(data?.visual?.id || "vertex-gemini-3.1-flash-image"), [data?.visual?.id]);
  const saveAi = () => onAction("/api/settings/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  }, `已切换到 ${data?.models?.find((item) => item.id === model)?.label || model}`);
  const saveVisual = () => onAction("/api/settings/visuals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: visualModel }),
  }, `已切换到 ${data?.visual?.models?.find((item) => item.id === visualModel)?.label || visualModel}`);
  return <div className="grid gap-3 sm:gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(16rem,.72fr)]">
    <Card className="p-4 sm:p-5"><div className="flex items-start justify-between gap-4"><div><div className="text-sm font-semibold text-slate-900">图文处理与写作模型</div><p className="mt-1 text-xs leading-relaxed text-slate-500">用于来源读取、图片识别、事实整理、内容规划、英文写作与质量审核。每次输出都会记录实际模型。</p></div><StatusPill status={data?.configured ? "configured" : "needs_ai"} /></div>
      <div className="mt-4 space-y-2 sm:mt-5">{(data?.models || []).map((item) => <label key={item.id} className={cn("flex cursor-pointer gap-3 rounded-xl border p-3 transition", model === item.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300")}><input className="mt-1 accent-slate-900" type="radio" name="ai-model" value={item.id} checked={model === item.id} onChange={() => setModel(item.id)} /><span><span className="block text-xs font-semibold text-slate-900">{item.label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{item.description}</span><span className="mt-1 block text-[10px] text-emerald-600">支持图文多模态输入{item.preview ? " · 预览版" : ""}</span></span></label>)}</div>
      <div className="mt-4 flex flex-wrap items-center gap-2.5 sm:mt-5 sm:gap-3"><Button size="sm" disabled={actionBusy || !data?.configured || model === data?.id} onClick={saveAi}><CheckCircle2 /> 保存图文模型</Button><span className="text-[11px] text-slate-400">来源：{data?.source === "dashboard" ? "后台设置" : "环境配置"}</span></div>
    </Card>
    <Card className="p-4 sm:p-5"><div className="flex items-start justify-between gap-4"><div><div className="text-sm font-semibold text-slate-900">内容配图策略与生图模型</div><p className="mt-1 text-xs leading-relaxed text-slate-500">已授权的人工筛选来源实景图会优先用于文章；此模型只补足无法由真实素材覆盖的原创、非事实性插画。</p></div><StatusPill status={data?.visual?.supportsGeneration && data?.visualGenerationConfigured ? "ready" : "pending"} /></div>
      <div className="mt-4 space-y-2 sm:mt-5">{(data?.visual?.models || []).map((item) => <label key={item.id} className={cn("flex gap-3 rounded-xl border p-3 transition", item.supportsGeneration ? "cursor-pointer" : "cursor-not-allowed opacity-65", visualModel === item.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300")}><input className="mt-1 accent-slate-900" type="radio" name="visual-model" value={item.id} checked={visualModel === item.id} disabled={!item.supportsGeneration} onChange={() => setVisualModel(item.id)} /><span><span className="block text-xs font-semibold text-slate-900">{item.label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{item.description}</span><span className={cn("mt-1 block text-[10px]", item.supportsGeneration ? "text-emerald-600" : "text-amber-600")}>{item.supportsGeneration ? "可生成原创插画" : "仅图文理解；当前 API 不支持图片输出"}</span></span></label>)}</div>
      <div className="mt-4 flex flex-wrap items-center gap-2.5 sm:mt-5 sm:gap-3"><Button size="sm" disabled={actionBusy || !data?.visual?.supportsGeneration || visualModel === data?.visual?.id} onClick={saveVisual}><CheckCircle2 /> 保存生图模型</Button><span className="text-[11px] text-slate-400">默认：Gemini 3.1 Flash Image</span></div>
    </Card>
    <Card className="p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">系统与数据存储</div><p className="mt-1 text-xs leading-relaxed text-slate-500">模型密钥只保留在服务器环境中；研究来源、Claims、知识库和草稿使用持久化数据库保存。</p></div><span className="grid size-8 place-items-center rounded-lg bg-sky-50 text-sky-700"><Database className="size-4" /></span></div><div className="mt-4 space-y-3 text-xs text-slate-600"><div className="flex items-center justify-between gap-3"><span>当前部署</span><span className="font-medium text-slate-900">{data?.storage?.label || "正在识别"}</span></div><div className="flex items-center justify-between gap-3"><span>跨设备访问</span><span className="font-medium text-slate-900">{data?.storage?.crossDevice ? "支持：登录同一后台即可" : "当前仅本机"}</span></div><div className="flex items-center justify-between gap-3"><span>应用版本</span><span className="font-medium text-slate-900">{data?.appVersion || health?.version || "—"}</span></div><div className="flex items-center justify-between gap-3"><span>内容策略</span><span className="font-medium text-slate-900">v{data?.contentStrategy?.version || health?.contentStrategy?.version || "—"}</span></div><div className="flex items-center justify-between gap-3"><span>SEO / GEO 结构化包</span><StatusPill status="ready" /></div><div className="flex items-center justify-between gap-3"><span>云端生图服务</span><StatusPill status={health?.visualGenerationConfigured ? "ready" : "pending"} /></div></div><p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-400 sm:mt-5">{data?.storage?.description || "数据库状态将在服务启动后显示。"}</p></Card>
    <CredentialSettingsCard auth={auth} onAction={onAction} onAuthRefresh={onAuthRefresh} actionBusy={actionBusy} />
    <FrontendContractSettingsCard contract={data?.frontendContract} onAction={onAction} actionBusy={actionBusy} />
  </div>;
}

function FrontendContractSettingsCard({ contract, onAction, actionBusy }) {
  const configured = Boolean(contract?.configured);
  const ready = Boolean(contract?.canCompose);
  const stateLabel = {
    unconfigured: "尚未配置来源", syncing: "正在同步", healthy: "已验证", stale: "使用最近有效缓存", major_mismatch: "需要确认重大版本", invalid: "无有效契约",
  }[contract?.status] || "等待状态";
  const sync = () => onAction("/api/frontend-contract/sync", { method: "POST" }, "已加入前端能力契约同步队列。");
  return <Card className="p-4 sm:p-5 xl:col-span-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">Frontend Capability Contract</div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">前端发布可渲染组件与页面 Schema；CMS 只选择组件、变体和顺序，并在生成与发布前校验。这里显示当前已同步的能力，不会扫描或猜测前端代码。</p></div><StatusPill status={ready ? "ready" : contract?.status === "major_mismatch" || contract?.status === "invalid" ? "exception" : "pending"} /></div>
    <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4"><ContractSetting label="同步状态" value={stateLabel} /><ContractSetting label="契约版本" value={contract?.active?.contractVersion ? `v${contract.active.contractVersion}` : "—"} /><ContractSetting label="页面 Schema" value={contract?.active?.schemaVersion ? `v${contract.active.schemaVersion}` : "—"} /><ContractSetting label="可用组件" value={contract?.active ? `${contract.stableComponents || 0} 个稳定 / ${contract.availableComponents || 0} 个总计` : "暂无"} /></div>
    <div className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 text-[11px] text-slate-500 sm:grid-cols-2"><div><span className="text-slate-400">来源仓库：</span><span className="break-all text-slate-700">{contract?.sourceRepository || "未配置"}</span></div><div><span className="text-slate-400">最近成功同步：</span><span className="text-slate-700">{contract?.lastSuccessAt ? formatDate(contract.lastSuccessAt) : "尚无"}</span></div>{contract?.lastError && <div className="sm:col-span-2"><span className="text-amber-700">最近错误：</span>{contract.lastError}</div>}</div>
    <div className="mt-4 flex flex-wrap items-center gap-3"><Button size="sm" variant="outline" disabled={actionBusy || !configured} onClick={sync}><RefreshCw /> 同步前端 Contract</Button><span className="text-[11px] text-slate-400">{configured ? "同步失败时仅可使用最近一次通过验证的缓存；重大版本需通过诊断 API 显式确认后才会恢复生产。" : "请在服务器环境中配置 Component Registry 与 Page Schema 的发布地址。"}</span></div>
  </Card>;
}

function ContractSetting({ label: title, value }) {
  return <div className="rounded-lg border border-slate-100 bg-white px-3 py-2"><div className="text-[10px] text-slate-400">{title}</div><div className="mt-0.5 font-medium text-slate-800">{value}</div></div>;
}

function CredentialSettingsCard({ auth, onAction, onAuthRefresh, actionBusy }) {
  const [username, setUsername] = useState(auth?.username || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setUsername(auth?.username || ""), [auth?.username]);
  const passwordMismatch = Boolean(nextPassword || confirmation) && nextPassword !== confirmation;
  const noChanges = username === (auth?.username || "") && !nextPassword;
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (passwordMismatch) return setError("两次输入的新密码不一致。");
    if (nextPassword && nextPassword.length < 8) return setError("新密码至少需要 8 个字符。");
    const succeeded = await onAction("/api/auth/update-credentials", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, nextUsername: username, nextPassword }),
    }, "管理员账号与密码已更新。");
    if (succeeded) {
      setCurrentPassword(""); setNextPassword(""); setConfirmation("");
      await onAuthRefresh?.();
    }
  };
  if (!auth?.enabled) return <Card className="p-4 sm:p-5 xl:col-span-3"><div className="text-sm font-semibold text-slate-900">管理员账号与密码</div><p className="mt-1 text-xs leading-relaxed text-amber-700">当前本机服务未启用账号密码登录；部署到云端时必须在服务器环境中设置管理员密码和会话密钥。</p></Card>;
  return <Card className="p-4 sm:p-5 xl:col-span-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">管理员账号与密码</div><p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">当前登录账号：<b className="text-slate-700">{auth.username}</b>。修改时必须验证当前密码；新密码可留空，以便只变更账号名称。</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-600">安全设置</span></div><form className="mt-4 grid gap-3 sm:mt-5 md:grid-cols-2 xl:grid-cols-4" onSubmit={submit}><CredentialField label="管理员账号" value={username} onChange={setUsername} autoComplete="username" minLength={3} maxLength={64} /><CredentialField label="当前密码" value={currentPassword} onChange={setCurrentPassword} type="password" autoComplete="current-password" /><CredentialField label="新密码（可留空）" value={nextPassword} onChange={setNextPassword} type="password" autoComplete="new-password" minLength={8} /><CredentialField label="确认新密码" value={confirmation} onChange={setConfirmation} type="password" autoComplete="new-password" />{error && <p className="text-xs text-rose-600 md:col-span-2 xl:col-span-4">{error}</p>}<div className="flex flex-wrap items-center gap-3 md:col-span-2 xl:col-span-4"><Button disabled={actionBusy || !currentPassword || noChanges || passwordMismatch}><CheckCircle2 /> 保存管理员凭据</Button><span className="text-[11px] text-slate-400">账号更名后会继续保持当前登录；请使用新账号登录其他设备。</span></div></form></Card>;
}

function CredentialField({ label: title, type = "text", value, onChange, autoComplete, ...props }) {
  return <label className="block min-w-0"><span className="mb-1.5 block text-[11px] font-medium text-slate-600">{title}</span><input className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-300 focus:border-slate-400 focus:ring-4 focus:ring-slate-100" type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} required={title === "管理员账号" || title === "当前密码"} {...props} /></label>;
}

function SourcesView({ data, onGuide, onOpenSource }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="source" title="尚无来源" description="在电脑端打开一篇小红书笔记，然后点击 Chrome 扩展中的“保存当前笔记”。" action={() => onGuide("capture")} actionLabel="查看采集说明" />;
  return (
    <><SummaryBar title="处理状态说明"><span><b>处理中：</b>笔记已安全保存，系统正在进行多模态提取、结构化来源、Claims 和内容蓝图。</span><span><b>提取完成：</b>结构化研究已可用，并不代表文章已生成。</span><span><b>需要处理：</b>打开来源查看原因后可重新执行提取。</span></SummaryBar><section className="space-y-2.5 md:hidden" aria-label="研究来源列表">{items.map((item) => <button key={item.id} type="button" onClick={() => onOpenSource(item.id)} className="block w-full rounded-2xl border border-slate-200/80 bg-white p-4 text-left shadow-sm transition active:scale-[0.99] focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-200"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="line-clamp-2 text-[15px] font-semibold leading-relaxed text-slate-900">{item.title || "未命名笔记"}</h2><p className="mt-1.5 text-[11px] text-slate-400">{item.author_name || "未知作者"}{item.external_id ? ` · XHS ID ${item.external_id}` : ""} · v{item.capture_version}</p></div><StatusPill status={item.status} /></div><div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-500"><span>{item.destination_name || "目的地识别中"}</span><span className="font-medium tabular-nums text-slate-700">{item.claim_count} 条 Claims</span></div><p className="mt-2 text-[10px] text-slate-400">点击查看来源详情与提取结果</p></button>)}</section><div className="hidden md:block"><TableShell><Table><TableHeader><TableRow><TableHead>来源</TableHead><TableHead>状态</TableHead><TableHead className="hidden md:table-cell">目的地</TableHead><TableHead>Claims</TableHead><TableHead className="hidden lg:table-cell">采集时间</TableHead></TableRow></TableHeader>
      <TableBody>{items.map((item) => <TableRow key={item.id} tabIndex={0} role="button" className="cursor-pointer focus-visible:bg-slate-50 focus-visible:outline-none" onClick={() => onOpenSource(item.id)} onKeyDown={(event) => event.key === "Enter" && onOpenSource(item.id)}>
        <TableCell><div className="max-w-md font-medium text-slate-900">{item.title || "未命名笔记"}</div><div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-slate-400"><span>{item.author_name || "未知作者"}</span>{item.external_id && <><span>·</span><span className="font-mono text-[10px] text-slate-500">XHS ID {item.external_id}</span></>}<span>· v{item.capture_version}</span></div></TableCell>
        <TableCell><StatusPill status={item.status} /></TableCell><TableCell className="hidden md:table-cell">{item.destination_name || "—"}</TableCell><TableCell className="tabular-nums">{item.claim_count}</TableCell><TableCell className="hidden whitespace-nowrap lg:table-cell">{formatDate(item.captured_at)}</TableCell>
      </TableRow>)}</TableBody></Table></TableShell></div></>
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
    <section className="space-y-3 lg:hidden">{items.map((item) => <Card key={item.id} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold leading-relaxed text-slate-900">{item.source_title || item.primary_topic}</h2><div className="mt-1 flex flex-wrap gap-1.5"><StatusPill status={item.classification} /><span className="text-[10px] text-slate-400">策略 v{item.strategy_version}</span></div></div><span className="shrink-0 text-xs font-semibold tabular-nums text-slate-600">{Math.round(item.article_potential)}<small className="ml-0.5 font-normal text-slate-400">/100</small></span></div><RecommendationConclusion item={item} />{item.suggested_article_title && item.classification === "ARTICLE_CANDIDATE" && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-700">建议文章：{item.suggested_article_title}</p>}<details className="mt-3 text-[11px] text-slate-500"><summary className="cursor-pointer select-none font-medium text-slate-600">查看质量信号与模型依据</summary><p className="mt-2 leading-relaxed">信息密度 {Math.round(item.information_density)} · 完整度 {Math.round(item.topic_completeness)} · 可信度 {Math.round(item.confidence * 100)}%</p><p className="mt-2 leading-relaxed text-slate-400">{item.reasoning_summary || "暂无原始说明"}</p></details><div className="mt-4"><RecommendationDecision item={item} decide={decide} actionBusy={actionBusy} mobile /></div></Card>)}</section>
    <div className="hidden lg:block"><TableShell><Table><TableHeader><TableRow><TableHead>来源与系统结论</TableHead><TableHead className="hidden md:table-cell">质量信号</TableHead><TableHead className="hidden lg:table-cell">需要补齐的证据</TableHead><TableHead>你的决定</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="max-w-md font-medium text-slate-900">{item.source_title || item.primary_topic}</div><div className="mt-1 flex flex-wrap gap-1.5"><StatusPill status={item.classification} /><span className="text-[10px] text-slate-400">策略 v{item.strategy_version}</span></div><RecommendationConclusion item={item} />{item.suggested_article_title && item.classification === "ARTICLE_CANDIDATE" && <p className="mt-2 text-[11px] font-medium text-slate-700">建议文章标题：{item.suggested_article_title}</p>}<details className="mt-2 max-w-xl text-[10px] text-slate-400"><summary className="cursor-pointer select-none hover:text-slate-600">查看模型原始分析依据</summary><p className="mt-1 leading-relaxed">{item.reasoning_summary || "暂无原始说明"}</p></details></TableCell><TableCell className="hidden md:table-cell"><div className="text-xs font-medium text-slate-700">文章潜力 {Math.round(item.article_potential)} / 100</div><div className="mt-1 text-[10px] leading-relaxed text-slate-400">信息密度 {Math.round(item.information_density)} · 完整度 {Math.round(item.topic_completeness)} · 可信度 {Math.round(item.confidence * 100)}%</div></TableCell><TableCell className="hidden max-w-sm lg:table-cell"><RecommendationEvidenceNeed item={item} /></TableCell><TableCell><RecommendationDecision item={item} decide={decide} actionBusy={actionBusy} /></TableCell></TableRow>)}</TableBody></Table></TableShell></div>
  </div>;
}

function RecommendationDecision({ item, decide, actionBusy, mobile = false }) {
  if (item.decision !== "pending") return <><StatusPill status={item.decision} /><div className="mt-1 text-[10px] text-slate-400">{item.approved_candidate_id ? "内容规划已排队" : "决定已记录"}</div></>;
  const primary = recommendationNextAction(item);
  const alternatives = Object.values(recommendationActions).filter((action) => action.decision !== primary.decision);
  const submit = (action) => decide(item.id, action.decision, action.message);
  return <div className={cn("space-y-2", mobile ? "w-full" : "max-w-48")}>
    <div className="rounded-xl border border-slate-900 bg-slate-900 p-2 shadow-sm"><p className="px-1 text-[10px] font-medium text-slate-300">推荐下一步</p><Button size="sm" className="mt-1 h-8 w-full bg-white px-2 text-[10px] text-slate-950 hover:bg-slate-100" disabled={actionBusy} onClick={() => submit(primary)}><CheckCircle2 className="size-3.5" />推荐：{primary.label}</Button><p className="mt-1.5 px-1 text-[10px] leading-relaxed text-slate-300">{primary.help}</p></div>
    <details className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[10px] text-slate-500"><summary className="cursor-pointer select-none font-medium text-slate-600">其他处理方式</summary><div className={cn("mt-2 gap-1.5", mobile ? "grid grid-cols-2" : "flex flex-wrap")}>{alternatives.map((action) => <Button key={action.decision} variant={action.decision === "ignored" ? "ghost" : "secondary"} size="sm" className={cn("h-8 px-2 text-[10px]", mobile && "w-full")} disabled={actionBusy} onClick={() => submit(action)}>{action.label}</Button>)}</div></details>
  </div>;
}

const recommendationActions = {
  approved_article: { decision: "approved_article", label: "批准文章", message: "已批准文章候选；证据就绪后将开始规划。", help: "建立内容规划队列；后续仍会经过事实、质量和发布前审核。" },
  knowledge_only: { decision: "knowledge_only", label: "仅入知识库", message: "已标记为仅进入知识库", help: "保留来源、Claims 和知识事实，用作未来选题的可追溯证据。" },
  cluster: { decision: "cluster", label: "归入专题", message: "已加入专题机会", help: "将它与相同目的地或主题的来源汇总，等证据更完整后再规划。" },
  research_first: { decision: "research_first", label: "补充研究", message: "已标记为优先补充研究", help: "优先补足官方入口、票价、开放时间、证件和交通等时效信息。" },
  ignored: { decision: "ignored", label: "忽略", message: "已忽略此建议", help: "不进入内容规划；原始来源仍保留，便于日后回看。" },
};

function recommendationNextAction(item) {
  const classification = String(item?.classification || "UNSURE").toUpperCase();
  const recommended = {
    ARTICLE_CANDIDATE: "approved_article",
    KNOWLEDGE_ONLY: "knowledge_only",
    CLAIM_ONLY: "knowledge_only",
    CLUSTER_CANDIDATE: "cluster",
    RESEARCH_REQUIRED: "research_first",
    DUPLICATE: "knowledge_only",
    LOW_VALUE: "ignored",
    UNSURE: "research_first",
  }[classification] || "research_first";
  return recommendationActions[recommended];
}

function RecommendationConclusion({ item }) {
  const guidance = recommendationGuidance(item);
  const tones = {
    emerald: "border-emerald-200/80 bg-emerald-50/70 text-emerald-950",
    amber: "border-amber-200/80 bg-amber-50/70 text-amber-950",
    blue: "border-blue-200/80 bg-blue-50/70 text-blue-950",
    slate: "border-slate-200/80 bg-slate-50 text-slate-900",
  };
  return <div className={cn("mt-3 max-w-xl rounded-xl border px-3 py-2.5 shadow-sm", tones[guidance.tone])}><div className="text-[10px] font-semibold uppercase tracking-[0.12em] opacity-65">系统建议结论</div><p className="mt-1 text-xs font-semibold leading-relaxed">{guidance.conclusion}</p><p className="mt-1 text-[11px] leading-relaxed opacity-85">{guidance.reason}</p><div className="mt-2 border-t border-current/10 pt-2 text-[10px] leading-relaxed opacity-80"><b>下一步：</b>{guidance.next}<br /><b>不会影响：</b>{guidance.impact}</div></div>;
}

function RecommendationEvidenceNeed({ item }) {
  const guidance = recommendationGuidance(item);
  const values = [...(item.missing_information || []), ...(item.possible_cluster_topics || [])].filter(Boolean);
  return <div className="text-[11px] leading-relaxed text-slate-600"><p className="font-medium text-slate-700">{guidance.evidenceNeed}</p>{values.length > 0 && <details className="mt-1 text-[10px] text-slate-400"><summary className="cursor-pointer select-none hover:text-slate-600">查看模型列出的原始项</summary><p className="mt-1">{values.join(" · ")}</p></details>}</div>;
}

function recommendationGuidance(item) {
  const type = String(item?.classification || "UNSURE").toUpperCase();
  const map = {
    DUPLICATE: { tone: "amber", conclusion: "不新建文章；作为已有主题的补充佐证。", reason: "系统发现该笔记与已采集的目的地攻略在景点、预约或行程提醒上高度重叠，新增的独立信息不足以支撑另一篇文章。", next: "优先点击“仅入知识库”；只有发现明确的新事实或官方链接时，再归入专题或补充研究。", impact: "来源、已提取的 Claims 和知识事实仍会保留，用来增强已有主题的证据。", evidenceNeed: "不需要补齐整篇文章；如要提升价值，只补充与已有资料不同、可核验的新事实。" },
    ARTICLE_CANDIDATE: { tone: "emerald", conclusion: "可作为新文章候选，但尚未自动发布。", reason: "这篇来源呈现了相对清晰的旅行问题和可写角度，当前信号显示具备独立内容潜力。", next: "核对右侧缺失信息后点击“批准文章”；满足证据门槛时系统才会创建内容规划。", impact: "批准仅进入规划队列，英文草稿和 WordPress 投递仍会经过质量审核。", evidenceNeed: "优先补齐高时效或影响游客决策的事实，例如预约、票价、开放时间和外籍游客规则。" },
    RESEARCH_REQUIRED: { tone: "amber", conclusion: "暂不写文章；先补充官方或第二来源验证。", reason: "当前来源有价值，但关键旅行决策信息的证据不完整或时效性较高，直接成文容易误导游客。", next: "点击“补充研究”，随后保存官方页面或另一篇能交叉验证的高质量来源。", impact: "现有 Claims 和知识事实会继续入库，只是不会进入可发布内容队列。", evidenceNeed: "优先核验预约、票价、开放时间、证件要求、交通和取消规则。" },
    KNOWLEDGE_ONLY: { tone: "blue", conclusion: "沉淀为知识事实，不单独规划文章。", reason: "内容对目的地知识有帮助，但它更适合作为文章中的一个事实或提醒，而不是独立选题。", next: "点击“仅入知识库”；后续系统会在匹配的文章规划中引用它。", impact: "不会丢弃该来源；它可与后续来源合并，未来也可能形成更完整主题。", evidenceNeed: "继续收集同一景点或同一旅行问题的互补事实，尤其是官方或第二来源。" },
    CLAIM_ONLY: { tone: "blue", conclusion: "保留为单条可追溯信息，不创建新选题。", reason: "该来源提供的是一个较小的信息点，尚不足以构成完整旅行指南。", next: "选择“仅入知识库”，并在保存后续相关来源时让系统自动聚合。", impact: "单条事实仍能被未来的文章作为证据使用。", evidenceNeed: "补充同一主题的背景、路线、费用、规则或实操信息。" },
    CLUSTER_CANDIDATE: { tone: "blue", conclusion: "归入现有专题，等待更多互补来源后统一策划。", reason: "它与已有主题相关，但目前更适合参与一个更完整的目的地专题。", next: "点击“归入专题”，继续积累同一主题的不同视角和可验证事实。", impact: "不会生成重复文章；现有知识会保留在专题的证据池中。", evidenceNeed: "补齐专题覆盖面，避免来源都重复描述同一个景点或同一个提醒。" },
    LOW_VALUE: { tone: "slate", conclusion: "暂不进入内容规划；保留来源记录即可。", reason: "信息密度、独特性或可验证性不足，当前不值得投入额外写作成本。", next: "可选择“忽略”或“仅入知识库”；除非后续出现可交叉验证的新价值。", impact: "不会删除原始来源，仍可回看和重新提取。", evidenceNeed: "需要更具体、可执行且能被验证的旅行信息。" },
    UNSURE: { tone: "slate", conclusion: "需要人工确认下一步。", reason: "系统无法可靠判断它应独立成文、归入专题还是仅作为知识事实。", next: "优先查看原始来源与模型依据，再选择“仅入知识库”或“补充研究”。", impact: "未决定前，系统不会自动发布或删除任何内容。", evidenceNeed: "需要更清楚的目的地、事实类型或交叉来源。" },
  };
  return map[type] || map.UNSURE;
}

function KnowledgeView({ data, onNavigate }) {
  const items = data?.items || [];
  const [activeTheme, setActiveTheme] = useState("all");
  const [activeSubject, setActiveSubject] = useState("all");
  const [cityExpanded, setCityExpanded] = useState(true);
  const overview = useMemo(() => buildKnowledgeOverview(items), [items]);
  const themeSubjects = activeTheme === "all"
    ? overview.subjects
    : overview.subjects.filter((subject) => subject.facts.some((fact) => knowledgeTheme(fact).id === activeTheme));
  const visibleSubjects = activeSubject === "all" ? themeSubjects : themeSubjects.filter((subject) => subject.key === activeSubject);
  const selectTheme = (theme) => { setActiveTheme(theme); setActiveSubject("all"); };

  if (!items.length) return <EmptyState icon="knowledge" title="知识库正在建立" description="已保存来源完成信息主张提取后，经过结构化整理的事实会显示在这里。" action={() => onNavigate("sources")} actionLabel="查看研究来源" />;
  return <div className="space-y-4">
    <SummaryBar title="知识库如何参与创作"><span>系统先将来源拆成可验证事实，再按目的地、景点和主题关联；不会把笔记直接翻译成文章。</span><span>只有满足独立证据门槛的主题才会进入“内容”候选。</span></SummaryBar>
    <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="overflow-hidden p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] font-medium uppercase tracking-[0.14em] text-cyan-700">Destination knowledge map</p><h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">{overview.destinationLabel} · 可用研究地图</h2><p className="mt-1 text-xs leading-relaxed text-slate-500">先从城市目录进入景点或主题，再查看对应事实；避免把少量笔记拆出的信息点一次性铺满页面。</p></div><span className="rounded-full border border-cyan-100 bg-cyan-50 px-3 py-1 text-[11px] font-semibold text-cyan-700">{overview.subjects.length} 个地点 / 实体</span></div>
        <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{overview.themes.map((theme) => <button key={theme.id} type="button" onClick={() => selectTheme(activeTheme === theme.id ? "all" : theme.id)} className={cn("rounded-xl border p-3 text-left transition", activeTheme === theme.id ? "border-slate-900 bg-slate-900 text-white shadow-sm" : "border-slate-200/80 bg-white hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm")}><div className={cn("text-[11px] font-semibold", activeTheme === theme.id ? "text-white" : "text-slate-800")}>{theme.label}</div><div className={cn("mt-1 text-xl font-semibold tracking-tight tabular-nums", activeTheme === theme.id ? "text-white" : "text-slate-900")}>{theme.count}</div><div className={cn("mt-0.5 text-[10px]", activeTheme === theme.id ? "text-slate-300" : "text-slate-400")}>{theme.help}</div></button>)}</div>
      </Card>
      <Card className="p-5"><p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">Evidence health</p><div className="mt-3 space-y-3"><KnowledgeStat label="独立来源" value={overview.sourceCount} hint="用于判定是否可形成内容候选" tone="emerald" /><KnowledgeStat label="需官方核验" value={overview.officialCheckCount} hint="预约、票价、规则等高时效事实" tone="amber" /><KnowledgeStat label="存在冲突" value={overview.conflictCount} hint="系统会阻止未经处理的冲突进入正文" tone={overview.conflictCount ? "rose" : "slate"} /></div><p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">当前只有 {overview.sourceCount} 个独立来源，因此本批事实会入库，但不会自动形成可发布文章。</p></Card>
    </section>
    <section className="flex flex-wrap items-center gap-2"><span className="mr-1 text-xs font-semibold text-slate-700">查看主题：</span><Button type="button" variant={activeTheme === "all" ? "default" : "secondary"} size="sm" className="h-8" onClick={() => selectTheme("all")}>全部事实</Button>{overview.themes.map((theme) => <Button key={theme.id} type="button" variant={activeTheme === theme.id ? "default" : "secondary"} size="sm" className="h-8" onClick={() => selectTheme(theme.id)}>{theme.label} {theme.count}</Button>)}</section>
    <section className="grid gap-3 xl:grid-cols-[17rem_minmax(0,1fr)]"><KnowledgeDirectory overview={overview} activeSubject={activeSubject} expanded={cityExpanded} onToggle={() => setCityExpanded((value) => !value)} onSelect={setActiveSubject} /><div><div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-semibold text-slate-800">{activeSubject === "all" ? "景点与主题索引" : visibleSubjects[0]?.name || "景点事实"}</p><p className="mt-0.5 text-[11px] text-slate-400">{activeSubject === "all" ? "先从左侧目录选择一个景点；此处默认不展开全部事实。" : `正在查看 ${visibleSubjects[0]?.facts.length || 0} 条关联事实。`}</p></div>{activeSubject !== "all" && <Button type="button" variant="secondary" size="sm" className="h-8" onClick={() => setActiveSubject("all")}>返回索引</Button>}</div><section className="grid gap-3 md:grid-cols-2">{visibleSubjects.map((subject) => <KnowledgeSubjectCard key={subject.key} subject={subject} activeTheme={activeTheme} compact={activeSubject === "all"} onSelect={() => setActiveSubject(subject.key)} />)}</section></div></section>
    {activeTheme !== "all" && !visibleSubjects.length && <EmptyState icon="knowledge" title="该主题暂时没有事实" description="继续保存相关来源后，系统会自动归纳并纳入此主题。" />}
  </div>;
}

function KnowledgeStat({ label: title, value, hint, tone }) {
  const styles = { emerald: "border-emerald-100 bg-emerald-50 text-emerald-700", amber: "border-amber-100 bg-amber-50 text-amber-700", rose: "border-rose-100 bg-rose-50 text-rose-700", slate: "border-slate-100 bg-slate-50 text-slate-700" };
  return <div className={cn("rounded-xl border px-3 py-2.5", styles[tone])}><div className="flex items-baseline justify-between gap-3"><span className="text-[11px] font-medium">{title}</span><strong className="text-lg font-semibold tabular-nums">{value}</strong></div><p className="mt-0.5 text-[10px] opacity-75">{hint}</p></div>;
}

function KnowledgeDirectory({ overview, activeSubject, expanded, onToggle, onSelect }) {
  return <Card className="h-max overflow-hidden p-2.5"><button type="button" onClick={onToggle} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-slate-50"><span className="grid size-7 place-items-center rounded-lg bg-cyan-50 text-cyan-700"><MapPin className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-slate-900">{overview.destinationLabel}</span><span className="block text-[10px] text-slate-400">目的地目录 · {overview.subjects.length} 个地点</span></span>{expanded ? <ChevronDown className="size-4 text-slate-400" /> : <ChevronRight className="size-4 text-slate-400" />}</button>{expanded && <div className="mt-1 border-t border-slate-100 pt-1.5"><button type="button" onClick={() => onSelect("all")} className={cn("flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[11px] transition", activeSubject === "all" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50")}><span>全部景点与主题</span><span className={cn("rounded-md px-1.5 py-0.5 text-[10px]", activeSubject === "all" ? "bg-white/15 text-white" : "bg-slate-100 text-slate-500")}>{overview.factCount}</span></button><p className="px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">景点与场所</p><div className="max-h-[27rem] space-y-0.5 overflow-y-auto pr-0.5">{overview.subjects.map((subject) => <button key={subject.key} type="button" onClick={() => onSelect(subject.key)} className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[11px] transition", activeSubject === subject.key ? "bg-cyan-50 font-medium text-cyan-800" : "text-slate-600 hover:bg-slate-50")}><span className="truncate">{subject.name}</span><span className="shrink-0 text-[10px] text-slate-400">{subject.facts.length}</span></button>)}</div></div>}</Card>;
}

function KnowledgeSubjectCard({ subject, activeTheme, compact = false, onSelect }) {
  const facts = activeTheme === "all" ? subject.facts : subject.facts.filter((fact) => knowledgeTheme(fact).id === activeTheme);
  const sourceCount = new Set(facts.flatMap((fact) => Array.isArray(fact.evidence) ? fact.evidence.map((evidence) => evidence?.source_id).filter(Boolean) : [])).size;
  const officialChecks = facts.filter((fact) => fact.verification_priority === "requires_official").length;
  if (compact) return <Card className="overflow-hidden p-0"><button type="button" onClick={onSelect} className="w-full p-4 text-left transition hover:bg-slate-50"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-900">{subject.name}</h3><p className="mt-1 text-[10px] text-slate-400">{facts.length} 条事实 · {sourceCount} 个独立来源{officialChecks ? ` · ${officialChecks} 项待核验` : ""}</p></div><ChevronRight className="mt-0.5 size-4 shrink-0 text-slate-400" /></div><p className="mt-3 text-[11px] text-slate-500">点击查看此景点的结构化事实与核验状态</p></button></Card>;
  return <Card className="overflow-hidden p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-900">{subject.name}</h3><p className="mt-1 text-[10px] text-slate-400">{facts.length} 条事实 · {sourceCount} 个独立来源{officialChecks ? ` · ${officialChecks} 项待核验` : ""}</p></div><StatusPill status={sourceCount >= 2 ? "corroborated" : "single_source"} /></div><div className="mt-4 space-y-2.5">{facts.slice(0, 4).map((fact) => <div key={fact.id} className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2"><div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-medium text-slate-700">{knowledgeTheme(fact).label}</span><span className={cn("shrink-0 text-[10px]", fact.verification_priority === "requires_official" ? "text-amber-600" : "text-slate-400")}>{fact.verification_priority === "requires_official" ? "待官方核验" : "当前记录"}</span></div><p className="mt-1 text-xs leading-relaxed text-slate-900">{fact.preferred_value || "尚无结论"}</p></div>)}</div>{facts.length > 4 && <p className="mt-3 text-[11px] text-slate-400">还有 {facts.length - 4} 条关联事实已折叠</p>}</Card>;
}

function buildKnowledgeOverview(items) {
  const destinations = [...new Set(items.map((item) => item.destination_name).filter(Boolean))];
  const subjectMap = new Map();
  const themes = knowledgeThemes().map((theme) => ({ ...theme, count: 0 }));
  const sourceIds = new Set();
  let officialCheckCount = 0;
  let conflictCount = 0;
  for (const fact of items) {
    const key = String(fact.subject || "未归类地点").trim().toLowerCase();
    if (!subjectMap.has(key)) subjectMap.set(key, { key, name: fact.subject || "未归类地点", facts: [] });
    subjectMap.get(key).facts.push(fact);
    const theme = knowledgeTheme(fact);
    const bucket = themes.find((item) => item.id === theme.id);
    if (bucket) bucket.count += 1;
    if (fact.verification_priority === "requires_official") officialCheckCount += 1;
    if (fact.consensus_status === "conflicted") conflictCount += 1;
    for (const evidence of Array.isArray(fact.evidence) ? fact.evidence : []) if (evidence?.source_id) sourceIds.add(evidence.source_id);
  }
  return {
    destinationLabel: destinations.join(" / ") || "目的地",
    subjects: [...subjectMap.values()].sort((a, b) => b.facts.length - a.facts.length || a.name.localeCompare(b.name)),
    themes,
    sourceCount: sourceIds.size,
    factCount: items.length,
    officialCheckCount,
    conflictCount,
  };
}

function knowledgeThemes() {
  return [
    { id: "reservation", label: "预约与入园", help: "预约、门票、入场规则", pattern: /reservation|book|ticket|admission|entry|passport|id.?card/i },
    { id: "timing", label: "时间与体验", help: "开放、夜游、最佳时段", pattern: /timing|opening|hour|afternoon|evening|night|lighting|blue.?hour/i },
    { id: "transport", label: "路线与交通", help: "地铁、步行、线路与顺序", pattern: /route|metro|transport|station|walk|district|area|sequence|duration/i },
    { id: "practical", label: "实用提醒", help: "费用、语言、限制与避坑", pattern: /price|cost|language|warning|restriction|queue|crowd|accessibility/i },
    { id: "other", label: "景点与其他", help: "尚待进一步归类的事实", pattern: /.*/i },
  ];
}

function knowledgeTheme(fact) {
  const input = `${fact.normalized_key || ""} ${fact.predicate || ""} ${fact.preferred_value || ""}`;
  return knowledgeThemes().find((theme) => theme.pattern.test(input)) || knowledgeThemes().at(-1);
}

function BlueprintsView({ data, onNavigate }) {
  const items = data?.items || [];
  if (!items.length) return <EmptyState icon="blueprint" title="暂无编辑蓝图" description="系统会从已提取来源中归纳可复用的选题角度、写作形式和章节结构。" action={() => onNavigate("sources")} actionLabel="查看研究来源" />;
  const reusable = items.filter((item) => !isPendingBlueprint(item));
  const pendingCount = items.length - reusable.length;
  if (!reusable.length) return <EmptyState icon="blueprint" title="蓝图正在等待归纳" description="来源已被安全保存；图文提取完成后，系统才会把稳定的写作模式加入这里。" action={() => onNavigate("sources")} actionLabel="查看研究来源" />;
  const sampleCount = reusable.reduce((total, item) => total + Number(item.sample_count || 0), 0);
  return <div className="space-y-3 sm:space-y-4"><SummaryBar title="编辑蓝图如何参与创作"><span>蓝图归纳的是“怎样组织信息更有帮助”，不会翻译或直接复用来源内容。</span><span>后续文章规划会参考其角度、形式和章节，但所有事实仍只取自知识库。</span>{pendingCount > 0 && <span className="text-amber-700">另有 {pendingCount} 条等待 AI 归纳，暂不计入写作模式。</span>}</SummaryBar><section className="grid gap-2.5 sm:grid-cols-3"><BlueprintStat label="可复用写作模式" value={reusable.length} hint="由已提取来源自动归纳" tone="blue" /><BlueprintStat label="支撑样本" value={sampleCount} hint="同类来源越多，模式越稳定" tone="violet" /><BlueprintStat label="当前用途" value="规划" hint="只提供结构参考，不直接成文" tone="emerald" /></section><section className="grid gap-3 lg:grid-cols-2">{reusable.map((item, index) => <BlueprintCard key={item.id} item={item} index={index} />)}</section></div>;
}

function isPendingBlueprint(item) {
  const format = String(item?.format || "").toLowerCase();
  const angle = String(item?.angle || "").toLowerCase();
  return [format, angle].some((value) => value.includes("pending-ai-analysis") || value === "unclassified" || value === "pending");
}

function BlueprintStat({ label: title, value, hint, tone }) {
  const styles = { blue: "border-blue-100 bg-blue-50/80 text-blue-700", violet: "border-violet-100 bg-violet-50/80 text-violet-700", emerald: "border-emerald-100 bg-emerald-50/80 text-emerald-700" };
  return <Card className={cn("p-3.5 shadow-sm", styles[tone])}><p className="text-[10px] font-semibold uppercase tracking-[0.12em] opacity-70">{title}</p><div className="mt-1.5 flex items-end gap-1.5"><strong className="text-2xl font-semibold tracking-tight text-slate-950 tabular-nums">{value}</strong>{typeof value === "number" && <span className="pb-1 text-[10px] font-medium text-slate-500">个</span>}</div><p className="mt-1 text-[10px] leading-relaxed text-slate-500">{hint}</p></Card>;
}

function BlueprintCard({ item, index }) {
  const sections = Array.isArray(item.section_patterns) ? item.section_patterns.map((entry) => entry?.value).filter(Boolean) : [];
  return <Card className="overflow-hidden p-4 shadow-sm sm:p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-600">写作模式 {String(index + 1).padStart(2, "0")}</p><h2 className="mt-1 text-sm font-semibold leading-relaxed text-slate-900">{item.format || "待归纳的写作形式"}</h2></div><span className="shrink-0 rounded-full border border-violet-100 bg-violet-50 px-2.5 py-1 text-[10px] font-semibold text-violet-700">{item.sample_count || 0} 个样本</span></div><section className="mt-4 rounded-xl border border-slate-100 bg-slate-50/80 p-3"><p className="text-[10px] font-semibold text-slate-500">可复用角度</p><p className="mt-1.5 text-xs leading-relaxed text-slate-800">{item.angle || "暂无角度说明"}</p></section><section className="mt-4"><div className="flex items-center justify-between gap-3"><h3 className="text-[11px] font-semibold text-slate-700">推荐章节顺序</h3><span className="text-[10px] text-slate-400">仅供规划参考</span></div>{sections.length ? <ol className="mt-2.5 space-y-2">{sections.slice(0, 6).map((section, sectionIndex) => <li key={`${item.id}-${sectionIndex}`} className="flex gap-2 rounded-lg border border-slate-100 px-2.5 py-2"><span className="grid size-4 shrink-0 place-items-center rounded-full bg-slate-100 text-[9px] font-semibold text-slate-500">{sectionIndex + 1}</span><span className="text-[11px] leading-relaxed text-slate-600">{section}</span></li>)}</ol> : <p className="mt-2.5 text-[11px] text-slate-400">系统尚未归纳出稳定的章节结构。</p>}</section><details className="mt-4 border-t border-slate-100 pt-3 text-[11px] text-slate-500"><summary className="cursor-pointer select-none font-medium text-slate-600">蓝图使用边界</summary><p className="mt-2 leading-relaxed">蓝图只影响内容规划的组织方式；不会把小红书表达翻译、复制到文章，也不会覆盖知识库中的证据与冲突规则。</p></details></Card>;
}

function ContentView({ data, onNavigate, onOpenDraft }) {
  const items = data?.items || [];
  const knowledgeOnly = (data?.opportunities || []).filter((item) => item.status === "knowledge_only");
  if (knowledgeOnly.length) return <ContentFlowWorkspace items={items} knowledgeOnly={knowledgeOnly} onNavigate={onNavigate} onOpenDraft={onOpenDraft} />;
  if (!items.length) return <EmptyState icon="content" title="暂无可生产的选题" description="当一个目的地具备足够的独立证据并通过建议页审批后，选题会自动出现在这里。" action={() => onNavigate("knowledge")} actionLabel="查看目的地知识" />;
  return <><SummaryBar title="内容生产说明"><span>这里管理已批准选题的规划、英文草稿、质量审核和 WordPress 草稿投递。</span><span>点击已有草稿的行可查看详情。</span></SummaryBar><TableShell><Table><TableHeader><TableRow><TableHead>选题</TableHead><TableHead>覆盖度</TableHead><TableHead className="hidden md:table-cell">证据</TableHead><TableHead>流程状态</TableHead><TableHead className="hidden lg:table-cell">质检 / WordPress</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id} tabIndex={item.draft_id ? 0 : undefined} role={item.draft_id ? "button" : undefined} className={cn(item.draft_id && "cursor-pointer")} onClick={() => item.draft_id && onOpenDraft(item.draft_id)} onKeyDown={(event) => event.key === "Enter" && item.draft_id && onOpenDraft(item.draft_id)}><TableCell><div className="max-w-md font-medium text-slate-900">{item.draft_title || item.proposed_title}</div><div className="mt-1 max-w-lg text-[11px] leading-relaxed text-slate-400">{item.rationale}</div>{item.suppression_reason && <div className="mt-1 text-[10px] font-medium text-amber-600">已抑制：{item.suppression_reason}</div>}</TableCell><TableCell className="font-medium tabular-nums">{Math.round(item.coverage_score)}%</TableCell><TableCell className="hidden md:table-cell">{item.evidence_count} 个来源 · {item.conflict_count} 项冲突<div className="mt-1 text-[10px] text-slate-400">{item.stale_fact_count || 0} 项过期 · {item.verification_fact_count || 0} 项待核验</div></TableCell><TableCell><StatusPill status={item.draft_status || item.brief_status || item.status} />{item.status === "candidate" && <div className="mt-1 text-[10px] text-slate-400">请先在“建议”中审批</div>}</TableCell><TableCell className="hidden lg:table-cell">{item.qa_score == null ? "—" : `${Math.round(item.qa_score)} · ${item.qa_passed ? "通过" : "未通过"}`}<div className="mt-1 text-[10px] text-slate-400">商品：{label(item.commercial_status || "pending")}（{item.commercial_offer_count || 0}）· WP：{label(item.wordpress_status || "not_synced")}</div></TableCell></TableRow>)}</TableBody></Table></TableShell></>;
}

function ContentFlowWorkspace({ items, knowledgeOnly, onNavigate, onOpenDraft }) {
  return <div className="space-y-3">
    <SummaryBar title="内容生产流程"><span>“仅入知识库”已完成：事实已沉淀，但不会创建候选文章或草稿。</span><span>需要新文章时，请在“建议”中批准文章或补充研究。</span></SummaryBar>
    <section className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(18rem,.85fr)]">
      <Card className="p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold text-slate-900">已入库，未进入内容生产</p><p className="mt-1 text-[11px] leading-relaxed text-slate-500">这些来源被保留为后续选题的佐证，不会自动写成文章，避免重复或证据不足的内容进入发布队列。</p></div><StatusPill status="knowledge_only" /></div><div className="mt-4 space-y-2.5">{knowledgeOnly.map((item) => <div key={item.source_id || item.id} className="rounded-xl border border-slate-100 bg-slate-50/80 p-3"><p className="text-xs font-semibold text-slate-900">{item.title || item.proposed_title || "已归档来源"}</p><p className="mt-1 text-[11px] leading-relaxed text-slate-500">{item.decision_summary || item.rationale || "系统已将该来源的可用事实写入知识库。"}</p><p className="mt-2 text-[10px] font-medium text-emerald-700">下一步：如需围绕该主题写文，请返回“建议”并选择“批准文章”。</p></div>)}</div><Button className="mt-4" size="sm" onClick={() => onNavigate("recommendations")}>查看建议与下一步</Button></Card>
      <Card className="p-4 sm:p-5"><p className="text-xs font-semibold text-slate-900">内容队列状态</p><div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/70 p-3"><strong className="text-2xl font-semibold tabular-nums text-slate-950">{items.length}</strong><span className="ml-1.5 text-xs font-medium text-slate-600">篇候选 / 草稿</span><p className="mt-1 text-[11px] leading-relaxed text-slate-500">候选文章只来自已被“批准文章”的建议；仅入知识库不会改变这个数字。</p></div><Button className="mt-4" variant="secondary" size="sm" onClick={() => onNavigate("knowledge")}>查看已沉淀的知识事实</Button></Card>
    </section>
    {items.length > 0 && <TableShell><Table><TableHeader><TableRow><TableHead>候选文章</TableHead><TableHead>覆盖度</TableHead><TableHead>流程状态</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id} role={item.draft_id ? "button" : undefined} tabIndex={item.draft_id ? 0 : undefined} className={cn(item.draft_id && "cursor-pointer")} onClick={() => item.draft_id && onOpenDraft(item.draft_id)} onKeyDown={(event) => event.key === "Enter" && item.draft_id && onOpenDraft(item.draft_id)}><TableCell><div className="font-medium text-slate-900">{item.draft_title || item.proposed_title}</div><p className="mt-1 text-[11px] text-slate-500">{item.rationale}</p></TableCell><TableCell className="font-medium tabular-nums">{Math.round(item.coverage_score || 0)}%</TableCell><TableCell><StatusPill status={item.draft_status || item.brief_status || item.status} /></TableCell></TableRow>)}</TableBody></Table></TableShell>}
  </div>;
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
  const providers = data?.providers || [];
  const opportunities = data?.opportunities || [];
  const performance = data?.performance || [];
  const commissionRules = data?.commissionRules || [];
  if (!items.length && !providers.length) return <><SummaryBar title="0 个联盟提供商"><span>没有 Asset 时 Commercial Overlay 严格 no-op，研究、知识和正文不会受影响。</span></SummaryBar><EmptyState icon="offer" title="暂无联盟资产" description="先配置 Trip.com MANUAL Provider，再保存官方生成的 Link 或结构化 Embed 配置；不要保存账号、密码、Cookie 或任意 HTML。" action={() => onGuide("commercial")} actionLabel="查看 Affiliate 配置说明" /></>;
  return <>
    <SummaryBar title={`${providers.length} 个提供商 · ${items.length} 个资产`}><span>{opportunities.length} 个高价值 Affiliate Opportunity</span><span>{performance.length} 组归因指标 · {commissionRules.length} 条可维护佣金规则</span></SummaryBar>
    <SectionTitle title="Affiliate Providers" description="V1 使用 MANUAL；账号凭证和登录态不进入 CMS" />
    <TableShell><Table><TableHeader><TableRow><TableHead>提供商</TableHead><TableHead>连接方式</TableHead><TableHead>站点 / 语言</TableHead><TableHead>活跃资产</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{providers.map((item) => <TableRow key={item.id}><TableCell><div className="font-medium text-slate-900">{item.display_name}</div><div className="mt-1 text-[10px] text-slate-400">{item.provider_key}</div></TableCell><TableCell>{label(item.connection_mode)}</TableCell><TableCell>{item.site_name || "—"} · {item.default_language || "en"}</TableCell><TableCell className="tabular-nums">{item.active_asset_count || 0}</TableCell><TableCell><StatusPill status={item.status || "configured"} /></TableCell></TableRow>)}</TableBody></Table></TableShell>
    <SectionTitle title="Affiliate Asset Registry" description="Destination / Area / Route / selective Entity" />
    <TableShell><Table><TableHeader><TableRow><TableHead>资产</TableHead><TableHead>范围</TableHead><TableHead>展示类型</TableHead><TableHead>商品类别</TableHead><TableHead className="hidden md:table-cell">提供商</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="font-medium text-slate-900">{item.title || item.id}</div><div className="mt-1 text-[10px] text-slate-400">优先级 {item.priority} · {item.language || "en"}</div></TableCell><TableCell>{label(item.scope_type)}<div className="mt-1 text-[10px] text-slate-400">{item.scope_key || item.destination_slug || "global"}</div></TableCell><TableCell>{label(item.asset_type)}</TableCell><TableCell>{label(item.product_category)}</TableCell><TableCell className="hidden md:table-cell">{item.provider}</TableCell><TableCell><StatusPill status={item.active ? "active" : "inactive"} /><div className="mt-1 text-[10px] text-slate-400">{item.valid_until ? `有效至 ${formatDate(item.valid_until)}` : "未设置截止时间"}</div></TableCell></TableRow>)}</TableBody></Table></TableShell>
    {opportunities.length > 0 && <><SectionTitle title="高价值机会" description="仅显示超过人工维护门槛的精度缺口" /><TableShell><Table><TableHeader><TableRow><TableHead>范围</TableHead><TableHead>类别</TableHead><TableHead>评分</TableHead><TableHead className="hidden md:table-cell">原因</TableHead></TableRow></TableHeader><TableBody>{opportunities.map((item) => <TableRow key={item.id}><TableCell>{label(item.scope_type)} · {item.scope_key}</TableCell><TableCell>{label(item.product_category)}</TableCell><TableCell>{Math.round(item.score)}</TableCell><TableCell className="hidden md:table-cell">{item.reason}</TableCell></TableRow>)}</TableBody></Table></TableShell></>}
    {performance.length > 0 && <><SectionTitle title="Performance" description="Impression / Click 与后续 Booking / Commission 归因" /><TableShell><Table><TableHeader><TableRow><TableHead>提供商 / 类别</TableHead><TableHead>位置</TableHead><TableHead>Impressions</TableHead><TableHead>Clicks / CTR</TableHead><TableHead>Commission</TableHead></TableRow></TableHeader><TableBody>{performance.map((item) => <TableRow key={`${item.provider}:${item.category}:${item.slot_key}:${item.destination_slug}`}><TableCell>{item.provider} · {label(item.category)}</TableCell><TableCell>{item.slot_key || "—"}</TableCell><TableCell>{item.impressions}</TableCell><TableCell>{item.clicks} · {Math.round((item.ctr || 0) * 1000) / 10}%</TableCell><TableCell>{Number(item.commission || 0).toFixed(2)}</TableCell></TableRow>)}</TableBody></Table></TableShell></>}
  </>;
}

function ExceptionsView({ data, onAction, actionBusy }) {
  const items = data?.items || [];
  const manualReviewItems = items.filter((item) => Boolean(item.knowledge?.id || item.entity_alias?.id || item.claim_review?.id));
  if (manualReviewItems.length) return <ExceptionsWorkspace items={items} onAction={onAction} actionBusy={actionBusy} />;
  if (!items.length) return <EmptyState icon="check" title="当前没有需要处理的问题" description="采集、队列和知识库目前没有需要你介入的异常。" healthy />;
  const retry = (item) => onAction(`/api/exceptions/${encodeURIComponent(item.key)}/retry`, { method: "POST" }, "已重新加入处理队列");
  return <div className="space-y-3">
    <SummaryBar title={`${items.length} 个待处理问题`}><span>只有重试型任务可直接重新执行；知识冲突先保留证据，避免系统擅自选择其中一项。</span></SummaryBar>
    <section className="space-y-3 md:hidden">{items.map((item) => <Card key={item.key} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold leading-relaxed text-slate-900">{item.title}</h2><p className="mt-1 text-xs text-slate-600">{item.subject}</p></div><StatusPill status={item.severity} /></div><p className="mt-3 text-[11px] leading-relaxed text-slate-500">{item.detail}</p><div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-[10px] text-slate-400"><span>{label(item.kind)}</span><span>{formatDate(item.updatedAt)}</span></div>{item.retryable ? <Button className="mt-3 w-full" variant="secondary" size="sm" disabled={actionBusy} onClick={() => retry(item)}><RotateCcw />重新执行</Button> : <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">需要补充或核验新的证据。当前事实会保留，但不会被用于自动生成内容。</p>}</Card>)}</section>
    <div className="hidden md:block"><TableShell><Table><TableHeader><TableRow><TableHead>问题</TableHead><TableHead>类型</TableHead><TableHead>优先级</TableHead><TableHead className="hidden md:table-cell">更新时间</TableHead><TableHead>处理</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.key}><TableCell><div className="font-medium text-slate-900">{item.title}</div><div className="mt-1 text-xs text-slate-600">{item.subject}</div><div className="mt-1 max-w-xl text-[10px] leading-relaxed text-slate-400">{item.detail}</div></TableCell><TableCell>{label(item.kind)}</TableCell><TableCell><StatusPill status={item.severity} /></TableCell><TableCell className="hidden whitespace-nowrap md:table-cell">{formatDate(item.updatedAt)}</TableCell><TableCell>{item.retryable ? <Button variant="secondary" size="sm" disabled={actionBusy} onClick={() => retry(item)}><RotateCcw />重新执行</Button> : <span className="text-[10px] text-slate-400">需要新的证据</span>}</TableCell></TableRow>)}</TableBody></Table></TableShell></div>
  </div>;
}

function ExceptionsWorkspace({ items, onAction, actionBusy }) {
  const retry = (item) => onAction(`/api/exceptions/${encodeURIComponent(item.key)}/retry`, { method: "POST" }, "已重新加入处理队列");
  return <div className="space-y-3"><SummaryBar title={`${items.length} 个待处理问题`}><span>队列按 Entity Identity、Claim Conflict、Relation、Source/Temporal Conflict 和 Extraction Error 分类；enrichment、refinement 与兼容建议不会进入这里。</span></SummaryBar><div className="grid gap-3 lg:grid-cols-2">{items.map((item) => <Card key={item.key} className="p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900">{item.title}</h2><p className="mt-1 text-xs text-slate-600">{item.subject}</p></div><StatusPill status={item.severity} /></div><p className="mt-3 text-[11px] leading-relaxed text-slate-500">{item.detail}</p>{item.knowledge?.id ? <KnowledgeConflictResolution item={item} onAction={onAction} actionBusy={actionBusy} /> : item.entity_alias?.id ? <EntityAliasResolution item={item} onAction={onAction} actionBusy={actionBusy} /> : item.claim_review?.id ? <ClaimReviewResolution item={item} onAction={onAction} actionBusy={actionBusy} /> : item.retryable ? <Button className="mt-4" variant="secondary" size="sm" disabled={actionBusy} onClick={() => retry(item)}><RotateCcw />重新执行</Button> : <p className="mt-4 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">需要补充新的来源证据；现有事实会保留，但不会自动用于内容生产。</p>}</Card>)}</div></div>;
}

function EntityAliasResolution({ item, onAction, actionBusy }) {
  const candidate = item.entity_alias;
  const decide = (decision, relationType) => onAction(`/api/knowledge/entity-aliases/candidates/${encodeURIComponent(candidate.id)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, relationType }) }, decision === "same_entity" ? "已确认同一实体；审计快照已保存，可撤销。" : decision === "create_relation" ? "已保持实体分离并建立关系。" : decision === "defer" ? "已保留为暂不判断。" : "已保持为不同实体。");
  return <section className="mt-4 rounded-xl border border-violet-200 bg-violet-50/70 p-3"><p className="text-xs font-semibold text-violet-950">Entity Identity Review</p><div className="mt-2 grid gap-2 text-[10px] text-violet-900 sm:grid-cols-2"><div className="rounded-lg bg-white/70 p-2"><b>Candidate A</b><p>{candidate.alias}</p><p>{label(candidate.candidateEntityType)} · {label(candidate.candidateGranularity)}</p></div><div className="rounded-lg bg-white/70 p-2"><b>Candidate B</b><p>{candidate.proposedCanonicalSubject}</p><p>{label(candidate.proposedEntityType)} · {label(candidate.proposedGranularity)}</p></div></div><p className="mt-2 text-[10px] leading-relaxed text-violet-700">AI：{label(candidate.aiRecommendation || "uncertain")} · {Math.round((candidate.confidence || 0) * 100)}% · {candidate.reason}</p>{candidate.linkedClaims?.length > 0 && <details className="mt-2 text-[10px]"><summary className="cursor-pointer">来源与关联 Claims（{candidate.linkedClaims.length}）</summary><ul className="mt-1 space-y-1">{candidate.linkedClaims.map((claim) => <li key={claim.id}>{claim.source_title}：{claim.source_quote || claim.value_text}</li>)}</ul></details>}<div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={actionBusy} onClick={() => decide("same_entity")}><CheckCircle2 />确认同一实体</Button><Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => decide("different_entity")}>保持不同实体</Button><Button size="sm" variant="secondary" disabled={actionBusy || !candidate.suggestedRelation} onClick={() => decide("create_relation", candidate.suggestedRelation)}>建立关系{candidate.suggestedRelation ? `：${label(candidate.suggestedRelation)}` : ""}</Button><Button size="sm" variant="ghost" disabled={actionBusy} onClick={() => decide("defer")}>暂不判断</Button></div></section>;
}

function ClaimReviewResolution({ item, onAction, actionBusy }) {
  const review = item.claim_review;
  const extractionIssue = String(review.reviewType || "").includes("EXTRACTION_ERROR");
  const decide = (decision) => onAction(`/api/knowledge/claim-reviews/${encodeURIComponent(review.id)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) }, decision === "resolved" ? "已转入知识事实取值判断，请继续选择可信值。" : "已记录为误报；原始 Claim 和证据保持不变。");
  const retryExtraction = () => onAction(`/api/sources/${encodeURIComponent(review.claimA.sourceId)}/retry`, { method: "POST" }, "已重新加入来源提取队列；完成后会重新计算 Claim Review。");
  const Claim = ({ title, claim }) => claim && <div className="rounded-lg border border-slate-200 bg-white p-2.5"><b className="text-[10px] text-slate-500">{title} original sentence</b><p className="mt-1 text-[11px] text-slate-800">{claim.originalSentence || "—"}</p><b className="mt-2 block text-[10px] text-slate-500">Normalized Claim</b><p className="mt-1 text-[11px] text-slate-800">{claim.normalized.subject} · {claim.normalized.predicate} = {claim.normalized.value}</p></div>;
  return <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3"><p className="text-xs font-semibold text-amber-950">{label(review.reviewType)}</p><div className="mt-2 grid gap-2"><Claim title="Source A" claim={review.claimA} /><Claim title="Source B" claim={review.claimB} /></div>{extractionIssue ? <><p className="mt-3 text-[10px] leading-relaxed text-amber-900">若原句中的否定、条件或限制已保留在完整 Claim 中，这是误报；若确实遗漏，请重新提取来源。重新提取不会删除原始证据。</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={actionBusy || !review.claimA.sourceId} onClick={retryExtraction}><RotateCcw />重新提取来源</Button><Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => decide("dismissed")}>语义已保留（关闭误报）</Button></div></> : <><p className="mt-3 text-[10px] leading-relaxed text-amber-900">只有在相同对象、相同时间与相同条件下不能同时为真，才属于冲突；否则请关闭误报。</p><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={actionBusy} onClick={() => decide("resolved")}><CheckCircle2 />进入事实取值判断</Button><Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => decide("dismissed")}>不是冲突（关闭误报）</Button></div></>}</section>;
}

function LegacyExceptionsWorkspace({ items, onAction, actionBusy }) {
  const retry = (item) => onAction(`/api/exceptions/${encodeURIComponent(item.key)}/retry`, { method: "POST" }, "已重新加入处理队列");
  return <div className="space-y-3"><SummaryBar title={`${items.length} 个待处理问题`}><span>“注意”表示需要人工确认，不会自动重试；在确认前，该冲突事实不会进入文章生产。</span></SummaryBar><div className="grid gap-3 lg:grid-cols-2">{items.map((item) => <Card key={item.key} className="p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900">{item.title}</h2><p className="mt-1 text-xs text-slate-600">{item.subject}</p></div><StatusPill status={item.severity} /></div><p className="mt-3 text-[11px] leading-relaxed text-slate-500">{item.detail}</p>{item.knowledge?.id ? <KnowledgeConflictResolution item={item} onAction={onAction} actionBusy={actionBusy} /> : item.retryable ? <Button className="mt-4" variant="secondary" size="sm" disabled={actionBusy} onClick={() => retry(item)}><RotateCcw />重新执行</Button> : <p className="mt-4 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">此问题需补充新的来源证据；现有事实会保留，但不会自动用于内容生产。</p>}</Card>)}</div></div>;
}

function KnowledgeConflictResolution({ item, onAction, actionBusy }) {
  const evidence = Array.isArray(item.knowledge?.evidence) ? item.knowledge.evidence : [];
  const choices = [...new Set([item.knowledge?.preferredValue, ...evidence.map((entry) => entry?.value)].filter(Boolean))];
  const [selected, setSelected] = useState(choices[0] || "");
  const [customValue, setCustomValue] = useState("");
  const [note, setNote] = useState("");
  const preferredValue = customValue.trim() || selected;
  const resolve = () => onAction(`/api/knowledge/${encodeURIComponent(item.knowledge.id)}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preferredValue, note }) }, "已确认知识结论，后续选题和写作将采用该值");
  return <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-semibold text-amber-950">人工判定入口</p><p className="mt-1 text-[11px] leading-relaxed text-amber-900">选择可信结论，或输入纠正值。保存后，此异常会退出待处理队列，并为后续写作提供已确认事实。</p></div><span className="text-[10px] font-semibold text-amber-700">需要确认</span></div>{choices.length > 0 && <div className="mt-3 space-y-2">{choices.map((value) => <label key={value} className={cn("flex cursor-pointer gap-2 rounded-lg border p-2.5 text-[11px] transition", selected === value && !customValue ? "border-amber-400 bg-white" : "border-amber-100 bg-white/70")}><input type="radio" name={`resolution-${item.knowledge.id}`} checked={selected === value && !customValue} onChange={() => { setSelected(value); setCustomValue(""); }} /><span>{value}</span></label>)}</div>}<label className="mt-3 block text-[10px] font-medium text-slate-600">输入纠正值<input value={customValue} onChange={(event) => setCustomValue(event.target.value)} placeholder="如以上结论都不准确，在这里输入正确内容" className="mt-1.5 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-amber-400" /></label><label className="mt-3 block text-[10px] font-medium text-slate-600">判定备注（可选）<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：已根据官方公告确认" className="mt-1.5 min-h-16 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-amber-400" /></label><Button className="mt-3 w-full" size="sm" disabled={actionBusy || !preferredValue} onClick={resolve}><CheckCircle2 />确认并应用此结论</Button></section>;
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
