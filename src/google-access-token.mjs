import { GoogleAuth } from "google-auth-library";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export function createGoogleAccessTokenProvider(config, fetchImpl = fetch, authFactory = () => new GoogleAuth({ scopes: SCOPES })) {
  let token = "";
  let expiresAt = 0;
  let pending = null;
  let auth = null;
  return async () => {
    if (config.accessToken) return config.accessToken;
    if (token && Date.now() < expiresAt) return token;
    if (pending) return pending;
    pending = (async () => {
      if (config.googleAuthMode === "adc") {
        try {
          const adcFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || (process.platform === "win32"
            ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "gcloud", "application_default_credentials.json")
            : path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"));
          if (!fs.existsSync(adcFile)) throw new Error("No ADC credential file is configured; set GOOGLE_APPLICATION_CREDENTIALS or create local Application Default Credentials.");
          auth ??= authFactory();
          const client = await auth.getClient();
          const result = await client.getAccessToken();
          if (!result?.token) throw new Error("ADC returned no access token.");
          token = result.token;
          expiresAt = Math.max(Date.now() + 1_000, Number(client.credentials?.expiry_date || 0) - 60_000);
          return token;
        } catch (error) {
          throw Object.assign(new Error(`Google ADC is unavailable or cannot refresh: ${error.message}`), { code: "GOOGLE_ADC_UNAVAILABLE", cause: error });
        }
      }
      const response = await fetchImpl(METADATA_TOKEN_URL, {
        headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.access_token) throw Object.assign(new Error("GCE service-account token is unavailable."), { code: "GOOGLE_METADATA_UNAVAILABLE" });
      token = payload.access_token;
      expiresAt = Date.now() + Math.max(1, Number(payload.expires_in || 300) - 60) * 1_000;
      return token;
    })();
    try { return await pending; } finally { pending = null; }
  };
}
