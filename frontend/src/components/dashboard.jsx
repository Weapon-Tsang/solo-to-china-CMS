import {
  AlertTriangle, Bell, BookOpen, Bot, Box, Check, CircleAlert, Database, FileCheck2,
  FileText, Gauge, Inbox, Layers3, Library, PanelTop, RefreshCw, Route, Search, Settings2, Sparkles,
  TicketCheck, WandSparkles,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, label } from "@/lib/utils";

export const views = {
  sources: { label: "来源", title: "研究来源", description: "查看并提交由你主动选择的旅行笔记、链接、文档与图片。", icon: FileText },
  recommendations: { label: "建议", title: "内容建议", description: "在文章规划前，审阅每条来源的下一步建议。", icon: Sparkles },
  knowledge: { label: "知识库", title: "目的地知识", description: "集中查看已佐证事实、冲突和时效性。", icon: BookOpen },
  blueprints: { label: "蓝图", title: "编辑蓝图", description: "把重复出现的优秀表达转化为可复用的编辑洞察。", icon: Layers3 },
  content: { label: "内容", title: "内容生产", description: "将有证据支撑的主题推进至草稿、审核和发布。", icon: WandSparkles },
  wordpress: { label: "WordPress", title: "WordPress 文章库存", description: "同步既有文章，避免新选题与站内内容重复。", icon: PanelTop },
  commercial: { label: "商品", title: "商业商品", description: "管理独立的联盟层，不污染研究知识库。", icon: TicketCheck },
  exceptions: { label: "异常", title: "需要处理", description: "只显示真正需要人工判断或介入的问题。", icon: CircleAlert },
  maintenance: { label: "维护", title: "系统维护", description: "静默完成备份、校验、同步和清理。", icon: Gauge },
  settings: { label: "设置", title: "系统设置", description: "选择用于提取、规划、写作和审核的 AI 模型。", icon: Settings2 },
};

export const emptyIcons = {
  source: FileText,
  knowledge: Library,
  blueprint: Sparkles,
  content: WandSparkles,
  wordpress: PanelTop,
  offer: TicketCheck,
  check: Check,
  offline: CircleAlert,
  config: Settings2,
  search: Search,
  inbox: Inbox,
};

const metricStyles = [
  [FileText, "bg-blue-50 text-blue-600"],
  [Bot, "bg-violet-50 text-violet-600"],
  [BookOpen, "bg-cyan-50 text-cyan-600"],
  [Route, "bg-indigo-50 text-indigo-600"],
  [FileCheck2, "bg-emerald-50 text-emerald-600"],
  [PanelTop, "bg-sky-50 text-sky-600"],
  [Box, "bg-fuchsia-50 text-fuchsia-600"],
  [CircleAlert, "bg-amber-50 text-amber-600"],
];

export function Topbar({ health, refreshing, onRefresh }) {
  const healthy = health?.ok !== false;
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-slate-50/85 backdrop-blur-xl">
      <div className="mx-auto flex h-[52px] w-full max-w-[1440px] items-center justify-between px-3 sm:h-14 sm:px-6 lg:px-8">
        <a href="/" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-slate-900">
          <span className="grid size-8 place-items-center rounded-lg bg-slate-900 text-white shadow-sm"><Database className="size-4" /></span>
          <span>SoloToChina</span><span className="hidden border-l border-slate-200 pl-2.5 font-normal text-slate-400 sm:inline">内容研究引擎</span>
        </a>
        <div className="flex items-center gap-2">
          <Badge variant={healthy ? "success" : "destructive"} className="h-7 max-w-36 px-2 sm:max-w-64 sm:px-2.5">
            <span className="relative flex size-2">
              {healthy && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
              <span className={cn("relative inline-flex size-2 rounded-full", healthy ? "bg-emerald-500" : "bg-red-500")} />
            </span>
            <span className="truncate sm:hidden">{healthy ? "服务就绪" : "服务离线"}</span><span className="hidden truncate sm:inline">{health?.aiConfigured ? `${health.aiProvider === "vertex" ? "Vertex AI" : "Kimi"} · ${health.aiModel || "已配置"}` : healthy ? "采集服务就绪 · AI 未配置" : "服务离线"}</span>
          </Badge>
          <Button variant="ghost" size="sm" aria-label="刷新最新状态" title="刷新最新状态" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && "animate-spin")} /><span className="hidden sm:inline">刷新状态</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function PageHeading({ view, health, onOpenStrategy }) {
  const config = views[view];
  const Icon = config.icon;
  return (
    <section className="flex flex-col justify-between gap-3 sm:gap-4 sm:flex-row sm:items-end">
      <div>
        <Badge variant="info" className="mb-2 sm:mb-3"><Icon className="size-3" /> 内容研究</Badge>
        <h1 className="text-[1.65rem] font-semibold tracking-tight text-slate-900 sm:text-3xl">{config.title}</h1>
        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slate-500 sm:mt-2 sm:text-sm">{config.description}</p>
      </div>
      <div className="flex items-center gap-2"><button type="button" onClick={onOpenStrategy} title="阅读或下载当前内容生产策略" className="inline-flex h-7 items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 text-[11px] font-medium text-blue-700 transition hover:border-blue-300 hover:bg-blue-100"><FileText className="size-3" /><span>策略 v{health?.contentStrategy?.version || "—"}</span><span className="hidden sm:inline">阅读</span></button><Badge variant="success" className="hidden h-7 px-2.5 sm:inline-flex"><Check className="size-3" /> 采集服务就绪</Badge></div>
    </section>
  );
}

export function Metrics({ totals = {}, onNavigate }) {
  const groups = [
    {
      icon: FileText, tone: "blue", eyebrow: "研究资产", title: "来源已结构化", value: totals.knowledgeFacts ?? 0, unit: "条知识事实",
      detail: totals.conflicts ? `${totals.conflicts} 项冲突需要处理` : "暂无事实冲突", stats: [[totals.sources, "来源"], [totals.claims, "信息主张"]], view: "knowledge",
    },
    {
      icon: Route, tone: "indigo", eyebrow: "内容机会", title: "选题发现", value: totals.topicCandidates ?? 0, unit: "个候选主题",
      detail: totals.topicCandidates ? "查看候选主题与文章生产状态" : "继续积累独立来源以发现选题", stats: [[totals.draftsReady, "可用草稿"], [totals.wordpressInventory, "站内文章"]], view: "content",
    },
    {
      icon: Box, tone: "fuchsia", eyebrow: "商业图层", title: "联盟商品", value: totals.activeOffers ?? 0, unit: "个可用商品",
      detail: totals.activeOffers ? "仅在质检通过后叠加到发布稿" : "未配置也不影响研究与写作", stats: [[totals.wordpressInventory, "WordPress 库存"], [totals.draftsReady, "待投递草稿"]], view: "commercial",
    },
    {
      icon: CircleAlert, tone: totals.exceptions ? "amber" : "emerald", eyebrow: "系统健康", title: totals.exceptions ? "需要关注" : "运行正常", value: totals.exceptions ?? 0, unit: "个待处理异常",
      detail: totals.exceptions ? "查看待判断问题与处理入口" : "采集、队列与维护状态正常", stats: [[totals.conflicts, "知识冲突"], [totals.sources, "已采集来源"]], view: "exceptions",
    },
  ];
  return (
    <section aria-label="工作台总览" className="grid grid-cols-2 gap-2 sm:gap-2.5 md:grid-cols-4">
      {groups.map((group) => <MetricGroup key={group.eyebrow} {...group} onNavigate={onNavigate} />)}
    </section>
  );
}

function MetricGroup({ icon: Icon, tone, eyebrow, title, value, unit, detail, stats, view, onNavigate }) {
  const tones = {
    blue: "border-blue-100/90 from-blue-50/90 to-white text-blue-700 ring-blue-100",
    indigo: "border-indigo-100/90 from-indigo-50/90 to-white text-indigo-700 ring-indigo-100",
    fuchsia: "border-fuchsia-100/90 from-fuchsia-50/90 to-white text-fuchsia-700 ring-fuchsia-100",
    emerald: "border-emerald-100/90 from-emerald-50/90 to-white text-emerald-700 ring-emerald-100",
    amber: "border-amber-100/90 from-amber-50/90 to-white text-amber-700 ring-amber-100",
  };
  return <Card className={cn("group relative min-w-0 overflow-hidden border bg-gradient-to-br p-2.5 shadow-sm transition duration-200 sm:p-3", onNavigate ? "cursor-pointer sm:hover:-translate-y-0.5 sm:hover:shadow-md" : "", tones[tone])}>
    {onNavigate && <button type="button" aria-label={`查看${title}`} onClick={() => onNavigate(view)} className="absolute inset-0 z-10 rounded-xl focus:outline-none focus-visible:ring-4 focus-visible:ring-slate-300"><span className="sr-only">查看{title}</span></button>}
    <div className="absolute -right-6 -top-6 size-20 rounded-full bg-current opacity-[0.035]" />
    <div className="relative flex items-start justify-between gap-2"><div className="min-w-0"><p className="hidden truncate text-[9px] font-semibold uppercase tracking-[0.12em] opacity-70 sm:block">{eyebrow}</p><h2 className="truncate text-[11px] font-semibold text-slate-900 sm:mt-0.5 sm:text-xs">{title}</h2></div><span className="grid size-6 shrink-0 place-items-center rounded-lg bg-white/80 shadow-sm ring-1 sm:size-7"><Icon className="size-3 sm:size-3.5" /></span></div>
    <div className="relative mt-1.5 flex min-w-0 items-end gap-1 sm:mt-2 sm:gap-1.5"><strong className="text-xl font-semibold tracking-tight text-slate-950 tabular-nums sm:text-2xl">{value ?? 0}</strong><span className="truncate pb-0.5 text-[9px] font-medium text-slate-500 sm:text-[10px]">{unit}</span></div>
    <p className="relative mt-1 hidden truncate text-[10px] leading-relaxed text-slate-500 sm:block">{detail}</p>
    <div className="relative mt-2 hidden gap-1.5 sm:flex">{stats.map(([statValue, statLabel]) => <div key={statLabel} className="min-w-0 rounded-md bg-white/55 px-1.5 py-1"><span className="mr-1 text-xs font-semibold text-slate-900 tabular-nums">{statValue ?? 0}</span><span className="text-[9px] text-slate-500">{statLabel}</span></div>)}{onNavigate && <span className="ml-auto self-center text-[9px] font-medium text-slate-500">点击查看</span>}</div>
  </Card>;
}

export function AiAlert({ onConfigure }) {
  return (
    <Alert className="flex-wrap sm:flex-nowrap">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <AlertTitle>AI 提取已暂停</AlertTitle>
        <AlertDescription>请在“设置”中配置 AI 模型后，系统才会处理排队中的图文提取、信息主张和编辑蓝图；已采集的来源不会丢失。</AlertDescription>
      </div>
      <Button variant="outline" size="sm" className="w-full border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100 sm:w-auto" onClick={onConfigure}>前往设置</Button>
    </Alert>
  );
}

export function EmptyState({ icon = "inbox", title, description, action, actionLabel, healthy = false }) {
  const Icon = emptyIcons[icon] || Inbox;
  return (
    <Card className="flex min-h-52 flex-col items-center justify-center px-5 py-9 text-center sm:min-h-72 sm:px-6 sm:py-12">
      <span className={cn("mb-4 grid size-12 place-items-center rounded-xl border", healthy ? "border-emerald-100 bg-emerald-50 text-emerald-600" : "border-slate-200 bg-slate-50 text-slate-400")}>
        <Icon className="size-5" strokeWidth={1.6} />
      </span>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">{description}</p>
      {action && <Button size="sm" className="mt-5" onClick={action}>{actionLabel}<Sparkles className="size-3.5" /></Button>}
    </Card>
  );
}

export function LoadingView() {
  return (
    <Card className="p-5">
      <div className="space-y-4">
        {[0, 1, 2, 3].map((item) => <div className="flex items-center gap-4" key={item}><Skeleton className="size-9 rounded-lg" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-2.5 w-2/3" /></div><Skeleton className="h-6 w-16 rounded-full" /></div>)}
      </div>
    </Card>
  );
}

export function TableShell({ children, className }) {
  return <Card className={cn("overflow-hidden shadow-sm", className)}>{children}</Card>;
}

export function StatusPill({ status }) {
  const normalized = String(status || "").toLowerCase();
  const variant = ["processed", "corroborated", "resolved", "succeeded", "publish", "active", "ready", "configured", "ready_for_wordpress"].includes(normalized)
    ? "success" : ["exception", "conflicted", "blocker", "failed"].includes(normalized)
      ? "destructive" : ["warning", "needs_ai", "pending", "retry", "time_sensitive"].includes(normalized)
        ? "warning" : ["candidate", "queued", "running", "single_source"].includes(normalized) ? "info" : "default";
  return <Badge variant={variant}>{label(status || "unknown")}</Badge>;
}

export function SummaryBar({ title, children, action }) {
  return <Card className="mb-3 flex flex-wrap items-center gap-2.5 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3"><strong className="text-xs font-semibold text-slate-900">{title}</strong><div className="flex flex-1 flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500 sm:gap-x-4">{children}</div>{action}</Card>;
}

export function Toast({ message, error }) {
  if (!message) return null;
  return <div className={cn("fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-3 right-3 z-[100] flex max-w-sm items-center gap-2 rounded-xl border px-4 py-3 text-xs font-medium shadow-xl backdrop-blur sm:bottom-4 sm:left-auto sm:right-4", error ? "border-red-200 bg-red-600/95 text-white" : "border-slate-700 bg-slate-900/95 text-white")}><Bell className="size-4" />{message}</div>;
}

export function SectionTitle({ title, description }) {
  return <div className="mb-2 mt-6 flex items-baseline gap-2 px-0.5"><h3 className="text-xs font-semibold text-slate-900">{title}</h3>{description && <span className="text-[10px] text-slate-400">{description}</span>}</div>;
}
