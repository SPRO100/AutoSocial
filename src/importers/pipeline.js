// Bulk account-import pipeline.
//
// Consumes normalized records (see normalize.js) already produced by a
// supplier adapter - this module knows nothing about supplier file formats.
// For each record: create AutoSocial account -> create dedicated Persona
// profile -> link -> import cookies -> attach headless -> verify the real
// platform session -> disconnect -> stop -> safe per-account result.
//
// Rollback boundary (deliberate): a failure while the record's AutoSocial
// account / Persona profile / cookie import are still being assembled
// leaves nothing of independent value, so it is rolled back (account
// removed, orphan Persona profile deleted) rather than left as a silent
// orphan. Once cookies are successfully imported into a properly linked
// profile, that is a genuinely useful, retryable artifact - a later
// verification failure (or Persona being briefly unreachable) reports
// NEEDS_LOGIN/FAILED but does NOT destroy it, so a human (or a re-run) can
// retry verification without redoing account/profile creation.
const accountManager = require("../account-manager");
const persona = require("../persona-browser");
const { toSafePreview, duplicateKey } = require("./normalize");
const { toPersonaCookiePayload } = require("./cookie-adapter");

const DEFAULT_CONCURRENCY = 2;
// A hard ceiling regardless of what a caller requests - importBatch is
// reachable directly via POST /api/import/confirm, and each unit of
// concurrency is a real headless Chromium process via Persona, not just a
// cheap async task. The Dashboard UI only ever offers up to 8; this is the
// server-side backstop for any other caller.
const MAX_CONCURRENCY = 8;

// Process-wide (not just per-batch) claim on a (platform, username) key
// while it is actively being imported. Reserved synchronously - before any
// await - the same pattern as persona-browser.js's checkedOutProfiles, so
// two calls can never both observe a key as unclaimed. This closes TWO
// distinct races: two records for the same identity within one batch
// (concurrent workers), AND two overlapping importBatch() calls entirely
// (e.g. the same file confirmed twice from two browser tabs, or a
// double-submitted request) - accountManager's own findAccountByImportSource
// check has no lock of its own and would otherwise let both requests pass
// it before either had actually created an account. Released once
// processRecord settles for that key, so a later, genuinely separate import
// is never blocked by a finished one.
const activeImportKeys = new Set();

const VERIFIERS = {
  tiktok: require("./tiktok-verify").verifyTikTokSession,
};

async function buildPreview(records) {
  const seen = new Set();
  const preview = [];
  for (const record of records) {
    const safe = toSafePreview(record);
    const key = duplicateKey(record);
    let duplicateInBatch = false;
    if (key) {
      duplicateInBatch = seen.has(key);
      seen.add(key);
    }
    let alreadyImported = false;
    let existingAccountId = null;
    let existingPersonaProfileId = null;
    if (record.platform && record.username) {
      const match = await accountManager.findAccountByImportSource(record.platform, record.username);
      if (match) {
        alreadyImported = true;
        existingAccountId = match.id;
        existingPersonaProfileId = match.personaProfileId || null;
      }
    }
    // Fail-closed, by construction: "Update session" is only ever offered
    // when there is an unambiguous existing account (findAccountByImportSource
    // returns at most one match) AND it already has a linked Persona
    // profile. No mapping, or an account with no linked profile, means no
    // update option - never guessed, never auto-created.
    const canUpdateSession = alreadyImported && Boolean(existingPersonaProfileId);
    preview.push({
      ...safe,
      key,
      duplicateInBatch,
      alreadyImported,
      existingAccountId,
      existingPersonaProfileId,
      canUpdateSession,
    });
  }
  return preview;
}

function safeMessage(error) {
  // PersonaApiError/Error messages in this codebase are already written to
  // be human-safe (see persona-browser.js) - never include raw record
  // fields (password/cookies) in a result, only these caught messages.
  return error && error.message ? error.message : String(error);
}

// Persists the verify step's outcome onto the account record - the same
// safe, non-secret session-status history session-check.js's manual "Check
// session" writes, so Dashboard status reflects the LATEST verification
// regardless of which flow (new import, Update Session, or a manual check)
// produced it. Best-effort: a failure to persist status must never fail
// the import/update itself, which has already completed by this point.
async function persistSessionStatus(accountId, pipelineStatus, reason) {
  const map = { READY: "ready", NEEDS_LOGIN: "needs_login", FAILED: "error" };
  const status = map[pipelineStatus];
  if (!status || !accountId) return;
  await accountManager.setSessionStatus(accountId, { status, reason }).catch(() => {});
}

async function rollback({ accountId, profileId }) {
  if (profileId) {
    await persona.deletePersonaProfile(profileId).catch(() => {});
  }
  if (accountId) {
    await accountManager.removeAccount(accountId).catch(() => {});
  }
}

// Update Session: an existing account's already-linked Persona profile
// gets a fresh cookie import from a re-uploaded supplier file, instead of
// creating anything new. Never calls addAccount() or createPersonaProfile()
// - the account and profile must already exist and already be linked
// (callers only reach this after that exact check - see processRecord
// below and buildPreview's canUpdateSession). A failure here leaves the
// existing account/profile exactly as they were; there is nothing to roll
// back because nothing new was created.
async function updateExistingAccountSession(existingAccount, record) {
  const base = { platform: record.platform, username: record.username };
  const accountId = existingAccount.id;
  const profileId = existingAccount.personaProfileId;

  // Fail-closed - buildPreview already gates this, but processRecord's own
  // caller re-checks defensively rather than trusting a client-supplied key
  // blindly matched an offer that was actually valid.
  if (!profileId) {
    return {
      ...base,
      accountId,
      autosocial: "Existing",
      persona: "Missing",
      cookies: "Skipped",
      session: "Skipped",
      status: "FAILED",
      reason: "this account has no linked Persona profile - cannot update its session",
    };
  }

  // Cookie import requires the profile to not be running.
  await persona.stopPersonaProfile(profileId).catch(() => {});

  // clear:true (a real replace, not a merge - Persona's own /cookies
  // endpoint adds/overwrites by (name, domain, path) but never removes a
  // cookie it wasn't given, confirmed empirically before writing this) is
  // only safe on a profile this pipeline itself knows to be single-purpose
  // - i.e. one it created via processRecord's own createPersonaProfile
  // call below, tagged "autosocial-import". An account can be relinked to
  // an arbitrary, possibly shared/multi-purpose Persona profile through
  // the existing manual link UI (POST /api/accounts/persona), which has no
  // such guarantee - wiping THAT profile's whole cookie jar could destroy
  // unrelated domains/sessions it holds. Checked here, against Persona's
  // real current tags for this exact profile id, rather than trusted from
  // the account record - independent reviewer finding, fixed before commit.
  let allowFullReplace = false;
  try {
    const profiles = await persona.listPersonaProfiles();
    const liveProfile = profiles.find((p) => p.id === profileId);
    allowFullReplace = Boolean(liveProfile?.tags?.includes("autosocial-import"));
  } catch {
    // Persona API hiccup reading tags - fail closed to the non-destructive
    // merge path below rather than risk an unverified full wipe.
  }

  let cookiesStatus = "Skipped (none provided)";
  if (record.cookies) {
    const payload = toPersonaCookiePayload(record.cookies, record.platform);
    if (!payload) {
      return {
        ...base,
        accountId,
        personaProfileId: profileId,
        autosocial: "Existing",
        persona: "Existing",
        cookies: "Failed",
        session: "Skipped",
        status: "FAILED",
        reason: "the supplied cookie data could not be parsed into a usable format",
      };
    }
    try {
      await persona.importPersonaCookies(profileId, { ...payload, clear: allowFullReplace });
      cookiesStatus = allowFullReplace
        ? "Imported"
        : "Imported (merged - profile was not created by this pipeline, so its other cookies were left alone)";
    } catch (error) {
      return {
        ...base,
        accountId,
        personaProfileId: profileId,
        autosocial: "Existing",
        persona: "Existing",
        cookies: "Failed",
        session: "Skipped",
        status: "FAILED",
        reason: safeMessage(error),
      };
    }
  }

  const verify = VERIFIERS[record.platform];
  let sessionLabel = "Skipped (verification not implemented for this platform)";
  let status = "FAILED";
  let reason = verify ? null : `no session verifier is implemented for platform "${record.platform}"`;

  if (verify) {
    let session = null;
    try {
      session = await persona.attachPersonaProfile(profileId, { headless: true });
      const result = await verify(session.page);
      sessionLabel = result.active ? "Active" : "Invalid";
      status = result.active ? "READY" : "NEEDS_LOGIN";
      reason = result.active ? null : result.reason;
    } catch (error) {
      sessionLabel = "Unknown";
      status = "FAILED";
      reason = safeMessage(error);
    } finally {
      if (session) {
        await persona.disconnectPersonaBrowser(session).catch(() => {});
      }
      await persona.stopPersonaProfile(profileId).catch(() => {});
    }
    await persistSessionStatus(accountId, status, reason);
  }

  return {
    ...base,
    accountId,
    personaProfileId: profileId,
    autosocial: "Existing",
    persona: "Existing",
    cookies: cookiesStatus,
    session: sessionLabel,
    status,
    reason,
  };
}

async function processRecord(record, updateSessionKeys) {
  const base = { platform: record.platform, username: record.username };

  if (record.platform && record.username) {
    const existing = await accountManager.findAccountByImportSource(record.platform, record.username);
    if (existing) {
      const key = duplicateKey(record);
      if (updateSessionKeys && key && updateSessionKeys.has(key) && existing.personaProfileId) {
        return updateExistingAccountSession(existing, record);
      }
      return {
        ...base,
        accountId: existing.id,
        personaProfileId: existing.personaProfileId || null,
        autosocial: "Existing",
        persona: existing.personaProfileId ? "Existing" : "Missing",
        cookies: "Skipped (already imported)",
        session: "Skipped (already imported)",
        status: "SKIPPED_DUPLICATE",
        reason: "an account for this platform/username was already imported",
      };
    }
  }

  let accountId = null;
  let profileId = null;

  // 1. AutoSocial account
  try {
    const account = await accountManager.addAccount(record.username, {
      importPlatform: record.platform,
      importUsername: record.username,
    });
    accountId = account.id;
  } catch (error) {
    return {
      ...base,
      autosocial: "Failed",
      persona: "Skipped",
      cookies: "Skipped",
      session: "Skipped",
      status: "FAILED",
      reason: safeMessage(error),
    };
  }

  // 2. Dedicated Persona profile
  const profileName = `autosocial-${record.platform}-${record.username}`;
  try {
    const profile = await persona.createPersonaProfile({
      name: profileName,
      tags: ["autosocial-import", record.platform],
    });
    profileId = profile.id;
  } catch (error) {
    // The HTTP response can be lost (timeout/abort) after Persona has
    // already persisted the profile, in which case profileId above is
    // never learned and the normal rollback below can't delete it by id.
    // Best-effort self-heal: this exact name is deterministic per
    // (platform, username) and namespaced with "autosocial-import" - the
    // process-wide claim in importBatch guarantees no other in-flight
    // import can be using it at the same time - so if a real profile with
    // this name now exists, it must be the one this failed call actually
    // created, and it is safe to delete as part of this record's rollback.
    try {
      const profiles = await persona.listPersonaProfiles();
      const orphan = profiles.find((p) => p.name === profileName);
      if (orphan) await persona.deletePersonaProfile(orphan.id).catch(() => {});
    } catch {
      // Persona API itself may be unreachable here too - nothing more to
      // do; the account rollback below still runs regardless.
    }
    await rollback({ accountId });
    return {
      ...base,
      accountId,
      autosocial: "Rolled back",
      persona: "Failed",
      cookies: "Skipped",
      session: "Skipped",
      status: "FAILED",
      reason: safeMessage(error),
    };
  }

  // 3. Link
  try {
    await accountManager.setPersonaProfileId(accountId, profileId);
  } catch (error) {
    await rollback({ accountId, profileId });
    return {
      ...base,
      accountId,
      personaProfileId: profileId,
      autosocial: "Rolled back",
      persona: "Rolled back",
      cookies: "Skipped",
      session: "Skipped",
      status: "FAILED",
      reason: safeMessage(error),
    };
  }

  // 4. Cookie import (before the profile is ever attached - Persona
  // requires the profile to not be running for this call).
  let cookiesStatus = "Skipped (none provided)";
  if (record.cookies) {
    const payload = toPersonaCookiePayload(record.cookies, record.platform);
    if (!payload) {
      await rollback({ accountId, profileId });
      return {
        ...base,
        accountId,
        personaProfileId: profileId,
        autosocial: "Rolled back",
        persona: "Rolled back",
        cookies: "Failed",
        session: "Skipped",
        status: "FAILED",
        reason: "the supplied cookie data could not be parsed into a usable format",
      };
    }
    try {
      await persona.importPersonaCookies(profileId, payload);
      cookiesStatus = "Imported";
    } catch (error) {
      await rollback({ accountId, profileId });
      return {
        ...base,
        accountId,
        personaProfileId: profileId,
        autosocial: "Rolled back",
        persona: "Rolled back",
        cookies: "Failed",
        session: "Skipped",
        status: "FAILED",
        reason: safeMessage(error),
      };
    }
  }

  // 5-8. Attach, verify, disconnect, stop. From here on, account/profile/
  // cookies are a coherent, worthwhile artifact - failures no longer roll
  // back (see module comment).
  const verify = VERIFIERS[record.platform];
  let sessionLabel = "Skipped (verification not implemented for this platform)";
  let status = "FAILED";
  let reason = verify ? null : `no session verifier is implemented for platform "${record.platform}"`;

  if (verify) {
    let session = null;
    try {
      session = await persona.attachPersonaProfile(profileId, { headless: true });
      const result = await verify(session.page);
      sessionLabel = result.active ? "Active" : "Invalid";
      status = result.active ? "READY" : "NEEDS_LOGIN";
      reason = result.active ? null : result.reason;
    } catch (error) {
      sessionLabel = "Unknown";
      status = "FAILED";
      reason = safeMessage(error);
    } finally {
      if (session) {
        await persona.disconnectPersonaBrowser(session).catch(() => {});
      }
      await persona.stopPersonaProfile(profileId).catch(() => {});
    }
    await persistSessionStatus(accountId, status, reason);
  }

  return {
    ...base,
    accountId,
    personaProfileId: profileId,
    autosocial: "Created",
    persona: "Created",
    cookies: cookiesStatus,
    session: sessionLabel,
    status,
    reason,
  };
}

function duplicateSkipResult(record, reason) {
  return {
    platform: record.platform,
    username: record.username,
    autosocial: "Skipped",
    persona: "Skipped",
    cookies: "Skipped",
    session: "Skipped",
    status: "SKIPPED_DUPLICATE",
    reason,
  };
}

// Wraps processRecord with the process-wide claim described above - the
// single place both the intra-batch and cross-request duplicate races are
// closed. This also covers Update Session: two concurrent requests for the
// same (platform, username) - whether both are new imports, both are
// update-session calls, or one of each - can never both proceed against
// the same Persona profile at once.
async function claimAndProcess(record, updateSessionKeys) {
  const key = duplicateKey(record);
  if (!key) return processRecord(record, updateSessionKeys);
  if (activeImportKeys.has(key)) {
    return duplicateSkipResult(record, "this platform/username is already being imported or updated by another in-flight request");
  }
  activeImportKeys.add(key);
  try {
    return await processRecord(record, updateSessionKeys);
  } finally {
    activeImportKeys.delete(key);
  }
}

// Bounded-concurrency worker pool - never launches more than `concurrency`
// (clamped to MAX_CONCURRENCY) Persona attach/verify operations (each a
// real Chromium process) at once, and one record's exception never aborts
// the batch.
//
// updateSessionKeys: an explicit, caller-supplied allow-list (duplicateKey
// strings, e.g. "tiktok:someuser") of which already-imported records the
// caller wants to run Update Session for. Anything not in this list stays
// the existing, safe default (SKIPPED_DUPLICATE) - Update Session is never
// applied automatically to every duplicate in a batch.
async function importBatch(records, { concurrency = DEFAULT_CONCURRENCY, updateSessionKeys = [] } = {}) {
  const limit = Math.min(MAX_CONCURRENCY, Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY));
  const updateSet = new Set(Array.isArray(updateSessionKeys) ? updateSessionKeys : []);
  const results = new Array(records.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= records.length) return;
      const record = records[index];
      try {
        results[index] = await claimAndProcess(record, updateSet);
      } catch (error) {
        // processRecord already catches its own known failure points; this
        // is a last-resort net so one unexpected exception can never abort
        // the rest of the batch.
        results[index] = {
          platform: records[index].platform,
          username: records[index].username,
          autosocial: "Unknown",
          persona: "Unknown",
          cookies: "Unknown",
          session: "Unknown",
          status: "FAILED",
          reason: safeMessage(error),
        };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, records.length) }, () => worker());
  await Promise.all(workers);

  const report = {
    total: results.length,
    successful: results.filter((r) => r.status === "READY").length,
    needsLogin: results.filter((r) => r.status === "NEEDS_LOGIN").length,
    failed: results.filter((r) => r.status === "FAILED").length,
    skipped: results.filter((r) => r.status === "SKIPPED_DUPLICATE").length,
    results,
  };
  return report;
}

// Read-only visibility into the same concurrency claim importBatch uses,
// for account-deletion.js: deleting a Persona profile while an import/
// update-session for the very same (platform, username) is mid-flight
// would be a real race (the delete could tear down a profile the other
// operation is actively attached to). Exposes only a query, never the Set
// itself, so nothing outside this module can claim/release a key.
function isImportKeyActive(key) {
  return Boolean(key) && activeImportKeys.has(key);
}

module.exports = { buildPreview, importBatch, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, isImportKeyActive };
