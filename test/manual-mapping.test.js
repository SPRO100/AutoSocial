const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("../src/importers/manual-mapping");
const { toSafePreview } = require("../src/importers/normalize");
const { normalize: normalizeTemplate } = require("../src/importers/template-store");

test("manual mapping parses two Instagram rows plus metadata and preserves 2FA", () => {
  const content = [
    "Order instructions: ignore this line",
    "alpha_user|PassAlpha|JBSWY3DPEHPK3PXP|sid=alpha:opaque",
    "IMPORTANT: use a proxy",
    "beta_user|PassBeta|KRSXG5A3N5Z2M4QW|sid=beta:opaque",
    "Footer: support only",
  ].join("\r\n");
  const result = parse(content, "instagram", { delimiter: "|", fields: { username: 0, password: 1, twoFactorSecret: 2, cookie: 3 } });
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((row) => row.username), ["alpha_user", "beta_user"]);
  assert.deepEqual(result.records.map((row) => Boolean(row.twoFactorSecret)), [true, true]);
  assert.deepEqual(result.records.map((row) => Boolean(row.password)), [true, true]);
  assert.equal(JSON.stringify(toSafePreview(result.records[0])).includes("PassAlpha"), false);
  assert.equal(toSafePreview(result.records[0]).hasTwoFactor, true);
});

test("manual mapping parses two labelled Instagram credential blocks and ignores prose", () => {
  const content = "Order: metadata\nUsername: alpha_user\nPassword: PassAlpha\n2FA: JBSWY3DPEHPK3PXP\n\nIMPORTANT: instructions\nLogin: beta_user\nPassword: PassBeta\nTOTP: KRSXG5A3N5Z2M4QW\n";
  const result = parse(content, "instagram", { delimiter: ":", fields: { username: 0, password: 1, twoFactorSecret: 2, cookie: "ignore" } });
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].twoFactorSecret, "JBSWY3DPEHPK3PXP");
  assert.equal(result.records[1].twoFactorSecret, "KRSXG5A3N5Z2M4QW");
});

test("saved supplier template preserves structural fields and restores a two-account row mapping", () => {
  const saved = normalizeTemplate({
    id: "supplier-instagram-v1", name: "supplier-instagram-v1", platform: "Instagram", delimiter: ":",
    fields: { username: 0, password: 1, twoFactorSecret: 2, cookie: "ignore", email: "ignore" }, recordMode: "ROW",
    normalization: { trim: true },
  });
  assert.equal(saved.platform, "instagram");
  assert.deepEqual(saved.fields, { username: 0, password: 1, twoFactorSecret: 2, cookie: "ignore", email: "ignore" });
  const result = parse([
    "Order 8090729: supplier instructions",
    "first_user:FirstPass:AAAA1111",
    "Visit https://supplier.invalid/help: ignore",
    "second_user:SecondPass:BBBB2222",
    "Footer: support",
  ].join("\r\n"), saved.platform, saved);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((row) => row.username), ["first_user", "second_user"]);
  assert.deepEqual(result.records.map((row) => Boolean(row.twoFactorSecret)), [true, true]);
  const safe = result.records.map(toSafePreview);
  assert.equal(JSON.stringify(safe).includes("FirstPass"), false);
  assert.equal(JSON.stringify(safe).includes("AAAA1111"), false);
});
