const test = require("node:test");
const assert = require("node:assert/strict");

const { computeAccountPersona, indexProfilesById } = require("../src/persona-overview");

test("computeAccountPersona returns null for an account with no personaProfileId", () => {
  const result = computeAccountPersona({ id: "a", name: "A" }, new Map(), true);
  assert.equal(result, null);
});

test("computeAccountPersona reports found:true with the real name/status when the profile exists in Persona's real list", () => {
  const profilesById = indexProfilesById([{ id: "p1", name: "My Profile", status: "running" }]);
  const result = computeAccountPersona({ id: "a", name: "A", personaProfileId: "p1" }, profilesById, true);
  assert.deepEqual(result, { id: "p1", name: "My Profile", status: "running", found: true });
});

test("computeAccountPersona reports found:false, status:unknown, name:null when Persona is reachable but genuinely does not have the profile (e.g. deleted)", () => {
  const profilesById = indexProfilesById([{ id: "other", name: "Other", status: "stopped" }]);
  const result = computeAccountPersona({ id: "a", name: "A", personaProfileId: "gone" }, profilesById, true);
  assert.deepEqual(result, { id: "gone", name: null, status: "unknown", found: false });
});

test("computeAccountPersona reports found:null, status:unknown when Persona API is unavailable - never fabricates true/false", () => {
  const result = computeAccountPersona({ id: "a", name: "A", personaProfileId: "p1" }, new Map(), false);
  assert.deepEqual(result, { id: "p1", name: null, status: "unknown", found: null });
});

test("indexProfilesById handles null/undefined/empty input safely", () => {
  assert.equal(indexProfilesById(null).size, 0);
  assert.equal(indexProfilesById(undefined).size, 0);
  assert.equal(indexProfilesById([]).size, 0);
});

test("indexProfilesById keys by real profile id, last one wins on a duplicate id (should never happen, but never throws)", () => {
  const index = indexProfilesById([{ id: "p1", name: "First" }, { id: "p1", name: "Second" }]);
  assert.equal(index.size, 1);
  assert.equal(index.get("p1").name, "Second");
});
