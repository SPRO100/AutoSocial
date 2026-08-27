// Safe account-health and supplier-quality projections.
//
// This module deliberately deals only in operational metadata.  Cookie
// values, passwords and 2FA material are never returned, hashed, or logged.
const crypto = require("crypto");

const CRITICAL_INSTAGRAM_COOKIES = new Set(["sessionid", "ds_user_id", "csrftoken"]);
const FRESHNESS_MS = Number(process.env.AUTOSOCIAL_READY_FRESHNESS_MS || 24 * 60 * 60 * 1000);

function safeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hashMetadata(items) {
  return crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

function cookieObjects(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.cookies)) return parsed.cookies;
  } catch { /* Netscape/header parsing below is structural only. */ }
  const rows = text.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (rows.some((line) => line.includes("\t"))) {
    return rows.map((line) => {
      const p = line.split("\t");
      return { domain: p[0], path: p[2], secure: String(p[3]).toUpperCase() === "TRUE", name: p[5], expires: Number(p[4]) || undefined };
    });
  }
  if (rows.length === 1 && rows[0].includes(";")) {
    return rows[0].split(";").map((pair) => {
      const i = pair.indexOf("=");
      return i > 0 ? { name: pair.slice(0, i).trim(), domain: null, path: "/" } : null;
    }).filter(Boolean);
  }
  return [];
}

/** Return a deterministic, secret-free description of a supplier cookie set. */
function analyzeCookieSet(raw, platform = null) {
  const objects = cookieObjects(raw);
  const now = Math.floor(Date.now() / 1000);
  const metadata = objects.map((cookie) => ({
    name: typeof cookie.name === "string" ? cookie.name : null,
    domain: typeof cookie.domain === "string" ? cookie.domain.toLowerCase() : null,
    path: typeof cookie.path === "string" ? cookie.path : "/",
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: typeof cookie.sameSite === "string" ? cookie.sameSite : null,
    hasExpiry: Number.isFinite(Number(cookie.expires ?? cookie.expirationDate)),
    expiryBucket: Number.isFinite(Number(cookie.expires ?? cookie.expirationDate)) ? Math.floor(Number(cookie.expires ?? cookie.expirationDate) / 3600) : null,
    expired: Number.isFinite(Number(cookie.expires ?? cookie.expirationDate)) && Number(cookie.expires ?? cookie.expirationDate) > 0 && Number(cookie.expires ?? cookie.expirationDate) < now,
  })).filter((cookie) => cookie.name);
  const names = [...new Set(metadata.map((cookie) => cookie.name))].sort();
  const criticalNames = names.filter((name) => CRITICAL_INSTAGRAM_COOKIES.has(name.toLowerCase()));
  const expiredCount = metadata.filter((cookie) => cookie.expired).length;
  const fingerprintMetadata = metadata.map(({ expired, ...cookie }) => cookie);
  return {
    platform: platform || null,
    count: metadata.length || null,
    domains: [...new Set(metadata.map((cookie) => cookie.domain).filter(Boolean))].sort(),
    names,
    criticalNames,
    criticalCount: criticalNames.length,
    expiredCount,
    sessionCookieCount: metadata.filter((cookie) => !cookie.hasExpiry).length,
    fingerprint: metadata.length ? hashMetadata(fingerprintMetadata.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) : null,
    analyzedAt: new Date().toISOString(),
  };
}

function healthForAccount(account, now = Date.now()) {
  const status = account.sessionStatus || "unknown";
  const state = account.sessionState || null;
  const checked = account.sessionCheckedAt ? new Date(account.sessionCheckedAt).getTime() : NaN;
  const stale = status === "ready" && (!Number.isFinite(checked) || now - checked > FRESHNESS_MS);
  if (state === "ACCOUNT_SUSPENDED" || status === "challenge_required") return { healthState: "QUARANTINED", failureClass: state === "ACCOUNT_SUSPENDED" ? "ACCOUNT_SUSPENDED" : "CHALLENGE_REQUIRED", stale: false };
  if (status === "needs_login") return { healthState: "LOGIN_REQUIRED", failureClass: state || "LOGIN_REQUIRED", stale: false };
  if (status === "unknown" || status === "error") return { healthState: "UNKNOWN", failureClass: state || status.toUpperCase(), stale: false };
  if (stale) return { healthState: "DEGRADED", failureClass: "STALE_READY", stale: true };
  if (status === "ready") return { healthState: "READY", failureClass: null, stale: false };
  return { healthState: "IMPORTED", failureClass: null, stale: false };
}

function qualitySummary(accounts) {
  const rows = accounts.filter((account) => account.importPlatform);
  const count = (predicate) => rows.filter(predicate).length;
  const rate = (n) => rows.length ? Number((n / rows.length).toFixed(4)) : null;
  const measured = rows.filter((a) => a.firstVerifiedAt && a.firstSessionStatus);
  const ready = measured.filter((a) => a.firstSessionStatus === "ready").length;
  return {
    total: rows.length,
    firstPassMeasured: measured.length,
    firstPassReady: ready,
    firstPassReadyRate: measured.length ? Number((ready / measured.length).toFixed(4)) : null,
    firstPassMeasurementComplete: measured.length === rows.length,
    loginRequired: count((a) => a.sessionStatus === "needs_login"),
    unknown: count((a) => a.sessionStatus === "unknown" || a.sessionStatus === "error"),
    challengedOrSuspended: count((a) => a.sessionStatus === "challenge_required"),
    staleReady: count((a) => healthForAccount(a).stale),
    note: measured.length ? "First-pass metrics cover accounts with import-time verification evidence; supplier attribution is unavailable for legacy imports." : "No import-time first-pass evidence exists for legacy imports; collect a new measured batch before evaluating supplier quality.",
  };
}

module.exports = { analyzeCookieSet, healthForAccount, qualitySummary, FRESHNESS_MS, CRITICAL_INSTAGRAM_COOKIES };
