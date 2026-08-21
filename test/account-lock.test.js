const test = require("node:test");
const assert = require("node:assert/strict");
const accountLock = require("../src/account-lock");

test("account-lock: a second tryLock for the same accountId fails while the first is held", () => {
  const id = `lock-test-${Date.now()}-a`;
  assert.equal(accountLock.tryLock(id), true);
  assert.equal(accountLock.tryLock(id), false, "a locked account must reject a second concurrent lock");
  accountLock.unlock(id);
});

test("account-lock: unlock releases the lock so a later tryLock succeeds again", () => {
  const id = `lock-test-${Date.now()}-b`;
  assert.equal(accountLock.tryLock(id), true);
  accountLock.unlock(id);
  assert.equal(accountLock.tryLock(id), true, "unlock must actually release the lock");
  accountLock.unlock(id);
});

test("account-lock: different accountIds never contend with each other", () => {
  const a = `lock-test-${Date.now()}-c1`;
  const b = `lock-test-${Date.now()}-c2`;
  assert.equal(accountLock.tryLock(a), true);
  assert.equal(accountLock.tryLock(b), true, "locking one account must not block a different account");
  accountLock.unlock(a);
  accountLock.unlock(b);
});
