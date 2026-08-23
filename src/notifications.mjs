import { VERSION } from "./version.mjs";

const SEVERITY = { warning: 1, blocker: 2 };

export class ExceptionNotifier {
  constructor(repository, config = {}, { fetchImpl = fetch, clock = () => new Date() } = {}) {
    this.repository = repository;
    this.config = {
      webhookUrl: "",
      webhookToken: "",
      minimumSeverity: "blocker",
      repeatHours: 24,
      timeoutMs: 10_000,
      ...config,
    };
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.url = validateWebhookUrl(this.config.webhookUrl);
    this.enabled = Boolean(this.url);
  }

  async deliver() {
    if (!this.enabled) return { itemCount: 0, metadata: { configured: false, skipped: true } };
    const threshold = SEVERITY[this.config.minimumSeverity] || SEVERITY.blocker;
    const exceptions = this.repository.listOperationalExceptions()
      .filter((item) => (SEVERITY[item.severity] || 0) >= threshold)
      .filter((item) => !(item.kind === "maintenance" && item.entityId === "exception_notifications"));
    this.repository.pruneResolvedNotificationState(exceptions.map((item) => item.key));
    const candidates = this.repository.notificationCandidates(exceptions, this.config.repeatHours, this.clock());
    if (!candidates.length) {
      return { itemCount: 0, metadata: { configured: true, activeExceptions: exceptions.length, delivered: 0 } };
    }

    const generatedAt = this.clock().toISOString();
    const payload = {
      event: "solo_to_china.operational_exceptions",
      version: VERSION,
      generatedAt,
      summary: {
        total: candidates.length,
        blockers: candidates.filter((item) => item.severity === "blocker").length,
        warnings: candidates.filter((item) => item.severity === "warning").length,
      },
      items: candidates.slice(0, 50).map(({ fingerprint, ...item }) => item),
    };

    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `SoloToChina-Research-Engine/${VERSION}`,
          "x-solotochina-event": payload.event,
          ...(this.config.webhookToken ? { authorization: `Bearer ${this.config.webhookToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.max(1_000, this.config.timeoutMs)),
      });
      if (!response.ok) throw new Error(`Exception webhook returned HTTP ${response.status}.`);
      for (const item of candidates) this.repository.recordNotificationSent(item.key, item.fingerprint, generatedAt);
      return {
        itemCount: candidates.length,
        metadata: { configured: true, activeExceptions: exceptions.length, delivered: candidates.length, status: response.status },
      };
    } catch (error) {
      for (const item of candidates) this.repository.recordNotificationFailed(item.key, item.fingerprint, error, generatedAt);
      throw error;
    }
  }
}

function validateWebhookUrl(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EXCEPTION_WEBHOOK_URL must be a valid absolute URL.");
  }
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("EXCEPTION_WEBHOOK_URL must use HTTPS (loopback HTTP is allowed for testing).");
  }
  if (url.username || url.password) throw new Error("EXCEPTION_WEBHOOK_URL must not contain embedded credentials.");
  return url.toString();
}
