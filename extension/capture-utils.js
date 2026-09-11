(() => {
  function validIso(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }

  function parseSourceDate(raw, now = new Date()) {
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const kind = /编辑|更新|updated|edited/i.test(text) ? "edited"
      : /发布|published|posted/i.test(text) ? "published" : "unknown";
    const absolute = text.match(/(20\d{2})[年月./-]\s*(\d{1,2})[月./-]\s*(\d{1,2})(?:日)?(?:\s+(\d{1,2}):?(\d{2})?)?/);
    if (absolute) {
      const date = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]), Number(absolute[4] || 12), Number(absolute[5] || 0));
      return { value:date.toISOString(),kind,raw:text,confidence:"high" };
    }
    const short = text.match(/(?:^|\s)(\d{1,2})[月./-]\s*(\d{1,2})(?:日)?(?:\s+(\d{1,2}):?(\d{2})?)?/);
    if (short) {
      const year = now.getFullYear();
      const date = new Date(year, Number(short[1]) - 1, Number(short[2]), Number(short[3] || 12), Number(short[4] || 0));
      if (date.getTime() > now.getTime() + 7 * 86400000) date.setFullYear(year - 1);
      return { value:date.toISOString(),kind,raw:text,confidence:"medium" };
    }
    const relative = new Date(now);
    const amount = Number(text.match(/(\d+)\s*(?:天|小时|分钟)前/)?.[1] || 0);
    if (/昨天/.test(text)) relative.setDate(relative.getDate() - 1);
    else if (/今天/.test(text)) relative.setTime(now.getTime());
    else if (/\d+\s*天前/.test(text)) relative.setDate(relative.getDate() - amount);
    else if (/\d+\s*小时前/.test(text)) relative.setHours(relative.getHours() - amount);
    else if (/\d+\s*分钟前/.test(text)) relative.setMinutes(relative.getMinutes() - amount);
    else return null;
    return { value:relative.toISOString(),kind,raw:text,confidence:"low" };
  }

  function extractSourceTimestamp(document, root = document, now = new Date()) {
    const candidates = [];
    for (const node of root.querySelectorAll('time,[datetime],[class*="date" i],[class*="publish" i],[class*="update" i],[class*="edit" i]')) {
      const raw = node.getAttribute?.("datetime") || node.dateTime || node.textContent || "";
      const direct = node.getAttribute?.("datetime") ? validIso(raw) : null;
      const parsed = direct ? {
        value:direct,
        kind:/edit|update/i.test(`${node.className} ${node.getAttribute?.("aria-label") || ""}`) ? "edited" : "published",
        raw,
        confidence:"high",
      } : parseSourceDate(raw,now);
      const dedicatedTimeElement = node.tagName === "TIME" || node.hasAttribute?.("datetime");
      if (parsed && (parsed.kind !== "unknown" || dedicatedTimeElement)) candidates.push(parsed);
    }
    const kindScore = { edited:3,published:2,unknown:1 };
    const confidenceScore = { high:3,medium:2,low:1 };
    return candidates.sort((a,b) => kindScore[b.kind] - kindScore[a.kind] || confidenceScore[b.confidence] - confidenceScore[a.confidence])[0]
      || { value:null,kind:"unknown",raw:"",confidence:"none" };
  }

  globalThis.SoloToChinaCaptureUtils = { parseSourceDate,extractSourceTimestamp };
})();
