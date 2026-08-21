const test = require("node:test");
const assert = require("node:assert/strict");

const { toPersonaCookiePayload } = require("../src/importers/cookie-adapter");

test("a raw HTTP-header-style cookie string is expanded into a Playwright-shaped cookies array with a platform default domain", () => {
  const payload = toPersonaCookiePayload("sessionid=abc123; sid_guard=def456", "tiktok");
  assert.ok(payload.cookies);
  assert.equal(payload.cookies.length, 2);
  assert.deepEqual(payload.cookies[0], { name: "sessionid", value: "abc123", domain: ".tiktok.com", path: "/", secure: true });
  assert.deepEqual(payload.cookies[1], { name: "sid_guard", value: "def456", domain: ".tiktok.com", path: "/", secure: true });
});

test("a JSON array/object is passed through as raw text unchanged, not re-parsed", () => {
  const json = JSON.stringify([{ name: "a", value: "1", domain: ".tiktok.com" }]);
  assert.deepEqual(toPersonaCookiePayload(json, "tiktok"), { text: json });

  const storageState = JSON.stringify({ cookies: [{ name: "a", value: "1" }], origins: [] });
  assert.deepEqual(toPersonaCookiePayload(storageState, "tiktok"), { text: storageState });
});

test("Netscape cookies.txt (tab-delimited) is passed through as raw text unchanged", () => {
  const netscape = ".tiktok.com\tTRUE\t/\tTRUE\t0\tsessionid\tabc123";
  assert.deepEqual(toPersonaCookiePayload(netscape, "tiktok"), { text: netscape });
});

test("returns null for empty/missing input", () => {
  assert.equal(toPersonaCookiePayload(null, "tiktok"), null);
  assert.equal(toPersonaCookiePayload("", "tiktok"), null);
  assert.equal(toPersonaCookiePayload("   ", "tiktok"), null);
});

test("returns null (rather than guessing) for a header-style string on a platform with no known default domain", () => {
  assert.equal(toPersonaCookiePayload("sessionid=abc123", "some-unsupported-platform"), null);
});

test("returns null for a header-style string with no valid name=value pairs at all", () => {
  assert.equal(toPersonaCookiePayload("this is not cookie data", "tiktok"), null);
});
