import crypto from "node:crypto";
import net from "node:net";

export function createLoginThrottle(config = {}, { clock = () => Date.now(), logger = null } = {}) {
  const entries = new Map();
  const settings = {
    accountAttempts: Math.max(1, Number(config.accountAttempts || 5)),
    sourceAttempts: Math.max(2, Number(config.sourceAttempts || 20)),
    windowMs: Math.max(1_000, Number(config.windowMs || 15 * 60_000)),
    baseCooldownMs: Math.max(1_000, Number(config.baseCooldownMs || 2_000)),
    maxCooldownMs: Math.max(1_000, Number(config.maxCooldownMs || 5 * 60_000)),
    maxEntries: Math.max(100, Number(config.maxEntries || 5_000)),
  };
  const accountKey = (username) => `account:${crypto.createHash("sha256").update(String(username || "").trim().toLowerCase()).digest("hex").slice(0, 24)}`;
  const sourceKey = (source) => `source:${String(source || "unknown").slice(0, 160)}`;

  const prune = (timestamp) => {
    for (const [key, entry] of entries) if (timestamp - entry.lastSeenAt >= settings.windowMs) entries.delete(key);
    while (entries.size > settings.maxEntries) entries.delete(entries.keys().next().value);
  };
  const blocked = (username, source) => {
    const timestamp = clock();
    prune(timestamp);
    const matches = [entries.get(accountKey(username)), entries.get(sourceKey(source))].filter(Boolean);
    const blockedUntil = Math.max(0, ...matches.map((entry) => entry.blockedUntil || 0));
    return blockedUntil > timestamp ? { allowed: false, retryAfterMs: blockedUntil - timestamp } : { allowed: true, retryAfterMs: 0 };
  };
  const failKey = (key, threshold, timestamp) => {
    const previous = entries.get(key);
    const entry = previous && timestamp - previous.lastSeenAt < settings.windowMs
      ? previous : { failures: 0, blockedUntil: 0, lastSeenAt: timestamp };
    entry.failures += 1;
    entry.lastSeenAt = timestamp;
    if (entry.failures >= threshold) {
      const exponent = Math.min(16, entry.failures - threshold);
      entry.blockedUntil = Math.max(entry.blockedUntil, timestamp + Math.min(settings.maxCooldownMs, settings.baseCooldownMs * (2 ** exponent)));
    }
    entries.delete(key);
    entries.set(key, entry);
    return entry;
  };
  return {
    check(username, source) {
      const result = blocked(username, source);
      if (!result.allowed) logger?.warn("auth.login_throttled", {
        accountKey: accountKey(username).slice(-12), clientSource: source, retryAfterMs: result.retryAfterMs,
      });
      return result;
    },
    recordFailure(username, source) {
      const timestamp = clock();
      prune(timestamp);
      const account = failKey(accountKey(username), settings.accountAttempts, timestamp);
      const client = failKey(sourceKey(source), settings.sourceAttempts, timestamp);
      prune(timestamp);
      logger?.warn("auth.login_failed", {
        accountKey: accountKey(username).slice(-12), clientSource: source,
        accountFailures: account.failures, sourceFailures: client.failures,
      });
      return blocked(username, source);
    },
    recordSuccess(username, source) {
      entries.delete(accountKey(username));
      const key = sourceKey(source);
      const entry = entries.get(key);
      if (entry) {
        entry.failures = Math.max(0, entry.failures - 1);
        entry.blockedUntil = 0;
        entry.lastSeenAt = clock();
        if (!entry.failures) entries.delete(key);
      }
      logger?.info("auth.login_succeeded", { accountKey: accountKey(username).slice(-12), clientSource: source });
    },
    size() { prune(clock()); return entries.size; },
  };
}

export function resolveClientSource(request, config = {}) {
  const remote = normalizeIp(request?.socket?.remoteAddress) || "unknown";
  const trusted = Array.isArray(config.trustedProxySources) ? config.trustedProxySources : [];
  const header = String(config.trustedProxyHeader || "").toLowerCase();
  if (!header || !trusted.some((range) => ipMatches(remote, range))) return remote;
  if (header === "cf-connecting-ip") {
    const candidate = normalizeIp(request.headers?.["cf-connecting-ip"]);
    return candidate || remote;
  }
  if (header === "x-forwarded-for") {
    const chain = String(request.headers?.["x-forwarded-for"] || "").split(",").map(normalizeIp).filter(Boolean);
    chain.push(remote);
    while (chain.length > 1 && trusted.some((range) => ipMatches(chain.at(-1), range))) chain.pop();
    return chain.at(-1) || remote;
  }
  return remote;
}

function normalizeIp(value) {
  const text = String(value || "").trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  return net.isIP(text) ? text : "";
}

function ipMatches(ip, range) {
  const normalizedRange = String(range || "").trim();
  if (!normalizedRange.includes("/")) return normalizeIp(normalizedRange) === ip;
  const [base, prefixText] = normalizedRange.split("/", 2);
  const prefix = Number(prefixText);
  if (net.isIP(ip) !== 4 || net.isIP(base) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const numeric = (value) => value.split(".").reduce((result, part) => (result << 8) + Number(part), 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (numeric(ip) & mask) === (numeric(base) & mask);
}
