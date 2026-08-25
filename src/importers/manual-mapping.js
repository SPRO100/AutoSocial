const { createRecord, toSafePreview } = require("./normalize");

function lines(text) { return String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).map((line, i) => ({ line: line.trim(), lineNumber: i + 1 })).filter(({ line }) => line && !line.startsWith("#")); }
function detectDelimiter(text) {
  const rows = lines(text).slice(0, 20).map((x) => x.line);
  const candidates = ["|", "\t", ";", ",", ":"];
  return candidates.map((delimiter) => ({ delimiter, score: rows.reduce((n, row) => n + (row.split(delimiter).length > 1 ? 1 : 0), 0) })).sort((a, b) => b.score - a.score)[0]?.delimiter || "|";
}
function splitRow(row, delimiter, cookieIndex) {
  if (delimiter === "whitespace") return row.trim().split(/\s+/);
  const parts = row.split(delimiter);
  if (cookieIndex === undefined || cookieIndex < 0 || cookieIndex >= parts.length - 1) return parts.map((x) => x.trim());
  return [...parts.slice(0, cookieIndex), parts.slice(cookieIndex).join(delimiter)].map((x) => x.trim());
}
function mask(value) { if (!value) return null; const s = String(value); return s.length <= 2 ? "**" : `${s.slice(0, 1)}${"*".repeat(Math.min(8, s.length - 1))}`; }
function suggest(content, platform) {
  const delimiter = detectDelimiter(content); const rows = lines(content).slice(0, 8);
  return { platform, delimiter: delimiter === "\t" ? "TAB" : delimiter, columns: Math.max(0, ...rows.map(({ line }) => line.split(delimiter).length)), rows: rows.map(({ line, lineNumber }) => ({ lineNumber, values: splitRow(line, delimiter).map(mask) })) };
}
function parse(content, platform, mapping) {
  const delimiter = mapping.delimiter === "TAB" ? "\t" : mapping.delimiter;
  const fields = mapping.fields || {}; const used = Object.entries(fields).filter(([, index]) => index !== "ignore" && index !== null && index !== undefined).map(([, index]) => Number(index));
  if (!fields.username && !fields.login && fields.email) fields.username = fields.email;
  const loginIndex = fields.username ?? fields.login ?? fields.email;
  const passwordIndex = fields.password;
  if (!Number.isInteger(Number(loginIndex)) || !Number.isInteger(Number(passwordIndex)) || used.filter((i) => i >= 0).length !== new Set(used.filter((i) => i >= 0)).size) return { records: [], errors: [{ reason: "login and password mappings are required and fields cannot be assigned twice", code: "PARSE_REVIEW_REQUIRED" }] };
  const records = []; const errors = [];
  for (const { line, lineNumber } of lines(content)) {
    const values = splitRow(line, delimiter, fields.cookie === undefined ? undefined : Number(fields.cookie));
    const login = values[Number(loginIndex)] || ""; const password = values[Number(passwordIndex)] || "";
    if (!login || !password || /\s/.test(login)) { continue; }
    records.push(createRecord({ platform, username: login, email: fields.email !== undefined ? login : undefined, password, twoFactorSecret: fields.twoFactorSecret !== undefined ? values[Number(fields.twoFactorSecret)] : undefined, cookies: fields.cookie !== undefined ? values[Number(fields.cookie)] : undefined, recoveryEmail: fields.recoveryEmail !== undefined ? values[Number(fields.recoveryEmail)] : undefined, recoveryPassword: fields.recoveryPassword !== undefined ? values[Number(fields.recoveryPassword)] : undefined, externalId: fields.channelUrl !== undefined ? values[Number(fields.channelUrl)] : undefined, userAgent: fields.userAgent !== undefined ? values[Number(fields.userAgent)] : undefined, parserStatus: "READY", parserConfidence: "MANUAL" }));
  }
  return { records, errors };
}
module.exports = { suggest, parse, detectDelimiter, splitRow };
