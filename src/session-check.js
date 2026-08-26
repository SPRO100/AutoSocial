// Real, on-demand social-session health check for a single account - the
// backing implementation for the Dashboard's "Check session" action, and
// reused as the fresh, server-side precondition check immediately before a
// real publish (see tiktok-publish.js). Sibling to account-deletion.js:
// combines account-manager.js and persona-browser.js for one specific
// lifecycle operation.
//
// Reuses the EXACT SAME verifier the import/Update Session pipeline uses
// (importers/tiktok-verify.js#verifyTikTokSession) - there is only ever
// one verifier per platform in this codebase, never a second one.
//
// Persona-lifecycle contract: if the profile was already running before
// this check, it is left running afterward. If it was stopped, it is
// stopped again afterward - a manual "Check session" (or an automatic
// pre-publish check) must never be the reason a profile is left running
// that the operator had deliberately stopped.
//
// Concurrency contract: this snapshot-then-restore logic is only correct
// if no OTHER operation on the same account's Persona profile can run
// concurrently - two overlapping checks (or a check overlapping a publish)
// would otherwise race each other's "was it running before?" read and one
// caller can stop a profile the other is still actively using. checkSession()
// therefore acquires account-lock.js's per-account lock for its whole
// duration; publish() (tiktok-publish.js) acquires the SAME lock for its
// whole duration (verification + upload) and calls checkSessionUnlocked()
// directly rather than re-entering checkSession(), since it already holds
// the lock.
const accountManager = require("./account-manager");
const persona = require("./persona-browser");
const accountLock = require("./account-lock");
const { recoverSession, mapToSessionStatus } = require("./session-recovery");

const VERIFIERS = {
  tiktok: require("./importers/tiktok-verify").verifyTikTokSession,
  instagram: require("./importers/instagram-verify").verifyInstagramSession,
  youtube: require("./importers/youtube-verify").verifyYouTubeSession,
  threads: require("./importers/threads-verify").verifyThreadsSession,
  x: require("./importers/x-verify").verifyXSession,
};

// Same Session Recovery Pipeline the import pipeline uses (see
// importers/pipeline.js) - a manual "Check session" click gets the exact
// same bounded, fail-closed auto-recovery benefit as a fresh import, never
// a second/divergent implementation. Only Instagram currently has one.
const RECOVERERS = {
  instagram: require("./importers/instagram-recovery"),
};

function safeMessage(error) {
  return error && error.message ? error.message : String(error);
}

// The page's own URL is never a secret (no query/hash tokens are ever
// appended by any of these platforms' real navigation flows this codebase
// drives) - safe to log as-is for diagnosing exactly which real page a
// session check/publish landed on.
function safeFinalUrl(page) {
  try {
    return typeof page.url === "function" ? page.url() : "unknown";
  } catch {
    return "unknown";
  }
}

// tiktok-verify.js's own reason strings are a small fixed vocabulary except
// for its one exception-path fallback ("verification failed: <raw error>"),
// which can embed a raw Playwright/navigation error message. sessionReason
// is now a persistent, always-visible Dashboard field (not just a one-time
// import report line), so that one case gets rewritten to a safe, generic
// message - every other reason here is already a fixed, safe string.
function safeVerifyReason(reason) {
  if (typeof reason === "string" && /^verification failed:/i.test(reason)) {
    return "Could not verify the session (a technical error occurred).";
  }
  return reason;
}

// Core logic, no locking. Only two callers: checkSession() below (which
// wraps this with the per-account lock) and tiktok-publish.js#publish
// (which already holds that same lock for its own, longer duration and
// must not try to re-acquire it).
async function checkSessionUnlocked(accountId, requestedPlatform) {
  const account = await accountManager.getAccountById(accountId);
  if (!account) {
    return { ok: false, error: "Account not found." };
  }
  const profileId = account.personaProfileId || null;
  if (!profileId) {
    return { ok: false, error: "This account has no linked Persona profile." };
  }
  const platform = requestedPlatform || account.importPlatform;
  const verify = VERIFIERS[platform];
  if (!verify) {
    return { ok: false, error: `Session verification is not supported for platform "${platform || "unknown"}".` };
  }

  // Real current Persona status, read BEFORE attaching - this is what
  // "restore the original state afterward" is measured against.
  let wasRunning = false;
  try {
    const profiles = await persona.listPersonaProfiles();
    const live = profiles.find((p) => p.id === profileId);
    if (!live) {
      return { ok: false, error: "Persona profile not found." };
    }
    wasRunning = live.status === "running";
  } catch (error) {
    return { ok: false, error: `Could not reach Persona: ${safeMessage(error)}` };
  }

  let session = null;
  let sessionStatus = "unknown";
  let reason = null;
  let sessionState = null;
  let recoveryAttempts = null;
  try {
    session = await persona.attachPersonaProfile(profileId, { headless: true });
    // Bind the check to the real imported identity when the verifier
    // supports it (currently Instagram) - never lets a session that's
    // authenticated as a DIFFERENT account read as Ready for this one.
    // Verifiers that don't accept a second argument (TikTok, YouTube, ...)
    // simply ignore it. Recovery (see ../session-recovery.js) only ever
    // acts on a SAFE, recognized state - every security/policy-sensitive
    // outcome is returned exactly as the verifier classified it.
    const recover = RECOVERERS[platform];
    const outcome = await recoverSession({
      verify,
      recover,
      page: session.page,
      username: account.name || null,
      account: accountId,
      platform,
      personaProfileId: profileId,
    });
    sessionStatus = mapToSessionStatus(outcome);
    reason = outcome.active ? null : safeVerifyReason(outcome.reason);
    sessionState = outcome.state || null;
    recoveryAttempts = outcome.attempts || null;
    // Safe diagnostic observability: account/platform/decision/reason and
    // the real final URL the verifier landed on - never a cookie, token, or
    // password value (none of those ever reach this module in the first
    // place; session.page only exposes navigation state).
    console.log(
      `[session-check] account=${accountId} platform=${platform} status=${sessionStatus} state=${sessionState || "n/a"} ` +
      `finalUrl=${safeFinalUrl(session.page)} reason=${JSON.stringify(reason || outcome.reason || null)}`
    );
  } catch (error) {
    sessionStatus = "error";
    reason = "Could not verify the session (Persona attach failed).";
    console.warn(`[session-check] account=${accountId} platform=${platform} status=error reason=${safeMessage(error)}`);
  } finally {
    if (session) {
      await persona.disconnectPersonaBrowser(session).catch(() => {});
    }
    if (!wasRunning) {
      // It was stopped before this check - keep it stopped. If it was
      // already running, leave it exactly as it was (nothing to do here).
      await persona.stopPersonaProfile(profileId).catch(() => {});
    }
  }

  const checkedAt = new Date().toISOString();
  await accountManager.setSessionStatus(accountId, { status: sessionStatus, reason, checkedAt, state: sessionState, attempts: recoveryAttempts });

  return { ok: true, accountId, personaProfileId: profileId, sessionStatus, reason, checkedAt, sessionState };
}

// Returns { ok, accountId, personaProfileId, sessionStatus, reason,
// checkedAt } on a completed check (sessionStatus is always persisted to
// the account record when ok:true), or { ok:false, error } when the check
// itself could not be performed at all (no account, no linked profile, no
// verifier for this platform, Persona unreachable, or another check/publish
// for this same account is already in progress).
async function checkSession(accountId, requestedPlatform) {
  if (!accountLock.tryLock(accountId)) {
    return { ok: false, error: "This account is busy with another session check or publish. Try again shortly." };
  }
  try {
    return await checkSessionUnlocked(accountId, requestedPlatform);
  } finally {
    accountLock.unlock(accountId);
  }
}

module.exports = { checkSession, checkSessionUnlocked };
