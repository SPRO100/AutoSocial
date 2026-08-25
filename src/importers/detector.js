// Supplier-format registry + detection.
//
// Adding a new supplier format means adding one adapter here - never
// touching the import pipeline (src/importers/pipeline.js) or the Dashboard
// routes that call it. Each adapter exports { id, test(text), parse(text) }
// (see src/importers/suppliers/tiktok-pipe7.js for the contract).
const tiktokPipe7 = require("./suppliers/tiktok-pipe7");
const csv = require("./suppliers/csv");
const instagramColon = require("./suppliers/instagram-colon");
const youtubeSupplier = require("./suppliers/youtube-supplier");

const SUPPLIERS = [csv, tiktokPipe7, instagramColon, youtubeSupplier];

// Returns the first matching adapter, or null if nothing recognizes the
// file. Order matters only if two adapters could both match the same text;
// registered suppliers should keep their test() conservative enough that
// this stays a non-issue.
function detectFormat(text, { platform } = {}) {
  const candidates = SUPPLIERS.filter((supplier) => !platform || supplier.id.includes(String(platform).toLowerCase()) || supplier.id === "generic-csv-v1");
  const scored = candidates.map((supplier) => ({ supplier, score: typeof supplier.score === "function" ? supplier.score(text) : { validRows: supplier.test(text) ? 1 : 0, confidence: "MEDIUM" } })).filter(({ score }) => score.validRows > 0);
  scored.sort((a, b) => b.score.validRows - a.score.validRows);
  return scored[0]?.supplier || null;
}

function getSupplierById(id) {
  return SUPPLIERS.find((s) => s.id === id) || null;
}

module.exports = { detectFormat, getSupplierById, SUPPLIERS };
