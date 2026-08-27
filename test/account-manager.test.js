const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

async function freshAccountManager() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-accounts-"));
  const stateFile = path.join(dir, "accounts-state.json");
  process.env.ACCOUNTS_STATE_FILE = stateFile;
  // account-manager.js caches its loaded state at module scope, so each
  // test needs a genuinely fresh module instance to see its own state file.
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");
  return { accountManager, stateFile, dir };
}

test("a brand-new account has no personaProfileId, and legacy shape (id/name only) is preserved", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Legacy Account");
  assert.equal(account.personaProfileId, undefined);
  assert.deepEqual(Object.keys(account).sort(), ["id", "name"]);
});

test("setPersonaProfileId persists across a reload from disk", async () => {
  const { accountManager, stateFile } = await freshAccountManager();
  const account = await accountManager.addAccount("Persona Account");
  await accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1");

  // Reload as a genuinely fresh module instance (simulates a process
  // restart) reading the SAME state file back from disk.
  delete require.cache[require.resolve("../src/account-manager")];
  const reloaded = require("../src/account-manager");
  const reloadedAccount = await reloaded.getAccountById(account.id);
  assert.equal(reloadedAccount.personaProfileId, "6a34ff44d3e1");

  const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const rawAccount = raw.accounts.find((a) => a.id === account.id);
  assert.equal(rawAccount.personaProfileId, "6a34ff44d3e1");
});

test("legacy accounts-state.json (no personaProfileId field at all, pre-existing on disk) loads without error and stays legacy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-accounts-"));
  const stateFile = path.join(dir, "accounts-state.json");
  await fs.writeFile(
    stateFile,
    JSON.stringify({
      activeAccountId: "old-account",
      accounts: [{ id: "old-account", name: "Old Account" }],
    })
  );
  process.env.ACCOUNTS_STATE_FILE = stateFile;
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");

  const accounts = await accountManager.getAllAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "old-account");
  assert.equal(accounts[0].personaProfileId, undefined);
  const active = await accountManager.getActiveAccount();
  assert.equal(active.id, "old-account");
});

test("normalizeState never drops an extraneous/malformed account entry, and never crashes on garbage input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-accounts-"));
  const stateFile = path.join(dir, "accounts-state.json");
  await fs.writeFile(stateFile, JSON.stringify({ accounts: [{ id: 123 }, null, "garbage"], activeAccountId: "??" }));
  process.env.ACCOUNTS_STATE_FILE = stateFile;
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");

  // Every entry was malformed -> falls back to the built-in default account,
  // never throws.
  const accounts = await accountManager.getAllAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, "default");
});

test("getPersonaProfileId reads null for an unmapped account and the real value for a mapped one", async () => {
  const { accountManager } = await freshAccountManager();
  const plain = await accountManager.addAccount("Plain Account");
  const linked = await accountManager.addAccount("Linked Account");
  await accountManager.setPersonaProfileId(linked.id, "6a34ff44d3e1");

  assert.equal(await accountManager.getPersonaProfileId(plain.id), null);
  assert.equal(await accountManager.getPersonaProfileId(linked.id), "6a34ff44d3e1");
});

test("setPersonaProfileId rejects an unknown account and an empty profile id", async () => {
  const { accountManager } = await freshAccountManager();
  await assert.rejects(accountManager.setPersonaProfileId("does-not-exist", "abc"), /Account not found/);
  const account = await accountManager.addAccount("Validation Account");
  await assert.rejects(accountManager.setPersonaProfileId(account.id, ""), /required/);
  await assert.rejects(accountManager.setPersonaProfileId(account.id, "   "), /required/);
});

test("setPersonaProfileId rejects linking a Persona profile that is already mapped to a DIFFERENT account", async () => {
  const { accountManager } = await freshAccountManager();
  const accountA = await accountManager.addAccount("Account A");
  const accountB = await accountManager.addAccount("Account B");
  await accountManager.setPersonaProfileId(accountA.id, "6a34ff44d3e1");

  await assert.rejects(
    accountManager.setPersonaProfileId(accountB.id, "6a34ff44d3e1"),
    /already linked to account "Account A"/
  );
  // Account B must not have been partially mutated by the rejected call.
  assert.equal(await accountManager.getPersonaProfileId(accountB.id), null);
});

test("setPersonaProfileId allows re-setting the SAME profile id on the SAME account (not a conflict with itself)", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Idempotent Account");
  await accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1");
  await assert.doesNotReject(accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1"));
});

test("clearPersonaProfileId removes the mapping and reverts hasSavedPlatformSession to the legacy check", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Clear Test Account");
  await accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1");
  assert.equal(await accountManager.getPersonaProfileId(account.id), "6a34ff44d3e1");

  await accountManager.clearPersonaProfileId(account.id);
  assert.equal(await accountManager.getPersonaProfileId(account.id), null);

  // With no personaProfileId, hasSavedPlatformSession falls back to the
  // legacy Cookies-DB check, which is honestly false for a brand-new
  // account with no browser profile on disk yet.
  const saved = await accountManager.hasSavedPlatformSession("tiktok", account.id);
  assert.equal(saved, false);
});

test("clearPersonaProfileId rejects an unknown account", async () => {
  const { accountManager } = await freshAccountManager();
  await assert.rejects(accountManager.clearPersonaProfileId("does-not-exist"), /Account not found/);
});

test("hasSavedPlatformSession for a Persona-backed account is Persona-derived, not the AutoSocial .profiles Cookies DB", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Persona Session Account");
  await accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1");

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify([{ id: "6a34ff44d3e1", name: "content-os-api-test" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    // No .profiles Cookies DB exists anywhere for this account - a legacy
    // check would honestly say false. Persona says the profile is real, so
    // the account-level answer must be true.
    const saved = await accountManager.hasSavedPlatformSession("tiktok", account.id);
    assert.equal(saved, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("hasSavedPlatformSession fails OPEN (true) for a Persona-backed account when Persona API is unreachable", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Persona Unreachable Account");
  await accountManager.setPersonaProfileId(account.id, "unreachable-profile");

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };
  try {
    const saved = await accountManager.hasSavedPlatformSession("tiktok", account.id);
    assert.equal(saved, true, "a transient Persona API outage must not falsely report no saved session");
  } finally {
    global.fetch = originalFetch;
  }
});

test("hasSavedPlatformSession for a Persona-backed account reports false when Persona is reachable but genuinely does not know the profile", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Persona Deleted Account");
  await accountManager.setPersonaProfileId(account.id, "deleted-profile-id");

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(JSON.stringify([{ id: "some-other-profile", name: "unrelated" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    const saved = await accountManager.hasSavedPlatformSession("tiktok", account.id);
    assert.equal(saved, false, "a confirmed-absent profile must honestly report no saved session");
  } finally {
    global.fetch = originalFetch;
  }
});

// --- removeAccount / findAccountByImportSource (bulk importer rollback) --

test("removeAccount deletes the account and reassigns activeAccountId if it was active", async () => {
  const { accountManager } = await freshAccountManager();
  // A brand-new state always starts with the built-in "default" account
  // present alongside whatever addAccount() creates.
  const b = await accountManager.addAccount("Account B");
  await accountManager.selectAccount(b.id);

  const removed = await accountManager.removeAccount(b.id);
  assert.equal(removed, true);
  assert.equal(await accountManager.getAccountById(b.id), null);
  const state = await accountManager.getState();
  assert.equal(state.activeAccountId, "default", "falls back to the remaining accounts[0] once the active one is removed");
});

test("removeAccount returns false for an unknown account id and refuses to remove the last remaining account", async () => {
  const { accountManager } = await freshAccountManager();
  assert.equal(await accountManager.removeAccount("does-not-exist"), false);
  const only = await accountManager.getAllAccounts();
  await assert.rejects(accountManager.removeAccount(only[0].id), /last remaining account/);
});

test("findAccountByImportSource matches by (platform, username) case-insensitively and returns null otherwise", async () => {
  const { accountManager } = await freshAccountManager();
  await accountManager.addAccount("account1", { importPlatform: "tiktok", importUsername: "Account1" });

  const match = await accountManager.findAccountByImportSource("TikTok", "account1");
  assert.ok(match);
  assert.equal(match.importUsername, "Account1");

  assert.equal(await accountManager.findAccountByImportSource("tiktok", "someone-else"), null);
  assert.equal(await accountManager.findAccountByImportSource("instagram", "account1"), null);
});

test("importPlatform/importUsername survive a save/reload round trip, and a plain addAccount(name) omits them entirely", async () => {
  const { accountManager, stateFile } = await freshAccountManager();
  await accountManager.addAccount("account2", { importPlatform: "tiktok", importUsername: "account2" });
  const plain = await accountManager.addAccount("Manually Added");
  assert.deepEqual(Object.keys(plain).sort(), ["id", "name"]);

  delete require.cache[require.resolve("../src/account-manager")];
  const reloaded = require("../src/account-manager");
  const match = await reloaded.findAccountByImportSource("tiktok", "account2");
  assert.ok(match);

  const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const rawImported = raw.accounts.find((a) => a.importUsername === "account2");
  assert.equal(rawImported.importPlatform, "tiktok");
});

// 2026-08-27 hardening (real bruna118564/brenda9875428 incidents) - the
// granular sessionState allowlist (SESSION_STATE_VALUES) must be kept in
// sync with instagram-verify.js's STATES or normalizeEnum silently drops an
// unrecognized value to null on persistence, even though it was classified
// correctly upstream. Both new states must survive setSessionStatus and a
// disk reload exactly like every pre-existing state does.
for (const state of ["ACCOUNT_SUSPENDED", "UNKNOWN"]) {
  test(`setSessionStatus persists the new "${state}" sessionState across a reload from disk (never silently dropped to null)`, async () => {
    const { accountManager } = await freshAccountManager();
    const account = await accountManager.addAccount("ig-account");
    await accountManager.setSessionStatus(account.id, {
      status: "challenge_required",
      reason: `test reason for ${state}`,
      checkedAt: new Date().toISOString(),
      state,
      attempts: null,
    });

    delete require.cache[require.resolve("../src/account-manager")];
    const reloaded = require("../src/account-manager");
    const persisted = await reloaded.getAccountById(account.id);
    assert.equal(persisted.sessionState, state, `sessionState must round-trip as "${state}", never null`);
  });
}

// Recovery V2 (2026-08-27+) diagnostic fields - same silent-drop risk as
// above if the allowlist in normalizeRecoveryAttempt isn't kept in sync.
test("setSessionStatus persists Recovery V2's transitionObserved/transitionElapsedMs attempt fields across a reload from disk", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("ig-account-v2");
  await accountManager.setSessionStatus(account.id, {
    status: "ready",
    reason: null,
    checkedAt: new Date().toISOString(),
    state: "READY",
    attempts: [
      {
        attempt: 1,
        state: "COOKIE_CONSENT_REQUIRED",
        url: "https://ig/consent/?flow=user_cookie_choice_v2",
        action: "cookie_consent",
        actionPerformed: true,
        actionDetail: "clicked control matching \"Decline optional cookies\"",
        transitionObserved: true,
        transitionElapsedMs: 42,
        result: "RECOVERY_RETRYABLE",
        reason: "Instagram is showing a routine cookie-consent banner",
        timestamp: new Date().toISOString(),
        nextAction: "re-verify after recovery action",
      },
    ],
  });

  delete require.cache[require.resolve("../src/account-manager")];
  const reloaded = require("../src/account-manager");
  const persisted = await reloaded.getAccountById(account.id);
  assert.equal(persisted.sessionRecoveryAttempts[0].transitionObserved, true);
  assert.equal(persisted.sessionRecoveryAttempts[0].transitionElapsedMs, 42);
});

test("many concurrent addAccount calls (as the bulk importer's worker pool issues) never lose an update on disk - final file matches final in-memory state", async () => {
  const { accountManager, stateFile } = await freshAccountManager();

  const names = Array.from({ length: 15 }, (_, i) => `Concurrent Account ${i}`);
  await Promise.all(names.map((name) => accountManager.addAccount(name)));

  const inMemory = await accountManager.getAllAccounts();
  // +1 for the built-in default account.
  assert.equal(inMemory.length, 16);

  const onDisk = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(
    onDisk.accounts.length,
    inMemory.length,
    "the file on disk must reflect every account created concurrently, not just whichever write happened to land last"
  );
  assert.deepEqual(
    onDisk.accounts.map((a) => a.id).sort(),
    inMemory.map((a) => a.id).sort()
  );
});
