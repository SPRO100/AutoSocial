const test = require("node:test");
const assert = require("node:assert/strict");

const {
  probeInstagramCapabilities,
  probeTikTokCapabilities,
  applyInstagramProfileLink,
  readInstagramProfileEdit,
  readInstagramPrivacy,
  readTikTokPrivacy,
  readTikTokProfileLink,
  classifyIdentity,
  safePathOnly,
  safeMessage,
} = require("../src/account-capability");

// Minimal fake Playwright Locator - chainable no-ops plus scripted leaf
// results, same pattern as instagram-uploader-permalink.test.js's fake Page.
function fakeLocator(script = {}) {
  const loc = {
    first: () => loc,
    filter: () => loc,
    count: async () => script.count ?? 0,
    inputValue: async () => (script.inputValue !== undefined ? script.inputValue : null),
    isEnabled: async () => (script.isEnabled !== undefined ? script.isEnabled : true),
    getAttribute: async () => (script.getAttribute !== undefined ? script.getAttribute : null),
    fill: async (value) => { script.onFill && script.onFill(value); },
    press: async () => {},
    click: async () => { script.onClick && script.onClick(); },
  };
  return loc;
}

// Configurable fake Page. `routes` maps a URL-matching RegExp to either a
// literal string (the URL the page "lands on", e.g. a redirect) or a
// function(url) => landedUrl. `locators` maps a selector-matching RegExp to
// a locator script (see fakeLocator). `getByRole` maps a name-matching
// RegExp to a locator script.
function fakePage({ routes = [], locators = [], getByRole = [], evaluateResult = null, gotoError = null, gotoStatus = 200 } = {}) {
  let currentUrl = "https://www.instagram.com/";
  return {
    async goto(url) {
      if (gotoError) throw gotoError;
      const match = routes.find(([re]) => re.test(url));
      currentUrl = match ? (typeof match[1] === "function" ? match[1](url) : match[1]) : url;
      return { status: () => gotoStatus };
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    url() { return currentUrl; },
    locator(selector) {
      const match = locators.find(([re]) => re.test(selector));
      return fakeLocator(match ? match[1] : {});
    },
    getByRole(_role, opts) {
      const name = String(opts?.name || "");
      const match = getByRole.find(([re]) => re.test(name));
      return fakeLocator(match ? match[1] : { count: 0 });
    },
    async evaluate() {
      return evaluateResult;
    },
  };
}

test("readInstagramProfileEdit: website field present reports AVAILABLE/AVAILABLE with its current value", async () => {
  const page = fakePage({
    locators: [[/placeholder="Website"/i, { count: 1, inputValue: "https://example.com/a" }]],
  });
  const result = await readInstagramProfileEdit(page);
  assert.equal(result.profileEditCapability, "AVAILABLE");
  assert.equal(result.linkCapability, "AVAILABLE");
  assert.equal(result.observedProfileLink, "https://example.com/a");
});

test("readInstagramProfileEdit: website field present but disabled (real finding: Instagram gates it on account eligibility) reports link UNAVAILABLE, never AVAILABLE from DOM presence alone", async () => {
  const page = fakePage({ locators: [[/placeholder="Website"/i, { count: 1, isEnabled: false, inputValue: "" }]] });
  const result = await readInstagramProfileEdit(page);
  assert.equal(result.profileEditCapability, "AVAILABLE");
  assert.equal(result.linkCapability, "UNAVAILABLE");
  assert.ok(result.evidence.includes("website_field_found_but_disabled"));
});

test("readInstagramProfileEdit: edit page reachable but no website field reports link UNAVAILABLE, never guesses a value", async () => {
  const page = fakePage({ locators: [[/placeholder="Website"/i, { count: 0 }]] });
  const result = await readInstagramProfileEdit(page);
  assert.equal(result.profileEditCapability, "AVAILABLE");
  assert.equal(result.linkCapability, "UNAVAILABLE");
  assert.equal(result.observedProfileLink, null);
});

test("readInstagramProfileEdit: redirected away from /accounts/edit/ reports profile edit UNAVAILABLE, never a fabricated capability", async () => {
  const page = fakePage({ routes: [[/\/accounts\/edit\/?$/, "https://www.instagram.com/accounts/login/"]] });
  const result = await readInstagramProfileEdit(page);
  assert.equal(result.profileEditCapability, "UNAVAILABLE");
  assert.equal(result.linkCapability, "UNKNOWN");
  assert.ok(result.evidence.some((e) => e.startsWith("redirected:")));
});

test("readInstagramProfileEdit: navigation error fails closed to UNKNOWN, never throws", async () => {
  const page = fakePage({ gotoError: new Error("net::ERR_CONNECTION_RESET") });
  const result = await readInstagramProfileEdit(page);
  assert.equal(result.profileEditCapability, "UNKNOWN");
  assert.equal(result.linkCapability, "UNKNOWN");
});

test("readInstagramPrivacy: reads PRIVATE from the real 'Private account' switch", async () => {
  const page = fakePage({
    locators: [[/role="switch"\]\[aria-label="Private account"/i, { count: 1, getAttribute: "true" }]],
  });
  const result = await readInstagramPrivacy(page);
  assert.equal(result.privacyStatus, "PRIVATE");
});

test("readInstagramPrivacy: reads PUBLIC from the real 'Private account' switch", async () => {
  const page = fakePage({
    locators: [[/role="switch"\]\[aria-label="Private account"/i, { count: 1, getAttribute: "false" }]],
  });
  const result = await readInstagramPrivacy(page);
  assert.equal(result.privacyStatus, "PUBLIC");
});

test("readInstagramPrivacy: toggle not found reports UNKNOWN, never guesses PUBLIC", async () => {
  const page = fakePage({ locators: [[/role="switch"\]\[aria-label="Private account"/i, { count: 0 }]] });
  const result = await readInstagramPrivacy(page);
  assert.equal(result.privacyStatus, "UNKNOWN");
});

test("classifyIdentity: maps verifyInstagramSession's confirmed-match reason to CONFIRMED", () => {
  assert.equal(classifyIdentity({ active: true, reason: "reached Instagram's authenticated app shell with a confirmed identity match and no login/signup/checkpoint gate" }), "CONFIRMED");
});

test("classifyIdentity: maps the identity-mismatch reason to MISMATCH even though active is false", () => {
  assert.equal(classifyIdentity({ active: false, reason: "authenticated identity did not match the imported username" }), "MISMATCH");
});

test("classifyIdentity: null/ambiguous input is UNKNOWN, never guessed", () => {
  assert.equal(classifyIdentity(null), "UNKNOWN");
  assert.equal(classifyIdentity({ active: true, reason: "reached Instagram's authenticated app shell with no login/signup/checkpoint gate" }), "UNKNOWN");
});

test("probeInstagramCapabilities: a non-READY session never opens the profile/privacy pages and reports UNKNOWN capabilities", async () => {
  const page = fakePage({ routes: [[/instagram\.com\/?$/, "https://www.instagram.com/accounts/login/"]] });
  const result = await probeInstagramCapabilities(page, "someuser");
  assert.equal(result.profileEditCapability, "UNKNOWN");
  assert.equal(result.linkCapability, "UNKNOWN");
  assert.equal(result.privacyStatus, "UNKNOWN");
  assert.ok(result.evidence.includes("session_not_ready_for_probe"));
});

test("applyInstagramProfileLink: desired URL already matches observed - no mutation performed, reports ACTIVE", async () => {
  let filled = false;
  const page = fakePage({
    locators: [[/placeholder="Website"/i, { count: 1, inputValue: "https://example.com/a", onFill: () => { filled = true; } }]],
  });
  const result = await applyInstagramProfileLink(page, "https://example.com/a");
  assert.equal(result.status, "ACTIVE");
  assert.equal(filled, false, "must not mutate when already correct");
});

test("applyInstagramProfileLink: link capability unavailable is reported without attempting a mutation", async () => {
  let filled = false;
  const page = fakePage({
    locators: [[/placeholder="Website"/i, { count: 0, onFill: () => { filled = true; } }]],
  });
  const result = await applyInstagramProfileLink(page, "https://example.com/a");
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(filled, false);
});

test("applyInstagramProfileLink: a disabled Website field is reported UNAVAILABLE without ever attempting fill()", async () => {
  let filled = false;
  const page = fakePage({
    locators: [[/placeholder="Website"/i, { count: 1, isEnabled: false, inputValue: "", onFill: () => { filled = true; } }]],
  });
  const result = await applyInstagramProfileLink(page, "https://example.com/a");
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(filled, false);
});

test("applyInstagramProfileLink: fill+verify round-trip matching desired URL reports ACTIVE", async () => {
  let value = "";
  const page = fakePage({
    getByRole: [[/submit/i, { count: 1, onClick: () => {} }]],
    locators: [[/placeholder="Website"/i, {
      get count() { return 1; },
      get inputValue() { return value; },
      onFill: (v) => { value = v; },
    }]],
  });
  const result = await applyInstagramProfileLink(page, "https://example.com/new");
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.observedUrl, "https://example.com/new");
});

test("applyInstagramProfileLink: field empty after apply reports MISSING, not a fabricated ACTIVE", async () => {
  const page = fakePage({
    getByRole: [[/submit/i, { count: 0 }]],
    locators: [[/placeholder="Website"/i, { count: 1, inputValue: "" }]],
  });
  const result = await applyInstagramProfileLink(page, "https://example.com/new");
  assert.equal(result.status, "MISSING");
});

test("applyInstagramProfileLink: an exception during the mutate step reports ERROR (ambiguous, never silently ACTIVE/MISSING)", async () => {
  const page = fakePage({
    locators: [[/placeholder="Website"/i, { count: 1, inputValue: "https://old.example.com", onFill: () => { throw new Error("timeout"); } }]],
  });
  const result = await applyInstagramProfileLink(page, "https://example.com/new");
  assert.equal(result.status, "ERROR");
});

test("readTikTokPrivacy: settings page rendering with no content reports UNKNOWN, never guesses PUBLIC", async () => {
  const page = fakePage({ locators: [[/body/, { count: 0 }]] });
  page.locator = () => ({ innerText: async () => "" });
  const result = await readTikTokPrivacy(page);
  assert.equal(result.privacyStatus, "UNKNOWN");
  assert.ok(result.evidence.includes("settings_page_did_not_render"));
});

test("readTikTokPrivacy: real 'Private account' switch checked=true resolves PRIVATE", async () => {
  const page = fakePage({ evaluateResult: "true" });
  page.locator = () => ({ innerText: async () => "Privacy\nDiscoverability\nPrivate account\nWith a private account..." });
  const result = await readTikTokPrivacy(page);
  assert.equal(result.privacyStatus, "PRIVATE");
});

test("readTikTokProfileLink: a real HTTP 403 on the profile page is reported precisely, never guessed as a generic render failure", async () => {
  const page = fakePage({ gotoStatus: 403 });
  const result = await readTikTokProfileLink(page, "fakeuser");
  assert.equal(result.linkCapability, "UNKNOWN");
  assert.ok(result.evidence.includes("profile_page_blocked_http_403"));
});

test("readTikTokProfileLink: no username supplied never guesses a profile URL", async () => {
  const result = await readTikTokProfileLink(fakePage(), null);
  assert.equal(result.linkCapability, "UNKNOWN");
  assert.ok(result.evidence.includes("no_username_supplied"));
});

test("readTikTokProfileLink: blank-rendered profile page reports UNKNOWN, not UNAVAILABLE (honest 'could not observe', never a false negative)", async () => {
  const page = fakePage();
  page.locator = () => ({ innerText: async () => "" });
  const result = await readTikTokProfileLink(page, "fakeuser");
  assert.equal(result.linkCapability, "UNKNOWN");
  assert.ok(result.evidence.includes("profile_page_did_not_render_http_200"));
});

test("probeTikTokCapabilities never leaks the raw username into evidence", async () => {
  const page = fakePage();
  page.locator = () => ({ innerText: async () => "" });
  const result = await probeTikTokCapabilities(page, "sensitive_username_value");
  assert.equal(JSON.stringify(result).includes("sensitive_username_value"), false);
});

test("safePathOnly masks any path segment outside the known-safe allowlist (e.g. a username in a redirect target)", () => {
  assert.equal(safePathOnly("https://www.instagram.com/accounts/login/"), "/accounts/login");
  assert.equal(safePathOnly("https://www.instagram.com/some_real_username/"), "/[masked]");
  assert.equal(safePathOnly("not a url"), "unknown_url");
});

test("safeMessage redacts known session/csrf query params and bounds length", () => {
  const msg = safeMessage("failed at ?sessionid=abc123&other=1".repeat(10));
  assert.ok(!msg.includes("abc123"));
  assert.ok(msg.length <= 160);
});
