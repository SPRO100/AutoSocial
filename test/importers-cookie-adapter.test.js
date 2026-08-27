const test = require("node:test");
const assert = require("node:assert/strict");

const { toPersonaCookiePayload, HEADER_STYLE_FALLBACK_TTL_SECONDS } = require("../src/importers/cookie-adapter");

test("a raw HTTP-header-style cookie string is expanded into a Playwright-shaped cookies array with a platform default domain and a future expires", () => {
  const before = Math.floor(Date.now() / 1000);
  const payload = toPersonaCookiePayload("sessionid=abc123; sid_guard=def456", "tiktok");
  assert.ok(payload.cookies);
  assert.equal(payload.cookies.length, 2);
  for (const cookie of payload.cookies) {
    assert.equal(typeof cookie.expires, "number");
    assert.ok(cookie.expires > before, "expires must be in the future - a missing/past expires is exactly the bug that caused cookies to never persist past the Persona write process");
  }
  const { expires: expires0, ...rest0 } = payload.cookies[0];
  const { expires: expires1, ...rest1 } = payload.cookies[1];
  assert.deepEqual(rest0, { name: "sessionid", value: "abc123", domain: ".tiktok.com", path: "/", secure: true });
  assert.deepEqual(rest1, { name: "sid_guard", value: "def456", domain: ".tiktok.com", path: "/", secure: true });
});

test("the fallback expires is derived from the documented TTL constant, not a hidden magic number, and is the same for every cookie in one call", () => {
  const before = Math.floor(Date.now() / 1000);
  const payload = toPersonaCookiePayload("sessionid=abc123; sid_guard=def456; another=xyz789", "tiktok");
  const after = Math.floor(Date.now() / 1000);
  const expiresValues = new Set(payload.cookies.map((c) => c.expires));
  assert.equal(expiresValues.size, 1, "all cookies from one call must share the same synthetic expiry");
  const [expires] = [...expiresValues];
  assert.ok(expires >= before + HEADER_STYLE_FALLBACK_TTL_SECONDS);
  assert.ok(expires <= after + HEADER_STYLE_FALLBACK_TTL_SECONDS);
});

test("HEADER_STYLE_FALLBACK_TTL_SECONDS is a reasonable, bounded, positive TTL - not zero, not absurdly long", () => {
  assert.ok(HEADER_STYLE_FALLBACK_TTL_SECONDS > 0);
  const oneYear = 365 * 24 * 60 * 60;
  assert.ok(HEADER_STYLE_FALLBACK_TTL_SECONDS < oneYear, "a synthetic fallback must not overstate confidence in the session's real validity with a near-permanent expiry");
});

test("a JSON array/object is passed through as raw text unchanged, not re-parsed", () => {
  const json = JSON.stringify([{ name: "a", value: "1", domain: ".tiktok.com" }]);
  assert.deepEqual(toPersonaCookiePayload(json, "tiktok"), { text: json });

  const storageState = JSON.stringify({ cookies: [{ name: "a", value: "1" }], origins: [] });
  assert.deepEqual(toPersonaCookiePayload(storageState, "tiktok"), { text: storageState });
});

test("Netscape cookies.txt (tab-delimited) is passed through as raw text unchanged", () => {
  const netscape = ".tiktok.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc123";
  assert.deepEqual(toPersonaCookiePayload(netscape, "tiktok"), { text: netscape });
});

test("returns null for empty/missing input", () => {
  assert.equal(toPersonaCookiePayload(null, "tiktok"), null);
  assert.equal(toPersonaCookiePayload("", "tiktok"), null);
  assert.equal(toPersonaCookiePayload("   ", "tiktok"), null);
});

test("returns null (rather than guessing) for a header-style string on a platform with no known default domain", () => {
  assert.equal(toPersonaCookiePayload("sessionid=abc123", "some-unsupported-platform"), null);
});

test("returns null for a header-style string with no valid name=value pairs at all", () => {
  assert.equal(toPersonaCookiePayload("this is not cookie data", "tiktok"), null);
});

// --- Instagram-only browser-cookie allowlist (2026-08-27, real supplier
// finding - instagram-android-session-v1) -----------------------------
// A header-style Instagram session block may mix real browser-cookie names
// with Instagram's own private/mobile-API authorization headers, which
// must never become Chromium cookies. Scoped strictly to platform ===
// "instagram" - every other platform is unaffected (see the TikTok tests
// above and the explicit regression test at the end of this section).

const REAL_ANDROID_SESSION_BLOCK =
  "Authorization=Bearer FAKE:JWT:TOKEN:VALUE1;X-MID=FAKE_MID_0001;IG-U-DS-USER-ID=1000000001;IG-U-RUR=FAKE_RUR_0001;X-IG-WWW-Claim=FAKE_CLAIM_0001;csrftoken=fakecsrftoken0001;sessionid=fakesessionid0001";

test("(A) Authorization never becomes a browser cookie for Instagram", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  assert.equal(payload.cookies.some((c) => c.name === "Authorization"), false);
});

test("(B) X-MID never becomes a browser cookie for Instagram", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  assert.equal(payload.cookies.some((c) => c.name === "X-MID"), false);
});

test("(C) IG-U-DS-USER-ID never becomes a browser cookie for Instagram", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  assert.equal(payload.cookies.some((c) => c.name === "IG-U-DS-USER-ID"), false);
});

test("(D) IG-U-RUR never becomes a browser cookie for Instagram", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  assert.equal(payload.cookies.some((c) => c.name === "IG-U-RUR"), false);
});

test("(E) X-IG-WWW-Claim never becomes a browser cookie for Instagram", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  assert.equal(payload.cookies.some((c) => c.name === "X-IG-WWW-Claim"), false);
});

test("(F) sessionid becomes a real browser cookie for Instagram", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  const cookie = payload.cookies.find((c) => c.name === "sessionid");
  assert.ok(cookie);
  assert.equal(cookie.domain, ".instagram.com");
});

test("(G) csrftoken becomes a real browser cookie for Instagram", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  const cookie = payload.cookies.find((c) => c.name === "csrftoken");
  assert.ok(cookie);
  assert.equal(cookie.domain, ".instagram.com");
});

test("(H) ds_user_id name-for-name becomes a browser cookie when it is actually present under that exact name", () => {
  const payload = toPersonaCookiePayload("sessionid=fakeSess1;csrftoken=fakeCsrf1;ds_user_id=1000000099", "instagram");
  assert.equal(payload.cookies.length, 3);
  assert.ok(payload.cookies.some((c) => c.name === "ds_user_id"));
});

test("(I) IG-U-DS-USER-ID is never renamed/mapped to ds_user_id - only the real supplier field name is checked, nothing is invented", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  assert.equal(payload.cookies.some((c) => c.name === "ds_user_id"), false, "no cookie named ds_user_id must be fabricated from IG-U-DS-USER-ID");
  assert.equal(payload.cookies.length, 2, "only sessionid and csrftoken survive filtering for this real supplier block");
});

test("filtering the android-session block down to zero allowlisted names returns null, exactly like any other unusable cookie data", () => {
  assert.equal(toPersonaCookiePayload("Authorization=Bearer FAKE;X-MID=FAKE_MID", "instagram"), null);
});

// (Q) TikTok/YouTube header-style cookies are completely unaffected by the
// Instagram-only allowlist - explicit regression lock on top of the
// existing "tiktok" tests above (which never exercised platform ===
// "instagram" at all, so were already implicitly unaffected; this test
// additionally proves a TikTok-shaped name that would NOT be on the
// Instagram allowlist still survives for its own platform).
test("(Q) TikTok/YouTube header-style cookie names are never filtered by the Instagram-only allowlist", () => {
  const tiktokPayload = toPersonaCookiePayload("sessionid=fakeVal1; sid_guard=fakeVal2; uid_tt=fakeVal3", "tiktok");
  assert.equal(tiktokPayload.cookies.length, 3, "sid_guard/uid_tt are not on the Instagram allowlist but must still survive for tiktok");
  const youtubePayload = toPersonaCookiePayload("SID=fakeVal1; HSID=fakeVal2", "youtube");
  assert.equal(youtubePayload.cookies.length, 2);
});

// (R) No secret leakage - filtering must never surface a dropped cookie's
// VALUE anywhere, including in the returned payload for the names that ARE
// kept.
test("(R) filtered-out cookie values never appear anywhere in the returned payload", () => {
  const payload = toPersonaCookiePayload(REAL_ANDROID_SESSION_BLOCK, "instagram");
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("FAKE_MID_0001"), false);
  assert.equal(serialized.includes("1000000001"), false);
  assert.equal(serialized.includes("FAKE_RUR_0001"), false);
  assert.equal(serialized.includes("FAKE_CLAIM_0001"), false);
  assert.equal(serialized.includes("FAKE:JWT:TOKEN:VALUE1"), false);
});

// --- AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS override validation -----------
// Regression coverage for a real reviewer finding: an invalid override
// must never silently win, because a NaN/zero/negative expires reproduces
// the exact original bug (Persona's normalize() treats it as a session
// cookie again). Each case reloads the module fresh (module-cache
// substitution, same convention as account-manager.test.js) since the TTL
// is resolved once at module load time.

function freshCookieAdapterWithEnv(value) {
  if (value === undefined) delete process.env.AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS;
  else process.env.AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS = value;
  delete require.cache[require.resolve("../src/importers/cookie-adapter")];
  return require("../src/importers/cookie-adapter");
}

test("a valid AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS override is honored", () => {
  const mod = freshCookieAdapterWithEnv("3600");
  assert.equal(mod.HEADER_STYLE_FALLBACK_TTL_SECONDS, 3600);
  delete process.env.AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS;
});

test("a non-numeric override (NaN) falls back to the default instead of silently reintroducing the session-cookie bug, and warns", () => {
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    const mod = freshCookieAdapterWithEnv("thirty days");
    assert.equal(mod.HEADER_STYLE_FALLBACK_TTL_SECONDS, 30 * 24 * 60 * 60);
    assert.equal(warned, true, "an invalid override must be surfaced, not silently ignored");
  } finally {
    console.warn = originalWarn;
    delete process.env.AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS;
  }
});

test("a zero or negative override falls back to the default rather than producing an already-expired cookie", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(freshCookieAdapterWithEnv("0").HEADER_STYLE_FALLBACK_TTL_SECONDS, 30 * 24 * 60 * 60);
    assert.equal(freshCookieAdapterWithEnv("-100").HEADER_STYLE_FALLBACK_TTL_SECONDS, 30 * 24 * 60 * 60);
  } finally {
    console.warn = originalWarn;
    delete process.env.AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS;
  }
});

test("an unset override uses the documented default", () => {
  const mod = freshCookieAdapterWithEnv(undefined);
  assert.equal(mod.HEADER_STYLE_FALLBACK_TTL_SECONDS, 30 * 24 * 60 * 60);
});
