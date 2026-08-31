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
  commercial: "/api/commercial/offers",
  exceptions: "/api/exceptions",
  maintenance: "/api/maintenance",
  settings: "/api/settings/ai",
};

export default function App() {
  const [activeView, setActiveView] = useState("sources");
  const [health, setHealth] = useState(null);
  const [auth, setAuth] = useState(null);
  const [totals, setTotals] = useState({});
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

  const openGuide = useCallback((guide) => setDetail({ open: true, type: "guide", data: { guide }, loading: false }), []);

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
      <main className="mx-auto w-full max-w-[1440px] space-y-4 px-4 py-6 sm:px-6 sm:py-7 lg:px-8">
        <PageHeading view={activeView} health={health} />
        <Metrics totals={totals} />
        <Tabs value={activeView} onValueChange={setActiveView}>
          <div className="sticky top-[62px] z-30 -mx-1 overflow-x-auto px-1 py-1.5 scrollbar-none">
            <TabsList aria-label="后台功能导航">{Object.entries(views).map(([key, item]) => { const Icon = item.icon; return <TabsTrigger key={key} value={key} title={item.title}><Icon className="size-3.5 shrink-0" /><span>{item.label}</span></TabsTrigger>; })}</TabsList>
          </div>
        </Tabs>
        {health && !health.aiConfigured && <AiAlert onConfigure={() => openGuide("ai")} />}
        <section aria-live="polite">
          {loading ? <LoadingView /> : error ? <EmptyState icon="offline" title="无法加载此页面" description={error} action={() => refresh(true)} actionLabel="重新尝试" /> : <ViewRenderer view={activeView} data={viewData} health={health} onNavigate={setActiveView} onGuide={openGuide} onOpenSource={(id) => openPackage("source", id)} onOpenDraft={(id) => openPackage("draft", id)} onAction={runAction} actionBusy={actionBusy} />}
        </section>
        <footer className="flex items-center justify-between border-t border-slate-200/70 pt-5 text-[10px] text-slate-400"><span>SoloToChina 内容研究引擎</span><span>应用 v{health?.version || "—"} · 策略 v{health?.contentStrategy?.version || "—"} · 仅处理人工选定来源</span></footer>
      </main>
      <DetailDialog detail={detail} health={health} actionBusy={actionBusy} onOpenChange={(open) => setDetail((current) => ({ ...current, open }))} onAction={runAction} onClose={() => setDetail({ open: false, type: null, data: null, loading: false })} />
      <Toast {...toast} />
    </div>
  );
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
            : detail.type === "source" ? <SourceDetail source={detail.data} actionBusy={actionBusy} onAction={onAction} onClose={onClose} />
              : detail.type === "draft" ? <DraftDetail item={detail.data} health={health} actionBusy={actionBusy} onAction={onAction} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function SourceDetail({ source, actionBusy, onAction, onClose }) {
  const retry = async () => { if (await onAction(`/api/sources/${source.id}/retry`, { method: "POST" }, "Extraction queued")) onClose(); };
  return <>
    <DialogHeader><Badge variant="info" className="w-max"><FileText className="size-3" /> Source detail</Badge><DialogTitle>{source.title || "Untitled note"}</DialogTitle><DialogDescription>Raw evidence, structured extraction, claims, and editorial pattern remain traceable to the selected note.</DialogDescription></DialogHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2"><Button variant="secondary" size="sm" asChild><a href={source.canonical_url} target="_blank" rel="noreferrer"><ExternalLink /> Open original</a></Button><Button size="sm" disabled={actionBusy} onClick={retry}><RefreshCw className={cn(actionBusy && "animate-spin")} /> Re-run extraction</Button><StatusPill status={source.status} /></div>
    <div className="grid gap-3 md:grid-cols-2"><DetailCard title="Structured source"><p>{source.structured?.summary || "Pending extraction"}</p><small>Destination: {source.structured?.destination_name || "—"} · Confidence {source.structured?.confidence ?? "—"}</small></DetailCard><DetailCard title="Source blueprint"><p>{source.blueprint?.angle || "Pending extraction"}</p><small>{source.blueprint?.format || "—"}</small></DetailCard><DetailCard title={`Claims (${source.claims.length})`} className="md:col-span-2">{source.claims.length ? <ul className="space-y-3">{source.claims.map((claim) => <li key={claim.id}><strong className="text-xs text-slate-800">{claim.subject} {claim.predicate}</strong><p>{claim.value_text}</p><small>“{claim.source_quote}”</small></li>)}</ul> : <p>No claims extracted.</p>}</DetailCard><DetailCard title="Raw captured text" className="md:col-span-2"><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">{source.raw_text}</pre></DetailCard></div>
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
  ai: { icon: KeyRound, title: "Enable Kimi extraction", description: "Add a Kimi Open Platform API key to the server environment, then restart the engine. Captures already queued as needs_ai remain safe.", steps: ["Set KIMI_API_KEY in .env or the process environment.", "Kimi K2.7 Code is the default; Kimi K3 remains selectable in System settings.", "Confirm the active model from the top status badge."], code: "$env:KIMI_API_KEY = \"your-kimi-key\"\n$env:KIMI_MODEL = \"kimi-k2.7-code\"\nnpm start" },
  wordpress: { icon: Settings2, title: "Connect WordPress", description: "Use a least-privilege WordPress Application Password. The engine always creates drafts and never publishes.", steps: ["Create an editor Application Password in WordPress.", "Set site URL, username, and application password in the engine environment.", "Restart the engine. Inventory sync will begin automatically."], code: "WORDPRESS_SITE_URL=https://example.com\nWORDPRESS_USERNAME=editor\nWORDPRESS_APPLICATION_PASSWORD=xxxx xxxx xxxx" },
  commercial: { icon: TicketCheck, title: "Sync commercial offers", description: "Offers remain isolated from Research, Knowledge, planning, and QA. Only typed HTTPS offers are accepted.", steps: ["Prepare provider offers using a supported category.", "POST the batch to /api/commercial/offers with ADMIN_TOKEN.", "QA-passed drafts receive a deterministic overlay; no offer means a safe no-op."], code: "POST /api/commercial/offers\nAuthorization: Bearer <ADMIN_TOKEN>" },
};

function GuideContent({ guide }) {
  const item = guides[guide] || guides.ai;
  const Icon = item.icon;
  return <><DialogHeader><span className="mb-2 grid size-10 place-items-center rounded-xl bg-slate-900 text-white"><Icon className="size-4" /></span><DialogTitle>{item.title}</DialogTitle><DialogDescription>{item.description}</DialogDescription></DialogHeader><ol className="space-y-3">{item.steps.map((step, index) => <li className="flex gap-3 text-sm leading-relaxed text-slate-600" key={step}><span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">{index + 1}</span><span>{step}</span></li>)}</ol><div className="mt-5 rounded-xl border border-slate-800 bg-slate-950 p-4 text-slate-200 shadow-inner"><div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-slate-500"><Terminal className="size-3" /> Configuration</div><pre className="overflow-auto whitespace-pre-wrap text-xs leading-relaxed">{item.code}</pre></div><div className="mt-4 flex items-center gap-2 text-[11px] text-slate-400"><CheckCircle2 className="size-3.5 text-emerald-500" /> No spreadsheet or manual Knowledge Base maintenance is introduced.</div></>;
}
