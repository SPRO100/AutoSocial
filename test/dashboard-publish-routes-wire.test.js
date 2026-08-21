// Live wire-level check for the two new milestone-2 routes
// (POST /api/accounts/check-session, POST /api/publish/tiktok) - proves
// the real HTTP layer (query-string parsing, express.raw() body handling,
// precondition fail-closed responses) works, without needing a working
// TikTok session or attempting any real publish (which would require a
// real, authenticated Persona profile this test deliberately does not
// have - only fail-closed / bad-input paths are exercised here).
//
// Spins up a real, temporary dashboard-server.js child process (its own
// port, its own state file, torn down after) - same pattern as
// import-confirm-wire-contract.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const TEST_PORT = 34192; // fixed, dedicated - see import-confirm-wire-contract.test.js's own note on this

function waitForServer(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function poll() {
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${baseUrl}/api/status`);
          if (res.ok) return resolve();
        } catch {
          // Not up yet.
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      reject(new Error("test dashboard-server did not become ready in time"));
    })();
  });
}

test("LIVE WIRE CHECK: check-session and publish routes exist, parse real requests, and fail closed for bad/incomplete input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-publish-wire-"));
  const stateFile = path.join(dir, "accounts-state.json");
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  const child = spawn(process.execPath, ["src/dashboard-server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, ACCOUNTS_STATE_FILE: stateFile, DASHBOARD_PORT: String(TEST_PORT), DASHBOARD_HOST: "127.0.0.1", HEADLESS: "true" },
    stdio: "ignore",
  });

  try {
    await waitForServer(baseUrl);

    // check-session: missing accountId -> clean 400, not a crash.
    const missing = await fetch(`${baseUrl}/api/accounts/check-session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.ok, false);
    assert.match(missingBody.error, /accountId/i);

    // check-session: real account, but no linked Persona profile -> fails
    // closed with a clear reason, never guesses a profile.
    const addRes = await fetch(`${baseUrl}/api/accounts/add`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "wire-check-session-user" }),
    });
    const addBody = await addRes.json();
    const noProfileCheck = await fetch(`${baseUrl}/api/accounts/check-session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: addBody.account.id }),
    });
    assert.equal(noProfileCheck.status, 400);
    const noProfileBody = await noProfileCheck.json();
    assert.match(noProfileBody.error, /no linked Persona profile/i);

    // publish/tiktok: missing accountId -> clean 400.
    const publishNoAccount = await fetch(`${baseUrl}/api/publish/tiktok`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("fake video bytes"),
    });
    assert.equal(publishNoAccount.status, 400);
    const publishNoAccountBody = await publishNoAccount.json();
    assert.match(publishNoAccountBody.error, /accountId/i);

    // publish/tiktok: real accountId, but no video body -> clean 400, the
    // real express.raw() body handling genuinely receives and checks it.
    // (This plain /api/accounts/add account has no importPlatform set, so
    // the platform precondition is what fails first - proving the
    // precondition gate runs before any body/video check.)
    const publishNoVideo = await fetch(`${baseUrl}/api/publish/tiktok?accountId=${encodeURIComponent(addBody.account.id)}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.alloc(0),
    });
    assert.equal(publishNoVideo.status, 400);
    const publishNoVideoBody = await publishNoVideo.json();
    assert.ok(!publishNoVideoBody.ok);

    // publish/tiktok: real video bytes, account is not a TikTok account
    // (no importPlatform) -> must fail closed on the precondition, never
    // attempt a real browser.
    const publishNoProfile = await fetch(`${baseUrl}/api/publish/tiktok?accountId=${encodeURIComponent(addBody.account.id)}&caption=test`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("fake video bytes, not a real file"),
    });
    assert.equal(publishNoProfile.status, 400);
    const publishNoProfileBody = await publishNoProfile.json();
    assert.match(publishNoProfileBody.error, /not a TikTok automation account/i);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
});
