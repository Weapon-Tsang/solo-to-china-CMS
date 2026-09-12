(() => {
  const SELECTORS = Object.freeze({
    noteRoot: ["#noteContainer", "[class*='note-detail']", "[class*='note-content']", "main article", "main"],
    title: ["#detail-title", "[class*='title']", "h1"],
    description: ["#detail-desc", "[class*='desc']", "article"],
    authorLink: ["[class*='author'] a", "[class*='user'] a", "a[href*='/user/profile/']"],
    favoriteCards: ["a[href*='/explore/']", "a[href*='/discovery/item/']"],
    carouselNext: ["button[aria-label*='next' i]", "[class*='swiper-button-next']", "[class*='carousel'] button[class*='next']"],
    carouselIndicators: ["[class*='swiper-pagination'] [class*='bullet']", "[class*='carousel'] [role='tab']", "[class*='indicator']"],
    mediaImages: ["img"],
    mediaVideos: ["video"],
  });

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const discoveryObservation = { identities: new Set(), stableRounds: 0 };
  const first = (selectors, root = document) => selectors.map((selector) => root.querySelector(selector)).find(Boolean) || null;
  const textOf = (selectors, root = document) => {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const text = node?.innerText?.trim() || node?.textContent?.trim();
      if (text) return text;
    }
    return "";
  };

  function scanFavorites({ limit = 100, offset = 0, seenIdentities = [] } = {}) {
    const blocking = detectBlockingPage();
    if (blocking) return { cards: [], blocking, collectionEnd: false, pageUrl: location.href };
    const output = [];
    const seen = new Set(seenIdentities.map((value) => String(value).replace(/^xiaohongshu:/, "")));
    let position = 0;
    for (const selector of SELECTORS.favoriteCards) {
      for (const anchor of document.querySelectorAll(selector)) {
        let url;
        try { url = new URL(anchor.href, location.href); } catch { continue; }
        const externalId = url.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/)?.[1];
        if (!externalId || seen.has(externalId)) continue;
        seen.add(externalId);
        const card = anchor.closest("section,article,li,[class*='note-item'],[class*='card']") || anchor;
        const navigationAnchor = card.querySelector("a.cover[href*='/board/'],a[href*='/board/']") || anchor;
        let navigationUrl;
        try { navigationUrl = new URL(navigationAnchor.href, location.href).toString(); } catch { navigationUrl = url.toString(); }
        const cover = card.querySelector("img");
        if (position++ < Math.max(0, Number(offset) || 0)) continue;
        output.push({
          externalId,
          url: navigationUrl,
          navigationUrl,
          canonicalUrl: `https://www.xiaohongshu.com/explore/${externalId}`,
          title: (card.querySelector("[class*='title']")?.textContent || anchor.title || cover?.alt || "").trim(),
          author: (card.querySelector("[class*='author'],[class*='user']")?.textContent || "").trim(),
          coverUrl: cover?.currentSrc || cover?.src || "",
          position: position - 1,
        });
        if (output.length >= Math.max(1, Math.min(200, Number(limit) || 100))) return discoveryResult(output);
      }
    }
    return discoveryResult(output);
  }

  function discoveryResult(cards) {
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const collectionEnd = explicitCollectionEnd();
    return { cards, scrollY: window.scrollY, scrollHeight: height, collectionEnd, pageUrl: location.href };
  }

  async function scrollFavoritesWindow() {
    const before = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    window.scrollTo({ top: before, behavior: "instant" });
    await waitForMutation(document.documentElement, 1_200);
    const after = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    let newIdentities = 0;
    for (const node of document.querySelectorAll(SELECTORS.favoriteCards.join(","))) {
      const identity = node.href?.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/)?.[1];
      if (identity && !discoveryObservation.identities.has(identity)) { discoveryObservation.identities.add(identity); newIdentities++; }
    }
    const loading = [...document.querySelectorAll("[aria-busy='true'],[class*='loading']")].some(visible);
    const bottom = window.scrollY + window.innerHeight >= after - 80;
    discoveryObservation.stableRounds = bottom && !loading && !newIdentities && after === before ? discoveryObservation.stableRounds + 1 : 0;
    return { advanced: after > before || window.scrollY > 0, scrollY: window.scrollY, scrollHeight: after,
      collectionEnd: explicitCollectionEnd() || discoveryObservation.stableRounds >= 4 };
  }

  function explicitCollectionEnd() {
    return [...document.querySelectorAll("[class*='end-tip'],[class*='no-more'],[class*='load-more']")]
      .some((node) => visible(node) && /没有更多|到底了|no more|all loaded/i.test(node.textContent || ""));
  }

  async function prepareAndExtract({ acquisitionOrigin = "xhs_favorites_sync", syncScopeKey = "", deadlineMs = 120_000 } = {}) {
    const startedAt = Date.now();
    const failure = detectBlockingPage();
    if (failure) return { ok: false, error: failure };
    const externalId = location.pathname.match(/\/(?:explore|discovery\/item)\/([A-Za-z0-9]+)/)?.[1]
      || location.pathname.match(/\/board\/[A-Za-z0-9]+\/([A-Za-z0-9]+)/)?.[1];
    if (!externalId) return error("NAVIGATION_INTERRUPTED", "Xiaohongshu interrupted the note navigation. The worker will reopen this note automatically.", true);

    let root = first(SELECTORS.noteRoot);
    if (!root) root = await waitForSelector(SELECTORS.noteRoot, 30_000);
    const delayedBlock = detectBlockingPage();
    if (delayedBlock) return { ok: false, error: delayedBlock };
    if (!root) return error("CONTENT_NOT_READY", "The note content did not render before the load timeout.", true);

    await expandVisibleText(root);
    const traversal = await traverseMedia(root, startedAt + deadlineMs);
    const domSettled = await settleDom(root, startedAt + deadlineMs);
    const blocked = detectBlockingPage();
    if (blocked) return { ok: false, error: blocked };

    root = first(SELECTORS.noteRoot) || root;
    const title = textOf(SELECTORS.title, root) || meta("og:title", true) || document.title;
    const description = textOf(SELECTORS.description, root) || meta("description");
    const authorElement = first(SELECTORS.authorLink, root) || first(SELECTORS.authorLink);
    const authorName = authorElement?.innerText?.trim() || textOf(["[class*='author']", "[class*='username']"], root);
    const contentClone = root.cloneNode(true);
    contentClone.querySelectorAll("script,style,noscript,svg,iframe,button,input,textarea,[class*='comment'],[class*='recommend'],nav").forEach((node) => node.remove());
    const bodyText = contentClone.innerText?.trim() || contentClone.textContent?.trim() || "";
    if (bodyText.length < 20) return error("SELECTOR_MISMATCH", "The detail page rendered but the complete note text selector returned no usable content.", false);

    const clone = contentClone;
    clone.querySelectorAll("script, style, noscript, svg, iframe, button, input, textarea").forEach((node) => node.remove());
    const html = clone.innerHTML;
    const images = mergeMedia(traversal.images, collectImages(root));
    const videos = mergeMedia(traversal.videos, collectVideos(root));
    const imageExpected = traversal.imageExpected == null ? null : Math.max(traversal.imageExpected, images.length);
    const videoExpected = traversal.videoExpected;
    const imagesComplete = traversal.finished && imageExpected != null && images.length >= imageExpected
      && images.every((image) => image.width > 0 && image.height > 0);
    const videosComplete = traversal.finished && videoExpected != null && videos.length >= videoExpected;
    const text = [title, bodyText || description].filter(Boolean).join("\n\n");
    const textHash = await hash(text);
    const domHash = await hash(html);
    const sourceTimestamp = globalThis.SoloToChinaCaptureUtils?.extractSourceTimestamp(document, root, new Date())
      || { value:document.querySelector("time")?.dateTime || null,kind:"unknown",raw:"",confidence:"low" };
    const capture = {
      url: location.href,
      title,
      text,
      html,
      author: { name: authorName, url: authorElement?.href || "" },
      publishedAt: sourceTimestamp.kind === "published" ? sourceTimestamp.value || "" : "",
      sourceTimestamp,
      images,
      videos,
      capturedAt: new Date().toISOString(),
      acquisitionOrigin,
      syncScopeKey,
      completeness: {
        text: { complete: domSettled, chars: text.length, hash: textHash, detectionMethod: "settled_detail_dom_text" },
        dom: { complete: domSettled, bytes: new TextEncoder().encode(html).byteLength, chunks: 1, hash: domHash, detectionMethod: "settled_detail_dom_snapshot" },
        images: { expected: imageExpected, captured: images.length, complete: imagesComplete, traversed: traversal.finished, detectionMethod: traversal.imageMethod },
        videos: { expected: videoExpected, captured: videos.length, complete: videosComplete, traversed: traversal.finished, detectionMethod: traversal.videoMethod },
        overall: domSettled && imagesComplete && videosComplete ? "complete" : "partial_retryable",
      },
      client: {
        extensionVersion: chrome.runtime.getManifest().version,
        pageLocale: document.documentElement.lang || navigator.language,
        acquisitionOrigin,
        syncScopeKey,
      },
    };
    return { ok: true, capture };
  }

  async function expandVisibleText(root) {
    for (const button of root.querySelectorAll("button,[role='button'],span")) {
      const label = String(button.textContent || "").trim();
      if (/^(展开|更多|全文|show more|read more)$/i.test(label) && visible(button)) {
        button.click();
        await waitForMutation(root, 500);
      }
    }
  }

  async function traverseMedia(root, deadline) {
    const indicators = Math.max(...SELECTORS.carouselIndicators.map((selector) => root.querySelectorAll(selector).length), 0);
    const observed = new Map(collectImages(root).map((item) => [item.mediaIdentity, item]));
    const observedVideos = new Map(collectVideos(root).map((item) => [item.mediaIdentity, item]));
    let stableRounds = 0;
    let finished = true;
    while (Date.now() < deadline) {
      const next = first(SELECTORS.carouselNext, root);
      if (!next || next.disabled || next.getAttribute("aria-disabled") === "true") break;
      const before = observed.size + observedVideos.size;
      next.click();
      await waitForMutation(root, 700);
      for (const image of collectImages(root)) observed.set(image.mediaIdentity, image);
      for (const video of collectVideos(root)) observedVideos.set(video.mediaIdentity, video);
      stableRounds = observed.size + observedVideos.size === before ? stableRounds + 1 : 0;
      if (indicators && observed.size + observedVideos.size >= indicators) break;
      if (!indicators && stableRounds >= 2) break;
    }
    if (Date.now() >= deadline) finished = false;
    const images = [...observed.values()];
    const videos = [...observedVideos.values()];
    return {
      finished,
      imageExpected: indicators ? Math.max(0, indicators - videos.length)
        : root.querySelector(SELECTORS.carouselNext.join(",")) ? null : images.length,
      videoExpected: Math.max(videos.length, root.querySelectorAll(SELECTORS.mediaVideos.join(",")).length),
      imageMethod: indicators ? "carousel_indicator_media_traversal" : "stable_carousel_dom_traversal",
      videoMethod: "video_element_traversal",
      images,
      videos,
    };
  }

  async function settleDom(root, deadline) {
    let stable = 0;
    let previous = -1;
    while (stable < 3 && Date.now() < deadline) {
      root.scrollTo?.({ top: root.scrollHeight, behavior: "instant" });
      window.scrollTo({ top: Math.min(document.documentElement.scrollHeight, root.getBoundingClientRect().bottom + window.scrollY), behavior: "instant" });
      const changed = await waitForMutation(root, 700);
      const current = root.scrollHeight;
      const pendingImages = [...root.querySelectorAll('img')].filter(image => !image.closest("[class*='comment'],[class*='recommend'],[class*='author'],nav"))
        .some(image => (image.src || image.dataset?.src) && !(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0));
      const loading = [...root.querySelectorAll("[aria-busy='true'],[class*='loading']")].some(visible);
      stable = current === previous && !changed && !pendingImages && !loading ? stable + 1 : 0;
      previous = current;
    }
    return stable >= 3;
  }

  function mergeMedia(...groups) {
    const output = new Map();
    for (const item of groups.flat()) if (item?.mediaIdentity) output.set(item.mediaIdentity, item);
    return [...output.values()].map((item, position) => ({ ...item, position }));
  }

  function collectImages(root) {
    const output = new Map();
    const images = [...root.querySelectorAll(SELECTORS.mediaImages.join(","))];
    for (const [domOrder, image] of images.entries()) {
      if (image.closest("[class*='comment'],[class*='recommend'],[class*='author'],nav")) continue;
      const url = image.currentSrc || image.src;
      if (!/^https:\/\//.test(url) || (image.naturalWidth && image.naturalWidth < 160) || (image.naturalHeight && image.naturalHeight < 120)) continue;
      const identity = image.dataset?.src || image.getAttribute("data-src") || url.replace(/[?&](?:imageView2|imageMogr2)[^&]*/g, "");
      const container = image.closest("figure,[class*='swiper-slide'],[class*='carousel-item']");
      const captionText = image.closest("figure")?.querySelector("figcaption")?.textContent?.trim() || "";
      const localSiblings = [image.previousElementSibling,image.nextElementSibling].filter(node => node?.matches('p,figcaption,h2,h3')).map(node => node.textContent);
      const nearbyText = String(container?.innerText || container?.textContent || [image.alt,...localSiblings].filter(Boolean).join(' ')).replace(/\s+/g, " ").trim().slice(0, 2000);
      output.set(identity, { kind: "image", url, alt: image.alt || "", width: image.naturalWidth || null, height: image.naturalHeight || null,
        mediaIdentity: identity, position: output.size, nearbyText, captionText, domOrder,
        provenance: { traversal: "detail_carousel", nearbyText, captionText, domOrder } });
    }
    return [...output.values()];
  }

  function collectVideos(root) {
    const output = new Map();
    for (const video of root.querySelectorAll(SELECTORS.mediaVideos.join(","))) {
      const urls = [video.currentSrc, video.src, ...[...video.querySelectorAll("source")].map((source) => source.src)].filter(Boolean);
      for (const url of urls) {
        if (!/^https:\/\//.test(url)) continue;
        output.set(url, { kind: "video", url, alt: video.poster ? `Video poster: ${video.poster}` : "Xiaohongshu note video",
          duration: Number.isFinite(video.duration) ? video.duration : null, mediaIdentity: url, position: output.size,
          provenance: { traversal: "video_element", poster: video.poster || "" } });
      }
    }
    return [...output.values()];
  }

  function detectBlockingPage() {
    const text = String(document.body?.innerText || "").slice(0, 30_000);
    const route = `${location.pathname}${location.search}`;
    const hasNoteDetail = Boolean(document.querySelector("#noteContainer,[class*='note-detail'],main article"));
    const hasVerificationWidget = Boolean(document.querySelector("iframe[src*='captcha' i],iframe[src*='verify' i],[class*='captcha' i],[class*='verify' i],[class*='slider' i]"));
    if (/captcha|verify|verification|security|challenge/i.test(route) && !hasNoteDetail) {
      return detail("VERIFICATION_REQUIRED", "Xiaohongshu requires manual verification. Complete it in Chrome, then resume.", false);
    }
    if (/登录后|登录查看更多|手机号登录|扫码登录|log\s*in|sign\s*in/i.test(text) && !hasNoteDetail) {
      return detail("NOT_LOGGED_IN", "Xiaohongshu login is required. Log in manually, then resume.", false);
    }
    if (!hasNoteDetail && (hasVerificationWidget || /验证码|安全验证|访问验证|滑块|captcha|verify you are human|unusual traffic/i.test(text))) {
      return detail("VERIFICATION_REQUIRED", "Xiaohongshu requires manual verification. Complete it in Chrome, then resume.", false);
    }
    if (/笔记不存在|内容已删除|无法查看|页面不存在|当前笔记暂时无法浏览|请打开小红书App扫码查看|not found|unavailable/i.test(text)) {
      return detail("NOTE_UNAVAILABLE", "This note is unavailable, private, or deleted.", false);
    }
    return null;
  }

  function waitForMutation(root, timeoutMs = 700) {
    if (!root || typeof MutationObserver !== "function") return wait(timeoutMs).then(() => false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (changed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        root.removeEventListener('load', onLoad, true);
        root.removeEventListener('loadeddata', onLoad, true);
        resolve(changed);
      };
      const onLoad = () => finish(true);
      const observer = new MutationObserver(() => finish(true));
      const timer = setTimeout(() => finish(false), timeoutMs);
      observer.observe(root, { childList: true, subtree: true, attributes: true });
      root.addEventListener('load', onLoad, true);
      root.addEventListener('loadeddata', onLoad, true);
    });
  }

  function waitForSelector(selectors, timeoutMs) {
    if (typeof MutationObserver !== "function") return wait(timeoutMs).then(() => first(selectors));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        const match = first(selectors);
        if (match || detectBlockingPage()) finish(match);
      });
      const timer = setTimeout(() => finish(first(selectors)), timeoutMs);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  function error(code, message, retryable) { return { ok: false, error: detail(code, message, retryable) }; }
  function detail(code, message, retryable) { return { code, message, retryable, timestamp: new Date().toISOString() }; }
  function meta(name, property = false) { return document.querySelector(`meta[${property ? "property" : "name"}="${name}"]`)?.content || ""; }
  function visible(node) { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; }
  async function hash(value) {
    const bytes = new TextEncoder().encode(String(value || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
  }

  globalThis.SoloToChinaXhs = { scanFavorites, scrollFavoritesWindow, prepareAndExtract };
})();
