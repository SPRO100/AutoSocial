// Real TikTok supplier adapter - the actual, confirmed supplier format
// (replaces the earlier placeholder adapter, which was explicitly marked
// unverified pending a real sample; that placeholder has been removed).
//
// Line shape, one account per line, pipe-delimited:
//   username|password|email|emailPassword|authToken|externalId|cookies
// - username is the only field whose VALUE is truly required - password,
//   email, emailPassword, authToken, externalId, and cookies may each be
//   empty. The DELIMITERS themselves are not optional though: this is a
//   fixed-column automated export, so a genuine account row always carries
//   all 6 "|" separators even when some values between them are blank
//   (see MIN_PIPES below - a line with fewer than 6 pipes is treated as
//   non-account content, not a malformed account, and is silently skipped
//   rather than reported as an error).
// - cookies (always the LAST field) is a raw HTTP-header-style cookie
//   string: "name=value; name=value; ..." - carrying TikTok's real session
//   cookies (sessionid, sessionid_ss, sid_tt, uid_tt, ttwid, etc.). Handed
//   to Persona's cookie importer as-is via ../cookie-adapter.js, which
//   already converts exactly this shape into what Persona's own API
//   accepts - unchanged by this adapter.
// - Supplier files ship with a marketing/informational header before the
//   real account rows (banner text, contact info, "batch checked" notices,
//   an optional literal column-header line, etc.) - all of it is skipped
//   automatically, never reported as a parse error. Only lines that
//   plausibly look like an attempted 7-field account row but fail
//   validation are reported as malformed.
const { createRecord } = require("../normalize");

const ID = "tiktok-pipe7-v1";
// 7 fields => at least 6 "|" separators. This is the one signal that
// separates a real (or malformed-but-attempted) account row from ad/header
// prose, which essentially never contains this many literal pipes. Known
// limitation, accepted pending a real file to verify against: a decorative
// header line that happens to contain 6+ literal pipes (e.g. an ASCII-art
// table border) could still false-positive into a spurious parse error;
// there is no secondary signal (e.g. validating the last field looks
// cookie-shaped) to fall back on yet.
const MIN_PIPES = 6;

function splitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }));
}

function pipeCount(line) {
  return (line.match(/\|/g) || []).length;
}

function looksLikeAccountLine(line) {
  if (!line || line.startsWith("#")) return false;
  return pipeCount(line) >= MIN_PIPES;
}

// A literal column-header row (the seller's own template line pasted into
// the file, e.g. "username|password|email|emailPassword|authToken|
// externalId|cookies") is recognized by its first field being the exact
// word "username" - never a real handle - not by position in the file, so
// it's skipped wherever it appears.
function isColumnHeaderLine(firstField) {
  return (firstField || "").trim().toLowerCase() === "username";
}

function test(text) {
  return splitLines(text).some(({ line }) => {
    if (!looksLikeAccountLine(line)) return false;
    const firstField = line.split("|", 1)[0];
    return !isColumnHeaderLine(firstField);
  });
}

function parseLine(line) {
  // Split into at most 7 parts - everything from the 7th field onward
  // (the cookies blob) is rejoined verbatim with "|", so a literal "|"
  // that happens to appear inside a cookie value can never shift which
  // field is which.
  const parts = line.split("|");
  const [usernameRaw, passwordRaw, emailRaw, emailPasswordRaw, authTokenRaw, externalIdRaw, ...cookieParts] = parts;

  if (isColumnHeaderLine(usernameRaw)) {
    return { skip: true };
  }

  const username = (usernameRaw || "").trim();
  if (!username) {
    return { error: "missing username" };
  }

  const cookies = cookieParts.length ? cookieParts.join("|").trim() : "";

  return {
    record: createRecord({
      platform: "tiktok",
      username,
      password: (passwordRaw || "").trim(),
      email: (emailRaw || "").trim(),
      emailPassword: (emailPasswordRaw || "").trim(),
      authToken: (authTokenRaw || "").trim(),
      externalId: (externalIdRaw || "").trim(),
      cookies,
    }),
  };
}

function parse(text) {
  const records = [];
  const errors = [];
  for (const { line, lineNumber } of splitLines(text)) {
    // Not shaped like an attempted account row at all - seller header/ad
    // text, a blank line, or a comment. Silently skipped, never an error.
    if (!looksLikeAccountLine(line)) continue;

    const result = parseLine(line);
    if (result.skip) continue;
    if (result.error) {
      // Never include the raw line - it may contain a password, auth
      // token, or cookie value even when malformed.
      errors.push({ line: lineNumber, reason: result.error });
    } else {
      records.push(result.record);
    }
  }
  return { records, errors };
}

module.exports = { id: ID, test, parse };
