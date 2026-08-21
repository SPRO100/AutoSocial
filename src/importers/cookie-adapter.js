// Converts a supplier's raw cookie blob into a payload Persona's own
// cookie importer (POST /api/profiles/{pid}/cookies, see
// engine/persona/cookies.py) can actually parse.
//
// Persona's parser (read in full while designing this milestone) only
// recognizes two real shapes: JSON (Playwright storage-state or a flat
// browser-extension export array) or Netscape cookies.txt (tab-delimited).
// It does NOT recognize a plain HTTP "name=value; name2=value2" header
// string - a very common shape for a supplier's raw session dump. This was
// confirmed against the real, running Persona API during this milestone's
// smoke test: passing such a string through as `text` failed with
// "No usable cookies found". This module is the fix - it expands a
// header-style string into a Playwright-shaped cookie array (using a
// conservative per-platform default domain, since the header string itself
// carries no domain/path/expiry) and passes anything already
// JSON/Netscape-shaped straight through unchanged.
const PLATFORM_DEFAULT_DOMAIN = {
  tiktok: ".tiktok.com",
  instagram: ".instagram.com",
  youtube: ".youtube.com",
};

// PRODUCTION BUG FOUND AND FIXED (forensic root-cause trace, see the
// milestone's diagnostic report): a header-style cookie built without an
// `expires` field defaults, on Persona's side (engine/persona/cookies.py
// normalize()), to a SESSION cookie (expires: -1). Persona's own cookie
// importer opens a short-lived browser process just to write the cookies,
// then closes it immediately - a session cookie only lives in that
// process's memory and is never written to the profile's persistent
// on-disk cookie store, so it does not exist for any later attach
// (verification, or real use). Confirmed with a controlled A/B trace
// against the real running Persona API: identical cookies with vs without
// an explicit `expires` - 0/3 survived a later attach without one, 3/3
// survived with one.
//
// FALLBACK PERSISTENCE POLICY (not a real supplier-provided expiry - the
// raw "name=value; name=value" header format never carries one, so there
// is nothing authentic to preserve here): every header-style cookie is
// given a synthetic expiry this many seconds in the future, purely so it
// survives the write-then-attach process boundary and normal day-to-day
// re-attaches. 30 days is a deliberate middle ground - long enough that a
// reasonable operational cadence of re-attaching/re-verifying an account
// never loses the cookie to this synthetic expiry specifically, short
// enough that it doesn't overstate confidence in how long the real TikTok
// session actually stays valid (that is governed entirely by TikTok's own
// server-side session/device checks, not by this timestamp). Overridable
// via AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS for operators who want a
// different tradeoff, without needing a code change.
const DEFAULT_HEADER_STYLE_FALLBACK_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// A malformed or non-positive override must never silently win: a NaN
// `expires` serializes as JSON `null`, and a zero/negative one produces an
// already-expired timestamp - either way Persona's own normalize() would
// treat the cookie as session-only again (expires in (None, "", 0) or
// simply already in the past), which is exactly the bug this constant
// exists to prevent. Falls back to the documented default and warns
// instead of failing that quietly.
function resolveHeaderStyleFallbackTtlSeconds() {
  const raw = process.env.AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_HEADER_STYLE_FALLBACK_TTL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[cookie-adapter] Ignoring invalid AUTOSOCIAL_HEADER_COOKIE_TTL_SECONDS=${JSON.stringify(raw)} ` +
      `(must be a positive number of seconds) - using the default of ${DEFAULT_HEADER_STYLE_FALLBACK_TTL_SECONDS}s (30 days) instead.`
    );
    return DEFAULT_HEADER_STYLE_FALLBACK_TTL_SECONDS;
  }
  return parsed;
}

const HEADER_STYLE_FALLBACK_TTL_SECONDS = resolveHeaderStyleFallbackTtlSeconds();

function looksLikeJson(text) {
  return text.startsWith("{") || text.startsWith("[");
}

function looksLikeNetscape(text) {
  return /\t/.test(text) || /^#HttpOnly_/m.test(text) || /^\.?[\w.-]+\tTRUE\t/m.test(text);
}

function parseHeaderStyleCookies(text) {
  return text
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) return null;
      return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    })
    .filter(Boolean);
}

// Returns { text } or { cookies } - ready to spread into
// persona-browser.js#importPersonaCookies's options - or null if nothing
// usable could be extracted at all.
function toPersonaCookiePayload(raw, platform) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;

  if (looksLikeJson(text) || looksLikeNetscape(text)) {
    return { text };
  }

  const pairs = parseHeaderStyleCookies(text);
  if (!pairs.length) return null;

  const domain = PLATFORM_DEFAULT_DOMAIN[platform];
  if (!domain) return null;

  // Computed once per call, not per cookie - these are all imported
  // together, there's no reason for their synthetic expiries to differ by
  // a few milliseconds from each other.
  const expires = Math.floor(Date.now() / 1000) + HEADER_STYLE_FALLBACK_TTL_SECONDS;

  return {
    cookies: pairs.map((c) => ({
      name: c.name,
      value: c.value,
      domain,
      path: "/",
      secure: true,
      expires,
    })),
  };
}

module.exports = { toPersonaCookiePayload, HEADER_STYLE_FALLBACK_TTL_SECONDS };
