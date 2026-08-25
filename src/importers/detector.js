// Supplier-format registry + detection.
//
// Adding a new supplier format means adding one adapter here - never
// touching the import pipeline (src/importers/pipeline.js) or the Dashboard
// routes that call it. Each adapter exports { id, test(text), parse(text) }
// (see src/importers/suppliers/tiktok-pipe7.js for the contract).
const tiktokPipe7 = require("./suppliers/tiktok-pipe7");
const csv = require("./suppliers/csv");
const instagramColon = require("./suppliers/instagram-colon");

const SUPPLIERS = [csv, tiktokPipe7, instagramColon];

// Returns the first matching adapter, or null if nothing recognizes the
// file. Order matters only if two adapters could both match the same text;
// registered suppliers should keep their test() conservative enough that
// this stays a non-issue.
function detectFormat(text) {
  for (const supplier of SUPPLIERS) {
    if (supplier.test(text)) return supplier;
  }
  return null;
}

function getSupplierById(id) {
  return SUPPLIERS.find((s) => s.id === id) || null;
}

module.exports = { detectFormat, getSupplierById, SUPPLIERS };
