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
function validLogin(value) { return /^@?[A-Za-z0-9][A-Za-z0-9._+@-]{1,127}$/.test(String(value || "").trim()); }
function suggest(content, platform) {
  const delimiter = detectDelimiter(content); const rows = lines(content).slice(0, 8);
  return { platform, delimiter: delimiter === "\t" ? "TAB" : delimiter, columns: Math.max(0, ...rows.map(({ line }) => line.split(delimiter).length)), rows: rows.map(({ line, lineNumber }) => ({ lineNumber, values: splitRow(line, delimiter).map(mask) })) };
}
function parse(content, platform, mapping) {
  const delimiter = mapping.delimiter === "TAB" ? "\t" : mapping.delimiter;
  const fields = mapping.fields || {}; const used = Object.entries(fields).filter(([, index]) => index !== "ignore" && index !== null && index !== undefined).map(([, index]) => Number(index));
  const fieldIndex = (field) => Number.isInteger(Number(fields[field])) && Number(fields[field]) >= 0 ? Number(fields[field]) : undefined;
  if (fieldIndex("username") === undefined && fieldIndex("login") === undefined && fieldIndex("email") !== undefined) fields.username = fields.email;
  const loginIndex = fieldIndex("username") ?? fieldIndex("login") ?? fieldIndex("email");
  const passwordIndex = fieldIndex("password");
  if (!Number.isInteger(Number(loginIndex)) || !Number.isInteger(Number(passwordIndex)) || used.filter((i) => i >= 0).length !== new Set(used.filter((i) => i >= 0)).size) return { records: [], errors: [{ reason: "login and password mappings are required and fields cannot be assigned twice", code: "PARSE_REVIEW_REQUIRED" }] };
  const records = []; const errors = []; let ignoredMetadata = 0;
  const pushRecord = (values) => {
    const requiredIndexes = [loginIndex, passwordIndex, fieldIndex("twoFactorSecret"), fieldIndex("cookie"), fieldIndex("cookies")].filter((index) => index !== undefined);
    if (requiredIndexes.some((index) => index >= values.length)) return false;
    const login = values[Number(loginIndex)] || ""; const password = values[Number(passwordIndex)] || "";
    if (!validLogin(login) || !password) return false;
    records.push(createRecord({ platform, username: login, email: fieldIndex("email") !== undefined ? values[fieldIndex("email")] : undefined, password, twoFactorSecret: fieldIndex("twoFactorSecret") !== undefined ? values[fieldIndex("twoFactorSecret")] : undefined, cookies: fieldIndex("cookie") !== undefined ? values[fieldIndex("cookie")] : (fieldIndex("cookies") !== undefined ? values[fieldIndex("cookies")] : undefined), recoveryEmail: fieldIndex("recoveryEmail") !== undefined ? values[fieldIndex("recoveryEmail")] : undefined, recoveryPassword: fieldIndex("recoveryPassword") !== undefined ? values[fieldIndex("recoveryPassword")] : undefined, externalId: fieldIndex("channelUrl") !== undefined ? values[fieldIndex("channelUrl")] : undefined, userAgent: fieldIndex("userAgent") !== undefined ? values[fieldIndex("userAgent")] : undefined, parserStatus: "READY", parserConfidence: "MANUAL" }));
    return true;
  };
  // Some suppliers export one credential per labelled block rather than one
  // row. Assemble only recognized credential labels; prose/ads never become
  // records and values remain server-side until the normal safe preview.
  const labelled = { username: /^(?:username|login|email)\s*[:=]\s*(.+)$/i, password: /^password\s*[:=]\s*(.+)$/i, twoFactorSecret: /^(?:2fa|totp|otp(?:_secret)?)\s*[:=]\s*(.+)$/i, cookie: /^(?:cookie|cookies)\s*[:=]\s*(.+)$/i };
  const blockLines = lines(content); const blocks = []; let block = {};
  for (const { line } of blockLines) {
    let matched = false;
    for (const [field, expression] of Object.entries(labelled)) { const match = line.match(expression); if (match) { if (field === "username" && block.username) { blocks.push(block); block = {}; } block[field] = match[1].trim(); matched = true; break; } }
    if (!matched && /^(?:username|login|email|password|2fa|totp|cookie|cookies)\s*[:=]/i.test(line)) block.invalid = true;
  }
  if (block.username) blocks.push(block);
  // A saved ROW template is authoritative. Do not let a colon in a supplier
  // row accidentally reinterpret it as labelled metadata.
  if (mapping.recordMode !== "ROW" && blocks.length >= 2) {
    for (const item of blocks) {
      if (!validLogin(item.username) || !item.password) continue;
      const values = []; values[Number(loginIndex)] = item.username; values[Number(passwordIndex)] = item.password;
      if (fieldIndex("twoFactorSecret") !== undefined) values[fieldIndex("twoFactorSecret")] = item.twoFactorSecret;
      if (fieldIndex("cookie") !== undefined) values[fieldIndex("cookie")] = item.cookie;
      pushRecord(values);
    }
    return { records, errors, ignoredMetadata: Math.max(0, blockLines.length - blocks.length * 3) };
  }
  for (const { line, lineNumber } of lines(content)) {
    const cookieIndex = fieldIndex("cookie") ?? fieldIndex("cookies");
    const values = splitRow(line, delimiter, cookieIndex);
    if (!pushRecord(values)) ignoredMetadata += 1;
  }
  return { records, errors, ignoredMetadata };
}
module.exports = { suggest, parse, detectDelimiter, splitRow };
