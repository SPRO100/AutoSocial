// Live regression test: deleteCompletely against the REAL running Persona
// API - proves the stop -> delete -> verify sequence actually works
// end to end against real Persona behavior, not just mocked responses.
// Uses a throwaway account (its own temp accounts-state.json) and a
// throwaway Persona profile, both real, both cleaned up by the function
// under test itself (that's exactly what's being verified). Skips (does
// not fail) if Persona isn't reachable. Never touches a real imported
// account.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { config } = require("../src/config");

async function isPersonaReachable() {
  try {
    const res = await fetch(`${config.personaApiUrl}/api/profiles`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

test("REGRESSION/LIVE: deleteCompletely actually stops, deletes, and verifies a real Persona profile is gone, then removes the AutoSocial account", async (t) => {
  if (!(await isPersonaReachable())) {
    t.skip("persona-api.service is not reachable in this environment - skipping the live delete regression test");
    return;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-delete-persistence-"));
  process.env.ACCOUNTS_STATE_FILE = path.join(dir, "accounts-state.json");
  delete require.cache[require.resolve("../src/account-manager")];
  const accountManager = require("../src/account-manager");
  delete require.cache[require.resolve("../src/account-deletion")];
  const accountDeletion = require("../src/account-deletion");
  const persona = require("../src/persona-browser");

  const profile = await persona.createPersonaProfile({
    name: "autosocial-test-delete-persistence",
    tags: ["autosocial-test", "regression-test"],
  });
  let deletedByTest = false;
  try {
    const account = await accountManager.addAccount("delete-regression-user", {
      importPlatform: "tiktok",
      importUsername: "delete-regression-user",
    });
    await accountManager.setPersonaProfileId(account.id, profile.id);

    // Real attach + immediate leave-running, to exercise the "stop a
    // genuinely running profile" path for real.
    const session = await persona.attachPersonaProfile(profile.id, { headless: true });
    await persona.disconnectPersonaBrowser(session);
    const beforeExists = await persona.personaProfileExists(profile.id);
    assert.equal(beforeExists, true);

    const result = await accountDeletion.deleteCompletely(account.id);
    assert.equal(result.ok, true);
    assert.equal(result.personaAction, "deleted");
    deletedByTest = true;

    const afterExists = await persona.personaProfileExists(profile.id);
    assert.equal(afterExists, false, "the real Persona profile must genuinely be gone");
    assert.equal(await accountManager.getAccountById(account.id), null);
  } finally {
    // If deleteCompletely itself is what's under test and it (or an
    // assertion before it) fails, the throwaway profile must not leak -
    // independent-review finding.
    if (!deletedByTest) {
      await persona.stopPersonaProfile(profile.id).catch(() => {});
      await persona.deletePersonaProfile(profile.id).catch(() => {});
    }
  }
});
