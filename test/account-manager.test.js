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
