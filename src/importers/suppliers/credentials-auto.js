// Generic, headerless, delimiter-agnostic account+cookie-bundle adapter.
//
// Real production incident: a purchased Instagram supplier file (username,
// password, email, JSON cookie bundle, ...) matched neither instagram-colon
// (rejects any line containing a comma - the JSON bundle has plenty) nor
// csv.js (requires a recognized header row - this file has none), so it
// fell all the way through to manual-mapping's raw column-index guessing
// and rendered as "Column 1 / Column 2 / ...". This adapter fills that gap
// WITHOUT guessing: it tries every candidate delimiter (see DELIMITERS)
// using the JSON-safe tokenizer (../tokenizer.js, so a cookie bundle's
// internal commas/colons never fragment it), classifies each resulting
// column by the SHAPE of its values (field-detect.js) rather than by
// position, and only produces records when a username column and a
// password column can each be identified unambiguously. Anything less
// confident returns no records at all - detector.js then falls through to
// the existing manual-mapping review flow exactly as it did before this
// adapter existed, never a guessed/misassigned field.
//
// This is a platform-AGNOSTIC adapter (like csv.js) - it needs the
// operator's platform selection to label the records it produces, since a
// bare credentials file carries no platform marker of its own. detector.js
// marks both `generic: true` so a platform hint doesn't filter it out, and
// dashboard-server.js's /api/import/preview passes the hinted platform
// through to parse() as a second argument.
const { createRecord } = require("../normalize");
const { splitDelimited } = require("../tokenizer");
const { isEmail, isTotp, isUserAgent, isLoginCandidate, isCookieBundle } = require("../field-detect");

const ID = "credentials-auto-v1";
const DELIMITERS = ["|", "\t", ";", ",", ":"];
const CONFIDENCE_RATIO = 0.8;
const MAX_SAMPLE_LINES = 30;

function splitLines(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line && !line.startsWith("#"));
}

// Picks the delimiter whose bracket-safe split produces the most rows
// agreeing on the same column count (>= 2 columns) - the modal column
// count under the winning delimiter becomes this file's expected row shape.
function pickDelimiter(lines) {
  let best = null;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => splitDelimited(line, delimiter).length);
    const votes = new Map();
    for (const count of counts) {
      if (count < 2) continue;
      votes.set(count, (votes.get(count) || 0) + 1);
    }
    if (!votes.size) continue;
    const [columns, agreeing] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best || agreeing > best.agreeing) best = { delimiter, columns, agreeing };
  }
  return best;
}

function classifyColumns(rowValues, columns) {
  const samples = Array.from({ length: columns }, () => []);
  for (const values of rowValues) {
    values.forEach((value, index) => {
      if (index < columns && value) samples[index].push(value);
    });
  }
  const ratio = (predicate, column) => {
    const values = samples[column];
    if (!values.length) return 0;
    return values.filter(predicate).length / values.length;
  };

  const roles = new Array(columns).fill(null);
  // Priority order matters: a JSON cookie bundle or an email address must
  // never be reclassified as a plain username/password just because a
  // later, looser check would also technically match a few samples.
  for (let c = 0; c < columns; c += 1) if (ratio(isCookieBundle, c) >= CONFIDENCE_RATIO) roles[c] = "cookies";
  const emailColumns = [];
  for (let c = 0; c < columns; c += 1) if (!roles[c] && ratio(isEmail, c) >= CONFIDENCE_RATIO) emailColumns.push(c);
  // Two independently email-shaped columns in a supplier file are
  // conventionally "email" then "recovery email" - order is the only
  // available signal, and recoveryEmail is non-critical metadata, so a
  // wrong guess here is low-risk and still reviewable in the safe preview.
  if (emailColumns.length >= 1) roles[emailColumns[0]] = "email";
  if (emailColumns.length >= 2) roles[emailColumns[1]] = "recoveryEmail";
  for (let c = 0; c < columns; c += 1) if (!roles[c] && ratio(isUserAgent, c) >= CONFIDENCE_RATIO) roles[c] = "userAgent";
  for (let c = 0; c < columns; c += 1) if (!roles[c] && ratio(isTotp, c) >= CONFIDENCE_RATIO) roles[c] = "twoFactorSecret";

  const unclassified = [];
  for (let c = 0; c < columns; c += 1) if (!roles[c]) unclassified.push(c);

  // Username and password are near-indistinguishable by pure value shape
  // once email/cookie/userAgent/TOTP are already claimed - an alnum
  // password like "SafePass123" also satisfies the login-shape regex, so a
  // per-column "is this login-shaped" test alone cannot tell them apart.
  // Resolved instead with the one structural convention every adapter in
  // this codebase already assumes (csv.js, tiktok-pipe7.js,
  // instagram-colon.js, manual-mapping.js's own field list): username
  // precedes password. Only applied when exactly two unclassified columns
  // remain, the lower-indexed one is genuinely login-shaped, and the
  // higher-indexed one is present in every sampled row (a sparse
  // "sometimes empty" column is more likely optional metadata this adapter
  // doesn't know about than a real password field) - anything else is too
  // ambiguous and is left unassigned, which fails the whole file closed.
  if (unclassified.length === 2) {
    const [first, second] = unclassified;
    if (ratio(isLoginCandidate, first) >= CONFIDENCE_RATIO && samples[second].length === rowValues.length) {
      roles[first] = "username";
      roles[second] = "password";
    }
  }

  return roles;
}

function tryDetect(text) {
  const lineObjs = splitLines(text);
  if (!lineObjs.length) return null;
  const sample = lineObjs.slice(0, MAX_SAMPLE_LINES).map(({ line }) => line);
  const picked = pickDelimiter(sample);
  if (!picked || picked.columns < 2) return null;

  const { delimiter, columns } = picked;
  const rows = lineObjs
    .map(({ line, lineNumber }) => ({ lineNumber, values: splitDelimited(line, delimiter) }))
    .filter(({ values }) => values.length === columns);
  if (!rows.length) return null;

  const roles = classifyColumns(rows.map((r) => r.values), columns);
  const usernameCol = roles.indexOf("username");
  const passwordCol = roles.indexOf("password");
  // Fail closed: no confidently-identified username AND password column
  // means this file is not a match for this adapter at all, never a
  // partial/guessed record.
  if (usernameCol === -1 || passwordCol === -1) return null;

  return { roles, rows, usernameCol, passwordCol };
}

function score(text) {
  const detected = tryDetect(text);
  if (!detected) return { validRows: 0, confidence: "LOW" };
  return { validRows: detected.rows.length, confidence: "MEDIUM" };
}

function test(text) {
  return score(text).validRows > 0;
}

function parse(text, platformHint) {
  const platform = typeof platformHint === "string" ? platformHint.trim().toLowerCase() : "";
  // This adapter carries no platform signal of its own (unlike
  // instagram-colon/tiktok-pipe7/youtube-supplier, which are each
  // platform-specific by construction) - without an operator-selected
  // platform there is nothing safe to label these records with, so it
  // produces no records at all rather than a platform-less account.
  if (!platform) return { records: [], errors: [] };

  const detected = tryDetect(text);
  if (!detected) return { records: [], errors: [] };
  const { roles, rows, usernameCol, passwordCol } = detected;
  const colOf = (role) => roles.indexOf(role);
  const emailCol = colOf("email");
  const recoveryEmailCol = colOf("recoveryEmail");
  const cookieCol = colOf("cookies");
  const totpCol = colOf("twoFactorSecret");
  const uaCol = colOf("userAgent");

  const records = [];
  const errors = [];
  for (const { lineNumber, values } of rows) {
    const username = values[usernameCol];
    const password = values[passwordCol];
    if (!username || !password) {
      errors.push({ line: lineNumber, reason: "missing username or password", code: "INVALID_ROW" });
      continue;
    }
    records.push(
      createRecord({
        platform,
        username,
        password,
        email: emailCol >= 0 ? values[emailCol] : undefined,
        recoveryEmail: recoveryEmailCol >= 0 ? values[recoveryEmailCol] : undefined,
        cookies: cookieCol >= 0 ? values[cookieCol] : undefined,
        twoFactorSecret: totpCol >= 0 ? values[totpCol] : undefined,
        userAgent: uaCol >= 0 ? values[uaCol] : undefined,
        parserStatus: "READY",
        parserConfidence: "MEDIUM",
      })
    );
  }
  return { records, errors };
}

module.exports = { id: ID, generic: true, test, score, parse };
