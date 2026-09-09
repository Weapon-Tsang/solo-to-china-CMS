import assert from "node:assert/strict";
import test from "node:test";
import { createLoginThrottle, resolveClientSource } from "../src/login-throttle.mjs";

test("adaptive account throttling stops repeated expensive password checks and expires", () => {
  let now = 1_000;
  const throttle = createLoginThrottle({ accountAttempts: 3, sourceAttempts: 20, windowMs: 60_000,
    baseCooldownMs: 5_000, maxCooldownMs: 20_000, maxEntries: 100 }, { clock: () => now });
  let passwordChecks = 0;
  const attempt = (username) => {
    const gate = throttle.check(username, "203.0.113.8");
    if (!gate.allowed) return gate;
    passwordChecks += 1;
    return throttle.recordFailure(username, "203.0.113.8");
  };
  assert.equal(attempt("admin").allowed, true);
  assert.equal(attempt("admin").allowed, true);
  assert.equal(attempt("admin").allowed, false);
  for (let index = 0; index < 10; index += 1) assert.equal(attempt("admin").allowed, false);
  assert.equal(passwordChecks, 3);
  assert.equal(throttle.check("another-admin", "203.0.113.8").allowed, true,
    "one account cooldown must not permanently lock every administrator on a shared source");
  now += 61_000;
  assert.equal(throttle.check("admin", "203.0.113.8").allowed, true);
  assert.equal(throttle.size(), 0);
});

test("untrusted forwarded headers cannot change the client-source key", () => {
  const request = { socket: { remoteAddress: "::ffff:127.0.0.1" }, headers: {
    "x-forwarded-for": "198.51.100.77", "cf-connecting-ip": "198.51.100.88",
  } };
  assert.equal(resolveClientSource(request, { trustedProxyHeader: "", trustedProxySources: [] }), "127.0.0.1");
  assert.equal(resolveClientSource(request, { trustedProxyHeader: "cf-connecting-ip", trustedProxySources: ["10.0.0.0/8"] }), "127.0.0.1");
  assert.equal(resolveClientSource(request, { trustedProxyHeader: "cf-connecting-ip", trustedProxySources: ["127.0.0.1"] }), "198.51.100.88");
});
