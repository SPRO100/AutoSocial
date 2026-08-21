// TikTok supplier adapter - PLACEHOLDER FORMAT, UNVERIFIED AGAINST A REAL
// SUPPLIER FILE.
//
// No real TikTok supplier export was available to inspect when this adapter
// was written (the file the milestone brief referred to was never actually
// found in this environment - see the import milestone's final report).
// This adapter defines ONE reasonable, common-in-the-wild shape so the rest
// of the import pipeline (detector -> adapter -> normalize -> pipeline)
// could be built and genuinely tested end to end with fake fixtures.
//
// DO NOT trust the field mapping below against a real purchased account
// until it has been checked against an actual supplier sample. Everything
// downstream of normalize() (Persona profile creation, cookie import,
// session verification, rollback) is real and format-independent; only the
// parsing in this one file is a placeholder. Swapping it for the real
// format later means editing/replacing this file only - detector.js and
// pipeline.js never change.
//
// Assumed shape: one account per line, pipe-delimited, trailing fields
// optional:
//   username|password|email|emailPassword|externalId|cookies
// - Blank lines and lines starting with # are skipped.
// - cookies (if present) is everything after the 5th pipe, verbatim - it is
//   handed to Persona's own cookie importer as-is (see persona-browser.js's
//   importPersonaCookies), which already accepts raw JSON (Playwright
//   storage-state or extension-export arrays) or Netscape cookies.txt text.
//   This adapter does not need to understand the cookie format itself.

const { createRecord } = require("../normalize");

const ID = "tiktok-lines-v1";

function usableLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith("#"));
}

function test(text) {
  const lines = usableLines(text);
  if (!lines.length) return false;
  const withPipe = lines.filter(({ line }) => line.includes("|"));
  // Conservative: only claim this format if most non-comment lines actually
  // look like it, so an unrelated file doesn't get silently misparsed.
  return withPipe.length / lines.length >= 0.5;
}

function parseLine(line) {
  const parts = line.split("|").map((p) => p.trim());
  const [username, password, email, emailPassword, externalId, ...cookieParts] = parts;
  if (!username) {
    return { error: "missing username" };
  }
  const cookies = cookieParts.length ? cookieParts.join("|").trim() : undefined;
  return {
    record: createRecord({
      platform: "tiktok",
      username,
      password,
      email,
      emailPassword,
      externalId,
      cookies: cookies || undefined,
    }),
  };
}

function parse(text) {
  const records = [];
  const errors = [];
  for (const { line, lineNumber } of usableLines(text)) {
    const result = parseLine(line);
    if (result.error) {
      // Never include the raw line in the error - it may contain a
      // password or cookie value.
      errors.push({ line: lineNumber, reason: result.error });
    } else {
      records.push(result.record);
    }
  }
  return { records, errors };
}

module.exports = { id: ID, test, parse };
