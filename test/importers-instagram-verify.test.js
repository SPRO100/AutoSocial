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
  return {
    goto: async () => {
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
  };
}

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

test("reports NOT active for a consent/onetap gate", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/accounts/onetap/", bodyText: "" });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.match(result.reason, /consent|verification/i);
});

test("reports NOT active when navigated off instagram.com entirely", async () => {
  const page = makePage({ finalUrl: "https://example.com/unexpected" });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
});

test("reports NOT active (fails closed) when navigation itself throws", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", gotoError: new Error("net::ERR_CONNECTION_RESET") });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, false);
  assert.match(result.reason, /verification failed/);
});

// --- Genuinely authenticated ---

test("reports active when the home page shows the authenticated app shell (<nav> present) with no gate", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", bodyText: "Home Search Explore Reels Messages", hasNav: true });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, true);
});

test("reports active when no gate matched even without a detectable <nav> marker (never a false negative from an unverified selector)", async () => {
  const page = makePage({ finalUrl: "https://www.instagram.com/", bodyText: "some unexpected but harmless page content", hasNav: false });
  const result = await verifyInstagramSession(page);
  assert.equal(result.active, true, "the nav marker is a bonus signal only - its absence must never turn a healthy account into a false needs_login");
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
