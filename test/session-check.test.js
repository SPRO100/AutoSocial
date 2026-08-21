const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function installFakeModule(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

function makeFakePage(finalUrl) {
  return { goto: async () => {}, waitForLoadState: async () => {}, url: () => finalUrl };
}

const ACTIVE_URL = "https://www.tiktok.com/tiktokstudio/upload";
const LOGIN_URL = "https://www.tiktok.com/login?redirect_url=%2Ftiktokstudio%2Fupload";

async function freshSessionCheck({ persona = {}, profileStatus = "stopped" } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-session-check-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");

  const calls = { attachPersonaProfile: [], disconnectPersonaBrowser: [], stopPersonaProfile: [], listPersonaProfiles: 0 };
  const fakePersona = {
    listPersonaProfiles: async () => {
      calls.listPersonaProfiles += 1;
      return [{ id: "session-check-profile-1", name: "x", status: profileStatus, tags: [] }];
    },
    attachPersonaProfile: async (id) => {
      calls.attachPersonaProfile.push(id);
      return { profileId: id, page: makeFakePage(ACTIVE_URL), browser: {}, context: {}, info: { port: 1 } };
    },
    disconnectPersonaBrowser: async (session) => { calls.disconnectPersonaBrowser.push(session?.profileId); },
    stopPersonaProfile: async (id) => { calls.stopPersonaProfile.push(id); },
    PersonaApiError: class PersonaApiError extends Error {},
    ...persona,
  };
  installFakeModule("../src/persona-browser", fakePersona);

  delete require.cache[require.resolve("../src/session-check")];
  const sessionCheck = require("../src/session-check");
  return { sessionCheck, accountManager, calls, dir };
}

async function seedAccount(accountManager, { username = "session-user", profileId = "session-check-profile-1" } = {}) {
  const account = await accountManager.addAccount(username, { importPlatform: "tiktok", importUsername: username });
  await accountManager.setPersonaProfileId(account.id, profileId);
  return account;
}

test("checkSession reports 'ready' for an authenticated session and persists it on the account", async () => {
  const { sessionCheck, accountManager } = await freshSessionCheck();
  const account = await seedAccount(accountManager);

  const result = await sessionCheck.checkSession(account.id);
  assert.equal(result.ok, true);
  assert.equal(result.sessionStatus, "ready");
  assert.equal(result.reason, null);

  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.sessionStatus, "ready");
  assert.ok(reloaded.sessionCheckedAt);
});

test("checkSession reports 'needs_login' with a safe reason when redirected to login", async () => {
  const { sessionCheck, accountManager } = await freshSessionCheck({
    persona: { attachPersonaProfile: async (id) => ({ profileId: id, page: makeFakePage(LOGIN_URL), browser: {}, context: {}, info: { port: 1 } }) },
  });
  const account = await seedAccount(accountManager);

  const result = await sessionCheck.checkSession(account.id);
  assert.equal(result.sessionStatus, "needs_login");
  assert.match(result.reason, /login/i);

  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.sessionStatus, "needs_login");
});

test("checkSession leaves a RUNNING profile running afterward - never stops it", async () => {
  const { sessionCheck, accountManager, calls } = await freshSessionCheck({ profileStatus: "running" });
  const account = await seedAccount(accountManager);

  await sessionCheck.checkSession(account.id);
  assert.deepEqual(calls.stopPersonaProfile, [], "a profile that was already running must not be stopped by a Check Session call");
  assert.equal(calls.disconnectPersonaBrowser.length, 1, "the CDP client itself must still be released");
});

test("checkSession restores a STOPPED profile back to stopped afterward", async () => {
  const { sessionCheck, accountManager, calls } = await freshSessionCheck({ profileStatus: "stopped" });
  const account = await seedAccount(accountManager);

  await sessionCheck.checkSession(account.id);
  assert.deepEqual(calls.stopPersonaProfile, ["session-check-profile-1"], "a profile that was stopped before the check must be stopped again afterward");
});

test("checkSession fails cleanly for an account with no linked Persona profile - never guesses", async () => {
  const { sessionCheck, accountManager } = await freshSessionCheck();
  const account = await accountManager.addAccount("no-profile-user", { importPlatform: "tiktok", importUsername: "no-profile-user" });

  const result = await sessionCheck.checkSession(account.id);
  assert.equal(result.ok, false);
  assert.match(result.error, /no linked Persona profile/i);
});

test("checkSession fails cleanly for an unknown account", async () => {
  const { sessionCheck } = await freshSessionCheck();
  const result = await sessionCheck.checkSession("does-not-exist");
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

test("checkSession never persists a stale 'ready' when Persona itself is unreachable", async () => {
  const { sessionCheck, accountManager } = await freshSessionCheck({
    persona: { listPersonaProfiles: async () => { throw new Error("connect ECONNREFUSED"); } },
  });
  const account = await seedAccount(accountManager);

  const result = await sessionCheck.checkSession(account.id);
  assert.equal(result.ok, false);

  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.sessionStatus, undefined, "no status should be written at all when the check itself could not run");
});

test("checkSession result never contains a cookie/token/password value - only the safe verifier reason", async () => {
  const { sessionCheck, accountManager } = await freshSessionCheck();
  const account = await seedAccount(accountManager);
  const result = await sessionCheck.checkSession(account.id);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.toLowerCase().includes("sessionid="));
});
