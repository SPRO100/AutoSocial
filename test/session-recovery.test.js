const test = require("node:test");
const assert = require("node:assert/strict");
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

test("redirect loop between two states is detected and stopped, never infinite", async () => {
  const a = { active: false, state: "COOKIE_CONSENT_REQUIRED", reason: "banner", url: "https://ig/consent/?flow=user_cookie_choice_v2" };
  const b = { active: false, state: "SCRAPING_WARNING", reason: "warning", url: "https://ig/accounts/scraping_warning/" };
  // a -> (recoverable, act) -> b -> (not recoverable... but we need a cycle,
  // so make BOTH recoverable to exercise the true A->B->A cycle path)
  const { verify, calls } = scriptedVerify([a, b, a, b, a, b, a, b]);
  const recover = fakeRecover(["COOKIE_CONSENT_REQUIRED", "SCRAPING_WARNING"]);
  const result = await recoverSession({ verify, recover, page: {}, username: "u", maxAttempts: 10 });
  assert.equal(result.state, "REDIRECT_LOOP");
  assert.ok(calls.length <= 10, "must never exceed the retry budget even while detecting a loop");
  assert.ok(calls.length < 8, "the loop must be detected well before the scripted sequence is exhausted");
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
  for (const state of ["SCRAPING_WARNING", "SECURITY_CHALLENGE", "TWO_FACTOR_REQUIRED", "CAPTCHA_REQUIRED", "PRIVACY_CHOICE_REQUIRED", "REDIRECT_LOOP", "RECOVERY_EXHAUSTED"]) {
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
});
