// Regression test for a real P1 finding from independent review: two
// overlapping operations on the SAME account (a manual "Check session"
// click racing an in-flight publish) used to be able to race each other's
// Persona running/stopped-state snapshot-and-restore logic, with the
// second caller potentially stopping a profile the first was still
// actively using mid-upload. Fixed by giving session-check.js#checkSession
// and tiktok-publish.js#publish a single SHARED per-account lock
// (account-lock.js) - this test proves a manual checkSession() call made
// while a publish is in flight for that same account is rejected cleanly
// ("busy"), never allowed to race forward and touch the profile.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function installFakeModule(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

function makeFakePage() {
  return {
    goto: async () => {},
    waitForLoadState: async () => {},
    url: () => "https://www.tiktok.com/tiktokstudio/upload",
  };
}

test("a manual checkSession() call is rejected as busy while a publish for the same account is in flight - never races the Persona lifecycle restore", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-lock-race-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");

  const calls = { stopPersonaProfile: [], attachPersonaProfile: 0 };
  const fakePersona = {
    listPersonaProfiles: async () => [{ id: "lock-race-profile", name: "x", status: "stopped", tags: [] }],
    attachPersonaProfile: async (id) => {
      calls.attachPersonaProfile += 1;
      return { profileId: id, page: makeFakePage(), browser: {}, context: {}, info: { port: 1 } };
    },
    disconnectPersonaBrowser: async () => {},
    stopPersonaProfile: async (id) => { calls.stopPersonaProfile.push(id); },
    PersonaApiError: class PersonaApiError extends Error {},
  };
  installFakeModule("../src/persona-browser", fakePersona);

  // uploadVideo blocks until the test explicitly releases it, so the
  // publish() call below is guaranteed to still hold the account lock when
  // the manual checkSession() call is made.
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  let uploadStarted;
  const uploadStartedPromise = new Promise((resolve) => { uploadStarted = resolve; });
  installFakeModule("../src/tiktok-uploader", {
    uploadVideo: async () => {
      uploadStarted();
      await uploadGate;
      return { ok: true };
    },
  });

  delete require.cache[require.resolve("../src/account-lock")];
  delete require.cache[require.resolve("../src/session-check")];
  delete require.cache[require.resolve("../src/tiktok-publish")];
  const accountLock = require("../src/account-lock");
  const sessionCheck = require("../src/session-check");
  const tiktokPublish = require("../src/tiktok-publish");

  const account = await accountManager.addAccount("lock-race-user", { importPlatform: "tiktok", importUsername: "lock-race-user" });
  await accountManager.setPersonaProfileId(account.id, "lock-race-profile");

  const publishPromise = tiktokPublish.publish(account.id, {
    videoBuffer: Buffer.from("fake video bytes"),
    filename: "clip.mp4",
    caption: "hello",
  });

  await uploadStartedPromise;
  // At this point publish()'s OWN internal checkSessionUnlocked step has
  // already legitimately run once (the fake profile starts "stopped", so
  // that step stops it again itself, before uploadVideo even starts) -
  // capture that count as the baseline the concurrent check must not add to.
  const stopsBeforeConcurrentCheck = calls.stopPersonaProfile.length;

  // The publish is now mid-upload, still holding the account lock. A
  // concurrent manual "Check session" click for the SAME account must be
  // rejected cleanly - not race forward and attach/stop the profile.
  const manualCheck = await sessionCheck.checkSession(account.id);
  assert.equal(manualCheck.ok, false);
  assert.match(manualCheck.error, /busy/i);
  // The manual check must never have attempted its own attach or stop -
  // proof it was rejected up front, not raced and merely lost a later step.
  assert.equal(calls.stopPersonaProfile.length, stopsBeforeConcurrentCheck, "no additional stop must happen from the rejected concurrent check");

  releaseUpload();
  const publishResult = await publishPromise;
  assert.equal(publishResult.ok, true);
  assert.equal(publishResult.finalStatus, "published");

  // Lock must be released after publish finishes - a later check succeeds.
  assert.equal(accountLock.tryLock(account.id), true);
  accountLock.unlock(account.id);
});
