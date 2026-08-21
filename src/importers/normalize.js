// Normalized account-import record + safe-preview helpers.
//
// Every supplier adapter (see src/importers/suppliers/) must produce records
// shaped exactly like this, regardless of the raw file format it parsed.
// The import pipeline (src/importers/pipeline.js) only ever works with this
// shape - it never knows or cares which supplier format a record came from.
// Adding a new supplier means adding a new adapter that emits this shape,
// never changing the pipeline.
//
// Fields are optional except platform/username - a supplier file may omit
// email, emailPassword, externalId, or cookies entirely.
const NORMALIZED_FIELDS = [
  "platform",
  "username",
  "password",
  "email",
  "emailPassword",
  "authToken",
  "externalId",
  "cookies",
];

function createRecord(fields = {}) {
  const record = {};
  for (const key of NORMALIZED_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") continue;
    record[key] = value;
  }
  return record;
}

function duplicateKey(record) {
  if (!record || !record.platform || !record.username) return null;
  return `${String(record.platform).toLowerCase()}:${String(record.username).toLowerCase()}`;
}

// Masks an email so a reviewer can recognize it without the full address
// ever being shown - e.g. "ab***@example.com". Never returns the raw email.
function maskEmail(email) {
  if (!email || typeof email !== "string") return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(local.length - visible.length, 3))}@${domain}`;
}

// Best-effort, never-throws count of how many cookies a raw cookie blob
// contains - shown in the safe preview so a reviewer can sanity-check
// "cookies exist and look plausible" without ever seeing a value. Returns
// null (not 0) when the shape can't be confidently counted, so the UI can
// distinguish "no cookies" from "couldn't tell".
function countCookies(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && Array.isArray(parsed.cookies)) return parsed.cookies.length;
  } catch {
    // Not JSON - fall through to a line-based estimate (Netscape/cookies.txt
    // style, or a simple "name=value; name2=value2" header string).
  }
  if (trimmed.includes(";") && !trimmed.includes("\n")) {
    return trimmed.split(";").map((s) => s.trim()).filter(Boolean).length;
  }
  const lines = trimmed
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return lines.length || null;
}

// The ONLY view of a record that may ever reach the Dashboard API response
// or frontend before import is confirmed. No password, no email password,
// no auth token, no cookie values - ever. See dashboard-server.js's
// import-preview route, which must never send anything but records already
// passed through this.
function toSafePreview(record) {
  return {
    platform: record.platform || null,
    username: record.username || null,
    emailMasked: maskEmail(record.email),
    externalId: record.externalId || null,
    hasPassword: Boolean(record.password),
    hasEmail: Boolean(record.email),
    hasEmailPassword: Boolean(record.emailPassword),
    hasAuthToken: Boolean(record.authToken),
    hasCookies: Boolean(record.cookies),
    cookieCount: countCookies(record.cookies),
  };
}

module.exports = {
  NORMALIZED_FIELDS,
  createRecord,
  duplicateKey,
  maskEmail,
  countCookies,
  toSafePreview,
};
