// Conservative supplier adapter for the common Instagram export shapes:
// login:password[:totp|cookie][:cookie].  Only the first two separators are
// structural; cookie values may contain ':' and are never logged or echoed.
const { createRecord } = require("../normalize");
const ID = "instagram-colon-v1";
const TOTP = /^(?:[A-Z2-7]{16,}|\d{6,8})$/i;
const COOKIE = /(?:=|;|\{|\[|\b(?:sessionid|csrftoken|ds_user_id)\b)/i;

function lines(text) { return String(text || "").split(/\r?\n/).map((line, i) => ({ line: line.trim(), lineNumber: i + 1 })).filter(({ line }) => line && !line.startsWith("#")); }
function isCredentialLogin(value) {
  // Supplier identities are usernames/emails, never prose. Keep this
  // deliberately conservative: a false negative is reviewable; importing a
  // marketing sentence as an account is not.
  return /^[A-Za-z0-9][A-Za-z0-9._+@-]{2,127}$/.test(String(value || "").trim());
}
function classifyLine(line) {
  const first = line.indexOf(":");
  if (first <= 0) return "SUPPLIER_METADATA";
  const login = line.slice(0, first).trim();
  if (!isCredentialLogin(login) || /^https?$/i.test(login) || /\s/.test(login)) return "SUPPLIER_METADATA";
  const second = line.indexOf(":", first + 1);
  const passwordPart = line.slice(first + 1, second < 0 ? line.length : second).trim();
  if (!passwordPart) return "INVALID";
  // Supplier credential passwords are single fields. A whitespace-bearing
  // or URL-like value is prose/instructions and must not become an account.
  if (/\s/.test(passwordPart) || /^https?$/i.test(passwordPart)) return "SUPPLIER_METADATA";
  if (second < 0) return "ACCOUNT_RECORD";
  return "ACCOUNT_RECORD";
}
function test(text) {
  return lines(text).some(({ line }) => !line.includes(",") && classifyLine(line) === "ACCOUNT_RECORD");
}
function parse(text) {
  const records = []; const errors = []; let ignoredMetadata = 0; let invalid = 0;
  const classifications = { ACCOUNT_RECORD: 0, SUPPLIER_METADATA: 0, COMMENT: 0, EMPTY: 0, INVALID: 0, AMBIGUOUS: 0 };
  for (const { line, lineNumber } of lines(text)) {
    const classification = classifyLine(line);
    if (classification === "SUPPLIER_METADATA") { ignoredMetadata += 1; classifications.SUPPLIER_METADATA += 1; continue; }
    if (classification === "INVALID") { invalid += 1; classifications.INVALID += 1; errors.push({ line: lineNumber, reason: "invalid credential record", code: "INVALID_ROW" }); continue; }
    const first = line.indexOf(":");
    if (first <= 0) continue;
    const login = line.slice(0, first).trim();
    const second = line.indexOf(":", first + 1);
    const passwordEnd = second < 0 ? line.length : second;
    const passwordValue = line.slice(first + 1, passwordEnd).trim();
    const tail = second < 0 ? "" : line.slice(second + 1).trim();
    if (!login || !passwordValue) { classifications.INVALID += 1; errors.push({ line: lineNumber, reason: "missing login or password", code: "INVALID_ROW" }); continue; }
    if (!tail) { classifications.ACCOUNT_RECORD += 1; records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, parserStatus: "READY", parserConfidence: "HIGH" })); continue; }
    // Four-part form is unambiguous only when the third field is a TOTP and
    // the remainder looks like a cookie.  Otherwise fail closed.
    const thirdSep = tail.indexOf(":");
    if (thirdSep > 0) {
      const maybeTotp = tail.slice(0, thirdSep).trim(); const cookie = tail.slice(thirdSep + 1).trim();
      // A cookie string may itself contain colons. If the complete tail has
      // cookie syntax, preserve it as one field instead of splitting it.
      if (COOKIE.test(tail) && !TOTP.test(maybeTotp)) {
        classifications.ACCOUNT_RECORD += 1; records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, cookies: tail, parserStatus: "READY", parserConfidence: "HIGH" }));
        continue;
      }
      if (!TOTP.test(maybeTotp) || !COOKIE.test(cookie)) { classifications.AMBIGUOUS += 1; errors.push({ line: lineNumber, reason: "ambiguous colon-delimited fields; review 2FA/cookie assignment", code: "PARSE_REVIEW_REQUIRED" }); continue; }
      classifications.ACCOUNT_RECORD += 1; records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, twoFactorSecret: maybeTotp, cookies: cookie, parserStatus: "READY", parserConfidence: "HIGH" }));
      continue;
    }
    if (TOTP.test(tail)) { classifications.ACCOUNT_RECORD += 1; records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, twoFactorSecret: tail, parserStatus: "READY", parserConfidence: "HIGH" })); }
    else if (COOKIE.test(tail)) { classifications.ACCOUNT_RECORD += 1; records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, cookies: tail, parserStatus: "READY", parserConfidence: "MEDIUM" })); }
    else { classifications.AMBIGUOUS += 1; errors.push({ line: lineNumber, reason: "ambiguous third field; cannot determine whether it is 2FA or cookie", code: "PARSE_REVIEW_REQUIRED" }); }
  }
  return { records, errors, ignoredMetadata, invalid, classifications };
}
module.exports = { id: ID, test, parse };
