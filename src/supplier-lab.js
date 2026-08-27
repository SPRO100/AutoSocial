const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./config");

const STATE_FILE = path.resolve(process.env.SUPPLIER_LAB_STATE_FILE || path.join(config.projectRoot, "supplier-lab-state.json"));
let state = { experiments: [] };
let loaded = false;
let writeQueue = Promise.resolve();

function safe(value, max = 200) { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null; }
function id(value, fallback) { return safe(value, 120) || fallback; }
function now() { return new Date().toISOString(); }
function key(experimentId, accountId, checkpoint) { return `${experimentId}:${accountId}:${checkpoint}`; }
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(value || {})).digest("hex"); }

async function ensureLoaded() {
  if (loaded) return;
  try { state = JSON.parse(await fs.readFile(STATE_FILE, "utf8")); } catch { state = { experiments: [] }; }
  if (!Array.isArray(state.experiments)) state = { experiments: [] };
  loaded = true;
}
async function save() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(STATE_FILE, payload, "utf8")).catch(() => {});
  return writeQueue;
}

function classifyFailure(input = {}) {
  if (input.networkMismatch) return "NETWORK_PROXY";
  if (input.infrastructureFailure) return "PERSONA_INFRA";
  const status = String(input.status || input.sessionStatus || "").toUpperCase();
  if (status === "ACCOUNT_SUSPENDED" || status === "CHALLENGE_REQUIRED") return "PLATFORM_ENFORCEMENT";
  if (status === "LOGIN_REQUIRED") return "SUPPLIER_SESSION";
  if (status === "UNKNOWN") return "VERIFICATION_UNKNOWN";
  if (status === "READY") return null;
  return safe(input.failureClass, 80) || "UNKNOWN";
}

function sanitizeObservation(input = {}) {
  const status = safe(input.status || input.sessionStatus, 40) || "UNKNOWN";
  return {
    observationId: safe(input.observationId, 120) || fingerprint({ experimentId: input.experimentId, accountId: input.accountId, checkpoint: input.checkpoint }),
    accountId: safe(input.accountId, 120),
    checkpoint: safe(input.checkpoint, 20) || "T0",
    observedAt: safe(input.observedAt, 40) || now(),
    status,
    failureClass: classifyFailure(input),
    healthState: safe(input.healthState, 40),
    networkContinuityState: safe(input.networkContinuityState, 40),
    evidence: Array.isArray(input.evidence) ? input.evidence.map((e) => safe(e, 160)).filter(Boolean).slice(0, 12) : [],
    verifierReason: safe(input.verifierReason, 240),
  };
}

async function createExperiment(input = {}) {
  await ensureLoaded();
  const experiment = {
    experimentId: id(input.experimentId, `supplier-lab-${Date.now()}`),
    name: safe(input.name, 120) || "Supplier quality pilot",
    supplierId: safe(input.supplierId, 120),
    supplierBatchId: safe(input.supplierBatchId, 120),
    platform: safe(input.platform, 30) || "instagram",
    cohort: safe(input.cohort, 80),
    createdAt: now(),
    status: "PLANNED",
    observationPlan: ["T0", "T+24H", "T+72H", "T+7D"],
    accounts: [],
    observations: [],
  };
  state.experiments.push(experiment); await save(); return JSON.parse(JSON.stringify(experiment));
}

async function listExperiments() { await ensureLoaded(); return JSON.parse(JSON.stringify(state.experiments)); }
async function getExperiment(experimentId) { await ensureLoaded(); const e = state.experiments.find((x) => x.experimentId === experimentId); return e ? JSON.parse(JSON.stringify(e)) : null; }

async function recordBaseline(experimentId, input) {
  return recordObservation(experimentId, { ...input, checkpoint: "T0" });
}
async function recordObservation(experimentId, input = {}) {
  await ensureLoaded();
  const experiment = state.experiments.find((x) => x.experimentId === experimentId);
  if (!experiment) throw new Error("Supplier experiment not found.");
  const observation = sanitizeObservation({ ...input, experimentId });
  const existing = experiment.observations.find((x) => x.observationId === observation.observationId || key(experimentId, x.accountId, x.checkpoint) === key(experimentId, observation.accountId, observation.checkpoint));
  if (existing) return { ...JSON.parse(JSON.stringify(existing)), duplicate: true };
  experiment.observations.push(observation);
  if (observation.accountId && !experiment.accounts.includes(observation.accountId)) experiment.accounts.push(observation.accountId);
  experiment.status = "RUNNING";
  await save(); return JSON.parse(JSON.stringify(observation));
}

function scorecard(experiment) {
  const observations = experiment?.observations || [];
  const baseline = observations.filter((o) => o.checkpoint === "T0");
  const eligible = baseline.filter((o) => o.failureClass !== "PERSONA_INFRA" && o.failureClass !== "NETWORK_PROXY");
  const at = (checkpoint) => observations.filter((o) => o.checkpoint === checkpoint);
  const ready = (checkpoint) => { const rows = at(checkpoint); return eligible.filter((b) => rows.some((o) => o.accountId === b.accountId && o.status === "READY")).length; };
  const rate = (n, d) => d ? n / d : null;
  const counts = (checkpoint) => at(checkpoint).reduce((m, o) => { m[o.status] = (m[o.status] || 0) + 1; return m; }, {});
  return {
    experimentId: experiment?.experimentId || null,
    supplierId: experiment?.supplierId || null,
    supplierBatchId: experiment?.supplierBatchId || null,
    imported: baseline.length,
    eligibleDenominator: eligible.length,
    infrastructureExcluded: baseline.length - eligible.length,
    checkpoints: ["T0", "T+24H", "T+72H", "T+7D"].map((checkpoint) => ({ checkpoint, ready: ready(checkpoint), survivalRate: rate(ready(checkpoint), eligible.length), statusCounts: counts(checkpoint) })),
    note: "Supplier verdict requires controlled batches and complete observation windows; legacy accounts are excluded from denominator.",
  };
}

module.exports = { STATE_FILE, createExperiment, listExperiments, getExperiment, recordBaseline, recordObservation, scorecard, classifyFailure, sanitizeObservation, fingerprint };
