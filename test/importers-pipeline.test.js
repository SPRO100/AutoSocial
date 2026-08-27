const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

// This file exercises the recovery STATE MACHINE through the real
// pipeline, not real settle timing (that's proven in its own dedicated
// tests in test/session-recovery.test.js) - disabled here so the
// cookie-consent-recovery tests below don't spend several real seconds
// waiting on every run.
process.env.AUTOSOCIAL_RECOVERY_SETTLE_DELAY_MS = "0";

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
  // Tracks every profile "known to exist" in this fake Persona, with its
  // real tags - backs the default listPersonaProfiles() below, and lets
  // tests register a profile Update Session didn't itself create (to
  // simulate the manual-relink scenario updateExistingAccountSession's
  // clear:true safety check must fail closed against).
  const profileRegistry = new Map();
  function registerFakeProfile(id, { name = id, status = "stopped", tags = [] } = {}) {
    profileRegistry.set(id, { id, name, status, tags });
  }

  const fakePersona = {
    createPersonaProfile: async ({ name, tags }) => {
      const profile = { id: `persona-${++personaIdCounter}`, name, status: "stopped", tags: tags || [] };
      profileRegistry.set(profile.id, profile);
      return profile;
    },
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
    listPersonaProfiles: async () => [...profileRegistry.values()],
    personaProfileExists: async () => true,
    startPersonaBrowser: async () => ({}),
    PersonaApiError: class PersonaApiError extends Error {},
    ...persona,
  };
  installFakeModule("../src/persona-browser", fakePersona);

  delete require.cache[require.resolve("../src/importers/pipeline")];
  const pipeline = require("../src/importers/pipeline");
  return { pipeline, accountManager, fakePersona, calls, dir, registerFakeProfile };
}

function tiktokRecord(username, overrides = {}) {
  return { platform: "tiktok", username, password: "pw", cookies: "sessionid=abc123", ...overrides };
}

test("selectRecords restricts a preview confirmation to the selected canonical identities", async () => {
  const { pipeline } = await freshPipeline();
  const records = [tiktokRecord("one"), tiktokRecord("two"), tiktokRecord("three")];
  assert.deepEqual(pipeline.selectRecords(records, ["tiktok:two"]).map((record) => record.username), ["two"]);
  assert.deepEqual(pipeline.selectRecords(records, ["tiktok:one", "tiktok:three"]).map((record) => record.username), ["one", "three"]);
  assert.deepEqual(pipeline.selectRecords(records, ["tiktok:one", "unknown:account"]).map((record) => record.username), ["one"]);
  assert.deepEqual(pipeline.selectRecords(records, []).map((record) => record.username), []);
  // Internal callers that omit the option retain the established full-batch contract.
  assert.equal(pipeline.selectRecords(records).length, 3);
});

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
  assert.deepEqual(Object.keys(report).sort(), ["challengeRequired", "failed", "needsLogin", "results", "skipped", "successful", "total"]);
  assert.equal(Array.isArray(report.results), true);
});

// --- Real production gap (2026-08-26): the Instagram scraping_warning
// anti-automation challenge was already classified as CHALLENGE_REQUIRED
// for "Update Session" (updateExistingAccountSession), but the main,
// brand-new-import path (processRecord, exercised here via importBatch)
// still degraded the exact same gate to a generic NEEDS_LOGIN. See ubt-os's
// docs/adr/0030-security-challenge-states-fail-closed.md - a challenge must
// never be silently merged into NEEDS_LOGIN on ANY import path. -----------

function instagramRecord(username, overrides = {}) {
  return { platform: "instagram", username, password: "pw", ...overrides };
}

const SCRAPING_WARNING_URL = "https://www.instagram.com/accounts/scraping_warning/";

test("processRecord (brand-new import) classifies an Instagram scraping_warning challenge as CHALLENGE_REQUIRED, never NEEDS_LOGIN", async () => {
  const { pipeline, accountManager } = await freshPipeline({ sessionUrl: SCRAPING_WARNING_URL });
  const report = await pipeline.importBatch([instagramRecord("challenge-user")]);

  assert.equal(report.results[0].status, "CHALLENGE_REQUIRED");
  assert.notEqual(report.results[0].status, "NEEDS_LOGIN");
  assert.equal(report.challengeRequired, 1);
  assert.equal(report.needsLogin, 0);

  const accountId = report.results[0].accountId;
  const account = await accountManager.getAccountById(accountId);
  assert.equal(account.sessionStatus, "challenge_required", "the persisted account record must reflect the same first-class state, not a plain needs_login");
});

test("updateExistingAccountSession also classifies a scraping_warning challenge as CHALLENGE_REQUIRED (regression lock for the path already fixed)", async () => {
  // A single fake Persona whose attach returns a genuinely authenticated
  // page for the first (brand-new-import) call, then the scraping_warning
  // challenge page for every later call - simulates the account going
  // READY -> CHALLENGE_REQUIRED between the initial import and a later
  // Update Session, without ever touching two separate account-manager
  // state files.
  const INSTAGRAM_ACTIVE_URL = "https://www.instagram.com/";
  let attachCount = 0;
  const { pipeline, accountManager } = await freshPipeline({
    persona: {
      attachPersonaProfile: async (profileId) => {
        attachCount += 1;
        const url = attachCount === 1 ? INSTAGRAM_ACTIVE_URL : SCRAPING_WARNING_URL;
        // makeFakePage has no `locator` at all - fine for the challenge leg
        // (matched by URL alone, before any positive-evidence check runs),
        // but the first/READY leg needs real positive evidence (2026-08-27
        // hardening: "no gate matched" is no longer sufficient for READY on
        // its own) - a bare <nav> landmark stub is enough to prove it,
        // mirroring makeRecoverableInstagramPage's same pattern above.
        const page = makeFakePage(url);
        if (attachCount === 1) {
          page.locator = (selector) => (selector === "nav" ? { count: async () => 1 } : { count: async () => 0, innerText: async () => "", evaluateAll: async () => [] });
        }
        return { profileId, page, browser: {}, context: {}, info: { port: 1 } };
      },
    },
  });

  const first = await pipeline.importBatch([instagramRecord("update-challenge-user")]);
  assert.equal(first.results[0].status, "READY");
  const accountId = first.results[0].accountId;

  const key = "instagram:update-challenge-user";
  const second = await pipeline.importBatch([instagramRecord("update-challenge-user")], { updateSessionKeys: [key] });

  assert.equal(second.results[0].status, "CHALLENGE_REQUIRED");
  assert.notEqual(second.results[0].status, "NEEDS_LOGIN");
  const account = await accountManager.getAccountById(accountId);
  assert.equal(account.sessionStatus, "challenge_required");
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

// --- end-to-end against the real supplier format's fixture --------------
// Full chain: detector -> tiktok-pipe7 adapter -> buildPreview, using the
// real fixture FILE (test/fixtures/tiktok-pipe7-sample.txt - fake data,
// same shape as the actual confirmed supplier format including its
// marketing header). Directly covers "a file with two accounts must
// produce a preview of exactly two" and "no secret ever reaches preview".

test("the real supplier fixture (header + two accounts) detects, parses to exactly two records, and previews with zero leaked secrets", async () => {
  const { detectFormat } = require("../src/importers/detector");
  const fixturePath = path.join(__dirname, "fixtures", "tiktok-pipe7-sample.txt");
  const content = await fs.readFile(fixturePath, "utf8");

  const supplier = detectFormat(content);
  assert.ok(supplier, "the real fixture must be auto-detected without asking the user to pick a format");
  assert.equal(supplier.id, "tiktok-pipe7-v1");

  const { records, errors } = supplier.parse(content);
  assert.equal(errors.length, 0, "the marketing header must never be reported as a parse error");
  assert.equal(records.length, 2, "a file with two accounts must produce exactly two records");

  const { pipeline } = await freshPipeline();
  const preview = await pipeline.buildPreview(records);
  assert.equal(preview.length, 2, "and exactly two preview entries");
  assert.equal(preview[0].username, "fakeacct_one");
  assert.equal(preview[1].username, "fakeacct_two");
  for (const entry of preview) {
    assert.equal(entry.hasPassword, true);
    assert.equal(entry.hasEmail, true);
    assert.equal(entry.hasEmailPassword, true);
    assert.equal(entry.hasAuthToken, true);
    assert.equal(entry.hasCookies, true);
    assert.equal(entry.cookieCount, 5);
  }

  const serialized = JSON.stringify(preview);
  assert.ok(!serialized.includes("FakePass"), "no password may ever reach the preview");
  assert.ok(!serialized.includes("FakeMailPass"), "no email password may ever reach the preview");
  assert.ok(!serialized.includes("fake-auth-token"), "no auth token may ever reach the preview");
  assert.ok(!serialized.includes("fakeSESSIONVALUE"), "no cookie value may ever reach the preview");
  assert.ok(!serialized.includes("fakeacct_one@example.com"), "the full raw email must never reach the preview, only the masked form");
});

// --- Update Session -------------------------------------------------------
// Refreshes an already-imported account's linked Persona profile with a
// fresh cookie import - never creates a new account or profile. See
// pipeline.js#updateExistingAccountSession and buildPreview's
// canUpdateSession/key fields.

// By default the profile is registered exactly like one this pipeline
// really created for an original import - tagged "autosocial-import",
// matching processRecord's own createPersonaProfile call. Pass
// profileTags: [] to simulate a profile Update Session did NOT create
// itself (e.g. manually relinked via the existing link UI), which the
// clear:true safety check must fail closed against.
async function seedExistingAccount(accountManager, registerFakeProfile, {
  username = "existing-user",
  platform = "tiktok",
  profileId = "existing-profile-1",
  profileTags = ["autosocial-import", "tiktok"],
} = {}) {
  const account = await accountManager.addAccount(username, { importPlatform: platform, importUsername: username });
  await accountManager.setPersonaProfileId(account.id, profileId);
  registerFakeProfile(profileId, { tags: profileTags });
  return { account, profileId };
}

test("buildPreview flags an existing account as canUpdateSession with its real linked Persona profile id and a stable key", async () => {
  const { pipeline, accountManager, registerFakeProfile } = await freshPipeline();
  const { account, profileId } = await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-preview-1" });

  const preview = await pipeline.buildPreview([tiktokRecord("account-preview-1")]);
  assert.equal(preview.length, 1);
  const [entry] = preview;
  assert.equal(entry.alreadyImported, true);
  assert.equal(entry.existingAccountId, account.id);
  assert.equal(entry.existingPersonaProfileId, profileId);
  assert.equal(entry.canUpdateSession, true);
  assert.equal(entry.key, "tiktok:account-preview-1");
});

test("buildPreview reports canUpdateSession:false (fail-closed) for an existing account with no linked Persona profile", async () => {
  const { pipeline, accountManager } = await freshPipeline();
  await accountManager.addAccount("account-no-profile", { importPlatform: "tiktok", importUsername: "account-no-profile" });

  const preview = await pipeline.buildPreview([tiktokRecord("account-no-profile")]);
  const [entry] = preview;
  assert.equal(entry.alreadyImported, true);
  assert.equal(entry.existingPersonaProfileId, null);
  assert.equal(entry.canUpdateSession, false, "no linked profile means Update Session must never be offered");
});

test("Update Session refreshes the EXISTING linked profile and never calls addAccount/createPersonaProfile", async () => {
  let createPersonaProfileCalled = false;
  const { pipeline, accountManager, registerFakeProfile } = await freshPipeline({
    persona: {
      createPersonaProfile: async () => { createPersonaProfileCalled = true; throw new Error("must not be called for Update Session"); },
    },
    sessionUrl: ACTIVE_URL,
  });
  const { account, profileId } = await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-update-1" });
  const accountCountBefore = (await accountManager.getAllAccounts()).length;

  const report = await pipeline.importBatch([tiktokRecord("account-update-1")], { updateSessionKeys: ["tiktok:account-update-1"] });

  assert.equal(createPersonaProfileCalled, false);
  const [result] = report.results;
  assert.equal(result.accountId, account.id);
  assert.equal(result.personaProfileId, profileId, "must reuse the exact existing profile id, never a new one");
  assert.equal(result.autosocial, "Existing");
  assert.equal(result.persona, "Existing");
  assert.equal(result.cookies, "Imported");
  assert.equal(result.status, "READY");

  const accountCountAfter = (await accountManager.getAllAccounts()).length;
  assert.equal(accountCountAfter, accountCountBefore, "no new account may be created");
  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.personaProfileId, profileId, "the account must still point at the same profile, not a new one");
});

test("Update Session imports cookies with clear:true (real replace, not merge) and stops the profile before importing", async () => {
  const stopCallsBeforeImport = [];
  const { pipeline, accountManager, calls, registerFakeProfile } = await freshPipeline({
    persona: {
      importPersonaCookies: async (profileId, opts) => {
        stopCallsBeforeImport.push(calls.stopPersonaProfile.length);
        calls.importPersonaCookies.push({ profileId, opts });
        return { ok: true, imported: 1 };
      },
    },
    sessionUrl: ACTIVE_URL,
  });
  const { profileId } = await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-update-2" });

  await pipeline.importBatch([tiktokRecord("account-update-2")], { updateSessionKeys: ["tiktok:account-update-2"] });

  assert.ok(stopCallsBeforeImport[0] >= 1, "the profile must be stopped before cookie import is attempted");
  const [importCall] = calls.importPersonaCookies;
  assert.equal(importCall.profileId, profileId);
  assert.equal(importCall.opts.clear, true, "Update Session must fully replace cookies, not merge with a stale session");
});

test("Update Session reports NEEDS_LOGIN when the refreshed session still isn't authenticated, without touching the existing account/profile", async () => {
  const { pipeline, accountManager, registerFakeProfile } = await freshPipeline({ sessionUrl: LOGIN_URL });
  const { account, profileId } = await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-update-3" });

  const report = await pipeline.importBatch([tiktokRecord("account-update-3")], { updateSessionKeys: ["tiktok:account-update-3"] });
  const [result] = report.results;
  assert.equal(result.status, "NEEDS_LOGIN");
  assert.equal(result.session, "Invalid");

  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.personaProfileId, profileId, "NEEDS_LOGIN must not remove the account/profile link");
});

test("only the explicitly selected duplicate is updated - a second existing account not in updateSessionKeys stays SKIPPED_DUPLICATE untouched", async () => {
  const { pipeline, accountManager, calls, registerFakeProfile } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const first = await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-selected" });
  const second = await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-not-selected", profileId: "existing-profile-2" });

  const report = await pipeline.importBatch(
    [tiktokRecord("account-selected"), tiktokRecord("account-not-selected")],
    { updateSessionKeys: ["tiktok:account-selected"] }
  );

  const byUsername = Object.fromEntries(report.results.map((r) => [r.username, r]));
  assert.equal(byUsername["account-selected"].status, "READY");
  assert.equal(byUsername["account-selected"].autosocial, "Existing");
  assert.equal(byUsername["account-not-selected"].status, "SKIPPED_DUPLICATE");

  // The untouched account's profile was never attached/imported at all.
  assert.ok(!calls.importPersonaCookies.some((c) => c.profileId === second.profileId));
  assert.ok(!calls.attachPersonaProfile.includes(second.profileId));

  const reloadedFirst = await accountManager.getAccountById(first.account.id);
  const reloadedSecond = await accountManager.getAccountById(second.account.id);
  assert.equal(reloadedFirst.personaProfileId, first.profileId);
  assert.equal(reloadedSecond.personaProfileId, second.profileId);
});

test("two concurrent Update Session requests for the SAME account never both proceed - one is skipped as in-flight", async () => {
  const { pipeline, accountManager, calls, registerFakeProfile } = await freshPipeline({
    persona: {
      attachPersonaProfile: async (profileId) => {
        calls.attachPersonaProfile.push(profileId);
        await new Promise((r) => setTimeout(r, 20));
        return { profileId, page: makeFakePage(ACTIVE_URL), browser: {}, context: {}, info: { port: 1 } };
      },
    },
  });
  await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-racey" });

  const [reportA, reportB] = await Promise.all([
    pipeline.importBatch([tiktokRecord("account-racey")], { updateSessionKeys: ["tiktok:account-racey"] }),
    pipeline.importBatch([tiktokRecord("account-racey")], { updateSessionKeys: ["tiktok:account-racey"] }),
  ]);

  const statuses = [reportA.results[0].status, reportB.results[0].status].sort();
  assert.deepEqual(statuses, ["READY", "SKIPPED_DUPLICATE"], "exactly one concurrent update may proceed - the other must be skipped as in-flight, never run against the same profile at the same time");
  assert.equal(calls.attachPersonaProfile.filter((id) => id === "existing-profile-1").length, 1);
});

test("Update Session failure (cookie import throws) leaves the existing account and Persona link fully intact - nothing is rolled back or removed", async () => {
  const { pipeline, accountManager, calls, registerFakeProfile } = await freshPipeline({
    persona: {
      importPersonaCookies: async () => { throw new Error("simulated Persona API failure"); },
    },
  });
  const { account, profileId } = await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-update-fail" });

  const report = await pipeline.importBatch([tiktokRecord("account-update-fail")], { updateSessionKeys: ["tiktok:account-update-fail"] });
  const [result] = report.results;
  assert.equal(result.status, "FAILED");
  assert.equal(result.cookies, "Failed");
  // Never a rollback status like "Rolled back" - there is nothing to roll
  // back, this account/profile already existed before this call.
  assert.equal(result.autosocial, "Existing");
  assert.equal(result.persona, "Existing");

  assert.deepEqual(calls.deletePersonaProfile, [], "Update Session must never delete the existing Persona profile, even on failure");
  const reloaded = await accountManager.getAccountById(account.id);
  assert.ok(reloaded, "the account must still exist");
  assert.equal(reloaded.personaProfileId, profileId, "the profile link must be unchanged");
});

test("Update Session never returns a password/cookie/auth-token value anywhere in the batch report", async () => {
  const { pipeline, accountManager, registerFakeProfile } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-secret-check" });

  const report = await pipeline.importBatch(
    [tiktokRecord("account-secret-check", { password: "TotallySecretUpdatePW", cookies: "sessionid=TOP_SECRET_UPDATE_TOKEN" })],
    { updateSessionKeys: ["tiktok:account-secret-check"] }
  );
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("TotallySecretUpdatePW"));
  assert.ok(!serialized.includes("TOP_SECRET_UPDATE_TOKEN"));
});

test("Update Session requires an explicit, exact key match - a client-supplied key for a DIFFERENT identity never triggers an update", async () => {
  const { pipeline, accountManager, calls, registerFakeProfile } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const { profileId } = await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-real-target" });

  const report = await pipeline.importBatch(
    [tiktokRecord("account-real-target")],
    { updateSessionKeys: ["tiktok:some-other-unrelated-username"] }
  );
  assert.equal(report.results[0].status, "SKIPPED_DUPLICATE");
  assert.ok(!calls.attachPersonaProfile.includes(profileId));
});

// --- clear:true safety check (independent reviewer finding) --------------
// An account can be manually relinked (via the existing, separate link UI/
// route - not touched by this feature) to an arbitrary already-existing
// Persona profile that this pipeline never created itself - e.g. one
// shared across platforms for manual testing. Wiping that profile's whole
// cookie jar with clear:true would destroy unrelated domains/sessions it
// holds, which is exactly what the user's "never clear other domains
// without necessity" constraint forbids. Update Session must check the
// profile's own real tags before deciding, not just trust that every
// linked profile was one it made itself.

test("Update Session uses clear:true (full replace) only for a profile Persona itself confirms was created by this pipeline (tagged autosocial-import)", async () => {
  const { pipeline, accountManager, calls, registerFakeProfile } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  await seedExistingAccount(accountManager, registerFakeProfile, {
    username: "account-pipeline-owned-profile",
    profileTags: ["autosocial-import", "tiktok"],
  });

  const report = await pipeline.importBatch(
    [tiktokRecord("account-pipeline-owned-profile")],
    { updateSessionKeys: ["tiktok:account-pipeline-owned-profile"] }
  );
  assert.equal(report.results[0].status, "READY");
  assert.equal(report.results[0].cookies, "Imported");
  assert.equal(calls.importPersonaCookies[0].opts.clear, true);
});

test("SAFETY: Update Session falls back to a non-destructive MERGE (clear:false), never a full wipe, for a profile it did not create itself (e.g. manually relinked to a shared/multi-purpose profile)", async () => {
  const { pipeline, accountManager, calls, registerFakeProfile } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  // Simulates an operator having manually relinked this account (via the
  // pre-existing, separate link UI) to a profile this pipeline never
  // created - e.g. no tags at all, or tags unrelated to autosocial-import.
  await seedExistingAccount(accountManager, registerFakeProfile, {
    username: "account-manually-relinked",
    profileTags: [],
  });

  const report = await pipeline.importBatch(
    [tiktokRecord("account-manually-relinked")],
    { updateSessionKeys: ["tiktok:account-manually-relinked"] }
  );
  assert.equal(report.results[0].status, "READY");
  assert.equal(calls.importPersonaCookies[0].opts.clear, false, "a profile of unconfirmed origin must never be fully wiped");
  assert.match(report.results[0].cookies, /merged/i, "the result must honestly say a merge happened, not an unqualified replace");
});

test("SAFETY: if Persona's profile list is unreachable while checking provenance, Update Session fails closed to a merge rather than risk an unverified full wipe", async () => {
  const { pipeline, accountManager, calls, registerFakeProfile } = await freshPipeline({
    persona: { listPersonaProfiles: async () => { throw new Error("Persona API unreachable"); } },
    sessionUrl: ACTIVE_URL,
  });
  await seedExistingAccount(accountManager, registerFakeProfile, { username: "account-provenance-check-fails" });

  const report = await pipeline.importBatch(
    [tiktokRecord("account-provenance-check-fails")],
    { updateSessionKeys: ["tiktok:account-provenance-check-fails"] }
  );
  assert.equal(calls.importPersonaCookies[0].opts.clear, false);
});

test("a client bypassing the UI to send an update key for an account with NO linked Persona profile falls through to SKIPPED_DUPLICATE at the importBatch level (not just in buildPreview)", async () => {
  const { pipeline, accountManager, calls } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  await accountManager.addAccount("account-no-profile-direct-api", {
    importPlatform: "tiktok",
    importUsername: "account-no-profile-direct-api",
  });

  const report = await pipeline.importBatch(
    [tiktokRecord("account-no-profile-direct-api")],
    { updateSessionKeys: ["tiktok:account-no-profile-direct-api"] }
  );
  assert.equal(report.results[0].status, "SKIPPED_DUPLICATE", "processRecord's own re-check must gate this, not just the preview's canUpdateSession");
  assert.equal(calls.attachPersonaProfile.length, 0);
  assert.equal(calls.importPersonaCookies.length, 0);
});

// --- Session status persistence (milestone 2: Dashboard account status) --
// A NEW import's and an Update Session's own verify step must persist the
// same safe sessionStatus/sessionCheckedAt fields session-check.js's manual
// "Check session" writes, so the Dashboard reflects the latest
// verification regardless of which flow produced it.

test("a brand-new account import persists sessionStatus='ready' onto the account after a successful verify", async () => {
  const { pipeline, accountManager } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const report = await pipeline.importBatch([tiktokRecord("session-status-new-account")]);
  const [result] = report.results;
  assert.equal(result.status, "READY");

  const account = await accountManager.getAccountById(result.accountId);
  assert.equal(account.sessionStatus, "ready");
  assert.ok(account.sessionCheckedAt);
});

test("a brand-new account import persists sessionStatus='needs_login' after a failed verify", async () => {
  const { pipeline, accountManager } = await freshPipeline({ sessionUrl: LOGIN_URL });
  const report = await pipeline.importBatch([tiktokRecord("session-status-needs-login")]);
  const [result] = report.results;
  assert.equal(result.status, "NEEDS_LOGIN");

  const account = await accountManager.getAccountById(result.accountId);
  assert.equal(account.sessionStatus, "needs_login");
});

test("Update Session persists the refreshed sessionStatus onto the account after its own verify", async () => {
  const { pipeline, accountManager, registerFakeProfile } = await freshPipeline({ sessionUrl: ACTIVE_URL });
  const { account } = await seedExistingAccount(accountManager, registerFakeProfile, { username: "session-status-update" });

  await pipeline.importBatch([tiktokRecord("session-status-update")], { updateSessionKeys: ["tiktok:session-status-update"] });

  const reloaded = await accountManager.getAccountById(account.id);
  assert.equal(reloaded.sessionStatus, "ready");
  assert.ok(reloaded.sessionCheckedAt);
});

// --- Session Recovery Pipeline, end to end through the real pipeline -----
// (importers/instagram-verify.js + importers/instagram-recovery.js +
// session-recovery.js, all real - only Persona/the browser page are faked).

const COOKIE_CONSENT_URL = "https://www.instagram.com/consent/?flow=user_cookie_choice_v2";
const PRIVACY_CHOICE_URL = "https://www.instagram.com/consent/?flow=ad_free_subscription_blocking_flow";
const INSTAGRAM_HOME_URL = "https://www.instagram.com/";

// A stateful fake Instagram page: starts on a consent screen with a
// recognizable button, and "navigates" to an authenticated home page only
// when instagram-recovery.js's real button-search-and-click logic finds and
// clicks a matching button - exercising the REAL recovery action, not a
// mocked one.
function makeRecoverableInstagramPage({ initialUrl, afterClickUrl = INSTAGRAM_HOME_URL, buttonTexts = ["Allow all cookies", "Decline optional cookies"] }) {
  let currentUrl = initialUrl;
  return {
    goto: async () => {},
    waitForLoadState: async () => {},
    url: () => currentUrl,
    locator: (selector) => {
      if (selector === "body") return { innerText: async () => "" };
      if (selector === "nav") return { count: async () => (currentUrl === afterClickUrl ? 1 : 0) };
      if (selector === 'a[href^="/"]') return { evaluateAll: async () => [] };
      if (selector === 'button, [role="button"], a') {
        const texts = currentUrl === initialUrl ? buttonTexts : [];
        return {
          count: async () => texts.length,
          nth: (i) => ({
            innerText: async () => texts[i],
            click: async () => { currentUrl = afterClickUrl; },
          }),
        };
      }
      return { count: async () => 0, innerText: async () => "", evaluateAll: async () => [] };
    },
  };
}

test("real production scenario (2026-08-26): cookie consent is auto-recovered to READY through a brand-new import", async () => {
  const { pipeline, accountManager } = await freshPipeline({
    persona: {
      attachPersonaProfile: async (profileId) => ({
        profileId, browser: {}, context: {}, info: { port: 1 },
        page: makeRecoverableInstagramPage({ initialUrl: COOKIE_CONSENT_URL }),
      }),
    },
  });
  const report = await pipeline.importBatch([instagramRecord("cookie-recovery-user")]);
  const [result] = report.results;

  assert.equal(result.status, "READY");
  assert.equal(result.sessionState, "READY");

  const account = await accountManager.getAccountById(result.accountId);
  assert.equal(account.sessionStatus, "ready");
  assert.equal(account.sessionState, "READY");
  assert.ok(Array.isArray(account.sessionRecoveryAttempts));
  assert.ok(account.sessionRecoveryAttempts.length >= 2, "expects at least the initial COOKIE_CONSENT_REQUIRED attempt plus the READY re-verify");
  assert.equal(account.sessionRecoveryAttempts[0].state, "COOKIE_CONSENT_REQUIRED");
  assert.equal(account.sessionRecoveryAttempts[0].actionPerformed, true);
  assert.equal(account.sessionRecoveryAttempts.at(-1).result, "READY");
  // Never a raw secret anywhere in the persisted, safe attempt history.
  const serialized = JSON.stringify(account.sessionRecoveryAttempts);
  assert.equal(serialized.toLowerCase().includes("sessionid="), false);
  assert.equal(serialized.toLowerCase().includes("password"), false);
});

test("real production scenario (2026-08-26): privacy/subscription choice stops fail-closed, never auto-decided", async () => {
  const { pipeline, accountManager } = await freshPipeline({
    persona: {
      attachPersonaProfile: async (profileId) => ({
        profileId, browser: {}, context: {}, info: { port: 1 },
        page: makeRecoverableInstagramPage({ initialUrl: PRIVACY_CHOICE_URL, buttonTexts: ["Continue without subscribing", "Subscribe"] }),
      }),
    },
  });
  const report = await pipeline.importBatch([instagramRecord("privacy-choice-user")]);
  const [result] = report.results;

  assert.equal(result.status, "CHALLENGE_REQUIRED");
  assert.equal(result.sessionState, "PRIVACY_CHOICE_REQUIRED");
  assert.match(result.reason, /privacy|subscription/i);

  const account = await accountManager.getAccountById(result.accountId);
  assert.equal(account.sessionStatus, "challenge_required");
  assert.equal(account.sessionState, "PRIVACY_CHOICE_REQUIRED");
});

test("batch isolation: one account stuck on a policy decision does not block another account's successful recovery in the same batch", async () => {
  const { pipeline, accountManager, fakePersona } = await freshPipeline();
  // Decide the fake page by the PROFILE'S NAME (which pipeline.js sets to
  // `autosocial-${platform}-${username}` - see processRecord), never by
  // call order or profile id, since importBatch's concurrent workers give
  // no ordering guarantee for which account's attach resolves first.
  fakePersona.attachPersonaProfile = async (profileId) => {
    const profiles = await fakePersona.listPersonaProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    const isRecoverable = Boolean(profile && profile.name && profile.name.includes("batch-recoverable"));
    const page = isRecoverable
      ? makeRecoverableInstagramPage({ initialUrl: COOKIE_CONSENT_URL })
      : makeRecoverableInstagramPage({ initialUrl: PRIVACY_CHOICE_URL, buttonTexts: ["Subscribe"] });
    return { profileId, browser: {}, context: {}, info: { port: 1 }, page };
  };

  const report = await pipeline.importBatch([instagramRecord("batch-recoverable"), instagramRecord("batch-blocked")]);
  assert.equal(report.total, 2);

  const recovered = report.results.find((r) => r.username === "batch-recoverable");
  const blocked = report.results.find((r) => r.username === "batch-blocked");
  assert.equal(recovered.status, "READY");
  assert.equal(blocked.status, "CHALLENGE_REQUIRED");
  assert.equal(blocked.sessionState, "PRIVACY_CHOICE_REQUIRED");

  // Both accounts were fully, independently processed - the blocked one
  // never prevented the recoverable one from reaching READY, and vice
  // versa never masked the blocked one's real state.
  const recoveredAccount = await accountManager.getAccountById(recovered.accountId);
  const blockedAccount = await accountManager.getAccountById(blocked.accountId);
  assert.equal(recoveredAccount.sessionStatus, "ready");
  assert.equal(blockedAccount.sessionStatus, "challenge_required");
});
