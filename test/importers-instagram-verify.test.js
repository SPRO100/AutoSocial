const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyInstagramSession } = require("../src/importers/instagram-verify");

// Minimal fake Playwright Page - only the surface verifyInstagramSession
// actually calls. `locators` maps a selector string to canned behavior;
// unmapped selectors resolve to "nothing found" (count 0 / empty text /
// empty evaluateAll), matching a real Playwright locator on a page that
// doesn't contain that element - never throws just because a selector
// wasn't explicitly stubbed.
function makePage({ finalUrl, bodyText = "", hasNav = false, profileHandles = null, gotoError = null }) {
  let gotoCalls = 0;
  return {
    goto: async () => {
      gotoCalls += 1;
      if (gotoError) throw gotoError;
    },
    waitForLoadState: async () => {},
    url: () => finalUrl,
    locator: (selector) => ({
      first: () => ({}),
      innerText: async () => {
        if (selector === "body") return bodyText;
        return "";
      },
      count: async () => {
        if (selector === "nav") return hasNav ? 1 : 0;
        return 0;
      },
      evaluateAll: async () => {
        if (selector === 'a[href^="/"]') return profileHandles || [];
        return [];
      },
    }),
    getGotoCalls: () => gotoCalls,
  };
}

test("scraping_warning is an explicit challenge and a known challenge URL is not re-navigated", async () => {
  const page = makePage({
    finalUrl: "https://www.instagram.com/accounts/scraping_warning/",
    bodyText: "Sorry, something went wrong",
  });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.equal(result.challenge, true);
  assert.equal(result.code, "instagram_scraping_warning");
  assert.match(result.reason, /anti-automation|account review/i);
  assert.equal(page.getGotoCalls(), 0);
});

// --- Real production incident: signup redirect was misclassified as active ---

test("reports NOT active when redirected to Instagram's sign-up flow (the real incident: 'Get started on Instagram')", async () => {
  const page = makePage({
    finalUrl: "https://www.instagram.com/accounts/emailsignup/",
    bodyText: "Get started on Instagram\nSign up to see photos and videos from your friends.",
  });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.match(result.reason, /sign-up|not authenticated/i);
});

test("reports NOT active for the sign-up gate even when only the page TEXT matches, not the URL (client-side routing)", async () => {
  const page = makePage({
    finalUrl: "https://www.instagram.com/",
    bodyText: "Get started on Instagram\nSign up to see photos and videos from your friends.",
  });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
});

// --- Established gates ---

test("reports NOT active when redirected to login", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/accounts/login/", bodyText: "Log in to Instagram" });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.match(result.reason, /login/i);
});

test("reports NOT active for a checkpoint/challenge gate", async () => {
  const page = makePage({
    finalUrl: "https://www.instagram.com/challenge/",
    bodyText: "Help Us Confirm It's You. We detected an unusual login attempt.",
  });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.match(result.reason, /checkpoint|challenge/i);
});

test("reports NOT active for a consent/onetap gate, classified as PRIVACY_CHOICE_REQUIRED - never guessed as a safe cookie banner", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/accounts/onetap/", bodyText: "" });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.equal(result.state, "PRIVACY_CHOICE_REQUIRED");
  assert.match(result.reason, /privacy|subscription|consent/i);
});

test("reports NOT active (UNKNOWN, not LOGIN_REQUIRED) when navigated off instagram.com entirely - never proven to be a login page", async () => {
  const page = makePage({ finalUrl: "https://example.com/unexpected" });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.equal(result.state, "UNKNOWN");
});

test("reports NOT active (fails closed, UNKNOWN not LOGIN_REQUIRED) when navigation itself throws - real incident 2026-08-27 brenda9875428 ERR_TOO_MANY_REDIRECTS", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", gotoError: new Error("net::ERR_TOO_MANY_REDIRECTS") });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.equal(result.state, "UNKNOWN", "a navigation exception is not evidence of specifically a login requirement");
  assert.match(result.reason, /verification failed/);
});

// --- Real production incident: account suspended, no gate previously recognized it ---

test("reports NOT active with state ACCOUNT_SUSPENDED for a real /accounts/suspended/ page (2026-08-27 bruna118564 incident) - NEVER READY", async () => {
  const page = makePage({
    finalUrl: "https://www.instagram.com/accounts/suspended/?next=https%3A%2F%2Fwww.instagram.com%2F%3F__coig_ufac%3D1",
    bodyText: "",
  });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.equal(result.state, "ACCOUNT_SUSPENDED");
  assert.match(result.reason, /suspend/i);
});

// --- Genuinely authenticated ---

test("reports active when the home page shows the authenticated app shell (<nav> present) with no gate", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", bodyText: "Home Search Explore Reels Messages", hasNav: true });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, true);
  assert.equal(result.state, "READY");
});

test("reports active via identity-match evidence ALONE, with no <nav> marker (the two positive signals are independent, either is sufficient)", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", hasNav: false, profileHandles: ["kinsleyvaughn6", "explore", "direct"] });
  const result = await verifyInstagramSession(page, "kinsleyvaughn6");
  assert.equal(result.active, true);
  assert.equal(result.state, "READY");
});

// --- Core hardening (2026-08-27, real bruna118564 incident): UNKNOWN is not READY ---

test("reports NOT active (UNKNOWN) when no gate matched AND no positive authenticated evidence exists - READY must be proven, never assumed from absence of a known problem", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", bodyText: "some unexpected but harmless page content", hasNav: false });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false, "no gate matching is NOT itself proof of an authenticated session");
  assert.equal(result.state, "UNKNOWN");
  assert.match(result.reason, /no positive authenticated-session evidence/i);
});

test("reports NOT active (UNKNOWN) when no gate matched, no <nav>, and an expected username was supplied but never found among the page's links (no positive evidence, not a mismatch either)", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", bodyText: "unexpected page", hasNav: false, profileHandles: [] });
  const result = await verifyInstagramSession(page, "kinsleyvaughn6");
  assert.equal(result.active, false);
  assert.equal(result.state, "UNKNOWN");
});

// --- Identity binding ---

test("reports NOT active when the authenticated identity does not match the expected username", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", hasNav: true, profileHandles: ["someoneelse", "explore", "direct"] });
  const result = await verifyInstagramSession(page, "kinsleyvaughn6");
  assert.equal(result.active, false);
  assert.match(result.reason, /identity/i);
});

test("reports active when the authenticated identity matches the expected username", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", hasNav: true, profileHandles: ["kinsleyvaughn6", "explore", "direct"] });
  const result = await verifyInstagramSession(page, "kinsleyvaughn6");
  assert.equal(result.active, true);
});

test("identity check is diagnostic-only when no profile links are observable at all (never blocks a clean result)", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", hasNav: true, profileHandles: [] });
  const result = await verifyInstagramSession(page, "kinsleyvaughn6");
  assert.equal(result.active, true);
});
