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
const credentialsAuto = require("./suppliers/credentials-auto");

// Registration order also breaks ties when two adapters score equally
// (Array#sort is stable) - the more specific/structural adapters
// (instagram-colon, tiktok-pipe7, youtube-supplier) are listed before the
// generic ones (csv, credentials-auto) so a file that could plausibly match
// either prefers the platform-specific parser.
const SUPPLIERS = [instagramColon, tiktokPipe7, youtubeSupplier, csv, credentialsAuto];

// Returns the first matching adapter, or null if nothing recognizes the
// file. Order matters only if two adapters could both match the same text;
// registered suppliers should keep their test() conservative enough that
// this stays a non-issue.
function detectFormat(text, { platform } = {}) {
  // Platform-agnostic adapters (csv.js, credentials-auto.js) are marked
  // `generic: true` and are always considered regardless of a platform
  // hint - they determine (or are told) the platform from the file/caller
  // itself rather than from their own id, unlike a platform-specific
  // adapter such as instagram-colon-v1.
  const candidates = SUPPLIERS.filter((supplier) => !platform || supplier.generic || supplier.id.includes(String(platform).toLowerCase()));
  const scored = candidates.map((supplier) => ({ supplier, score: typeof supplier.score === "function" ? supplier.score(text) : { validRows: supplier.test(text) ? 1 : 0, confidence: "MEDIUM" } })).filter(({ score }) => score.validRows > 0);
  scored.sort((a, b) => b.score.validRows - a.score.validRows);
  return scored[0]?.supplier || null;
}

function getSupplierById(id) {
  return SUPPLIERS.find((s) => s.id === id) || null;
}

module.exports = { detectFormat, getSupplierById, SUPPLIERS };
