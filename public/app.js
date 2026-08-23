const state = { view: "sources", health: null, loadingView: 0 };
const content = document.querySelector("#content");
const notice = document.querySelector("#notice");
const dialog = document.querySelector("#detail-dialog");
const healthElement = document.querySelector("#health");
const refreshButton = document.querySelector("#refresh");

const views = {
  sources: ["Research sources", "Capture and trace every human-selected travel source."],
  knowledge: ["Destination knowledge", "Review corroborated facts, conflicts, and freshness in one place."],
  blueprints: ["Editorial blueprints", "Turn recurring source patterns into reusable editorial intelligence."],
  content: ["Content production", "Move evidence-backed topics through drafting, review, and delivery."],
  wordpress: ["WordPress inventory", "Keep production topics distinct from posts already in your CMS."],
  commercial: ["Commercial offers", "Manage the isolated affiliate layer without touching research knowledge."],
  exceptions: ["Exceptions", "Only the issues that genuinely need human judgment or intervention."],
  maintenance: ["System maintenance", "Quiet automation for backups, reconciliation, sync, and cleanup."],
};

document.querySelector(".close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

refreshButton.addEventListener("click", async () => {
  refreshButton.classList.add("is-loading");
  refreshButton.disabled = true;
  await refresh();
  refreshButton.disabled = false;
  refreshButton.classList.remove("is-loading");
  toast("Dashboard refreshed");
});

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => selectView(tab));
  tab.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll(".tab")];
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(tabs.indexOf(tab) + direction + tabs.length) % tabs.length];
    next.focus();
    selectView(next);
  });
}

await refresh();
setInterval(refresh, 60_000);

function selectView(tab) {
  if (state.view === tab.dataset.view && tab.classList.contains("active")) return;
  state.view = tab.dataset.view;
  document.querySelectorAll(".tab").forEach((item) => {
    const selected = item === tab;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  tab.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  updateWorkspaceHeading();
  content.innerHTML = loadingState("Loading view");
  void loadView();
}

async function refresh() {
  try {
    const [health, dashboard] = await Promise.all([api("/api/health"), api("/api/dashboard")]);
    state.health = health;
    renderHealth(health);
    renderMetrics(dashboard.totals);
    notice.classList.toggle("hidden", health.aiConfigured);
    notice.textContent = "AI extraction is paused until OPENAI_API_KEY is configured. Captures remain safe and queued.";
    await loadView();
  } catch (error) {
    healthElement.classList.add("offline");
    healthElement.innerHTML = '<span class="status-dot" aria-hidden="true"></span><span class="health-copy">Engine offline</span>';
    content.innerHTML = emptyState("offline", "Engine unavailable", error.message);
  }
}

async function loadView() {
  const requestId = ++state.loadingView;
  const view = state.view;
  try {
    let render;
    let data;
    if (view === "sources") [render, data] = [renderSources, (await api("/api/sources")).items];
    else if (view === "knowledge") [render, data] = [renderKnowledge, (await api("/api/knowledge")).items];
    else if (view === "blueprints") [render, data] = [renderBlueprints, (await api("/api/editorial-blueprints")).items];
    else if (view === "content") [render, data] = [renderContent, (await api("/api/content")).items];
    else if (view === "wordpress") [render, data] = [renderWordPressInventory, await api("/api/wordpress/inventory")];
    else if (view === "commercial") [render, data] = [renderCommercial, (await api("/api/commercial/offers")).items];
    else if (view === "exceptions") [render, data] = [renderExceptions, (await api("/api/exceptions")).items];
    else [render, data] = [renderMaintenance, await api("/api/maintenance")];
    if (requestId === state.loadingView && view === state.view) render(data);
  } catch (error) {
    if (requestId === state.loadingView) content.innerHTML = emptyState("offline", "Couldn’t load this view", error.message);
  }
}

function renderHealth(health) {
  const label = health.aiConfigured
    ? `AI ready · WordPress ${health.wordpressConfigured ? "ready" : "not configured"}`
    : "Capture ready · AI paused";
  healthElement.classList.remove("offline");
  healthElement.innerHTML = `<span class="status-dot" aria-hidden="true"></span><span class="health-copy">${label}</span>`;
}

function renderMetrics(totals) {
  const values = [
    [totals.sources, "Sources", "source", ""],
    [totals.claims, "Claims", "claim", ""],
    [totals.knowledgeFacts, "Knowledge", "knowledge", ""],
    [totals.conflicts, "Conflicts", "conflict", totals.conflicts ? "attention" : ""],
    [totals.topicCandidates, "Topics", "topic", ""],
    [totals.draftsReady, "Drafts ready", "draft", totals.draftsReady ? "success" : ""],
    [totals.wordpressInventory, "WordPress", "wordpress", ""],
    [totals.activeOffers, "Offers", "offer", ""],
    [totals.exceptions, "Exceptions", "exception", totals.exceptions ? "problem" : "success"],
  ];
  document.querySelector("#metrics").innerHTML = values.map(([value, label, iconName, tone]) => `
    <div class="metric ${tone}">
      <div class="metric-top"><span class="metric-icon">${icon(iconName)}</span><strong>${value}</strong></div>
      <span class="metric-label">${label}</span>
    </div>`).join("");
}

function updateWorkspaceHeading() {
  const [title, description] = views[state.view];
  document.querySelector("#workspace-title").textContent = title;
  document.querySelector("#workspace-description").textContent = description;
}

function renderSources(items) {
  if (!items.length) {
    content.innerHTML = emptyState("source", "No sources yet", "Open a Xiaohongshu note on your computer, then choose Save to SoloToChina in the extension.");
    return;
  }
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Status</th><th>Destination</th><th>Claims</th><th>Captured</th></tr></thead><tbody>${items.map((item) => `
    <tr data-id="${item.id}" tabindex="0"><td><div class="title">${escapeHtml(item.title || "Untitled note")}</div><div class="subtle">${escapeHtml(item.author_name || "Unknown author")} · v${item.capture_version}</div></td>
    <td><span class="badge ${item.status}">${label(item.status)}</span></td><td>${escapeHtml(item.destination_name || "—")}</td><td>${item.claim_count}</td><td>${date(item.captured_at)}</td></tr>`).join("")}</tbody></table></div>`;
  content.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", () => openSource(row.dataset.id));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter") void openSource(row.dataset.id); });
  });
}

function renderKnowledge(items) {
  if (!items.length) {
    content.innerHTML = emptyState("knowledge", "Knowledge is building", "Structured facts will appear after claims have been extracted from saved sources.");
    return;
  }
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Destination</th><th>Claim</th><th>Value</th><th>Evidence</th><th>State</th></tr></thead><tbody>${items.map((item) => `
    <tr><td>${escapeHtml(item.destination_name)}</td><td><div class="title">${escapeHtml(item.subject)} · ${escapeHtml(item.predicate)}</div><div class="subtle">${escapeHtml(item.normalized_key)}</div></td><td>${escapeHtml(item.preferred_value)}</td><td>${item.evidence.length}</td><td><span class="badge ${item.consensus_status}">${label(item.consensus_status)}</span><div class="subtle">${label(item.freshness_state)} · ${label(item.verification_priority)}</div></td></tr>`).join("")}</tbody></table></div>`;
}

function renderBlueprints(items) {
  if (!items.length) {
    content.innerHTML = emptyState("blueprint", "No editorial patterns yet", "Reusable angles, formats, and section patterns appear after source blueprint extraction.");
    return;
  }
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Pattern</th><th>Format</th><th>Samples</th><th>Top sections</th></tr></thead><tbody>${items.map((item) => `
    <tr><td><div class="title">${escapeHtml(item.angle)}</div></td><td>${escapeHtml(item.format)}</td><td>${item.sample_count}</td><td>${item.section_patterns.slice(0, 4).map((entry) => escapeHtml(entry.value)).join(" · ") || "—"}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderContent(items) {
  if (!items.length) {
    content.innerHTML = emptyState("draft", "No topics are ready", "Candidates appear automatically when a destination reaches the required independent evidence threshold.");
    return;
  }
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Topic</th><th>Coverage</th><th>Evidence</th><th>Pipeline</th><th>QA / WordPress</th></tr></thead><tbody>${items.map((item) => `
    <tr data-topic="${item.id}" ${item.draft_id ? `data-draft="${item.draft_id}" tabindex="0"` : ""}>
      <td><div class="title">${escapeHtml(item.draft_title || item.proposed_title)}</div><div class="subtle">${escapeHtml(item.rationale)}</div>${item.suppression_reason ? `<div class="suppression">Suppressed: ${escapeHtml(item.suppression_reason)}</div>` : ""}</td>
      <td>${Math.round(item.coverage_score)} / 100</td><td>${item.evidence_count} sources · ${item.conflict_count} conflicts<div class="subtle">${item.stale_fact_count || 0} stale · ${item.verification_fact_count || 0} to verify</div></td>
      <td><span class="badge ${item.draft_status || item.brief_status || item.status}">${label(item.draft_status || item.brief_status || item.status)}</span>${item.status === "candidate" ? `<div class="actions"><button class="primary generate" data-id="${item.id}" ${state.health?.contentAutomationConfigured ? "" : "disabled title='Configure OPENAI_API_KEY first'"}>Generate</button></div>` : ""}</td>
      <td>${item.qa_score == null ? "—" : `${Math.round(item.qa_score)} · ${item.qa_passed ? "passed" : "failed"}`}<div class="subtle">Commercial: ${label(item.commercial_status || "pending")} (${item.commercial_offer_count || 0}) · WP: ${label(item.wordpress_status || "not_synced")}</div></td>
    </tr>`).join("")}</tbody></table></div>`;
  content.querySelectorAll("button.generate").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await api(`/api/topics/${button.dataset.id}/generate`, { method: "POST" });
      toast("Content generation queued");
      await refresh();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  }));
  content.querySelectorAll("tr[data-draft]").forEach((row) => {
    row.addEventListener("click", () => openDraft(row.dataset.draft));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter") void openDraft(row.dataset.draft); });
  });
}

function renderWordPressInventory({ configured, sync, items }) {
  if (!configured) {
    content.innerHTML = emptyState("wordpress", "Connect WordPress", "Add your site URL and an Application Password to enable automatic read-only inventory sync.");
    return;
  }
  const summary = `<div class="inventory-summary"><strong>${items.length} posts tracked</strong><span>Sync: ${label(sync?.status || "pending")} ${sync?.last_succeeded_at ? `· ${date(sync.last_succeeded_at)}` : ""}</span>${sync?.last_error ? `<span class="error-text">${escapeHtml(sync.last_error)}</span>` : ""}</div>`;
  if (!items.length) {
    content.innerHTML = `${summary}${emptyState("wordpress", "Inventory is empty", "The first sync is still pending, or this WordPress site has no posts.")}`;
    return;
  }
  content.innerHTML = `${summary}<div class="table-wrap"><table><thead><tr><th>Post</th><th>Status</th><th>Slug</th><th>Modified</th></tr></thead><tbody>${items.map((item) => `
    <tr><td><div class="title">${item.post_url ? `<a href="${escapeHtml(item.post_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title || "Untitled")}</a>` : escapeHtml(item.title || "Untitled")}</div><div class="subtle">WordPress #${item.post_id}</div></td>
    <td><span class="badge ${item.status}">${label(item.status)}</span></td><td>${escapeHtml(item.slug)}</td><td>${item.modified_at ? date(item.modified_at) : "—"}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderCommercial(items) {
  if (!items.length) {
    content.innerHTML = emptyState("offer", "No active offers", "Research drafts stay complete and can reach WordPress even when the commercial layer is empty.");
    return;
  }
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Offer</th><th>Destination</th><th>Category</th><th>Provider</th><th>Status</th></tr></thead><tbody>${items.map((item) => `
    <tr><td><div class="title">${escapeHtml(item.title || item.offer_key || item.id)}</div><div class="subtle">Priority ${item.priority} · ${escapeHtml(item.price_text || "No price copy")}</div></td>
    <td>${escapeHtml(item.destination_slug)}</td><td>${label(item.category)}</td><td>${escapeHtml(item.provider)}</td>
    <td><span class="badge ${item.active ? "active" : ""}">${item.active ? "Active" : "Inactive"}</span><div class="subtle">${item.valid_until ? `Until ${date(item.valid_until)}` : "No expiry"}</div></td></tr>`).join("")}</tbody></table></div>`;
}

function renderExceptions(items) {
  if (!items.length) {
    content.innerHTML = emptyState("check", "Everything looks good", "The pipeline has no operational exceptions that require your attention.", "healthy-empty");
    return;
  }
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Issue</th><th>Kind</th><th>Severity</th><th>Updated</th><th>Action</th></tr></thead><tbody>${items.map((item) => `
    <tr><td><div class="title">${escapeHtml(item.title)}</div><div>${escapeHtml(item.subject)}</div><div class="subtle">${escapeHtml(item.detail)}</div></td>
    <td>${label(item.kind)}</td><td><span class="badge ${item.severity}">${label(item.severity)}</span></td><td>${item.updatedAt ? date(item.updatedAt) : "—"}</td>
    <td>${item.retryable ? `<button class="primary retry-exception" data-key="${escapeHtml(item.key)}">Retry</button>` : '<span class="subtle">New evidence required</span>'}</td></tr>`).join("")}</tbody></table></div>`;
  content.querySelectorAll("button.retry-exception").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`/api/exceptions/${encodeURIComponent(button.dataset.key)}/retry`, { method: "POST" });
      toast("Retry queued");
      await refresh();
    } catch (error) {
      toast(error.message, true);
      button.disabled = false;
    }
  }));
}

function renderMaintenance(data) {
  const wordpress = data.wordpressSync;
  const telemetry = data.telemetry;
  const recent = telemetry.recent;
  const notifications = data.notifications;
  const notificationState = notifications.configured
    ? notifications.failed ? "Delivery issue" : notifications.lastSentAt ? "Connected" : "Ready"
    : "Not configured";
  content.innerHTML = `
    <section class="operations-grid" aria-label="Operational health">
      ${operationCard("queue", "Active queue", telemetry.active, telemetry.oldestQueuedAgeSeconds ? `Oldest waiting ${formatDuration(telemetry.oldestQueuedAgeSeconds * 1000)}` : "No waiting jobs", telemetry.active ? "attention" : "success")}
      ${operationCard("check", "Success rate", recent.successRate == null ? "—" : `${recent.successRate}%`, `${recent.completed} completed in ${telemetry.windowHours}h`, recent.failed ? "attention" : "success")}
      ${operationCard("timer", "Queue p95", formatDuration(recent.queueLatencyMs.p95), `${recent.queueLatencyMs.samples} measured jobs`)}
      ${operationCard("speed", "Processing p95", formatDuration(recent.durationMs.p95), `${recent.durationMs.samples} measured jobs`)}
      ${operationCard("bell", "Exception alerts", notificationState, notifications.configured ? `Repeat after ${notifications.repeatHours}h · ${notifications.minimumSeverity}+` : "Optional HTTPS webhook", notifications.failed ? "problem" : notifications.configured ? "success" : "")}
    </section>
    <div class="inventory-summary"><strong>${data.enabled ? "Automatic maintenance enabled" : "Automatic maintenance disabled"}</strong><span>Checks every ${data.intervalMinutes} minutes · ${label(data.logging.format)} logs</span><button class="primary" id="run-maintenance" ${data.enabled ? "" : "disabled"}>Run now</button></div>
    <div class="section-heading"><div><strong>Maintenance tasks</strong><span>Durable schedules survive restarts</span></div></div>
    <div class="table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Last success</th><th>Items</th><th>Result</th></tr></thead><tbody>
    ${data.runs.map((run) => `<tr><td><div class="title">${label(run.task_key)}</div></td><td><span class="badge ${run.status}">${label(run.status)}</span></td><td>${run.last_succeeded_at ? date(run.last_succeeded_at) : "—"}</td><td>${run.item_count}</td><td><div class="subtle">${escapeHtml(run.last_error || maintenanceResult(run.metadata))}</div></td></tr>`).join("")}
    <tr><td><div class="title">WordPress inventory</div></td><td><span class="badge ${wordpress?.status || ""}">${label(wordpress?.status || "not_configured")}</span></td><td>${wordpress?.last_succeeded_at ? date(wordpress.last_succeeded_at) : "—"}</td><td>${wordpress?.item_count || 0}</td><td><div class="subtle">${escapeHtml(wordpress?.last_error || "Read-only synchronization")}</div></td></tr>
    </tbody></table></div>
    ${telemetry.types.length ? `<div class="section-heading"><div><strong>Job performance</strong><span>Rolling ${telemetry.windowHours}-hour window</span></div></div>
      <div class="table-wrap"><table><thead><tr><th>Job type</th><th>Queued</th><th>Running</th><th>Completed</th><th>Success</th><th>p95 duration</th></tr></thead><tbody>
      ${telemetry.types.map((item) => `<tr><td><div class="title">${label(item.type)}</div></td><td>${item.queued}</td><td>${item.running}</td><td>${item.completed}</td><td>${item.completed ? `${Math.round(item.succeeded / item.completed * 100)}%` : "—"}</td><td>${formatDuration(item.durationP95Ms)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}`;
  document.querySelector("#run-maintenance")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api("/api/maintenance/run", { method: "POST" });
      toast("Maintenance run completed");
      await refresh();
    } catch (error) {
      toast(error.message, true);
      event.currentTarget.disabled = false;
    }
  });
}

function operationCard(iconName, title, value, detail, tone = "") {
  return `<article class="operation-card ${tone}"><span class="operation-icon">${icon(iconName)}</span><div><span>${escapeHtml(title)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div></article>`;
}

function formatDuration(milliseconds) {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 100) / 10} sec`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} min`;
  return `${Math.round(milliseconds / 360_000) / 10} hr`;
}

function maintenanceResult(metadata) {
  if (metadata?.backup) return `${metadata.backup} · schema ${metadata.schemaVersion} · ${metadata.bytes} bytes · SHA ${metadata.sha256?.slice(0, 12) || "—"}`;
  if (metadata?.retentionDays) return `${metadata.retentionDays}-day retention`;
  return "Completed";
}

async function openDraft(id) {
  try {
    const item = await api(`/api/drafts/${id}`);
    const { draft, review, commercial_composition: composition } = item;
    document.querySelector("#detail").innerHTML = `<p class="eyebrow">ARTICLE DRAFT · REVISION ${draft.revision}</p><h2>${escapeHtml(draft.title)}</h2>
      <p><span class="badge ${draft.status}">${label(draft.status)}</span> · QA ${review ? `${Math.round(review.score)} / 100` : "pending"}</p>
      ${review?.passed && state.health?.wordpressConfigured && draft.status === "ready_for_wordpress" ? '<div class="actions"><button class="primary" id="push-wordpress">Send to WordPress drafts</button></div>' : ""}
      ${review?.issues?.length ? `<section class="panel"><h3>QA issues</h3><ul>${review.issues.map((issue) => `<li><strong>${escapeHtml(issue.severity)}</strong>: ${escapeHtml(issue.message)}</li>`).join("")}</ul></section>` : ""}
      <div class="detail-grid" style="margin-top:18px"><section class="panel wide"><h3>Reader-facing Markdown</h3><div class="draft-body">${escapeHtml(draft.body_markdown)}</div></section>
      <section class="panel wide"><h3>Internal evidence ledger</h3><p>${draft.evidence_ledger.length} mapped sections · ${draft.unresolved_conflicts.length} unresolved conflicts · ${draft.verification_notes.length} time-sensitive verification notes</p></section>
      <section class="panel wide"><h3>Commercial overlay</h3><p>${composition ? `${composition.offer_ids.length} offers · ${label(composition.status)}` : "Pending composition"}</p>${composition?.status === "composed" ? `<div class="draft-body">${escapeHtml(composition.publishable_body_markdown.slice(draft.body_markdown.length).trim())}</div>` : ""}</section></div>`;
    dialog.showModal();
    document.querySelector("#push-wordpress")?.addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        await api(`/api/drafts/${id}/wordpress`, { method: "POST" });
        dialog.close();
        toast("Draft sent to WordPress");
        await refresh();
      } catch (error) {
        toast(error.message, true);
        event.currentTarget.disabled = false;
      }
    });
  } catch (error) {
    toast(error.message, true);
  }
}

async function openSource(id) {
  try {
    const source = await api(`/api/sources/${id}`);
    document.querySelector("#detail").innerHTML = `<p class="eyebrow">SOURCE DETAIL</p><h2>${escapeHtml(source.title || "Untitled note")}</h2>
      <p><a href="${escapeHtml(source.canonical_url)}" target="_blank" rel="noreferrer">Open original</a> · <span class="badge ${source.status}">${label(source.status)}</span></p>
      <div class="actions"><button class="primary" id="retry">Re-run extraction</button></div>
      <div class="detail-grid">
        <section class="panel"><h3>Structured source</h3><p>${escapeHtml(source.structured?.summary || "Pending extraction")}</p><p class="subtle">Destination: ${escapeHtml(source.structured?.destination_name || "—")} · confidence ${source.structured?.confidence ?? "—"}</p></section>
        <section class="panel"><h3>Source blueprint</h3><p>${escapeHtml(source.blueprint?.angle || "Pending extraction")}</p><p class="subtle">${escapeHtml(source.blueprint?.format || "—")}</p></section>
        <section class="panel wide"><h3>Claims (${source.claims.length})</h3>${source.claims.length ? `<ul>${source.claims.map((claim) => `<li><strong>${escapeHtml(claim.subject)} ${escapeHtml(claim.predicate)}</strong>: ${escapeHtml(claim.value_text)}<div class="subtle">“${escapeHtml(claim.source_quote)}”</div></li>`).join("")}</ul>` : "<p>No claims extracted.</p>"}</section>
        <section class="panel wide"><h3>Raw captured text</h3><div class="raw">${escapeHtml(source.raw_text)}</div></section>
      </div>`;
    document.querySelector("#retry").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      try {
        await api(`/api/sources/${id}/retry`, { method: "POST" });
        dialog.close();
        toast("Extraction queued");
        await refresh();
      } catch (error) {
        toast(error.message, true);
        event.currentTarget.disabled = false;
      }
    });
    dialog.showModal();
  } catch (error) {
    toast(error.message, true);
  }
}

async function api(url, options = {}, canPrompt = true) {
  const adminToken = sessionStorage.getItem("solo_admin_token");
  const headers = { ...(options.headers || {}), ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) };
  const response = await fetch(url, { ...options, headers });
  const body = await response.json();
  if (response.status === 401 && options.method && options.method !== "GET" && canPrompt) {
    const supplied = prompt("Enter ADMIN_TOKEN for this browser session:");
    if (supplied) {
      sessionStorage.setItem("solo_admin_token", supplied);
      return api(url, options, false);
    }
  }
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function emptyState(iconName, title, description, extraClass = "") {
  return `<div class="empty ${extraClass}"><span class="empty-icon">${icon(iconName)}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`;
}

function loadingState(message) {
  return `<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></div>`;
}

function toast(message, isError = false) {
  const element = document.createElement("div");
  element.className = "toast";
  if (isError) element.style.background = "rgba(180, 20, 30, .94)";
  element.textContent = message;
  document.querySelector("#toast-region").append(element);
  setTimeout(() => element.remove(), 3000);
}

function icon(name) {
  const paths = {
    source: '<path d="M7 3.5h7l4 4V20.5H7z"/><path d="M14 3.5v4h4M10 12h5M10 15.5h5"/>',
    claim: '<path d="M6 5.5h12v10H9l-3 3z"/><path d="M9.5 9h5M9.5 12h3.5"/>',
    knowledge: '<path d="M5 5.5c3.1-.7 5.4-.1 7 1.6v12c-1.6-1.7-3.9-2.3-7-1.6zM19 5.5c-3.1-.7-5.4-.1-7 1.6v12c1.6-1.7 3.9-2.3 7-1.6z"/>',
    conflict: '<path d="m12 3.5 9 16H3z"/><path d="M12 9v4.5M12 17h.01"/>',
    topic: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5V6M20.5 12H18M12 20.5V18M3.5 12H6"/>',
    draft: '<path d="M5 4.5h9l5 5v10H5z"/><path d="M14 4.5v5h5M8.5 13h7M8.5 16h5"/>',
    wordpress: '<circle cx="12" cy="12" r="9"/><path d="m7.5 8 3.5 9M16.5 8 13 17M6.5 8h3M14.5 8h3"/>',
    offer: '<path d="M4.5 8.5 12 4l7.5 4.5v8L12 21l-7.5-4.5z"/><path d="m4.5 8.5 7.5 4.3 7.5-4.3M12 12.8V21"/>',
    exception: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
    queue: '<path d="M5 6.5h14M5 12h14M5 17.5h9"/><circle cx="18" cy="17.5" r="1.5"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M9 3h6M12 13V8M12 13l3 2"/>',
    speed: '<path d="M5.6 18a8 8 0 1 1 12.8 0M12 14l4-5"/><path d="M4 14h2M18 14h2M12 5v2"/>',
    bell: '<path d="M6.5 16.5h11l-1.2-2V10a4.3 4.3 0 0 0-8.6 0v4.5zM10 19h4"/>',
    blueprint: '<path d="M12 3.5a6 6 0 0 0-3.5 10.9V17h7v-2.6A6 6 0 0 0 12 3.5ZM9.5 20h5"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/>',
    offline: '<path d="M4 4l16 16M8.5 5.2A9 9 0 0 1 21 12c0 1.9-.6 3.7-1.6 5.2M5.2 8.5A9 9 0 0 0 17 19.4"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.source}</svg>`;
}

function label(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function date(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
