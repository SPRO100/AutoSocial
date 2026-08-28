const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

// Same isolation pattern as account-manager.test.js: account-manager.js
// caches loaded state at module scope, so each test needs its own state
// file and a genuinely fresh module instance.
async function freshAccountManager() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-capability-"));
  const stateFile = path.join(dir, "accounts-state.json");
  process.env.ACCOUNTS_STATE_FILE = stateFile;
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");
  return { accountManager, stateFile };
}

test("effectivePool defaults an account with no stored pool value to ACTIVE - never fabricates QUARANTINE/ARCHIVED", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Pool Default Account");
  assert.equal(accountManager.effectivePool(account), "ACTIVE");
});

test("setPool persists across a reload from disk and records a reason/timestamp", async () => {
  const { accountManager, stateFile } = await freshAccountManager();
  const account = await accountManager.addAccount("Pool Account");
  await accountManager.setPool(account.id, { pool: "QUARANTINE", reason: "needs operator review" });

  delete require.cache[require.resolve("../src/account-manager")];
  const reloaded = require("../src/account-manager");
  const reloadedAccount = await reloaded.getAccountById(account.id);
  assert.equal(reloadedAccount.pool, "QUARANTINE");
  assert.equal(reloadedAccount.poolReason, "needs operator review");
  assert.ok(reloadedAccount.poolUpdatedAt);

  const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(raw.accounts.find((a) => a.id === account.id).pool, "QUARANTINE");
});

test("setPool rejects an unknown pool value and never persists it", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Bad Pool Account");
  await assert.rejects(() => accountManager.setPool(account.id, { pool: "DELETED" }));
  const reread = await accountManager.getAccountById(account.id);
  assert.equal(accountManager.effectivePool(reread), "ACTIVE");
});

test("setCapabilities persists identity/privacy/link/publishing capability and evidence, secret-free", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Capability Account");
  const updated = await accountManager.setCapabilities(account.id, {
    identityStatus: "CONFIRMED",
    privacyStatus: "PRIVATE",
    profileEditCapability: "AVAILABLE",
    linkCapability: "UNAVAILABLE",
    publishingCapability: "AVAILABLE",
    observedProfileLink: null,
    evidence: ["website_field_not_found"],
  });
  assert.equal(updated.identityStatus, "CONFIRMED");
  assert.equal(updated.privacyStatus, "PRIVATE");
  assert.equal(updated.linkCapability, "UNAVAILABLE");
  assert.deepEqual(updated.capabilityEvidence, ["website_field_not_found"]);
  assert.ok(updated.capabilityCheckedAt);
  assert.equal(JSON.stringify(updated).toLowerCase().includes("cookie"), false);
  assert.equal(JSON.stringify(updated).toLowerCase().includes("sessionid"), false);
});

test("setCapabilities rejects garbage into the strict enum instead of silently persisting it as-is", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Garbage Enum Account");
  const updated = await accountManager.setCapabilities(account.id, { privacyStatus: "hacked_value" });
  assert.equal(updated.privacyStatus, "UNKNOWN");
});

test("Profile Link lifecycle: intent marks APPLYING, then a positive result marks ACTIVE and persists observed/applied/verified", async () => {
  const { accountManager, stateFile } = await freshAccountManager();
  const account = await accountManager.addAccount("Link Lifecycle Account");
  await accountManager.setProfileLinkIntent(account.id, "https://example.com/a");
  let current = await accountManager.getAccountById(account.id);
  assert.equal(current.profileLinkStatus, "APPLYING");
  assert.equal(current.desiredProfileLink, "https://example.com/a");

  await accountManager.setProfileLinkResult(account.id, {
    status: "ACTIVE", observedUrl: "https://example.com/a", appliedAt: new Date().toISOString(), verifiedAt: new Date().toISOString(),
  });
  current = await accountManager.getAccountById(account.id);
  assert.equal(current.profileLinkStatus, "ACTIVE");
  assert.equal(current.observedProfileLink, "https://example.com/a");
  assert.equal(current.linkFailureReason, undefined);

  delete require.cache[require.resolve("../src/account-manager")];
  const reloaded = require("../src/account-manager");
  const reloadedAccount = await reloaded.getAccountById(account.id);
  assert.equal(reloadedAccount.profileLinkStatus, "ACTIVE");

  const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(raw.accounts.find((a) => a.id === account.id).profileLinkStatus, "ACTIVE");
});

test("Profile Link lifecycle: a MISMATCH result keeps the failure reason for operator visibility", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Link Mismatch Account");
  await accountManager.setProfileLinkIntent(account.id, "https://example.com/desired");
  const updated = await accountManager.setProfileLinkResult(account.id, {
    status: "MISMATCH", observedUrl: "https://example.com/different", failureReason: "Observed link differs from desired link after apply.",
  });
  assert.equal(updated.profileLinkStatus, "MISMATCH");
  assert.equal(updated.observedProfileLink, "https://example.com/different");
  assert.equal(updated.linkFailureReason, "Observed link differs from desired link after apply.");
});

test("setProfileLinkResult rejects an unknown status value", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Bad Link Status Account");
  await assert.rejects(() => accountManager.setProfileLinkResult(account.id, { status: "PENDING_REVIEW_XYZ" }));
});

test("setCapabilities/setPool/setProfileLinkIntent all reject an unknown accountId (no silent no-op that could hide a caller bug)", async () => {
  const { accountManager } = await freshAccountManager();
  await assert.rejects(() => accountManager.setCapabilities("does-not-exist", { privacyStatus: "PUBLIC" }));
  await assert.rejects(() => accountManager.setPool("does-not-exist", { pool: "ACTIVE" }));
  await assert.rejects(() => accountManager.setProfileLinkIntent("does-not-exist", "https://example.com/a"));
});

test("setCapabilities persists linkMechanisms and it survives a reload from disk, always carrying all five mechanism keys", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Link Mechanisms Account");
  const updated = await accountManager.setCapabilities(account.id, {
    linkCapability: "AVAILABLE",
    linkMechanisms: { PROFILE_WEBSITE: "AVAILABLE" },
  });
  assert.deepEqual(updated.linkMechanisms, {
    PROFILE_WEBSITE: "AVAILABLE", DESTINATION_LINK: "UNKNOWN", VIDEO_LINK: "UNKNOWN", COMMENT_ANCHOR: "UNKNOWN", BUSINESS_PAGE: "UNKNOWN",
  });

  delete require.cache[require.resolve("../src/account-manager")];
  const reloaded = require("../src/account-manager");
  const reloadedAccount = await reloaded.getAccountById(account.id);
  assert.equal(reloadedAccount.linkMechanisms.PROFILE_WEBSITE, "AVAILABLE");
});

test("setCapabilities ignores an unrecognized mechanism name rather than inventing a new one", async () => {
  const { accountManager } = await freshAccountManager();
  const account = await accountManager.addAccount("Unknown Mechanism Account");
  const updated = await accountManager.setCapabilities(account.id, {
    linkMechanisms: { PROFILE_WEBSITE: "AVAILABLE", MADE_UP_MECHANISM: "AVAILABLE" },
  });
  assert.equal("MADE_UP_MECHANISM" in updated.linkMechanisms, false);
});
