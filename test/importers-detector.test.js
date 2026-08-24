const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { detectFormat, getSupplierById } = require("../src/importers/detector");
const tiktokPipe7 = require("../src/importers/suppliers/tiktok-pipe7");
const csv = require("../src/importers/suppliers/csv");

// Real fixture FILE (not just an inline string) matching the confirmed real
// supplier format: a marketing/informational header (never real account
// data) followed by two pipe-delimited account rows. Every credential/
// token/cookie value in it is fake - see test/fixtures/tiktok-pipe7-sample.txt.
const REALISTIC_FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "tiktok-pipe7-sample.txt"),
  "utf8"
);

test("detectFormat recognizes the real 7-field TikTok supplier format even with a marketing header present", () => {
  const supplier = detectFormat(REALISTIC_FIXTURE);
  assert.ok(supplier, "expected a supplier adapter to claim this file");
  assert.equal(supplier.id, "tiktok-pipe7-v1");
});

test("a file with the seller header plus exactly two account lines parses to exactly two records", () => {
  const { records, errors } = tiktokPipe7.parse(REALISTIC_FIXTURE);
  assert.equal(errors.length, 0, "the header must never be reported as a parse error");
  assert.equal(records.length, 2);
  assert.equal(records[0].username, "fakeacct_one");
  assert.equal(records[1].username, "fakeacct_two");
});

test("detectFormat returns null for a file that matches no registered supplier", () => {
  const supplier = detectFormat("this is just some unrelated prose\nwith no delimiters at all\n");
  assert.equal(supplier, null);
});

test("detectFormat returns null for empty input", () => {
  assert.equal(detectFormat(""), null);
  assert.equal(detectFormat(null), null);
});

test("detectFormat returns null for a file containing only the seller's own column-header template line, no real accounts", () => {
  const supplier = detectFormat("username|password|email|emailPassword|authToken|externalId|cookies\n");
  assert.equal(supplier, null);
});

test("getSupplierById finds the registered real adapter by id, null otherwise", () => {
  assert.equal(getSupplierById("tiktok-pipe7-v1").id, "tiktok-pipe7-v1");
  assert.equal(getSupplierById("does-not-exist"), null);
});

// --- tiktok-pipe7 adapter itself --------------------------------------

test("tiktok-pipe7 parses a full line into every normalized field, including authToken", () => {
  const { records, errors } = tiktokPipe7.parse(
    "acct1|FakePass1|acct1@example.com|FakeMailPass1|fake-auth-token-1|ext-001|sessionid=fakeVal1; sid_tt=fakeVal2"
  );
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    platform: "tiktok",
    username: "acct1",
    password: "FakePass1",
    email: "acct1@example.com",
    emailPassword: "FakeMailPass1",
    authToken: "fake-auth-token-1",
    externalId: "ext-001",
    cookies: "sessionid=fakeVal1; sid_tt=fakeVal2",
  });
});

test("tiktok-pipe7 handles trailing field VALUES being empty (username + password only, delimiters still present)", () => {
  // The real format always emits all 6 separators for a well-formed row -
  // it's a fixed automated export, not free text - so "optional" means
  // the VALUE between two pipes can be empty, not that trailing pipes are
  // dropped entirely. See the header-skipping test below for why a line
  // needs enough pipes to look like an attempted row in the first place.
  const { records, errors } = tiktokPipe7.parse("acct2|FakePass2|||||");
  assert.equal(errors.length, 0);
  assert.deepEqual(records[0], { platform: "tiktok", username: "acct2", password: "FakePass2" });
});

test("tiktok-pipe7 requires only username - a bare username with every other field empty is still a valid record", () => {
  const { records, errors } = tiktokPipe7.parse("acct-username-only||||||");
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { platform: "tiktok", username: "acct-username-only" });
});

test("tiktok-pipe7 skips blank lines, # comment lines, and a multi-line marketing/ad header, reporting zero errors for any of it", () => {
  const text = [
    "############################",
    "# Seller notes - read first #",
    "############################",
    "",
    "Fresh batch, delivered today!",
    "Contact us on Telegram for support.",
    "",
    "acct3|FakePass3|||||",
    "",
  ].join("\n");
  const { records, errors } = tiktokPipe7.parse(text);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].username, "acct3");
});

test("tiktok-pipe7 skips a literal column-header line (seller's own template row) wherever it appears in the file", () => {
  const text = [
    "username|password|email|emailPassword|authToken|externalId|cookies",
    "acct4|FakePass4|acct4@example.com|FakeMailPass4|fake-token-4|ext-004|sessionid=fakeVal4",
  ].join("\n");
  const { records, errors } = tiktokPipe7.parse(text);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].username, "acct4");
});

test("tiktok-pipe7 reports a malformed line (missing username) without leaking the raw line content in the error", () => {
  const { records, errors } = tiktokPipe7.parse(
    "|FakePass5|acct5@example.com|FakeMailPass5|fake-token-5|ext-005|sessionid=fakeVal5\nacct6|FakePass6|||||"
  );
  assert.equal(records.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.equal(errors[0].reason, "missing username");
  assert.ok(!errors[0].reason.includes("FakePass5"), "error reason must never contain raw secret-bearing line content");
  assert.ok(!errors[0].reason.includes("sessionid"), "error reason must never contain raw cookie content");
});

test("tiktok-pipe7 treats a cookie field containing extra pipe characters as part of the cookie blob, never as extra fields", () => {
  const { records } = tiktokPipe7.parse(
    "acct7|FakePass7|acct7@example.com|FakeMailPass7|fake-token-7|ext-007|sessionid=fakeVal7|extra=piece|more=data"
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].cookies, "sessionid=fakeVal7|extra=piece|more=data");
  assert.equal(records[0].externalId, "ext-007", "fields before the cookie boundary must be unaffected by pipes inside it");
});

test("tiktok-pipe7 captures real-shaped TikTok session cookie names in the cookies field verbatim", () => {
  const cookieBlob = "sessionid=fakeSESSION1; sessionid_ss=fakeSESSIONSS1; sid_tt=fakeSIDTT1; uid_tt=fakeUIDTT1; ttwid=fakeTTWID1";
  const { records } = tiktokPipe7.parse(`acct8|FakePass8|acct8@example.com|FakeMailPass8|fake-token-8|ext-008|${cookieBlob}`);
  assert.equal(records[0].cookies, cookieBlob);
});

test("tiktok-pipe7's own test() rejects prose/ad text with fewer than 6 pipes, so it never falsely claims an unrelated file", () => {
  assert.equal(tiktokPipe7.test("Contact us | for the best | TikTok accounts | on the market!"), false);
});

test("generic CSV importer supports all browser platforms and never exposes credential values in preview", () => {
  const input = "platform,handle,password,project,group\ninstagram,@creator,secret,brand,video\nthreads,@threads-user,,,brand,\nyoutube,@channel,,,brand,\nx,@x-user,,,brand,\n";
  assert.equal(csv.test(input), true);
  const parsed = csv.parse(input);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.records.map((r) => r.platform), ["instagram", "threads", "youtube", "x"]);
  assert.equal(parsed.records[0].password, "secret");
  const normalize = require("../src/importers/normalize");
  const preview = normalize.toSafePreview(parsed.records[0]);
  assert.equal(preview.password, undefined);
  assert.equal(preview.hasPassword, true);
});
