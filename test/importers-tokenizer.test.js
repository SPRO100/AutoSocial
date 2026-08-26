const test = require("node:test");
const assert = require("node:assert/strict");
const { splitDelimited } = require("../src/importers/tokenizer");

// Real production incident regression: a JSON cookie bundle's internal
// commas/colons must never be treated as field separators, or a supplier
// file with a JSON cookie column explodes into dozens of bogus columns
// (the exact "Column 1 / Column 2 / ..." symptom reported against a real
// Instagram supplier file).

test("comma delimiter does not split a JSON array containing commas", () => {
  const json = '[{"name":"sessionid","value":"a,b,c"},{"name":"csrftoken","value":"d"}]';
  const line = `alice,pass1,${json}`;
  const parts = splitDelimited(line, ",");
  assert.deepEqual(parts, ["alice", "pass1", json]);
});

test("colon delimiter does not split a JSON object containing colons", () => {
  const json = '{"sessionid":"abc:def","csrftoken":"ghi"}';
  const line = `alice:pass1:${json}`;
  const parts = splitDelimited(line, ":");
  assert.deepEqual(parts, ["alice", "pass1", json]);
});

test("nested brackets are tracked correctly (array of objects with nested arrays)", () => {
  const json = '[{"name":"a","tags":["x,y","z:q"]},{"name":"b","tags":[]}]';
  const line = `user,pw,${json}`;
  const parts = splitDelimited(line, ",");
  assert.deepEqual(parts, ["user", "pw", json]);
});

test("a double-quoted CSV field protects delimiter characters inside it", () => {
  const line = 'user,pw,"value, with, commas"';
  const parts = splitDelimited(line, ",");
  assert.deepEqual(parts, ["user", "pw", '"value, with, commas"']);
});

test("plain delimited lines with no JSON/quoting split exactly as before", () => {
  assert.deepEqual(splitDelimited("a|b|c", "|"), ["a", "b", "c"]);
  assert.deepEqual(splitDelimited("a:b:c:d", ":"), ["a", "b", "c", "d"]);
  assert.deepEqual(splitDelimited("a\tb\tc", "\t"), ["a", "b", "c"]);
});

test("trims whitespace around each token, matching the previous naive-split + trim behavior", () => {
  assert.deepEqual(splitDelimited(" alice , pass1 , x@example.test ", ","), ["alice", "pass1", "x@example.test"]);
});

test("an unbalanced trailing bracket never throws - depth just never returns to 0", () => {
  assert.doesNotThrow(() => splitDelimited("alice,pass1,[{\"name\":\"a\"", ","));
});
