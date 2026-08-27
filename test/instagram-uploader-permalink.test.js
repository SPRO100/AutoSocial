const test = require("node:test");
const assert = require("node:assert/strict");

const { capturePermalink } = require("../src/instagram-uploader");

// Minimal fake Playwright Page exposing only what capturePermalink calls.
function makePage({ href, gotoError, locatorError } = {}) {
  return {
    goto: async () => {
      if (gotoError) throw gotoError;
    },
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => "https://www.instagram.com/fakeuser_one/",
    locator: () => ({
      first: () => ({
        waitFor: async () => {
          if (locatorError) throw locatorError;
        },
        getAttribute: async () => href ?? null,
      }),
    }),
  };
}

test("capturePermalink returns null/null when no username is supplied - never guesses a profile URL", async () => {
  const page = makePage({ href: "/p/FakeShortcode123/" });
  const result = await capturePermalink(page, null);
  assert.deepEqual(result, { remotePostId: null, remotePostUrl: null });
});

test("capturePermalink extracts the post id and full URL from a real /p/ grid link", async () => {
  const page = makePage({ href: "/p/FakeShortcode123/" });
  const result = await capturePermalink(page, "fakeuser_one");
  assert.equal(result.remotePostId, "FakeShortcode123");
  assert.equal(result.remotePostUrl, "https://www.instagram.com/p/FakeShortcode123/");
});

test("capturePermalink extracts the post id and full URL from a /reel/ grid link", async () => {
  const page = makePage({ href: "/reel/FakeReelCode456/" });
  const result = await capturePermalink(page, "fakeuser_one");
  assert.equal(result.remotePostId, "FakeReelCode456");
  assert.equal(result.remotePostUrl, "https://www.instagram.com/reel/FakeReelCode456/");
});

test("capturePermalink returns null/null (never throws) when navigation to the profile fails", async () => {
  const page = makePage({ gotoError: new Error("net::ERR_CONNECTION_RESET") });
  const result = await capturePermalink(page, "fakeuser_one");
  assert.deepEqual(result, { remotePostId: null, remotePostUrl: null });
});

test("capturePermalink returns null/null (never throws) when no grid link is ever found", async () => {
  const page = makePage({ locatorError: new Error("Timeout waiting for locator") });
  const result = await capturePermalink(page, "fakeuser_one");
  assert.deepEqual(result, { remotePostId: null, remotePostUrl: null });
});

test("capturePermalink returns null/null (never throws) when the link element has no href", async () => {
  const page = makePage({ href: null });
  const result = await capturePermalink(page, "fakeuser_one");
  assert.deepEqual(result, { remotePostId: null, remotePostUrl: null });
});

test("capturePermalink never leaks the username into the returned URL/id beyond what Instagram's own grid link already contains", async () => {
  const page = makePage({ href: "/p/AnotherFakeCode789/" });
  const result = await capturePermalink(page, "sensitive_test_username");
  assert.equal(JSON.stringify(result).includes("sensitive_test_username"), false);
});
