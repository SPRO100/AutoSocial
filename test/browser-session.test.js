const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function installFakeModule(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  return resolved;
}

function makeFakeContext() {
  const pages = [];
  let closed = false;
  const context = {
    pages: () => pages,
    newPage: async () => {
      const page = { url: () => "about:blank" };
      pages.push(page);
      return page;
    },
    close: async () => { closed = true; },
    isClosed: () => closed,
  };
  return context;
}

function makeFakeBrowser(context) {
  let closed = false;
  return {
    contexts: () => [context],
    close: async () => { closed = true; },
    isClosed: () => closed,
  };
}

async function freshBrowserSession({ personaOverrides = {}, playwrightOverrides = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-browser-session-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");

  const legacyContext = makeFakeContext();
  const personaContext = makeFakeContext();
  const personaBrowser = makeFakeBrowser(personaContext);

  const attachCalls = [];
  const disconnectCalls = [];
  installFakeModule("../src/persona-browser", {
    PersonaApiError: class PersonaApiError extends Error {},
    attachPersonaProfile: async (profileId, opts) => {
      attachCalls.push({ profileId, opts });
      return { profileId, browser: personaBrowser, context: personaContext, page: personaContext.pages()[0] || (await personaContext.newPage()), info: { port: 1 } };
    },
    disconnectPersonaBrowser: async (session) => {
      disconnectCalls.push(session);
      await session.browser.close();
    },
    stopPersonaProfile: async () => {},
    personaProfileExists: async () => true,
    ...personaOverrides,
  });

  const launchCalls = [];
  installFakeModule("playwright", {
    chromium: {
      launchPersistentContext: async (profileDir, options) => {
        launchCalls.push({ profileDir, options });
        return legacyContext;
      },
      connectOverCDP: async () => {
        throw new Error("connectOverCDP should not be called directly by browser-session.js");
      },
      ...playwrightOverrides,
    },
  });

  delete require.cache[require.resolve("../src/account-manager")];
  delete require.cache[require.resolve("../src/browser-session")];
  const accountManager = require("../src/account-manager");
  const { acquireBrowserSession } = require("../src/browser-session");

  return {
    accountManager,
    acquireBrowserSession,
    legacyContext,
    personaContext,
    personaBrowser,
    attachCalls,
    disconnectCalls,
    launchCalls,
  };
}

test("acquireBrowserSession uses the legacy launchPersistentContext path for an account with no personaProfileId", async () => {
  const { accountManager, acquireBrowserSession, launchCalls, attachCalls } = await freshBrowserSession();
  const account = await accountManager.addAccount("Legacy Session Account");

  const session = await acquireBrowserSession("tiktok", { accountId: account.id });

  assert.equal(session.backend, "legacy");
  assert.equal(session.browser, null);
  assert.equal(launchCalls.length, 1);
  assert.equal(attachCalls.length, 0);
  assert.ok(launchCalls[0].profileDir.includes(account.id));
});

test("acquireBrowserSession uses the Persona/CDP path for an account with a personaProfileId, never the legacy launcher", async () => {
  const { accountManager, acquireBrowserSession, launchCalls, attachCalls } = await freshBrowserSession();
  const account = await accountManager.addAccount("Persona Session Account");
  await accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1");

  const session = await acquireBrowserSession("tiktok", { accountId: account.id });

  assert.equal(session.backend, "persona");
  assert.equal(session.profileId, "6a34ff44d3e1");
  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0].profileId, "6a34ff44d3e1");
  assert.equal(launchCalls.length, 0, "the legacy persistent-context launcher must never run for a Persona-backed account");
});

test("acquireBrowserSession with no accountId resolves the active account, same as every other account-scoped call", async () => {
  const { accountManager, acquireBrowserSession, attachCalls } = await freshBrowserSession();
  const account = await accountManager.addAccount("Active Persona Account");
  await accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1");
  await accountManager.selectAccount(account.id);

  await acquireBrowserSession("instagram");
  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0].profileId, "6a34ff44d3e1");
});

test("session.disconnect() for a Persona-backed session calls disconnectPersonaBrowser, never context.close() directly", async () => {
  const { accountManager, acquireBrowserSession, personaContext, disconnectCalls } = await freshBrowserSession();
  const account = await accountManager.addAccount("Disconnect Persona Account");
  await accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1");

  const session = await acquireBrowserSession("tiktok", { accountId: account.id });
  await session.disconnect();

  assert.equal(disconnectCalls.length, 1);
  assert.equal(personaContext.isClosed(), false, "the persistent context itself must never be closed by AutoSocial's disconnect");
});

test("session.disconnect() for a legacy session closes the context directly (unchanged backward-compatible behavior)", async () => {
  const { accountManager, acquireBrowserSession, legacyContext } = await freshBrowserSession();
  const account = await accountManager.addAccount("Disconnect Legacy Account");

  const session = await acquireBrowserSession("tiktok", { accountId: account.id });
  await session.disconnect();

  assert.equal(legacyContext.isClosed(), true);
});

test("legacyLaunchOptions (e.g. Instagram's extra args/user agent) reach launchPersistentContext only on the legacy path", async () => {
  const { accountManager, acquireBrowserSession, launchCalls } = await freshBrowserSession();
  const account = await accountManager.addAccount("Instagram Options Account");

  await acquireBrowserSession("instagram", {
    accountId: account.id,
    legacyLaunchOptions: { userAgent: "custom-agent" },
  });

  assert.equal(launchCalls[0].options.userAgent, "custom-agent");
  // Base options (headless/viewport/locale/etc.) must still be present -
  // legacyLaunchOptions extends, never replaces, the shared defaults.
  assert.ok("headless" in launchCalls[0].options);
  assert.ok("viewport" in launchCalls[0].options);
});
