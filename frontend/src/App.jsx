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
import { api, uploadChunk } from "@/lib/api";
import { classifyRefreshOutcome, createInFlightRequestCoordinator, createLatestRequestCoordinator, startStatusPolling } from "@/lib/request-coordinator";
import { cn, friendlyError, label } from "@/lib/utils";
import { ViewRenderer } from "@/views";
import { ContentRecovery, QualityIssue } from "@/workspaces/content-recovery";
import { ContentQualityStatus } from "@/workspaces/content-quality-status";

const endpoints = {
  sources: "/api/sources",
  recommendations: "/api/recommendations",
  content: "/api/content",
  knowledge: "/api/knowledge",
  commercial: "/api/commercial",
  settings: "/api/settings",
};

export default function App() {
  const [activeView, setActiveView] = useState("sources");
  const [health, setHealth] = useState(null);
  const [auth, setAuth] = useState(null);
  const [totals, setTotals] = useState({});
  const [actionCounts, setActionCounts] = useState({});
  const [viewCache, setViewCache] = useState({});
  const [paging, setPaging] = useState({
    sources:{cursor:'',history:[],pageSize:20}, recommendations:{cursor:'0',history:[],pageSize:20},
    content:{cursor:'0',history:[],pageSize:20}, knowledge:{cursor:'',history:[],pageSize:20},
    commercial:{cursor:'0',history:[],pageSize:20,filter:'all'},
  });
  const [pendingActionView, setPendingActionView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [contentPagingBusy, setContentPagingBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState({ open: false, type: null, data: null, loading: false });
  const [toast, setToast] = useState({ message: "", error: false });
  const requestSequence = useRef(0);
  const viewCacheRef = useRef({});
  const overviewRequests = useRef(createInFlightRequestCoordinator());
  const viewRequests = useRef(createInFlightRequestCoordinator());
  const prefetchAbortRef = useRef(null);
  const detailRequests = useRef(createLatestRequestCoordinator());
  const authScope = auth?.authenticated ? `${auth.username || 'local'}:${auth.role || 'admin'}` : 'anonymous';
  const keyFor = (view) => JSON.stringify([authScope,view,paging[view]?.cursor || '',paging[view]?.pageSize || null,paging[view]?.filter || '']);
  const activeKey = keyFor(activeView);
  const viewData = viewCache[activeKey]?.data || null;

  useEffect(() => { viewCacheRef.current = viewCache; }, [viewCache]);
  useEffect(() => { viewRequests.current.invalidate(); detailRequests.current.invalidate(); setViewCache({}); }, [authScope]);

  const showToast = useCallback((message, isError = false) => {
    setToast({ message, error: isError });
  }, []);

  useEffect(() => {
    if (!toast.message) return undefined;
    const timeout = setTimeout(() => setToast({ message: "", error: false }), 3000);
    return () => clearTimeout(timeout);
  }, [toast]);

  const loadOverview = useCallback(() => overviewRequests.current.run("overview", async ({ signal }) => {
    const [nextHealth, dashboard] = await Promise.all([api("/api/health", { signal }), api("/api/dashboard/summary", { signal })]);
    setHealth(nextHealth);
    setTotals(dashboard.totals || {});
    setActionCounts(dashboard.actionCounts || {});
  }), []);

  const loadStatusSummary = useCallback(() => overviewRequests.current.run("status", async ({ signal }) => {
    const [nextHealth,dashboard,sourceStatus] = await Promise.all([
      api("/api/health",{signal}),api("/api/dashboard/summary", { signal }),
      activeView==="sources" ? (() => {
        const ids = (viewCacheRef.current[keyFor('sources')]?.data?.items || []).map((item) => item.id);
        return ids.length ? api(`/api/sources/status?ids=${encodeURIComponent(ids.join(','))}`,{signal}) : Promise.resolve(null);
      })() : Promise.resolve(null),
    ]);
    setTotals(dashboard.totals || {});
    setActionCounts(dashboard.actionCounts || {});
    setHealth(nextHealth);
    if(sourceStatus?.items)setViewCache((current)=>{
      const key=keyFor('sources');const cached=current[key]?.data;if(!cached?.items)return current;
      const updates=new Map(sourceStatus.items.map((item)=>[item.id,item]));
      return {...current,[key]:{...current[key],data:{...cached,items:cached.items.map((item)=>updates.has(item.id)?{...item,...updates.get(item.id)}:item)}}};
    });
  }), [activeView, authScope, paging.sources]);

  const loadAuth = useCallback(async () => setAuth(await api("/api/auth/status")), []);

  const loadView = useCallback((view, { quiet = false, force = false } = {}) => viewRequests.current.run(keyFor(view), async ({ signal }) => {
    const key = keyFor(view);
    const cached = viewCacheRef.current[key];
    if (!force && cached?.data && Date.now() - cached.loadedAt < 30_000) return { ok: true, cached: true };
    const sequence = ++requestSequence.current;
    if (!quiet && !cached?.data) setLoading(true);
    try {
      const data = view === "knowledge"
        ? await Promise.all([api("/api/knowledge/summary", { signal }),
          api(`/api/knowledge/subjects?limit=${paging.knowledge.pageSize}&cursor=${encodeURIComponent(paging.knowledge.cursor)}`, { signal })])
          .then(([summary, subjects]) => ({ summary, subjects: subjects.items || [], nextCursor: subjects.nextCursor || null }))
        : await api(paging[view] ? `${endpoints[view]}?limit=${paging[view].pageSize}&cursor=${encodeURIComponent(paging[view].cursor)}${view==='commercial' ? `&filter=${encodeURIComponent(paging.commercial.filter)}` : ''}` : endpoints[view], { signal });
      if (sequence !== requestSequence.current) return { ok: false, stale: true };
      setViewCache((current) => {
        const entries=Object.entries(current).slice(-23);
        return { ...Object.fromEntries(entries), [key]: { data: { ...data, _loadedView: view }, loadedAt: Date.now() } };
      });
      setError("");
      return { ok: true, stale: false };
    } catch (caught) {
      if (sequence !== requestSequence.current || caught.name === 'AbortError') return { ok: false, stale: true, error: caught };
      setError(caught.message);
      return { ok: false, stale: false, error: caught };
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }), [authScope, paging]);

  useEffect(() => {
    if (!auth?.authenticated || auth.mustChangePassword || !paging[activeView] || !viewData?.nextCursor || document.hidden) return undefined;
    const nextCursor=String(viewData.nextCursor);
    const page=paging[activeView];
    const nextKey=JSON.stringify([authScope,activeView,nextCursor,page.pageSize,page.filter || '']);
    if (viewCacheRef.current[nextKey]?.data) return undefined;
    const controller=new AbortController();
    prefetchAbortRef.current=controller;
    const timer=setTimeout(async()=>{
      if (controller.signal.aborted || document.hidden) return;
      try {
        const next=activeView==='knowledge'
          ? await api(`/api/knowledge/subjects?limit=${page.pageSize}&cursor=${encodeURIComponent(nextCursor)}`,{signal:controller.signal})
            .then((subjects)=>({summary:viewData.summary,subjects:subjects.items || [],nextCursor:subjects.nextCursor || null}))
          : await api(`${endpoints[activeView]}?limit=${page.pageSize}&cursor=${encodeURIComponent(nextCursor)}${activeView==='commercial' ? `&filter=${encodeURIComponent(page.filter)}` : ''}`,
            {signal:controller.signal});
        if (controller.signal.aborted) return;
        const loadedAt=Date.now();
        setViewCache((current)=>{
          if (current[nextKey]?.loadedAt) return current;
          return {...Object.fromEntries(Object.entries(current).slice(-23)),
            [nextKey]:{data:{...next,_loadedView:activeView},loadedAt}};
        });
      } catch (error) {
        if (error.name!=='AbortError') prefetchAbortRef.current=null;
      }
    },250);
    const cancel=()=>controller.abort();
    document.addEventListener('visibilitychange',cancel);
    return ()=>{clearTimeout(timer);controller.abort();document.removeEventListener('visibilitychange',cancel);
      if(prefetchAbortRef.current===controller)prefetchAbortRef.current=null;};
  },[activeKey,activeView,auth?.authenticated,auth?.mustChangePassword,authScope,viewData?.nextCursor,viewData?.summary,paging]);

  const nextPage = useCallback((view) => {
    const next=viewCacheRef.current[keyFor(view)]?.data?.nextCursor;
    if (!next) return;
    prefetchAbortRef.current?.abort();
    setPaging((current)=>({...current,[view]:{...current[view],history:[...current[view].history,current[view].cursor],cursor:next}}));
  }, [authScope,paging]);
  const previousPage = useCallback((view) => setPaging((current) => {
    const previous=current[view]; if (!previous?.history.length) return current;
    return {...current,[view]:{...previous,cursor:previous.history.at(-1),history:previous.history.slice(0,-1)}};
  }), []);
  const changePageSize = useCallback((view,size) => setPaging((current)=>({ ...current,
    [view]:{...current[view],cursor:['sources','knowledge'].includes(view)?'':'0',history:[],pageSize:Number(size)} })), []);
  const changeCommercialFilter=useCallback((filter)=>setPaging((current)=>({...current,
    commercial:{...current.commercial,cursor:'0',history:[],filter}})),[]);

  useEffect(() => {
    void loadAuth().catch((caught) => setError(caught.message));
  }, [loadAuth]);

  useEffect(() => {
    if (!auth?.authenticated || auth.mustChangePassword) return;
    void loadOverview().catch((caught) => setError(caught.message));
  }, [auth?.authenticated, auth?.mustChangePassword, authScope, loadOverview]);

  useEffect(() => {
    if (!auth?.authenticated || auth.mustChangePassword) return;
    void loadView(activeView).catch((caught) => setError(caught.message));
  }, [activeView, activeKey, auth?.authenticated, auth?.mustChangePassword, loadView]);

  useEffect(() => {
    if (!auth?.authenticated || auth.mustChangePassword) return undefined;
    return startStatusPolling({ document, active: health?.queueActive > 0, refresh: loadStatusSummary,
      onError: caught => setError(caught.message) });
  }, [auth, health?.queueActive, loadStatusSummary]);

  const refresh = useCallback(async (notify = false) => {
    setRefreshing(true);
    try {
      const [overviewResult, viewResult] = await Promise.allSettled([loadOverview(), loadView(activeView, { quiet: true, force: true })]);
      const outcome = classifyRefreshOutcome(overviewResult, viewResult);
      if (notify) showToast(outcome.message, outcome.state !== "success");
      return outcome;
    } finally {
      setRefreshing(false);
    }
  }, [activeView, loadOverview, loadView, showToast]);

  const runAction = useCallback(async (url, options, successMessage) => {
    setActionBusy(true);
    try {
      prefetchAbortRef.current?.abort();
      const result = await api(url, options);
      showToast(typeof successMessage === "function" ? successMessage(result) : successMessage);
      const changedId=result?.article_id || result?.opportunity_id || result?.source_id || result?.id;
      if (changedId) setViewCache((current)=>{
        const currentPage=current[activeKey]; if (!currentPage?.data?.items) return current;
        return {...current,[activeKey]:{...currentPage,data:{...currentPage.data,items:currentPage.data.items.map((item)=>
          [item.id,item.opportunity_id,item.candidate_id].includes(changedId) ? {...item,...result} : item)}}};
      });
      void loadView(activeView,{quiet:true,force:true});
      void loadOverview();
      return result || true;
    } catch (caught) {
      showToast(caught.message, true);
      return false;
    } finally {
      setActionBusy(false);
    }
  }, [activeKey, activeView, loadOverview, loadView, showToast]);

  const submitManualSource = useCallback(async (payload, onProgress) => {
    setActionBusy(true);
    try {
      let result;
      if (payload.kind === "video" && payload.rawFiles?.[0]) {
        const file = payload.rawFiles[0];
        onProgress?.({ phase: "initializing", percent: 0, label: "正在建立分块上传会话" });
        const session = await api("/api/manual-source-uploads", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "video", name: file.name, mimeType: file.type || "video/mp4", size: file.size }) });
        let sent = 0;
        for (let index = 0; index < session.chunkCount; index += 1) {
          const start = index * session.chunkBytes;
          const chunk = file.slice(start, Math.min(file.size, start + session.chunkBytes));
          await uploadChunk(`/api/manual-source-uploads/${session.uploadId}/chunks/${index}`, chunk, (loaded) => {
            const percent = Math.min(99, Math.round(((sent + loaded) / file.size) * 100));
            onProgress?.({ phase: "uploading", percent, label: `正在上传第 ${index + 1}/${session.chunkCount} 个分块` });
          });
          sent += chunk.size;
        }
        onProgress?.({ phase: "processing", percent: 100, label: "上传完成，正在校验并写入证据库" });
        result = await api(`/api/manual-source-uploads/${session.uploadId}/complete`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: payload.title, notes: payload.notes }) });
      } else {
        onProgress?.({ phase: "processing", percent: 0, label: "正在上传并解析来源" });
        result = await api("/api/manual-sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      }
      onProgress?.({ phase: "queued", percent: 100, label: "已入库，等待分段提取" });
      showToast(result.message || "来源已进入处理流程");
       void loadView('sources',{quiet:true,force:true});
       void loadOverview();
      return result;
    } catch (caught) {
      showToast(caught.message, true);
      throw caught;
    } finally {
      setActionBusy(false);
    }
  }, [loadOverview, loadView, showToast]);

  const closeDetail = useCallback(() => {
    detailRequests.current.invalidate();
    setDetail({ open: false, type: null, data: null, loading: false });
  }, []);

  const openGuide = useCallback((guide) => {
    detailRequests.current.invalidate();
    setDetail({ open: true, type: "guide", data: { guide }, loading: false });
  }, []);

  const openContentStrategy = useCallback(async () => {
    const request = detailRequests.current.begin();
    setDetail({ open: true, type: "strategy", data: null, loading: true });
    try {
      const data = await api("/api/content-strategy", { signal: request.signal });
      if (!request.isCurrent()) return;
      setDetail({ open: true, type: "strategy", data, loading: false });
    } catch (caught) {
      if (!request.isCurrent() || caught.name === "AbortError") return;
      closeDetail();
      showToast(caught.message, true);
    }
  }, [closeDetail, showToast]);

  const openPackage = useCallback(async (type, id) => {
    const request = detailRequests.current.begin();
    setDetail({ open: true, type, data: null, loading: true });
    try {
      const endpoint = type === "source" ? `/api/sources/${id}` : type === "production"
        ? `/api/content/${encodeURIComponent(id)}/production-state` : `/api/drafts/${id}`;
      const data = await api(endpoint, { signal: request.signal });
      if (!request.isCurrent()) return;
      setDetail({ open: true, type, data, loading: false });
    } catch (caught) {
      if (!request.isCurrent() || caught.name === "AbortError") return;
      closeDetail();
      showToast(caught.message, true);
    }
  }, [closeDetail, showToast]);

  const openNavigationAction = useCallback((view) => {
    setPendingActionView({ view, requestedAt: Date.now() });
    setActiveView(view);
  }, []);

  useEffect(() => {
    if (!pendingActionView || pendingActionView.view !== activeView || loading || viewData?._loadedView !== activeView) return;
    if (activeView === "sources") {
      const target = (viewData.items || []).find((item) => item.queue?.state === "failed" || item.status === "exception");
      if (target) void openPackage("source", target.id);
    }
    if (activeView !== "knowledge") setPendingActionView(null);
  }, [activeView, loading, openPackage, pendingActionView, viewData]);

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
                {Object.entries(views).map(([key, item]) => { const Icon = item.icon; const badge = <NavigationBadge count={actionCounts[key]} active={activeView === key} compact />; return <TabsTrigger key={key} value={key} title={item.title} className="relative h-11 min-w-0 w-full px-1.5"><Icon className="size-3.5 shrink-0" /><span className="truncate">{item.label}</span>{["sources", "knowledge"].includes(key) ? <NavigationAction count={actionCounts[key]} onActivate={() => openNavigationAction(key)}>{badge}</NavigationAction> : badge}</TabsTrigger>; })}
              </TabsList>
            </div>
          </div>
          <div className="sticky top-[62px] z-30 -mx-1 hidden overflow-x-auto px-1 py-1.5 scrollbar-none sm:block">
            <TabsList aria-label="后台功能导航">{Object.entries(views).map(([key, item]) => { const Icon = item.icon; const badge = <NavigationBadge count={actionCounts[key]} active={activeView === key} />; return <TabsTrigger key={key} value={key} title={item.title}><Icon className="size-3.5 shrink-0" /><span>{item.label}</span>{["sources", "knowledge"].includes(key) ? <NavigationAction count={actionCounts[key]} onActivate={() => openNavigationAction(key)}>{badge}</NavigationAction> : badge}</TabsTrigger>; })}</TabsList>
          </div>
        </Tabs>
        {health && !health.aiConfigured && <AiAlert onConfigure={() => openGuide("ai")} />}
        <section aria-live="polite">
          {loading && !viewData ? <LoadingView /> : error && !viewData ? <EmptyState icon="offline" title="无法加载此页面" description={error} action={() => refresh(true)} actionLabel="重新尝试" /> : <><ViewRenderer view={activeView} data={viewData} commercialFilter={paging.commercial.filter} onCommercialFilter={changeCommercialFilter} reviewRequest={pendingActionView?.view === "knowledge" ? pendingActionView.requestedAt : null} health={health} auth={auth} onAuthRefresh={loadAuth} onNavigate={setActiveView} onGuide={openGuide} onOpenSource={(id) => openPackage("source", id)} onOpenDraft={(id) => openPackage("draft", id)} onOpenProduction={(id) => openPackage("production", id)} onAction={runAction} onSubmitManualSource={submitManualSource} onLoadMoreContent={() => nextPage('content')} contentPagingBusy={contentPagingBusy} actionBusy={actionBusy} />{paging[activeView] && <nav aria-label="列表分页" className="mt-3 flex items-center gap-2"><Button variant="outline" disabled={!paging[activeView].history.length} onClick={() => previousPage(activeView)}>上一页</Button><span className="text-xs text-slate-500">第 {paging[activeView].history.length+1} 页</span>{activeView!=='content' && <Button variant="outline" disabled={!viewData?.nextCursor} onClick={() => nextPage(activeView)}>下一页</Button>}<label className="text-xs text-slate-500">每页 <select value={paging[activeView].pageSize} onChange={(event)=>changePageSize(activeView,event.target.value)}><option value="20">20</option><option value="50">50</option></select> 条</label></nav>}</>}
        </section>
        <footer className="flex flex-col gap-1 border-t border-slate-200/70 pt-4 text-[10px] text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:pt-5"><span>SoloToChina 内容研究引擎</span><span>应用 v{health?.version || "—"} · 策略 v{health?.contentStrategy?.version || "—"} · 仅处理人工选定来源</span></footer>
      </main>
      <DetailDialog detail={detail} health={health} actionBusy={actionBusy} onOpenChange={(open) => { if (!open) closeDetail(); }} onAction={runAction} onClose={closeDetail} />
      <Toast {...toast} />
    </div>
  );
}

function NavigationAction({ count, onActivate, children }) {
  if (Number(count || 0) <= 0) return children;
  const activate = (event) => { event.preventDefault(); event.stopPropagation(); onActivate(); };
  return <span aria-label="打开首个待处理项目" onPointerDown={(event) => event.stopPropagation()} onClick={activate}>{children}</span>;
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
  return <AuthShell title="欢迎回来" description="登录后管理 SoloToChina 内容研究工作区。"><form className="space-y-4" onSubmit={submit}><AuthField label="用户名" value={username} onChange={setUsername} autoComplete="username" /><AuthField label="密码" type="password" value={password} onChange={setPassword} autoComplete="current-password" />{error && <p className="text-xs text-rose-600">{error}</p>}<Button className="w-full" disabled={busy}>{busy ? "正在登录…" : "登录"}</Button></form></AuthShell>;
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
  return <AuthShell title="保护工作区" description="首次使用控制台前，请设置新密码。"><form className="space-y-4" onSubmit={submit}><AuthField label="当前密码" type="password" value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" /><AuthField label="新密码" type="password" value={nextPassword} onChange={setNextPassword} autoComplete="new-password" hint="至少使用 8 个字符。" />{error && <p className="text-xs text-rose-600">{error}</p>}<Button className="w-full" disabled={busy}>{busy ? "正在更新…" : "设置新密码"}</Button></form></AuthShell>;
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
      <DialogContent className={detail.type === "production" ? "inset-x-0 bottom-0 top-auto max-h-[92dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl p-4 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6" : undefined}>
        {detail.loading ? <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-slate-500"><LoaderCircle className="size-4 animate-spin" /> 正在加载详情</div>
          : detail.type === "guide" ? <GuideContent guide={detail.data.guide} />
            : detail.type === "strategy" ? <ContentStrategyDetail strategy={detail.data} />
            : detail.type === "source" ? <SourceDetail source={detail.data} actionBusy={actionBusy} onAction={onAction} onClose={onClose} />
              : detail.type === "draft" ? <DraftDetail item={detail.data} health={health} actionBusy={actionBusy} onAction={onAction} onClose={onClose} />
                : detail.type === "production" ? <ProductionDetail item={detail.data} health={health} actionBusy={actionBusy} onAction={onAction} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ProductionDetail({ item, health, actionBusy, onAction, onClose }) {
  const state = item.production_state || {};
  const preview = item.page_preview || {};
  const publication = item.publication;
  const [grantReason, setGrantReason] = useState('');
  const [grantCount, setGrantCount] = useState(1);
  const exhaustedBudgets = (item.media_budgets || []).filter((budget) => budget.grantable
    && budget.spent >= budget.limit && !budget.unknown);
  const approveMediaBudget = async (budget) => {
    const granted = await onAction(`/api/content/${encodeURIComponent(item.opportunity_id)}/media-budget-grants`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({visualId:budget.visualId,
        substage:budget.substage,additionalDispatches:Number(grantCount),reason:grantReason.trim(),
        idempotencyKey:crypto.randomUUID()}),
    },'额外媒体调用预算已记录。请从失败阶段恢复，已完成的图片会复用。');
    if (granted) onClose();
  };
  return <>
    <DialogHeader><Badge variant={state.needs_human ? "warning" : "info"} className="w-max"><Layers3 className="size-3" /> 内容生产详情</Badge><DialogTitle className="break-words text-lg sm:text-xl">{item.draft_title || item.title || item.proposed_title || "未命名文章"}</DialogTitle><DialogDescription>{state.headline}。{state.explanation}</DialogDescription></DialogHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2"><StatusPill status={state.stage_status || "waiting"} /><Badge>完成 {state.progress?.completed || 0}/{state.progress?.total || 0}</Badge><Badge variant={state.auto_continue ? "success" : state.needs_human ? "warning" : "secondary"}>{state.auto_continue ? "会自动继续" : state.needs_human ? "等待人工" : "不会自动继续"}</Badge>{state.retry_state && <Badge variant="warning">模型重试 {state.retry_state.attempt}/{state.retry_state.max_attempts} · 剩余 {state.retry_state.remaining_auto_attempts}</Badge>}<FinalPreviewAction draftId={item.draft?.draft?.id || item.draft_id} available={Boolean(publication?.preview_url)} complete={Boolean(item.draft?.commercial_composition?.current && item.draft?.publish_composition?.status === "delivered")} />{publication?.edit_url && <Button size="sm" variant="outline" asChild><a href={publication.edit_url} target="_blank" rel="noreferrer"><ExternalLink />在 WordPress 编辑</a></Button>}</div>
    {state.latest_error && <DetailCard title="准确失败原因" className="mb-3 border-rose-200 bg-rose-50/40"><p><strong>失败阶段：</strong>{state.latest_error.stage_label || state.current_stage_label}</p><p>{state.latest_error.reason}</p><details className="mt-2 rounded-lg border border-rose-100 bg-white/70 p-2"><summary className="cursor-pointer font-medium text-slate-700">技术详情</summary><dl className="mt-2 grid gap-1 break-all text-[10px] text-slate-600"><div>code: {state.latest_error.code || "—"}</div><div>job: {state.latest_error.job_id || "—"}</div><div>request: {state.latest_error.request_id || "—"}</div><div>job attempt: {state.latest_error.attempt ?? "—"} · model calls: {state.latest_error.model_call_count ?? "未知"}</div><div>class / kind: {state.latest_error.failure_class || "—"} / {state.latest_error.execution_kind || "legacy_unknown"}</div><div>substage / visual: {state.latest_error.substage || "—"} / {state.latest_error.visual_id || "—"}</div><div>provider/model: {state.latest_error.provider || "—"} / {state.latest_error.model || "—"}</div><div>服务请求：{providerRequestLabel(state.latest_error.provider_request_state)}</div><div>HTTP / provider code: {state.latest_error.http_status ?? "未知"} / {state.latest_error.provider_code || "—"}</div><div>模型执行：{modelExecutionLabel(state.latest_error.model_execution)}</div><div>证据依据：{state.latest_error.evidence_basis || "telemetry_missing"}</div>{(state.latest_error.technical_details?.validation?.errors || []).map((error,index)=><div key={`${error.code}:${error.path}:${index}`} className="mt-1 rounded bg-rose-50 p-1">{error.code || "VALIDATION_ERROR"} @ {error.path || "$"}{error.slot_key ? ` · slot ${error.slot_key}` : ""}{error.affiliate_asset_id ? ` · asset ${error.affiliate_asset_id}` : ""}{error.message ? ` · ${error.message}` : ""}</div>)}</dl></details></DetailCard>}
    {exhaustedBudgets.length > 0 && <DetailCard title="媒体预算需要人工增额" className="mb-3 border-amber-200"><p>已耗尽的调用保留在账本中。每次可批准 1–4 次，单个图片步骤累计最多增加 12 次；未知结果须先核实。</p><label className="mt-2 block">增额原因<input className="mt-1 w-full rounded border p-2" maxLength={500} value={grantReason} onChange={(event)=>setGrantReason(event.target.value)} /></label><label className="mt-2 block">增加次数<select className="ml-2 rounded border p-2" value={grantCount} onChange={(event)=>setGrantCount(Number(event.target.value))}>{[1,2,3,4].map((n)=><option key={n} value={n}>{n}</option>)}</select></label>{exhaustedBudgets.map((budget)=><div key={`${budget.visualId}:${budget.substage}`} className="mt-2 flex flex-wrap items-center gap-2"><span className="break-all">{budget.visualId} / {budget.substage}：已用 {budget.spent}/{budget.limit}</span><Button size="sm" disabled={actionBusy || !grantReason.trim() || budget.granted+Number(grantCount)>12} onClick={()=>approveMediaBudget(budget)}>批准增额</Button></div>)}</DetailCard>}
    {state.latest_historical_error && <DetailCard title="历史失败（不阻塞当前恢复）" className="mb-3 border-amber-200 bg-amber-50/40"><p><strong>历史阶段：</strong>{state.latest_historical_error.stage_label}</p><p>这条旧失败缺少当前流水线要求的前置产物，系统不会再把它当作当前恢复目标。请按下方时间线显示的断点继续。</p><details className="mt-2 rounded-lg border border-amber-100 bg-white/70 p-2"><summary className="cursor-pointer font-medium text-slate-700">历史技术记录</summary><p className="mt-2 break-all text-[10px]">job: {state.latest_historical_error.job_id || "—"} · code: {state.latest_historical_error.code || "—"}</p></details></DetailCard>}
    {(state.latest_error?.code === "DESTINATION_TOPIC_MISMATCH" || state.available_actions?.includes("confirm_destination_scope")) && <DetailCard title="更正目的地归属" className="mb-3 border-amber-200"><p>{state.available_actions?.includes("confirm_destination_scope") ? "目的地已更正；请确认更正后的生产范围，旧失败不会继续阻塞。" : "该错误不能靠重复重试解决。更正后系统会重新计算证据范围，并要求重新确认生产范围。"}</p><ContentRecovery candidateId={item.opportunity_id || item.candidate_id} onAction={onAction} actionBusy={actionBusy} /></DetailCard>}
    {publication?.post_id && <DetailCard title="远端 WordPress 草稿保护" className="mb-3 border-amber-200 bg-amber-50/40"><p>这篇内容已经创建 WordPress 草稿。删除本地生产记录不会删除 WordPress 中的草稿。为避免记录失配，本次只能归档本地生产记录。</p></DetailCard>}
    <DetailCard title="生产时间线" className="mb-3"><ol className="space-y-2">{(state.timeline || []).map((step) => <li key={step.key} className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2"><div className="min-w-0"><strong>{step.label}</strong><small>{step.dependencies?.length ? `已有 ${step.dependencies.length} 个前置依赖` : "生产入口"}{step.reused ? " · 已复用持久化产物" : ""}{step.historical_failure ? " · 旧失败已移入历史，不阻塞当前断点" : ""}</small></div><StatusPill status={step.status} /></li>)}</ol><p className="mt-3">{state.stage_status === "failed" ? `恢复目标：重新执行${state.recovery_target_label || state.current_stage_label}` : state.stage_status === "interrupted" ? `断点恢复目标：${state.recovery_target_label || state.next_stage_label || "无"}` : `下一步骤：${state.next_stage_label || "无"}`}</p><details className="mt-3 rounded-lg bg-slate-50 p-2"><summary className="cursor-pointer font-medium">展开内部 stage key</summary><ul className="mt-2 break-all text-[10px]">{(state.timeline || []).map((step)=><li key={step.key}>{step.label}: {step.key} · dependencies [{(step.dependencies || []).join(", ")}]</li>)}</ul></details></DetailCard>
    <DetailCard title="页面编排预览" className="mb-3"><p>{preview.notice}</p>{preview.kind === "unavailable" ? <small>页面规划尚未生成；生产详情仍可正常查看。</small> : <><p className="mt-2">来源：{label(preview.kind)} · Contract {preview.contract_version || "—"} · Schema {preview.schema_version || "—"}</p><ol className="mt-3 space-y-2">{(preview.blocks || []).map((block) => <li key={`${block.order}:${block.component}`} className="rounded-lg border border-slate-100 px-3 py-2"><strong>{block.order}. {block.component}{block.variant ? ` · ${block.variant}` : ""}</strong><small>{block.heading || "无标题"} · Claims {block.claim_keys?.length || 0} · 来源章节 {block.source_section_ids?.length || 0}{block.commercial ? " · 商业模块" : ""}</small></li>)}</ol><small>Payload hash：{preview.payload_hash || "—"} · Contract checksum：{preview.contract_checksum || "—"}</small></>}</DetailCard>
    {item.draft ? <details className="rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer text-xs font-semibold text-slate-800">展开 Draft 正文、质量与商业层详情</summary><div className="mt-4"><DraftDetail item={item.draft} health={health} actionBusy={actionBusy} onAction={onAction} onClose={onClose} /></div></details> : <DetailCard title="Draft 尚未生成"><p>这不是详情缺失。你仍可查看已完成步骤、当前步骤、下一步骤、自动继续状态及历史记录。</p></DetailCard>}
    {(item.history || []).length > 0 && <DetailCard title={`生产与审计历史（${item.history.length}）`} className="mt-3"><ul className="max-h-48 space-y-2 overflow-auto">{item.history.map((event, index) => <li key={`${event.kind}:${event.id}:${index}`}><strong>{label(event.action || event.failing_stage || event.kind)}</strong><small>{event.created_at} · {label(event.status || event.failure_code || event.kind)}</small></li>)}</ul></DetailCard>}
  </>;
}

function modelExecutionLabel(value) {
  return ({ confirmed:"已确认执行", rejected_before_generation:"接口在生成前拒绝", not_requested:"未发起", not_applicable:"本步骤不适用", cache_hit:"复用已有合格结果，本次未新增调用", unknown:"调用情况未知" })[value] || "未确认";
}

function providerRequestLabel(value) {
  return ({ sent:"已发送并收到可归因结果",not_attempted:"本地前置检查拦截，未发起",not_applicable:"本步骤不需要外部调用",
    cache_hit:"缓存复用，本次无新增外部请求",unknown:"调用情况未知" })[value] || "调用情况未知";
}

function SourceDetail({ source, actionBusy, onAction, onClose }) {
  const retry = async () => { if (await onAction(`/api/sources/${source.id}/retry`, { method: "POST" }, "已重新加入提取队列")) onClose(); };
  const processingEstimate = source.submission_metadata?.processingEstimate;
  const blockedByHardLimit = processingEstimate?.processingClass === "blocked_hard_limit";
  const reviewEvidence = (decision, authorityLevel) => onAction(`/api/sources/${source.id}/evidence-review`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision, authorityLevel, note: "在来源详情中完成审核" }),
  }, decision === "verified" ? "证据核验结果已保存，相关知识和内容机会正在重建。" : "证据可信状态已更新。");
  const originalUrl = /^https?:\/\//.test(source.submitted_url || "") ? source.submitted_url : /^https?:\/\//.test(source.canonical_url || "") ? source.canonical_url : "";
  return <>
    <DialogHeader><Badge variant="info" className="w-max"><FileText className="size-3" /> 来源详情</Badge><DialogTitle>{source.title || "未命名来源"}</DialogTitle><DialogDescription>原始证据、上传文件来源、结构化提取、信息主张和编辑模式均可追溯到当前来源。</DialogDescription></DialogHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2">{originalUrl && <Button variant="secondary" size="sm" asChild><a href={originalUrl} target="_blank" rel="noreferrer"><ExternalLink /> 打开原文</a></Button>}<Button size="sm" disabled={actionBusy || blockedByHardLimit} onClick={retry}><RefreshCw className={cn(actionBusy && "animate-spin")} /> 重新提取</Button><Button size="sm" variant="secondary" disabled={actionBusy} onClick={() => reviewEvidence("verified", 1)}><CheckCircle2 /> 核验为官方来源</Button><Button size="sm" variant="outline" disabled={actionBusy} onClick={() => reviewEvidence("unverified", 4)}>标记为未核验</Button><StatusPill status={source.status} /><Badge variant={source.verified_at ? "success" : "warning"}>权威等级 L{source.authority_level || 4} · {source.verified_at ? "已核验" : "未核验"}</Badge></div>
    {source.last_error && <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800"><strong>处理失败</strong><p className="mt-1 leading-relaxed">{friendlyError(source.last_error)}</p><small>请先修正访问权限、模型配置或来源内容问题，再重新执行提取。</small></div>}
    {processingEstimate && <DetailCard title="处理规模预估" className="mb-3"><p>预计提取请求 {processingEstimate.estimatedExtractionCalls} 次 · 文本分段 {processingEstimate.textSegments} 个 · 媒体 {processingEstimate.assetCount} 项 · 文件 {(processingEstimate.totalFileBytes / 1024 / 1024).toFixed(2)} MB</p><small>{blockedByHardLimit ? `已超过硬限制：${processingEstimate.blockReasons?.join("；") || "请检查来源文件"}` : `处理级别：${processingEstimate.processingClass || "normal"}，系统会自动排队。`}</small></DetailCard>}
    {source.status_projection && <DetailCard title="当前处理阶段" className="mb-3"><p>{label(source.status_projection.current_stage)} · 捕获版本 v{source.status_projection.capture_version}</p><small>媒体 {source.status_projection.media_ready_count}/{source.status_projection.media_count} · 分段 {source.status_projection.extracted_segment_count}/{source.status_projection.segment_count} · 覆盖 {source.status_projection.audited_segment_count}/{source.status_projection.segment_count} · Experience {label(source.status_projection.experience_status || "pending")}</small></DetailCard>}
    {source.timeline?.length>0 && <DetailCard title="来源处理时间线" className="mb-3"><ul className="max-h-48 space-y-2 overflow-auto">{source.timeline.slice(0,30).map((event,index)=><li key={`${event.kind}:${event.stage}:${event.occurred_at}:${index}`}><strong>{label(event.stage)}</strong><small>{label(event.status)} · {event.occurred_at}{event.detail?` · ${friendlyError(event.detail)}`:""}</small></li>)}</ul></DetailCard>}
    <div className="mb-3 grid gap-3 md:grid-cols-2"><DetailCard title="媒体原件耐久化"><p>{source.media_manifest?.mediaDurability?.originalsStored || 0} / {source.media_manifest?.mediaDurability?.discovered || 0} 个原件已保存</p><small>状态：{source.media_manifest?.mediaDurability?.status || "等待发现"} · 浏览器修复 {source.media_manifest?.mediaDurability?.browserRepairRequired || 0}</small></DetailCard><DetailCard title={`旅行经验层（${source.experience_blocks?.length || 0}）`}>{source.experience_blocks?.length ? <ul className="space-y-2">{source.experience_blocks.map((block)=><li key={block.id}><strong>{block.title}</strong><small>{label(block.type)} · 序列 {block.sequence.length} · 决策 {block.decision_logic.length} · 证据跨度 {block.evidence_span_ids.length}</small></li>)}</ul>:<p>尚无可追溯 Experience Block；写作者不得编造第一人称经历。</p>}</DetailCard></div>
    <div className="grid gap-3 md:grid-cols-2"><DetailCard title="结构化来源"><p>{source.structured?.summary || "等待提取"}</p><small>目的地：{source.structured?.destination_name || "—"} · 置信度 {source.structured?.confidence ?? "—"}</small></DetailCard><DetailCard title="编辑蓝图"><p>{source.blueprint?.angle === "pending-ai-analysis" ? "等待 AI 分析" : source.blueprint?.angle || "等待提取"}</p><small>{source.blueprint?.format === "unclassified" ? "待分类" : source.blueprint?.format || "—"}</small></DetailCard>{source.files?.length > 0 && <DetailCard title={`原始文件（${source.files.length}）`} className="md:col-span-2"><ul className="space-y-1">{source.files.map((file) => <li key={file.id}><strong className="text-xs text-slate-700">{file.original_filename}</strong><small className="ml-2">{file.mime_type} · {(file.size_bytes / 1024 / 1024).toFixed(2)} MB · SHA-256 {file.sha256.slice(0, 12)}…</small></li>)}</ul></DetailCard>}{source.segments?.length > 0 && <SegmentCoverageList source={source} actionBusy={actionBusy} onAction={onAction} onClose={onClose} />}<DetailCard title={`信息主张（${source.claims.length}）`} className="md:col-span-2">{source.claims.length ? <ul className="space-y-3">{source.claims.map((claim) => <li key={claim.id} className={claim.lifecycle_status === "excluded" ? "opacity-50" : ""}><div className="flex items-start justify-between gap-3"><div><strong className="text-xs text-slate-800">{claim.subject} {claim.predicate}</strong><p>{claim.value_text}</p><small>“{claim.source_quote}”</small></div><Button size="sm" variant="outline" disabled={actionBusy} onClick={() => onAction(`/api/claims/${claim.id}/${claim.lifecycle_status === "excluded" ? "restore" : "exclude"}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "后台人工管理" }) }, claim.lifecycle_status === "excluded" ? "信息主张已恢复" : "信息主张已排除并将重建知识库")}>{claim.lifecycle_status === "excluded" ? "恢复" : "排除"}</Button></div></li>)}</ul> : <p>尚未提取信息主张。</p>}</DetailCard><DetailCard title="原始采集文本" className="md:col-span-2"><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">{source.raw_text}</pre></DetailCard></div>
  </>;
}

function DraftDetail({ item, health, actionBusy, onAction, onClose }) {
  const { draft, review, commercial_composition: composition, publish_composition: publishComposition, publication } = item;
  const [seoTitle, setSeoTitle] = useState(draft.seo?.meta_title || draft.title || "");
  const [seoDescription, setSeoDescription] = useState(draft.meta_description || "");
  const titleLength = [...seoTitle].length;
  const descriptionLength = [...seoDescription].length;
  const push = async () => { if (await onAction(`/api/drafts/${draft.id}/wordpress`, { method: "POST" }, "草稿已加入 WordPress 投递队列")) onClose(); };
  const saveSeo = async () => {
    if (await onAction(`/api/drafts/${draft.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: seoTitle, meta_description: seoDescription }) }, "SEO 标题与描述已保存，最终检查已重新排队")) onClose();
  };
  const retryFailedStage = async (retry) => {
    if (await onAction(retry.endpoint, { method: "POST" }, `已只重试失败阶段：${retry.stage}`)) onClose();
  };
  return <>
    <DialogHeader><Badge variant="info" className="w-max"><Layers3 className="size-3" /> 文章草稿 · 修订版 {draft.revision}</Badge><DialogTitle>{draft.title}</DialogTitle><DialogDescription>面向读者的正文与内部证据台账、商业内容层保持分离。</DialogDescription></DialogHeader>
    <div className="mb-4 flex flex-wrap items-center gap-2"><StatusPill status={draft.status} /><Badge>质量审核 {review ? `${Math.round(review.score)} / 100` : "待处理"}</Badge>{review?.passed && health?.wordpressConfigured && draft.status === "ready_for_wordpress" && <Button size="sm" disabled={actionBusy} onClick={push}><Send /> 发送到 WordPress 草稿箱</Button>}<FinalPreviewAction draftId={draft.id} available={Boolean(publication?.preview_url)} complete={Boolean(composition?.current && publishComposition?.status === "delivered")} />{publication?.edit_url && <Button size="sm" variant="outline" asChild><a href={publication.edit_url} target="_blank" rel="noreferrer"><ExternalLink />在 WordPress 编辑</a></Button>}</div>
    <ContentRecovery candidateId={item.candidate?.id} onAction={onAction} actionBusy={actionBusy} />
    <ContentQualityStatus operation={item.operation} actionBusy={actionBusy} onRetry={retryFailedStage} onAction={onAction} />
    <DetailCard title="编辑反馈与金标" className="mb-3"><div className="flex flex-wrap gap-2">{["满意","AI味重","太啰嗦","信息太平","像数据库","结构不好","很好"].map((feedback)=><Button key={feedback} size="sm" variant="outline" disabled={actionBusy} onClick={()=>onAction(`/api/drafts/${draft.id}/editorial-feedback`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({feedback})},`已记录“${feedback}”，后续组装与叙事规划会参考。`)}>{feedback}</Button>)}<Button size="sm" disabled={actionBusy} onClick={()=>onAction(`/api/drafts/${draft.id}/golden`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({principles:["evidence-led","concise","traveler-decision-focused"]})},"已标记为金标文章。")}>标记金标</Button></div></DetailCard>
    {review?.issues?.length > 0 && <DetailCard title="质量审核问题" className="mb-3 border-amber-200 bg-amber-50/40"><ul className="space-y-2">{review.issues.map((issue, index) => <li key={`${issue.message}-${index}`} className="text-xs text-amber-900"><QualityIssue issue={issue} /></li>)}</ul></DetailCard>}
    <div className="grid gap-3"><DetailCard title="读者正文（Markdown）"><pre className="max-h-[420px] overflow-auto whitespace-pre-wrap font-serif text-sm leading-7 text-slate-700">{draft.body_markdown}</pre></DetailCard><DetailCard title="SEO / GEO 编辑预览"><label className="block text-xs font-semibold text-slate-700">页面标题<input className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal" value={seoTitle} maxLength={200} onChange={(event) => setSeoTitle(event.target.value)} /></label><p className={titleLength > 60 ? "text-amber-700" : "text-slate-500"}>{titleLength} 个字符{titleLength > 60 ? " · 超出编辑建议长度，请人工判断，不会机械截断" : " · 在编辑建议范围内"}</p><label className="mt-3 block text-xs font-semibold text-slate-700">页面描述<textarea className="mt-1 min-h-20 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-normal" value={seoDescription} maxLength={500} onChange={(event) => setSeoDescription(event.target.value)} /></label><p className={descriptionLength > 160 ? "text-amber-700" : "text-slate-500"}>{descriptionLength} 个字符{descriptionLength > 160 ? " · 超出编辑建议长度，请人工判断，不会机械截断" : " · 在编辑建议范围内"}</p><p className="mt-2 text-[11px] text-slate-500">仅供编辑预览；搜索引擎可能改写或截断标题与描述，不承诺展示方式或点击率。</p><div className="mt-3 flex items-center gap-2"><Button size="sm" variant="outline" disabled={actionBusy || !seoTitle.trim() || !seoDescription.trim()} onClick={saveSeo}>保存并重新检查</Button><span className="text-[11px] text-slate-500">正文与证据提取不会重跑。</span></div><p className="mt-3"><strong>核心关键词：</strong> {draft.seo?.focus_keyword || "待处理"}</p><p><strong>核心要点：</strong> {draft.seo?.key_takeaways?.length || 0} · <strong>常见问题：</strong> {draft.seo?.faqs?.length || 0} · <strong>JSON-LD：</strong> {draft.schema_jsonld?.["@graph"]?.length || 0} 个实体</p></DetailCard><DetailCard title={`视觉资产（${draft.visuals?.length || 0}）`}><ul className="space-y-2">{(draft.visuals || []).map((visual) => <li key={visual.id} className="rounded-lg bg-slate-50 px-3 py-2"><div className="flex items-center justify-between gap-3"><strong>{label(visual.placement)} · {label(visual.acquisition_strategy)}</strong><StatusPill status={visual.status} /></div><p className="mt-1">{visual.alt_text}</p>{visual.media_url && <a className="mt-1 inline-block text-[11px] text-blue-600 hover:underline" href={visual.media_url} target="_blank" rel="noreferrer">打开视觉资产</a>}</li>)}</ul></DetailCard><DetailCard title="内部证据台账"><p>{draft.evidence_ledger.length} 个已映射章节 · {draft.unresolved_conflicts.length} 项未解决冲突 · {draft.verification_notes.length} 项时效性核验备注</p></DetailCard><DetailCard title="商业内容层"><p>{composition ? `${composition.asset_ids?.length || 0} 个已选资产 · ${label(composition.outcome || composition.status)}` : "等待编排"}</p>{composition?.reason_code && <small>原因：{composition.reason_code}</small>}{composition?.diagnostics?.intents?.length > 0 && <small>检测到 {composition.diagnostics.intent_count} 个意图；合格资产 {composition.diagnostics.intents.reduce((sum,item)=>sum+(item.eligibleCount || 0),0)} 个。</small>}{(composition?.slots || []).map((slot)=><p key={slot.slot_key} className="mt-2 break-all rounded bg-slate-50 p-2 text-[11px]">资产 {slot.affiliate_asset_id} · {slot.slot_key} · {label(slot.component_type)} · {label(slot.placement)}</p>)}{composition?.status === "composed" && <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{composition.publishable_body_markdown.slice(draft.body_markdown.length).trim()}</pre>}</DetailCard></div>
  </>;
}

function DetailCard({ title, className, children }) {
  return <Card className={cn("p-4 shadow-none", className)}><h3 className="mb-2 text-xs font-semibold text-slate-900">{title}</h3><div className="text-xs leading-relaxed text-slate-600 [&_small]:mt-2 [&_small]:block [&_small]:text-[10px] [&_small]:text-slate-400 [&_p]:leading-relaxed">{children}</div></Card>;
}

function FinalPreviewAction({ draftId, available, complete = false }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!available || !draftId) return null;
  const open = async () => {
    const popup = window.open("about:blank", "_blank");
    if (!popup) { setMessage("浏览器阻止了新窗口，请允许弹窗后重试。"); return; }
    popup.opener = null;
    setBusy(true); setMessage("");
    try {
      const result = await api(`/api/drafts/${encodeURIComponent(draftId)}/final-preview`, { method:"POST" });
      popup.location.replace(result.url);
      if (result.mode === "wordpress_login_required") setMessage("需要先登录 WordPress；登录后会进入这篇草稿的最终预览。");
    } catch (caught) {
      popup.close();
      setMessage(friendlyError(caught));
    } finally { setBusy(false); }
  };
  return <span className="inline-flex flex-col items-start"><Button type="button" size="sm" variant={complete ? "default" : "outline"} disabled={busy} onClick={open}><ExternalLink />{busy ? "正在准备预览…" : complete ? "预览最终页面" : "诊断预览 / 待修复"}</Button>{message && <small className="max-w-72 text-[10px] text-amber-700" role="status">{message}</small>}</span>;
}

function SegmentCoverageList({ source, actionBusy, onAction, onClose }) {
  const review = async (segment, decision) => {
    const success = await onAction(`/api/sources/${source.id}/segments/${segment.id}/coverage-review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, note: decision === "not_material" ? "人工确认该分段无需形成信息主张" : "人工要求再次定向提取" }),
    }, decision === "not_material" ? "该分段已确认无需信息主张" : "该分段已加入定向重试队列");
    if (success) onClose();
  };
  return <DetailCard title={`分段与覆盖审计（${source.segments.length}）`} className="md:col-span-2">
    <ul className="space-y-2">{source.segments.map((segment) => {
      const coverage = source.extraction_coverage?.find((item) => item.segment_id === segment.id);
      const status = coverage?.status || segment.status;
      return <li key={segment.id} className="rounded-lg border border-slate-100 px-2 py-1.5">
        <div className="flex items-center justify-between gap-3"><span>#{segment.sequence + 1} · {label(segment.segment_type)}{segment.image_index ? ` · 图片 ${segment.image_index}` : ""}</span><StatusPill status={status} /></div>
        {status === "manual_review" && <div className="mt-2 rounded-md bg-amber-50 p-2 text-amber-900">
          {(coverage.uncovered_spans || []).map((item, index) => <p key={`${item.locator}-${index}`}>{item.locator || "该分段"}：{item.reason || "仍有重要证据未形成信息主张"}</p>)}
          <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" disabled={actionBusy} onClick={() => review(segment, "retry")}><RefreshCw /> 重试此分段</Button><Button size="sm" variant="outline" disabled={actionBusy} onClick={() => review(segment, "not_material")}><CheckCircle2 /> 确认无需信息主张</Button></div>
        </div>}
      </li>;
    })}</ul>
  </DetailCard>;
}

const guides = {
  capture: { icon: AppWindow, title: "采集第一个来源", description: "来源发现由人工主导；扩展只读取你明确打开并保存的笔记。", steps: ["在 Chrome 扩展程序页面以“加载已解压的扩展程序”方式加载仓库中的 extension/ 文件夹。", "打开一篇你已筛选的小红书笔记。", "点击“保存当前笔记”，该来源会自动进入提取流程。"], code: "引擎地址：http://127.0.0.1:4310" },
  ai: { icon: KeyRound, title: "启用 AI 内容提取", description: "在服务器环境中配置 AI 提供商后重启引擎；已经排队等待 AI 的采集内容不会丢失。", steps: ["在 .env 或进程环境中设置所需的 API 配置。", "可在“系统设置”中选择当前可用的图文处理模型。", "从页面顶部的状态标记确认当前启用的模型。"], code: "$env:KIMI_API_KEY = \"your-kimi-key\"\n$env:AI_MODEL = \"kimi-k3\"\nnpm start" },
  wordpress: { icon: Settings2, title: "连接 WordPress", description: "使用最小权限的 WordPress 应用程序密码。引擎只创建草稿，不会直接发布。", steps: ["在 WordPress 中为编辑账号创建应用程序密码。", "在引擎环境中设置站点地址、用户名和应用程序密码。", "重启引擎，文章库存会自动开始同步。"], code: "WORDPRESS_SITE_URL=https://example.com\nWORDPRESS_USERNAME=editor\nWORDPRESS_APPLICATION_PASSWORD=xxxx xxxx xxxx" },
  commercial: { icon: TicketCheck, title: "配置联盟营销资产", description: "提供商账号和可复用资产与研究、知识、文章创建及质量审核流程隔离。", steps: ["创建 MANUAL 类型的 Trip.com 提供商；不要保存后台凭证或 Cookie。", "只将官方链接或结构化嵌入配置填入联盟资产登记表。", "按目的地、区域、路线或精选实体映射资产；精确资产缺失时会按既有规则回退。"], code: "POST /api/commercial/providers\nPOST /api/commercial/assets\nAuthorization: Bearer <ADMIN_TOKEN>" },
};

function GuideContent({ guide }) {
  const item = guides[guide] || guides.ai;
  const Icon = item.icon;
  return <><DialogHeader><span className="mb-2 grid size-10 place-items-center rounded-xl bg-slate-900 text-white"><Icon className="size-4" /></span><DialogTitle>{item.title}</DialogTitle><DialogDescription>{item.description}</DialogDescription></DialogHeader><ol className="space-y-3">{item.steps.map((step, index) => <li className="flex gap-3 text-sm leading-relaxed text-slate-600" key={step}><span className="grid size-6 shrink-0 place-items-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600">{index + 1}</span><span>{step}</span></li>)}</ol><div className="mt-5 rounded-xl border border-slate-800 bg-slate-950 p-4 text-slate-200 shadow-inner"><div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-slate-500"><Terminal className="size-3" /> 配置示例</div><pre className="overflow-auto whitespace-pre-wrap text-xs leading-relaxed">{item.code}</pre></div><div className="mt-4 flex items-center gap-2 text-[11px] text-slate-400"><CheckCircle2 className="size-3.5 text-emerald-500" /> 无需引入电子表格或人工维护知识库。</div></>;
}

function ContentStrategyDetail({ strategy }) {
  const version = strategy?.version || "—";
  const history = Array.isArray(strategy?.history) ? strategy.history : [];
  const steps = [
    ["人工选源", "只保存你已打开并明确选择的小红书笔记；不自动搜索、翻页或抓取。"],
    ["事实与建议", "系统提取可追溯的 信息主张和知识事实，再给出唯一的推荐下一步；不会自行发布文章。"],
    ["人工批准", "只有“批准文章”会启动文章创建；证据不足、重复或冲突会优先留在知识层或补充研究。"],
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
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs font-medium text-slate-800"><span>人工采集</span><span className="text-slate-300">→</span><span>结构化事实</span><span className="text-slate-300">→</span><span>建议与人工决定</span><span className="text-slate-300">→</span><span>文章创建</span><span className="text-slate-300">→</span><span>质量审核</span><span className="text-slate-300">→</span><span>WordPress 草稿</span></div>
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
