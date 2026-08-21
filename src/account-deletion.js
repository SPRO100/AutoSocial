// Account-management lifecycle: safe deletion of an automation account,
// with or without its linked Persona profile. Sibling to account-manager.js
// (account CRUD) and persona-browser.js (Persona API client) - this module
// is the orchestration layer that combines both for delete operations,
// the same role importers/pipeline.js plays for import/update-session.
//
// Two modes:
//  - removeAccountOnly:  deletes the AutoSocial account record only. The
//                        Persona profile (browser, cookies, session data)
//                        is never touched - it becomes unlinked and stays
//                        available for a later Link.
//  - deleteCompletely:   stops the Persona profile if running, deletes it
//                        through Persona's real API, VERIFIES it is
//                        actually gone, and only then removes the
//                        AutoSocial account. Fails closed at every step -
//                        if Persona is unreachable, stop fails, delete
//                        fails, or the deletion can't be verified, the
//                        AutoSocial account is left exactly as it was.
//
// Canonical mapping: every function here takes only an accountId. The
// Persona profile id is always resolved server-side from the real account
// record - never accepted from a caller - so a spoofed/wrong client-
// supplied profile id can never be used to delete an unrelated profile.
const accountManager = require("./account-manager");
const persona = require("./persona-browser");
const { duplicateKey } = require("./importers/normalize");

function safeMessage(error) {
  return error && error.message ? error.message : String(error);
}

// Process-wide claim per accountId - guards against a double-click/double-
// submit racing two deletions (of either mode) for the same account at
// once. Reserved synchronously, before any await, same pattern as
// importers/pipeline.js's activeImportKeys.
const activeDeletions = new Set();

function accountImportKey(account) {
  return duplicateKey({ platform: account.importPlatform, username: account.importUsername });
}

// Not the same lock as importers/pipeline.js's own claim (this module never
// imports its live Set, only a read-only query). A single check at the
// start of an operation is not enough by itself: deleteCompletely's
// stop -> delete -> verify sequence spans several real network round-trips
// to Persona, and an import/Update Session for the same account could
// legitimately start in that window. So this is re-checked immediately
// before EACH destructive Persona call (see deleteCompletely below), not
// just once up front - independent-review finding, fixed before commit.
function assertImportNotActive(importKey) {
  if (!importKey) return null;
  const { isImportKeyActive } = require("./importers/pipeline");
  if (isImportKeyActive(importKey)) {
    return "An import or Update Session for this account is currently in progress - try again once it finishes.";
  }
  return null;
}

async function withAccountClaim(accountId, account, fn) {
  if (activeDeletions.has(accountId)) {
    return { ok: false, error: "A delete operation for this account is already in progress." };
  }
  const importKey = account ? accountImportKey(account) : null;
  const blockedReason = assertImportNotActive(importKey);
  if (blockedReason) {
    return { ok: false, error: blockedReason };
  }
  activeDeletions.add(accountId);
  try {
    return await fn(importKey);
  } finally {
    activeDeletions.delete(accountId);
  }
}

async function removeAccountOnly(accountId) {
  const account = await accountManager.getAccountById(accountId);
  if (!account) {
    return { ok: false, error: "Account not found." };
  }
  return withAccountClaim(accountId, account, async () => {
    try {
      await accountManager.removeAccount(accountId);
    } catch (error) {
      return { ok: false, error: safeMessage(error) };
    }
    return {
      ok: true,
      mode: "remove_only",
      accountId,
      accountRemoved: true,
      personaProfileId: account.personaProfileId || null,
      personaAction: "kept",
    };
  });
}

async function deleteCompletely(accountId) {
  const account = await accountManager.getAccountById(accountId);
  if (!account) {
    return { ok: false, error: "Account not found." };
  }
  // Canonical, server-resolved - never a client-supplied profile id.
  const profileId = account.personaProfileId || null;

  return withAccountClaim(accountId, account, async (importKey) => {
    if (!profileId) {
      try {
        await accountManager.removeAccount(accountId);
      } catch (error) {
        return { ok: false, error: safeMessage(error) };
      }
      return {
        ok: true,
        mode: "delete_completely",
        accountId,
        accountRemoved: true,
        personaProfileId: null,
        personaAction: "not_linked",
      };
    }

    // Fail closed: check existence FIRST, read-only, before any
    // destructive action - and before ever touching the AutoSocial record.
    let exists;
    try {
      exists = await persona.personaProfileExists(profileId);
    } catch (error) {
      return { ok: false, error: `Could not verify the Persona profile before deleting it: ${safeMessage(error)}` };
    }

    if (!exists) {
      // Orphaned mapping - the profile is already gone. Clean up the
      // AutoSocial record, but the result must never claim a real Persona
      // profile was deleted here - it wasn't; it was already missing.
      try {
        await accountManager.removeAccount(accountId);
      } catch (error) {
        return { ok: false, error: safeMessage(error) };
      }
      return {
        ok: true,
        mode: "delete_completely",
        accountId,
        accountRemoved: true,
        personaProfileId: profileId,
        personaAction: "already_missing",
      };
    }

    // Re-checked here, not just at the top of withAccountClaim - an import/
    // Update Session could have started in the time this function spent
    // awaiting the existence check above.
    const blockedBeforeStop = assertImportNotActive(importKey);
    if (blockedBeforeStop) {
      return { ok: false, error: blockedBeforeStop };
    }
    try {
      await persona.stopPersonaProfile(profileId);
    } catch (error) {
      return { ok: false, error: `Could not stop the Persona profile before deleting it: ${safeMessage(error)}` };
    }

    // Re-checked again immediately before the actually-destructive call -
    // stopping a profile an Update Session just attached to is recoverable
    // (it can re-attach), but deleting it out from under one is not.
    const blockedBeforeDelete = assertImportNotActive(importKey);
    if (blockedBeforeDelete) {
      return { ok: false, error: blockedBeforeDelete };
    }
    try {
      await persona.deletePersonaProfile(profileId);
    } catch (error) {
      return { ok: false, error: `Could not delete the Persona profile: ${safeMessage(error)}` };
    }

    // Verify the deletion actually took effect before touching AutoSocial's
    // own record - never trust a 200 response alone.
    let stillExists;
    try {
      stillExists = await persona.personaProfileExists(profileId);
    } catch (error) {
      return { ok: false, error: `Persona profile deletion could not be verified: ${safeMessage(error)}` };
    }
    if (stillExists) {
      return {
        ok: false,
        error: "Persona profile deletion did not take effect - the profile still exists. The AutoSocial account was NOT removed.",
      };
    }

    try {
      await accountManager.removeAccount(accountId);
    } catch (error) {
      // The Persona profile is genuinely gone at this point but the
      // AutoSocial record removal itself failed (e.g. "last remaining
      // account" guard) - report this honestly rather than claiming full
      // success.
      return {
        ok: false,
        error: `The Persona profile was deleted, but the AutoSocial account could not be removed: ${safeMessage(error)}`,
      };
    }

    return {
      ok: true,
      mode: "delete_completely",
      accountId,
      accountRemoved: true,
      personaProfileId: profileId,
      personaAction: "deleted",
    };
  });
}

module.exports = { removeAccountOnly, deleteCompletely };
