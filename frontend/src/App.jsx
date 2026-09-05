import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppWindow, CheckCircle2, ExternalLink, FileText, KeyRound, Layers3, LoaderCircle,
  RefreshCw, Send, Settings2, Terminal, TicketCheck,
} from "lucide-react";
import { AiAlert, EmptyState, LoadingView, Metrics, PageHeading, StatusPill, Toast, Topbar, views } from "@/components/dashboard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { cn, label } from "@/lib/utils";
import { ViewRenderer } from "@/views";

const endpoints = {
  sources: "/api/sources",
  recommendations: "/api/recommendations",
  knowledge: "/api/knowledge",
  blueprints: "/api/editorial-blueprints",
  content: "/api/content",
  wordpress: "/api/wordpress/inventory",
  commercial: "/api/commercial",
  exceptions: "/api/exceptions",
  maintenance: "/api/maintenance",
  settings: "/api/settings/ai",
};

export default function App() {
  const [activeView, setActiveView] = useState("sources");
  const [health, setHealth] = useState(null);
  const [auth, setAuth] = useState(null);
  const [totals, setTotals] = useState({});
  const [actionCounts, setActionCounts] = useState({});
  const [viewData, setViewData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState({ open: false, type: null, data: null, loading: false });
  const [toast, setToast] = useState({ message: "", error: false });
  const requestSequence = useRef(0);

  const showToast = useCallback((message, isError = false) => {
    setToast({ message, error: isError });
  }, []);

  useEffect(() => {
    if (!toast.message) return undefined;
    const timeout = setTimeout(() => setToast({ message: "", error: false }), 3000);
    return () => clearTimeout(timeout);
  }, [toast]);

  const loadOverview = useCallback(async () => {
    const [nextHealth, dashboard] = await Promise.all([api("/api/health"), api("/api/dashboard")]);
    setHealth(nextHealth);
    setTotals(dashboard.totals || {});
    setActionCounts(dashboard.actionCounts || {});
  }, []);

  const loadAuth = useCallback(async () => setAuth(await api("/api/auth/status")), []);

  const loadView = useCallback(async (view, { quiet = false } = {}) => {
    const sequence = ++requestSequence.current;
    if (!quiet) setLoading(true);
    try {
      const data = await api(endpoints[view]);
      if (sequence !== requestSequence.current) return;
      setViewData(data);
      setError("");
    } catch (caught) {
      if (sequence !== requestSequence.current) return;
      setError(caught.message);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAuth().catch((caught) => setError(caught.message));
  }, [loadAuth]);

  useEffect(() => {
    if (!auth?.authenticated || auth.mustChangePassword) return;
    void loadOverview().catch((caught) => setError(caught.message));
  }, [auth, loadOverview]);

  useEffect(() => {
    if (!auth?.authenticated || auth.mustChangePassword) return;
    setViewData(null);
    void loadView(activeView);
  }, [activeView, auth, loadView]);

  useEffect(() => {
    if (!auth?.authenticated || auth.mustChangePassword) return undefined;
    const interval = setInterval(() => {
      void Promise.all([loadOverview(), loadView(activeView, { quiet: true })]).catch((caught) => setError(caught.message));
    }, 60_000);
    return () => clearInterval(interval);
  }, [activeView, auth, loadOverview, loadView]);

  const refresh = useCallback(async (notify = false) => {
    setRefreshing(true);
    try {
      await Promise.all([loadOverview(), loadView(activeView, { quiet: true })]);
      if (notify) showToast("已刷新最新状态");
    } catch (caught) {
      setError(caught.message);
      showToast(caught.message, true);
    } finally {
      setRefreshing(false);
    }
  }, [activeView, loadOverview, loadView, showToast]);

  const runAction = useCallback(async (url, options, successMessage) => {
    setActionBusy(true);
    try {
      await api(url, options);
      showToast(successMessage);
      await refresh(false);
      return true;
    } catch (caught) {
      showToast(caught.message, true);
      return false;
    } finally {
      setActionBusy(false);
    }
  }, [refresh, showToast]);

  const submitManualSource = useCallback(async (payload) => {
    setActionBusy(true);
    try {
      const result = await api("/api/manual-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      showToast(result.message || "来源已进入处理流程");
      await refresh(false);
      return result;
    } catch (caught) {
      showToast(caught.message, true);
      throw caught;
    } finally {
      setActionBusy(false);
    }
  }, [refresh, showToast]);

  const openGuide = useCallback((guide) => setDetail({ open: true, type: "guide", data: { guide }, loading: false }), []);

  const openContentStrategy = useCallback(async () => {
    setDetail({ open: true, type: "strategy", data: null, loading: true });
    try {
      const data = await api("/api/content-strategy");
      setDetail({ open: true, type: "strategy", data, loading: false });
    } catch (caught) {
      setDetail({ open: false, type: null, data: null, loading: false });
      showToast(caught.message, true);
    }
  }, [showToast]);

  const openPackage = useCallback(async (type, id) => {
    setDetail({ open: true, type, data: null, loading: true });
    try {
      const data = await api(type === "source" ? `/api/sources/${id}` : `/api/drafts/${id}`);
      setDetail({ open: true, type, data, loading: false });
    } catch (caught) {
      setDetail({ open: false, type: null, data: null, loading: false });
      showToast(caught.message, true);
    }
  }, [showToast]);

  if (!auth) return <LoadingView />;
  if (auth.enabled && !auth.authenticated) return <LoginScreen onAuthenticated={loadAuth} />;
  if (auth.enabled && auth.mustChangePassword) return <ChangePasswordScreen onChanged={loadAuth} />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Topbar health={health || { ok: !error }} refreshing={refreshing} onRefresh={() => refresh(true)} />
      <main className="mx-auto w-full max-w-[1440px] space-y-3 px-3 py-4 sm:space-y-4 sm:px-6 sm:py-7 lg:px-8">
        <PageHeading view={activeView} health={health} onOpenStrategy={openContentStrategy} />
        <Metrics totals={totals} onNavigate={setActiveView} />
        <Tabs value={activeView} onValueChange={setActiveView}>
          <div className="sticky top-[53px] z-30 -mx-1 py-1.5 sm:top-[62px] sm:hidden">
            <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white/90 p-1.5 shadow-sm backdrop-blur">
              <TabsList aria-label="手机端后台菜单" className="grid h-auto w-full grid-cols-3 gap-1 border-0 bg-transparent p-0 shadow-none">
                {Object.entries(views).map(([key, item]) => { const Icon = item.icon; return <TabsTrigger key={key} value={key} title={item.title} className="relative h-11 min-w-0 w-full px-1.5"><Icon className="size-3.5 shrink-0" /><span className="truncate">{item.label}</span><NavigationBadge count={actionCounts[key]} active={activeView === key} compact /></TabsTrigger>; })}
              </TabsList>
            </div>
          </div>
          <div className="sticky top-[62px] z-30 -mx-1 hidden overflow-x-auto px-1 py-1.5 scrollbar-none sm:block">
            <TabsList aria-label="后台功能导航">{Object.entries(views).map(([key, item]) => { const Icon = item.icon; return <TabsTrigger key={key} value={key} title={item.title}><Icon className="size-3.5 shrink-0" /><span>{item.label}</span><NavigationBadge count={actionCounts[key]} active={activeView === key} /></TabsTrigger>; })}</TabsList>
          </div>
        </Tabs>
        {health && !health.aiConfigured && <AiAlert onConfigure={() => openGuide("ai")} />}
        <section aria-live="polite">
          {loading ? <LoadingView /> : error ? <EmptyState icon="offline" title="无法加载此页面" description={error} action={() => refresh(true)} actionLabel="重新尝试" /> : <ViewRenderer view={activeView} data={viewData} health={health} auth={auth} onAuthRefresh={loadAuth} onNavigate={setActiveView} onGuide={openGuide} onOpenSource={(id) => openPackage("source", id)} onOpenDraft={(id) => openPackage("draft", id)} onAction={runAction} onSubmitManualSource={submitManualSource} actionBusy={actionBusy} />}
        </section>
        <footer className="flex flex-col gap-1 border-t border-slate-200/70 pt-4 text-[10px] text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:pt-5"><span>SoloToChina 内容研究引擎</span><span>应用 v{health?.version || "—"} · 策略 v{health?.contentStrategy?.version || "—"} · 仅处理人工选定来源</span></footer>
      </main>
      <DetailDialog detail={detail} health={health} actionBusy={actionBusy} onOpenChange={(open) => setDetail((current) => ({ ...current, open }))} onAction={runAction} onClose={() => setDetail({ open: false, type: null, data: null, loading: false })} />
      <Toast {...toast} />
    </div>
  );
}

function NavigationBadge({ count, active = false, compact = false }) {
  const value = Number(count || 0);
  if (value <= 0) return null;
  return <span aria-label={`${value} 项待处理`} className={cn("inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums", compact && "absolute right-1 top-1", active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-800")}>{value > 99 ? "99+" : value}</span>;
}

function LoginScreen({ onAuthenticated }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
      await onAuthenticated();
    } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  };
  return <AuthShell title="Welcome back" description="Sign in to manage your SoloToChina research workspace."><form className="space-y-4" onSubmit={submit}><AuthField label="Username" value={username} onChange={setUsername} autoComplete="username" /><AuthField label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />{error && <p className="text-xs text-rose-600">{error}</p>}<Button className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button></form></AuthShell>;
}

function ChangePasswordScreen({ onChanged }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/auth/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword, nextPassword }) });
      await onChanged();
    } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  };
  return <AuthShell title="Secure your workspace" description="Choose a new password before using the dashboard."><form className="space-y-4" onSubmit={submit}><AuthField label="Current password" type="password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /><AuthField label="New password" type="password" value={nextPassword} onChange={setNextPassword} autoComplete="new-password" hint="Use at least 8 characters." />{error && <p className="text-xs text-rose-600">{error}</p>}<Button className="w-full" disabled={busy}>{busy ? "Updating…" : "Set new password"}</Button></form></AuthShell>;
}

function AuthShell({ title, description, children }) {
  return <main className="grid min-h-screen place-items-center bg-slate-50 px-4"><Card className="w-full max-w-sm p-7 shadow-sm"><div className="mb-6"><div className="mb-4 grid size-10 place-items-center rounded-xl bg-slate-950 text-sm font-semibold text-white">S</div><h1 className="text-xl font-semibold tracking-tight text-slate-950">{title}</h1><p className="mt-2 text-sm leading-6 text-slate-500">{description}</p></div>{children}</Card></main>;
}

function AuthField({ label, type = "text", value, onChange, autoComplete, hint }) {
  return <label className="block space-y-1.5"><span className="text-xs font-medium text-slate-700">{label}</span><input className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-slate-400 focus:ring-4 focus:ring-slate-100" type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} required />{hint && <span className="block text-[11px] text-slate-400">{hint}</span>}</label>;
}

function DetailDialog({ detail, health, actionBusy, onOpenChange, onAction, onClose }) {
  return (
    <Dialog open={detail.open} onOpenChange={onOpenChange}>
      <DialogContent>
        {detail.loading ? <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-slate-500"><LoaderCircle className="size-4 animate-spin" /> Loading details</div>
          : detail.type === "guide" ? <GuideContent guide={detail.data.guide} />
            : detail.type === "strategy" ? <ContentStrategyDetail strategy={detail.data} />
            : detail.type === "source" ? <SourceDetail source={detail.data} actionBusy={actionBusy} onAction={onAction} onClose={onClose} />
              : detail.type === "draft" ? <DraftDetail item={detail.data} health={health} actionBusy={actionBusy} onAction={onAction} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SourceDetail({ source, actionBusy, onAction, onClose }) {
  const retry = async () => { if (await onAction(`/api/sources/${source.id}/retry`, { method: "POST" }, "Extraction queued")) onClose(); };
  const originalUrl = /^https?:\/\//.test(source.submitted_url || "") ? source.submitted_url : /^https?:\/\//.test(source.canonical_url || "") ? source.canonical_url : "";
  return <>
    <DialogHeader><Badge variant="info" className="w-max"><FileText className="size-3" /> Source detail</Badge><DialogTitle>{source.title || "Untitled source"}</DialogTitle><DialogDescription>Raw evidence, uploaded-file provenance, structured extraction, Claims, and editorial pattern remain traceable to this selected source.</DialogDescription></DialogHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2">{originalUrl && <Button variant="secondary" size="sm" asChild><a href={originalUrl} target="_blank" rel="noreferrer"><ExternalLink /> Open original</a></Button>}<Button size="sm" disabled={actionBusy} onClick={retry}><RefreshCw className={cn(actionBusy && "animate-spin")} /> Re-run extraction</Button><StatusPill status={source.status} /></div>
    {source.last_error && <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800"><strong>Processing failure</strong><p className="mt-1 leading-relaxed">{source.last_error}</p><small>Correct the access, model, or source-content issue before retrying extraction.</small></div>}
    <div className="grid gap-3 md:grid-cols-2"><DetailCard title="Structured source"><p>{source.structured?.summary || "Pending extraction"}</p><small>Destination: {source.structured?.destination_name || "—"} · Confidence {source.structured?.confidence ?? "—"}</small></DetailCard><DetailCard title="Source blueprint"><p>{source.blueprint?.angle || "Pending extraction"}</p><small>{source.blueprint?.format || "—"}</small></DetailCard>{source.files?.length > 0 && <DetailCard title={`Original files (${source.files.length})`} className="md:col-span-2"><ul className="space-y-1">{source.files.map((file) => <li key={file.id}><strong className="text-xs text-slate-700">{file.original_filename}</strong><small className="ml-2">{file.mime_type} · {(file.size_bytes / 1024 / 1024).toFixed(2)} MB · SHA-256 {file.sha256.slice(0, 12)}…</small></li>)}</ul></DetailCard>}<DetailCard title={`Claims (${source.claims.length})`} className="md:col-span-2">{source.claims.length ? <ul className="space-y-3">{source.claims.map((claim) => <li key={claim.id}><strong className="text-xs text-slate-800">{claim.subject} {claim.predicate}</strong><p>{claim.value_text}</p><small>“{claim.source_quote}”</small></li>)}</ul> : <p>No claims extracted.</p>}</DetailCard><DetailCard title="Raw captured text" className="md:col-span-2"><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">{source.raw_text}</pre></DetailCard></div>
  </>;
}

function DraftDetail({ item, health, actionBusy, onAction, onClose }) {
  const { draft, review, commercial_composition: composition } = item;
  const push = async () => { if (await onAction(`/api/drafts/${draft.id}/wordpress`, { method: "POST" }, "Draft queued for WordPress")) onClose(); };
  return <>
    <DialogHeader><Badge variant="info" className="w-max"><Layers3 className="size-3" /> Article draft · revision {draft.revision}</Badge><DialogTitle>{draft.title}</DialogTitle><DialogDescription>Reader-facing copy stays separate from the internal evidence ledger and commercial overlay.</DialogDescription></DialogHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2"><StatusPill status={draft.status} /><Badge>QA {review ? `${Math.round(review.score)} / 100` : "pending"}</Badge>{review?.passed && health?.wordpressConfigured && draft.status === "ready_for_wordpress" && <Button size="sm" disabled={actionBusy} onClick={push}><Send /> Send to WordPress drafts</Button>}</div>
    {review?.issues?.length > 0 && <DetailCard title="QA issues" className="mb-3 border-amber-200 bg-amber-50/40"><ul className="space-y-2">{review.issues.map((issue, index) => <li key={`${issue.message}-${index}`} className="text-xs text-amber-900"><strong>{label(issue.severity)}:</strong> {issue.message}</li>)}</ul></DetailCard>}
    <div className="grid gap-3"><DetailCard title="Reader-facing Markdown"><pre className="max-h-[420px] overflow-auto whitespace-pre-wrap font-serif text-sm leading-7 text-slate-700">{draft.body_markdown}</pre></DetailCard><DetailCard title="SEO / GEO package"><p><strong>Meta title:</strong> {draft.seo?.meta_title || draft.title}</p><p><strong>Focus keyword:</strong> {draft.seo?.focus_keyword || "Pending"}</p><p><strong>Key takeaways:</strong> {draft.seo?.key_takeaways?.length || 0} · <strong>FAQs:</strong> {draft.seo?.faqs?.length || 0} · <strong>JSON-LD:</strong> {draft.schema_jsonld?.["@graph"]?.length || 0} entities</p></DetailCard><DetailCard title={`Original visual plan (${draft.visuals?.length || 0})`}><ul className="space-y-2">{(draft.visuals || []).map((visual) => <li key={visual.id} className="rounded-lg bg-slate-50 px-3 py-2"><div className="flex items-center justify-between gap-3"><strong>{label(visual.placement)}</strong><StatusPill status={visual.status} /></div><p className="mt-1">{visual.alt_text}</p>{visual.media_url && <a className="mt-1 inline-block text-[11px] text-blue-600 hover:underline" href={visual.media_url} target="_blank" rel="noreferrer">Open generated image</a>}</li>)}</ul></DetailCard><DetailCard title="Internal evidence ledger"><p>{draft.evidence_ledger.length} mapped sections · {draft.unresolved_conflicts.length} unresolved conflicts · {draft.verification_notes.length} time-sensitive verification notes</p></DetailCard><DetailCard title="Commercial overlay"><p>{composition ? `${composition.offer_ids.length} offers · ${label(composition.status)}` : "Pending composition"}</p>{composition?.status === "composed" && <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{composition.publishable_body_markdown.slice(draft.body_markdown.length).trim()}</pre>}</DetailCard></div>
  </>;
}

function DetailCard({ title, className, children }) {
  return <Card className={cn("p-4 shadow-none", className)}><h3 className="mb-2 text-xs font-semibold text-slate-900">{title}</h3><div className="text-xs leading-relaxed text-slate-600 [&_small]:mt-2 [&_small]:block [&_small]:text-[10px] [&_small]:text-slate-400 [&_p]:leading-relaxed">{children}</div></Card>;
}

const guides = {
  capture: { icon: AppWindow, title: "Capture your first source", description: "Discovery remains human-led. The extension only reads the note you explicitly opened and saved.", steps: ["Open Chrome Extensions and load the repository extension/ folder as an unpacked extension.", "Open one Xiaohongshu /explore/ note that you already selected.", "Choose Save to SoloToChina. The source will enter extraction automatically."], code: "Engine URL: http://127.0.0.1:4310" },
  ai: { icon: KeyRound, title: "Enable Kimi extraction", description: "Add a Kimi Open Platform API key to the server environment, then restart the engine. Captures already queued as needs_ai remain safe.", steps: ["Set KIMI_API_KEY in .env or the process environment.", "Kimi K3 is the default; Kimi K2.7 Code remains selectable in System settings.", "Confirm the active model from the top status badge."], code: "$env:KIMI_API_KEY = \"your-kimi-key\"\n$env:AI_MODEL = \"kimi-k3\"\nnpm start" },
  wordpress: { icon: Settings2, title: "Connect WordPress", description: "Use a least-privilege WordPress Application Password. The engine always creates drafts and never publishes.", steps: ["Create an editor Application Password in WordPress.", "Set site URL, username, and application password in the engine environment.", "Restart the engine. Inventory sync will begin automatically."], code: "WORDPRESS_SITE_URL=https://example.com\nWORDPRESS_USERNAME=editor\nWORDPRESS_APPLICATION_PASSWORD=xxxx xxxx xxxx" },
  commercial: { icon: TicketCheck, title: "Configure affiliate assets", description: "Provider accounts and reusable assets remain isolated from Research, Knowledge, planning, and QA.", steps: ["Create a MANUAL Trip.com provider account; never store dashboard credentials or cookies.", "Copy only official links or structured embed configuration into the Affiliate Asset Registry.", "Map assets at the destination, area, route, or selective entity level. Missing exact assets silently fall back unless the opportunity score is high."], code: "POST /api/commercial/providers\nPOST /api/commercial/assets\nAuthorization: Bearer <ADMIN_TOKEN>" },
};

function GuideContent({ guide }) {
  const item = guides[guide] || guides.ai;
  const Icon = item.icon;
  return <><DialogHeader><span className="mb-2 grid size-10 place-items-center rounded-xl bg-slate-900 text-white"><Icon className="size-4" /></span><DialogTitle>{item.title}</DialogTitle><DialogDescription>{item.description}</DialogDescription></DialogHeader><ol className="space-y-3">{item.steps.map((step, index) => <li className="flex gap-3 text-sm leading-relaxed text-slate-600" key={step}><span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">{index + 1}</span><span>{step}</span></li>)}</ol><div className="mt-5 rounded-xl border border-slate-800 bg-slate-950 p-4 text-slate-200 shadow-inner"><div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-slate-500"><Terminal className="size-3" /> Configuration</div><pre className="overflow-auto whitespace-pre-wrap text-xs leading-relaxed">{item.code}</pre></div><div className="mt-4 flex items-center gap-2 text-[11px] text-slate-400"><CheckCircle2 className="size-3.5 text-emerald-500" /> No spreadsheet or manual Knowledge Base maintenance is introduced.</div></>;
}

function ContentStrategyDetail({ strategy }) {
  const version = strategy?.version || "—";
  const history = Array.isArray(strategy?.history) ? strategy.history : [];
  const steps = [
    ["人工选源", "只保存你已打开并明确选择的小红书笔记；不自动搜索、翻页或抓取。"],
    ["事实与建议", "系统提取可追溯的 Claims 和知识事实，再给出唯一的推荐下一步；不会自行发布文章。"],
    ["人工批准", "只有“批准文章”会启动内容规划；证据不足、重复或冲突会优先留在知识层或补充研究。"],
    ["英文内容生产", "基于已验证事实生成面向国际自由行游客的原创英文草稿，并附 SEO / GEO、FAQ 和 Schema.org 包。"],
    ["质量与草稿发布", "通过证据、冲突、图片和结构化数据检查后，才写入 WordPress 草稿，最终发布仍由你决定。"],
  ];
  return <>
    <DialogHeader>
      <Badge variant="info" className="w-max"><Layers3 className="size-3" /> 内容生产策略 v{version}</Badge>
      <DialogTitle>{strategy?.name || "SoloToChina 内容生产策略"}</DialogTitle>
      <DialogDescription>这是当前运行策略的中文操作摘要；内容输出语言与站点文案不会因此改变。</DialogDescription>
    </DialogHeader>
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">运行路径</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs font-medium text-slate-800"><span>人工采集</span><span className="text-slate-300">→</span><span>结构化事实</span><span className="text-slate-300">→</span><span>建议与人工决定</span><span className="text-slate-300">→</span><span>内容规划</span><span className="text-slate-300">→</span><span>QA</span><span className="text-slate-300">→</span><span>WordPress 草稿</span></div>
      </section>
      <ol className="space-y-3">{steps.map(([title, description], index) => <li className="flex gap-3" key={title}><span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-900 text-[10px] font-semibold text-white">{index + 1}</span><div><h3 className="text-xs font-semibold text-slate-900">{title}</h3><p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{description}</p></div></li>)}</ol>
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-950"><b>图片策略：</b>你人工筛选并保存的笔记图片已标记为授权发布素材。文章证据引用同一来源且图片支持对应场景时，实景图会优先进入 WordPress 草稿；其余视觉槽位再使用已验证数据的地图、信息图或无事实断言的原创插画。</section>
      {history.length > 0 && <section className="rounded-xl border border-slate-200 bg-white p-3.5"><div className="flex items-center justify-between gap-3"><div><h3 className="text-xs font-semibold text-slate-900">策略演化日志</h3><p className="mt-0.5 text-[11px] text-slate-500">版本不会覆盖历史记录；每次变更都有简短说明。</p></div><Badge variant="muted">{history.length} 个版本</Badge></div><ol className="mt-3 space-y-2.5">{history.map((entry) => <li className="rounded-lg border border-slate-100 bg-slate-50 p-3" key={entry.version}><div className="flex flex-wrap items-center gap-2"><strong className="text-xs text-slate-900">v{entry.version}</strong><Badge variant={entry.status === "active" ? "success" : "muted"}>{entry.status === "active" ? "当前运行" : "历史版本"}</Badge><span className="text-[10px] text-slate-400">{entry.effectiveDate}</span></div><p className="mt-1.5 text-[11px] leading-relaxed text-slate-700">{entry.summary}</p><ul className="mt-2 space-y-1 text-[10px] leading-relaxed text-slate-500">{entry.changes.map((change) => <li className="flex gap-1.5" key={change}><span className="mt-0.5 text-slate-300">•</span><span>{change}</span></li>)}</ul></li>)}</ol></section>}
      <details className="rounded-xl border border-slate-200 bg-white p-3"><summary className="cursor-pointer select-none text-xs font-semibold text-slate-700">展开阅读完整策略原文（Markdown）</summary><pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-3 text-[10px] leading-relaxed text-slate-200">{strategy?.markdown || "策略原文暂时无法读取。"}</pre></details>
      <Button asChild className="w-full"><a href="/api/content-strategy/download"><FileText />下载完整策略 v{version}（.md）</a></Button>
      <p className="text-center text-[10px] text-slate-400">策略状态：{strategy?.status === "active" ? "运行中" : strategy?.status || "—"} · 新记录会携带此版本，历史记录不会被追溯改写。</p>
    </div>
  </>;
}
