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
