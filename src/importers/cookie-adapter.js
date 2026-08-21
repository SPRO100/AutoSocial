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

  return {
    cookies: pairs.map((c) => ({
      name: c.name,
      value: c.value,
      domain,
      path: "/",
      secure: true,
    })),
  };
}

module.exports = { toPersonaCookiePayload };
