const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

// Exercises the real, exported uploader entry point every dashboard/CLI
// caller actually uses (getLoginSessionStatus), through the real
// account-manager + persona-browser modules (only global.fetch is mocked -
// no real network, no real browser launched). Confirms requirement #8
// (saved-session detection) is correctly wired for all three platforms,
// not just unit-tested in isolation inside account-manager.test.js.

async function freshUploaderModules() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-uploader-status-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");

  for (const modulePath of [
    "../src/account-manager",
    "../src/persona-browser",
    "../src/browser-session",
    "../src/tiktok-uploader",
    "../src/instagram-uploader",
    "../src/youtube-uploader",
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }

  const accountManager = require("../src/account-manager");
  const tiktokUploader = require("../src/tiktok-uploader");
  const instagramUploader = require("../src/instagram-uploader");
  const youtubeUploader = require("../src/youtube-uploader");
  return { accountManager, tiktokUploader, instagramUploader, youtubeUploader };
}

for (const [platform, uploaderKey] of [
  ["tiktok", "tiktokUploader"],
  ["instagram", "instagramUploader"],
  ["youtube", "youtubeUploader"],
]) {
  test(`${platform}-uploader getLoginSessionStatus reports saved=true for a Persona-backed active account, with no open session`, async () => {
    const modules = await freshUploaderModules();
    const account = await modules.accountManager.addAccount(`${platform} Persona Account`);
    await modules.accountManager.setPersonaProfileId(account.id, "6a34ff44d3e1");
    await modules.accountManager.selectAccount(account.id);

    const originalFetch = global.fetch;
    global.fetch = async () =>
      new Response(JSON.stringify([{ id: "6a34ff44d3e1" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const status = await modules[uploaderKey].getLoginSessionStatus();
      assert.equal(status.saved, true);
      assert.equal(status.open, false, "no session was actually started in this test");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test(`${platform}-uploader getLoginSessionStatus reports saved=false for a brand-new legacy account with no browser profile on disk`, async () => {
    const modules = await freshUploaderModules();
    const account = await modules.accountManager.addAccount(`${platform} Legacy Account`);
    await modules.accountManager.selectAccount(account.id);

    const status = await modules[uploaderKey].getLoginSessionStatus();
    assert.equal(status.saved, false);
    assert.equal(status.open, false);
  });
}
