export async function api(url, options = {}, canPrompt = true) {
  const response = await fetch(url, { ...options, credentials: "same-origin", headers: { ...(options.headers || {}) } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed: ${response.status}`);
    error.code = body?.code || "REQUEST_FAILED";
    error.details = body?.details || null;
    error.status = response.status;
    throw error;
  }
  return body;
}

export function uploadChunk(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.withCredentials = true;
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = (event) => onProgress?.(event.loaded, event.total || blob.size);
    request.onerror = () => reject(new Error("上传连接中断，请保留页面并重试。"));
    request.onload = () => {
      let body = null;
      try { body = request.responseText ? JSON.parse(request.responseText) : null; } catch { body = null; }
      if (request.status >= 200 && request.status < 300) resolve(body);
      else { const error = new Error(body?.error || `上传失败：${request.status}`); error.code = body?.code || "UPLOAD_FAILED"; reject(error); }
    };
    request.send(blob);
  });
}
