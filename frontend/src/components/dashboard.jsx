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
  sources: { label: "来源", title: "研究来源", description: "查看每一条由你亲自挑选并保存的旅行笔记。", icon: FileText },
  recommendations: { label: "建议", title: "内容建议", description: "在文章规划前，审阅每条来源的下一步建议。", icon: Sparkles },
  knowledge: { label: "知识库", title: "目的地知识", description: "集中查看已佐证事实、冲突和时效性。", icon: BookOpen },
  blueprints: { label: "蓝图", title: "编辑蓝图", description: "把重复出现的优秀表达转化为可复用的编辑洞察。", icon: Layers3 },
  content: { label: "内容", title: "内容生产", description: "将有证据支撑的主题推进至草稿、审核和发布。", icon: WandSparkles },
  wordpress: { label: "WordPress", title: "WordPress inventory", description: "Keep new topics distinct from posts already in your CMS.", icon: PanelTop },
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
      <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <a href="/" className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-slate-900">
          <span className="grid size-8 place-items-center rounded-lg bg-slate-900 text-white shadow-sm"><Database className="size-4" /></span>
          <span>SoloToChina</span><span className="hidden border-l border-slate-200 pl-2.5 font-normal text-slate-400 sm:inline">Research Engine</span>
        </a>
        <div className="flex items-center gap-2">
          <Badge variant={healthy ? "success" : "destructive"} className="h-7 px-2.5">
            <span className="relative flex size-2">
              {healthy && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
              <span className={cn("relative inline-flex size-2 rounded-full", healthy ? "bg-emerald-500" : "bg-red-500")} />
            </span>
            <span className="max-w-40 truncate">{health?.aiConfigured ? `Kimi · ${health.aiModel || "configured"}` : healthy ? "Capture ready · Kimi paused" : "Engine offline"}</span>
          </Badge>
          <Button variant="ghost" size="sm" aria-label="刷新最新状态" title="刷新最新状态" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && "animate-spin")} /> 刷新状态
          </Button>
        </div>
      </div>
    </header>
  );
}

export function PageHeading({ view, health }) {
  const config = views[view];
  const Icon = config.icon;
  return (
    <section className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <Badge variant="info" className="mb-3"><Icon className="size-3" /> Content intelligence</Badge>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{config.title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">{config.description}</p>
      </div>
      <div className="hidden items-center gap-2 sm:flex"><Badge variant="info" className="h-7 px-2.5">Content Strategy v{health?.contentStrategy?.version || "—"}</Badge><Badge variant="success" className="h-7 px-2.5"><Check className="size-3" /> Capture service ready</Badge></div>
    </section>
  );
}

export function Metrics({ totals = {} }) {
  const items = [
    [totals.sources, "Sources"],
    [totals.claims, "Claims"],
    [totals.knowledgeFacts, "Knowledge", totals.conflicts ? `${totals.conflicts} conflicts` : "No conflicts"],
    [totals.topicCandidates, "Topics"],
    [totals.draftsReady, "Drafts ready"],
    [totals.wordpressInventory, "WordPress"],
    [totals.activeOffers, "Offers"],
    [totals.exceptions, "Exceptions"],
  ];
  return (
    <section aria-label="Pipeline overview" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:grid-cols-8">
      {items.map(([value, text, meta], index) => {
        const [Icon, iconClass] = metricStyles[index];
        return (
          <Card key={text} className="group p-3.5 transition duration-200 hover:-translate-y-0.5 hover:border-slate-300/80 hover:shadow-md">
            <div className="flex items-center justify-between gap-2">
              <span className={cn("grid size-8 place-items-center rounded-lg", iconClass)}><Icon className="size-4" /></span>
              <strong className="text-xl font-bold tracking-tight text-slate-900 tabular-nums">{value ?? 0}</strong>
            </div>
            <div className="mt-3 truncate text-[11px] font-medium text-slate-500">{text}</div>
            {meta && <div className={cn("mt-0.5 truncate text-[9px]", totals.conflicts ? "text-amber-600" : "text-slate-400")}>{meta}</div>}
          </Card>
        );
      })}
    </section>
  );
}

export function AiAlert({ onConfigure }) {
  return (
    <Alert className="flex-wrap sm:flex-nowrap">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <AlertTitle>Kimi extraction is paused</AlertTitle>
        <AlertDescription>Configure KIMI_API_KEY to process queued multimodal claims and blueprints. Existing captures remain safe.</AlertDescription>
      </div>
      <Button variant="outline" size="sm" className="w-full border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100 sm:w-auto" onClick={onConfigure}>View setup</Button>
    </Alert>
  );
}

export function EmptyState({ icon = "inbox", title, description, action, actionLabel, healthy = false }) {
  const Icon = emptyIcons[icon] || Inbox;
  return (
    <Card className="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
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
  return <Card className={cn("overflow-hidden", className)}>{children}</Card>;
}

export function StatusPill({ status }) {
  const normalized = String(status || "").toLowerCase();
  const variant = ["processed", "corroborated", "succeeded", "publish", "active", "ready", "configured", "ready_for_wordpress"].includes(normalized)
    ? "success" : ["exception", "conflicted", "blocker", "failed"].includes(normalized)
      ? "destructive" : ["warning", "needs_ai", "pending", "retry", "time_sensitive"].includes(normalized)
        ? "warning" : ["candidate", "queued", "running"].includes(normalized) ? "info" : "default";
  return <Badge variant={variant}>{label(status || "unknown")}</Badge>;
}

export function SummaryBar({ title, children, action }) {
  return <Card className="mb-3 flex flex-wrap items-center gap-3 px-4 py-3"><strong className="text-xs font-semibold text-slate-900">{title}</strong><div className="flex flex-1 flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">{children}</div>{action}</Card>;
}

export function Toast({ message, error }) {
  if (!message) return null;
  return <div className={cn("fixed right-4 bottom-4 z-[100] flex max-w-sm items-center gap-2 rounded-xl border px-4 py-3 text-xs font-medium shadow-xl backdrop-blur", error ? "border-red-200 bg-red-600/95 text-white" : "border-slate-700 bg-slate-900/95 text-white")}><Bell className="size-4" />{message}</div>;
}

export function SectionTitle({ title, description }) {
  return <div className="mb-2 mt-6 flex items-baseline gap-2 px-0.5"><h3 className="text-xs font-semibold text-slate-900">{title}</h3>{description && <span className="text-[10px] text-slate-400">{description}</span>}</div>;
}
