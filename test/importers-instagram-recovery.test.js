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
  for (const state of ["PRIVACY_CHOICE_REQUIRED", "SCRAPING_WARNING", "SECURITY_CHALLENGE", "TWO_FACTOR_REQUIRED", "CAPTCHA_REQUIRED", "LOGIN_REQUIRED"]) {
    const page = makePageWithButtons(["Allow all cookies"]); // even with a clickable button present
    const result = await attemptRecovery(page, state);
    assert.equal(result.performed, false, `${state} must never trigger an automated action`);
  }
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
