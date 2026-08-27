const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

// Same module-cache-substitution convention as account-manager.test.js -
// the vault's file path and encryption key are both resolved once at
// module load time from env vars, so each test needs its own fresh
// require() to see its own temp file/key.
async function freshVault({ key } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-vault-"));
  const file = path.join(dir, "credential-vault.json");
  process.env.CREDENTIAL_VAULT_FILE = file;
  // Explicitly empty (never deleted): config.js's dotenv.config() only
  // fills in a var that is entirely ABSENT from process.env, and only on
  // its own first-ever require in this process - deleting the key here
  // would let a real, developer-machine .env file's AUTOSOCIAL_CREDENTIALS_KEY
  // silently leak into the "no key configured" test case. An explicit
  // empty string is present (so dotenv never touches it) and falsy (so
  // credential-vault.js#key() still correctly treats it as unset).
  process.env.AUTOSOCIAL_CREDENTIALS_KEY = key === undefined ? "" : key;
  process.env.CREDENTIALS_ENCRYPTION_KEY = "";
  delete require.cache[require.resolve("../src/security/credential-vault")];
  const vault = require("../src/security/credential-vault");
  return { vault, file, dir };
}

test("without a configured key, store() persists nothing and reports stored:false - never a plaintext password on disk", async () => {
  const { vault, file } = await freshVault({ key: undefined });
  const result = await vault.store("acct-1", { password: "FakeSecretPass123" });
  assert.equal(result.stored, false);
  await assert.rejects(() => fs.access(file), "no vault file should be created at all when no key is configured");
});

test("with a configured key, store() persists an encrypted-at-rest entry - the raw password never appears in the file", async () => {
  const { vault, file } = await freshVault({ key: "test-only-fake-vault-key-not-for-production" });
  const result = await vault.store("acct-2", { password: "FakeSecretPass456", twoFactorSecret: "FAKETOTP" });
  assert.equal(result.stored, true);

  const raw = await fs.readFile(file, "utf8");
  assert.equal(raw.includes("FakeSecretPass456"), false, "the raw password must never appear anywhere in the vault file");
  assert.equal(raw.includes("FAKETOTP"), false);

  const state = JSON.parse(raw);
  assert.ok(state["acct-2"]);
  assert.equal(state["acct-2"].version, 1);
  assert.ok(typeof state["acct-2"].ciphertext === "string" && state["acct-2"].ciphertext.length > 0);
  assert.ok(typeof state["acct-2"].iv === "string");
  assert.ok(typeof state["acct-2"].tag === "string");
});

test("the vault file is written with restrictive (owner-only) permissions", async () => {
  const { vault, file } = await freshVault({ key: "test-only-fake-vault-key-not-for-production" });
  await vault.store("acct-3", { password: "FakeSecretPass789" });
  const stat = await fs.stat(file);
  // 0o600 - owner read/write only, no group/other access.
  assert.equal(stat.mode & 0o777, 0o600);
});

test("multiple accounts are stored independently - one account's entry never overwrites another's", async () => {
  const { vault, file } = await freshVault({ key: "test-only-fake-vault-key-not-for-production" });
  await vault.store("acct-4", { password: "FakeSecretPassA" });
  await vault.store("acct-5", { password: "FakeSecretPassB" });
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.ok(state["acct-4"]);
  assert.ok(state["acct-5"]);
  assert.notEqual(state["acct-4"].ciphertext, state["acct-5"].ciphertext);
});

test("store() with no accountId reports stored:false rather than writing a malformed entry", async () => {
  const { vault } = await freshVault({ key: "test-only-fake-vault-key-not-for-production" });
  const result = await vault.store(null, { password: "FakeSecretPass" });
  assert.equal(result.stored, false);
});

test("seal() never throws and returns null when no key is configured, regardless of input shape", async () => {
  const { vault } = await freshVault({ key: undefined });
  assert.equal(vault.seal({ password: "x" }), null);
  assert.equal(vault.seal({}), null);
});
