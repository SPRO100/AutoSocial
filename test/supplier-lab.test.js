const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

async function loadLab() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "supplier-lab-"));
  process.env.SUPPLIER_LAB_STATE_FILE = path.join(dir, "state.json");
  delete require.cache[require.resolve("../src/supplier-lab")];
  return require("../src/supplier-lab");
}

test("supplier observations are append-only and idempotent", async () => {
  const lab = await loadLab();
  const e = await lab.createExperiment({ experimentId: "e1", supplierId: "supplier-a", supplierBatchId: "batch-1" });
  const first = await lab.recordBaseline(e.experimentId, { accountId: "acct-1", status: "READY", evidence: ["live_verifier"] });
  const duplicate = await lab.recordBaseline(e.experimentId, { accountId: "acct-1", status: "LOGIN_REQUIRED", evidence: ["different"] });
  assert.equal(first.status, "READY");
  assert.equal(duplicate.duplicate, true);
  assert.equal((await lab.getExperiment("e1")).observations.length, 1);
});

test("scorecard excludes network/persona failures from supplier denominator", async () => {
  const lab = await loadLab();
  const e = await lab.createExperiment({ experimentId: "e2" });
  await lab.recordBaseline("e2", { accountId: "a", status: "READY" });
  await lab.recordBaseline("e2", { accountId: "b", status: "UNKNOWN", networkMismatch: true });
  await lab.recordObservation("e2", { accountId: "a", checkpoint: "T+24H", status: "READY" });
  const score = lab.scorecard(await lab.getExperiment("e2"));
  assert.equal(score.imported, 2);
  assert.equal(score.eligibleDenominator, 1);
  assert.equal(score.infrastructureExcluded, 1);
  assert.equal(score.checkpoints[1].survivalRate, 1);
});

test("network identity and observations never retain secret fields", async () => {
  const lab = await loadLab();
  const safe = lab.sanitizeObservation({ experimentId: "e3", accountId: "a", status: "READY", password: "secret", cookies: "sessionid=secret", proxyPassword: "secret" });
  assert.equal("password" in safe, false);
  assert.equal("cookies" in safe, false);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
  const fp = lab.fingerprint({ host: "proxy.example" });
  assert.match(fp, /^[a-f0-9]{64}$/);
});
