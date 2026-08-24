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

const SESSION_STATUS_VALUES = new Set(["ready", "needs_login", "unknown", "error"]);
const PUBLISH_STATUS_VALUES = new Set(["published", "failed", "unconfirmed"]);

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

async function setSessionStatus(accountId, { status, reason, checkedAt } = {}) {
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
