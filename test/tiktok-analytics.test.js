const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMetric, parseStudioDate } = require("../src/tiktok-analytics");

test("TikTok Studio metrics parse compact values and preserve unavailable values", () => {
  assert.equal(parseMetric("1.2K"), 1200);
  assert.equal(parseMetric("0"), 0);
  assert.equal(parseMetric("N/A"), null);
});

test("TikTok Studio locale date with narrow no-break space anchors to canonical year", () => {
  const canonical = new Date("2026-08-24T10:06:48.091Z");
  const parsed = parseStudioDate("Aug 24, 6:06\u202fAM", canonical);
  assert.ok(parsed);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 7);
  assert.equal(parsed.getDate(), 24);
  assert.equal(parsed.getHours(), 6);
  assert.equal(parsed.getMinutes(), 6);
});
