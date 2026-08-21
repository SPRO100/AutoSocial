// Single per-account concurrency guard shared by every operation that
// attaches this account's Persona profile - session-check.js#checkSession
// and tiktok-publish.js#publish both acquire this SAME lock, not separate
// ones. This exists specifically because checkSession's running/stopped
// state-preservation logic (snapshot "was it running before?", then
// restore that exact state in a finally block) is only safe if no other
// operation can attach/detach the same profile in between - two
// overlapping callers for the same account would otherwise race each
// other's snapshot-and-restore and could stop a profile the other caller
// is still actively using mid-publish.
const locked = new Set();

function tryLock(accountId) {
  if (locked.has(accountId)) return false;
  locked.add(accountId);
  return true;
}

function unlock(accountId) {
  locked.delete(accountId);
}

module.exports = { tryLock, unlock };
