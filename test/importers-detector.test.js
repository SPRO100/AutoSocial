const test = require("node:test");
const assert = require("node:assert/strict");

const { detectFormat, getSupplierById } = require("../src/importers/detector");

test("detectFormat recognizes the placeholder TikTok pipe-delimited format", () => {
  const text = [
    "account1|Passw0rd!|account1@example.com|MailPass1|ext-001",
    "account2|Passw0rd2!|account2@example.com|MailPass2|ext-002",
  ].join("\n");
  const supplier = detectFormat(text);
  assert.ok(supplier, "expected a supplier adapter to claim this file");
  assert.equal(supplier.id, "tiktok-lines-v1");
});

test("detectFormat returns null for a file that matches no registered supplier", () => {
  const supplier = detectFormat("this is just some unrelated prose\nwith no delimiters at all\n");
  assert.equal(supplier, null);
});

test("detectFormat returns null for empty input", () => {
  assert.equal(detectFormat(""), null);
  assert.equal(detectFormat(null), null);
});

test("getSupplierById finds a registered adapter by id, null otherwise", () => {
  assert.equal(getSupplierById("tiktok-lines-v1").id, "tiktok-lines-v1");
  assert.equal(getSupplierById("does-not-exist"), null);
});

// --- tiktok-lines adapter itself -------------------------------------

const tiktokLines = require("../src/importers/suppliers/tiktok-lines");

test("tiktok-lines parses a full line into every normalized field", () => {
  const { records, errors } = tiktokLines.parse(
    "account1|Passw0rd!|account1@example.com|MailPass1|ext-001|sessionid=abc; sid_guard=def"
  );
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    platform: "tiktok",
    username: "account1",
    password: "Passw0rd!",
    email: "account1@example.com",
    emailPassword: "MailPass1",
    externalId: "ext-001",
    cookies: "sessionid=abc; sid_guard=def",
  });
});

test("tiktok-lines handles optional trailing fields being entirely absent", () => {
  const { records, errors } = tiktokLines.parse("account2|Passw0rd2!");
  assert.equal(errors.length, 0);
  assert.deepEqual(records[0], { platform: "tiktok", username: "account2", password: "Passw0rd2!" });
});

test("tiktok-lines skips blank lines and # comment lines", () => {
  const { records, errors } = tiktokLines.parse("\n# a comment\naccount3|pw\n\n");
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].username, "account3");
});

test("tiktok-lines reports a malformed line (missing username) without leaking the raw line content in the error", () => {
  const { records, errors } = tiktokLines.parse("|justapassword\naccount4|pw2");
  assert.equal(records.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.equal(errors[0].reason, "missing username");
  assert.ok(!errors[0].reason.includes("justapassword"), "error reason must never contain raw secret-bearing line content");
});

test("tiktok-lines treats a cookie field containing extra pipe characters as part of the cookie blob, not extra fields", () => {
  const { records } = tiktokLines.parse("account5|pw|e@x.com|mp|ext|name1=val1|name2=val2");
  assert.equal(records[0].cookies, "name1=val1|name2=val2");
});
