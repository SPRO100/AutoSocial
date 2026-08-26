// Ephemeral, in-memory-only holding area for a parsed supplier upload
// between the "preview" and "confirm" steps of the Dashboard import flow.
//
// Deliberately never touches disk: the uploaded file's content (and the
// normalized records parsed from it - passwords, cookies included) lives
// only in this process's memory, for at most DEFAULT_TTL_MS, and is deleted
// the moment it is consumed by take() or expires. This is a strictly
// stronger guarantee than "write a temp file then delete it after
// processing" - there is never a window where an uploaded credential file
// exists on disk at all, so it can never be accidentally committed, left
// behind by a crash, or picked up by an unrelated process.
const crypto = require("crypto");

// A human operator needs time to inspect a multi-account preview, resolve
// duplicates, and explicitly confirm it. Keep the normalized records
// memory-only, but use a bounded review window rather than expiring during a
// normal Dashboard workflow.
const DEFAULT_TTL_MS = 45 * 60 * 1000;

const store = new Map();

function put(records, meta = {}, ttlMs = DEFAULT_TTL_MS) {
  const importId = crypto.randomBytes(16).toString("hex");
  const timer = setTimeout(() => store.delete(importId), ttlMs);
  if (typeof timer.unref === "function") timer.unref();
  store.set(importId, { records, meta, timer });
  return importId;
}

// Single-use: consuming an import (successfully or not) removes it, so a
// re-submitted confirm request (double click, retry) can never process the
// same batch twice.
function take(importId) {
  const entry = store.get(importId);
  if (!entry) return null;
  store.delete(importId);
  clearTimeout(entry.timer);
  return entry;
}

function peekMeta(importId) {
  const entry = store.get(importId);
  return entry ? entry.meta : null;
}

function size() {
  return store.size;
}

function _clearAllForTests() {
  for (const entry of store.values()) clearTimeout(entry.timer);
  store.clear();
}

module.exports = { put, take, peekMeta, size, _clearAllForTests, DEFAULT_TTL_MS };
