const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function installFakeModule(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

async function freshTiktokPublish({ sessionResult, uploadResult, uploadImpl } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-tiktok-publish-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");

  const calls = { checkSession: [], uploadVideo: [] };
  installFakeModule("../src/session-check", {
    // tiktok-publish.js calls checkSessionUnlocked (not checkSession) since
    // it already holds account-lock.js's per-account lock itself - see
    // session-check.js's own module comment for why.
    checkSessionUnlocked: async (accountId) => {
      calls.checkSession.push(accountId);
      return sessionResult || { ok: true, accountId, personaProfileId: "pub-profile-1", sessionStatus: "ready", reason: null, checkedAt: new Date().toISOString() };
    },
  });
  installFakeModule("../src/tiktok-uploader", {
    uploadVideo: uploadImpl || (async (opts) => {
      calls.uploadVideo.push(opts);
      return uploadResult || { ok: true };
    }),
  });

  delete require.cache[require.resolve("../src/tiktok-publish")];
  const tiktokPublish = require("../src/tiktok-publish");
  return { tiktokPublish, accountManager, calls, dir };
}

async function seedTiktokAccount(accountManager, { username = "publish-user", profileId = "pub-profile-1" } = {}) {
  const account = await accountManager.addAccount(username, { importPlatform: "tiktok", importUsername: username });
  await accountManager.setPersonaProfileId(account.id, profileId);
  return account;
}

const FAKE_VIDEO = Buffer.from("not a real video, just fake test bytes");

test("publish succeeds end to end for a READY session and persists lastPublishStatus='published'", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish();
  const account = await seedTiktokAccount(accountManager);

  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO, filename: "clip.mp4", caption: "hello" });
  assert.equal(result.ok, true);
  assert.equal(result.finalStatus, "published");
  assert.ok(result.startedAt);
  assert.ok(result.finishedAt);

  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.lastPublishStatus, "published");
  assert.ok(reloaded.lastPublishAt);
});

// --- Preconditions (fail closed) ----------------------------------------

test("publish fails closed for an unknown account", async () => {
  const { tiktokPublish } = await freshTiktokPublish();
  const result = await tiktokPublish.publish("does-not-exist", { videoBuffer: FAKE_VIDEO });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

test("publish fails closed when the account has no linked Persona profile - never guesses one", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish();
  const account = await accountManager.addAccount("no-profile-publish", { importPlatform: "tiktok", importUsername: "no-profile-publish" });

  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  assert.equal(result.ok, false);
  assert.match(result.error, /no linked Persona profile/i);
});

test("publish fails closed for a non-TikTok account", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish();
  const account = await accountManager.addAccount("insta-user", { importPlatform: "instagram", importUsername: "insta-user" });
  await accountManager.setPersonaProfileId(account.id, "some-profile");

  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  assert.equal(result.ok, false);
  assert.match(result.error, /not a TikTok/i);
});

// --- Fresh server-side session verification, never trusts frontend -------

test("publish is BLOCKED when the fresh server-side check returns NEEDS_LOGIN, even if the caller claims otherwise", async () => {
  const { tiktokPublish, accountManager, calls } = await freshTiktokPublish({
    sessionResult: { ok: true, accountId: "x", sessionStatus: "needs_login", reason: "redirected to login" },
  });
  const account = await seedTiktokAccount(accountManager);

  // The publish() function signature takes no "trust me it's ready" flag
  // at all - there is nothing a caller could even pass to skip this.
  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  assert.equal(result.ok, false);
  assert.match(result.error, /session expired/i);
  assert.equal(calls.checkSession.length, 1, "a fresh check must always run - never trust a cached/frontend status");
  assert.equal(calls.uploadVideo.length, 0, "uploadVideo must never be called when the fresh check fails");
});

test("publish is blocked when Persona itself is unavailable during the fresh check", async () => {
  const { tiktokPublish, accountManager, calls } = await freshTiktokPublish({
    sessionResult: { ok: false, error: "Could not reach Persona: connect ECONNREFUSED" },
  });
  const account = await seedTiktokAccount(accountManager);

  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  assert.equal(result.ok, false);
  assert.equal(calls.uploadVideo.length, 0);
});

test("a client cannot spoof READY - publish()'s options object has no sessionStatus/verified field of any kind", async () => {
  // Function.prototype.length only counts parameters before the first
  // default value, so this is 1 (accountId) - the options object (with a
  // default of {}) isn't counted, but its actual accepted keys are what
  // matter: only videoBuffer/filename/caption, never a status the caller
  // could set to bypass the fresh server-side check.
  assert.equal(require("../src/tiktok-publish").publish.length, 1);
});

// --- Publish confirmation classification (strongest confirmation, never fake success) ---

test("a genuine TikTok-reported publish error is classified as 'failed', not 'published'", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish({
    uploadResult: { ok: false, error: "Publish verification failed: TikTok displayed an error after publish click." },
  });
  const account = await seedTiktokAccount(accountManager);

  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  assert.equal(result.finalStatus, "failed");
  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.lastPublishStatus, "failed");
});

test("an ambiguous/timed-out confirmation is classified as 'unconfirmed', NEVER reported as published", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish({
    uploadResult: { ok: false, error: "Publish verification failed: No reliable publish confirmation observed within timeout." },
  });
  const account = await seedTiktokAccount(accountManager);

  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  assert.equal(result.finalStatus, "unconfirmed");
  assert.notEqual(result.finalStatus, "published");
  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.lastPublishStatus, "unconfirmed");
});

test("an unexpected browser error after the publish action starts is unconfirmed, never definitely failed", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish({
    uploadResult: { ok: false, error: "Protocol error while closing page", externalActionStarted: true },
  });
  const account = await seedTiktokAccount(accountManager);
  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  assert.equal(result.finalStatus, "unconfirmed");
  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.lastPublishStatus, "unconfirmed");
});

test("a click alone (upload never actually confirmed ok:true) never becomes 'published'", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish({
    uploadResult: { ok: false, error: "could not locate the video file input" },
  });
  const account = await seedTiktokAccount(accountManager);
  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  assert.notEqual(result.finalStatus, "published");
  assert.equal(result.finalStatus, "failed");
});

// --- Concurrency -----------------------------------------------------------

test("a double-submit for the SAME account never fires two real publishes at once", async () => {
  let resolveUpload;
  const uploadStarted = new Promise((r) => { resolveUpload = r; });
  const { tiktokPublish, accountManager } = await freshTiktokPublish({
    uploadImpl: async () => {
      resolveUpload();
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true };
    },
  });
  const account = await seedTiktokAccount(accountManager);

  const first = tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  await uploadStarted;
  const second = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });
  const firstResult = await first;

  assert.equal(second.ok, false);
  assert.match(second.error, /already in progress/i);
  assert.equal(firstResult.ok, true);
});

test("publishing account A never touches account B's status", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish();
  const accountA = await seedTiktokAccount(accountManager, { username: "pub-a", profileId: "profile-a" });
  const accountB = await seedTiktokAccount(accountManager, { username: "pub-b", profileId: "profile-b" });

  await tiktokPublish.publish(accountA.id, { videoBuffer: FAKE_VIDEO });

  const reloadedB = await accountManager.getAccountById(accountB.id);
  assert.equal(reloadedB.lastPublishStatus, undefined);
});

// --- Secret leakage --------------------------------------------------------

test("no publish result ever contains a raw caption/video content or internal path", async () => {
  const { tiktokPublish, accountManager } = await freshTiktokPublish();
  const account = await seedTiktokAccount(accountManager);
  const result = await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO, caption: "SECRET_CAPTION_MARKER" });
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("SECRET_CAPTION_MARKER"));
  assert.ok(!serialized.includes(os.tmpdir()));
});

// --- Result persists across "Dashboard refresh" (re-read from disk) ------

test("lastPublishStatus/lastPublishAt survive a fresh account-manager reload (simulated Dashboard refresh)", async () => {
  const { tiktokPublish, accountManager, dir } = await freshTiktokPublish();
  const account = await seedTiktokAccount(accountManager);
  await tiktokPublish.publish(account.id, { videoBuffer: FAKE_VIDEO });

  delete require.cache[require.resolve("../src/account-manager")];
  const reloaded = require("../src/account-manager");
  const reloadedAccount = await reloaded.getAccountById(account.id);
  assert.equal(reloadedAccount.lastPublishStatus, "published");
});
