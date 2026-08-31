export async function api(url, options = {}, canPrompt = true) {
  const response = await fetch(url, { ...options, credentials: "same-origin", headers: { ...(options.headers || {}) } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}
