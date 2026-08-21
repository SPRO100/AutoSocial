const test = require("node:test");
const assert = require("node:assert/strict");

const { createRecord, duplicateKey, maskEmail, countCookies, toSafePreview } = require("../src/importers/normalize");

test("createRecord drops empty/undefined/null fields and keeps only known normalized fields", () => {
  const record = createRecord({
    platform: "tiktok",
    username: "acct1",
    password: "",
    email: undefined,
    externalId: null,
    cookies: "raw-cookie-text",
    extraneous: "should never appear",
  });
  assert.deepEqual(record, { platform: "tiktok", username: "acct1", cookies: "raw-cookie-text" });
  assert.ok(!("extraneous" in record));
});

test("duplicateKey combines platform+username case-insensitively, null when either is missing", () => {
  assert.equal(duplicateKey({ platform: "TikTok", username: "Acct1" }), "tiktok:acct1");
  assert.equal(duplicateKey({ platform: "tiktok" }), null);
  assert.equal(duplicateKey({}), null);
});

test("maskEmail never returns the raw email and keeps the domain visible", () => {
  const masked = maskEmail("supplieraccount1@gmail.com");
  assert.notEqual(masked, "supplieraccount1@gmail.com");
  assert.ok(masked.endsWith("@gmail.com"));
  assert.ok(masked.startsWith("su"));
  assert.ok(!masked.includes("supplieraccount1"));
});

test("maskEmail handles missing/malformed input safely", () => {
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail(""), null);
  assert.equal(maskEmail("not-an-email"), "***");
});

test("countCookies counts a JSON array, a Playwright-shaped {cookies:[...]} object, and a semicolon header string", () => {
  assert.equal(countCookies(JSON.stringify([{ name: "a", value: "1" }, { name: "b", value: "2" }])), 2);
  assert.equal(countCookies(JSON.stringify({ cookies: [{ name: "a", value: "1" }] })), 1);
  assert.equal(countCookies("sessionid=abc123; sid_guard=xyz789; uid_tt=42"), 3);
});

test("countCookies returns null (not 0) for empty/unrecognizable input, never throws", () => {
  assert.equal(countCookies(null), null);
  assert.equal(countCookies(""), null);
  assert.equal(countCookies(undefined), null);
});

test("toSafePreview never includes password, emailPassword, authToken, or the raw cookie value - even when present on the record", () => {
  const record = createRecord({
    platform: "tiktok",
    username: "leak-check",
    password: "SuperSecretPassword123",
    email: "leak-check@example.com",
    emailPassword: "MailboxSecret456",
    authToken: "eyJhbGciOiJIUzI1NiJ9.FAKE.TOKEN",
    cookies: "sessionid=TOP_SECRET_SESSION_TOKEN",
  });
  const preview = toSafePreview(record);
  const serialized = JSON.stringify(preview);
  assert.ok(!serialized.includes("SuperSecretPassword123"));
  assert.ok(!serialized.includes("MailboxSecret456"));
  assert.ok(!serialized.includes("eyJhbGciOiJIUzI1NiJ9.FAKE.TOKEN"));
  assert.ok(!serialized.includes("TOP_SECRET_SESSION_TOKEN"));
  assert.ok(!serialized.includes("leak-check@example.com"));
  assert.deepEqual(Object.keys(preview).sort(), [
    "cookieCount",
    "emailMasked",
    "externalId",
    "hasAuthToken",
    "hasCookies",
    "hasEmail",
    "hasEmailPassword",
    "hasPassword",
    "platform",
    "username",
  ]);
  assert.equal(preview.hasPassword, true);
  assert.equal(preview.hasEmail, true);
  assert.equal(preview.hasEmailPassword, true);
  assert.equal(preview.hasAuthToken, true);
  assert.equal(preview.hasCookies, true);
  assert.equal(preview.username, "leak-check");
});
