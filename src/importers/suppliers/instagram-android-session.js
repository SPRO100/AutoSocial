// Instagram "device + session" supplier export (2026-08-27, first sample:
// instagram_test3.txt from this supplier - real file, NOT committed to
// this repo; see test/fixtures/instagram-android-session-sample.txt for a
// fully synthetic stand-in with the identical structure).
//
// Real record shape, one account per line:
//   USERNAME:PASSWORD||DEVICE_DATA|SESSION_DATA|||
//
// - USERNAME:PASSWORD is a plain credential pair, terminated by the first
//   "||" in the line - never split further (a password never legitimately
//   contains "||").
// - DEVICE_DATA is itself ";"-separated device/hardware identifiers
//   (device id, phone id, adid, OS version, etc.) - never a 2FA secret,
//   see the module header note on why it is never written to
//   twoFactorSecret, and never given its own canonical field (see the
//   report/ADR this format was added under: the canonical account model
//   has no "device fingerprint" slot, and one is not invented here).
// - SESSION_DATA is Instagram's own private/mobile-API authorization state
//   (Authorization, X-MID, IG-U-DS-USER-ID, IG-U-RUR, X-IG-WWW-Claim,
//   csrftoken, sessionid, ...). It freely contains BOTH ":" (e.g. inside an
//   Authorization bearer value) and ";" (its own internal field separator)
//   - this module NEVER splits on either character. The only structural
//   boundaries this format actually guarantees are the literal "||" after
//   the credential pair and the single "|" immediately after DEVICE_DATA;
//   everything else is preserved byte-for-byte.
// - The trailing "|||" is this format's own end-of-record terminator
//   (reserved/empty trailing fields) - only a trailing RUN of "|"
//   characters is ever stripped, never content.
//
// Detection is purely structural (the "||" + single "|" shape, a
// colon-separated credential pair, a username that looks like an
// identity) - never based on order numbers, account counts, or the
// specific file name this format was first observed in. A header/order/
// divider line (order number, "===" banners, etc.) simply never matches
// this shape and is silently skipped as supplier metadata, exactly like
// every other adapter in this directory - it is not special-cased by
// string content.
const { createRecord } = require("../normalize");

const ID = "instagram-android-session-v1";

// Same conservative identity shape already used by instagram-colon.js -
// deliberately narrow so a stray line of prose is never mistaken for a
// username.
const USERNAME_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._+@-]{1,127}$/;

function splitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line);
}

// Cheap, purely structural gate: does this line even attempt this format's
// shape? A real account row always contains "||" immediately after the
// credential pair - header/order/divider lines essentially never do.
function looksLikeAccountLine(line) {
  return line.includes("||");
}

// Returns { record } | { error } | { skip: true }. Never throws, never
// includes the raw line (which may carry a password/session secret) in an
// error reason.
function parseLine(line) {
  const doublePipe = line.indexOf("||");
  if (doublePipe <= 0) return { skip: true };

  const credentialPart = line.slice(0, doublePipe);
  const colon = credentialPart.indexOf(":");
  if (colon <= 0) return { error: "missing username/password separator" };

  const username = credentialPart.slice(0, colon).trim();
  const password = credentialPart.slice(colon + 1).trim();
  if (!username || !USERNAME_PATTERN.test(username)) return { error: "missing or invalid username" };
  // A password carrying whitespace or looking like a bare URL is prose/an
  // instruction line, not a real credential - same guard instagram-colon.js
  // uses for exactly this reason.
  if (!password || /\s/.test(password) || /^https?$/i.test(password)) return { error: "missing or invalid password" };

  // Only a trailing RUN of "|" characters (this format's "|||" terminator)
  // is ever stripped - never content. If stripping would leave nothing,
  // keep the original tail instead of losing data.
  let remainder = line.slice(doublePipe + 2);
  const strippedTrailing = remainder.replace(/\|+$/, "");
  if (strippedTrailing) remainder = strippedTrailing;
  if (!remainder) return { error: "missing device/session data" };

  // The ONE remaining structural boundary: the single "|" that separates
  // DEVICE_DATA from SESSION_DATA. Never searched for again inside either
  // half - SESSION_DATA may itself contain further "|" characters (e.g. an
  // encoded value) and those are preserved as part of it verbatim.
  const boundary = remainder.indexOf("|");
  if (boundary <= 0) return { error: "missing device/session boundary" };
  const deviceData = remainder.slice(0, boundary).trim();
  const sessionData = remainder.slice(boundary + 1).trim();
  if (!deviceData) return { error: "missing device data" };
  if (!sessionData) return { error: "missing session data" };

  return {
    record: createRecord({
      platform: "instagram",
      username,
      password,
      // SESSION_DATA is Instagram's private/mobile-API authorization state,
      // not a browser cookie jar dump - preserved verbatim in the canonical
      // "cookies" field (the closest existing canonical slot for "session/
      // credential blob to hand to the session layer"), never decomposed
      // into individual named fields (Authorization/X-MID/IG-U-*/csrftoken/
      // sessionid) since the canonical schema has no such fields and none
      // are invented here. See this format's own analysis note on which
      // downstream consumers can and cannot use it as-is.
      cookies: sessionData,
      // DEVICE_DATA is deliberately NOT written anywhere - there is no
      // canonical field for a device fingerprint, and it must never be
      // mistaken for twoFactorSecret (a hardware/device identifier is not
      // a 2FA secret, regardless of its shape or length). Recoverable from
      // the raw supplier file if ever needed; never fabricated, never
      // silently merged into an unrelated field.
      parserStatus: "READY",
      parserConfidence: "HIGH",
    }),
  };
}

function test(text) {
  return splitLines(text).some(({ line }) => looksLikeAccountLine(line) && !parseLine(line).error && !parseLine(line).skip);
}

function score(text) {
  const rows = splitLines(text).filter(({ line }) => looksLikeAccountLine(line) && !parseLine(line).error && !parseLine(line).skip);
  return { candidateRows: rows.length, validRows: rows.length, confidence: rows.length >= 2 ? "HIGH" : "MEDIUM" };
}

function parse(text) {
  const records = [];
  const errors = [];
  let ignoredMetadata = 0;
  const classifications = { ACCOUNT_RECORD: 0, SUPPLIER_METADATA: 0, INVALID: 0 };

  for (const { line, lineNumber } of splitLines(text)) {
    if (!looksLikeAccountLine(line)) {
      ignoredMetadata += 1;
      classifications.SUPPLIER_METADATA += 1;
      continue;
    }
    const result = parseLine(line);
    if (result.skip) {
      ignoredMetadata += 1;
      classifications.SUPPLIER_METADATA += 1;
      continue;
    }
    if (result.error) {
      classifications.INVALID += 1;
      errors.push({ line: lineNumber, reason: result.error, code: "INVALID_ROW" });
      continue;
    }
    classifications.ACCOUNT_RECORD += 1;
    records.push(result.record);
  }
  return { records, errors, ignoredMetadata, classifications };
}

module.exports = { id: ID, test, score, parse };
