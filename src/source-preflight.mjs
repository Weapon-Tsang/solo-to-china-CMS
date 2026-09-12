import fs from "node:fs";
import path from "node:path";

const IMAGE_MIME = /^image\/(?:jpeg|jpg|png|webp|gif)$/i;
const VIDEO_MIME = /^video\//i;
const PDF_MIME = "application/pdf";

export function estimateSourceProcessing(source, {
  textSegmentMaxChars = 120_000,
  imageBatchSize = 6,
  hardMaxAssets = 200,
  hardMaxSourceBytes = 1024 * 1024 * 1024,
  hardMaxFileBytes = 512 * 1024 * 1024,
} = {}) {
  const assets = Array.isArray(source?.assets) ? source.assets : [];
  const files = Array.isArray(source?.files) ? source.files : [];
  const images = assets.filter((asset) => asset?.kind !== "video").length;
  const videos = assets.filter((asset) => asset?.kind === "video").length;
  const pdfPages = Number(source?.submissionMetadata?.pdf?.pageCount
    ?? source?.submission_metadata?.pdf?.pageCount ?? 0);
  const textChars = String(source?.rawText ?? source?.raw_text ?? "").length;
  const totalFileBytes = files.reduce((total, file) => total + nonNegative(file?.sizeBytes ?? file?.size_bytes), 0);
  const textSegments = Math.max(1, Math.ceil(textChars / Math.max(2_000, Number(textSegmentMaxChars) || 120_000)));
  const effectiveImageBatchSize = Math.min(8, Math.max(4, Number(imageBatchSize) || 6));
  const mediaCalls = Math.ceil(images / effectiveImageBatchSize) + videos;
  const estimatedExtractionCalls = textSegments + mediaCalls;
  const largestFileBytes = files.reduce((largest, file) => Math.max(largest, nonNegative(file?.sizeBytes ?? file?.size_bytes)), 0);
  const schedulingReasons = [];
  if (estimatedExtractionCalls >= 20) schedulingReasons.push(`${estimatedExtractionCalls} estimated extraction calls`);
  if (assets.length >= 25) schedulingReasons.push(`${assets.length} media assets`);
  if (pdfPages >= 26) schedulingReasons.push(`${pdfPages} PDF pages`);
  if (totalFileBytes > 128 * 1024 * 1024) schedulingReasons.push(`${totalFileBytes} source bytes`);
  const hardLimitReasons = [];
  if (assets.length > hardMaxAssets) hardLimitReasons.push(`${assets.length} media assets exceeds hard limit ${hardMaxAssets}`);
  if (totalFileBytes > hardMaxSourceBytes) hardLimitReasons.push(`${totalFileBytes} source bytes exceeds hard limit ${hardMaxSourceBytes}`);
  if (largestFileBytes > hardMaxFileBytes) hardLimitReasons.push(`${largestFileBytes} file bytes exceeds hard limit ${hardMaxFileBytes}`);
  const processingClass = hardLimitReasons.length ? "blocked_hard_limit"
    : assets.length >= 80 || pdfPages >= 100 || totalFileBytes > 256 * 1024 * 1024 ? "oversized"
      : schedulingReasons.length ? "heavy" : "normal";
  return {
    version: 2,
    basis: "technical_scope_only",
    textChars,
    textSegments,
    assetCount: assets.length,
    imageInputs: images,
    videoInputs: videos,
    pdfPages,
    totalFileBytes,
    largestFileBytes,
    imageBatchSize: effectiveImageBatchSize,
    estimatedExtractionCalls,
    processingClass,
    blocked: processingClass === "blocked_hard_limit",
    blockReasons: hardLimitReasons,
    schedulingReasons,
    // Kept for old clients. Work size never requires a manual start.
    requiresManualStart: false,
    manualStartReasons: [],
  };
}

export function evaluateSourcePreflight(source, { provider = "kimi", sourceUploadsDir = "data/source-uploads", imageBatchSize = 6,
  textSegmentMaxChars = 120_000 } = {}) {
  const issues = [];
  const assets = Array.isArray(source?.assets) ? source.assets : [];
  const files = Array.isArray(source?.files) ? source.files : [];
  const uploadRoot = path.resolve(sourceUploadsDir);
  const notesProvided = Boolean(source?.submission_metadata?.operatorNotesProvided ?? source?.submissionMetadata?.operatorNotesProvided);

  if ((source?.completeness_status || source?.completeness?.overall || "complete") !== "complete") {
    issues.push(issue("SOURCE_CAPTURE_PARTIAL", "Capture completeness is not confirmed."));
  }

  for (const file of files) {
    const localPath = file?.storage_path || file?.storagePath;
    if (localPath) checkLocalFile(localPath, uploadRoot, issues, "SOURCE_FILE_UNAVAILABLE");
  }
  for (const asset of assets) {
    const localPath = asset?.local_path || asset?.localPath;
    const mimeType = String(asset?.mime_type || asset?.mimeType || "").toLowerCase();
    if (localPath) {
      const localBytes = checkLocalFile(localPath, uploadRoot, issues, "SOURCE_ASSET_UNAVAILABLE");
      if (!(IMAGE_MIME.test(mimeType) || VIDEO_MIME.test(mimeType) || mimeType === PDF_MIME)) {
        issues.push(issue("SOURCE_ASSET_UNSUPPORTED", `Unsupported local media type: ${mimeType || "unknown"}.`));
      }
      const hasDerivative = Boolean(asset?.ai_derivative_data_url || asset?.aiDerivativeDataUrl);
      if (IMAGE_MIME.test(mimeType) && localBytes > 6 * 1024 * 1024 && !hasDerivative) {
        issues.push(issue("AI_DERIVATIVE_REQUIRED", "Local image exceeds the inline model limit and has no derived vision copy."));
      }
      if (mimeType === PDF_MIME && localBytes > 20 * 1024 * 1024) {
        issues.push(issue("PDF_VISUAL_TOO_LARGE", "PDF visual input exceeds the provider inline limit."));
      }
    } else if (!safeHttps(asset?.remote_url || asset?.url)) {
      issues.push(issue("SOURCE_ASSET_UNAVAILABLE", "Media has neither a readable local file nor an HTTPS source URL."));
    }
    const pdfVisual = mimeType === PDF_MIME || asset?.provenance?.documentKind === "pdf";
    if (pdfVisual && provider !== "vertex") {
      issues.push(issue("PDF_VISUAL_INPUT_UNSUPPORTED", "PDF visual pages require the configured Vertex multimodal provider."));
    }
    if (asset?.kind === "video" && provider !== "vertex" && !notesProvided) {
      issues.push(issue("VIDEO_INPUT_UNSUPPORTED", "Video evidence requires Vertex or operator-supplied transcript notes."));
    }
  }

  const text = String(source?.raw_text ?? source?.rawText ?? "").trim();
  if (text.length < 20 && assets.length === 0) issues.push(issue("EMPTY_SOURCE", "No usable text or media evidence was captured."));
  const estimate = estimateSourceProcessing(source, { imageBatchSize, textSegmentMaxChars });
  if (estimate.blocked) issues.push(issue("BLOCKED_HARD_LIMIT", estimate.blockReasons.join("; ")));
  return { version: 1, checkedAt: new Date().toISOString(), ready: issues.length === 0, provider, issues, estimate };
}

function checkLocalFile(value, root, issues, code) {
  const filename = path.resolve(String(value || ""));
  if (!(filename === root || filename.startsWith(`${root}${path.sep}`))) {
    issues.push(issue(code, "Local evidence path is outside the configured upload directory."));
    return 0;
  }
  try {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size === 0) issues.push(issue(code, "Local evidence file is empty or is not a file."));
    return stat.isFile() ? stat.size : 0;
  } catch {
    issues.push(issue(code, "Local evidence file is missing or unreadable."));
    return 0;
  }
}

function issue(code, message) { return { code, message }; }
function nonNegative(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; }
function safeHttps(value) { try { return new URL(String(value || "")).protocol === "https:"; } catch { return false; } }
