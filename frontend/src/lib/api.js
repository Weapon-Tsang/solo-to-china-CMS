export async function api(url, options = {}, canPrompt = true) {
  const adminToken = sessionStorage.getItem("solo_admin_token");
  const headers = { ...(options.headers || {}), ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}) };
  const response = await fetch(url, { ...options, headers });
  const body = await response.json();
  if (response.status === 401 && options.method && options.method !== "GET" && canPrompt) {
    const supplied = window.prompt("Enter ADMIN_TOKEN for this browser session:");
    if (supplied) {
      sessionStorage.setItem("solo_admin_token", supplied);
      return api(url, options, false);
    }
  }
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}
