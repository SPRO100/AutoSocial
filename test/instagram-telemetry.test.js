const test = require("node:test");
const assert = require("node:assert/strict");

function installFake(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
  return resolved;
}

test("Instagram acquisition failure is reported before external action", async () => {
  const browserSessionPath = require.resolve("../src/browser-session");
  const uploaderPath = require.resolve("../src/instagram-uploader");
  const configPath = require.resolve("../src/config");
  const originalBrowser = require.cache[browserSessionPath];
  const originalUploader = require.cache[uploaderPath];
  const originalConfig = require.cache[configPath];
  process.env.FAILURE_HOLD_MS = "0";
  delete require.cache[configPath];
  installFake("../src/browser-session", {
    acquireBrowserSession: async () => { throw new Error("Persona CDP attach failed"); },
  });
  delete require.cache[uploaderPath];
  const uploader = require("../src/instagram-uploader");
  try {
    const result = await uploader.uploadMedia({ mediaPaths: "/tmp/synthetic.mp4", caption: "safe", accountId: "synthetic" });
    assert.equal(result.ok, false);
    assert.equal(result.phase, "SESSION_ACQUIRE");
    assert.equal(result.externalActionStarted, false);
    assert.equal(result.postClick, false);
    assert.equal(result.navigationStarted, false);
    assert.equal(result.mediaUploadStarted, false);
  } finally {
    if (originalConfig) require.cache[configPath] = originalConfig; else delete require.cache[configPath];
    if (originalBrowser) require.cache[browserSessionPath] = originalBrowser; else delete require.cache[browserSessionPath];
    if (originalUploader) require.cache[uploaderPath] = originalUploader; else delete require.cache[uploaderPath];
    delete process.env.FAILURE_HOLD_MS;
  }
});
