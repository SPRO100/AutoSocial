// Conservative supplier adapter for the common Instagram export shapes:
// login:password[:totp|cookie][:cookie].  Only the first two separators are
// structural; cookie values may contain ':' and are never logged or echoed.
const { createRecord } = require("../normalize");
const ID = "instagram-colon-v1";
const TOTP = /^(?:[A-Z2-7]{16,}|\d{6,8})$/i;
const COOKIE = /(?:=|;|\{|\[|\b(?:sessionid|csrftoken|ds_user_id)\b)/i;

function lines(text) { return String(text || "").split(/\r?\n/).map((line, i) => ({ line: line.trim(), lineNumber: i + 1 })).filter(({ line }) => line && !line.startsWith("#")); }
function test(text) {
  return lines(text).some(({ line }) => {
    const first = line.indexOf(":");
    return first > 0 && !line.includes(",") && !/^\s*(login|username)\s*:/i.test(line);
  });
}
function parse(text) {
  const records = []; const errors = [];
  for (const { line, lineNumber } of lines(text)) {
    const first = line.indexOf(":");
    if (first <= 0) continue;
    const login = line.slice(0, first).trim();
    const second = line.indexOf(":", first + 1);
    const passwordEnd = second < 0 ? line.length : second;
    const passwordValue = line.slice(first + 1, passwordEnd).trim();
    const tail = second < 0 ? "" : line.slice(second + 1).trim();
    if (!login || !passwordValue) { errors.push({ line: lineNumber, reason: "missing login or password", code: "INVALID_ROW" }); continue; }
    if (!tail) { records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, parserStatus: "READY", parserConfidence: "HIGH" })); continue; }
    // Four-part form is unambiguous only when the third field is a TOTP and
    // the remainder looks like a cookie.  Otherwise fail closed.
    const thirdSep = tail.indexOf(":");
    if (thirdSep > 0) {
      const maybeTotp = tail.slice(0, thirdSep).trim(); const cookie = tail.slice(thirdSep + 1).trim();
      if (!TOTP.test(maybeTotp) || !COOKIE.test(cookie)) { errors.push({ line: lineNumber, reason: "ambiguous colon-delimited fields; review 2FA/cookie assignment", code: "PARSE_REVIEW_REQUIRED" }); continue; }
      records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, twoFactorSecret: maybeTotp, cookies: cookie, parserStatus: "READY", parserConfidence: "HIGH" }));
      continue;
    }
    if (TOTP.test(tail)) records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, twoFactorSecret: tail, parserStatus: "READY", parserConfidence: "HIGH" }));
    else if (COOKIE.test(tail)) records.push(createRecord({ platform: "instagram", username: login, password: passwordValue, cookies: tail, parserStatus: "READY", parserConfidence: "MEDIUM" }));
    else errors.push({ line: lineNumber, reason: "ambiguous third field; cannot determine whether it is 2FA or cookie", code: "PARSE_REVIEW_REQUIRED" });
  }
  return { records, errors };
}
module.exports = { id: ID, test, parse };
