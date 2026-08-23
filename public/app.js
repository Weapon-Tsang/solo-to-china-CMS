const state = { view: "sources" };
const content = document.querySelector("#content");
const notice = document.querySelector("#notice");
const dialog = document.querySelector("#detail-dialog");

document.querySelector(".close").addEventListener("click", () => dialog.close());
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    void loadView();
  });
}

await refresh();
setInterval(refresh, 60_000);

async function refresh() {
  try {
    const [health, dashboard] = await Promise.all([api("/api/health"), api("/api/dashboard")]);
    state.health = health;
    document.querySelector("#health").textContent = health.aiConfigured
      ? `AI ready · WordPress ${health.wordpressConfigured ? "ready" : "not configured"}`
      : "Capture ready · AI key not configured";
    renderMetrics(dashboard.totals);
    notice.classList.toggle("hidden", health.aiConfigured);
    notice.textContent = "OPENAI_API_KEY is not configured. Captures are safe, but multimodal claims and blueprints remain pending.";
    await loadView();
  } catch (error) {
    document.querySelector("#health").textContent = "Offline";
    content.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadView() {
  if (state.view === "sources") return renderSources((await api("/api/sources")).items);
  if (state.view === "knowledge") return renderKnowledge((await api("/api/knowledge")).items);
  if (state.view === "blueprints") return renderBlueprints((await api("/api/editorial-blueprints")).items);
  if (state.view === "content") return renderContent((await api("/api/content")).items);
  return renderCommercial((await api("/api/commercial/offers")).items);
}

function renderMetrics(totals) {
  const values = [
    [totals.sources, "Sources"], [totals.claims, "Claims"], [totals.knowledgeFacts, "Knowledge facts"],
    [totals.conflicts, "Conflicts"], [totals.topicCandidates, "Topic candidates"],
    [totals.draftsReady, "Drafts ready"], [totals.activeOffers, "Active offers"], [totals.exceptions, "Exceptions"],
  ];
  document.querySelector("#metrics").innerHTML = values.map(([value, label]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
}

function renderSources(items) {
  if (!items.length) return content.innerHTML = '<div class="empty">No sources yet. Open a Xiaohongshu note and click “Save to SoloToChina”.</div>';
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Status</th><th>Destination</th><th>Claims</th><th>Captured</th></tr></thead><tbody>${items.map((item) => `
    <tr data-id="${item.id}"><td><div class="title">${escapeHtml(item.title || "Untitled note")}</div><div class="subtle">${escapeHtml(item.author_name || "Unknown author")} · v${item.capture_version}</div></td>
    <td><span class="badge ${item.status}">${escapeHtml(item.status)}</span></td><td>${escapeHtml(item.destination_name || "—")}</td><td>${item.claim_count}</td><td>${date(item.captured_at)}</td></tr>`).join("")}</tbody></table></div>`;
  content.querySelectorAll("tr[data-id]").forEach((row) => row.addEventListener("click", () => openSource(row.dataset.id)));
}

function renderKnowledge(items) {
  if (!items.length) return content.innerHTML = '<div class="empty">Knowledge facts appear after claims are extracted.</div>';
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Destination</th><th>Claim</th><th>Value</th><th>Evidence</th><th>State</th></tr></thead><tbody>${items.map((item) => `
    <tr><td>${escapeHtml(item.destination_name)}</td><td><div class="title">${escapeHtml(item.subject)} · ${escapeHtml(item.predicate)}</div><div class="subtle">${escapeHtml(item.normalized_key)}</div></td><td>${escapeHtml(item.preferred_value)}</td><td>${item.evidence.length}</td><td><span class="badge ${item.consensus_status}">${item.consensus_status}</span></td></tr>`).join("")}</tbody></table></div>`;
}

function renderBlueprints(items) {
  if (!items.length) return content.innerHTML = '<div class="empty">Editorial patterns appear after source blueprints are extracted.</div>';
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Pattern</th><th>Format</th><th>Samples</th><th>Top sections</th></tr></thead><tbody>${items.map((item) => `
    <tr><td><div class="title">${escapeHtml(item.angle)}</div></td><td>${escapeHtml(item.format)}</td><td>${item.sample_count}</td><td>${item.section_patterns.slice(0, 4).map((entry) => escapeHtml(entry.value)).join(" · ") || "—"}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderContent(items) {
  if (!items.length) return content.innerHTML = '<div class="empty">Topic candidates appear automatically when a destination reaches the configured evidence threshold.</div>';
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Topic</th><th>Coverage</th><th>Evidence</th><th>Pipeline</th><th>QA / WordPress</th></tr></thead><tbody>${items.map((item) => `
    <tr data-topic="${item.id}" ${item.draft_id ? `data-draft="${item.draft_id}"` : ""}>
      <td><div class="title">${escapeHtml(item.draft_title || item.proposed_title)}</div><div class="subtle">${escapeHtml(item.rationale)}</div></td>
      <td>${Math.round(item.coverage_score)} / 100</td><td>${item.evidence_count} sources · ${item.conflict_count} conflicts</td>
      <td><span class="badge ${item.draft_status || item.brief_status || item.status}">${escapeHtml(item.draft_status || item.brief_status || item.status)}</span>${item.status === "candidate" ? `<div class="actions"><button class="primary generate" data-id="${item.id}" ${state.health?.contentAutomationConfigured ? "" : "disabled title='Configure OPENAI_API_KEY first'"}>Generate</button></div>` : ""}</td>
      <td>${item.qa_score == null ? "—" : `${Math.round(item.qa_score)} · ${item.qa_passed ? "passed" : "failed"}`}<div class="subtle">Commercial: ${escapeHtml(item.commercial_status || "pending")} (${item.commercial_offer_count || 0}) · WP: ${escapeHtml(item.wordpress_status || "not synced")}</div></td>
    </tr>`).join("")}</tbody></table></div>`;
  content.querySelectorAll("button.generate").forEach((button) => button.addEventListener("click", async (event) => {
    event.stopPropagation(); button.disabled = true;
    try { await api(`/api/topics/${button.dataset.id}/generate`, { method: "POST" }); await refresh(); }
    catch (error) { alert(error.message); button.disabled = false; }
  }));
  content.querySelectorAll("tr[data-draft]").forEach((row) => row.addEventListener("click", () => openDraft(row.dataset.draft)));
}

function renderCommercial(items) {
  if (!items.length) return content.innerHTML = '<div class="empty">No commercial offers synced. Research drafts remain complete and can still reach WordPress without offers.</div>';
  content.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Offer</th><th>Destination</th><th>Category</th><th>Provider</th><th>Status</th></tr></thead><tbody>${items.map((item) => `
    <tr><td><div class="title">${escapeHtml(item.title || item.offer_key || item.id)}</div><div class="subtle">Priority ${item.priority} · ${escapeHtml(item.price_text || "No price copy")}</div></td>
    <td>${escapeHtml(item.destination_slug)}</td><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.provider)}</td>
    <td><span class="badge ${item.active ? "processed" : ""}">${item.active ? "active" : "inactive"}</span><div class="subtle">${item.valid_until ? `until ${date(item.valid_until)}` : "no expiry"}</div></td></tr>`).join("")}</tbody></table></div>`;
}

async function openDraft(id) {
  const item = await api(`/api/drafts/${id}`);
  const draft = item.draft;
  const review = item.review;
  const composition = item.commercial_composition;
  document.querySelector("#detail").innerHTML = `<p class="eyebrow" style="color:var(--green)">ARTICLE DRAFT · REVISION ${draft.revision}</p><h2>${escapeHtml(draft.title)}</h2>
    <p><span class="badge ${draft.status}">${escapeHtml(draft.status)}</span> · QA ${review ? `${Math.round(review.score)} / 100` : "pending"}</p>
    ${review?.passed && state.health?.wordpressConfigured && draft.status === "ready_for_wordpress" ? '<div class="actions"><button class="primary" id="push-wordpress">Send to WordPress drafts</button></div>' : ""}
    ${review?.issues?.length ? `<section class="panel"><h3>QA issues</h3><ul>${review.issues.map((issue) => `<li><strong>${escapeHtml(issue.severity)}</strong>: ${escapeHtml(issue.message)}</li>`).join("")}</ul></section>` : ""}
    <div class="detail-grid" style="margin-top:18px"><section class="panel wide"><h3>Reader-facing Markdown</h3><div class="draft-body">${escapeHtml(draft.body_markdown)}</div></section>
    <section class="panel wide"><h3>Internal evidence ledger</h3><p>${draft.evidence_ledger.length} mapped sections · ${draft.unresolved_conflicts.length} unresolved conflicts</p></section>
    <section class="panel wide"><h3>Commercial overlay</h3><p>${composition ? `${composition.offer_ids.length} offers · ${escapeHtml(composition.status)}` : "Pending composition"}</p>${composition?.status === "composed" ? `<div class="draft-body">${escapeHtml(composition.publishable_body_markdown.slice(draft.body_markdown.length).trim())}</div>` : ""}</section></div>`;
  dialog.showModal();
  document.querySelector("#push-wordpress")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try { await api(`/api/drafts/${id}/wordpress`, { method: "POST" }); dialog.close(); await refresh(); }
    catch (error) { alert(error.message); event.currentTarget.disabled = false; }
  });
}

async function openSource(id) {
  const source = await api(`/api/sources/${id}`);
  document.querySelector("#detail").innerHTML = `<p class="eyebrow" style="color:var(--green)">SOURCE DETAIL</p><h2>${escapeHtml(source.title || "Untitled note")}</h2>
    <p><a href="${escapeHtml(source.canonical_url)}" target="_blank" rel="noreferrer">Open original</a> · <span class="badge ${source.status}">${source.status}</span></p>
    <div class="actions"><button class="primary" id="retry">Re-run extraction</button></div>
    <div class="detail-grid">
      <section class="panel"><h3>Structured source</h3><p>${escapeHtml(source.structured?.summary || "Pending extraction")}</p><p class="subtle">Destination: ${escapeHtml(source.structured?.destination_name || "—")} · confidence ${source.structured?.confidence ?? "—"}</p></section>
      <section class="panel"><h3>Source blueprint</h3><p>${escapeHtml(source.blueprint?.angle || "Pending extraction")}</p><p class="subtle">${escapeHtml(source.blueprint?.format || "—")}</p></section>
      <section class="panel wide"><h3>Claims (${source.claims.length})</h3>${source.claims.length ? `<ul>${source.claims.map((claim) => `<li><strong>${escapeHtml(claim.subject)} ${escapeHtml(claim.predicate)}</strong>: ${escapeHtml(claim.value_text)}<div class="subtle">“${escapeHtml(claim.source_quote)}”</div></li>`).join("")}</ul>` : "<p>No claims extracted.</p>"}</section>
      <section class="panel wide"><h3>Raw captured text</h3><div class="raw">${escapeHtml(source.raw_text)}</div></section>
    </div>`;
  document.querySelector("#retry").addEventListener("click", async () => { await api(`/api/sources/${id}/retry`, { method: "POST" }); dialog.close(); await refresh(); });
  dialog.showModal();
}

async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function date(value) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
