// Regression test for the actual production incident this milestone
// investigated: Update Session appeared to "not work" in the real
// Dashboard. Root cause was a deployment gap (CONTENT-OS's production
// process was never restarted after the feature shipped), NOT a code bug
// anywhere in the chain - but that gap was only findable by checking the
// real request Content OS's client sends against what AutoSocial's real
// HTTP route (not just the in-process pipeline function) actually
// consumes. This test closes that specific gap in coverage: it spins up a
// REAL, temporary dashboard-server.js instance (a fixed port dedicated to
// this test - see TEST_PORT below, never 3000 - and its own isolated
// accounts-state.json, torn down at the end of the test) and
// proves the exact wire format - `updateSessionKeys` in the JSON body of
// POST /api/import/confirm - is correctly read and forwarded into
// importBatch(), using the same key shape buildPreview() actually returns
// (never recomputed by the caller, matching how the real Content OS
// client behaves - it only ever echoes back a key it was given).
//
// This is a genuinely temporary, single-test-scoped child process - not
// the persistent manual "node src/dashboard-server.js" the production
// deployment rules forbid. It is always killed in a finally block, on its
// own port, never 3000.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { config } = require("../src/config");

// A fixed, dedicated port - not randomized. Chosen to be unlikely to
// collide with anything else on this host or CI runner; if this suite ever
// needs to run several times concurrently on the same machine, this would
// need to become genuinely randomized (e.g. bind to port 0 and read back
// the assigned port) - noted, not needed for this milestone's usage.
const TEST_PORT = 34191;

async function isPersonaReachable() {
  try {
    const res = await fetch(`${config.personaApiUrl}/api/profiles`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

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

test("REGRESSION: the real HTTP route (not just the in-process function) correctly reads updateSessionKeys from POST /api/import/confirm and applies it to the matching record", async (t) => {
  if (!(await isPersonaReachable())) {
    t.skip("persona-api.service is not reachable in this environment - skipping the live wire-contract regression test");
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-wire-contract-"));
  const stateFile = path.join(dir, "accounts-state.json");
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  const child = spawn(process.execPath, ["src/dashboard-server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      ACCOUNTS_STATE_FILE: stateFile,
      DASHBOARD_PORT: String(TEST_PORT),
      DASHBOARD_HOST: "127.0.0.1",
      HEADLESS: "true",
    },
    stdio: "ignore",
  });
  let createdProfileId = null;

  try {
    await waitForServer(baseUrl);

    // Seed a genuinely "already imported" account by actually running the
    // real import flow once through the real HTTP routes first (the only
    // way an account gets real importPlatform/importUsername provenance
    // fields set - the plain manual /api/accounts/add route does not set
    // these, so it would never be recognized as an update-eligible
    // duplicate). This creates one real, throwaway Persona profile,
    // deleted in the finally block below.
    const supplierLine = "wire-contract-user|FakePass1|wire-contract-user@example.com|FakeMailPass1|fake-token-1|ext-001|sessionid=FAKEVAL";
    const seedPreviewRes = await fetch(`${baseUrl}/api/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: supplierLine }),
    });
    const seedPreviewBody = await seedPreviewRes.json();
    const seedConfirmRes = await fetch(`${baseUrl}/api/import/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importId: seedPreviewBody.importId, concurrency: 1 }),
    });
    const seedConfirmBody = await seedConfirmRes.json();
    const [seedResult] = seedConfirmBody.report.results;
    assert.equal(seedResult.autosocial, "Created", "seeding must have actually created the account for real, provenance and all");
    createdProfileId = seedResult.personaProfileId;

    // Now re-preview the SAME file - the real production scenario
    // (re-uploading a supplier file for an already-imported account).
    const previewRes = await fetch(`${baseUrl}/api/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: supplierLine }),
    });
    const previewBody = await previewRes.json();
    assert.equal(previewBody.ok, true);
    assert.equal(previewBody.preview.length, 1);
    const [record] = previewBody.preview;
    assert.equal(record.alreadyImported, true);
    assert.equal(record.canUpdateSession, true);
    assert.ok(record.key, "the real route must return a real key for an update-eligible record");

    // Confirm WITHOUT updateSessionKeys - the exact request the stale,
    // pre-fix production UI actually sent. Must stay SKIPPED_DUPLICATE.
    const confirmSkipRes = await fetch(`${baseUrl}/api/import/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ importId: previewBody.importId, concurrency: 1 }),
    });
    const confirmSkipBody = await confirmSkipRes.json();
    assert.equal(confirmSkipBody.report.results[0].status, "SKIPPED_DUPLICATE");

    // Re-preview (the store is single-use) and confirm WITH the exact key
    // the real route returned, echoed back exactly as the real client
    // does - never recomputed - proving the wire contract actually works
    // end to end through the real HTTP layer, not just importBatch()
    // called directly in-process.
    const previewRes2 = await fetch(`${baseUrl}/api/import/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: supplierLine }),
    });
    const previewBody2 = await previewRes2.json();
    const confirmUpdateRes = await fetch(`${baseUrl}/api/import/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        importId: previewBody2.importId,
        concurrency: 1,
        updateSessionKeys: [previewBody2.preview[0].key],
      }),
    });
    const confirmUpdateBody = await confirmUpdateRes.json();
    const [updateResult] = confirmUpdateBody.report.results;
    assert.equal(updateResult.autosocial, "Existing", "the real route must have actually branched into Update Session, not silently skipped it");
    assert.notEqual(updateResult.status, "SKIPPED_DUPLICATE");
  } finally {
    if (createdProfileId) {
      await fetch(`${config.personaApiUrl}/api/profiles/${createdProfileId}`, { method: "DELETE" }).catch(() => {});
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
});
