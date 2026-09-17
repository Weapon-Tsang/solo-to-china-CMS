// Shared by the extension and server. Array membership establishes kind;
// bytes establish format. A URL suffix is never evidence of a media format.
export function normalizeCaptureMedia(capture) {
  for (const [field, kind] of [["images", "image"], ["videos", "video"]]) {
    capture[field] = (capture[field] || []).map((asset) => ({ ...asset, kind }));
  }
  return [...capture.images, ...capture.videos];
}

export function detectMediaMime(value, kind, supplied = "") {
  const bytes = new Uint8Array(value);
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  let mime = "";
  if (kind === "image") {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = "image/jpeg";
    else if ([137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) mime = "image/png";
    else if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") mime = "image/webp";
    else if (/^GIF8[79]a$/.test(ascii(0, 6))) mime = "image/gif";
  } else if (kind === "video") {
    if ([26,69,223,163].every((n, i) => bytes[i] === n)) mime = "video/webm";
    else if (bytes.length >= 12 && ascii(4, 8) === "ftyp") mime = ascii(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  const declared = String(supplied || "").toLowerCase().split(";")[0].trim();
  if (declared && declared !== "application/octet-stream" && declared !== mime) return "";
  return mime;
}
