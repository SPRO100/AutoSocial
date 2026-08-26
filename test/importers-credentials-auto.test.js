const test = require("node:test");
const assert = require("node:assert/strict");
const { detectFormat, getSupplierById } = require("../src/importers/detector");
const credentialsAuto = require("../src/importers/suppliers/credentials-auto");
const { toSafePreview } = require("../src/importers/normalize");

// Real production incident regression: a purchased Instagram supplier file
// shaped as "username,password,email,<JSON cookie bundle>" matched neither
// instagram-colon-v1 (rejects any comma-bearing line) nor generic-csv-v1
// (no recognized header row), and fell through to manual-mapping's raw
// column-index guessing ("Column 1 / Column 2 / ..."). This adapter must
// recognize it automatically instead.

function fakeCookieJson(n) {
  return JSON.stringify([
    { name: "sessionid", value: `FAKE_SESSION_${n}`, domain: ".instagram.com", path: "/", expires: 1999999999, httpOnly: true, secure: true },
    { name: "csrftoken", value: `FAKE_CSRF_${n}`, domain: ".instagram.com", path: "/", expires: 1999999999, secure: true },
    { name: "ds_user_id", value: `100000000${n}`, domain: ".instagram.com", path: "/", expires: 1999999999 },
  ]);
}

test("detectFormat recognizes a comma-delimited Instagram file with a JSON cookie bundle column", () => {
  const content = [
    `alice_user,SafePass123,alice@example.test,${fakeCookieJson(1)}`,
    `bob_user,SafePass456,bob@example.test,${fakeCookieJson(2)}`,
  ].join("\n");
  const supplier = detectFormat(content, { platform: "instagram" });
  assert.ok(supplier, "expected an adapter to claim this file");
  assert.equal(supplier.id, "credentials-auto-v1");
});

test("parses username, password, email and cookie bundle correctly for a multi-account file, with a safe preview showing the real cookie count", () => {
  const content = [
    `alice_user,SafePass123,alice@example.test,${fakeCookieJson(1)}`,
    `bob_user,SafePass456,bob@example.test,${fakeCookieJson(2)}`,
  ].join("\n");
  const { records, errors } = credentialsAuto.parse(content, "instagram");
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.equal(records[0].platform, "instagram");
  assert.equal(records[0].username, "alice_user");
  assert.equal(records[0].password, "SafePass123");
  assert.equal(records[1].username, "bob_user");

  const safe = records.map(toSafePreview);
  assert.equal(safe[0].hasPassword, true);
  assert.equal(safe[0].hasEmail, true);
  assert.equal(safe[0].emailMasked, "al***@example.test");
  assert.equal(safe[0].hasCookies, true);
  assert.equal(safe[0].cookieCount, 3);
  assert.equal(JSON.stringify(safe).includes("SafePass123"), false, "safe preview must never contain the raw password");
  assert.equal(JSON.stringify(safe).includes("FAKE_SESSION_1"), false, "safe preview must never contain a raw cookie value");
});

test("pipe-delimited file with a 2FA column and a header-style cookie string is recognized and parsed", () => {
  const content = [
    "carol_user|SafePassA1|JBSWY3DPEHPK3PXP|sessionid=fakeC1; csrftoken=fakeC2; ds_user_id=1",
    "dave_user|SafePassB2|KRSXG5A3N5Z2M4QW|sessionid=fakeD1; csrftoken=fakeD2; ds_user_id=2",
  ].join("\n");
  const supplier = detectFormat(content, { platform: "instagram" });
  assert.equal(supplier.id, "credentials-auto-v1");
  const { records, errors } = supplier.parse(content, "instagram");
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.equal(records[0].twoFactorSecret, "JBSWY3DPEHPK3PXP");
  assert.match(records[0].cookies, /sessionid=fakeC1/);
});

test("semicolon-delimited file with a User-Agent column is recognized and parsed", () => {
  // The UA value itself must not contain the file's own delimiter (";") -
  // an unquoted field containing its own delimiter is genuinely ambiguous
  // to split, same as a real semicolon-delimited CSV would be.
  const content = [
    `eve_user;SafePassC1;eve@example.test;Mozilla/5.0 (X11 Linux x86_64) Chrome/120.0;${fakeCookieJson(3)}`,
    `frank_user;SafePassD2;frank@example.test;Mozilla/5.0 (X11 Linux i686) Chrome/120.0;${fakeCookieJson(4)}`,
  ].join("\n");
  const { records, errors } = credentialsAuto.parse(content, "instagram");
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.match(records[0].userAgent, /^Mozilla\/5\.0/);
});

test("a row missing its username is reported as an error, never as a record, and the reason never leaks the raw line", () => {
  const content = [
    `alice_user,SafePass123,alice@example.test,${fakeCookieJson(1)}`,
    `,SafePass999,ghost@example.test,${fakeCookieJson(9)}`,
  ].join("\n");
  const { records, errors } = credentialsAuto.parse(content, "instagram");
  assert.equal(records.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].reason, "missing username or password");
  assert.ok(!errors[0].reason.includes("SafePass999"));
  assert.ok(!errors[0].reason.includes("ghost@example.test"));
});

test("fails closed (no records) for an ambiguous file with more than one unexplained column left over", () => {
  // Four plain alnum columns with no email/cookie/UA/TOTP signal at all -
  // there is no safe way to tell which two are username/password out of
  // four equally plausible candidates, so this must not guess.
  const content = ["one,two,three,four", "alpha,beta,gamma,delta"].join("\n");
  assert.equal(credentialsAuto.test(content), false);
  const { records } = credentialsAuto.parse(content, "instagram");
  assert.equal(records.length, 0);
});

test("never produces records without a platform hint, even for an otherwise-recognizable file", () => {
  const content = [`alice_user,SafePass123,alice@example.test,${fakeCookieJson(1)}`, `bob_user,SafePass456,bob@example.test,${fakeCookieJson(2)}`].join("\n");
  const { records } = credentialsAuto.parse(content, undefined);
  assert.equal(records.length, 0);
});

test("comment lines and single-column marketing/header lines are ignored, not counted as malformed rows", () => {
  const content = [
    "# Fresh Instagram accounts batch",
    "Contact us on Telegram for support",
    `alice_user,SafePass123,alice@example.test,${fakeCookieJson(1)}`,
    `bob_user,SafePass456,bob@example.test,${fakeCookieJson(2)}`,
  ].join("\n");
  const { records, errors } = credentialsAuto.parse(content, "instagram");
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
});

test("registered in the detector registry as a generic, platform-agnostic adapter", () => {
  const supplier = getSupplierById("credentials-auto-v1");
  assert.ok(supplier);
  assert.equal(supplier.generic, true);
});

test("a real Instagram-shaped file recognized by this adapter is not misclassified as instagram-colon-v1", () => {
  const content = [`alice_user,SafePass123,alice@example.test,${fakeCookieJson(1)}`, `bob_user,SafePass456,bob@example.test,${fakeCookieJson(2)}`].join("\n");
  const supplier = detectFormat(content, { platform: "instagram" });
  assert.notEqual(supplier.id, "instagram-colon-v1");
});
