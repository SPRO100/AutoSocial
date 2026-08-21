const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function installFakeModule(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsValue };
}

function makeFakePage(finalUrl) {
  return {
    goto: async () => {},
    waitForLoadState: async () => {},
    url: () => finalUrl,
  };
}

const ACTIVE_URL = "https://www.tiktok.com/tiktokstudio/upload";
const LOGIN_URL = "https://www.tiktok.com/login?redirect_url=%2Ftiktokstudio%2Fupload";

// A fresh account-manager (own temp state file) AND a fresh pipeline.js
// with persona-browser faked out (no real Persona API, no real Chromium) -
// same module-cache-substitution convention as persona-browser.test.js and
// account-manager.test.js.
async function freshPipeline({ persona = {}, sessionUrl = ACTIVE_URL } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-import-pipeline-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");

  let personaIdCounter = 0;
  const calls = { deletePersonaProfile: [], importPersonaCookies: [], attachPersonaProfile: [], stopPersonaProfile: [] };

  const fakePersona = {
    createPersonaProfile: async ({ name, tags }) => ({
      id: `persona-${++personaIdCounter}`,
      name,
      status: "stopped",
      tags: tags || [],
    }),
    importPersonaCookies: async (profileId, opts) => {
      calls.importPersonaCookies.push({ profileId, opts });
      return { ok: true, imported: 1 };
    },
    attachPersonaProfile: async (profileId) => {
      calls.attachPersonaProfile.push(profileId);
      return { profileId, page: makeFakePage(sessionUrl), browser: {}, context: {}, info: { port: 1 } };
    },
    disconnectPersonaBrowser: async () => {},
    stopPersonaProfile: async (profileId) => {
      calls.stopPersonaProfile.push(profileId);
    },
    deletePersonaProfile: async (profileId) => {
      calls.deletePersonaProfile.push(profileId);
    },
    listPersonaProfiles: async () => [],
    personaProfileExists: async () => true,
    startPersonaBrowser: async () => ({}),
    PersonaApiError: class PersonaApiError extends Error {},
    ...persona,
  };
  installFakeModule("../src/persona-browser", fakePersona);

  delete require.cache[require.resolve("../src/importers/pipeline")];
  const pipeline = require("../src/importers/pipeline");
  return { pipeline, accountManager, fakePersona, calls, dir };
}

function tiktokRecord(username, overrides = {}) {
  return { platform: "tiktok", username, password: "pw", cookies: "sessionid=abc123", ...overrides };
}

test("a fully successful import creates the account, creates+links a Persona profile, imports cookies, and verifies an active session -> READY", async () => {
  const { pipeline, accountManager } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const report = await pipeline.importBatch([tiktokRecord("account1")]);

  assert.equal(report.total, 1);
  assert.equal(report.successful, 1);
  assert.equal(report.needsLogin, 0);
  assert.equal(report.failed, 0);

  const [result] = report.results;
  assert.equal(result.status, "READY");
  assert.equal(result.autosocial, "Created");
  assert.equal(result.persona, "Created");
  assert.equal(result.cookies, "Imported");
  assert.equal(result.session, "Active");

  const account = await accountManager.getAccountById(result.accountId);
  assert.ok(account, "the AutoSocial account must actually exist");
  assert.equal(account.personaProfileId, result.personaProfileId);
});

test("an invalid/expired session -> NEEDS_LOGIN, and the account/profile are kept (not rolled back) for a retry", async () => {
  const { pipeline, accountManager } = await freshPipeline({ sessionUrl: LOGIN_URL });
  const report = await pipeline.importBatch([tiktokRecord("account2")]);

  const [result] = report.results;
  assert.equal(result.status, "NEEDS_LOGIN");
  assert.equal(result.session, "Invalid");
  assert.equal(report.needsLogin, 1);

  const account = await accountManager.getAccountById(result.accountId);
  assert.ok(account, "NEEDS_LOGIN must not roll back a coherent account+profile+cookies");
  assert.equal(account.personaProfileId, result.personaProfileId);
});

test("Persona profile creation failure rolls back the AutoSocial account - no orphan account left behind", async () => {
  const { pipeline, accountManager } = await freshPipeline({
    persona: { createPersonaProfile: async () => { throw new Error("Persona API unreachable"); } },
  });
  const report = await pipeline.importBatch([tiktokRecord("account3")]);

  const [result] = report.results;
  assert.equal(result.status, "FAILED");
  assert.equal(result.autosocial, "Rolled back");
  assert.equal(result.persona, "Failed");

  const all = await accountManager.getAllAccounts();
  assert.ok(!all.some((a) => a.importUsername === "account3"), "a failed Persona creation must not leave an orphan AutoSocial account");
});

test("cookie import failure rolls back BOTH the Persona profile (real delete call) and the AutoSocial account", async () => {
  const { pipeline, accountManager, calls } = await freshPipeline({
    persona: { importPersonaCookies: async () => { throw new Error("Persona rejected the cookies"); } },
  });
  const report = await pipeline.importBatch([tiktokRecord("account4")]);

  const [result] = report.results;
  assert.equal(result.status, "FAILED");
  assert.equal(result.autosocial, "Rolled back");
  assert.equal(result.persona, "Rolled back");
  assert.equal(result.cookies, "Failed");
  assert.equal(calls.deletePersonaProfile.length, 1, "the orphaned Persona profile must be deleted via the real rollback primitive");

  const all = await accountManager.getAllAccounts();
  assert.ok(!all.some((a) => a.importUsername === "account4"));
});

test("cookie data that cannot be converted into anything Persona understands rolls back cleanly instead of sending garbage to Persona", async () => {
  const { pipeline, accountManager, fakePersona } = await freshPipeline();
  let importCalled = false;
  fakePersona.importPersonaCookies = async () => { importCalled = true; };
  const report = await pipeline.importBatch([
    tiktokRecord("account-unparseable-cookies", { cookies: "not cookie data at all" }),
  ]);

  const [result] = report.results;
  assert.equal(result.status, "FAILED");
  assert.equal(result.cookies, "Failed");
  assert.equal(result.autosocial, "Rolled back");
  assert.equal(importCalled, false, "must never call Persona's cookie import with unparseable data");

  const all = await accountManager.getAllAccounts();
  assert.ok(!all.some((a) => a.importUsername === "account-unparseable-cookies"));
});

test("a record with no cookies field skips cookie import cleanly and still proceeds to verification", async () => {
  const { pipeline, calls } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const report = await pipeline.importBatch([tiktokRecord("account5", { cookies: undefined })]);

  const [result] = report.results;
  assert.equal(result.cookies, "Skipped (none provided)");
  assert.equal(result.status, "READY");
  assert.equal(calls.importPersonaCookies.length, 0);
});

test("session verification throwing (e.g. attach fails) is reported FAILED but does NOT roll back the account/profile/cookies", async () => {
  const { pipeline, accountManager } = await freshPipeline({
    persona: { attachPersonaProfile: async () => { throw new Error("Persona attach timed out"); } },
  });
  const report = await pipeline.importBatch([tiktokRecord("account6")]);

  const [result] = report.results;
  assert.equal(result.status, "FAILED");
  assert.equal(result.session, "Unknown");
  assert.equal(result.autosocial, "Created");
  assert.equal(result.persona, "Created");

  const account = await accountManager.getAccountById(result.accountId);
  assert.ok(account, "an attach/verification failure must not destroy an already-coherent account+profile+cookies");
});

test("verification always disconnects and stops the Persona profile afterward, whether the session was active or not", async () => {
  const { pipeline, calls } = await freshPipeline({ sessionUrl: LOGIN_URL });
  await pipeline.importBatch([tiktokRecord("account7")]);
  assert.equal(calls.attachPersonaProfile.length, 1);
  assert.equal(calls.stopPersonaProfile.length, 1);
});

test("one bad record in a batch does not abort the rest - failures are isolated per record", async () => {
  const { pipeline } = await freshPipeline({
    persona: {
      createPersonaProfile: async ({ name }) => {
        if (name.includes("bad-account")) throw new Error("simulated failure for this one account");
        return { id: `persona-${name}`, name, status: "stopped", tags: [] };
      },
    },
  });
  const report = await pipeline.importBatch([
    tiktokRecord("good-account-1"),
    tiktokRecord("bad-account"),
    tiktokRecord("good-account-2"),
  ]);

  assert.equal(report.total, 3);
  assert.equal(report.successful, 2);
  assert.equal(report.failed, 1);
  const byUsername = Object.fromEntries(report.results.map((r) => [r.username, r]));
  assert.equal(byUsername["good-account-1"].status, "READY");
  assert.equal(byUsername["bad-account"].status, "FAILED");
  assert.equal(byUsername["good-account-2"].status, "READY");
});

test("re-importing an account already linked from a prior import is a safe no-op (SKIPPED_DUPLICATE), never a second account", async () => {
  const { pipeline, accountManager } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const first = await pipeline.importBatch([tiktokRecord("account8")]);
  assert.equal(first.results[0].status, "READY");

  const second = await pipeline.importBatch([tiktokRecord("account8")]);
  assert.equal(second.results[0].status, "SKIPPED_DUPLICATE");
  assert.equal(second.skipped, 1);

  const all = await accountManager.getAllAccounts();
  const matches = all.filter((a) => a.importUsername === "account8");
  assert.equal(matches.length, 1, "re-importing the same platform/username must never create a second account");
});

test("two identical records within the SAME batch (e.g. a supplier file with a duplicated line) never race into two accounts", async () => {
  const { pipeline, accountManager } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const report = await pipeline.importBatch(
    [tiktokRecord("account9"), tiktokRecord("account9")],
    { concurrency: 2 }
  );
  const statuses = report.results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["READY", "SKIPPED_DUPLICATE"]);

  const all = await accountManager.getAllAccounts();
  assert.equal(all.filter((a) => a.importUsername === "account9").length, 1);
});

test("two overlapping importBatch() calls for the SAME record (e.g. the same file confirmed twice from two tabs) never race into two accounts", async () => {
  const { pipeline, accountManager } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const [reportA, reportB] = await Promise.all([
    pipeline.importBatch([tiktokRecord("cross-request-account")]),
    pipeline.importBatch([tiktokRecord("cross-request-account")]),
  ]);
  const statuses = [reportA.results[0].status, reportB.results[0].status].sort();
  assert.deepEqual(statuses, ["READY", "SKIPPED_DUPLICATE"]);

  const all = await accountManager.getAllAccounts();
  assert.equal(all.filter((a) => a.importUsername === "cross-request-account").length, 1);
});

test("the process-wide claim releases after a batch finishes, so a genuinely later import of the same key is not blocked forever", async () => {
  const { pipeline } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const first = await pipeline.importBatch([tiktokRecord("release-check")]);
  assert.equal(first.results[0].status, "READY");
  // Second call finds a real existing account (findAccountByImportSource),
  // not a stale in-flight claim - still correctly SKIPPED_DUPLICATE, but
  // for the right reason.
  const second = await pipeline.importBatch([tiktokRecord("release-check")]);
  assert.equal(second.results[0].status, "SKIPPED_DUPLICATE");
  assert.match(second.results[0].reason, /already imported/);
});

test("requested concurrency is clamped to MAX_CONCURRENCY regardless of what the caller passes", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { pipeline } = await freshPipeline({
    persona: {
      attachPersonaProfile: async (profileId) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { profileId, page: makeFakePage(ACTIVE_URL), browser: {}, context: {}, info: { port: 1 } };
      },
    },
  });
  const records = Array.from({ length: 12 }, (_, i) => tiktokRecord(`clamp-${i}`));
  await pipeline.importBatch(records, { concurrency: 9999 });
  assert.ok(maxInFlight <= pipeline.MAX_CONCURRENCY, `expected at most ${pipeline.MAX_CONCURRENCY}, saw ${maxInFlight}`);
});

test("a Persona profile created just before the create-profile response is lost is still cleaned up (self-heal by deterministic name)", async () => {
  const { pipeline, accountManager, calls } = await freshPipeline({
    persona: {
      createPersonaProfile: async () => { throw new Error("simulated timeout after Persona had already persisted the profile"); },
      listPersonaProfiles: async () => [
        { id: "orphaned-by-timeout", name: "autosocial-tiktok-lost-response-account", status: "stopped", tags: [] },
      ],
    },
  });
  const report = await pipeline.importBatch([tiktokRecord("lost-response-account")]);

  assert.equal(report.results[0].status, "FAILED");
  assert.deepEqual(calls.deletePersonaProfile, ["orphaned-by-timeout"]);

  const all = await accountManager.getAllAccounts();
  assert.ok(!all.some((a) => a.importUsername === "lost-response-account"));
});

test("the self-heal never deletes an unrelated Persona profile that merely happens to already exist", async () => {
  const { pipeline, calls } = await freshPipeline({
    persona: {
      createPersonaProfile: async () => { throw new Error("simulated failure"); },
      listPersonaProfiles: async () => [
        { id: "unrelated-profile", name: "someones-manual-profile", status: "stopped", tags: [] },
      ],
    },
  });
  await pipeline.importBatch([tiktokRecord("no-name-match-account")]);
  assert.deepEqual(calls.deletePersonaProfile, [], "must never delete a profile whose name does not exactly match the one this record would have created");
});

test("concurrency option bounds how many Persona attach operations are in flight at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { pipeline } = await freshPipeline({
    persona: {
      attachPersonaProfile: async (profileId) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return { profileId, page: makeFakePage(ACTIVE_URL), browser: {}, context: {}, info: { port: 1 } };
      },
    },
  });
  const records = Array.from({ length: 6 }, (_, i) => tiktokRecord(`concurrency-${i}`));
  const report = await pipeline.importBatch(records, { concurrency: 2 });

  assert.equal(report.total, 6);
  assert.ok(maxInFlight <= 2, `expected at most 2 concurrent attach operations, saw ${maxInFlight}`);
  assert.ok(maxInFlight >= 1);
});

test("a batch-level report always includes total/successful/needsLogin/failed and a full per-account results array", async () => {
  const { pipeline } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const report = await pipeline.importBatch([tiktokRecord("account-report")]);
  assert.deepEqual(Object.keys(report).sort(), ["failed", "needsLogin", "results", "skipped", "successful", "total"]);
  assert.equal(Array.isArray(report.results), true);
});

test("no result object emitted by importBatch ever contains a raw password or cookie value", async () => {
  const { pipeline } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const report = await pipeline.importBatch([
    tiktokRecord("secret-check", { password: "TotallySecretPW", cookies: "sessionid=TOP_SECRET_TOKEN" }),
  ]);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("TotallySecretPW"));
  assert.ok(!serialized.includes("TOP_SECRET_TOKEN"));
});

// --- buildPreview -------------------------------------------------------

test("buildPreview flags an in-batch duplicate and a previously-imported account, without ever including secrets", async () => {
  const { pipeline, accountManager } = await freshPipeline();
  await accountManager.addAccount("account10", { importPlatform: "tiktok", importUsername: "account10" });

  const preview = await pipeline.buildPreview([
    tiktokRecord("account10", { password: "shh" }),
    tiktokRecord("account11", { password: "shh2" }),
    tiktokRecord("account11", { password: "shh3" }),
  ]);

  assert.equal(preview[0].alreadyImported, true);
  assert.equal(preview[0].duplicateInBatch, false);
  assert.equal(preview[1].duplicateInBatch, false);
  assert.equal(preview[2].duplicateInBatch, true);
  const serialized = JSON.stringify(preview);
  assert.ok(!serialized.includes("shh"));
});
