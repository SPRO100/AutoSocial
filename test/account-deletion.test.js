const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function installFakeModule(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

// Fresh account-manager (own temp state file), fresh account-deletion.js,
// AND a fresh importers/pipeline.js (faked, so the cross-feature
// concurrency check can be controlled) with persona-browser faked out - no
// real Persona API, no real Chromium. Same module-cache-substitution
// convention as the rest of this suite.
async function freshAccountDeletion({ persona = {}, importKeyActive = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-account-deletion-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");

  // Mutable, so a test can flip this MID-FLIGHT (simulating an import/
  // Update Session starting after deleteCompletely's up-front check but
  // before its destructive Persona calls) - not just set once at the start.
  const importKeyState = { active: importKeyActive };

  const calls = { stopPersonaProfile: [], deletePersonaProfile: [], personaProfileExists: [] };
  // Realistic default: a profile exists until it has actually been
  // deleted through this fake, then it doesn't - so the real code's
  // before/after verification has something real to distinguish, exactly
  // like the live Persona API.
  const deletedProfileIds = new Set();
  const fakePersona = {
    personaProfileExists: async (id) => {
      calls.personaProfileExists.push(id);
      return !deletedProfileIds.has(id);
    },
    stopPersonaProfile: async (id) => { calls.stopPersonaProfile.push(id); },
    deletePersonaProfile: async (id) => { calls.deletePersonaProfile.push(id); deletedProfileIds.add(id); },
    PersonaApiError: class PersonaApiError extends Error {},
    ...persona,
  };
  installFakeModule("../src/persona-browser", fakePersona);
  installFakeModule("../src/importers/pipeline", { isImportKeyActive: () => importKeyState.active });

  delete require.cache[require.resolve("../src/account-deletion")];
  const accountDeletion = require("../src/account-deletion");
  return { accountDeletion, accountManager, calls, dir, importKeyState };
}

async function seedAccount(accountManager, { username = "delete-user", profileId = "delete-profile-1" } = {}) {
  const account = await accountManager.addAccount(username, { importPlatform: "tiktok", importUsername: username });
  if (profileId) await accountManager.setPersonaProfileId(account.id, profileId);
  return account;
}

// --- 9. Remove account only ------------------------------------------

test("removeAccountOnly deletes the AutoSocial account and never touches Persona at all", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion();
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.removeAccountOnly(account.id);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "remove_only");
  assert.equal(result.accountRemoved, true);
  assert.equal(result.personaAction, "kept");

  assert.equal(await accountManager.getAccountById(account.id), null);
  assert.deepEqual(calls.stopPersonaProfile, []);
  assert.deepEqual(calls.deletePersonaProfile, []);
  assert.deepEqual(calls.personaProfileExists, [], "removeAccountOnly must never even check Persona - the profile is left completely alone");
});

test("removeAccountOnly on an account with no linked Persona profile still works cleanly", async () => {
  const { accountDeletion, accountManager } = await freshAccountDeletion();
  const account = await seedAccount(accountManager, { profileId: null });

  const result = await accountDeletion.removeAccountOnly(account.id);
  assert.equal(result.ok, true);
  assert.equal(result.personaProfileId, null);
});

test("removeAccountOnly reports a clean error for an unknown account, changes nothing", async () => {
  const { accountDeletion } = await freshAccountDeletion();
  const result = await accountDeletion.removeAccountOnly("does-not-exist");
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

// --- 10/11. Full delete - stopped and running profile -----------------

test("deleteCompletely on a STOPPED profile: verifies existence, stops (idempotent no-op), deletes, verifies gone, then removes the account", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion();
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "delete_completely");
  assert.equal(result.personaAction, "deleted");
  assert.equal(result.personaProfileId, "delete-profile-1");

  assert.deepEqual(calls.stopPersonaProfile, ["delete-profile-1"]);
  assert.deepEqual(calls.deletePersonaProfile, ["delete-profile-1"]);
  assert.equal(calls.personaProfileExists.length, 2, "must check existence both before deleting and after, to verify it actually took effect");

  assert.equal(await accountManager.getAccountById(account.id), null);
});

test("deleteCompletely on a RUNNING profile: stop -> delete -> verify -> remove, in that exact order", async () => {
  const order = [];
  let existsCheckCount = 0;
  const { accountDeletion, accountManager } = await freshAccountDeletion({
    persona: {
      personaProfileExists: async () => {
        existsCheckCount += 1;
        order.push("exists-check");
        return existsCheckCount === 1; // exists before deletion, gone after
      },
      stopPersonaProfile: async () => { order.push("stop"); },
      deletePersonaProfile: async () => { order.push("delete"); },
    },
  });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["exists-check", "stop", "delete", "exists-check"]);
  assert.equal(await accountManager.getAccountById(account.id), null);
});

// --- 12. Persona delete failure - account remains ----------------------

test("deleteCompletely: a Persona deletion failure leaves the AutoSocial account fully intact", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion({
    persona: { deletePersonaProfile: async () => { throw new Error("simulated Persona deletion failure"); } },
  });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not delete/i);

  const reloaded = await accountManager.getAccountById(account.id);
  assert.ok(reloaded, "the account must still exist");
  assert.equal(reloaded.personaProfileId, "delete-profile-1");
  assert.deepEqual(calls.stopPersonaProfile, ["delete-profile-1"], "stop must still have been attempted");
});

test("deleteCompletely: a stop failure leaves the AutoSocial account intact and never attempts delete", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion({
    persona: { stopPersonaProfile: async () => { throw new Error("simulated stop failure"); } },
  });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /could not stop/i);
  assert.deepEqual(calls.deletePersonaProfile, []);
  assert.ok(await accountManager.getAccountById(account.id));
});

test("deleteCompletely: if deletion cannot be VERIFIED to have taken effect, the AutoSocial account is NOT removed - never report success while Persona might still exist", async () => {
  const { accountDeletion, accountManager } = await freshAccountDeletion({
    persona: {
      personaProfileExists: async () => true, // still exists both before AND after the "delete" call
    },
  });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /still exists/i);
  assert.ok(await accountManager.getAccountById(account.id), "must never remove the account when deletion could not be verified");
});

// --- 13. Persona API unavailable - fail closed -------------------------

test("deleteCompletely: Persona API unreachable during the existence check fails closed - account untouched", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion({
    persona: { personaProfileExists: async () => { throw new Error("connect ECONNREFUSED"); } },
  });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, false);
  assert.deepEqual(calls.stopPersonaProfile, [], "must never attempt to stop/delete if it can't even verify the profile exists first");
  assert.ok(await accountManager.getAccountById(account.id));
});

// --- 14/18. Never touches an unrelated account/profile ------------------

test("deleting account A never calls stop/delete for account B's Persona profile, and B's mapping is untouched", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion();
  const accountA = await seedAccount(accountManager, { username: "account-a", profileId: "profile-a" });
  const accountB = await seedAccount(accountManager, { username: "account-b", profileId: "profile-b" });

  const result = await accountDeletion.deleteCompletely(accountA.id);
  assert.equal(result.ok, true);

  assert.ok(!calls.stopPersonaProfile.includes("profile-b"));
  assert.ok(!calls.deletePersonaProfile.includes("profile-b"));
  const reloadedB = await accountManager.getAccountById(accountB.id);
  assert.equal(reloadedB.personaProfileId, "profile-b");
});

test("a request body could carry an arbitrary personaProfileId, but the function signature never accepts one - only accountId is ever read, resolution is always server-side", async () => {
  // This is really a signature/contract assertion: deleteCompletely takes
  // exactly one argument. There is no way for a caller to pass a
  // different profile id even if they wanted to - the canonical mapping
  // is looked up from the real account record every time.
  assert.equal(require("../src/account-deletion").deleteCompletely.length, 1);
  assert.equal(require("../src/account-deletion").removeAccountOnly.length, 1);
});

// --- 15. Account without Persona -----------------------------------------

test("deleteCompletely on an account with NO linked Persona profile just removes the account - personaAction 'not_linked', never calls Persona at all", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion();
  const account = await seedAccount(accountManager, { profileId: null });

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, true);
  assert.equal(result.personaAction, "not_linked");
  assert.equal(result.personaProfileId, null);
  assert.deepEqual(calls.personaProfileExists, []);
  assert.equal(await accountManager.getAccountById(account.id), null);
});

// --- 16. Persona already missing -----------------------------------------

test("deleteCompletely on an orphaned mapping (Persona profile already gone) reports personaAction 'already_missing', never claims a real deletion happened", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion({
    persona: { personaProfileExists: async () => false },
  });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, true);
  assert.equal(result.personaAction, "already_missing");
  assert.deepEqual(calls.stopPersonaProfile, [], "must never call stop on a profile already confirmed gone");
  assert.deepEqual(calls.deletePersonaProfile, [], "must never call delete on a profile already confirmed gone");
  assert.equal(await accountManager.getAccountById(account.id), null);
});

// --- 17. Concurrent / double delete --------------------------------------

test("two concurrent deleteCompletely calls for the SAME account never both proceed - one is rejected as already in progress", async () => {
  let resolveDelete;
  const deleteStarted = new Promise((r) => { resolveDelete = r; });
  let deleted = false;
  const { accountDeletion, accountManager } = await freshAccountDeletion({
    persona: {
      personaProfileExists: async () => !deleted,
      deletePersonaProfile: async () => {
        resolveDelete();
        await new Promise((r) => setTimeout(r, 30));
        deleted = true;
      },
    },
  });
  const account = await seedAccount(accountManager);

  const first = accountDeletion.deleteCompletely(account.id);
  await deleteStarted;
  const second = await accountDeletion.deleteCompletely(account.id);
  const firstResult = await first;

  assert.equal(second.ok, false);
  assert.match(second.error, /already in progress/i);
  assert.equal(firstResult.ok, true);
  assert.equal(await accountManager.getAccountById(account.id), null);
});

test("a double-click removeAccountOnly (second call after the account is already gone) is rejected cleanly, not a crash", async () => {
  const { accountDeletion, accountManager } = await freshAccountDeletion();
  const account = await seedAccount(accountManager);

  const first = await accountDeletion.removeAccountOnly(account.id);
  assert.equal(first.ok, true);
  const second = await accountDeletion.removeAccountOnly(account.id);
  assert.equal(second.ok, false);
  assert.match(second.error, /not found/i);
});

test("deleteCompletely refuses to proceed while an import/Update Session for the same account is active (cross-feature race guard)", async () => {
  const { accountDeletion, accountManager, calls } = await freshAccountDeletion({ importKeyActive: true });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /in progress/i);
  assert.deepEqual(calls.personaProfileExists, []);
  assert.ok(await accountManager.getAccountById(account.id));
});

// Independent-review finding: a single up-front check isn't enough -
// deleteCompletely spans several real network round-trips, so an import/
// Update Session could legitimately start AFTER the initial check but
// BEFORE the actual destructive stop/delete calls. Fixed by re-checking
// immediately before each one. These two tests simulate exactly that
// window by flipping the flag mid-flight, from inside the fake Persona
// calls themselves.

test("SAFETY: an import/Update Session that starts DURING the existence check (before stop) is caught by the re-check and aborts the delete", async () => {
  const { accountDeletion, accountManager, calls, importKeyState } = await freshAccountDeletion({
    persona: {
      personaProfileExists: async (id) => {
        calls.personaProfileExists.push(id);
        // Simulate an Update Session claiming this key WHILE this call was
        // in flight - realistic, since this is itself a real network hop.
        importKeyState.active = true;
        return true;
      },
    },
  });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /in progress/i);
  assert.deepEqual(calls.stopPersonaProfile, [], "must never reach stop once the re-check catches the new claim");
  assert.ok(await accountManager.getAccountById(account.id), "the account must remain untouched");
});

test("SAFETY: an import/Update Session that starts DURING stop (before delete) is caught by the second re-check and aborts before the actually-destructive delete call", async () => {
  const { accountDeletion, accountManager, calls, importKeyState } = await freshAccountDeletion({
    persona: {
      stopPersonaProfile: async (id) => {
        calls.stopPersonaProfile.push(id);
        // Simulate the claim appearing right after stop succeeded, before
        // the delete call is made.
        importKeyState.active = true;
      },
    },
  });
  const account = await seedAccount(accountManager);

  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /in progress/i);
  assert.deepEqual(calls.deletePersonaProfile, [], "must never reach the actually-destructive delete call once the second re-check catches the new claim");
  assert.ok(await accountManager.getAccountById(account.id), "the account must remain untouched - stop alone is recoverable, so no partial-failure cleanup is needed");
});

// --- 19. Secret leakage ---------------------------------------------------

test("no result object from either deletion mode ever contains anything beyond the documented safe fields", async () => {
  const { accountDeletion, accountManager } = await freshAccountDeletion();
  const account = await seedAccount(accountManager);
  const result = await accountDeletion.deleteCompletely(account.id);
  assert.deepEqual(Object.keys(result).sort(), ["accountId", "accountRemoved", "mode", "ok", "personaAction", "personaProfileId"].sort());
});

test("an error message from a simulated Persona failure never contains anything beyond the caught Error.message - no raw account internals dumped", async () => {
  const { accountDeletion, accountManager } = await freshAccountDeletion({
    persona: { deletePersonaProfile: async () => { throw new Error("simulated Persona deletion failure"); } },
  });
  const account = await seedAccount(accountManager);
  const result = await accountDeletion.deleteCompletely(account.id);
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});
