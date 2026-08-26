const test = require("node:test");
const assert = require("node:assert/strict");
const { isEmail, isTotp, isUserAgent, isLoginCandidate, isCookieBundle } = require("../src/importers/field-detect");

test("isEmail recognizes a plain email and rejects a username", () => {
  assert.equal(isEmail("alice@example.test"), true);
  assert.equal(isEmail("alice_user"), false);
  assert.equal(isEmail(""), false);
});

test("isTotp recognizes a base32 secret and a 6-8 digit code, rejects a password", () => {
  assert.equal(isTotp("JBSWY3DPEHPK3PXP"), true);
  assert.equal(isTotp("123456"), true);
  assert.equal(isTotp("12345678"), true);
  assert.equal(isTotp("SafePass123"), false);
  assert.equal(isTotp("1234"), false);
});

test("isUserAgent recognizes a real UA string and rejects other values", () => {
  assert.equal(isUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0"), true);
  assert.equal(isUserAgent("alice_user"), false);
});

test("isLoginCandidate accepts alnum handles including an alnum password, but rejects email and prose", () => {
  assert.equal(isLoginCandidate("alice_user"), true);
  assert.equal(isLoginCandidate("SafePass123"), true, "a plain alnum password also satisfies the login shape - this is a KNOWN ambiguity resolved positionally by credentials-auto.js, not here");
  assert.equal(isLoginCandidate("alice@example.test"), false, "email-shaped values are never login candidates - the caller's email check must win");
  assert.equal(isLoginCandidate("please contact support"), false);
});

test("isCookieBundle recognizes a JSON cookie array with name/value keys", () => {
  const json = JSON.stringify([{ name: "sessionid", value: "fake1", domain: ".instagram.com" }, { name: "csrftoken", value: "fake2" }]);
  assert.equal(isCookieBundle(json), true);
});

test("isCookieBundle recognizes a JSON object with a cookies array", () => {
  const json = JSON.stringify({ cookies: [{ name: "sessionid", value: "fake1" }] });
  assert.equal(isCookieBundle(json), true);
});

test("isCookieBundle recognizes a header-style cookie string via known cookie names", () => {
  assert.equal(isCookieBundle("sessionid=fake1; csrftoken=fake2; ds_user_id=123"), true);
});

test("isCookieBundle recognizes Netscape cookies.txt format", () => {
  assert.equal(isCookieBundle(".instagram.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tfake1"), true);
});

test("isCookieBundle rejects a plain password or JSON that has no cookie-like keys", () => {
  assert.equal(isCookieBundle("SafePass123"), false);
  assert.equal(isCookieBundle(JSON.stringify({ foo: "bar" })), false);
  assert.equal(isCookieBundle(""), false);
});

test("none of the classifiers ever throw on malformed/truncated input", () => {
  assert.doesNotThrow(() => isCookieBundle("[{\"name\":"));
  assert.doesNotThrow(() => isEmail(null));
  assert.doesNotThrow(() => isTotp(undefined));
});
