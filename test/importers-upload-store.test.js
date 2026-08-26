const test = require("node:test");
const assert = require("node:assert/strict");

const uploadStore = require("../src/importers/upload-store");

test.beforeEach(() => uploadStore._clearAllForTests());

test("default pending import lifetime is long enough for normal human review but remains bounded", () => {
  assert.ok(uploadStore.DEFAULT_TTL_MS >= 30 * 60 * 1000);
  assert.ok(uploadStore.DEFAULT_TTL_MS <= 60 * 60 * 1000);
});

test("put then take returns the exact records held, and take is single-use", () => {
  const records = [{ platform: "tiktok", username: "a", password: "secret" }];
  const importId = uploadStore.put(records, { format: "tiktok-pipe7-v1" });
  assert.equal(uploadStore.size(), 1);

  const first = uploadStore.take(importId);
  assert.deepEqual(first.records, records);
  assert.equal(first.meta.format, "tiktok-pipe7-v1");

  const second = uploadStore.take(importId);
  assert.equal(second, null, "a second take() for the same importId must return null - single use only");
  assert.equal(uploadStore.size(), 0);
});

test("take returns null for an unknown importId", () => {
  assert.equal(uploadStore.take("does-not-exist"), null);
});

test("an entry expires and is no longer retrievable after its TTL elapses", async () => {
  const importId = uploadStore.put([{ platform: "tiktok", username: "expiring" }], {}, 30);
  assert.equal(uploadStore.size(), 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(uploadStore.take(importId), null, "expired entries must not be retrievable");
});

test("peekMeta reads metadata without consuming the entry", () => {
  const importId = uploadStore.put([{ platform: "tiktok", username: "a" }], { format: "x" });
  assert.equal(uploadStore.peekMeta(importId).format, "x");
  assert.equal(uploadStore.size(), 1, "peekMeta must not consume the entry");
  uploadStore.take(importId);
});

test("each put() mints a distinct, unguessable-length importId", () => {
  const a = uploadStore.put([{ platform: "tiktok", username: "a" }]);
  const b = uploadStore.put([{ platform: "tiktok", username: "b" }]);
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
  uploadStore.take(a);
  uploadStore.take(b);
});
