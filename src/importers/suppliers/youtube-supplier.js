// Conservative YouTube supplier adapter. It accepts common pipe/tab layouts
// and preserves the final cookie field as an opaque payload. Metadata and
// advertising lines are ignored unless they contain a strong email/password
// credential shape.
const { createRecord } = require("../normalize");
const ID = "youtube-supplier-v1";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COOKIE = /(?:=|;|\{|\[|\bsessionid\b|\bcookie\b)/i;
const URL = /(?:youtube\.com|youtu\.be)\//i;
function lines(text) { return String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).map((line, i) => ({ line: line.trim(), lineNumber: i + 1 })).filter(({ line }) => line && !line.startsWith("#")); }
function delimiter(line) { if (line.includes("\t")) return "\t"; if ((line.match(/\|/g) || []).length >= 1) return "|"; return null; }
function candidate(line) {
  const d = delimiter(line); if (!d) return null;
  const fields = line.split(d).map((v) => v.trim());
  if (fields.length < 2 || !EMAIL.test(fields[0]) || !fields[1] || /\s/.test(fields[1])) return null;
  return fields;
}
function score(text) { const rows = lines(text).map(({ line }) => candidate(line)).filter(Boolean); return { candidateRows: rows.length, validRows: rows.length, confidence: rows.length >= 2 ? "HIGH" : "MEDIUM" }; }
function test(text) { return score(text).validRows > 0; }
function parse(text) {
  const records = []; const errors = []; let ignoredMetadata = 0; const classifications = { ACCOUNT_RECORD: 0, SUPPLIER_METADATA: 0, COMMENT: 0, EMPTY: 0, INVALID: 0, AMBIGUOUS: 0 };
  for (const { line, lineNumber } of lines(text)) {
    const fields = candidate(line);
    if (!fields) { ignoredMetadata += 1; classifications.SUPPLIER_METADATA += 1; continue; }
    const [login, password, ...rest] = fields;
    const channel = rest.find((v) => URL.test(v)) || "";
    const recoveryEmail = rest.find((v) => EMAIL.test(v) && v !== login) || "";
    const userAgent = rest.find((v) => /(?:mozilla|chrome|safari|webkit)\//i.test(v)) || "";
    const cookies = rest.slice().reverse().find((v) => COOKIE.test(v) && v !== userAgent) || "";
    classifications.ACCOUNT_RECORD += 1;
    records.push(createRecord({ platform: "youtube", username: login, email: login, password, recoveryEmail, externalId: channel, userAgent, cookies, parserStatus: "READY", parserConfidence: "HIGH" }));
  }
  return { records, errors, ignoredMetadata, classifications };
}
module.exports = { id: ID, test, score, parse };
