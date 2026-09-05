import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { truncate } from "../utils.mjs";

const require = createRequire(import.meta.url);
const WordExtractor = require("word-extractor");

const LINK_KINDS = new Set(["auto_url", "xiaohongshu_url", "wechat_url", "video_url", "web_url"]);
const FILE_KINDS = new Set(["pdf", "word", "images"]);
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const WORD_EXTENSIONS = new Set([".doc", ".docx"]);
const DEFAULT_MAX_FILE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_REMOTE_BYTES = 8 * 1024 * 1024;

export class ManualSourceError extends Error {
  constructor(code, message, { statusCode = 422, details = null } = {}) {
    super(message);
    this.name = "ManualSourceError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ManualSourceIngestor {
  constructor(config = {}, { fetchImpl = fetch, lookupImpl = dns.lookup, extractPdfImpl = extractPdfText, extractWordImpl = extractWordText } = {}) {
    this.config = {
      uploadDir: path.resolve(config.uploadDir || "data/source-uploads"),
      requestTimeoutMs: Number(config.requestTimeoutMs || 20_000),
      maxFileBytes: Number(config.maxFileBytes || DEFAULT_MAX_FILE_BYTES),
      maxImageBytes: Number(config.maxImageBytes || DEFAULT_MAX_IMAGE_BYTES),
      maxTotalBytes: Number(config.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES),
      maxRemoteBytes: Number(config.maxRemoteBytes || DEFAULT_MAX_REMOTE_BYTES),
      maxImages: Number(config.maxImages || 8),
    };
    this.fetch = fetchImpl;
    this.lookup = lookupImpl;
    this.extractPdf = extractPdfImpl;
    this.extractWord = extractWordImpl;
  }

  async prepare(input) {
    if (!input || typeof input !== "object") throw new ManualSourceError("INVALID_SUBMISSION", "提交内容必须是有效对象。", { statusCode: 400 });
    const requestedKind = String(input.kind || "").trim();
    if (!LINK_KINDS.has(requestedKind) && !FILE_KINDS.has(requestedKind)) {
      throw new ManualSourceError("UNSUPPORTED_SOURCE_TYPE", "请选择受支持的链接、PDF、Word 或图片来源。", { statusCode: 400 });
    }

    const submissionId = crypto.randomUUID();
    const notes = truncate(input.notes, 120_000).trim();
    const suppliedTitle = truncate(input.title, 1_000).trim();
    const warnings = [];
    let uploadDirectory = null;
    let submittedUrl = "";
    let sourceKind = requestedKind;
    let title = suppliedTitle;
    let rawText = "";
    let rawHtml = "";
    let assets = [];
    let files = [];

    try {
      if (LINK_KINDS.has(requestedKind)) {
        submittedUrl = normalizePublicUrl(input.url);
        sourceKind = requestedKind === "auto_url" ? classifyUrl(submittedUrl) : requestedKind;
        validateKindMatchesUrl(sourceKind, submittedUrl);
        const youtube = sourceKind === "video_url" && isYoutubeUrl(submittedUrl);
        if (youtube) {
          await assertPublicUrl(submittedUrl, this.lookup);
          title ||= youtubeVideoTitle(submittedUrl);
          rawText = joinText(notes, "人工选择的公开视频将作为画面与音频证据提交给支持视频输入的模型。未提供额外文字稿。请只根据视频中可见或可听内容创建 Claims。");
          warnings.push("公开视频将由支持该能力的 Vertex Gemini 模型读取画面与音频；切换到其他模型时只使用页面文字和补充说明。");
        } else {
          const fetched = await this.fetchPublicSource(submittedUrl);
          title ||= fetched.title;
          rawHtml = fetched.rawHtml;
          rawText = joinText(notes, fetched.text);
          warnings.push(...fetched.warnings);
          if (sourceKind === "video_url") warnings.push("该视频平台不支持直接传入模型；当前仅提取公开页面文字。建议在补充说明中粘贴字幕或文字稿。");
        }
      } else {
        const decoded = decodeFiles(input.files, this.config);
        uploadDirectory = path.join(this.config.uploadDir, submissionId);
        fs.mkdirSync(uploadDirectory, { recursive: true });

        if (sourceKind === "images") {
          const images = decoded.filter((file) => isImage(file));
          if (images.length !== decoded.length || images.length === 0) {
            throw new ManualSourceError("UNSUPPORTED_FILE_TYPE", "图片来源只接受 JPG、PNG、WebP 或 GIF 文件。", { statusCode: 400 });
          }
          if (images.length > this.config.maxImages) {
            throw new ManualSourceError("TOO_MANY_IMAGES", `一次最多上传 ${this.config.maxImages} 张图片。`, { statusCode: 400 });
          }
          const oversized = images.find((file) => file.bytes.length > this.config.maxImageBytes);
          if (oversized) throw new ManualSourceError("FILE_TOO_LARGE", `${oversized.originalFilename} 超过图片 ${formatMegabytes(this.config.maxImageBytes)} MB 限制。`, { statusCode: 413 });
          files = images.map((file, index) => persistFile(file, uploadDirectory, submissionId, "image", index));
          assets = files.map((file, index) => ({
            kind: "image",
            url: `manual-asset://${submissionId}/${index}`,
            alt: file.originalFilename,
            position: index,
            localPath: file.storagePath,
            mimeType: file.mimeType,
            originalFilename: file.originalFilename,
          }));
          title ||= images.length === 1 ? images[0].originalFilename : `人工上传图片（${images.length} 张）`;
          rawText = joinText(notes, `人工上传的图片资料：${images.map((file) => file.originalFilename).join("、")}。请结合图片识别可见文字、地点和旅行信息。`);
        } else {
          if (decoded.length !== 1) throw new ManualSourceError("FILE_COUNT_INVALID", "PDF 或 Word 来源每次请上传一个文档。", { statusCode: 400 });
          const file = decoded[0];
          if (sourceKind === "pdf" && !isPdf(file)) throw new ManualSourceError("UNSUPPORTED_FILE_TYPE", "PDF 来源必须上传有效的 .pdf 文件。", { statusCode: 400 });
          if (sourceKind === "word" && !isWord(file)) throw new ManualSourceError("UNSUPPORTED_FILE_TYPE", "Word 来源必须上传有效的 .doc 或 .docx 文件。", { statusCode: 400 });
          files = [persistFile(file, uploadDirectory, submissionId, sourceKind, 0)];
          title ||= file.originalFilename;
          let extracted;
          try {
            extracted = sourceKind === "pdf" ? await this.extractPdf(file.bytes) : await this.extractWord(file.bytes);
          } catch {
            throw new ManualSourceError("DOCUMENT_PARSE_FAILED", "文档无法解析，可能已加密、损坏或格式与扩展名不一致。请另存为普通 PDF/DOCX 后重试。");
          }
          rawText = joinText(notes, normalizeExtractedText(extracted));
          if (rawText.length < 20) {
            const hint = sourceKind === "pdf" ? "该 PDF 可能是扫描件；请改为上传页面图片，或补充可复制的文字说明。" : "该 Word 文档没有提取到足够正文，请确认文件不是空白或受保护文档。";
            throw new ManualSourceError("EMPTY_DOCUMENT", hint);
          }
        }
      }

      if (rawText.length < 20) {
        throw new ManualSourceError("EMPTY_CONTENT", "来源中没有提取到足够的可处理内容。若页面需要登录或正文由客户端加载，请补充正文说明或改为上传文档/截图。");
      }

      const capture = {
        adapter: "manual",
        externalId: submissionId,
        canonicalUrl: `manual-source://${submissionId}`,
        submittedUrl,
        sourceKind,
        submissionMetadata: { requestedKind, warnings, operatorNotesProvided: Boolean(notes) },
        title: title || sourceKindLabel(sourceKind),
        authorName: "人工提交",
        authorUrl: "",
        publishedAt: null,
        capturedAt: new Date().toISOString(),
        rawText: truncate(rawText, 250_000),
        rawHtml: truncate(rawHtml, 1_500_000),
        assets,
        files,
        client: { channel: "admin_manual_submission" },
      };
      return {
        capture,
        warnings,
        cleanup: () => safeRemoveSubmissionDirectory(this.config.uploadDir, uploadDirectory),
      };
    } catch (error) {
      safeRemoveSubmissionDirectory(this.config.uploadDir, uploadDirectory);
      throw error;
    }
  }

  async fetchPublicSource(initialUrl) {
    let currentUrl = initialUrl;
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      await assertPublicUrl(currentUrl, this.lookup);
      let response;
      try {
        response = await this.fetch(currentUrl, {
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
            "user-agent": "SoloToChina-CMS/1.0 (manual research source fetch)",
          },
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new ManualSourceError("FETCH_TIMEOUT", "链接提取超时，目标网站响应过慢。请稍后重试，或改为上传文档/截图。");
        throw new ManualSourceError("FETCH_FAILED", "无法连接该链接。请检查链接是否公开可访问，或改为上传文档/截图。");
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location || redirects === 4) throw new ManualSourceError("TOO_MANY_REDIRECTS", "链接重定向次数过多，无法安全提取。");
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (response.status === 401) throw new ManualSourceError("AUTH_REQUIRED", "该链接需要账号登录或授权，CMS 无法读取正文。请上传文档、截图或补充正文。");
      if (response.status === 403) throw new ManualSourceError("BOT_PROTECTION", "目标网站拒绝了服务器访问，可能触发反爬或登录验证。请上传文档、截图或补充正文。");
      if (response.status === 429) throw new ManualSourceError("RATE_LIMITED", "目标网站限制了访问频率。请稍后重试，或改为上传文档/截图。");
      if (!response.ok) throw new ManualSourceError("REMOTE_HTTP_ERROR", `目标网站返回 HTTP ${response.status}，暂时无法提取正文。`);

      const bytes = await readLimitedResponse(response, this.config.maxRemoteBytes);
      const contentType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (contentType === "application/pdf" || looksLikePdf(bytes)) {
        let text;
        try { text = await this.extractPdf(bytes); } catch { throw new ManualSourceError("DOCUMENT_PARSE_FAILED", "链接指向的 PDF 无法解析，可能已加密或损坏。请下载后另存并上传。"); }
        text = normalizeExtractedText(text);
        if (text.length < 20) throw new ManualSourceError("EMPTY_DOCUMENT", "链接中的 PDF 没有可提取正文，可能是扫描件。请上传页面截图或补充文字说明。");
        return { title: filenameFromUrl(currentUrl) || "在线 PDF 文档", text, rawHtml: "", warnings: [] };
      }
      if (!(contentType.startsWith("text/") || contentType.includes("html") || !contentType)) {
        throw new ManualSourceError("UNSUPPORTED_CONTENT_TYPE", `链接返回了不支持的内容类型（${contentType || "未知"}）。请下载后以 PDF、Word 或图片上传。`);
      }
      const rawHtml = bytes.toString("utf8");
      const blockReason = detectAccessWall(rawHtml);
      if (blockReason) throw blockReason;
      const extracted = extractHtmlContent(rawHtml);
      if (extracted.text.length < 20) throw new ManualSourceError("EMPTY_CONTENT", "页面已打开，但没有提取到足够正文。页面可能需要登录、使用客户端打开或通过脚本加载内容；请改为上传文档/截图。");
      return { ...extracted, rawHtml, warnings: currentUrl === initialUrl ? [] : [`链接重定向至 ${safeDisplayHost(currentUrl)}`] };
    }
    throw new ManualSourceError("TOO_MANY_REDIRECTS", "链接重定向次数过多，无法安全提取。");
  }
}

export async function extractPdfText(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDirectory = `${path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/pdfjs-dist/standard_fonts")}${path.sep}`;
  const standardFontDataUrl = pathToFileURL(standardFontDirectory).href;
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, standardFontDataUrl, verbosity: 0 });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || "").join(" "));
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages.join("\n\n");
}

export async function extractWordText(bytes) {
  const extractor = new WordExtractor();
  const document = await extractor.extract(Buffer.from(bytes));
  return [document.getBody(), document.getFootnotes(), document.getEndnotes()].filter(Boolean).join("\n\n");
}

function decodeFiles(input, config) {
  if (!Array.isArray(input) || input.length === 0) throw new ManualSourceError("FILE_REQUIRED", "请选择要上传的文件。", { statusCode: 400 });
  let totalBytes = 0;
  return input.map((item, index) => {
    const originalFilename = normalizeFilename(item?.name || `upload-${index + 1}`);
    const mimeType = String(item?.mimeType || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
    const encoded = String(item?.base64 || "").replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ManualSourceError("INVALID_FILE_DATA", `${originalFilename} 的文件数据无效。`, { statusCode: 400 });
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length) throw new ManualSourceError("EMPTY_FILE", `${originalFilename} 是空文件。`, { statusCode: 400 });
    if (bytes.length > config.maxFileBytes) throw new ManualSourceError("FILE_TOO_LARGE", `${originalFilename} 超过单文件 ${formatMegabytes(config.maxFileBytes)} MB 限制。`, { statusCode: 413 });
    totalBytes += bytes.length;
    if (totalBytes > config.maxTotalBytes) throw new ManualSourceError("UPLOAD_TOO_LARGE", `本次上传总大小超过 ${formatMegabytes(config.maxTotalBytes)} MB 限制。`, { statusCode: 413 });
    return { originalFilename, mimeType, bytes };
  });
}

function persistFile(file, directory, submissionId, fileKind, index) {
  const extension = safeExtension(file.originalFilename, file.mimeType);
  const storedName = `${String(index + 1).padStart(2, "0")}-${crypto.randomUUID()}${extension}`;
  const storagePath = path.join(directory, storedName);
  fs.writeFileSync(storagePath, file.bytes, { flag: "wx" });
  return {
    id: `source_file_${submissionId}_${index}`,
    fileKind,
    originalFilename: file.originalFilename,
    mimeType: file.mimeType,
    storagePath,
    sizeBytes: file.bytes.length,
    sha256: crypto.createHash("sha256").update(file.bytes).digest("hex"),
  };
}

function normalizePublicUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { throw new ManualSourceError("INVALID_URL", "请输入有效的公开网页链接。", { statusCode: 400 }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new ManualSourceError("INVALID_URL", "链接仅支持不含账号密码的 HTTP/HTTPS 公网页面。", { statusCode: 400 });
  }
  if (url.port && !["80", "443"].includes(url.port)) throw new ManualSourceError("UNSAFE_URL", "链接使用了不允许的网络端口。", { statusCode: 400 });
  url.hash = "";
  return url.toString();
}

async function assertPublicUrl(value, lookup) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new ManualSourceError("PRIVATE_NETWORK_BLOCKED", "为保护服务器安全，不能提取本机或内网地址。", { statusCode: 400 });
  }
  let addresses;
  try {
    addresses = net.isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ManualSourceError("DNS_FAILED", "无法解析该链接的域名，请检查地址是否正确。");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ManualSourceError("PRIVATE_NETWORK_BLOCKED", "为保护服务器安全，不能提取本机、内网或保留网络地址。", { statusCode: 400 });
  }
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c))))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapped ? isPrivateAddress(mapped) : false;
  }
  return true;
}

async function readLimitedResponse(response, maxBytes) {
  const declared = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new ManualSourceError("REMOTE_CONTENT_TOO_LARGE", `链接内容超过 ${formatMegabytes(maxBytes)} MB 提取限制。`);
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ManualSourceError("REMOTE_CONTENT_TOO_LARGE", `链接内容超过 ${formatMegabytes(maxBytes)} MB 提取限制。`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ManualSourceError("REMOTE_CONTENT_TOO_LARGE", `链接内容超过 ${formatMegabytes(maxBytes)} MB 提取限制。`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function extractHtmlContent(html) {
  const title = decodeHtml(firstMatch(html, /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']*)["'][^>]*>/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']og:title["'][^>]*>/i)
    || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const description = decodeHtml(firstMatch(html, /<meta[^>]+(?:property|name)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["'][^>]*>/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["'](?:description|og:description)["'][^>]*>/i));
  const visible = decodeHtml(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6]|article|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
  return { title: truncate(title.trim(), 1_000), text: normalizeExtractedText(joinText(description, visible)) };
}

function detectAccessWall(html) {
  const normalized = String(html || "").toLowerCase();
  const authMarkers = ["请登录", "登录后查看", "账号登录", "sign in to continue", "login required", "请在微信客户端打开链接"];
  if (authMarkers.some((marker) => normalized.includes(marker))) return new ManualSourceError("AUTH_REQUIRED", "该页面需要账号登录或在指定客户端内打开，CMS 无法读取正文。请上传文档、截图或补充正文。");
  const botMarkers = ["验证码", "安全验证", "访问过于频繁", "环境异常", "captcha", "verify you are human", "unusual traffic", "访问受限"];
  if (botMarkers.some((marker) => normalized.includes(marker))) return new ManualSourceError("BOT_PROTECTION", "该页面触发了反爬或人机验证，CMS 无法读取正文。请上传文档、截图或补充正文。");
  return null;
}

function classifyUrl(value) {
  const host = new URL(value).hostname.toLowerCase();
  if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com" || host.endsWith(".xhslink.com")) return "xiaohongshu_url";
  if (host === "mp.weixin.qq.com") return "wechat_url";
  if (["youtube.com", "youtu.be", "bilibili.com", "b23.tv", "douyin.com", "vimeo.com"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return "video_url";
  return "web_url";
}

function isYoutubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (host === "youtu.be") return Boolean(segments[0]);
    if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return false;
    return Boolean(url.searchParams.get("v") || (["shorts", "live", "embed"].includes(segments[0]) && segments[1]));
  } catch {
    return false;
  }
}

function youtubeVideoTitle(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const id = url.hostname.toLowerCase() === "youtu.be" ? segments[0] : url.searchParams.get("v") || segments.at(-1);
    return id ? `YouTube 视频 ${truncate(id, 80)}` : "YouTube 视频";
  } catch {
    return "YouTube 视频";
  }
}

function validateKindMatchesUrl(kind, value) {
  const detected = classifyUrl(value);
  if (kind === "xiaohongshu_url" && detected !== kind) throw new ManualSourceError("SOURCE_TYPE_MISMATCH", "该地址不是受支持的小红书链接，请更正类型或选择“其他网页链接”。", { statusCode: 400 });
  if (kind === "wechat_url" && detected !== kind) throw new ManualSourceError("SOURCE_TYPE_MISMATCH", "微信公众号文章必须使用 mp.weixin.qq.com 链接。", { statusCode: 400 });
}

function isPdf(file) {
  return path.extname(file.originalFilename).toLowerCase() === ".pdf" && looksLikePdf(file.bytes);
}

function looksLikePdf(bytes) { return Buffer.from(bytes).subarray(0, 5).toString("ascii") === "%PDF-"; }

function isWord(file) {
  const extension = path.extname(file.originalFilename).toLowerCase();
  if (!WORD_EXTENSIONS.has(extension)) return false;
  const signature = Buffer.from(file.bytes).subarray(0, 8).toString("hex");
  return extension === ".docx" ? signature.startsWith("504b") : signature.startsWith("d0cf11e0a1b11ae1");
}

function isImage(file) {
  if (!IMAGE_MIME_TYPES.has(file.mimeType)) return false;
  const bytes = Buffer.from(file.bytes);
  if (file.mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (file.mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (file.mimeType === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (file.mimeType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function normalizeFilename(value) {
  const base = path.basename(String(value || "")).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
  return truncate(base || "upload", 180);
}

function safeExtension(filename, mimeType) {
  const extension = path.extname(filename).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  return { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "application/pdf": ".pdf" }[mimeType] || "";
}

function normalizeExtractedText(value) {
  return String(value || "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function joinText(...values) { return values.map(normalizeExtractedText).filter(Boolean).join("\n\n"); }
function firstMatch(value, pattern) { return String(value || "").match(pattern)?.[1] || ""; }
function filenameFromUrl(value) { try { return decodeURIComponent(path.basename(new URL(value).pathname)); } catch { return ""; } }
function safeDisplayHost(value) { try { return new URL(value).hostname; } catch { return "目标网站"; } }
function formatMegabytes(value) { return Math.max(1, Math.round(Number(value) / 1024 / 1024)); }

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'");
}

function sourceKindLabel(kind) {
  return { xiaohongshu_url: "小红书链接", wechat_url: "微信公众号文章", video_url: "视频链接", web_url: "网页链接", pdf: "PDF 文档", word: "Word 文档", images: "图片资料" }[kind] || "人工提交来源";
}

function safeRemoveSubmissionDirectory(root, directory) {
  if (!directory) return;
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  if (!resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`) || resolvedDirectory === resolvedRoot) return;
  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
}
