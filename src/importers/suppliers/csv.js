// Generic, header-driven CSV account importer. Credentials are kept only in
// the existing ephemeral import pipeline and are never included in previews.
const { createRecord } = require("../normalize");

const ID = "generic-csv-v1";

function splitCsvLine(line) {
  const fields = []; let field = ""; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"' && quoted) { field += '"'; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { fields.push(field.trim()); field = ""; continue; }
    field += ch;
  }
  if (quoted) return null;
  fields.push(field.trim());
  return fields;
}

function normalizeHeader(value) { return String(value || "").toLowerCase().replace(/[\s_-]+/g, ""); }
function splitLines(text) { return String(text || "").split(/\r?\n/).map((line, index) => ({ line: line.trim(), lineNumber: index + 1 })).filter(({ line }) => line && !line.startsWith("#")); }

function test(text) {
  const lines = splitLines(text); if (!lines.length) return false;
  const header = splitCsvLine(lines[0].line); if (!header) return false;
  const keys = new Set(header.map(normalizeHeader));
  return keys.has("platform") && (keys.has("username") || keys.has("handle"));
}

function parse(text) {
  const lines = splitLines(text); const header = lines.length ? splitCsvLine(lines[0].line) : null;
  if (!header) return { records: [], errors: [] };
  const columns = header.map(normalizeHeader); const records = []; const errors = [];
  const get = (values, ...names) => { const index = names.map(normalizeHeader).map((name) => columns.indexOf(name)).find((i) => i >= 0); return index === undefined ? "" : values[index] || ""; };
  for (const { line, lineNumber } of lines.slice(1)) {
    const values = splitCsvLine(line);
    if (!values) { errors.push({ line: lineNumber, reason: "malformed CSV quoting" }); continue; }
    const platform = get(values, "platform").toLowerCase(); const username = get(values, "username", "handle");
    if (!platform || !username) { errors.push({ line: lineNumber, reason: "platform and username are required" }); continue; }
    records.push(createRecord({ platform, username, password: get(values, "password"), email: get(values, "email"), emailPassword: get(values, "emailPassword", "email_password"), authToken: get(values, "authToken", "auth_token"), externalId: get(values, "externalId", "external_id"), cookies: get(values, "cookies") }));
  }
  return { records, errors };
}

module.exports = { id: ID, test, parse };
