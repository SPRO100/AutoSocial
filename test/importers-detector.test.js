const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { detectFormat, getSupplierById } = require("../src/importers/detector");
const tiktokPipe7 = require("../src/importers/suppliers/tiktok-pipe7");
const csv = require("../src/importers/suppliers/csv");
const instagramColon = require("../src/importers/suppliers/instagram-colon");
const instagramAndroidSession = require("../src/importers/suppliers/instagram-android-session");
const youtubeSupplier = require("../src/importers/suppliers/youtube-supplier");

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

test("Instagram colon importer accepts password-only and cookie rows without exposing secrets", () => {
  const result = instagramColon.parse("alice:pass\nbob:pass:sessionid=redacted; csrftoken=redacted");
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.records.map(({ platform, username, password, cookies }) => ({ platform, username, password, cookies })), [
    { platform: "instagram", username: "alice", password: "pass", cookies: undefined },
    { platform: "instagram", username: "bob", password: "pass", cookies: "sessionid=redacted; csrftoken=redacted" },
  ]);
});

test("Instagram colon importer fails closed for ambiguous third fields", () => {
  const result = instagramColon.parse("alice:pass:opaque-value");
  assert.equal(result.records.length, 0);
  assert.equal(result.errors[0].code, "PARSE_REVIEW_REQUIRED");
});

test("Instagram colon importer recognizes explicit TOTP plus cookie and safe preview masks it", () => {
  const normalize = require("../src/importers/normalize");
  const result = instagramColon.parse("alice:pass:JBSWY3DPEHPK3PXP:sessionid=secret");
  assert.equal(result.errors.length, 0);
  assert.equal(result.records[0].twoFactorSecret, "JBSWY3DPEHPK3PXP");
  const safe = normalize.toSafePreview(result.records[0]);
  assert.equal(safe.hasTwoFactor, true);
  assert.equal(safe.hasCookies, true);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
});

test("Instagram colon importer ignores supplier advertising/instructions and preserves colon-containing cookies", () => {
  const input = [
    "Order: Instagram accounts below",
    "IMPORTANT! Use a proxy or https://proxy.example",
    "Mircard instructions: read before use",
    "Your order below",
    "alice_user:SafePass123:sessionid=abc:def; csrftoken=ghi",
    "bob_user:SafePass456",
    "Received? Contact: support@example.test",
    "",
  ].join("\r\n");
  const supplier = getSupplierById("instagram-colon-v1");
  assert.equal(supplier.test(input), true);
  const result = supplier.parse(input);
  assert.equal(result.records.length, 2);
  assert.equal(result.ignoredMetadata, 5);
  assert.equal(result.errors.length, 0);
  assert.equal(result.records[0].username, "alice_user");
  assert.equal(result.records[0].cookies, "sessionid=abc:def; csrftoken=ghi");
  assert.equal(result.records[1].username, "bob_user");
});

test("Instagram colon importer does not claim metadata-only files", () => {
  const supplier = getSupplierById("instagram-colon-v1");
  const input = "Order: 12 accounts\nIMPORTANT: https://example.test\nYour order below\n";
  assert.equal(supplier.test(input), false);
  const result = supplier.parse(input);
  assert.equal(result.records.length, 0);
  assert.equal(result.ignoredMetadata, 3);
});

test("universal detector selects YouTube supplier from mixed metadata and pipe rows", () => {
  const input = [
    "Order instructions: use a secure browser",
    "seller.example: https://youtube.com/channel/demo",
    "creator@example.test|SafePass456|recovery@example.test|https://youtube.com/channel/UCdemo|Mozilla/5.0 Chrome/120.0|SID=opaque; HSID=opaque",
  ].join("\n");
  const supplier = detectFormat(input);
  assert.equal(supplier.id, "youtube-supplier-v1");
  const parsed = supplier.parse(input);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].platform, "youtube");
  assert.equal(parsed.records[0].externalId, "https://youtube.com/channel/UCdemo");
  assert.equal(parsed.records[0].userAgent, "Mozilla/5.0 Chrome/120.0");
  assert.equal(parsed.records[0].cookies, "SID=opaque; HSID=opaque");
});

test("manual platform selection can select the YouTube adapter without auto-detection", () => {
  const supplier = detectFormat("creator@example.test|SafePass456|https://youtube.com/channel/UCdemo", { platform: "youtube" });
  assert.equal(supplier.id, "youtube-supplier-v1");
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

// --- instagram-android-session adapter (2026-08-27) -----------------------
// Real supplier format, first sample: instagram_test3.txt (real file, never
// committed - all fixtures/tests below use a fully synthetic stand-in with
// the identical structure, see test/fixtures/instagram-android-session-
// sample.txt). Real shape: USERNAME:PASSWORD||DEVICE_DATA|SESSION_DATA|||
// where SESSION_DATA is Instagram's private/mobile-API authorization state
// (Authorization, X-MID, IG-U-DS-USER-ID, IG-U-RUR, X-IG-WWW-Claim,
// csrftoken, sessionid) and freely contains both ':' and ';' internally -
// this format is detected/parsed purely by the '||' + single '|'
// structural shape, never by splitting on ':' or ';'.

const ANDROID_SESSION_FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "instagram-android-session-sample.txt"),
  "utf8"
);

// (A) header/service lines ignored - purely structural, never string-matched
// against a specific order-header wording or language.
test("instagram-android-session: detectFormat recognizes the real supplier shape and ignores the order header/dividers", () => {
  const supplier = detectFormat(ANDROID_SESSION_FIXTURE);
  assert.ok(supplier, "expected a supplier adapter to claim this file");
  assert.equal(supplier.id, "instagram-android-session-v1");
});

test("instagram-android-session: header/order-number/divider lines are ignored as metadata, never as errors", () => {
  const result = instagramAndroidSession.parse(ANDROID_SESSION_FIXTURE);
  assert.equal(result.errors.length, 0, "the header must never be reported as a parse error");
  // 4 header/divider lines + "Your order below:" - 5 non-account, non-blank lines.
  assert.equal(result.ignoredMetadata, 5);
});

// (B) a single valid account line is detected correctly
test("instagram-android-session: a lone account line (no header at all) is detected and parsed", () => {
  const line = "solo_fake_user:FakeSoloPass1||FAKE-DEVICE-UUID-SOLO;29|Authorization=Bearer FAKE:TOKEN:SOLO;csrftoken=fakecsrf_solo;sessionid=fakesession_solo|||";
  assert.equal(instagramAndroidSession.test(line), true);
  const { records, errors } = instagramAndroidSession.parse(line);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0].username, "solo_fake_user");
});

// (C) multiple account lines are all detected correctly
test("instagram-android-session: a file with exactly two account lines parses to exactly two records", () => {
  const { records, errors } = instagramAndroidSession.parse(ANDROID_SESSION_FIXTURE);
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.equal(records[0].username, "fakeuser_one");
  assert.equal(records[1].username, "fakeuser_two");
});

// (D) username/password extracted correctly - only from the credential
// prefix before "||", never corrupted by "||"/"|" characters afterward.
test("instagram-android-session: username/password are extracted exactly from the credential prefix, unaffected by the rest of the line", () => {
  const { records } = instagramAndroidSession.parse(ANDROID_SESSION_FIXTURE);
  assert.equal(records[0].username, "fakeuser_one");
  assert.equal(records[0].password, "FakePass!Aa1");
  assert.equal(records[1].username, "fakeuser_two");
  assert.equal(records[1].password, "FakePass!Bb2");
});

// (E) the session block is preserved byte-for-byte, including internal
// ':' and ';' characters - never split, never truncated, never mixed with
// device data.
test("instagram-android-session: the session block survives intact, including internal ':' inside Authorization and every named field", () => {
  const { records } = instagramAndroidSession.parse(ANDROID_SESSION_FIXTURE);
  const cookies = records[0].cookies;
  assert.equal(cookies.includes("Authorization=Bearer FAKE:JWT:TOKEN:VALUE1"), true, "the colon-bearing Authorization value must survive unsplit");
  assert.equal(cookies.includes("X-MID=FAKE_MID_0001"), true);
  assert.equal(cookies.includes("IG-U-DS-USER-ID=1000000001"), true);
  assert.equal(cookies.includes("IG-U-RUR=FAKE_RUR_0001"), true);
  assert.equal(cookies.includes("X-IG-WWW-Claim=FAKE_CLAIM_0001"), true);
  assert.equal(cookies.includes("csrftoken=fakecsrftoken0001"), true);
  assert.equal(cookies.includes("sessionid=fakesessionid0001"), true);
  assert.equal(cookies.endsWith("|"), false, "the trailing '|||' terminator must never leak into the preserved session block");
  assert.equal(cookies.includes("FAKE-DEVICE-UUID"), false, "device data must never be mixed into the session/cookie block");
});

// (F) device data is never mistaken for a 2FA secret
test("instagram-android-session: device data is never written to twoFactorSecret (or anywhere else) - not fabricated, not misclassified", () => {
  const { records } = instagramAndroidSession.parse(ANDROID_SESSION_FIXTURE);
  for (const record of records) {
    assert.equal(record.twoFactorSecret, undefined);
    assert.equal(JSON.stringify(record).includes("FAKE-DEVICE-UUID"), false, "device data must not appear anywhere in the canonical record");
  }
});

// (G) fields this supplier never provides stay empty/undefined - never fabricated
test("instagram-android-session: email/recoveryEmail/twoFactorSecret/authToken/externalId are undefined - this supplier never provides them, nothing is invented", () => {
  const { records } = instagramAndroidSession.parse(ANDROID_SESSION_FIXTURE);
  for (const record of records) {
    assert.equal(record.email, undefined);
    assert.equal(record.recoveryEmail, undefined);
    assert.equal(record.recoveryPassword, undefined);
    assert.equal(record.twoFactorSecret, undefined);
    assert.equal(record.authToken, undefined);
    assert.equal(record.externalId, undefined);
    assert.equal(record.phone, undefined);
    assert.deepEqual(Object.keys(record).sort(), ["cookies", "parserConfidence", "parserStatus", "password", "platform", "username"]);
  }
});

// (H) Safe Preview masks every secret - password, full session block, and
// device data must never appear in the preview object.
test("instagram-android-session: Safe Preview masks the password and the entire session block, exposing only booleans/counts", () => {
  const normalize = require("../src/importers/normalize");
  const { records } = instagramAndroidSession.parse(ANDROID_SESSION_FIXTURE);
  for (const record of records) {
    const safe = normalize.toSafePreview(record);
    assert.equal(safe.username, record.username, "username itself is not a secret and must remain visible");
    assert.equal(safe.hasPassword, true);
    assert.equal(safe.hasCookies, true);
    assert.ok(Number.isInteger(safe.cookieCount) && safe.cookieCount > 0);
    const serialized = JSON.stringify(safe);
    assert.equal(serialized.includes(record.password), false, "raw password must never reach the safe preview");
    assert.equal(serialized.includes("FAKE_MID"), false, "raw session data must never reach the safe preview");
    assert.equal(serialized.includes("csrftoken="), false);
    assert.equal(serialized.includes("sessionid="), false);
    assert.equal(serialized.includes("Authorization="), false);
    assert.equal(serialized.includes("FAKE-DEVICE-UUID"), false, "device data must never reach the safe preview either");
  }
});

// (I) existing supplier formats are unaffected by this format's addition -
// explicit regression lock on top of every pre-existing test in this file
// (which already re-runs unmodified against the new detector.js ordering).
test("instagram-android-session: adding this adapter does not change detection for the existing Instagram-colon or TikTok formats", () => {
  const instagramColonSample = "alice_user:SafePass123:sessionid=abc:def; csrftoken=ghi\nbob_user:SafePass456";
  assert.equal(detectFormat(instagramColonSample).id, "instagram-colon-v1");
  assert.equal(detectFormat(REALISTIC_FIXTURE).id, "tiktok-pipe7-v1");
});

// (J) a malformed (but clearly attempted) line never leaks credentials in
// its error - and a completely absent structural shape is silently
// skipped, never reported as an error at all.
test("instagram-android-session: a malformed attempted row reports a generic error with zero raw content, never the line itself", () => {
  const text = [
    "fakeuser_one:FakePass!Aa1||FAKE-DEVICE-UUID-0001;FAKE-PHONE-ID-0001;FAKE-ADID-0001;29|Authorization=Bearer FAKE:JWT:TOKEN:VALUE1;csrftoken=fakecsrftoken0001;sessionid=fakesessionid0001|||",
    // Malformed: has the '||' shape (clearly attempted) but only ONE field
    // after it - no device/session boundary at all.
    "broken_user:BrokenSecretPass123||only-one-field-here|||",
  ].join("\n");
  const { records, errors } = instagramAndroidSession.parse(text);
  assert.equal(records.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "INVALID_ROW");
  assert.ok(!errors[0].reason.includes("BrokenSecretPass123"), "error reason must never contain the raw password");
  assert.ok(!errors[0].reason.includes("broken_user"), "error reason must never contain the raw username");
  assert.ok(!errors[0].reason.includes("only-one-field-here"), "error reason must never contain raw line content");
  assert.equal(JSON.stringify(errors).includes("BrokenSecretPass123"), false);
});

test("instagram-android-session: a line with no '||' at all (a real order-header/divider line) is silently skipped, never reported as an error", () => {
  const { records, errors, ignoredMetadata } = instagramAndroidSession.parse("Order: Instagram accounts - Order #99999\n=================\n");
  assert.equal(records.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(ignoredMetadata, 2);
});
