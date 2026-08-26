const test = require("node:test");
const assert = require("node:assert/strict");
const { SAFE_RECOVERABLE_STATES, attemptRecovery, getPrivacyChoicePolicy } = require("../src/importers/instagram-recovery");

// Minimal fake Playwright Page exposing only what instagram-recovery.js
// actually calls: page.locator(selector) -> { count(), nth(i) -> {
// innerText(), click() } }.
function makePageWithButtons(buttonTexts) {
  return {
    locator: (selector) => {
      assert.equal(selector, 'button, [role="button"], a');
      return {
        count: async () => buttonTexts.length,
        nth: (i) => ({
          innerText: async () => buttonTexts[i],
          click: async (opts) => {
            makePageWithButtons.lastClicked = buttonTexts[i];
          },
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
