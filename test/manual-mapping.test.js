const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, suggest } = require("../src/importers/manual-mapping");
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

// --- Real production incident regression: a JSON cookie bundle's internal
// commas must never inflate the manual-mapping review's reported column
// count ("Column 1 / Column 2 / ...") -------------------------------------

test("suggest() reports the JSON cookie bundle as exactly one column, not one column per internal comma", () => {
  const cookieJson = JSON.stringify([
    { name: "sessionid", value: "fake1", domain: ".instagram.com" },
    { name: "csrftoken", value: "fake2", domain: ".instagram.com" },
  ]);
  const content = [`alice_user,SafePass123,alice@example.test,${cookieJson}`, `bob_user,SafePass456,bob@example.test,${cookieJson}`].join("\n");
  const result = suggest(content, "instagram");
  assert.equal(result.delimiter, ",");
  assert.equal(result.columns, 4, "the JSON bundle's internal commas must not be counted as extra columns");
  assert.equal(result.rows[0].values.length, 4);
});

test("suggest() auto-suggests the cookie column so the operator does not have to guess it", () => {
  const cookieJson = JSON.stringify([{ name: "sessionid", value: "fake1", domain: ".instagram.com" }]);
  const content = [`alice_user,SafePass123,alice@example.test,${cookieJson}`, `bob_user,SafePass456,bob@example.test,${cookieJson}`].join("\n");
  const result = suggest(content, "instagram");
  assert.equal(result.fields.cookie, 3);
  assert.equal(result.fields.email, 2);
});

test("suggest() auto-suggests a 2FA column and a User-Agent column when present", () => {
  const content = [
    "carol_user|SafePassA1|JBSWY3DPEHPK3PXP|Mozilla/5.0 (Windows NT 10.0) Chrome/120.0",
    "dave_user|SafePassB2|KRSXG5A3N5Z2M4QW|Mozilla/5.0 (Macintosh) Chrome/120.0",
  ].join("\n");
  const result = suggest(content, "instagram");
  assert.equal(result.delimiter, "|");
  assert.equal(result.fields.twoFactorSecret, 2);
  assert.equal(result.fields.userAgent, 3);
});

test("suggest() never suggests the same column for two different fields", () => {
  const cookieJson = JSON.stringify([{ name: "sessionid", value: "fake1" }]);
  const content = `alice_user,SafePass123,alice@example.test,${cookieJson}`;
  const result = suggest(content, "instagram");
  const used = Object.values(result.fields);
  assert.equal(new Set(used).size, used.length, "no column index should be suggested twice");
});

test("suggest() output never contains a raw secret value - only masked previews and column indexes", () => {
  const cookieJson = JSON.stringify([{ name: "sessionid", value: "REAL_SECRET_VALUE" }]);
  const content = `alice_user,SuperSecretPass1,alice@example.test,${cookieJson}`;
  const result = suggest(content, "instagram");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("SuperSecretPass1"), false);
  assert.equal(serialized.includes("REAL_SECRET_VALUE"), false);
});
