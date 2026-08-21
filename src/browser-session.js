const fs = require("fs/promises");
const { chromium } = require("playwright");
const { config } = require("./config");
const { getAccountById, getActiveAccount, getPlatformProfileDir } = require("./account-manager");
const { attachPersonaProfile, disconnectPersonaBrowser } = require("./persona-browser");

// ---------------------------------------------------------------------------
// Common browser-acquisition abstraction shared by every uploader.
//
//   account.personaProfileId set    -> Persona owns identity/session (CDP).
//   account.personaProfileId absent -> legacy launchPersistentContext(),
//                                       unchanged, for backward compatibility.
//
// Returns one uniform shape either way:
//   { backend: "persona" | "legacy", accountId, profileId?, browser, context,
//     page, disconnect() }
//
// Callers MUST call session.disconnect() instead of context.close()/
// browser.close() directly - for a Persona-backed session, closing the
// context directly would send a real close command against Persona's own
// browser tabs (see persona-browser.js's disconnectPersonaBrowser doc
// comment); the abstraction is what keeps that distinction out of every
// uploader.
// ---------------------------------------------------------------------------

async function resolveAccount(accountId) {
  if (!accountId) return getActiveAccount();
  const account = await getAccountById(accountId);
  return account || { id: accountId, name: accountId };
}

async function acquirePersonaSession(account) {
  const { browser, context, page, profileId } = await attachPersonaProfile(
    account.personaProfileId,
    { headless: config.headless }
  );
  return {
    backend: "persona",
    accountId: account.id,
    profileId,
    browser,
    context,
    page,
    async disconnect() {
      await disconnectPersonaBrowser({ browser, profileId });
    },
  };
}

async function acquireLegacySession(platform, account, launchOptions = {}) {
  const profileDir = await getPlatformProfileDir(platform, account.id);
  await fs.mkdir(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    viewport: { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
    ...launchOptions,
  });
  const page = context.pages()[0] || (await context.newPage());
  return {
    backend: "legacy",
    accountId: account.id,
    profileId: null,
    browser: null,
    context,
    page,
    async disconnect() {
      await context.close().catch(() => {});
    },
  };
}

/**
 * Acquires a browser session for `platform`, routing to Persona or the
 * legacy persistent-profile launch based on whether the resolved account
 * has a personaProfileId. `accountId` defaults to the active account, same
 * as every other account-scoped call in this codebase.
 *
 * `legacyLaunchOptions` lets a platform supply its own extra
 * launchPersistentContext options (e.g. Instagram's realistic user agent
 * and extra Chromium args) without duplicating the whole launch call per
 * uploader - only used on the legacy path; Persona owns launch options for
 * its own profiles.
 */
async function acquireBrowserSession(platform, { accountId, legacyLaunchOptions } = {}) {
  const account = await resolveAccount(accountId);
  if (account.personaProfileId) {
    return acquirePersonaSession(account);
  }
  return acquireLegacySession(platform, account, legacyLaunchOptions);
}

module.exports = {
  acquireBrowserSession,
};
