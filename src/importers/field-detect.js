// Shared, syntax-based classifiers for "what kind of account field is this
// value", used by both the generic auto-detecting supplier adapter
// (suppliers/credentials-auto.js) and manual-mapping.js's cookie-column
// auto-suggestion. Every function is a pure, side-effect-free syntax check -
// none of them ever logs or echoes the value they were given.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Base32 TOTP secrets (Google Authenticator style) or a bare 6-8 digit
// one-time code - deliberately conservative, mirrors instagram-colon.js's
// own TOTP pattern.
const TOTP = /^(?:[A-Z2-7]{16,}|\d{6,8})$/i;
const USER_AGENT = /^Mozilla\/\d/i;
// Supplier identities are usernames/emails, never prose - same shape
// instagram-colon.js and manual-mapping.js already require.
const LOGIN = /^@?[A-Za-z0-9][A-Za-z0-9._+@-]{1,127}$/;
// Real Instagram/TikTok/YouTube session-cookie names - a strong signal a
// blob is a cookie bundle even when it isn't valid JSON on its own (for
// example a header-style "name=value; name2=value2" string).
const COOKIE_NAME_HINT = /\b(?:sessionid|csrftoken|ds_user_id|mid|rur|shbid|shbts|ig_did|ig_nrcb|sid_tt|sessionid_ss|uid_tt|ttwid|sid|hsid|ssid|apisid|sapisid)\b/i;

function isEmail(value) {
  return EMAIL.test(String(value || "").trim());
}

function isTotp(value) {
  return TOTP.test(String(value || "").trim());
}

function isUserAgent(value) {
  return USER_AGENT.test(String(value || "").trim());
}

// A login candidate that is NOT itself email-shaped - callers that already
// have a dedicated email classifier should treat email columns separately,
// never as a username, even though LOGIN's charset technically permits '@'.
function isLoginCandidate(value) {
  const text = String(value || "").trim();
  return LOGIN.test(text) && !isEmail(text);
}

// Detects a JSON cookie array/object (Playwright storage-state or a flat
// browser-extension export), or a header-style "name=value; ..." cookie
// string, WITHOUT ever inspecting or requiring specific cookie VALUES - only
// structure (JSON shape with name/value keys) or well-known cookie NAMES.
function isCookieBundle(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (text[0] === "{" || text[0] === "[") {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.length > 0 && parsed.every((c) => c && typeof c === "object" && "name" in c && "value" in c);
      }
      if (parsed && typeof parsed === "object") {
        return Array.isArray(parsed.cookies) || COOKIE_NAME_HINT.test(text);
      }
    } catch {
      // Not valid JSON by itself (e.g. the tokenizer's bracket-depth
      // tracking still let through a malformed/truncated fragment) - fall
      // through to the cookie-name heuristic below rather than reject
      // outright.
    }
    return COOKIE_NAME_HINT.test(text);
  }
  if (/^#HttpOnly_/m.test(text) || /^\.?[\w.-]+\tTRUE\t/m.test(text)) return true; // Netscape cookies.txt
  if (text.includes("=")) {
    return COOKIE_NAME_HINT.test(text) || /^[\w.$-]+=[^;]*(?:;\s*[\w.$-]+=[^;]*)+$/.test(text);
  }
  return false;
}

module.exports = { isEmail, isTotp, isUserAgent, isLoginCandidate, isCookieBundle };
