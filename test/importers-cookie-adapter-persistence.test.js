// Regression test for a real production bug (see the milestone's forensic
// diagnostic report): header-style cookies imported via
// cookie-adapter.js#toPersonaCookiePayload were silently discarded the
// moment Persona's own cookie-import CLI process closed, because they had
// no `expires` and defaulted to session-only cookies on Persona's side -
// session cookies only live in that short-lived process's memory and are
// never written to the profile's persistent on-disk cookie store.
//
// This can only be caught by a REAL round trip through the real, running
// Persona API - a mocked HTTP call cannot reproduce "does a cookie survive
// one Chromium process closing and a different one opening later," since
// that is genuine browser-engine persistence behavior, not JS logic. This
// test therefore talks to the real persona-api.service and is skipped
// (not failed) if it isn't reachable in the current environment, matching
// how the rest of this repo's suite stays hermetic by default while still
// giving this specific regression real coverage wherever Persona is up.
//
// Uses a throwaway Persona profile, created and deleted only for this
// test - never touches a real imported account. Never logs a cookie value.
const test = require("node:test");
const assert = require("node:assert/strict");

const { toPersonaCookiePayload } = require("../src/importers/cookie-adapter");
const {
  createPersonaProfile,
  importPersonaCookies,
  attachPersonaProfile,
  disconnectPersonaBrowser,
  deletePersonaProfile,
} = require("../src/persona-browser");
const { config } = require("../src/config");

const TARGET_COOKIE_NAMES = ["sessionid", "sessionid_ss", "sid_tt", "uid_tt", "ttwid"];

async function isPersonaReachable() {
  try {
    const res = await fetch(`${config.personaApiUrl}/api/profiles`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function fakeHeaderStyleCookies() {
  // Fake values only, shaped like a real TikTok cookie-header dump - the
  // exact 5 names this milestone's diagnostic traced, plus a couple of
  // ancillary ones for realism.
  const names = [...TARGET_COOKIE_NAMES, "msToken", "odin_tt"];
  return names.map((name, i) => `${name}=FAKEVAL${i}${"z".repeat(24)}`).join("; ");
}

test("REGRESSION: header-style cookies survive Persona's write process closing and a later, separate attach", async (t) => {
  if (!(await isPersonaReachable())) {
    t.skip("persona-api.service is not reachable in this environment - skipping the live persistence regression test");
    return;
  }

  const payload = toPersonaCookiePayload(fakeHeaderStyleCookies(), "tiktok");
  assert.ok(payload.cookies, "the adapter must produce a cookies array for a header-style string");

  let profile = null;
  let session = null;
  try {
    profile = await createPersonaProfile({
      name: "autosocial-test-cookie-persistence-regression",
      tags: ["autosocial-test", "regression-test"],
    });

    // Step 1: write - this is the short-lived process the real bug was in.
    const writeResult = await importPersonaCookies(profile.id, payload);
    assert.equal(writeResult.ok, true);

    // Step 2: a genuinely SEPARATE attach (new browser process), exactly
    // like the real pipeline's later verification step - reproduces the
    // real production process boundary, not a mocked shortcut.
    session = await attachPersonaProfile(profile.id, { headless: true });
    const liveCookies = await session.context.cookies();
    const liveNames = new Set(liveCookies.map((c) => c.name));

    for (const name of TARGET_COOKIE_NAMES) {
      assert.ok(liveNames.has(name), `${name} must still be present after a fresh attach - this is exactly the cookie that went missing in the real bug`);
    }

    // All 5 named cookies, not just "some of them" - the real bug lost
    // every header-style cookie, not a selective subset.
    const targetsPresent = TARGET_COOKIE_NAMES.filter((n) => liveNames.has(n));
    assert.equal(targetsPresent.length, TARGET_COOKIE_NAMES.length);
  } finally {
    if (session) await disconnectPersonaBrowser(session).catch(() => {});
    if (profile) await deletePersonaProfile(profile.id).catch(() => {});
  }
});
