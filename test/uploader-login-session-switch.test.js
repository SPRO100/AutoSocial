const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

// Covers a real gap flagged in review: startLoginSession's "an open session
// exists for a DIFFERENT account than the one now active" cleanup branch
// was exercised by no test, for either backend. This drives it for both a
// legacy account and a Persona-backed account.

function installFakeModule(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

function makeFakeContext() {
  let closed = false;
  const pages = [{ url: () => "about:blank", goto: async () => {} }];
  return {
    pages: () => pages,
    newPage: async () => pages[0],
    close: async () => { closed = true; },
    isClosed: () => closed,
    on: () => {},
  };
}

async function freshTikTokUploader() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-login-switch-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");

  const legacyContextsByProfileDir = new Map();
  const personaBrowsersByProfileId = new Map();

  installFakeModule("playwright", {
    chromium: {
      launchPersistentContext: async (profileDir) => {
        const context = makeFakeContext();
        legacyContextsByProfileDir.set(profileDir, context);
        return context;
      },
      connectOverCDP: async () => {
        throw new Error("not used in this test - persona-browser.js is faked directly");
      },
    },
  });

  installFakeModule("../src/persona-browser", {
    PersonaApiError: class PersonaApiError extends Error {},
    attachPersonaProfile: async (profileId) => {
      const context = makeFakeContext();
      const browser = { contexts: () => [context], close: async () => { await context.close(); }, on: () => {} };
      personaBrowsersByProfileId.set(profileId, { browser, context });
      return { profileId, browser, context, page: context.pages()[0], info: { port: 1 } };
    },
    disconnectPersonaBrowser: async (session) => {
      await session.browser.close();
    },
    stopPersonaProfile: async () => {},
    personaProfileExists: async () => true,
  });

  for (const modulePath of ["../src/account-manager", "../src/browser-session", "../src/tiktok-uploader"]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const accountManager = require("../src/account-manager");
  const tiktokUploader = require("../src/tiktok-uploader");
  return { accountManager, tiktokUploader, legacyContextsByProfileDir, personaBrowsersByProfileId };
}

test("startLoginSession disconnects the previous account's LEGACY session when the active account switches", async () => {
  const { accountManager, tiktokUploader, legacyContextsByProfileDir } = await freshTikTokUploader();
  const accountA = await accountManager.addAccount("Switch Legacy A");
  const accountB = await accountManager.addAccount("Switch Legacy B");

  await accountManager.selectAccount(accountA.id);
  await tiktokUploader.startDashboardLoginSession();
  const contextA = [...legacyContextsByProfileDir.values()][0];
  assert.equal(contextA.isClosed(), false);

  await accountManager.selectAccount(accountB.id);
  const result = await tiktokUploader.startDashboardLoginSession();

  assert.equal(result.alreadyOpen, false, "a NEW session must be opened for the newly active account");
  assert.equal(contextA.isClosed(), true, "the previous account's session must be disconnected when switching");

  const status = await tiktokUploader.getLoginSessionStatus();
  assert.equal(status.open, true, "the new account's session must now be reported open");
  await tiktokUploader.closeLoginSession();
});

test("startLoginSession disconnects the previous account's PERSONA session (browser.close, not context.close) when the active account switches", async () => {
  const { accountManager, tiktokUploader, personaBrowsersByProfileId } = await freshTikTokUploader();
  const accountA = await accountManager.addAccount("Switch Persona A");
  const accountB = await accountManager.addAccount("Switch Persona B");
  await accountManager.setPersonaProfileId(accountA.id, "profile-a");
  await accountManager.setPersonaProfileId(accountB.id, "profile-b");

  await accountManager.selectAccount(accountA.id);
  await tiktokUploader.startDashboardLoginSession();
  const sessionA = personaBrowsersByProfileId.get("profile-a");
  assert.equal(sessionA.context.isClosed(), false);

  await accountManager.selectAccount(accountB.id);
  await tiktokUploader.startDashboardLoginSession();

  assert.equal(sessionA.context.isClosed(), true, "disconnecting must still tear down the fake browser (proxying to context.close in this fake), never leave account A's session dangling");
  await tiktokUploader.closeLoginSession();
});

test("calling startLoginSession twice for the SAME active account reuses the open session (alreadyOpen), never double-attaches", async () => {
  const { accountManager, tiktokUploader, personaBrowsersByProfileId } = await freshTikTokUploader();
  const account = await accountManager.addAccount("Same Account Reuse");
  await accountManager.setPersonaProfileId(account.id, "profile-reuse");
  await accountManager.selectAccount(account.id);

  const first = await tiktokUploader.startDashboardLoginSession();
  assert.equal(first.alreadyOpen, false);
  const second = await tiktokUploader.startDashboardLoginSession();
  assert.equal(second.alreadyOpen, true);
  assert.equal(personaBrowsersByProfileId.size, 1, "a second call for the same account must not attach a second time");
  await tiktokUploader.closeLoginSession();
});
