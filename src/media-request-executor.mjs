import crypto from 'node:crypto';
import { transaction } from './db.mjs';

const iso = (milliseconds) => new Date(milliseconds).toISOString();
const blocked = (code, message, availableAt = null) => Object.assign(new Error(message), {
  code, retryable: code === 'MEDIA_RATE_WAIT', availableAt: availableAt === null ? null : iso(availableAt),
  retryAfterMs: availableAt === null ? null : Math.max(0, availableAt - Date.now()),
});

export function retryAfterDelayMs(value, nowMs = Date.now()) {
  if (value == null || String(value).trim() === '') return 0;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : 0;
}

export function mediaQuotaScope({ provider, model, accountScope = 'default' }) {
  const normalizedProvider = ['vertex','vertex_gemini','vertex_imagen'].includes(String(provider)) ? 'vertex' : String(provider || 'unknown');
  return `${normalizedProvider}:${String(accountScope)}:${String(model || 'unknown')}`;
}

export function createMediaRequestExecutor(db, { rpm = 2, windowMs = 60_000, safetyMarginMs = 1_000,
  maxDispatches = 4, leaseMs = 10 * 60_000, clock = Date.now } = {}) {
  if (!Number.isInteger(rpm) || rpm < 1 || !Number.isInteger(maxDispatches) || maxDispatches < 1) {
    throw new TypeError('Media RPM and dispatch budget must be positive integers.');
  }
  const paceMs = Math.ceil(windowMs / rpm) + safetyMarginMs;
  function acquire({ provider, model, accountScope, visualId, substage }) {
    if (!visualId || !substage) throw new TypeError('Media dispatch requires visual and substage identity.');
    const scopeKey = mediaQuotaScope({ provider, model, accountScope });
    const nowMs = clock();
    const token = crypto.randomUUID();
    const outcome = transaction(db, () => {
      const unknown = db.prepare(`SELECT id FROM media_dispatches WHERE visual_id=? AND substage=?
        AND state IN ('dispatch_started','outcome_unknown') LIMIT 1`).get(visualId, substage);
      if (unknown) return { error: blocked('MEDIA_OUTCOME_UNKNOWN', 'A prior media request has an unknown outcome.') };
      const spent = db.prepare('SELECT COUNT(*) AS n FROM media_dispatches WHERE visual_id=? AND substage=?')
        .get(visualId, substage).n;
      if (spent >= maxDispatches) return { error: blocked('MEDIA_BUDGET_EXHAUSTED', 'Media dispatch budget is exhausted.') };
      const lane = db.prepare('SELECT owner_token,lease_until_ms FROM media_visual_lane WHERE id=1').get();
      if (lane.owner_token && lane.lease_until_ms > nowMs) {
        return { error: blocked('MEDIA_RATE_WAIT', 'Another media request owns the visual lane.', Math.min(lane.lease_until_ms, nowMs + 2_000)) };
      }
      if (lane.owner_token && lane.lease_until_ms <= nowMs) {
        db.prepare(`UPDATE media_dispatches SET state='outcome_unknown' WHERE id=? AND state='dispatch_started'`)
          .run(lane.owner_token);
      }
      db.prepare(`INSERT OR IGNORE INTO media_quota_scopes(scope_key,updated_at) VALUES(?,?)`).run(scopeKey, iso(nowMs));
      const scope = db.prepare('SELECT * FROM media_quota_scopes WHERE scope_key=?').get(scopeKey);
      const starts = db.prepare(`SELECT started_at_ms FROM media_dispatches WHERE scope_key=? AND started_at_ms>?
        ORDER BY started_at_ms`).all(scopeKey, nowMs - windowMs).map((row) => row.started_at_ms);
      const rollingRelease = starts.length >= rpm ? starts[starts.length - rpm] + windowMs + safetyMarginMs : 0;
      const allowedAt = Math.max(nowMs, scope.next_spacing_at_ms, scope.cooldown_until_ms, rollingRelease);
      if (allowedAt > nowMs) return { error: blocked('MEDIA_RATE_WAIT', 'Media quota window is cooling down.', allowedAt) };
      db.prepare('UPDATE media_visual_lane SET owner_token=?,lease_until_ms=?,heartbeat_at_ms=? WHERE id=1')
        .run(token, nowMs + leaseMs, nowMs);
      db.prepare(`UPDATE media_quota_scopes SET next_spacing_at_ms=?,updated_at=? WHERE scope_key=?`)
        .run(nowMs + paceMs, iso(nowMs), scopeKey);
      db.prepare(`INSERT INTO media_dispatches(id,scope_key,visual_id,substage,started_at_ms,state,created_at)
        VALUES (?,?,?,?,?,'dispatch_started',?)`).run(token, scopeKey, visualId, substage, nowMs, iso(nowMs));
      return { token, scopeKey, startedAtMs: nowMs };
    });
    if (outcome.error) throw outcome.error;
    const heartbeat = () => db.prepare(`UPDATE media_visual_lane SET lease_until_ms=?,heartbeat_at_ms=?
      WHERE id=1 AND owner_token=?`).run(clock() + leaseMs, clock(), token).changes === 1;
    const finish = ({ error = null, responseReceived = false } = {}) => transaction(db, () => {
      const completedAtMs = clock();
      const status = Number(error?.status || error?.httpStatus || 0) || null;
      const state = !error ? 'completed' : responseReceived || status ? 'failed' : 'outcome_unknown';
      db.prepare(`UPDATE media_dispatches SET state=?,http_status=?,error_code=?,completed_at_ms=?
        WHERE id=? AND state='dispatch_started'`).run(state, status, error?.code || null, completedAtMs, token);
      if (status === 429) {
        const scope = db.prepare('SELECT pressure_streak,cooldown_until_ms FROM media_quota_scopes WHERE scope_key=?').get(scopeKey);
        const streak = Number(scope?.pressure_streak || 0) + 1;
        const serverDelay = Math.max(Number(error?.retryAfterMs || 0), retryAfterDelayMs(error?.retryAfter, completedAtMs));
        const localDelay = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(streak - 1, 10));
        db.prepare(`UPDATE media_quota_scopes SET pressure_streak=?,cooldown_until_ms=?,updated_at=? WHERE scope_key=?`)
          .run(streak, Math.max(scope?.cooldown_until_ms || 0, completedAtMs + Math.max(serverDelay, localDelay)),
            iso(completedAtMs), scopeKey);
      } else if (!error) db.prepare(`UPDATE media_quota_scopes SET pressure_streak=0,updated_at=? WHERE scope_key=?`)
        .run(iso(completedAtMs), scopeKey);
      db.prepare('UPDATE media_visual_lane SET owner_token=NULL,lease_until_ms=0 WHERE id=1 AND owner_token=?').run(token);
      return state;
    });
    return { ...outcome, heartbeat, finish };
  }
  return { acquire };
}
