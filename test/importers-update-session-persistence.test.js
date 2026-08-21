// Live regression test: Update Session's cookie refresh must survive the
// same write-process-closes-then-new-attach boundary as the original
// import flow (see importers-cookie-adapter-persistence.test.js for the
// underlying bug this guards against). Exercises the REAL account-manager,
// REAL persona-browser, and REAL Persona API end to end through
// pipeline.js#importBatch's updateSessionKeys path - not mocked - because
// this is genuine browser-process persistence behavior a mock cannot
// reproduce.
//
// Skips (does not fail) if Persona isn't reachable. Uses a throwaway
// account (its own temp accounts-state.json) and a throwaway Persona
// profile, both created and deleted only for this test. Never logs a
// cookie value.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { config } = require("../src/config");

const TARGET_COOKIE_NAMES = ["sessionid", "sessionid_ss", "sid_tt", "uid_tt", "ttwid"];

async function isPersonaReachable() {
  try {
    const res = await fetch(`${config.personaApiUrl}/api/profiles`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function fakeHeaderStyleCookies() {
  const names = [...TARGET_COOKIE_NAMES, "msToken", "odin_tt"];
  return names.map((name, i) => `${name}=FAKEVAL${i}${"q".repeat(24)}`).join("; ");
}

test("REGRESSION: Update Session's cookie refresh survives Persona's write process closing and a later, separate attach", async (t) => {
  if (!(await isPersonaReachable())) {
    t.skip("persona-api.service is not reachable in this environment - skipping the live persistence regression test");
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-update-session-persistence-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");
  delete require.cache[require.resolve("../src/importers/pipeline")];
  const pipeline = require("../src/importers/pipeline");
  const persona = require("../src/persona-browser");

  let profile = null;
  try {
    profile = await persona.createPersonaProfile({
      name: "autosocial-test-update-session-persistence",
      // "autosocial-import" matters here, not just for realism - it's what
      // updateExistingAccountSession's clear:true safety check looks for
      // (see the independent-review fix in pipeline.js) to confirm this
      // profile is actually one the pipeline itself owns, so this live
      // test exercises the real full-replace path, not the merge fallback.
      tags: ["autosocial-test", "regression-test", "autosocial-import"],
    });
    const account = await accountManager.addAccount("update-session-regression-user", {
      importPlatform: "tiktok",
      importUsername: "update-session-regression-user",
    });
    await accountManager.setPersonaProfileId(account.id, profile.id);

    const record = {
      platform: "tiktok",
      username: "update-session-regression-user",
      cookies: fakeHeaderStyleCookies(),
    };
    const report = await pipeline.importBatch([record], {
      updateSessionKeys: ["tiktok:update-session-regression-user"],
    });

    const [result] = report.results;
    assert.equal(result.accountId, account.id);
    assert.equal(result.personaProfileId, profile.id, "must reuse the existing profile, never create a new one");
    assert.equal(result.autosocial, "Existing");
    assert.equal(result.persona, "Existing");
    assert.equal(result.cookies, "Imported");

    // The real, independent check: attach fresh (a genuinely separate
    // browser process from whatever Update Session's own internal verify
    // step used) and confirm the cookies actually persisted.
    const session = await persona.attachPersonaProfile(profile.id, { headless: true });
    const liveNames = new Set((await session.context.cookies()).map((c) => c.name));
    await persona.disconnectPersonaBrowser(session);

    for (const name of TARGET_COOKIE_NAMES) {
      assert.ok(liveNames.has(name), `${name} must still be present after Update Session and a fresh attach`);
    }
  } finally {
    await persona.stopPersonaProfile(profile?.id).catch(() => {});
    if (profile) await persona.deletePersonaProfile(profile.id).catch(() => {});
  }
});
