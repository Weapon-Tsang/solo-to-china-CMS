const saveButton = document.querySelector("#save");
const settingsButton = document.querySelector("#save-settings");
const endpointInput = document.querySelector("#endpoint");
const tokenInput = document.querySelector("#token");
const status = document.querySelector("#status");

void restoreSettings();
saveButton.addEventListener("click", saveCurrentNote);
settingsButton.addEventListener("click", saveSettings);

async function restoreSettings() {
  const settings = await chrome.storage.local.get({ endpoint: "http://127.0.0.1:4310", token: "" });
  endpointInput.value = settings.endpoint;
  tokenInput.value = settings.token;
}

async function saveSettings() {
  await chrome.storage.local.set({ endpoint: endpointInput.value.replace(/\/$/, ""), token: tokenInput.value });
  show("Settings saved.", "success");
}

async function saveCurrentNote() {
  saveButton.disabled = true;
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

    const settings = await chrome.storage.local.get({ endpoint: "http://127.0.0.1:4310", token: "" });
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
    show(body.duplicate ? "Already saved — capture is up to date." : "Saved. The research pipeline is running.", "success");
  } catch (error) {
    show(error.message || String(error), "error");
  } finally {
    saveButton.disabled = false;
  }
}

function show(message, kind = "") {
  status.textContent = message;
  status.className = kind;
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
