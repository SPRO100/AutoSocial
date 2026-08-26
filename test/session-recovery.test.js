const test = require("node:test");
const assert = require("node:assert/strict");
// Every test in this file except the dedicated settle-delay ones below runs
// with the delay disabled - they exercise the STATE MACHINE, not real
// timing, and would otherwise take several real seconds across the
// redirect-loop/exhaustion tests that loop multiple times. The settle-delay
// mechanism itself is proven separately, with its own fresh module-cache
// instance (see "settle delay" tests at the bottom), matching this
// repository's established module-cache-substitution convention.
process.env.AUTOSOCIAL_RECOVERY_SETTLE_DELAY_MS = "0";
const { recoverSession, mapToPipelineStatus, mapToSessionStatus } = require("../src/session-recovery");

// Fake verifier: a scripted sequence of classifications, one per call.
// skipNavigation is recorded so tests can assert recovery re-verifies use
// it (never force a fresh goto over an unfinished flow).
function scriptedVerify(sequence) {
  const calls = [];
  let index = 0;
  return {
    calls,
    verify: async (page, username, options) => {
      calls.push({ username, skipNavigation: Boolean(options && options.skipNavigation) });
      const result = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return result;
    },
  };
}

function fakeRecover(recoverableStates, actionImpl) {
  const attempts = [];
  return {
    SAFE_RECOVERABLE_STATES: new Set(recoverableStates),
    attemptRecovery: async (page, state) => {
      attempts.push(state);
      return actionImpl ? actionImpl(state) : { performed: true, action: "fake_action", detail: "ok" };
    },
    attempts,
  };
}

test("READY immediately - a single verify call, no recovery attempted", async () => {
  const { verify, calls } = scriptedVerify([{ active: true, state: "READY", reason: "ok", url: "https://x/" }]);
  const recover = fakeRecover([]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.active, true);
  assert.equal(result.state, "READY");
  assert.equal(calls.length, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].result, "READY");
});

test("cookie consent -> recovery -> READY", async () => {
  const { verify, calls } = scriptedVerify([
    { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" },
    { active: true, state: "READY", reason: "ok", url: "https://ig/" },
  ]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.active, true);
  assert.equal(result.state, "READY");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].skipNavigation, false, "the initial verify must navigate normally");
  assert.equal(calls[1].skipNavigation, true, "the re-verify after a recovery action must never force navigation");
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].action, "fake_action");
  assert.equal(result.attempts[0].actionPerformed, true);
  assert.equal(result.attempts[1].result, "READY");
});

test("privacy choice required -> stop, never attempts recovery, never READY", async () => {
  const { verify, calls } = scriptedVerify([{ active: false, state: "PRIVACY_CHOICE_REQUIRED", reason: "ad-free vs ads", url: "https://ig/consent/?flow=ad_free_subscription_blocking_flow" }]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]); // privacy choice is NOT in the recoverable set
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.active, false);
  assert.equal(result.state, "PRIVACY_CHOICE_REQUIRED");
  assert.equal(calls.length, 1, "must stop after the first verify - no automated action on a policy-sensitive state");
  assert.equal(recover.attempts.length, 0);
});

test("scraping warning is classified and stopped, never auto-resolved", async () => {
  const { verify, calls } = scriptedVerify([{ active: false, state: "SCRAPING_WARNING", reason: "anti-automation check", url: "https://ig/accounts/scraping_warning/", challenge: true }]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.state, "SCRAPING_WARNING");
  assert.equal(calls.length, 1);
  assert.equal(recover.attempts.length, 0);
});

for (const state of ["SECURITY_CHALLENGE", "TWO_FACTOR_REQUIRED", "CAPTCHA_REQUIRED", "LOGIN_REQUIRED"]) {
  test(`${state} -> stop, no automated action ever attempted`, async () => {
    const { verify, calls } = scriptedVerify([{ active: false, state, reason: "needs manual resolution", url: "https://ig/x/" }]);
    const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
    const result = await recoverSession({ verify, recover, page: {}, username: "u" });
    assert.equal(result.state, state);
    assert.equal(calls.length, 1);
    assert.equal(recover.attempts.length, 0);
  });
}

// Real production finding (2026-08-26): a manually-driven session showed
// Instagram's own server oscillating between a consent/cookie screen and
// its scraping_warning anti-automation challenge - confirmed via DevTools
// as genuine server-side redirects. This scenario (two DIFFERENT members
// of the challenge/consent family repeating) must classify as
// BLOCKED_CHALLENGE, not the generic REDIRECT_LOOP - see the dedicated
// non-recoverable-branch test below for the more realistic single-hop
// version; this one exercises the SIGNATURE-REPEAT branch reaching the
// same conclusion (both marked "recoverable" here purely to drive the
// orchestrator's generic repeat-detection through a second cycle - real
// instagram-recovery.js never marks SCRAPING_WARNING recoverable).
test("an A<->B cycle between two challenge/consent-family states classifies as BLOCKED_CHALLENGE, never generic REDIRECT_LOOP", async () => {
  const a = { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" };
  const b = { active: false, state: "SCRAPING_WARNING", reason: "warning", url: "https://ig/accounts/scraping_warning/" };
  const { verify, calls } = scriptedVerify([a, b, a, b, a, b, a, b]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED", "SCRAPING_WARNING"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u", maxAttempts: 10 });
  assert.equal(result.state, "BLOCKED_CHALLENGE");
  assert.match(result.reason, /oscillating|challenge/i);
  assert.ok(calls.length <= 10, "must never exceed the retry budget even while detecting the oscillation");
  assert.ok(calls.length < 8, "the oscillation must be detected well before the scripted sequence is exhausted");
});

// The generic loop-detector must still work for a repeat that has NOTHING
// to do with the consent/challenge family - e.g. our own real 2026-08-26
// E2E run, where brenda9875428/bruna118564 repeated the exact same
// COOKIE_CONSENT_REQUIRED state/URL with no SCRAPING_WARNING or
// PRIVACY_CHOICE_REQUIRED ever observed. That must remain REDIRECT_LOOP.
test("REDIRECT_LOOP is preserved for a plain repeated state with no challenge/consent-family oscillation involved", async () => {
  const same = { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" };
  const { verify, calls } = scriptedVerify([same, same]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.state, "REDIRECT_LOOP");
  assert.equal(calls.length, 2);
});

// The realistic, single-hop version of the real incident: cookie consent
// (recoverable, clicked) is immediately followed by scraping_warning
// (never recoverable - this is exactly instagram-recovery.js's real
// SAFE_RECOVERABLE_STATES, unlike the synthetic two-state fake above).
// SCRAPING_WARNING alone, first-seen, must stay SCRAPING_WARNING (see the
// separate "scraping warning is classified and stopped" test) - only
// SEEING IT AFTER a different family member flips it to BLOCKED_CHALLENGE.
test("cookie consent immediately followed by scraping_warning (the real, single-hop incident shape) classifies as BLOCKED_CHALLENGE", async () => {
  const { verify, calls } = scriptedVerify([
    { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" },
    { active: false, state: "SCRAPING_WARNING", reason: "Instagram requires account review before continuing (anti-automation check)", url: "https://ig/accounts/scraping_warning/challenge_abc123/" },
  ]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]); // real SAFE_RECOVERABLE_STATES - only cookie consent
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.state, "BLOCKED_CHALLENGE");
  assert.equal(result.active, false);
  assert.match(result.reason, /oscillating|challenge/i);
  assert.equal(calls.length, 2);
});

test("bounded retry exhaustion - never infinite-loops when a recoverable state never resolves", async () => {
  // Every verify call returns a DIFFERENT URL for the same recoverable
  // state, so the (state, url) signature never repeats and the loop only
  // ever ends via the maxAttempts budget, not via redirect-loop detection.
  const sequence = Array.from({ length: 20 }, (_, i) => ({
    active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: `https://ig/consent/?flow=user_cookie_choice_v2&r=${i}`,
  }));
  const { verify, calls } = scriptedVerify(sequence);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u", maxAttempts: 3 });
  assert.equal(result.state, "RECOVERY_EXHAUSTED");
  assert.equal(calls.length, 3, "exactly maxAttempts verify calls, never more");
});

test("a recovery action that finds nothing safe to click stops immediately as RECOVERY_EXHAUSTED", async () => {
  const { verify, calls } = scriptedVerify([{ active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" }]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"], () => ({ performed: false, action: "cookie_consent", detail: "nothing recognizable found" }));
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.state, "RECOVERY_EXHAUSTED");
  assert.equal(calls.length, 1, "must not retry the same non-performing action");
});

test("an infrastructure failure calling verify() itself is reported as FAILED, never guessed as NEEDS_LOGIN", async () => {
  const verify = async () => { throw new Error("page crashed"); };
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.state, "FAILED");
  assert.equal(result.active, false);
  assert.match(result.reason, /page crashed/);
});

test("every attempt entry persists the required fields and never a raw secret", async () => {
  const { verify } = scriptedVerify([
    { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" },
    { active: true, state: "READY", reason: "ok", url: "https://ig/" },
  ]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "sensitive_user", account: "acct-1", platform: "instagram", personaProfileId: "persona-1" });
  for (const entry of result.attempts) {
    assert.equal(entry.account, "acct-1");
    assert.equal(entry.platform, "instagram");
    assert.equal(entry.personaProfileId, "persona-1");
    assert.ok(typeof entry.attempt === "number");
    assert.ok("state" in entry);
    assert.ok("url" in entry);
    assert.ok("action" in entry);
    assert.ok("result" in entry);
    assert.ok("reason" in entry);
    assert.ok("timestamp" in entry);
    assert.ok("nextAction" in entry);
    assert.ok(new Date(entry.timestamp).toString() !== "Invalid Date");
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("sessionid="), false);
  assert.equal(serialized.includes("password"), false);
});

// --- Legacy-compatible mapping (TikTok has no `state` field at all) ------

test("mapToPipelineStatus falls back to legacy active/challenge logic when state is absent (TikTok)", () => {
  assert.equal(mapToPipelineStatus({ active: true }), "READY");
  assert.equal(mapToPipelineStatus({ active: false }), "NEEDS_LOGIN");
  assert.equal(mapToPipelineStatus({ active: false, challenge: true }), "CHALLENGE_REQUIRED");
});

test("mapToPipelineStatus uses the granular state when present (Instagram)", () => {
  assert.equal(mapToPipelineStatus({ active: true, state: "READY" }), "READY");
  assert.equal(mapToPipelineStatus({ active: false, state: "LOGIN_REQUIRED" }), "NEEDS_LOGIN");
  assert.equal(mapToPipelineStatus({ active: false, state: "FAILED" }), "FAILED");
  for (const state of ["SCRAPING_WARNING", "SECURITY_CHALLENGE", "TWO_FACTOR_REQUIRED", "CAPTCHA_REQUIRED", "PRIVACY_CHOICE_REQUIRED", "REDIRECT_LOOP", "RECOVERY_EXHAUSTED", "BLOCKED_CHALLENGE"]) {
    assert.equal(mapToPipelineStatus({ active: false, state }), "CHALLENGE_REQUIRED", `${state} must map to CHALLENGE_REQUIRED`);
  }
});

test("mapToSessionStatus mirrors the same legacy-fallback and granular rules at the account-manager layer", () => {
  assert.equal(mapToSessionStatus({ active: true }), "ready");
  assert.equal(mapToSessionStatus({ active: false }), "needs_login");
  assert.equal(mapToSessionStatus({ active: false, challenge: true }), "challenge_required");
  assert.equal(mapToSessionStatus({ active: false, state: "LOGIN_REQUIRED" }), "needs_login");
  assert.equal(mapToSessionStatus({ active: false, state: "FAILED" }), "error");
  assert.equal(mapToSessionStatus({ active: false, state: "SCRAPING_WARNING" }), "challenge_required");
  assert.equal(mapToSessionStatus({ active: false, state: "BLOCKED_CHALLENGE" }), "challenge_required");
});

test("BLOCKED_CHALLENGE is never in SAFE_RECOVERABLE_STATES for the real Instagram recovery module - it must stay terminal, never attempted", () => {
  // Real module, not a fake - this is the actual production safety
  // boundary, not just an orchestrator-level guarantee.
  const { SAFE_RECOVERABLE_STATES } = require("../src/importers/instagram-recovery");
  assert.equal(SAFE_RECOVERABLE_STATES.has("BLOCKED_CHALLENGE"), false);
});

test("a classification that already arrives as BLOCKED_CHALLENGE (e.g. from a future/different verifier) is returned as-is, never retried or reclassified", async () => {
  const { verify, calls } = scriptedVerify([{ active: false, state: "BLOCKED_CHALLENGE", reason: "already blocked", url: "https://ig/x/" }]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u" });
  assert.equal(result.state, "BLOCKED_CHALLENGE");
  assert.equal(calls.length, 1);
});

// --- Settle delay: proves the mechanism itself, with its own fresh module
// instance (env var must be read before the module first loads) - not the
// same instance the rest of this file already loaded with the delay
// disabled. -----------------------------------------------------------

test("a real, nonzero settle delay elapses between a performed recovery action and the next verify call", async () => {
  const settleMs = 60; // small but real - proves the mechanism without a slow test
  process.env.AUTOSOCIAL_RECOVERY_SETTLE_DELAY_MS = String(settleMs);
  delete require.cache[require.resolve("../src/session-recovery")];
  const { recoverSession: recoverSessionWithDelay } = require("../src/session-recovery");
  try {
    const timestamps = [];
    const { verify } = scriptedVerify([
      { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" },
      { active: true, state: "READY", reason: "ok", url: "https://ig/" },
    ]);
    const timedVerify = async (...args) => { timestamps.push(Date.now()); return verify(...args); };
    const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
    const result = await recoverSessionWithDelay({ verify: timedVerify, recover, page: {}, username: "u" });
    assert.equal(result.state, "READY");
    assert.equal(timestamps.length, 2);
    const elapsed = timestamps[1] - timestamps[0];
    assert.ok(elapsed >= settleMs, `expected at least ${settleMs}ms between the click and the re-verify, got ${elapsed}ms`);
  } finally {
    delete process.env.AUTOSOCIAL_RECOVERY_SETTLE_DELAY_MS;
    delete require.cache[require.resolve("../src/session-recovery")];
  }
});

test("settleDelayMs:0 disables the delay explicitly, independent of the env default (used by every other test in this file)", async () => {
  const start = Date.now();
  const { verify } = scriptedVerify([
    { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" },
    { active: true, state: "READY", reason: "ok", url: "https://ig/" },
  ]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u", settleDelayMs: 0 });
  assert.equal(result.state, "READY");
  assert.ok(Date.now() - start < 200, "an explicit settleDelayMs:0 must not add any real delay");
});

test("a real click's own promise resolving is never treated as recovery success by itself - only the NEXT verify call's classification decides that", async () => {
  // Direct assertion of the architectural separation the product
  // requirement calls out explicitly: instagram-recovery.js's
  // {performed:true} only ever means "the click dispatched", never
  // "Instagram is now authenticated" - READY is asserted here to come
  // exclusively from the verifier's own classification, not from the
  // action's performed flag.
  const { verify } = scriptedVerify([
    { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" },
    { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "still not ready right after the click", url: "https://ig/consent/?flow=user_cookie_choice_v2&step=2" },
  ]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED"], () => ({ performed: true, action: "cookie_consent", detail: "clicked" }));
  const result = await recoverSession({ verify, recover, page: {}, username: "u", settleDelayMs: 0, maxAttempts: 2 });
  assert.notEqual(result.state, "READY", "a performed click must never be conflated with a recovered session");
  assert.equal(result.active, false);
});
