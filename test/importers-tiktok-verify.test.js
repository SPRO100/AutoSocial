const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyTikTokSession } = require("../src/importers/tiktok-verify");

function makePage({ finalUrl, gotoError, waitError }) {
  return {
    goto: async () => {
      if (gotoError) throw gotoError;
    },
    waitForLoadState: async () => {
      if (waitError) throw waitError;
    },
    url: () => finalUrl,
  };
}

test("reports active when the page lands on the TikTok upload page with no login redirect", async () => {
  const page = makePage({ finalUrl: "https://www.tiktok.com/tiktokstudio/upload" });
  const result = await verifyTikTokSession(page);
  assert.equal(result.active, true);
});

test("reports NOT active when redirected to a login URL", async () => {
  const page = makePage({ finalUrl: "https://www.tiktok.com/login?redirect_url=%2Fupload" });
  const result = await verifyTikTokSession(page);
  assert.equal(result.active, false);
  assert.match(result.reason, /login/);
});

test("reports NOT active when navigated off tiktok.com entirely", async () => {
  const page = makePage({ finalUrl: "https://example.com/unexpected" });
  const result = await verifyTikTokSession(page);
  assert.equal(result.active, false);
});

test("reports NOT active (fails closed) when navigation itself throws", async () => {
  const page = makePage({ finalUrl: "https://www.tiktok.com/tiktokstudio/upload", gotoError: new Error("net::ERR_CONNECTION_RESET") });
  const result = await verifyTikTokSession(page);
  assert.equal(result.active, false);
  assert.match(result.reason, /verification failed/);
});

test("a waitForLoadState timeout is tolerated (non-fatal) and the URL check still runs", async () => {
  const page = makePage({ finalUrl: "https://www.tiktok.com/tiktokstudio/upload" });
  page.waitForLoadState = async () => { throw new Error("Timeout 8000ms exceeded"); };
  // verifyTikTokSession itself must swallow this internally - simulate the
  // real module's own .catch(() => {}) by calling through the real function.
  const result = await verifyTikTokSession(page);
  assert.equal(result.active, true, "a networkidle timeout must not be treated as a failed verification");
});
