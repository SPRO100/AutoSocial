const test = require("node:test");
const assert = require("node:assert/strict");
const { getBrowserAdapter } = require("../src/browser-platform-adapters");

test("browser adapter registry exposes Threads and X without inventing other platforms", () => {
  const threads = getBrowserAdapter("threads");
  const x = getBrowserAdapter("X");
  assert.deepEqual(threads.types, ["TEXT", "IMAGE", "VIDEO"]);
  assert.deepEqual(x.types, ["TEXT", "IMAGE", "VIDEO", "MULTI_MEDIA"]);
  assert.equal(getBrowserAdapter("tiktok"), null);
});

test("browser adapter registry does not expose credentials or session material", () => {
  const serialized = JSON.stringify(getBrowserAdapter("threads"));
  assert.doesNotMatch(serialized, /cookie|password|token|secret/i);
});
