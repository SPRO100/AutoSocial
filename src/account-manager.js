const fs = require("fs/promises");
const path = require("path");
const { config } = require("./config");

// Overridable for test isolation (same convention as every other path in
// config.js) - never set in normal operation, so production behavior is
// unchanged.
const STATE_FILE = process.env.ACCOUNTS_STATE_FILE
  ? path.resolve(process.env.ACCOUNTS_STATE_FILE)
  : path.resolve(config.projectRoot, "accounts-state.json");
const DEFAULT_ACCOUNT = { id: "default", name: "Default" };
const LEGACY_PROFILE_DIRS = {
  tiktok: config.profileDir,
  instagram: config.instagramProfileDir,
  youtube: config.youtubeProfileDir,
};

let state = {
  activeAccountId: DEFAULT_ACCOUNT.id,
  accounts: [DEFAULT_ACCOUNT],
};
let loaded = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePersonaProfileId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Preserves every known optional field on an account across a load/save
// round-trip. Extend this (not a bare {id, name} literal) when adding a new
// optional account field, or it will silently vanish the next time
// accounts-state.json is read.
function normalizeSourceField(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const SESSION_STATUS_VALUES = new Set(["ready", "needs_login", "challenge_required", "unknown", "error"]);
const PUBLISH_STATUS_VALUES = new Set(["published", "failed", "unconfirmed"]);
// Granular Session Recovery Pipeline state - see
// importers/instagram-verify.js's STATES (the authoritative definition;
// this is a mirrored validation allowlist, same pattern as the two enums
// above) and session-recovery.js (the orchestrator that produces these).
// Coarser than the values above only in one direction: every one of these
// maps to exactly one SESSION_STATUS_VALUES entry (see
// session-recovery.js#mapToSessionStatus), never the reverse.
const SESSION_STATE_VALUES = new Set([
  "READY",
  "COOKIE_CONSENT_REQUIRED",
  "PRIVACY_CHOICE_REQUIRED",
  "SCRAPING_WARNING",
  "SECURITY_CHALLENGE",
  "TWO_FACTOR_REQUIRED",
  "CAPTCHA_REQUIRED",
  "LOGIN_REQUIRED",
  "REDIRECT_LOOP",
  "BLOCKED_CHALLENGE",
  "SESSION_EXPIRED",
  "RECOVERY_RETRYABLE",
  "RECOVERY_EXHAUSTED",
  "FAILED",
  // 2026-08-27 hardening (see importers/instagram-verify.js STATES) - must
  // be kept in sync with that enum or normalizeEnum below silently drops
  // the value to null on persistence, even though it was classified
  // correctly upstream.
  "ACCOUNT_SUSPENDED",
  "UNKNOWN",
]);
// Bounded so a account's history can never grow unbounded across repeated
// checks/recoveries - only the most recent run's attempts are operationally
// useful.
const MAX_RECOVERY_ATTEMPTS_STORED = 10;

// Strict allowlist of fields, each independently sanitized with the same
// normalizeSafeText/normalizeIsoTimestamp helpers already used for every
// other free-text account field - defense in depth: even if a future caller
// misused this (session-recovery.js's own contract never puts a cookie/
// password/2FA value in an attempt object), nothing outside this allowlist
// can ever reach disk or the API.
function normalizeRecoveryAttempt(item) {
  if (!item || typeof item !== "object") return null;
  const attempt = {};
  if (typeof item.attempt === "number" && Number.isFinite(item.attempt)) attempt.attempt = item.attempt;
  const state = normalizeSafeText(item.state, 60);
  if (state) attempt.state = state;
  const url = normalizeSafeText(item.url, 300);
  if (url) attempt.url = url;
  const action = normalizeSafeText(item.action, 60);
  if (action) attempt.action = action;
  if (typeof item.actionPerformed === "boolean") attempt.actionPerformed = item.actionPerformed;
  const actionDetail = normalizeSafeText(item.actionDetail, 200);
  if (actionDetail) attempt.actionDetail = actionDetail;
  // Recovery V2 (2026-08-27+) diagnostic fields - see session-recovery.js's
  // recordAttempt. Same allowlist pattern as every other field here: must
  // be added explicitly or normalizeEnum-style stripping silently drops
  // them even though they were computed correctly upstream.
  if (typeof item.transitionObserved === "boolean") attempt.transitionObserved = item.transitionObserved;
  if (typeof item.transitionElapsedMs === "number" && Number.isFinite(item.transitionElapsedMs)) attempt.transitionElapsedMs = item.transitionElapsedMs;
  const result = normalizeSafeText(item.result, 60);
  if (result) attempt.result = result;
  const reason = normalizeSafeText(item.reason, 300);
  if (reason) attempt.reason = reason;
  const timestamp = normalizeIsoTimestamp(item.timestamp);
  if (timestamp) attempt.timestamp = timestamp;
  const nextAction = normalizeSafeText(item.nextAction, 200);
  if (nextAction) attempt.nextAction = nextAction;
  return attempt;
}
function normalizeRecoveryAttempts(value) {
  if (!Array.isArray(value)) return null;
  const normalized = value.map(normalizeRecoveryAttempt).filter(Boolean);
  if (!normalized.length) return null;
  return normalized.slice(-MAX_RECOVERY_ATTEMPTS_STORED);
}

function normalizeEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

// Free text that ends up here must already be a safe, human-readable
// message (e.g. verifyTikTokSession's own `reason`, or a caught
// Error.message already written to be safe elsewhere in this codebase -
// see persona-browser.js/pipeline.js's safeMessage()). Never a raw cookie/
// password/token - callers are responsible for that before calling in.
function normalizeSafeText(value, maxLen = 300) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeCookieIntegrity(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  if (typeof value.platform === "string") out.platform = normalizeSafeText(value.platform, 30);
  if (Number.isFinite(value.count)) out.count = Math.max(0, Math.floor(value.count));
  if (Array.isArray(value.domains)) out.domains = value.domains.filter((v) => typeof v === "string").slice(0, 20);
  if (Array.isArray(value.names)) out.names = value.names.filter((v) => typeof v === "string").slice(0, 80);
  if (Array.isArray(value.criticalNames)) out.criticalNames = value.criticalNames.filter((v) => typeof v === "string").slice(0, 20);
  if (Number.isFinite(value.criticalCount)) out.criticalCount = Math.max(0, Math.floor(value.criticalCount));
  if (Number.isFinite(value.expiredCount)) out.expiredCount = Math.max(0, Math.floor(value.expiredCount));
  if (Number.isFinite(value.sessionCookieCount)) out.sessionCookieCount = Math.max(0, Math.floor(value.sessionCookieCount));
  if (typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/i.test(value.fingerprint)) out.fingerprint = value.fingerprint.toLowerCase();
  const analyzedAt = normalizeIsoTimestamp(value.analyzedAt);
  if (analyzedAt) out.analyzedAt = analyzedAt;
  return Object.keys(out).length ? out : null;
}

function normalizeNetworkIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const out = {};
  if (typeof value.proxyConfigured === "boolean") out.proxyConfigured = value.proxyConfigured;
  for (const key of ["proxyType", "proxyHostFingerprint", "proxyCountry", "expectedCountry", "proxyProvider", "networkContinuityState"]) {
    if (typeof value[key] === "string" && value[key].length <= 120) out[key] = value[key];
  }
  if (Number.isFinite(value.proxyPort)) out.proxyPort = Math.floor(value.proxyPort);
  return Object.keys(out).length ? out : null;
}

function normalizeAccount(item) {
  const account = { id: item.id, name: item.name };
  const personaProfileId = normalizePersonaProfileId(item.personaProfileId);
  if (personaProfileId) account.personaProfileId = personaProfileId;
  // Set only for accounts created by the bulk importer (src/importers/) -
  // lets it detect "this supplier record was already imported" without
  // guessing from the account name/id, which addAccount() may have
  // suffixed (-2, -3, ...) to stay unique.
  const importPlatform = normalizeSourceField(item.importPlatform);
  const importUsername = normalizeSourceField(item.importUsername);
  if (importPlatform) account.importPlatform = importPlatform;
  if (importUsername) account.importUsername = importUsername;
  const importedAt = normalizeIsoTimestamp(item.importedAt);
  if (importedAt) account.importedAt = importedAt;
  const supplierFormat = normalizeSourceField(item.supplierFormat);
  if (supplierFormat) account.supplierFormat = supplierFormat;
  const supplierBatchId = normalizeSourceField(item.supplierBatchId);
  if (supplierBatchId) account.supplierBatchId = supplierBatchId;
  const sessionSource = normalizeSourceField(item.sessionSource);
  if (sessionSource) account.sessionSource = sessionSource;
  const sessionIntegrity = normalizeCookieIntegrity(item.sessionIntegrity || item.cookieIntegrity);
  if (sessionIntegrity) account.sessionIntegrity = sessionIntegrity;
  const networkIdentity = normalizeNetworkIdentity(item.networkIdentity);
  if (networkIdentity) account.networkIdentity = networkIdentity;

  // Safe, non-secret operational status - last known verified social
  // session health and last publish outcome. Set by session-check.js
  // (manual "Check session", and reused by the import/Update Session
  // pipeline and the publish precondition check) and tiktok-publish.js.
  // Never a cookie/password/token - see normalizeSafeText above.
  const sessionStatus = normalizeEnum(item.sessionStatus, SESSION_STATUS_VALUES);
  if (sessionStatus) account.sessionStatus = sessionStatus;
  const sessionCheckedAt = normalizeIsoTimestamp(item.sessionCheckedAt);
  if (sessionCheckedAt) account.sessionCheckedAt = sessionCheckedAt;
  const sessionReason = normalizeSafeText(item.sessionReason);
  if (sessionReason) account.sessionReason = sessionReason;
  // Granular Session Recovery Pipeline record - see SESSION_STATE_VALUES
  // above. Additive to sessionStatus, never a replacement for it: every
  // consumer that only knows the five coarse values keeps working
  // unchanged.
  const sessionState = normalizeEnum(item.sessionState, SESSION_STATE_VALUES);
  if (sessionState) account.sessionState = sessionState;
  const sessionRecoveryAttempts = normalizeRecoveryAttempts(item.sessionRecoveryAttempts);
  if (sessionRecoveryAttempts) account.sessionRecoveryAttempts = sessionRecoveryAttempts;
  const firstVerifiedAt = normalizeIsoTimestamp(item.firstVerifiedAt);
  if (firstVerifiedAt) account.firstVerifiedAt = firstVerifiedAt;
  const firstSessionStatus = normalizeEnum(item.firstSessionStatus, SESSION_STATUS_VALUES);
  if (firstSessionStatus) account.firstSessionStatus = firstSessionStatus;
  const lastReadyAt = normalizeIsoTimestamp(item.lastReadyAt);
  if (lastReadyAt) account.lastReadyAt = lastReadyAt;
  const healthState = normalizeSafeText(item.healthState, 40);
  if (healthState) account.healthState = healthState;
  const failureClass = normalizeSafeText(item.failureClass, 80);
  if (failureClass) account.failureClass = failureClass;
  const quarantineReason = normalizeSafeText(item.quarantineReason);
  if (quarantineReason) account.quarantineReason = quarantineReason;
  const quarantinedAt = normalizeIsoTimestamp(item.quarantinedAt);
  if (quarantinedAt) account.quarantinedAt = quarantinedAt;
  if (Number.isFinite(item.failureCount) && item.failureCount >= 0) account.failureCount = Math.floor(item.failureCount);

  const lastPublishStatus = normalizeEnum(item.lastPublishStatus, PUBLISH_STATUS_VALUES);
  if (lastPublishStatus) account.lastPublishStatus = lastPublishStatus;
  const lastPublishAt = normalizeIsoTimestamp(item.lastPublishAt);
  if (lastPublishAt) account.lastPublishAt = lastPublishAt;
  const lastPublishError = normalizeSafeText(item.lastPublishError);
  if (lastPublishError) account.lastPublishError = lastPublishError;

  return account;
}

function normalizeState(raw) {
  const accounts = Array.isArray(raw?.accounts)
    ? raw.accounts
      .filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
      .map(normalizeAccount)
    : [];
  if (!accounts.length) {
    accounts.push({ ...DEFAULT_ACCOUNT });
  }

  const activeExists = accounts.some((item) => item.id === raw?.activeAccountId);
  const activeAccountId = activeExists ? raw.activeAccountId : accounts[0].id;
  return { accounts, activeAccountId };
}

function sanitizeName(name) {
  return (name || "").toString().trim().replace(/\s+/g, " ").slice(0, 60);
}

function makeId(name) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "account";
}

function ensureUniqueId(baseId, existing) {
  if (!existing.has(baseId)) return baseId;
  let index = 2;
  while (existing.has(`${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

// Serializes every actual disk write behind a FIFO queue. The JSON payload
// is captured synchronously here, at call time - before this function's
// first await - so it always reflects the exact in-memory state at the
// moment saveState() was invoked (JS's single-threaded execution means no
// other mutation can interleave before that point). Chaining the write
// itself onto the queue (rather than firing fs.writeFile calls
// independently) guarantees they land on disk in the same order they were
// requested, so the LAST call - always the most up to date, since callers
// mutate `state` before calling saveState() - is also the last to actually
// write, and never gets silently clobbered by an earlier, staler write
// finishing after it. Needed because the bulk importer (src/importers/
// pipeline.js) calls addAccount/setPersonaProfileId from several concurrent
// workers, which single-request dashboard routes never did before.
let writeQueue = Promise.resolve();

async function saveState() {
  const payload = JSON.stringify(state, null, 2);
  const write = writeQueue.then(() => fs.writeFile(STATE_FILE, payload, "utf8"));
  // Keep the queue alive even if this particular write fails, and never let
  // an earlier failure poison every write after it.
  writeQueue = write.catch(() => {});
  return write;
}

async function ensureLoaded() {
  if (loaded) return;
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    state = normalizeState(JSON.parse(raw));
  } catch {
    state = normalizeState(state);
    await saveState();
  }
  loaded = true;
}

async function getState() {
  await ensureLoaded();
  return clone(state);
}

// Queue directory helpers

// Keep the account/profile namespace future-proof for browser-managed
// identities. A platform being listed here only creates isolated state
// directories; it does not claim that publishing is implemented.
const PLATFORMS = ["tiktok", "instagram", "threads", "youtube", "x"];
const SUBDIRS = ["pending", "posted", "failed"];

function getAccountQueueDirs(accountId) {
  const base = path.resolve(config.projectRoot, "queue", accountId);
  const dirs = {};
  for (const platform of PLATFORMS) {
    dirs[platform] = {};
    for (const sub of SUBDIRS) {
      dirs[platform][sub] = path.resolve(base, platform, sub);
    }
  }
  return dirs;
}

async function ensureAccountDirs(accountId) {
  const dirs = getAccountQueueDirs(accountId);
  const allPaths = [];
  for (const platform of PLATFORMS) {
    for (const sub of SUBDIRS) {
      allPaths.push(dirs[platform][sub]);
    }
  }
  // Also ensure browser profile dirs
  const profileBase = path.resolve(config.projectRoot, ".profiles", accountId);
  for (const platform of PLATFORMS) {
    allPaths.push(path.resolve(profileBase, platform));
  }
  await Promise.all(allPaths.map((d) => fs.mkdir(d, { recursive: true })));
  return dirs;
}

// Account CRUD

async function addAccount(name, extra = {}) {
  await ensureLoaded();
  const cleanName = sanitizeName(name);
  if (!cleanName) {
    throw new Error("Account name is required.");
  }

  const existingIds = new Set(state.accounts.map((item) => item.id));
  const id = ensureUniqueId(makeId(cleanName), existingIds);
  const account = { id, name: cleanName };
  const importPlatform = normalizeSourceField(extra.importPlatform);
  const importUsername = normalizeSourceField(extra.importUsername);
  if (importPlatform) account.importPlatform = importPlatform;
  if (importUsername) account.importUsername = importUsername;
  for (const field of ["importedAt", "supplierFormat", "supplierBatchId", "sessionSource"]) {
    const value = normalizeSourceField(extra[field]);
    if (value) account[field] = value;
  }
  const sessionIntegrity = normalizeCookieIntegrity(extra.sessionIntegrity || extra.cookieIntegrity);
  if (sessionIntegrity) account.sessionIntegrity = sessionIntegrity;
  const networkIdentity = normalizeNetworkIdentity(extra.networkIdentity);
  if (networkIdentity) account.networkIdentity = networkIdentity;
  state.accounts.push(account);
  state.activeAccountId = account.id;
  await saveState();

  // Create queue and profile directories for the new account
  await ensureAccountDirs(id);

  return clone(account);
}

// Real rollback primitive for the bulk importer (src/importers/pipeline.js):
// removes an account this process just created after a later pipeline step
// failed (e.g. Persona profile creation failed after the AutoSocial account
// was already added), so a partial import never leaves an orphan account
// behind. Deliberately does NOT touch queue/profile directories on disk -
// same conservative "never silently delete user files" stance as the rest
// of this module; an empty leftover directory is harmless.
async function removeAccount(accountId) {
  await ensureLoaded();
  const index = state.accounts.findIndex((item) => item.id === accountId);
  if (index === -1) return false;
  if (state.accounts.length === 1) {
    throw new Error("Cannot remove the last remaining account.");
  }
  state.accounts.splice(index, 1);
  if (state.activeAccountId === accountId) {
    state.activeAccountId = state.accounts[0].id;
  }
  await saveState();
  return true;
}

// Duplicate-import detection: does an account already exist for this exact
// supplier (platform, username) pair? Used by the import pipeline so
// re-uploading the same supplier file is a safe no-op per record instead of
// creating a second AutoSocial account for the same real identity.
async function findAccountByImportSource(platform, username) {
  await ensureLoaded();
  const p = normalizeSourceField(platform);
  const u = normalizeSourceField(username);
  if (!p || !u) return null;
  const match = state.accounts.find(
    (item) =>
      normalizeSourceField(item.importPlatform)?.toLowerCase() === p.toLowerCase() &&
      normalizeSourceField(item.importUsername)?.toLowerCase() === u.toLowerCase()
  );
  return match ? clone(match) : null;
}

async function selectAccount(accountId) {
  await ensureLoaded();
  const target = state.accounts.find((item) => item.id === accountId);
  if (!target) {
    throw new Error("Account not found.");
  }
  state.activeAccountId = target.id;
  await saveState();
  return clone(target);
}

async function getActiveAccount() {
  await ensureLoaded();
  return clone(
    state.accounts.find((item) => item.id === state.activeAccountId) || state.accounts[0]
  );
}

async function getAllAccounts() {
  await ensureLoaded();
  return clone(state.accounts);
}

async function getAccountById(accountId) {
  await ensureLoaded();
  const target = state.accounts.find((item) => item.id === accountId);
  return target ? clone(target) : null;
}

// --- Persona profile mapping -----------------------------------------
//
// An account may optionally be linked to a Persona Studio browser profile
// (see src/persona-browser.js, src/browser-session.js). The mapping is
// just a plain field on the account record - never hardcoded, never
// assumed; callers must read it per-account.

async function setPersonaProfileId(accountId, profileId) {
  await ensureLoaded();
  const target = state.accounts.find((item) => item.id === accountId);
  if (!target) {
    throw new Error("Account not found.");
  }
  const normalized = normalizePersonaProfileId(profileId);
  if (!normalized) {
    throw new Error("Persona profile id is required.");
  }
  // One Persona profile must never drive two different AutoSocial accounts
  // at once - two accounts sharing a mapping would mean two independent
  // upload/login flows racing to attach and drive the same real browser
  // tab (see persona-browser.js's per-profile checkout guard, which
  // protects one process's concurrent calls but can't protect against two
  // ACCOUNTS being configured to point at the same identity in the first
  // place).
  const conflict = state.accounts.find(
    (item) => item.id !== accountId && item.personaProfileId === normalized
  );
  if (conflict) {
    throw new Error(
      `Persona profile ${normalized} is already linked to account "${conflict.name}" (${conflict.id}). ` +
      `Clear that mapping first if you want to move it.`
    );
  }
  target.personaProfileId = normalized;
  await saveState();
  return clone(target);
}

async function getPersonaProfileId(accountId) {
  const account = await getAccountById(accountId);
  return account?.personaProfileId || null;
}

async function clearPersonaProfileId(accountId) {
  await ensureLoaded();
  const target = state.accounts.find((item) => item.id === accountId);
  if (!target) {
    throw new Error("Account not found.");
  }
  delete target.personaProfileId;
  await saveState();
  return clone(target);
}

// --- Session / publish status -----------------------------------------
//
// Safe, non-secret operational history: the last verified social-session
// health and the last publish attempt's outcome. Never a cookie/password/
// token - see normalizeSafeText's contract above; callers must already
// have sanitized any free text before calling these.

async function setSessionStatus(accountId, { status, reason, checkedAt, state: sessionState, attempts } = {}) {
  await ensureLoaded();
  const target = state.accounts.find((item) => item.id === accountId);
  if (!target) {
    throw new Error("Account not found.");
  }
  if (!SESSION_STATUS_VALUES.has(status)) {
    throw new Error(`Invalid session status: ${status}`);
  }
  target.sessionStatus = status;
  target.sessionCheckedAt = normalizeIsoTimestamp(checkedAt) || new Date().toISOString();
  const safeReason = normalizeSafeText(reason);
  if (safeReason) target.sessionReason = safeReason;
  else delete target.sessionReason;
  // Optional, additive granular Session Recovery Pipeline record - see
  // SESSION_STATE_VALUES above. A caller that omits these (every pre-
  // existing caller: TikTok's verify path, manual Check Session before this
  // milestone) leaves them exactly as they were, never clearing a
  // previously-recorded one just because this particular call didn't have
  // it.
  const normalizedState = normalizeEnum(sessionState, SESSION_STATE_VALUES);
  if (normalizedState) target.sessionState = normalizedState;
  const normalizedAttempts = normalizeRecoveryAttempts(attempts);
  if (normalizedAttempts) target.sessionRecoveryAttempts = normalizedAttempts;
  const checked = target.sessionCheckedAt;
  if (!target.firstVerifiedAt) {
    target.firstVerifiedAt = checked;
    target.firstSessionStatus = status;
  }
  if (status === "ready") {
    target.lastReadyAt = checked;
    target.healthState = "READY";
    delete target.failureClass;
    delete target.quarantineReason;
    delete target.quarantinedAt;
  } else {
    target.failureCount = (Number.isFinite(target.failureCount) ? target.failureCount : 0) + 1;
    if (status === "challenge_required" || sessionState === "ACCOUNT_SUSPENDED") {
      target.healthState = "QUARANTINED";
      target.failureClass = sessionState || "CHALLENGE_REQUIRED";
      target.quarantineReason = safeReason || "Account requires operator review before use.";
      target.quarantinedAt = target.quarantinedAt || checked;
    } else if (status === "needs_login") {
      target.healthState = "LOGIN_REQUIRED";
      target.failureClass = sessionState || "LOGIN_REQUIRED";
    } else {
      target.healthState = "UNKNOWN";
      target.failureClass = sessionState || status.toUpperCase();
    }
  }
  await saveState();
  return clone(target);
}

async function setPublishStatus(accountId, { status, reason, at } = {}) {
  await ensureLoaded();
  const target = state.accounts.find((item) => item.id === accountId);
  if (!target) {
    throw new Error("Account not found.");
  }
  if (!PUBLISH_STATUS_VALUES.has(status)) {
    throw new Error(`Invalid publish status: ${status}`);
  }
  target.lastPublishStatus = status;
  target.lastPublishAt = normalizeIsoTimestamp(at) || new Date().toISOString();
  const safeReason = normalizeSafeText(reason);
  if (safeReason) target.lastPublishError = safeReason;
  else delete target.lastPublishError;
  await saveState();
  return clone(target);
}

async function getPlatformProfileDir(platform, accountId) {
  const acctId = accountId || (await getActiveAccount()).id;
  if (acctId === DEFAULT_ACCOUNT.id && LEGACY_PROFILE_DIRS[platform]) {
    try {
      await fs.stat(LEGACY_PROFILE_DIRS[platform]);
      return LEGACY_PROFILE_DIRS[platform];
    } catch {
      // Fall through to new path
    }
  }
  return path.resolve(config.projectRoot, ".profiles", acctId, platform);
}

async function hasSavedPlatformSession(platform, accountId) {
  const account = accountId
    ? await getAccountById(accountId)
    : await getActiveAccount();

  // Persona is the source of truth once an account is linked - AutoSocial's
  // own .profiles Cookies DB is irrelevant for these accounts (it was never
  // written to; Persona owns the real browser data). A transient Persona
  // API outage fails OPEN (treated as saved) rather than falsely implying
  // the operator needs to redo the account link - only a confirmed-absent
  // profile (Persona reachable, id genuinely not found) reports false.
  if (account?.personaProfileId) {
    // Lazy require avoids pulling in playwright (persona-browser.js's own
    // top-level dependency) for every account-manager.js consumer that
    // never touches a Persona-linked account.
    const { personaProfileExists } = require("./persona-browser");
    try {
      return await personaProfileExists(account.personaProfileId);
    } catch {
      // Persona API unreachable - fail OPEN (see comment above).
      return true;
    }
  }

  const profileDir = await getPlatformProfileDir(platform, accountId);
  const cookieCandidates = [
    path.resolve(profileDir, "Default", "Cookies"),
    path.resolve(profileDir, "Cookies"),
    path.resolve(profileDir, "Network", "Cookies"),
  ];

  for (const filePath of cookieCandidates) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size > 0) {
        return true;
      }
    } catch {
      // continue
    }
  }

  return false;
}

module.exports = {
  getState,
  addAccount,
  removeAccount,
  findAccountByImportSource,
  selectAccount,
  getActiveAccount,
  getAllAccounts,
  getAccountById,
  getAccountQueueDirs,
  ensureAccountDirs,
  getPlatformProfileDir,
  hasSavedPlatformSession,
  setPersonaProfileId,
  getPersonaProfileId,
  clearPersonaProfileId,
  setSessionStatus,
  setPublishStatus,
  PLATFORMS,
};
