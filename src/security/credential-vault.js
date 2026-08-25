// Minimal encrypted-at-rest vault for importer credentials that may be
// needed by a future re-auth flow.  Without an operator-provided key we
// deliberately do not persist secrets at all (the import remains usable for
// cookie-backed sessions).  No plaintext value is ever returned or logged.
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { config } = require("../config");

const FILE = process.env.CREDENTIAL_VAULT_FILE ? path.resolve(process.env.CREDENTIAL_VAULT_FILE) : path.resolve(config.projectRoot, "credential-vault.json");
function key() {
  const raw = process.env.AUTOSOCIAL_CREDENTIALS_KEY || process.env.CREDENTIALS_ENCRYPTION_KEY;
  return raw ? crypto.createHash("sha256").update(raw, "utf8").digest() : null;
}
function seal(value) {
  const k = key(); if (!k) return null;
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
async function store(accountId, record) {
  const payload = seal({ password: record.password, twoFactorSecret: record.twoFactorSecret, recoveryEmail: record.recoveryEmail, recoveryPassword: record.recoveryPassword, proxy: record.proxy, userAgent: record.userAgent, phone: record.phone });
  if (!payload || !accountId) return { stored: false, reason: "credential vault key is not configured" };
  let state = {};
  try { state = JSON.parse(await fs.readFile(FILE, "utf8")); } catch { /* first write */ }
  state[accountId] = payload;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  return { stored: true };
}
module.exports = { store, seal, FILE };
