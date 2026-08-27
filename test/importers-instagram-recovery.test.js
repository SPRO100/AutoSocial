const test = require("node:test");
const assert = require("node:assert/strict");
const { SAFE_RECOVERABLE_STATES, attemptRecovery, getPrivacyChoicePolicy } = require("../src/importers/instagram-recovery");

// Minimal fake Playwright Page exposing only what instagram-recovery.js
// actually calls: page.locator(selector) -> { count(), nth(i) -> {
// innerText(), click(), waitFor() } }. `detach` controls Recovery V2's
// bounded post-click transition wait: "immediate" resolves waitFor()
// right away (simulates the clicked element leaving the DOM promptly),
// "never" always rejects/times out (simulates it staying attached), and
// omitting it entirely (undefined) simulates an older/minimal fake page
// with no waitFor at all - must never throw just because it's absent.
function makePageWithButtons(buttonTexts, { detach } = {}) {
  return {
    locator: (selector) => {
      assert.equal(selector, 'button, [role="button"], a');
      return {
        count: async () => buttonTexts.length,
        nth: (i) => ({
          innerText: async () => buttonTexts[i],
          click: async () => {
            makePageWithButtons.lastClicked = buttonTexts[i];
          },
          ...(detach === undefined ? {} : {
            waitFor: async ({ timeout } = {}) => {
              if (detach === "immediate") return;
              // "never" - simulate Playwright's own timeout rejection.
              await new Promise((resolve) => setTimeout(resolve, Math.min(timeout || 0, 20)));
              throw new Error(`Timeout ${timeout}ms exceeded while waiting for element to be detached`);
            },
          }),
        }),
      };
    },
  };
}

test("SAFE_RECOVERABLE_STATES contains only the cookie-consent state - never a security/policy state", () => {
  assert.deepEqual([...SAFE_RECOVERABLE_STATES], ["COOKIE_CONSENT_REQUIRED"]);
});

test("attemptRecovery clicks 'Decline optional cookies' when present, preferring it over 'Allow all'", async () => {
  const page = makePageWithButtons(["Allow all cookies", "Decline optional cookies"]);
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, true);
  assert.match(result.detail, /Decline optional cookies/);
});

test("attemptRecovery falls back to 'Allow all cookies' when no decline option exists", async () => {
  const page = makePageWithButtons(["Allow all cookies"]);
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, true);
  assert.match(result.detail, /Allow all cookies/);
});

test("attemptRecovery reports performed:false (never throws, never guesses) when no recognized button exists", async () => {
  const page = makePageWithButtons(["Continue with Facebook", "Forgot password?"]);
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, false);
  assert.match(result.detail, /no recognized/i);
});

test("attemptRecovery reports performed:false gracefully when the page has no buttons at all", async () => {
  const page = makePageWithButtons([]);
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, false);
});

test("attemptRecovery never attempts any action for a security/policy state - only cookie consent has an implementation", async () => {
  for (const state of ["PRIVACY_CHOICE_REQUIRED", "SCRAPING_WARNING", "SECURITY_CHALLENGE", "TWO_FACTOR_REQUIRED", "CAPTCHA_REQUIRED", "LOGIN_REQUIRED", "BLOCKED_CHALLENGE"]) {
    const page = makePageWithButtons(["Allow all cookies"]); // even with a clickable button present
    const result = await attemptRecovery(page, state);
    assert.equal(result.performed, false, `${state} must never trigger an automated action`);
  }
});

// Regression lock (real production requirement, 2026-08-26): this module
// must never silently evolve into a generic "click through Instagram until
// something works" system. The real ads-data-processing/subscription
// consent flow an operator manually traced uses exactly this button
// sequence - none of it may ever match, even when presented as the ONLY
// buttons on a COOKIE_CONSENT_REQUIRED page (the most permissive case:
// if these were going to false-positive-match anything, this is where it
// would happen, since there's nothing else for the pattern search to find
// instead).
test("attemptRecovery never matches any button from the real Meta ads-consent/subscription flow, even as the only buttons present", async () => {
  const adsConsentFlowButtons = ["Get started", "Use free of charge with ads", "Continue", "Agree"];
  for (const label of adsConsentFlowButtons) {
    const page = makePageWithButtons([label]);
    const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
    assert.equal(result.performed, false, `"${label}" must never be treated as a safe cookie-consent control`);
  }
  // Also never matched when mixed in alongside a real, legitimate cookie
  // control - the search must not accidentally prefer/match these instead.
  const page = makePageWithButtons(["Get started", "Use free of charge with ads", "Continue", "Agree", "Decline optional cookies"]);
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, true);
  assert.match(result.detail, /Decline optional cookies/, "must still find and click only the genuine cookie control, never one of the ads-consent buttons");
});

test("scraping_warning challenge controls are never clicked even when a page's only buttons look cookie-consent-adjacent", async () => {
  // SCRAPING_WARNING has no action at all (see the state-gate test above),
  // but this asserts it independent of that gate too - even a low-level
  // call with a page full of clickable controls must never act.
  const page = makePageWithButtons(["I understand", "Continue", "Confirm", "Verify"]);
  const result = await attemptRecovery(page, "SCRAPING_WARNING");
  assert.equal(result.performed, false);
});

test("attemptRecovery reports a click failure without throwing", async () => {
  const page = {
    locator: () => ({
      count: async () => 1,
      nth: () => ({ innerText: async () => "Allow all cookies", click: async () => { throw new Error("element detached"); } }),
    }),
  };
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, false);
  assert.match(result.detail, /click failed/);
});

// --- Recovery V2 (2026-08-27+): bounded post-click transition detection --

test("performCookieConsent reports transitionObserved:false and a near-zero elapsed time when transitionWaitMs is not supplied (backward compatible with V1 callers)", async () => {
  const page = makePageWithButtons(["Decline optional cookies"]); // no `detach` option = no waitFor at all on the fake
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, true);
  assert.equal(result.transitionObserved, false);
  assert.equal(typeof result.transitionElapsedMs, "number");
});

test("performCookieConsent reports transitionObserved:true quickly when the clicked element detaches within the budget", async () => {
  const page = makePageWithButtons(["Decline optional cookies"], { detach: "immediate" });
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED", { transitionWaitMs: 2000 });
  assert.equal(result.performed, true);
  assert.equal(result.transitionObserved, true);
  assert.ok(result.transitionElapsedMs < 200, "an immediate detach must not wait anywhere near the full budget");
});

test("performCookieConsent reports transitionObserved:false (bounded, never throws) when the clicked element never detaches within the budget", async () => {
  const page = makePageWithButtons(["Decline optional cookies"], { detach: "never" });
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED", { transitionWaitMs: 20 });
  assert.equal(result.performed, true);
  assert.equal(result.transitionObserved, false);
});

test("performCookieConsent never waits for a transition when transitionWaitMs is 0 (explicit V1-equivalent behavior)", async () => {
  const page = makePageWithButtons(["Decline optional cookies"], { detach: "never" });
  const start = Date.now();
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED", { transitionWaitMs: 0 });
  assert.equal(result.performed, true);
  assert.equal(result.transitionObserved, false);
  assert.ok(Date.now() - start < 50, "transitionWaitMs:0 must add no real wait at all");
});

test("a click failure never reaches the transition-wait step (no waitFor call, no crash)", async () => {
  const page = {
    locator: () => ({
      count: async () => 1,
      nth: () => ({
        innerText: async () => "Allow all cookies",
        click: async () => { throw new Error("element detached"); },
        waitFor: async () => { throw new Error("must never be called after a failed click"); },
      }),
    }),
  };
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED", { transitionWaitMs: 500 });
  assert.equal(result.performed, false);
  assert.equal(result.transitionObserved, undefined);
});

// --- Recovery V2 (2026-08-27+): diagnostic candidate capture on no-match --
// Real incident (2026-08-27): bruna731302 hit "no recognized control" with
// zero captured evidence of what was actually on the page, permanently
// blocking any future fix. This never changes what is considered SAFE to
// click - it only records what was observed, bounded and deduplicated.

test("no recognized control found: the diagnostic detail includes a bounded, deduplicated sample of what WAS on the page", async () => {
  const page = makePageWithButtons(["Continuer", "Continuer", "En savoir plus", "", "  "]);
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, false);
  assert.match(result.detail, /no recognized/i);
  assert.match(result.detail, /observed candidates/i);
  assert.match(result.detail, /Continuer/);
  assert.match(result.detail, /En savoir plus/);
  // Deduplicated - "Continuer" appears twice on the page but must not be
  // listed twice in the diagnostic sample.
  const occurrences = (result.detail.match(/Continuer/g) || []).length;
  assert.equal(occurrences, 1, "duplicate candidate text must be deduplicated");
});

test("no recognized control found on an empty page: no candidates section is added (nothing to report)", async () => {
  const page = makePageWithButtons([]);
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, false);
  assert.equal(/observed candidates/i.test(result.detail), false);
});

test("the diagnostic candidate sample is bounded (never grows unbounded with a large page)", async () => {
  const manyButtons = Array.from({ length: 50 }, (_, i) => `Unrecognized Button ${i}`);
  const page = makePageWithButtons(manyButtons);
  const result = await attemptRecovery(page, "COOKIE_CONSENT_REQUIRED");
  assert.equal(result.performed, false);
  assert.ok(result.detail.length < 300, `diagnostic detail must stay bounded, got ${result.detail.length} chars`);
});

// --- Privacy/subscription choice policy hook ------------------------------

test("getPrivacyChoicePolicy reports unconfigured by default - no env var set", () => {
  delete process.env.AUTOSOCIAL_INSTAGRAM_PRIVACY_POLICY;
  const policy = getPrivacyChoicePolicy();
  assert.equal(policy.configured, false);
  assert.equal(policy.value, null);
});

test("getPrivacyChoicePolicy reports configured:true only when the env var is explicitly set, and never acts on it (no click implementation exists for PRIVACY_CHOICE_REQUIRED)", async () => {
  process.env.AUTOSOCIAL_INSTAGRAM_PRIVACY_POLICY = "some-future-value";
  try {
    const policy = getPrivacyChoicePolicy();
    assert.equal(policy.configured, true);
    assert.equal(policy.value, "some-future-value");
    const page = makePageWithButtons(["Continue without subscribing", "Subscribe"]);
    const result = await attemptRecovery(page, "PRIVACY_CHOICE_REQUIRED");
    assert.equal(result.performed, false, "a configured policy value must still never trigger an automated privacy/subscription choice in this milestone");
  } finally {
    delete process.env.AUTOSOCIAL_INSTAGRAM_PRIVACY_POLICY;
  }
});
