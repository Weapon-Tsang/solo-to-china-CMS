const DEFAULT_ENDPOINT = "http://127.0.0.1:4310";
const DEFAULT_CAPTURE_TOKEN = "";
const CLOUD_CONFIGURED = false;
const saveButton = document.querySelector("#save");
const settingsButton = document.querySelector("#save-settings");
const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");
const feedback = document.querySelector("#feedback");
const feedbackIcon = document.querySelector("#feedback-icon");
const feedbackTitle = document.querySelector("#feedback-title");
const feedbackDetail = document.querySelector("#feedback-detail");
const settingsPanel = document.querySelector("#connection-settings");

void restoreSettings();
saveButton.addEventListener("click", saveCurrentNote);
settingsButton.addEventListener("click", saveSettings);

async function restoreSettings() {
  const settings = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: DEFAULT_CAPTURE_TOKEN, lastCapture: null });
  endpointInput.value = settings.endpoint;
  tokenInput.value = settings.token;
  if (CLOUD_CONFIGURED) settingsPanel.hidden = true;
  if (settings.lastCapture) renderCaptureFeedback(settings.lastCapture);
}

async function saveSettings() {
  await chrome.storage.local.set({ endpoint: endpointInput.value.replace(/\/$/, ""), token: tokenInput.value });
  show("Settings saved.", "success");
  showFeedback("success", "Connection settings saved", "The extension will use this Engine address.");
}

async function saveCurrentNote() {
  saveButton.disabled = true;
  setSaveButton("saving", "Saving note");
  showFeedback("working", "Reading current note", "Only the note you explicitly opened is being captured.");
  show("Reading the current note…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(www\.)?xiaohongshu\.com\/explore\//.test(tab.url || "")) {
      throw new Error("Open a Xiaohongshu note (/explore/…) first.");
    }

    const [{ result: capture }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractVisibleNote,
    });
    if (!capture?.text || capture.text.length < 20) throw new Error("Could not read enough visible note content. Try opening the note detail page.");

    const settings = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, token: DEFAULT_CAPTURE_TOKEN });
    show("Saving and queuing extraction…");
    const response = await fetch(`${settings.endpoint.replace(/\/$/, "")}/api/captures`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
      },
      body: JSON.stringify(capture),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Save failed (${response.status}).`);
    const noteIdentity = body.identity?.externalId ? `XHS ID ${body.identity.externalId}` : "this note";
    show(body.duplicate ? `Already saved — ${noteIdentity} is up to date and was not queued again.` : `Saved — ${noteIdentity} is queued for extraction.`, "success");
    const saved = {
      id: body.id,
      title: capture.title || "This note",
      stage: body.duplicate ? "duplicate" : "saved",
      claimCount: null,
      externalId: body.identity?.externalId || null,
      captureVersion: body.captureVersion || null,
      savedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ lastCapture: saved });
    renderCaptureFeedback(saved);
    setSaveButton("success", body.duplicate ? "Already saved" : "Saved to Sources");
    await watchExtraction(settings, saved);
  } catch (error) {
    show(error.message || String(error), "error");
    showFeedback("error", "Save did not complete", error.message || String(error));
    setSaveButton("idle", "Try again");
  } finally {
    saveButton.disabled = false;
    if (!saveButton.classList.contains("is-success")) setSaveButton("idle", "Save current note");
  }
}

function show(message, kind = "") {
  status.textContent = message;
  status.className = kind;
}

function setSaveButton(state, label) {
  saveButton.classList.remove("is-saving", "is-success");
  if (state === "saving") saveButton.classList.add("is-saving");
  if (state === "success") saveButton.classList.add("is-success");
  saveButton.textContent = label;
}

function showFeedback(kind, title, detail) {
  feedback.className = `visible ${kind}`;
  feedbackIcon.textContent = kind === "error" ? "!" : kind === "warning" ? "!" : kind === "working" ? "…" : "✓";
  feedbackTitle.textContent = title;
  feedbackDetail.textContent = detail;
}

function renderCaptureFeedback(capture) {
  const name = String(capture.title || "This note").trim();
  if (capture.stage === "processed") {
    const claims = Number.isInteger(capture.claimCount) ? ` ${capture.claimCount} claims extracted.` : " Structured research is ready.";
    showFeedback("success", "Extraction complete", `${name} is ready in Sources.${claims}`);
    setSaveButton("success", "Extraction complete");
    return;
  }
  if (capture.stage === "needs_ai") {
    showFeedback("warning", "Saved to Sources · Kimi paused", `${name} is safe. Add KIMI_API_KEY, restart the Engine, then re-run extraction.`);
    setSaveButton("success", "Saved to Sources");
    return;
  }
  if (capture.stage === "exception") {
    showFeedback("error", "Saved, but extraction needs attention", capture.error || `${name} remains safe in Sources. Open it in the dashboard and choose Re-run extraction.`);
    setSaveButton("idle", "Save current note");
    return;
  }
  if (capture.stage === "queued") {
    showFeedback("working", "Saved to Sources", `${name} is stored safely. Extraction is still running in the background.`);
    setSaveButton("success", "Saved to Sources");
    return;
  }
  if (capture.stage === "duplicate") {
    const identity = capture.externalId ? `XHS ID ${capture.externalId}` : "This note";
    showFeedback("success", "Already saved", `${identity} is already up to date in Sources and was not queued again.`);
    setSaveButton("success", "Already saved");
    return;
  }
  showFeedback("success", "Saved to Sources", `${name} is safely stored. Checking extraction status…`);
}

async function watchExtraction(settings, saved) {
  const endpoint = settings.endpoint.replace(/\/$/, "");
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/api/sources/${saved.id}`, {
        headers: settings.token ? { authorization: `Bearer ${settings.token}` } : {},
      });
      const source = await response.json();
      if (!response.ok) return;
      const stage = source.status;
      if (["processed", "needs_ai", "exception"].includes(stage)) {
        const updated = {
          ...saved,
          stage,
          claimCount: Array.isArray(source.claims) ? source.claims.length : null,
          error: source.last_error || "",
          checkedAt: new Date().toISOString(),
        };
        await chrome.storage.local.set({ lastCapture: updated });
        renderCaptureFeedback(updated);
        return;
      }
    } catch {
      // A saved source remains successful even if the optional status poll is interrupted.
      return;
    }
    await delay(1_500);
  }
  const queued = { ...saved, stage: "queued", checkedAt: new Date().toISOString() };
  await chrome.storage.local.set({ lastCapture: queued });
  renderCaptureFeedback(queued);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// This function is injected only after the user presses Save. It reads the active page DOM;
// it does not request cookies, tokens, private APIs, pagination, or background navigation.
function extractVisibleNote() {
  const pickText = (selectors) => {
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = node?.innerText?.trim() || node?.textContent?.trim();
      if (value) return value;
    }
    return "";
  };
  const meta = (name, property = false) => document.querySelector(`meta[${property ? "property" : "name"}="${name}"]`)?.content || "";
  const title = pickText(["#detail-title", "[class*='title']", "h1"]) || meta("og:title", true) || document.title;
  const description = pickText(["#detail-desc", "[class*='desc']", "article"]) || meta("description");
  const authorElement = document.querySelector("[class*='author'] a, [class*='user'] a, a[href*='/user/profile/']");
  const authorName = authorElement?.innerText?.trim() || pickText(["[class*='author']", "[class*='username']"]);
  const imageMap = new Map();
  for (const image of document.querySelectorAll("main img, article img, [class*='note'] img, [class*='swiper'] img")) {
    const url = image.currentSrc || image.src;
    if (/^https?:\/\//.test(url) && image.naturalWidth >= 200 && image.naturalHeight >= 150) {
      imageMap.set(url, { url, alt: image.alt || "" });
    }
  }
  const clone = (document.querySelector("main") || document.body).cloneNode(true);
  clone.querySelectorAll("script, style, noscript, svg, iframe, button, input, textarea").forEach((node) => node.remove());
  const bodyText = document.body?.innerText?.trim() || "";
  return {
    url: location.href,
    title,
    text: [title, description || bodyText].filter(Boolean).join("\n\n"),
    html: clone.innerHTML.slice(0, 1_500_000),
    author: {
      name: authorName,
      url: authorElement?.href || "",
    },
    publishedAt: document.querySelector("time")?.dateTime || "",
    images: [...imageMap.values()],
    capturedAt: new Date().toISOString(),
    client: {
      extensionVersion: chrome.runtime.getManifest().version,
      pageLocale: document.documentElement.lang || navigator.language,
    },
  };
}
