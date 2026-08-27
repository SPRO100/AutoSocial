const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeCookieSet, healthForAccount, qualitySummary } = require("../src/account-health");

test("cookie integrity analysis is deterministic and contains no cookie values", () => {
  const raw = JSON.stringify([
    { name: "sessionid", value: "fixture-value-a", domain: ".instagram.com", path: "/", secure: true, httpOnly: true, expires: 4102444800 },
    { name: "csrftoken", value: "fixture-value-b", domain: ".instagram.com", path: "/", secure: true, expires: 4102444800 },
  ]);
  const result = analyzeCookieSet(raw, "instagram");
  assert.equal(result.count, 2);
  assert.equal(result.criticalCount, 2);
  assert.deepEqual(result.domains, [".instagram.com"]);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("fixture-value"), false);
});

test("health projection is fail-closed and marks stale READY degraded", () => {
  const now = Date.now();
  assert.deepEqual(healthForAccount({ sessionStatus: "ready", sessionCheckedAt: new Date(now - 2 * 86400000).toISOString() }, now).healthState, "DEGRADED");
  assert.deepEqual(healthForAccount({ sessionStatus: "ready", sessionCheckedAt: new Date(now).toISOString() }, now).healthState, "READY");
  assert.equal(healthForAccount({ sessionStatus: "challenge_required", sessionState: "ACCOUNT_SUSPENDED" }, now).healthState, "QUARANTINED");
  assert.equal(healthForAccount({ sessionStatus: "unknown" }, now).healthState, "UNKNOWN");
  assert.equal(healthForAccount({ sessionStatus: "needs_login" }, now).healthState, "LOGIN_REQUIRED");
});

test("quality summary reports evidence limits for legacy pool", () => {
  const result = qualitySummary([
    { importPlatform: "instagram", sessionStatus: "ready", sessionCheckedAt: new Date().toISOString() },
    { importPlatform: "instagram", sessionStatus: "needs_login" },
    { importPlatform: "instagram", sessionStatus: "challenge_required", sessionState: "ACCOUNT_SUSPENDED" },
    { importPlatform: "tiktok", sessionStatus: "ready", sessionCheckedAt: new Date().toISOString() },
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.firstPassReady, 2);
  assert.equal(result.loginRequired, 1);
  assert.equal(result.challengedOrSuspended, 1);
  assert.match(result.note, /legacy imports/);
});
