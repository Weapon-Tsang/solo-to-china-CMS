import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock3, Database, ExternalLink, FileUp, Gauge, Link2, MapPin, Plus, RefreshCw, RotateCcw, Trash2, UploadCloud, Webhook,
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
    assignments: AssignmentsView,
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
  const [model, setModel] = useState(data?.id || "vertex-gemini-3.8-flash");
  const [visualModel, setVisualModel] = useState(data?.visual?.id || "vertex-gemini-3.1-flash-image");
  useEffect(() => setModel(data?.id || "vertex-gemini-3.8-flash"), [data?.id]);
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
      <div className="mt-4 space-y-2 sm:mt-5">{(data?.models || []).map((item) => <label key={item.id} className={cn("flex cursor-pointer gap-3 rounded-xl border p-3 transition", model === item.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300")}><input className="mt-1 accent-slate-900" type="radio" name="ai-model" value={item.id} checked={model === item.id} onChange={() => setModel(item.id)} /><span><span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-900"><span>{item.label}</span>{item.isDefault && <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold text-blue-700">默认</span>}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{item.description}</span><span className="mt-1 block text-[10px] text-emerald-600">支持图文多模态输入{item.preview ? " · 预览版" : ""}</span></span></label>)}</div>
      <div className="mt-4 flex flex-wrap items-center gap-2.5 sm:mt-5 sm:gap-3"><Button size="sm" disabled={actionBusy || !data?.configured || model === data?.id} onClick={saveAi}><CheckCircle2 /> 保存图文模型</Button><span className="text-[11px] text-slate-400">来源：{data?.source === "dashboard" ? "后台设置" : "环境配置"}</span>{data?.vertexBatchConfigured && <span className="text-[11px] text-emerald-600">大批量异步提取已启用{data?.vertexBatchActive ? ` · ${data.vertexBatchActive} 个批任务进行中` : ""}</span>}</div>
    </Card>
    <Card className="p-4 sm:p-5"><div className="flex items-start justify-between gap-4"><div><div className="text-sm font-semibold text-slate-900">内容配图策略与生图模型</div><p className="mt-1 text-xs leading-relaxed text-slate-500">已授权的人工筛选来源实景图会优先用于文章；此模型只补足无法由真实素材覆盖的原创、非事实性插画。</p></div><StatusPill status={data?.visual?.supportsGeneration && data?.visualGenerationConfigured ? "ready" : "pending"} /></div>
      <div className="mt-4 space-y-2 sm:mt-5">{(data?.visual?.models || []).map((item) => <label key={item.id} className={cn("flex gap-3 rounded-xl border p-3 transition", item.supportsGeneration ? "cursor-pointer" : "cursor-not-allowed opacity-65", visualModel === item.id ? "border-slate-900 bg-slate-50" : "border-slate-200 hover:border-slate-300")}><input className="mt-1 accent-slate-900" type="radio" name="visual-model" value={item.id} checked={visualModel === item.id} disabled={!item.supportsGeneration} onChange={() => setVisualModel(item.id)} /><span><span className="block text-xs font-semibold text-slate-900">{item.label}</span><span className="mt-0.5 block text-[11px] leading-relaxed text-slate-500">{item.description}</span><span className={cn("mt-1 block text-[10px]", item.supportsGeneration ? "text-emerald-600" : "text-amber-600")}>{item.supportsGeneration ? "可生成原创插画" : "仅图文理解；当前 API 不支持图片输出"}</span></span></label>)}</div>
      <div className="mt-4 flex flex-wrap items-center gap-2.5 sm:mt-5 sm:gap-3"><Button size="sm" disabled={actionBusy || !data?.visual?.supportsGeneration || visualModel === data?.visual?.id} onClick={saveVisual}><CheckCircle2 /> 保存生图模型</Button><span className="text-[11px] text-slate-400">默认：Gemini 3.1 Flash Image</span></div>
    </Card>
    <Card className="p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">系统与数据存储</div><p className="mt-1 text-xs leading-relaxed text-slate-500">模型密钥只保留在服务器环境中；研究来源、信息主张、知识库和草稿使用持久化数据库保存。</p></div><span className="grid size-8 place-items-center rounded-lg bg-sky-50 text-sky-700"><Database className="size-4" /></span></div><div className="mt-4 space-y-3 text-xs text-slate-600"><div className="flex items-center justify-between gap-3"><span>当前部署</span><span className="font-medium text-slate-900">{data?.storage?.label || "正在识别"}</span></div><div className="flex items-center justify-between gap-3"><span>跨设备访问</span><span className="font-medium text-slate-900">{data?.storage?.crossDevice ? "支持：登录同一后台即可" : "当前仅本机"}</span></div><div className="flex items-center justify-between gap-3"><span>应用版本</span><span className="font-medium text-slate-900">{data?.appVersion || health?.version || "—"}</span></div><div className="flex items-center justify-between gap-3"><span>内容策略</span><span className="font-medium text-slate-900">v{data?.contentStrategy?.version || health?.contentStrategy?.version || "—"}</span></div><div className="flex items-center justify-between gap-3"><span>SEO / GEO 结构化包</span><StatusPill status="ready" /></div><div className="flex items-center justify-between gap-3"><span>云端生图服务</span><StatusPill status={health?.visualGenerationConfigured ? "ready" : "pending"} /></div></div><p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-400 sm:mt-5">{data?.storage?.description || "数据库状态将在服务启动后显示。"}</p></Card>
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
  return <Card className="p-4 sm:p-5 xl:col-span-3"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">前端能力契约</div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">前端发布可渲染组件与页面 Schema；CMS 只选择组件、变体和顺序，并在生成与发布前校验。这里显示当前已同步的能力，不会扫描或猜测前端代码。</p></div><StatusPill status={ready ? "ready" : contract?.status === "major_mismatch" || contract?.status === "invalid" ? "exception" : "pending"} /></div>
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

function SourcesView({ data, onGuide, onOpenSource, onSubmitManualSource, actionBusy }) {
  const items = (data?.items || []).map((item) => ({ ...item, status: sourceDisplayStatus(item) }));
  return (
    <div className="space-y-4">
      <ManualSourceForm onSubmit={onSubmitManualSource} busy={actionBusy} />
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span>也可以继续使用 Chrome 扩展采集已授权的小红书笔记。</span>
        <button type="button" className="font-medium text-blue-700 hover:text-blue-800" onClick={() => onGuide("capture")}>查看扩展采集说明</button>
      </div>
      {!items.length ? <EmptyState icon="source" title="尚无来源" description="可在上方提交公开链接、PDF、Word、图片或视频文件，提交后会自动进入现有研究与内容生产流程。" /> : <>
        <SummaryBar title="处理状态说明">
          <span><b>处理中：</b>来源已安全保存，系统正在进行多模态提取、结构化来源、信息主张和内容蓝图。</span>
          <span><b>提取完成：</b>结构化研究已可用，并不代表文章已生成。</span>
          <span><b>需要处理：</b>打开来源查看原因后可重新执行提取。</span>
        </SummaryBar>
        <SourceQueueOverview items={items} />
        <section className="space-y-2.5 md:hidden" aria-label="研究来源列表">
          {items.map((item) => <button key={item.id} type="button" onClick={() => onOpenSource(item.id)} className="block w-full rounded-2xl border border-slate-200/80 bg-white p-4 text-left shadow-sm transition active:scale-[0.99] focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-200">
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="line-clamp-2 text-[15px] font-semibold leading-relaxed text-slate-900"><span className="mr-1 tabular-nums text-slate-400">{item.list_number}.</span>{item.title || "未命名来源"}</h2><p className="mt-1.5 text-[11px] text-slate-400">{sourceTypeLabel(item)} · v{item.capture_version}</p></div><StatusPill status={item.status} /></div>
            <SourceQueueStatus item={item} compact />
            <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] text-slate-500"><span>{item.destination_name || "目的地识别中"}</span><span className="font-medium tabular-nums text-slate-700">{sourceProgressLabel(item)}</span></div>
            <p className="mt-2 text-[10px] text-slate-400">点击查看来源详情与提取结果</p>
          </button>)}
        </section>
        <div className="hidden md:block"><TableShell><Table><TableHeader><TableRow><TableHead>来源</TableHead><TableHead>状态</TableHead><TableHead>处理队列</TableHead><TableHead className="hidden md:table-cell">目的地</TableHead><TableHead>处理进度</TableHead><TableHead className="hidden lg:table-cell">采集时间</TableHead></TableRow></TableHeader>
          <TableBody>{items.map((item) => <TableRow key={item.id} tabIndex={0} role="button" className="cursor-pointer focus-visible:bg-slate-50 focus-visible:outline-none" onClick={() => onOpenSource(item.id)} onKeyDown={(event) => event.key === "Enter" && onOpenSource(item.id)}>
            <TableCell><div className="max-w-md font-medium text-slate-900"><span className="mr-1.5 tabular-nums text-slate-400">{item.list_number}.</span>{item.title || "未命名来源"}</div><div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-slate-400"><span>{sourceTypeLabel(item)}</span><span>· v{item.capture_version}</span></div></TableCell>
            <TableCell><StatusPill status={item.status} /></TableCell><TableCell><SourceQueueStatus item={item} /></TableCell><TableCell className="hidden md:table-cell">{item.destination_name || "—"}</TableCell><TableCell className="whitespace-nowrap text-xs tabular-nums">{sourceProgressLabel(item)}</TableCell><TableCell className="hidden whitespace-nowrap lg:table-cell">{formatDate(item.captured_at)}</TableCell>
          </TableRow>)}</TableBody>
        </Table></TableShell></div>
      </>}
    </div>
  );
}

function SourceQueueOverview({ items }) {
  const active = items.filter((item) => item.queue && ["running", "queued", "cooldown"].includes(item.queue.state));
  if (!active.length) return null;
  const running = active.filter((item) => item.queue.state === "running").length;
  const queued = active.filter((item) => item.queue.state === "queued").length;
  const cooldown = active.filter((item) => item.queue.state === "cooldown").length;
  return <SummaryBar title={`处理队列：${running} 篇正在处理 · ${queued} 篇可执行排队 · ${cooldown} 篇冷却等待`}>
    <span>来源页在队列活动时每 5 秒刷新状态；只有队首小工作集进入处理，其余来源保持真实排队状态。</span>
    <span>“冷却等待”只标记实际触发限流的任务；提供商暂停期间不会再把整支队列批量改成冷却。</span>
  </SummaryBar>;
}

function sourceDisplayStatus(item) {
  if (item.queue?.state === "running") return "processing";
  if (item.queue?.state === "queued") return "queued";
  if (item.queue?.state === "cooldown") return "retry_required";
  if (item.queue?.state === "failed") return "exception";
  return item.status;
}

function SourceQueueStatus({ item, compact = false }) {
  const queue = item.queue;
  if (!queue) return <span className="text-[10px] text-slate-400">{item.status === "processing" ? "等待生成后续任务" : "—"}</span>;
  const stage = sourceQueueStageLabel(queue.stage);
  if (queue.state === "running") return <div className={cn(compact && "mt-2", "text-[10px] leading-relaxed text-emerald-700")}><b>正在处理</b> · {stage}<br /><span className="text-slate-400">{queue.running_job_count} 个执行中 · {queue.queued_job_count} 个后续任务</span></div>;
  if (queue.state === "queued") return <div className={cn(compact && "mt-2", "text-[10px] leading-relaxed text-blue-700")}><b>排队第 {queue.queue_position} 位</b> · {stage}<br /><span className="text-slate-400">前方 {queue.queue_ahead} 篇 · 本笔记 {queue.queued_job_count} 个任务</span></div>;
  if (queue.state === "cooldown") {
    const quotaLimited = /429|quota|resource exhausted|rate.?limit/i.test(queue.last_error || "");
    return <div className={cn(compact && "mt-2", "text-[10px] leading-relaxed text-amber-700")}><b>冷却等待 · 排队第 {queue.queue_position} 位</b><br /><span>{quotaLimited ? "模型限流" : stage}，{formatDate(queue.available_at)} 后可重试</span></div>;
  }
  return <div className={cn(compact && "mt-2", "text-[10px] leading-relaxed text-rose-700")}><b>任务失败</b> · {stage}<br /><span>尝试 {queue.attempts}/{queue.max_attempts} 次，请打开异常页处理</span></div>;
}

function sourceQueueStageLabel(type) {
  return ({ extract_source: "准备处理", preflight_source: "来源预检", segment_source: "来源分段", extract_segment_claims: "信息主张提取", audit_segment_coverage: "覆盖审计", retry_segment_extraction: "定向补提", finalize_source_extraction: "汇总提取结果" })[type] || label(type);
}

function ManualSourceForm({ onSubmit, busy }) {
  const [kind, setKind] = useState("auto_url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [files, setFiles] = useState([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const [progress, setProgress] = useState(null);
  const linkMode = kind.endsWith("_url");
  const accept = kind === "pdf" ? ".pdf,application/pdf" : kind === "word" ? ".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" : kind === "video" ? ".mp4,.m4v,.mov,.mpeg,.mpg,.webm,.avi,.wmv,.flv,.3gp,video/*" : "image/jpeg,image/png,image/webp,image/gif";

  const submit = async (event) => {
    event.preventDefault();
    setFailure(null); setResult(null); setProgress({ phase: "preparing", percent: 0, label: "正在准备文件" });
    try {
      const encodedFiles = linkMode || kind === "video" ? [] : await Promise.all(files.map(readFileForSubmission));
      const response = await onSubmit({ kind, url: linkMode ? url : undefined, title, notes, files: encodedFiles,
        ...(kind === "video" ? { rawFiles: files } : {}) }, setProgress);
      setResult(response);
      setUrl(""); setTitle(""); setNotes(""); setFiles([]); setFileInputKey((value) => value + 1);
    } catch (caught) {
      setFailure({ code: caught.code, message: caught.message });
    } finally {
      setProgress(null);
    }
  };

  return <Card className="overflow-hidden border-blue-100 bg-gradient-to-br from-white to-blue-50/40 p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><UploadCloud className="size-4 text-blue-700" />人工提交内容来源</div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">提交后自动进入入库、内容提取、信息主张、知识整理、蓝图和创作建议流程。原文件会保存在持久化数据目录中。</p></div><span className="rounded-full bg-blue-100 px-2.5 py-1 text-[10px] font-semibold text-blue-700">统一生产流程</span></div>
    <form className="mt-4 grid gap-3 lg:grid-cols-2" onSubmit={submit}>
      <label className="block"><span className="mb-1.5 block text-[11px] font-medium text-slate-600">来源格式</span><select value={kind} onChange={(event) => { setKind(event.target.value); setFiles([]); setFailure(null); setResult(null); }} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-slate-400 focus:ring-4 focus:ring-slate-100"><option value="auto_url">自动识别链接</option><option value="xiaohongshu_url">小红书笔记链接</option><option value="wechat_url">微信公众号链接</option><option value="video_url">视频链接</option><option value="web_url">其他网页链接</option><option value="pdf">PDF 文档</option><option value="word">Word 文档（DOC/DOCX）</option><option value="images">图片（可多选）</option><option value="video">视频文件（最大 256 MB）</option></select></label>
      {linkMode ? <label className="block"><span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-slate-600"><Link2 className="size-3" />公开链接</span><input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-300 focus:border-slate-400 focus:ring-4 focus:ring-slate-100" /></label> : <label className="block"><span className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-slate-600"><FileUp className="size-3" />选择文件</span><input key={fileInputKey} type="file" required multiple={kind === "images"} accept={accept} onChange={(event) => setFiles(Array.from(event.target.files || []))} className="block h-10 w-full rounded-lg border border-slate-200 bg-white text-xs text-slate-600 file:mr-3 file:h-full file:border-0 file:border-r file:border-slate-200 file:bg-slate-50 file:px-3 file:text-xs file:font-medium" /><span className="mt-1 block text-[10px] text-slate-400">PDF/Word 最多 64 MB，图片每张最多 20 MB、最多 30 张；视频采用分块上传，最多 256 MB。</span></label>}
      <label className="block"><span className="mb-1.5 block text-[11px] font-medium text-slate-600">标题（选填）</span><input value={title} maxLength={1000} onChange={(event) => setTitle(event.target.value)} placeholder="留空时尝试从网页或文件名识别" className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-300 focus:border-slate-400 focus:ring-4 focus:ring-slate-100" /></label>
      <label className="block"><span className="mb-1.5 block text-[11px] font-medium text-slate-600">补充说明/正文（选填）</span><textarea value={notes} maxLength={120000} onChange={(event) => setNotes(event.target.value)} placeholder="可补充来源背景、视频文字稿，或在链接无法直接读取时粘贴正文。" className="min-h-24 w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-relaxed text-slate-900 outline-none placeholder:text-slate-300 focus:border-slate-400 focus:ring-4 focus:ring-slate-100" /></label>
      {failure && <div role="alert" className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800 lg:col-span-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><div><strong>{failureReasonLabel(failure.code)}</strong><p className="mt-0.5 leading-relaxed">{failure.message}</p><p className="mt-1 text-[10px] text-rose-600">错误代码：{failure.code || "REQUEST_FAILED"}</p></div></div>}
      {result && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 lg:col-span-2"><strong>{result.message}</strong>{result.warnings?.length > 0 && <ul className="mt-1 list-disc pl-4 text-[10px]">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}</div>}
      {progress && <div role="status" className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 lg:col-span-2"><div className="flex items-center justify-between gap-3"><strong>{progress.label}</strong><span className="tabular-nums">{progress.percent}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-600 transition-[width]" style={{ width: `${progress.percent}%` }} /></div><p className="mt-1.5 text-[10px] text-blue-600">入库后将依次进行预检、分段、信息主张提取、覆盖审计、实体解析和知识重建。</p></div>}
      <div className="flex flex-wrap items-center gap-3 lg:col-span-2"><Button disabled={busy || (linkMode ? !url : files.length === 0)}><UploadCloud />{busy ? "正在提取并入库…" : "提交并进入生产流程"}</Button><span className="text-[10px] leading-relaxed text-slate-400">{linkMode ? "链接只读取公开页面，不携带登录 Cookie；遇到反爬、登录墙、限流或空内容会明确返回原因。" : kind === "video" ? "原视频会保存在持久化目录；需使用支持视频输入的 Vertex Gemini，画面、对白和环境音会一并分析。" : "原文件会保存到持久化数据目录；文档解析失败或扫描版 PDF 无正文时会明确返回原因。"}</span></div>
    </form>
  </Card>;
}

function readFileForSubmission(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.onload = () => resolve({ name: file.name, mimeType: file.type || "application/octet-stream", base64: String(reader.result || "").split(",", 2)[1] || "" });
    reader.readAsDataURL(file);
  });
}

function sourceTypeLabel(item) {
  if (item.source_kind === "xiaohongshu_note") return `${item.author_name || "未知作者"}${item.external_id ? ` · XHS ID ${item.external_id}` : ""}`;
  const labels = { xiaohongshu_url: "人工提交 · 小红书链接", wechat_url: "人工提交 · 微信公众号", video_url: "人工提交 · 视频链接", video: "人工提交 · 视频文件", web_url: "人工提交 · 网页链接", pdf: "人工提交 · PDF", word: "人工提交 · Word", images: `人工提交 · 图片${item.file_count ? `（${item.file_count}）` : ""}` };
  return labels[item.source_kind] || "人工提交来源";
}

function sourceProgressLabel(item) {
  const claims = Number(item.claim_count || 0);
  const segments = Number(item.segment_count || 0);
  const extracted = Number(item.extracted_segment_count || 0);
  const audited = Number(item.audited_segment_count || 0);
  if (claims > 0 || item.status === "processed") return `${claims} 条主张`;
  if (segments > 0) return `提取 ${extracted}/${segments} · 审计 ${audited}/${segments}`;
  return item.status === "processing" ? "正在拆分来源" : `${claims} 条主张`;
}

function failureReasonLabel(code) {
  return { AUTH_REQUIRED: "需要登录或授权", BOT_PROTECTION: "触发反爬/人机验证", RATE_LIMITED: "访问频率受限", FETCH_TIMEOUT: "链接响应超时", EMPTY_CONTENT: "未提取到正文", EMPTY_DOCUMENT: "文档没有可提取正文", DOCUMENT_PARSE_FAILED: "文档解析失败", INVALID_VIDEO_FILE: "视频文件无效", FILE_TOO_LARGE: "文件体积超限", UPLOAD_TOO_LARGE: "本次上传体积超限", PRIVATE_NETWORK_BLOCKED: "已阻止内网地址", UNSUPPORTED_CONTENT_TYPE: "不支持的链接内容格式", REMOTE_HTTP_ERROR: "目标网站返回错误" }[code] || "提交失败";
}

function AssignmentsView({ data, onAction, actionBusy, onNavigate }) {
  const destinations = data?.destinations || [];
  const assignmentTypes = data?.assignmentTypes || [];
  const assignments = data?.assignments || [];
  const systemTopics = data?.systemTopics || [];
  const [destinationSlug, setDestinationSlug] = useState(destinations[0]?.slug || "");
  const [title, setTitle] = useState("");
  const [assignmentType, setAssignmentType] = useState("city_walk");
  const [targetEntities, setTargetEntities] = useState("");
  const [brief, setBrief] = useState("");
  const [desiredVisual, setDesiredVisual] = useState("route_sketch");
  useEffect(() => {
    if (!destinationSlug && destinations[0]?.slug) setDestinationSlug(destinations[0].slug);
  }, [destinationSlug, destinations]);
  const submit = async (event) => {
    event.preventDefault();
    const created = await onAction("/api/editorial-assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        destinationSlug,
        title,
        assignmentType,
        targetEntities: targetEntities.split(/[,，\n]/u).map((item) => item.trim()).filter(Boolean),
        brief,
        desiredVisual,
      }),
    }, (result) => result.status === "ready" ? "命题已新增，素材体检通过。" : "命题已新增，系统列出了需要补采的素材。" );
    if (created) {
      setTitle(""); setTargetEntities(""); setBrief("");
    }
  };
  const remove = (item) => {
    if (!window.confirm(`从命题清单移除“${item.title}”？`)) return;
    void onAction(`/api/editorial-assignments/${item.id}`, { method: "DELETE" }, (result) => result.message || "命题已移除。");
  };
  const removeSystemTopic = (item) => {
    if (!window.confirm(`从系统选题清单移除“${item.title}”？`)) return;
    void onAction(`/api/editorial-topics/${item.id}`, { method: "DELETE" }, (result) => result.message || "系统选题已移除。");
  };
  return <div className="space-y-4">
    <SummaryBar title={`${assignments.length} 个人工命题 · ${systemTopics.length} 个系统选题`}>
      <span>人工命题与系统自动发现的选题并行存在，互不覆盖。</span>
      <span>新增命题只做素材体检；你点击“加入创作队列”才视为批准生产。</span>
    </SummaryBar>
    <section className="grid gap-4 xl:grid-cols-[minmax(20rem,.8fr)_minmax(0,1.2fr)]">
      <Card className="p-4 sm:p-5">
        <div><h2 className="text-sm font-semibold text-slate-900">新增人工命题</h2><p className="mt-1 text-[11px] leading-relaxed text-slate-500">像命题作文一样给出方向。可指定城市、沿途 Attraction 和创作边界，系统会从知识库筛选直接相关的素材。</p></div>
        {destinations.length ? <form className="mt-4 space-y-3" onSubmit={submit}>
          <label className="block"><span className="text-[11px] font-medium text-slate-700">目的地</span><select value={destinationSlug} onChange={(event) => setDestinationSlug(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400">{destinations.map((item) => <option key={item.slug} value={item.slug}>{item.name} · {item.fact_count} 条知识</option>)}</select></label>
          <label className="block"><span className="text-[11px] font-medium text-slate-700">专题标题 / 命题</span><input required minLength={2} maxLength={180} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：重庆 City Walk：山城步道与江景机位" className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400" /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block"><span className="text-[11px] font-medium text-slate-700">专题类型</span><select value={assignmentType} onChange={(event) => { const value = event.target.value; setAssignmentType(value); if (value === "city_walk") setDesiredVisual("route_sketch"); }} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400">{assignmentTypes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <label className="block"><span className="text-[11px] font-medium text-slate-700">视觉方向</span><select value={desiredVisual} onChange={(event) => setDesiredVisual(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400"><option value="route_sketch">路线概念手稿</option><option value="illustration">原创编辑插画</option><option value="none">暂不指定</option></select></label>
          </div>
          <label className="block"><span className="text-[11px] font-medium text-slate-700">指定地点 / Attraction（可选）</span><input value={targetEntities} onChange={(event) => setTargetEntities(event.target.value)} placeholder="洪崖洞，山城巷，十八梯" className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400" /><span className="mt-1 block text-[10px] text-slate-400">用逗号分隔。填写后，缺口提示会具体到这些地点及其衔接路线。</span></label>
          <label className="block"><span className="text-[11px] font-medium text-slate-700">写作要求 / 边界（可选）</span><textarea rows={4} maxLength={2000} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="例如：面向第一次到重庆的独行游客；路线控制在半天；重点写步行顺序、坡度、交通和最佳拍摄时段。" className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm leading-relaxed outline-none focus:border-slate-400" /></label>
          <Button className="w-full" disabled={actionBusy || !destinationSlug || title.trim().length < 2}><Plus /> 新增并检测素材</Button>
        </form> : <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">还没有可选目的地。请先采集来源并完成知识库提取。</div>}
      </Card>
      <section className="space-y-3">
        <SectionTitle title="人工命题清单" description="素材不足时按城市和地点显示补采任务；补采完成后可一键重新检测。" />
        {assignments.length ? assignments.map((item) => <EditorialAssignmentCard key={item.id} item={item} onAction={onAction} onRemove={remove} actionBusy={actionBusy} />) : <Card className="p-6 text-center text-xs text-slate-500">尚未添加人工命题。</Card>}
      </section>
    </section>
    <section>
      <SectionTitle title="系统选定的专题 / 选题" description="这些来自来源分析与并行创作策略；人工命题不会替换或消耗它们。" />
      {systemTopics.length ? <TableShell><Table><TableHeader><TableRow><TableHead>选题</TableHead><TableHead>内容类型</TableHead><TableHead>素材就绪度</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{systemTopics.map((item) => <TableRow key={item.id}><TableCell><div className="max-w-lg font-medium text-slate-900">{item.title}</div><div className="mt-1 text-[10px] text-slate-400">{item.destination_slug}</div></TableCell><TableCell>{label(item.content_type)}</TableCell><TableCell className="font-medium tabular-nums">{Math.round(item.readiness_score || 0)}%</TableCell><TableCell><StatusPill status={item.status} /></TableCell><TableCell><Button size="sm" variant="ghost" disabled={actionBusy} onClick={() => removeSystemTopic(item)}><Trash2 /> 移除</Button></TableCell></TableRow>)}</TableBody></Table></TableShell> : <EmptyState icon="content" title="暂无系统选题" description="系统会在来源完成分析后，把可用的专题创作路径显示在这里。" action={() => onNavigate("sources")} actionLabel="查看来源" />}
    </section>
  </div>;
}

function EditorialAssignmentCard({ item, onAction, onRemove, actionBusy }) {
  const evaluation = item.evaluation || {};
  const evidence = evaluation.evidence || {};
  const visibleStatus = item.status === "queued" && item.opportunity_status ? item.opportunity_status : item.status;
  const recheck = () => onAction(`/api/editorial-assignments/${item.id}/recheck`, { method: "POST" }, (result) => result.status === "ready" ? "重新检测通过，可以加入创作队列。" : "已重新检测，仍有素材缺口。" );
  const queue = () => onAction(`/api/editorial-assignments/${item.id}/queue`, { method: "POST" }, "命题已批准并加入创作队列。" );
  return <Card className="p-4 sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold leading-relaxed text-slate-900">{item.title}</h3><StatusPill status={visibleStatus} /></div><p className="mt-1 text-[11px] text-slate-500">{item.destination_name || item.destination_slug} · {label(item.assignment_type)} · {label(item.content_type)}</p></div><div className="text-right"><strong className="text-xl font-semibold tabular-nums text-slate-900">{Math.round(item.quality_score || 0)}</strong><span className="text-[10px] text-slate-400"> / 100</span></div></div>
    {item.brief && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-600"><b>命题要求：</b>{item.brief}</p>}
    <p className={cn("mt-3 rounded-xl border p-3 text-xs leading-relaxed", evaluation.ready ? "border-emerald-200 bg-emerald-50 text-emerald-900" : item.status === "suppressed" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-blue-100 bg-blue-50 text-blue-900")}>{evaluation.summary || "正在等待素材体检。"}</p>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><AssignmentStat label="相关事实" value={evidence.factCount || 0} /><AssignmentStat label="独立来源" value={evidence.sourceFamilyCount || 0} /><AssignmentStat label="地点 / 项目" value={evidence.entityCount || 0} /><AssignmentStat label="路线证据" value={evidence.routeFactCount || 0} /></div>
    {(evaluation.acquisitionRequests || []).length > 0 && <div className="mt-3"><p className="text-[11px] font-semibold text-slate-700">需要补采</p><ul className="mt-2 space-y-2">{evaluation.acquisitionRequests.map((request, index) => <li key={`${request.evidenceType}-${index}`} className="rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2 text-[11px] leading-relaxed text-amber-900">{request.message}</li>)}</ul></div>}
    {(evidence.selectedFactPreview || []).length > 0 && <details className="mt-3 rounded-lg border border-slate-100 px-3 py-2 text-[11px] text-slate-500"><summary className="cursor-pointer font-medium text-slate-700">查看已筛选素材（{evidence.selectedFactPreview.length} 条预览）</summary><ul className="mt-2 space-y-1.5">{evidence.selectedFactPreview.map((fact) => <li key={fact.key}><b>{fact.subject}</b> · {fact.predicate}：{fact.value}</li>)}</ul></details>}
    {evaluation.visualBrief && <p className="mt-3 text-[10px] leading-relaxed text-violet-700"><b>视觉计划：</b>{evaluation.visualBrief.instruction}</p>}
    <div className="mt-4 flex flex-wrap gap-2">{item.status === "needs_sources" && <Button size="sm" variant="secondary" disabled={actionBusy} onClick={recheck}><RefreshCw /> 重新检测</Button>}{item.status === "ready" && <Button size="sm" disabled={actionBusy} onClick={queue}><CheckCircle2 /> 加入创作队列</Button>}{item.status === "queued" && <Button size="sm" variant="secondary" disabled>已进入创作队列</Button>}<Button size="sm" variant="ghost" disabled={actionBusy} onClick={() => onRemove(item)}><Trash2 /> 删除命题</Button></div>
  </Card>;
}

function AssignmentStat({ label: title, value }) {
  return <div className="rounded-lg border border-slate-100 bg-slate-50 px-2.5 py-2"><strong className="block text-sm tabular-nums text-slate-900">{value}</strong><span className="text-[9px] text-slate-500">{title}</span></div>;
}

function RecommendationsView({ data, onAction, actionBusy, onNavigate }) {
  const items = data?.items || [];
  const opportunities = data?.opportunities || [];
  const decide = (id, decision, message, options = {}) => onAction(`/api/recommendations/${id}/decision`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, ...options }),
  }, decision === "approved_article" ? (result) => result.queued
    ? "已批准该内容机会，证据就绪并已进入内容生产。"
    : result.status === "suppressed" ? "已批准，但检测到已有内容冲突，当前已抑制。"
      : `已批准该内容机会，仍缺少证据：${(result.readiness?.blockingRequirements || []).join("、") || "等待覆盖要求满足"}。`
    : message);
  if (!items.length) return <EmptyState icon="content" title="暂时没有内容建议" description="AI 完成来源提取后，系统会在这里建议：沉淀为知识、归入专题、补充研究，或进入文章候选。" action={() => onNavigate("sources")} actionLabel="查看研究来源" />;
  return <div className="space-y-4">
    <SummaryBar title="“建议”如何使用"><span>它是人工审批关口：系统只推荐下一步，不会自动发布文章。</span><span>“补充研究”表示现有证据不足，优先核验官方信息。</span></SummaryBar>
    {opportunities.length > 0 && <SummaryBar title={`${opportunities.length} 个内容机会`}><span>文章就绪度以证据为准，不等于会自动发布。</span><span>{opportunities.filter((item) => item.status === "research_required").length} 个需要补充研究</span></SummaryBar>}
    <section className="space-y-3 lg:hidden">{items.map((item) => <Card key={item.id} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold leading-relaxed text-slate-900">{item.source_title || item.primary_topic}</h2><div className="mt-1 flex flex-wrap gap-1.5"><StatusPill status={item.classification} /><span className="text-[10px] text-slate-400">策略 v{item.strategy_version}</span></div></div><span className="shrink-0 text-xs font-semibold tabular-nums text-slate-600">{Math.round(item.article_potential)}<small className="ml-0.5 font-normal text-slate-400">/100</small></span></div><RecommendationConclusion item={item} decide={decide} actionBusy={actionBusy} />{item.suggested_article_title && item.classification === "ARTICLE_CANDIDATE" && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-700">建议文章：{item.suggested_article_title}</p>}<details className="mt-3 text-[11px] text-slate-500"><summary className="cursor-pointer select-none font-medium text-slate-600">查看质量信号与模型依据</summary><p className="mt-2 leading-relaxed">信息密度 {Math.round(item.information_density)} · 完整度 {Math.round(item.topic_completeness)} · 可信度 {Math.round(item.confidence * 100)}%</p><p className="mt-2 leading-relaxed text-slate-400">{item.reasoning_summary || "暂无原始说明"}</p></details><div className="mt-4"><RecommendationDecision item={item} decide={decide} actionBusy={actionBusy} mobile /></div></Card>)}</section>
    <div className="hidden lg:block"><TableShell><Table><TableHeader><TableRow><TableHead>来源与系统结论</TableHead><TableHead className="hidden md:table-cell">质量信号</TableHead><TableHead className="hidden lg:table-cell">需要补齐的证据</TableHead><TableHead>你的决定</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="max-w-md font-medium text-slate-900">{item.source_title || item.primary_topic}</div><div className="mt-1 flex flex-wrap gap-1.5"><StatusPill status={item.classification} /><span className="text-[10px] text-slate-400">策略 v{item.strategy_version}</span></div><RecommendationConclusion item={item} decide={decide} actionBusy={actionBusy} />{item.suggested_article_title && item.classification === "ARTICLE_CANDIDATE" && <p className="mt-2 text-[11px] font-medium text-slate-700">建议文章标题：{item.suggested_article_title}</p>}<details className="mt-2 max-w-xl text-[10px] text-slate-400"><summary className="cursor-pointer select-none hover:text-slate-600">查看模型原始分析依据</summary><p className="mt-1 leading-relaxed">{item.reasoning_summary || "暂无原始说明"}</p></details></TableCell><TableCell className="hidden md:table-cell"><div className="text-xs font-medium text-slate-700">文章潜力 {Math.round(item.article_potential)} / 100</div><div className="mt-1 text-[10px] leading-relaxed text-slate-400">信息密度 {Math.round(item.information_density)} · 完整度 {Math.round(item.topic_completeness)} · 可信度 {Math.round(item.confidence * 100)}%</div></TableCell><TableCell className="hidden max-w-sm lg:table-cell"><RecommendationEvidenceNeed item={item} /></TableCell><TableCell><RecommendationDecision item={item} decide={decide} actionBusy={actionBusy} /></TableCell></TableRow>)}</TableBody></Table></TableShell></div>
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
  knowledge_only: { decision: "knowledge_only", label: "仅入知识库", message: "已标记为仅进入知识库", help: "保留来源、信息主张和知识事实，用作未来选题的可追溯证据。" },
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

function RecommendationConclusion({ item, decide, actionBusy }) {
  const guidance = recommendationGuidance(item);
  const tones = {
    emerald: "border-emerald-200/80 bg-emerald-50/70 text-emerald-950",
    amber: "border-amber-200/80 bg-amber-50/70 text-amber-950",
    blue: "border-blue-200/80 bg-blue-50/70 text-blue-950",
    slate: "border-slate-200/80 bg-slate-50 text-slate-900",
  };
  const topicIdeas = (item.possible_cluster_topics || []).slice(0, 5);
  const productionPaths = (item.production_paths || item.analysis?.production_paths || []).slice(0, 8);
  if (topicIdeas.length) guidance.reason = `${guidance.reason} 可继续拆分为：${topicIdeas.join("；")}。`;
  return <div className={cn("mt-3 max-w-xl rounded-xl border px-3 py-2.5 shadow-sm", tones[guidance.tone])}><div className="text-[10px] font-semibold uppercase tracking-[0.12em] opacity-65">系统建议结论</div><p className="mt-1 text-xs font-semibold leading-relaxed">{guidance.conclusion}</p><p className="mt-1 text-[11px] leading-relaxed opacity-85">{guidance.reason}</p>{productionPaths.length > 0 && <details className="mt-2 border-t border-current/10 pt-2 text-[10px] leading-relaxed"><summary className="cursor-pointer font-semibold">查看并行创作路线（{productionPaths.length}）</summary><div className="mt-2 space-y-2">{productionPaths.map((path, index) => { const approved = ["approved_waiting_for_evidence", "approved_ready", "producing", "drafted", "qa_failed", "ready_for_wordpress", "wordpress_draft"].includes(path.opportunity_status); return <div key={`${path.mode}-${index}`} className="rounded-lg border border-current/10 bg-white/50 p-2"><div className="font-semibold">{productionModeLabel(path.mode)}：{path.title}</div><p className="mt-1"><b>文章类型：</b>{path.content_type || "按主题判断"}</p><p className="mt-1"><b>给读者什么：</b>{path.reader_promise}</p><p className="mt-1"><b>为什么能写：</b>{path.why_it_works}</p><p className="mt-1"><b>证据边界：</b>{path.evidence_boundary}</p>{decide && <Button type="button" size="sm" className="mt-2 h-7 px-2 text-[10px]" disabled={actionBusy || approved || !path.opportunity_id} onClick={() => decide(item.id, "approved_article", "已批准这条创作路线。", { opportunityId: path.opportunity_id })}>{approved ? "这条路线已批准" : path.opportunity_id ? "批准这条路线" : "等待策略分析完成"}</Button>}</div>; })}</div></details>}<div className="mt-2 border-t border-current/10 pt-2 text-[10px] leading-relaxed opacity-80"><b>下一步：</b>{guidance.next}<br /><b>不会影响：</b>{guidance.impact}</div></div>;
}

function productionModeLabel(mode) {
  return { SOURCE_ADAPTATION: "单一来源改写", TOPIC_FEATURE: "专题创作", MULTI_SOURCE_SYNTHESIS: "多来源综合" }[String(mode || "").toUpperCase()] || "创作路线";
}

function RecommendationEvidenceNeed({ item }) {
  const guidance = recommendationGuidance(item);
  const values = [...(item.missing_information || []), ...(item.possible_cluster_topics || [])].filter(Boolean);
  return <div className="text-[11px] leading-relaxed text-slate-600"><p className="font-medium text-slate-700">{guidance.evidenceNeed}</p>{values.length > 0 && <details className="mt-1 text-[10px] text-slate-400"><summary className="cursor-pointer select-none hover:text-slate-600">查看模型列出的原始项</summary><p className="mt-1">{values.join(" · ")}</p></details>}</div>;
}

function recommendationGuidance(item) {
  const type = String(item?.classification || "UNSURE").toUpperCase();
  const map = {
    DUPLICATE: { tone: "amber", conclusion: "不新建文章；作为已有主题的补充佐证。", reason: "系统发现该笔记与已采集的目的地攻略在景点、预约或行程提醒上高度重叠，新增的独立信息不足以支撑另一篇文章。", next: "优先点击“仅入知识库”；只有发现明确的新事实或官方链接时，再归入专题或补充研究。", impact: "来源、已提取的 信息主张和知识事实仍会保留，用来增强已有主题的证据。", evidenceNeed: "不需要补齐整篇文章；如要提升价值，只补充与已有资料不同、可核验的新事实。" },
    ARTICLE_CANDIDATE: { tone: "emerald", conclusion: "可作为新文章候选，但尚未自动发布。", reason: "这篇来源呈现了相对清晰的旅行问题和可写角度，当前信号显示具备独立内容潜力。", next: "核对右侧缺失信息后点击“批准文章”；满足证据门槛时系统才会创建内容规划。", impact: "批准仅进入规划队列，英文草稿和 WordPress 投递仍会经过质量审核。", evidenceNeed: "优先补齐高时效或影响游客决策的事实，例如预约、票价、开放时间和外籍游客规则。" },
    RESEARCH_REQUIRED: { tone: "amber", conclusion: "暂不写文章；先补充官方或第二来源验证。", reason: "当前来源有价值，但关键旅行决策信息的证据不完整或时效性较高，直接成文容易误导游客。", next: "点击“补充研究”，随后保存官方页面或另一篇能交叉验证的高质量来源。", impact: "现有 信息主张和知识事实会继续入库，只是不会进入可发布内容队列。", evidenceNeed: "优先核验预约、票价、开放时间、证件要求、交通和取消规则。" },
    KNOWLEDGE_ONLY: { tone: "blue", conclusion: "沉淀为知识事实，不单独规划文章。", reason: "内容对目的地知识有帮助，但它更适合作为文章中的一个事实或提醒，而不是独立选题。", next: "点击“仅入知识库”；后续系统会在匹配的文章规划中引用它。", impact: "不会丢弃该来源；它可与后续来源合并，未来也可能形成更完整主题。", evidenceNeed: "继续收集同一景点或同一旅行问题的互补事实，尤其是官方或第二来源。" },
    CLAIM_ONLY: { tone: "blue", conclusion: "保留为单条可追溯信息，不创建新选题。", reason: "该来源提供的是一个较小的信息点，尚不足以构成完整旅行指南。", next: "选择“仅入知识库”，并在保存后续相关来源时让系统自动聚合。", impact: "单条事实仍能被未来的文章作为证据使用。", evidenceNeed: "补充同一主题的背景、路线、费用、规则或实操信息。" },
    CLUSTER_CANDIDATE: { tone: "blue", conclusion: "归入现有专题，等待更多互补来源后统一策划。", reason: "它与已有主题相关，但目前更适合参与一个更完整的目的地专题。", next: "点击“归入专题”，继续积累同一主题的不同视角和可验证事实。", impact: "不会生成重复文章；现有知识会保留在专题的证据池中。", evidenceNeed: "补齐专题覆盖面，避免来源都重复描述同一个景点或同一个提醒。" },
    LOW_VALUE: { tone: "slate", conclusion: "暂不进入内容规划；保留来源记录即可。", reason: "信息密度、独特性或可验证性不足，当前不值得投入额外写作成本。", next: "可选择“忽略”或“仅入知识库”；除非后续出现可交叉验证的新价值。", impact: "不会删除原始来源，仍可回看和重新提取。", evidenceNeed: "需要更具体、可执行且能被验证的旅行信息。" },
    UNSURE: { tone: "slate", conclusion: "需要人工确认下一步。", reason: "系统无法可靠判断它应独立成文、归入专题还是仅作为知识事实。", next: "优先查看原始来源与模型依据，再选择“仅入知识库”或“补充研究”。", impact: "未决定前，系统不会自动发布或删除任何内容。", evidenceNeed: "需要更清楚的目的地、事实类型或交叉来源。" },
  };
  return map[type] || map.UNSURE;
}

function KnowledgeView({ data, onNavigate, onAction, actionBusy }) {
  const items = data?.items || [];
  const visibleItems = items.filter((item) => item.visibility_status !== "hidden");
  const hiddenItems = items.filter((item) => item.visibility_status === "hidden");
  const [activeTheme, setActiveTheme] = useState("all");
  const [activeSubject, setActiveSubject] = useState("all");
  const [cityExpanded, setCityExpanded] = useState(true);
  const overview = useMemo(() => buildKnowledgeOverview(visibleItems), [visibleItems]);
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
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[11px] font-medium uppercase tracking-[0.14em] text-cyan-700">目的地知识地图</p><h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">{overview.destinationLabel} · 可用研究地图</h2><p className="mt-1 text-xs leading-relaxed text-slate-500">先从城市目录进入景点或主题，再查看对应事实；避免把少量笔记拆出的信息点一次性铺满页面。</p></div><span className="rounded-full border border-cyan-100 bg-cyan-50 px-3 py-1 text-[11px] font-semibold text-cyan-700">{overview.subjects.length} 个地点 / 实体</span></div>
        <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{overview.themes.map((theme) => <button key={theme.id} type="button" onClick={() => selectTheme(activeTheme === theme.id ? "all" : theme.id)} className={cn("rounded-xl border p-3 text-left transition", activeTheme === theme.id ? "border-slate-900 bg-slate-900 text-white shadow-sm" : "border-slate-200/80 bg-white hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm")}><div className={cn("text-[11px] font-semibold", activeTheme === theme.id ? "text-white" : "text-slate-800")}>{theme.label}</div><div className={cn("mt-1 text-xl font-semibold tracking-tight tabular-nums", activeTheme === theme.id ? "text-white" : "text-slate-900")}>{theme.count}</div><div className={cn("mt-0.5 text-[10px]", activeTheme === theme.id ? "text-slate-300" : "text-slate-400")}>{theme.help}</div></button>)}</div>
      </Card>
      <Card className="p-5"><p className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">证据健康度</p><div className="mt-3 space-y-3"><KnowledgeStat label="独立来源" value={overview.sourceCount} hint="同作者与转载来源会自动去重" tone="emerald" /><KnowledgeStat label="自动时效共识" value={overview.automaticConsensusCount} hint="按来源质量和证据时间自动选值" tone="amber" /><KnowledgeStat label="严格冲突" value={overview.conflictCount} hint="仅保留无法共存的高后果冲突" tone={overview.conflictCount ? "rose" : "slate"} /></div><p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-500">价格、营业时间和预约等动态事实由多来源与时效权重自动判断；暂定值会提示证据日期，不要求逐条人工核验。</p></Card>
    </section>
    <section className="flex flex-wrap items-center gap-2"><span className="mr-1 text-xs font-semibold text-slate-700">查看主题：</span><Button type="button" variant={activeTheme === "all" ? "default" : "secondary"} size="sm" className="h-8" onClick={() => selectTheme("all")}>全部事实</Button>{overview.themes.map((theme) => <Button key={theme.id} type="button" variant={activeTheme === theme.id ? "default" : "secondary"} size="sm" className="h-8" onClick={() => selectTheme(theme.id)}>{theme.label} {theme.count}</Button>)}</section>
    <section className="grid gap-3 xl:grid-cols-[17rem_minmax(0,1fr)]"><KnowledgeDirectory overview={overview} activeSubject={activeSubject} expanded={cityExpanded} onToggle={() => setCityExpanded((value) => !value)} onSelect={setActiveSubject} /><div><div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-semibold text-slate-800">{activeSubject === "all" ? "景点与主题索引" : visibleSubjects[0]?.name || "景点事实"}</p><p className="mt-0.5 text-[11px] text-slate-400">{activeSubject === "all" ? "先从左侧目录选择一个景点；此处默认不展开全部事实。" : `正在查看 ${visibleSubjects[0]?.facts.length || 0} 条关联事实。`}</p></div>{activeSubject !== "all" && <Button type="button" variant="secondary" size="sm" className="h-8" onClick={() => setActiveSubject("all")}>返回索引</Button>}</div><section className="grid gap-3 md:grid-cols-2">{visibleSubjects.map((subject) => <KnowledgeSubjectCard key={subject.key} subject={subject} activeTheme={activeTheme} compact={activeSubject === "all"} onSelect={() => setActiveSubject(subject.key)} />)}</section></div></section>
    {activeTheme !== "all" && !visibleSubjects.length && <EmptyState icon="knowledge" title="该主题暂时没有事实" description="继续保存相关来源后，系统会自动归纳并纳入此主题。" />}
    <KnowledgeManagement items={items} hiddenCount={hiddenItems.length} onAction={onAction} actionBusy={actionBusy} />
  </div>;
}

function KnowledgeManagement({ items, hiddenCount, onAction, actionBusy }) {
  const update = (fact, action) => onAction(`/api/knowledge/${encodeURIComponent(fact.id)}/${action}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: action === "hide" ? "由管理员在知识库页面隐藏" : "由管理员恢复显示" }),
  }, action === "hide" ? "知识事实已隐藏；底层信息主张 与证据保持不变。" : "知识事实已恢复显示。");
  return <details className="rounded-xl border border-slate-200 bg-white shadow-sm">
    <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-800">知识库人工管理（{items.length} 条，已隐藏 {hiddenCount} 条）</summary>
    <div className="border-t border-slate-100 p-3"><p className="mb-3 text-[11px] leading-relaxed text-slate-500">“隐藏”仅阻止该事实进入选题和写作，不删除原始信息主张、来源或证据；可随时恢复，且知识重建后仍保留此决定。</p>
      <TableShell><Table><TableHeader><TableRow><TableHead>知识事实</TableHead><TableHead>状态</TableHead><TableHead>管理</TableHead></TableRow></TableHeader><TableBody>{items.map((fact) => <TableRow key={fact.id}><TableCell><div className="font-medium text-slate-900">{fact.subject} · {fact.predicate}</div><div className="mt-1 max-w-2xl text-[10px] text-slate-500">{fact.preferred_value}</div>{fact.visibility_reason && <div className="mt-1 text-[10px] text-amber-700">原因：{fact.visibility_reason}</div>}</TableCell><TableCell><StatusPill status={fact.visibility_status === "hidden" ? "ignored" : "active"} /></TableCell><TableCell>{fact.visibility_status === "hidden" ? <Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => update(fact, "restore")}><RotateCcw />恢复</Button> : <Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => update(fact, "hide")}>隐藏</Button>}</TableCell></TableRow>)}</TableBody></Table></TableShell>
    </div>
  </details>;
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
  const sourceCount = new Set(facts.flatMap(factIndependentEvidenceKeys)).size;
  const automaticConsensusCount = facts.filter((fact) => isAutomatedConsensus(fact)).length;
  if (compact) return <Card className="overflow-hidden p-0"><button type="button" onClick={onSelect} className="w-full p-4 text-left transition hover:bg-slate-50"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-900">{subject.name}</h3><p className="mt-1 text-[10px] text-slate-400">{facts.length} 条事实 · {sourceCount} 个独立来源{automaticConsensusCount ? ` · ${automaticConsensusCount} 项自动时效结论` : ""}</p></div><ChevronRight className="mt-0.5 size-4 shrink-0 text-slate-400" /></div><p className="mt-3 text-[11px] text-slate-500">点击查看此景点的结构化事实与共识状态</p></button></Card>;
  return <Card className="overflow-hidden p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-900">{subject.name}</h3><p className="mt-1 text-[10px] text-slate-400">{facts.length} 条事实 · {sourceCount} 个独立来源{automaticConsensusCount ? ` · ${automaticConsensusCount} 项自动时效结论` : ""}</p></div><StatusPill status={sourceCount >= 2 ? "corroborated" : "single_source"} /></div><div className="mt-4 space-y-2.5">{facts.slice(0, 4).map((fact) => <div key={fact.id} className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2"><div className="flex items-center justify-between gap-2"><span className="truncate text-[11px] font-medium text-slate-700">{knowledgeTheme(fact).label}</span><span className={cn("shrink-0 text-[10px]", isAutomatedConsensus(fact) ? "text-amber-600" : "text-slate-400")}>{factConsensusLabel(fact)}</span></div><p className="mt-1 text-xs leading-relaxed text-slate-900">{fact.preferred_value || "尚无结论"}</p></div>)}</div>{facts.length > 4 && <p className="mt-3 text-[11px] text-slate-400">还有 {facts.length - 4} 条关联事实已折叠</p>}</Card>;
}

function isAutomatedConsensus(fact) {
  return ["MULTI_SOURCE_AGREEMENT", "RECENCY_WEIGHTED_CONSENSUS", "LATEST_WEIGHTED_PROVISIONAL", "SINGLE_SOURCE_LATEST"].includes(fact.consensus_method);
}

function factConsensusLabel(fact) {
  if (!isAutomatedConsensus(fact)) return "当前记录";
  const confidence = Math.round(Number(fact.consensus_confidence || 0) * 100);
  return `${fact.consensus_method === "LATEST_WEIGHTED_PROVISIONAL" ? "最新暂定" : "自动共识"}${confidence ? ` ${confidence}%` : ""}`;
}

function buildKnowledgeOverview(items) {
  const destinations = [...new Set(items.map((item) => item.destination_name).filter(Boolean))];
  const subjectMap = new Map();
  const themes = knowledgeThemes().map((theme) => ({ ...theme, count: 0 }));
  const sourceIds = new Set();
  let automaticConsensusCount = 0;
  let conflictCount = 0;
  for (const fact of items) {
    const key = String(fact.subject || "未归类地点").trim().toLowerCase();
    if (!subjectMap.has(key)) subjectMap.set(key, { key, name: fact.subject || "未归类地点", facts: [] });
    subjectMap.get(key).facts.push(fact);
    const theme = knowledgeTheme(fact);
    const bucket = themes.find((item) => item.id === theme.id);
    if (bucket) bucket.count += 1;
    if (isAutomatedConsensus(fact)) automaticConsensusCount += 1;
    if (fact.consensus_status === "conflicted") conflictCount += 1;
    for (const sourceKey of factIndependentEvidenceKeys(fact)) sourceIds.add(sourceKey);
  }
  return {
    destinationLabel: destinations.join(" / ") || "目的地",
    subjects: [...subjectMap.values()].sort((a, b) => b.facts.length - a.facts.length || a.name.localeCompare(b.name)),
    themes,
    sourceCount: sourceIds.size,
    factCount: items.length,
    automaticConsensusCount,
    conflictCount,
  };
}

function factIndependentEvidenceKeys(fact) {
  const consensusKeys = (fact?.consensus_detail?.variants || [])
    .flatMap((variant) => variant.independenceKeys || [])
    .filter(Boolean);
  if (consensusKeys.length) return consensusKeys;
  return (fact?.evidence || []).map((evidence) => evidence?.source_id ? `source:${evidence.source_id}` : null).filter(Boolean);
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
  const opportunities = data?.opportunities || [];
  const knowledgeOnly = opportunities.filter((item) => item.status === "knowledge_only");
  const tracked = opportunities.filter((item) => ["approved_waiting_for_evidence","approved_ready","producing","drafted","qa_failed","ready_for_wordpress","wordpress_draft","suppressed"].includes(item.status));
  const opportunityQueue = tracked.length ? <OpportunityQueue items={tracked} /> : null;
  if (knowledgeOnly.length) return <>{opportunityQueue}<ContentFlowWorkspace items={items} knowledgeOnly={knowledgeOnly} onNavigate={onNavigate} onOpenDraft={onOpenDraft} /></>;
  if (!items.length) return <>{opportunityQueue || <EmptyState icon="content" title="暂无可生产的选题" description="当一个目的地具备足够的独立证据并通过建议页审批后，选题会自动出现在这里。" action={() => onNavigate("knowledge")} actionLabel="查看目的地知识" />}</>;
  return <>{opportunityQueue}<SummaryBar title="内容生产说明"><span>这里管理已批准选题的规划、英文草稿、质量审核和 WordPress 草稿投递。</span><span>点击已有草稿的行可查看详情。</span></SummaryBar><TableShell><Table><TableHeader><TableRow><TableHead>选题</TableHead><TableHead>覆盖度</TableHead><TableHead className="hidden md:table-cell">证据</TableHead><TableHead>流程状态</TableHead><TableHead className="hidden lg:table-cell">质检 / WordPress</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id} tabIndex={item.draft_id ? 0 : undefined} role={item.draft_id ? "button" : undefined} className={cn(item.draft_id && "cursor-pointer")} onClick={() => item.draft_id && onOpenDraft(item.draft_id)} onKeyDown={(event) => event.key === "Enter" && item.draft_id && onOpenDraft(item.draft_id)}><TableCell><div className="max-w-md font-medium text-slate-900">{item.draft_title || item.proposed_title}</div><div className="mt-1 max-w-lg text-[11px] leading-relaxed text-slate-400">{item.rationale}</div>{item.suppression_reason && <div className="mt-1 text-[10px] font-medium text-amber-600">已抑制：{item.suppression_reason}</div>}</TableCell><TableCell className="font-medium tabular-nums">{Math.round(item.coverage_score)}%</TableCell><TableCell className="hidden md:table-cell">{item.evidence_count} 个来源 · {item.conflict_count} 项严格冲突<div className="mt-1 text-[10px] text-slate-400">{item.stale_fact_count || 0} 项带日期证据 · {item.verification_fact_count || 0} 项自动时效结论</div></TableCell><TableCell><StatusPill status={item.draft_status || item.brief_status || item.status} /></TableCell><TableCell className="hidden lg:table-cell">{item.qa_score == null ? "—" : `${Math.round(item.qa_score)} · ${item.qa_passed ? "通过" : "未通过"}`}<div className="mt-1 text-[10px] text-slate-400">商品：{label(item.commercial_status || "pending")}（{item.commercial_offer_count || 0}）· WP：{label(item.wordpress_status || "not_synced")}</div></TableCell></TableRow>)}</TableBody></Table></TableShell></>;
}

function OpportunityQueue({ items }) {
  return <Card className="mb-3 p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-slate-900">内容机会状态</p><p className="mt-1 text-xs text-slate-500">批准只作用于精确机会；证据不足会保留批准并自动等待，不会误选同目的地的其他主题。</p></div><span className="text-xs font-semibold tabular-nums">{items.length}</span></div><div className="mt-3 space-y-2">{items.map((item) => <div key={item.id} className="grid gap-2 rounded-xl border border-slate-100 bg-slate-50 p-3 sm:grid-cols-[1fr_auto]"><div><p className="text-xs font-semibold text-slate-800">{item.title}</p><p className="mt-1 text-[10px] text-slate-500">覆盖 {Math.round(item.readiness_score || 0)}% · 缺少：{(item.readiness?.blockingRequirements || []).join("、") || "无阻塞项"}</p></div><StatusPill status={item.status} /></div>)}</div></Card>;
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
  // Strategy 1.4 keeps this tab as read-only WordPress inventory. CMS
  // production and delivery states belong to Content Opportunities.
  const items = data.items || [];
  const summary = <SummaryBar title={`已追踪 ${items.length} 篇文章`}><span>同步：{label(data.sync?.status || "pending")}</span>{data.sync?.last_succeeded_at && <span>最近成功：{formatDate(data.sync.last_succeeded_at)}</span>}{data.sync?.last_error && <span className="text-red-600">{data.sync.last_error}</span>}</SummaryBar>;
  if (!items.length) return <>{summary}<EmptyState icon="wordpress" title="文章库存为空" description="首次同步仍在等待，或者该 WordPress 站点目前没有文章。" /></>;
  return <>{summary}<TableShell><Table><TableHeader><TableRow><TableHead>文章</TableHead><TableHead>状态</TableHead><TableHead className="hidden md:table-cell">固定链接</TableHead><TableHead className="hidden lg:table-cell">修改时间</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="flex items-center gap-1.5 font-medium text-slate-900">{item.post_url ? <a className="inline-flex items-center gap-1 hover:text-blue-600" href={item.post_url} target="_blank" rel="noreferrer">{item.title || "未命名文章"}<ExternalLink className="size-3" /></a> : item.title || "未命名文章"}</div><div className="mt-1 text-[10px] text-slate-400">WordPress #{item.post_id}</div></TableCell><TableCell><StatusPill status={item.status} /></TableCell><TableCell className="hidden md:table-cell">{item.slug}</TableCell><TableCell className="hidden whitespace-nowrap lg:table-cell">{formatDate(item.modified_at)}</TableCell></TableRow>)}</TableBody></Table></TableShell></>;
}

function CommercialView({ data, onGuide, onAction, actionBusy }) {
  const items = data?.items || [];
  const providers = data?.providers || [];
  const opportunities = data?.opportunities || [];
  const queue = data?.queue || [];
  const performance = data?.performance || [];
  const commissionRules = data?.commissionRules || [];
  return <>
    <SummaryBar title={`${providers.length} 个提供商 · ${items.length} 个资产`}><span>{opportunities.length} 个高价值 联盟营销机会</span><span>{queue.length} 个建链任务</span><span>{performance.length} 组归因指标 · {commissionRules.length} 条可维护佣金规则</span></SummaryBar>
    <AffiliateQueue items={queue} onAction={onAction} actionBusy={actionBusy} />
    <SectionTitle title="联盟营销提供商" description="V1 使用人工模式；账号凭证和登录态不进入 CMS" />
    <TableShell><Table><TableHeader><TableRow><TableHead>提供商</TableHead><TableHead>连接方式</TableHead><TableHead>站点 / 语言</TableHead><TableHead>活跃资产</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{providers.map((item) => <TableRow key={item.id}><TableCell><div className="font-medium text-slate-900">{item.display_name}</div><div className="mt-1 text-[10px] text-slate-400">{item.provider_key}</div></TableCell><TableCell>{label(item.connection_mode)}</TableCell><TableCell>{item.site_name || "—"} · {item.default_language || "en"}</TableCell><TableCell className="tabular-nums">{item.active_asset_count || 0}</TableCell><TableCell><StatusPill status={item.status || "configured"} /></TableCell></TableRow>)}</TableBody></Table></TableShell>
    <SectionTitle title="联盟资产登记表" description="支持目的地、区域、路线和精选实体范围" />
    <TableShell><Table><TableHeader><TableRow><TableHead>资产</TableHead><TableHead>范围</TableHead><TableHead>展示类型</TableHead><TableHead>商品类别</TableHead><TableHead className="hidden md:table-cell">提供商</TableHead><TableHead>状态</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell><div className="font-medium text-slate-900">{item.title || item.id}</div><div className="mt-1 text-[10px] text-slate-400">优先级 {item.priority} · {item.language || "en"}</div></TableCell><TableCell>{label(item.scope_type)}<div className="mt-1 text-[10px] text-slate-400">{item.scope_key || item.destination_slug || "global"}</div></TableCell><TableCell>{label(item.asset_type)}</TableCell><TableCell>{label(item.product_category)}</TableCell><TableCell className="hidden md:table-cell">{item.provider}</TableCell><TableCell><StatusPill status={item.active ? "active" : "inactive"} /><div className="mt-1 text-[10px] text-slate-400">{item.valid_until ? `有效至 ${formatDate(item.valid_until)}` : "未设置截止时间"}</div></TableCell></TableRow>)}</TableBody></Table></TableShell>
    {opportunities.length > 0 && <><SectionTitle title="高价值机会" description="仅显示超过人工维护门槛的精度缺口" /><TableShell><Table><TableHeader><TableRow><TableHead>范围</TableHead><TableHead>类别</TableHead><TableHead>评分</TableHead><TableHead className="hidden md:table-cell">原因</TableHead></TableRow></TableHeader><TableBody>{opportunities.map((item) => <TableRow key={item.id}><TableCell>{label(item.scope_type)} · {item.scope_key}</TableCell><TableCell>{label(item.product_category)}</TableCell><TableCell>{Math.round(item.score)}</TableCell><TableCell className="hidden md:table-cell">{item.reason}</TableCell></TableRow>)}</TableBody></Table></TableShell></>}
    {performance.length > 0 && <><SectionTitle title="成效数据" description="展示曝光、点击及后续预订与佣金归因" /><TableShell><Table><TableHeader><TableRow><TableHead>提供商 / 类别</TableHead><TableHead>位置</TableHead><TableHead>曝光次数</TableHead><TableHead>点击 / 点击率</TableHead><TableHead>佣金</TableHead></TableRow></TableHeader><TableBody>{performance.map((item) => <TableRow key={`${item.provider}:${item.category}:${item.slot_key}:${item.destination_slug}`}><TableCell>{item.provider} · {label(item.category)}</TableCell><TableCell>{item.slot_key || "—"}</TableCell><TableCell>{item.impressions}</TableCell><TableCell>{item.clicks} · {Math.round((item.ctr || 0) * 1000) / 10}%</TableCell><TableCell>{Number(item.commission || 0).toFixed(2)}</TableCell></TableRow>)}</TableBody></Table></TableShell></>}
  </>;
}

function AffiliateQueue({ items, onAction, actionBusy }) {
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [scope, setScope] = useState("");
  const [urls, setUrls] = useState({});
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const filtered = useMemo(() => items.filter((item) => (!status || item.status === status)
    && (!category || item.product_category === category) && (!scope || item.scope_type === scope)), [items, status, category, scope]);
  const active = items.filter((item) => ["PENDING", "READY_FOR_MANUAL", "INVALID"].includes(item.status)).length;
  const fieldClass = "rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 outline-none focus:border-slate-400";
  const copy = (value) => navigator.clipboard?.writeText(value);
  const record = (task) => {
    const affiliateUrl = String(urls[task.id] || "").trim();
    if (!affiliateUrl) return;
    onAction("/api/commercial/affiliate-queue/" + encodeURIComponent(task.id) + "/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ affiliateUrl }),
    }, (result) => "已创建 联盟资产 " + (result.asset?.id || ""));
  };
  const exportQueue = async (format) => {
    const result = await onAction("/api/commercial/affiliate-queue/export", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ format, status, product_category: category, scope_type: scope }),
    }, "已生成 " + format.toUpperCase() + " 导出文件");
    if (!result?.content) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([result.content], { type: result.contentType }));
    link.download = result.filename; document.body.appendChild(link); link.click();
    URL.revokeObjectURL(link.href); link.remove();
  };
  const importQueue = async (dryRun) => {
    if (!importFile) return;
    const data = await importFile.text();
    const format = importFile.name.toLowerCase().endsWith(".csv") ? "csv" : "json";
    const result = await onAction("/api/commercial/affiliate-queue/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format, dryRun, data }),
    }, dryRun ? "导入校验已完成" : "有效建链结果已导入");
    if (result) setImportPreview(result);
  };
  return <section className="space-y-3">
    <SectionTitle title="联盟资产建链队列" description="Trip.com 半自动人工建链；CMS 不接触账号、Cookie、登录态或后台页面" />
    <Card className="p-4"><div className="flex flex-wrap items-center gap-2">
      <select aria-label="队列状态" className={fieldClass} value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">全部状态</option>{["PENDING", "READY_FOR_MANUAL", "COMPLETED", "SKIPPED", "INVALID"].map((value) => <option key={value} value={value}>{label(value)}</option>)}
      </select>
      <select aria-label="商品类别" className={fieldClass} value={category} onChange={(event) => setCategory(event.target.value)}>
        <option value="">全部类别</option>{["HOTEL", "FLIGHT", "TRAIN", "ATTRACTION", "TOUR_ACTIVITY", "FLIGHT_HOTEL", "CAR_RENTAL", "AIRPORT_TRANSFER", "PLANNER"].map((value) => <option key={value} value={value}>{label(value)}</option>)}
      </select>
      <select aria-label="范围" className={fieldClass} value={scope} onChange={(event) => setScope(event.target.value)}>
        <option value="">全部范围</option>{["ENTITY", "ROUTE", "AREA", "DESTINATION", "COUNTRY", "CATEGORY", "GLOBAL"].map((value) => <option key={value} value={value}>{label(value)}</option>)}
      </select>
      <Button size="sm" disabled={actionBusy} onClick={() => onAction("/api/commercial/affiliate-queue/seed", { method: "POST" }, "初始 Seed 已同步")}><RefreshCw />同步初始 Seed</Button>
      <Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => exportQueue("csv")}><FileUp />导出 CSV</Button>
      <Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => exportQueue("json")}><FileUp />导出 JSON</Button>
    </div><div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
      <input aria-label="选择 Queue 导入文件" type="file" accept=".csv,.json,text/csv,application/json" className="max-w-full text-xs text-slate-600" onChange={(event) => { setImportFile(event.target.files?.[0] || null); setImportPreview(null); }} />
      <Button size="sm" variant="secondary" disabled={!importFile || actionBusy} onClick={() => importQueue(true)}>校验预览</Button>
      <Button size="sm" disabled={!importFile || !importPreview || actionBusy} onClick={() => importQueue(false)}>导入有效链接</Button>
      {importPreview && <span className="text-[11px] text-slate-500">总计 {importPreview.total} · 有效 {importPreview.valid} · 错误 {importPreview.failed} · 已保护 {importPreview.protected}</span>}
    </div></Card>
    <SummaryBar title={active + " 个待人工处理任务"}><span>共 {items.length} 个，当前筛选显示 {filtered.length} 个</span><span>只需复制 trip_sub1，并回填官方 联盟链接</span></SummaryBar>
    {!filtered.length ? <EmptyState icon="offer" title="当前筛选没有建链任务" description="任务只来自显式 Seed 或达到阈值的高意向 联盟营销机会，不会按城市、路线或实体批量组合生成。" /> :
      <div className="grid gap-3 lg:grid-cols-2">{filtered.map((task) => {
        const guidance = tripTaskGuidance(task);
        const mutable = !["COMPLETED", "SKIPPED"].includes(task.status);
        return <Card key={task.id} className="p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap gap-1.5"><span className="rounded bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">{task.product_category}</span><span className="rounded bg-slate-100 px-2 py-1 text-[10px] font-semibold text-slate-600">{task.scope_type}</span><span className="rounded bg-violet-50 px-2 py-1 text-[10px] font-semibold text-violet-700">{task.asset_type}</span></div><h3 className="mt-2 text-sm font-semibold text-slate-900">{task.suggested_title}</h3><p className="mt-1 text-[11px] text-slate-500">{task.scope_key}</p></div><StatusPill status={task.status} /></div>
          <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700"><b>Trip.com 操作指引</b><ul className="mt-1 space-y-0.5">{guidance.map((line) => <li key={line}>· {line}</li>)}</ul></div>
          <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2"><code className="truncate text-xs font-semibold text-slate-800">{task.trip_sub1}</code><Button size="sm" variant="ghost" onClick={() => copy(task.trip_sub1)}>复制 trip_sub1</Button></div>
          {task.source_trip_url && <Button className="mt-2" size="sm" variant="secondary" onClick={() => copy(task.source_trip_url)}><Link2 />复制 Trip.com URL</Button>}
          <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-slate-500"><span>优先级：{task.priority}</span><span>机会评分：{Math.round(task.score || 0)}</span></div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{task.reason}</p>
          {task.invalid_reason && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-700">{task.invalid_reason}</p>}
          {mutable && <div className="mt-3 space-y-2 border-t border-slate-100 pt-3"><input aria-label={task.suggested_title + " 联盟链接"} className={fieldClass + " w-full"} type="url" value={urls[task.id] || ""} placeholder="粘贴 Trip.com 官方 Affiliate HTTPS URL" onChange={(event) => setUrls((current) => ({ ...current, [task.id]: event.target.value }))} />
            <div className="flex gap-2"><Button size="sm" disabled={actionBusy || !String(urls[task.id] || "").trim()} onClick={() => record(task)}>记录 联盟链接</Button><Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => onAction("/api/commercial/affiliate-queue/" + encodeURIComponent(task.id) + "/skip", { method: "POST" }, "任务已跳过")}>跳过</Button></div></div>}
          {task.affiliate_asset_id && <p className="mt-3 text-[10px] text-emerald-700">联盟资产：{task.affiliate_asset_id}</p>}
        </Card>;
      })}</div>}
  </section>;
}

function tripTaskGuidance(task) {
  if (task.trip_tool_type === "HOTELS") return task.trip_property ? ["打开酒店页面", "酒店：" + task.trip_property] : ["打开酒店页面", "目的地：" + (task.trip_destination || task.destination_slug)];
  if (task.trip_tool_type === "FLIGHTS") return ["打开航班页面", "出发地：" + task.trip_departure, "到达地：" + task.trip_arrival];
  if (task.trip_tool_type === "TRAINS") return ["打开火车票页面", "出发地：" + task.trip_departure, "到达地：" + task.trip_arrival];
  if (task.trip_tool_type === "ATTRACTIONS_TOURS") return ["打开景点与玩乐页面", "选择目的地（必填）：" + (task.trip_destination || task.destination_slug)];
  if (task.trip_tool_type === "FLIGHT_HOTEL") return ["打开机票 + 酒店页面", "出发地（必填）：" + task.trip_departure, "到达地（必填）：" + task.trip_arrival];
  if (task.trip_tool_type === "CAR_RENTALS") return ["打开租车页面", "取车地点：" + task.trip_pickup_location];
  if (task.trip_tool_type === "AIRPORT_TRANSFERS") return ["打开机场接送页面", "填写本任务的 trip_sub1；当前后台没有目的地字段"];
  if (task.trip_tool_type === "HOMEPAGE") return ["打开 Trip.com 首页", "填写本任务的 trip_sub1"];
  if (task.trip_tool_type === "SEARCH_BOX") return ["创建结构化搜索框", "只记录官方 HTTPS 地址和结构化配置；不粘贴 HTML 或脚本"];
  return ["打开自定义链接", task.source_trip_url ? "使用下方已确认的 Trip.com 页面地址" : "查找对应的" + label(task.scope_type) + "页面：" + task.scope_key];
}

function ExceptionsView({ data, onAction, actionBusy }) {
  const items = data?.items || [];
  const manualReviewItems = items.filter((item) => Boolean(item.knowledge?.id || item.entity_alias?.id || item.claim_review?.id));
  if (manualReviewItems.length) return <ExceptionsWorkspace items={items} onAction={onAction} actionBusy={actionBusy} />;
  if (!items.length) return <EmptyState icon="check" title="当前没有需要处理的问题" description="采集、队列和知识库目前没有需要你介入的异常。" healthy />;
  const retry = (item) => onAction(`/api/exceptions/${encodeURIComponent(item.key)}/retry`, { method: "POST" }, "已重新加入处理队列");
  return <div className="space-y-3">
    <SummaryBar title={`${items.length} 个待处理问题`}><span>票价、营业时间、预约和交通等动态差异已由多来源时效共识自动处理；这里只保留系统失败、语义抽取缺失和高后果严格冲突。</span></SummaryBar>
    <section className="space-y-3 md:hidden">{items.map((item) => <Card key={item.key} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold leading-relaxed text-slate-900">{item.title}</h2><p className="mt-1 text-xs text-slate-600">{item.subject}</p></div><StatusPill status={item.severity} /></div><p className="mt-3 text-[11px] leading-relaxed text-slate-500">{item.detail}</p><div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-[10px] text-slate-400"><span>{label(item.kind)}</span><span>{formatDate(item.updatedAt)}</span></div>{item.retryable ? <Button className="mt-3 w-full" variant="secondary" size="sm" disabled={actionBusy} onClick={() => retry(item)}><RotateCcw />重新执行</Button> : <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">需要补充或核验新的证据。当前事实会保留，但不会被用于自动生成内容。</p>}</Card>)}</section>
    <div className="hidden md:block"><TableShell><Table><TableHeader><TableRow><TableHead>问题</TableHead><TableHead>类型</TableHead><TableHead>优先级</TableHead><TableHead className="hidden md:table-cell">更新时间</TableHead><TableHead>处理</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.key}><TableCell><div className="font-medium text-slate-900">{item.title}</div><div className="mt-1 text-xs text-slate-600">{item.subject}</div><div className="mt-1 max-w-xl text-[10px] leading-relaxed text-slate-400">{item.detail}</div></TableCell><TableCell>{label(item.kind)}</TableCell><TableCell><StatusPill status={item.severity} /></TableCell><TableCell className="hidden whitespace-nowrap md:table-cell">{formatDate(item.updatedAt)}</TableCell><TableCell>{item.retryable ? <Button variant="secondary" size="sm" disabled={actionBusy} onClick={() => retry(item)}><RotateCcw />重新执行</Button> : <span className="text-[10px] text-slate-400">需要新的证据</span>}</TableCell></TableRow>)}</TableBody></Table></TableShell></div>
  </div>;
}

function ExceptionsWorkspace({ items, onAction, actionBusy }) {
  const retry = (item) => onAction(`/api/exceptions/${encodeURIComponent(item.key)}/retry`, { method: "POST" }, "已重新加入处理队列");
  const issueGroups = new Set(items.map((item) => item.claim_review?.factGroupKey || item.key)).size;
  const groupedComparisonCount = items.filter((item) => item.claim_review?.factGroupKey).length;
  const summary = issueGroups < items.length
    ? `${issueGroups} 个待处理事项 · ${items.length} 条记录`
    : `${issueGroups} 个待处理事项`;
  return <div className="space-y-3"><SummaryBar title={summary}><span>同一事实组可能产生多条来源比较，但只算一个待处理事项。系统会自动处理同义、细化、可并存和动态时效差异；当前仍含 {groupedComparisonCount} 条需要严格处理的来源比较记录。</span></SummaryBar><div className="grid gap-3 lg:grid-cols-2">{items.map((item) => <Card key={item.key} className="p-4 sm:p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="text-sm font-semibold text-slate-900">{item.title}</h2><p className="mt-1 text-xs text-slate-600">{item.subject}</p></div><StatusPill status={item.severity} /></div><p className="mt-3 text-[11px] leading-relaxed text-slate-500">{item.detail}</p>{item.knowledge?.id ? <KnowledgeConflictResolution item={item} onAction={onAction} actionBusy={actionBusy} /> : item.entity_alias?.id ? <EntityAliasResolution item={item} onAction={onAction} actionBusy={actionBusy} /> : item.claim_review?.id ? <ClaimReviewResolution item={item} onAction={onAction} actionBusy={actionBusy} /> : item.retryable ? <Button className="mt-4" variant="secondary" size="sm" disabled={actionBusy} onClick={() => retry(item)}><RotateCcw />重新执行</Button> : <p className="mt-4 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">需要补充新的来源证据；现有事实会保留，但不会自动用于内容生产。</p>}</Card>)}</div></div>;
}

function EntityAliasResolution({ item, onAction, actionBusy }) {
  const candidate = item.entity_alias;
  const decide = (decision, relationType) => onAction(`/api/knowledge/entity-aliases/candidates/${encodeURIComponent(candidate.id)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, relationType }) }, decision === "same_entity" ? "已确认同一实体；审计快照已保存，可撤销。" : decision === "create_relation" ? "已保持实体分离并建立关系。" : decision === "defer" ? "已保留为暂不判断。" : "已保持为不同实体。");
  return <section className="mt-4 rounded-xl border border-violet-200 bg-violet-50/70 p-3"><p className="text-xs font-semibold text-violet-950">实体身份审核</p><div className="mt-2 grid gap-2 text-[10px] text-violet-900 sm:grid-cols-2"><div className="rounded-lg bg-white/70 p-2"><b>候选实体 A</b><p>{candidate.alias}</p><p>{label(candidate.candidateEntityType)} · {label(candidate.candidateGranularity)}</p></div><div className="rounded-lg bg-white/70 p-2"><b>候选实体 B</b><p>{candidate.proposedCanonicalSubject}</p><p>{label(candidate.proposedEntityType)} · {label(candidate.proposedGranularity)}</p></div></div><p className="mt-2 text-[10px] leading-relaxed text-violet-700">AI 建议：{label(candidate.aiRecommendation || "uncertain")} · {Math.round((candidate.confidence || 0) * 100)}% · {candidate.reason}</p>{candidate.linkedClaims?.length > 0 && <details className="mt-2 text-[10px]"><summary className="cursor-pointer">来源与关联信息主张（{candidate.linkedClaims.length}）</summary><ul className="mt-1 space-y-1">{candidate.linkedClaims.map((claim) => <li key={claim.id}>{claim.source_title}：{claim.source_quote || claim.value_text}</li>)}</ul></details>}<div className="mt-3 flex flex-wrap gap-2"><Button size="sm" disabled={actionBusy} onClick={() => decide("same_entity")}><CheckCircle2 />确认同一实体</Button><Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => decide("different_entity")}>保持不同实体</Button><Button size="sm" variant="secondary" disabled={actionBusy || !candidate.suggestedRelation} onClick={() => decide("create_relation", candidate.suggestedRelation)}>建立关系{candidate.suggestedRelation ? `：${label(candidate.suggestedRelation)}` : ""}</Button><Button size="sm" variant="ghost" disabled={actionBusy} onClick={() => decide("defer")}>暂不判断</Button></div></section>;
}

function ClaimReviewResolution({ item, onAction, actionBusy }) {
  const review = item.claim_review;
  const extractionIssue = String(review.reviewType || "").includes("EXTRACTION_ERROR");
  const claims = [review.claimA, review.claimB].filter(Boolean);
  const evidenceReady = claims.every((claim) => claim.evidence?.available);
  const decide = (decision) => onAction(`/api/knowledge/claim-reviews/${encodeURIComponent(review.id)}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) }, decision === "resolved" ? "已进入最终事实选择；请选择后续写作应采用的值。" : "已确认两条信息可以同时成立，误报已关闭，原始证据保持不变。");
  const retryExtraction = (sourceId) => onAction(`/api/sources/${encodeURIComponent(sourceId)}/retry`, { method: "POST" }, "已重新加入来源提取队列；完成后会重新计算信息主张审核。");
  const fallbackExplanation = extractionIssue
    ? "系统怀疑原文里的否定、条件或限制没有被完整保留下来。请比较原文和整理结果后再选择。"
    : "系统把两条信息归到了同一事实，但无法判断它们是互相补充，还是不能同时成立。";
  return <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
    <div className="rounded-lg border border-amber-200 bg-white/80 p-3">
      <p className="text-xs font-semibold text-amber-950">{extractionIssue ? "系统为什么拦住这条信息？" : "系统为什么拦住这两条信息？"}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-amber-900">{review.explanation || fallbackExplanation}</p>
    </div>
    <div className="mt-3 grid gap-2"><ClaimEvidencePanel title="来源 A" claim={review.claimA} actionBusy={actionBusy} onRetry={retryExtraction} /><ClaimEvidencePanel title="来源 B" claim={review.claimB} actionBusy={actionBusy} onRetry={retryExtraction} /></div>
    {!evidenceReady && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] leading-relaxed text-red-800"><b className="block">证据不完整，当前不能作出结论</b><span>至少一侧没有可核验的原文或图片。系统已禁用结论按钮，请先重新提取缺失证据的来源；完成后异常会自动重新计算。</span></div>}
    {extractionIssue ? <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <div className="rounded-lg border border-amber-200 bg-white p-3"><p className="text-[11px] font-semibold text-slate-900">选项一：原意确实丢了</p><p className="mt-1 text-[10px] leading-relaxed text-slate-600">重新让模型读取该来源。原始证据不会删除，任务会回到处理队列。</p><Button className="mt-2 w-full" size="sm" disabled={actionBusy || !review.claimA.sourceId} onClick={() => retryExtraction(review.claimA.sourceId)}><RotateCcw />原意丢失：重新提取</Button></div>
      <div className="rounded-lg border border-amber-200 bg-white p-3"><p className="text-[11px] font-semibold text-slate-900">选项二：整理结果已经表达原意</p><p className="mt-1 text-[10px] leading-relaxed text-slate-600">例如 contactless 已表达“0 打扰”。关闭这条误报并保留现有结果。</p><Button className="mt-2 w-full" size="sm" variant="secondary" disabled={actionBusy || !evidenceReady} onClick={() => decide("dismissed")}>语义完整：关闭误报</Button></div>
    </div> : <div className="mt-3 grid gap-2 sm:grid-cols-2">
      <div className="rounded-lg border border-amber-200 bg-white p-3"><p className="text-[11px] font-semibold text-slate-900">选项一：两句话不能同时为真</p><p className="mt-1 text-[10px] leading-relaxed text-slate-600">仅用于同一对象、同一时间和同一条件下互相否定的情况。下一步需要选择最终事实。</p><Button className="mt-2 w-full" size="sm" disabled={actionBusy || !evidenceReady} onClick={() => decide("resolved")}><CheckCircle2 />确实矛盾：选择最终事实</Button></div>
      <div className="rounded-lg border border-amber-200 bg-white p-3"><p className="text-[11px] font-semibold text-slate-900">选项二：两句话可以同时为真</p><p className="mt-1 text-[10px] leading-relaxed text-slate-600">适用于不同译法、概括与详情、或互相补充的描述。两条证据都会保留。</p><Button className="mt-2 w-full" size="sm" variant="secondary" disabled={actionBusy || !evidenceReady} onClick={() => decide("dismissed")}>可以同时成立：关闭误报</Button></div>
    </div>}
  </section>;
}

function ClaimEvidencePanel({ title, claim, actionBusy, onRetry }) {
  if (!claim) return null;
  const evidence = claim.evidence || {};
  const placeholder = /^\s*\[(?:image|video)\]\s*$/iu.test(String(claim.originalSentence || ""));
  return <div className="rounded-lg border border-slate-200 bg-white p-3">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><b className="text-[11px] text-slate-800">{title}</b><p className="mt-0.5 text-[10px] text-slate-500">{evidence.source?.title || "未记录来源标题"}{evidence.source?.authorName ? ` · ${evidence.source.authorName}` : ""}</p></div>{evidence.source?.canonicalUrl && <a className="inline-flex items-center gap-1 text-[10px] font-medium text-blue-700 hover:underline" href={evidence.source.canonicalUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-3" />打开原始来源</a>}</div>
    <b className="mt-3 block text-[10px] text-slate-500">原始证据</b>
    {placeholder ? <p className="mt-1 text-[11px] text-slate-700">这条信息由图片识别得出，请核对下方对应图片。</p> : <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-800">{evidence.exactQuote || claim.originalSentence || "未保存原句"}</p>}
    {evidence.textExcerpt && <details className="mt-2 rounded-md bg-slate-50 p-2 text-[10px] text-slate-600"><summary className="cursor-pointer font-medium text-slate-700">查看来源原文上下文</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{evidence.textExcerpt}</p></details>}
    {evidence.assets?.length > 0 && <div className="mt-2"><p className="mb-1.5 text-[10px] text-slate-500">{evidence.assets.every((asset) => asset.matched) ? "与该信息主张关联的图片" : "来源中的候选图片（旧记录未保存精确图片映射）"}</p><div className="grid gap-2 sm:grid-cols-2">{evidence.assets.map((asset) => <figure key={asset.id} className="overflow-hidden rounded-md border border-slate-200 bg-slate-50"><img className="max-h-72 w-full bg-slate-100 object-contain" src={asset.previewUrl} alt={asset.altText || `${title}证据图片`} loading="lazy" /><figcaption className="flex items-center justify-between gap-2 px-2 py-1.5 text-[9px] text-slate-500"><span>图片 {Number(asset.position ?? 0) + 1}{asset.matched ? " · 精确关联" : " · 候选"}</span>{asset.originalUrl && <a className="text-blue-700 hover:underline" href={asset.originalUrl} target="_blank" rel="noreferrer">打开原图</a>}</figcaption></figure>)}</div></div>}
    {!evidence.available && <p className="mt-2 rounded-md bg-red-50 px-2 py-1.5 text-[10px] leading-relaxed text-red-700">{evidence.reason || "没有可核验的原文或图片。"}</p>}
    <b className="mt-3 block text-[10px] text-slate-500">系统整理成</b><p className="mt-1 text-[11px] text-slate-800">{claim.normalized.subject} · {claim.normalized.predicate} = {claim.normalized.value}</p>
    {claim.sourceId && <Button className="mt-2" size="sm" variant="outline" disabled={actionBusy} onClick={() => onRetry(claim.sourceId)}><RotateCcw />重新提取该来源</Button>}
  </div>;
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
  return <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/70 p-3"><div className="rounded-lg border border-amber-200 bg-white/80 p-3"><p className="text-xs font-semibold text-amber-950">现在需要你决定什么？</p><p className="mt-1.5 text-[11px] leading-relaxed text-amber-900">系统确认这些值不能自动同时采用。请选择后续文章应当使用的最终事实。选择某一项表示“采用这条作为标准答案”，不会删除原始来源。</p></div>{choices.length > 0 && <div className="mt-3 space-y-2">{choices.map((value) => <label key={value} className={cn("flex cursor-pointer gap-2 rounded-lg border p-3 text-[11px] transition", selected === value && !customValue ? "border-amber-400 bg-white" : "border-amber-100 bg-white/70")}><input className="mt-0.5" type="radio" name={`resolution-${item.knowledge.id}`} checked={selected === value && !customValue} onChange={() => { setSelected(value); setCustomValue(""); }} /><span><b className="block text-slate-900">采用这条作为最终事实</b><span className="mt-1 block text-slate-700">{value}</span></span></label>)}</div>}<label className="mt-3 block text-[10px] font-medium text-slate-600">以上都不准确：输入正确事实<input value={customValue} onChange={(event) => setCustomValue(event.target.value)} placeholder="输入后将采用这里的内容，不再采用上面的候选值" className="mt-1.5 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-amber-400" /></label><label className="mt-3 block text-[10px] font-medium text-slate-600">为什么这样判断（可选）<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：已对照景区官网的最新公告" className="mt-1.5 min-h-16 w-full rounded-lg border border-amber-200 bg-white px-3 py-2 text-xs text-slate-900 outline-none focus:border-amber-400" /></label><p className="mt-3 text-[10px] leading-relaxed text-amber-900">保存后的结果：该异常会离开待处理列表，后续选题和文章将采用你选择或输入的值；所有来源证据仍会保留。</p><Button className="mt-2 w-full" size="sm" disabled={actionBusy || !preferredValue} onClick={resolve}><CheckCircle2 />保存为最终事实</Button></section>;
}

function MaintenanceView({ data, onAction, actionBusy }) {
  const telemetry = data?.telemetry || { active: 0, oldestQueuedAgeSeconds: 0, windowHours: 24, recent: { completed: 0, failed: 0, successRate: null, queueLatencyMs: {}, durationMs: {} }, types: [] };
  const recent = telemetry.recent;
  const favoritesRuns = data?.favoritesSyncRuns || [];
  const notifications = data?.notifications || { configured: false, failed: 0, repeatHours: 24, minimumSeverity: "blocker" };
  const wordpress = data?.wordpressSync;
  const searchConsole = data?.searchConsoleSync;
  const resetDerivedResearch = () => {
    if (!window.confirm("确认清空知识库、信息主张、建议、蓝图和内容生产结果，并保留原始来源后重新处理吗？")) return;
    onAction("/api/maintenance/reset-derived-research", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation: "RESET_DERIVED_RESEARCH" }),
    }, (result) => `已保留 ${result.preservedSources || 0} 个原始来源，并重新加入 Strategy 1.4 处理队列。`);
  };
  const cards = [
    [Activity, "活动队列", telemetry.active, telemetry.oldestQueuedAgeSeconds ? `最久等待 ${formatDuration(telemetry.oldestQueuedAgeSeconds * 1000)}` : "没有等待中的任务", telemetry.active ? "warning" : "success"],
    [CheckCircle2, "成功率", recent.successRate == null ? "—" : `${recent.successRate}%`, `${telemetry.windowHours} 小时内完成 ${recent.completed} 个任务`, recent.failed ? "warning" : "success"],
    [Clock3, "排队耗时 p95", formatDuration(recent.queueLatencyMs?.p95), `${recent.queueLatencyMs?.samples || 0} 个采样任务`, "info"],
    [Gauge, "处理耗时 p95", formatDuration(recent.durationMs?.p95), `${recent.durationMs?.samples || 0} 个采样任务`, "info"],
    [Webhook, "异常通知", notifications.configured ? notifications.failed ? "投递异常" : notifications.lastSentAt ? "已连接" : "就绪" : "未配置", notifications.configured ? `每 ${notifications.repeatHours} 小时重复 · ${notifications.minimumSeverity} 及以上` : "可选 HTTPS Webhook", notifications.failed ? "danger" : notifications.configured ? "success" : "default"],
  ];
  return <>
    <section aria-label="运行健康状况" className="grid grid-cols-2 gap-2.5 lg:grid-cols-5">
      {cards.map(([Icon, title, value, detail, tone]) => <OperationCard key={title} icon={Icon} title={title} value={value} detail={detail} tone={tone} className={title === "异常通知" ? "col-span-2 lg:col-span-1" : ""} />)}
    </section>
    <SummaryBar title={data?.enabled ? "自动维护已启用" : "自动维护已停用"} action={<Button size="sm" disabled={!data?.enabled || actionBusy} onClick={() => onAction("/api/maintenance/run", { method: "POST" }, "维护任务已完成")}><RefreshCw className={cn(actionBusy && "animate-spin")} /> 立即运行</Button>}><span>每 {data?.intervalMinutes || 15} 分钟检查一次</span><span>{label(data?.logging?.format || "json")} 日志</span></SummaryBar>
    {favoritesRuns.length > 0 && <><SectionTitle title="小红书收藏同步" description="仅保存聚合进度，不包含账号、Cookie 或浏览器会话数据" /><TableShell><Table><TableHeader><TableRow><TableHead>收藏范围</TableHead><TableHead>状态</TableHead><TableHead>扫描 / 新增</TableHead><TableHead>接收 / 重复</TableHead><TableHead className="hidden md:table-cell">失败</TableHead><TableHead className="hidden lg:table-cell">更新时间 / 耗时</TableHead></TableRow></TableHeader><TableBody>{favoritesRuns.map((run) => <TableRow key={run.session_id}><TableCell><p className="font-medium text-slate-900">{run.scope_label || "小红书收藏"}</p><p className="max-w-64 truncate text-[10px] text-slate-500">{run.mode === "full" ? "完整历史同步" : "增量同步"}</p></TableCell><TableCell><StatusPill status={run.status} /></TableCell><TableCell>{run.stats?.discovered || 0} / {run.stats?.new || 0}</TableCell><TableCell>{run.stats?.captured || 0} / {run.stats?.duplicate || 0}</TableCell><TableCell className="hidden md:table-cell">{run.stats?.failed || 0}</TableCell><TableCell className="hidden lg:table-cell"><p>{formatDate(run.updated_at)}</p><p className="text-[10px] text-slate-500">{formatDuration(run.duration_ms)}</p></TableCell></TableRow>)}</TableBody></Table></TableShell></>}
    <SectionTitle title="维护任务" description="持久化调度在服务重启后继续生效" />
    <TableShell><Table><TableHeader><TableRow><TableHead>任务</TableHead><TableHead>状态</TableHead><TableHead className="hidden md:table-cell">上次成功</TableHead><TableHead>处理项</TableHead><TableHead className="hidden lg:table-cell">结果</TableHead></TableRow></TableHeader><TableBody>{(data?.runs || []).map((run) => <TableRow key={run.task_key}><TableCell className="font-medium text-slate-900">{maintenanceLabel(run.task_key)}</TableCell><TableCell><StatusPill status={run.status} /></TableCell><TableCell className="hidden whitespace-nowrap md:table-cell">{formatDate(run.last_succeeded_at)}</TableCell><TableCell>{run.item_count}</TableCell><TableCell className="hidden max-w-xl text-[11px] lg:table-cell">{run.last_error || maintenanceResult(run.metadata)}</TableCell></TableRow>)}<IntegrationRow title="WordPress 文章库存" state={wordpress} result="只读同步站点文章" /><IntegrationRow title="Search Console 查询" state={searchConsole} result="只读检测搜索内容冲突" /></TableBody></Table></TableShell>
    {telemetry.types?.length > 0 && <><SectionTitle title="任务性能" description={`最近 ${telemetry.windowHours} 小时`} /><TableShell><Table><TableHeader><TableRow><TableHead>任务类型</TableHead><TableHead>排队</TableHead><TableHead>运行中</TableHead><TableHead>已完成</TableHead><TableHead>成功率</TableHead><TableHead className="hidden md:table-cell">p95 耗时</TableHead></TableRow></TableHeader><TableBody>{telemetry.types.map((item) => <TableRow key={item.type}><TableCell className="font-medium text-slate-900">{maintenanceLabel(item.type)}</TableCell><TableCell>{item.queued}</TableCell><TableCell>{item.running}</TableCell><TableCell>{item.completed}</TableCell><TableCell>{item.completed ? `${Math.round(item.succeeded / item.completed * 100)}%` : "—"}</TableCell><TableCell className="hidden md:table-cell">{formatDuration(item.durationP95Ms)}</TableCell></TableRow>)}</TableBody></Table></TableShell></>}
    <Card className="border-amber-200 bg-amber-50/60 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-semibold text-amber-950">研究派生数据重建</p><p className="mt-1 text-[11px] leading-relaxed text-amber-800">清空旧信息主张、知识、建议、蓝图和内容生产结果；保留原始来源、文件与授权图片，并按内容策略 1.4 重新处理。</p></div><Button variant="secondary" size="sm" disabled={actionBusy} onClick={resetDerivedResearch}><RotateCcw />清空并重新处理</Button></div></Card>
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
  if (metadata?.backup) return `${metadata.backup} · 数据库结构 ${metadata.schemaVersion} · ${metadata.bytes} 字节 · SHA ${metadata.sha256?.slice(0, 12) || "—"}`;
  if (metadata?.retentionDays) return `保留 ${metadata.retentionDays} 天`;
  return "已完成";
}

function maintenanceLabel(value) {
  return ({ database_backup: "数据库备份", entity_resolution: "实体归并", job_history_cleanup: "任务历史清理", knowledge_reconciliation: "知识库重建",
    rebuild_knowledge: "重建知识库", rebuild_topics: "重建主题", rebuild_topic_clusters: "重建主题簇", build_coverage_matrix: "构建覆盖矩阵",
    rebuild_content_opportunities: "重建内容机会", reconcile_approved_opportunities: "恢复已批准机会", generate_visuals: "生成配图",
    resolve_entities: "解析实体", review_draft: "审核草稿", revise_draft: "修订草稿", analyze_intake: "分析来源",
    analyze_source_diagnostic: "来源诊断", analyze_source_blueprint: "分析来源蓝图", analyze_source_family: "分析来源家族",
    extract_source: "提取来源", preflight_source: "来源预检", segment_source: "来源分段",
    extract_segment_claims: "分段提取 Claim", audit_segment_coverage: "审计分段覆盖", retry_segment_extraction: "定向补漏提取",
    finalize_source_extraction: "完成来源提取", rebuild_editorial: "重建编辑蓝图", compose_frontend_page: "组合前端页面",
    compose_commercial: "组合商业层", compose_publish_page: "组合发布页面", push_wordpress_draft: "投递 WordPress 草稿" })[value] || label(value);
}
