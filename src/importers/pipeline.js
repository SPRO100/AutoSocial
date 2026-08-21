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
    let existingAccount = false;
    if (record.platform && record.username) {
      const match = await accountManager.findAccountByImportSource(record.platform, record.username);
      existingAccount = Boolean(match);
    }
    preview.push({ ...safe, duplicateInBatch, alreadyImported: existingAccount });
  }
  return preview;
}

function safeMessage(error) {
  // PersonaApiError/Error messages in this codebase are already written to
  // be human-safe (see persona-browser.js) - never include raw record
  // fields (password/cookies) in a result, only these caught messages.
  return error && error.message ? error.message : String(error);
}

async function rollback({ accountId, profileId }) {
  if (profileId) {
    await persona.deletePersonaProfile(profileId).catch(() => {});
  }
  if (accountId) {
    await accountManager.removeAccount(accountId).catch(() => {});
  }
}

async function processRecord(record) {
  const base = { platform: record.platform, username: record.username };

  if (record.platform && record.username) {
    const existing = await accountManager.findAccountByImportSource(record.platform, record.username);
    if (existing) {
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
// closed.
async function claimAndProcess(record) {
  const key = duplicateKey(record);
  if (!key) return processRecord(record);
  if (activeImportKeys.has(key)) {
    return duplicateSkipResult(record, "this platform/username is already being imported by another in-flight request");
  }
  activeImportKeys.add(key);
  try {
    return await processRecord(record);
  } finally {
    activeImportKeys.delete(key);
  }
}

// Bounded-concurrency worker pool - never launches more than `concurrency`
// (clamped to MAX_CONCURRENCY) Persona attach/verify operations (each a
// real Chromium process) at once, and one record's exception never aborts
// the batch.
async function importBatch(records, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const limit = Math.min(MAX_CONCURRENCY, Math.max(1, Number(concurrency) || DEFAULT_CONCURRENCY));
  const results = new Array(records.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= records.length) return;
      const record = records[index];
      try {
        results[index] = await claimAndProcess(record);
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

module.exports = { buildPreview, importBatch, DEFAULT_CONCURRENCY, MAX_CONCURRENCY };
