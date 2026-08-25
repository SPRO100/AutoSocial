const fs = require("fs/promises"); const path = require("path"); const { config } = require("../config");
const FILE = path.resolve(config.projectRoot, "importer-templates.json");
async function read() { try { const value = JSON.parse(await fs.readFile(FILE, "utf8")); return Array.isArray(value) ? value : []; } catch { return []; } }
async function list(platform) { const all = await read(); return platform ? all.filter((x) => x.platform === platform) : all; }
function normalize(template) {
  const allowed = new Set(["username", "login", "email", "password", "twoFactorSecret", "cookie", "cookies", "recoveryEmail", "recoveryPassword", "channelUrl", "userAgent", "proxy", "phone", "emailPassword"]);
  const fields = {};
  for (const [key, value] of Object.entries(template?.fields || {})) {
    if (!allowed.has(key)) continue;
    if (value === "ignore" || value === null || value === undefined || value === "") fields[key] = "ignore";
    else if (Number.isInteger(Number(value)) && Number(value) >= 0) fields[key] = Number(value);
  }
  return {
    id: template.id,
    name: String(template.name || "Supplier template").slice(0, 80),
    platform: String(template.platform || "").toLowerCase(),
    delimiter: String(template.delimiter || "|"),
    fields,
    // Structural parser behavior is safe to persist; credentials never are.
    recordMode: ["ROW", "LABELLED_BLOCK", "AUTO"].includes(template.recordMode) ? template.recordMode : "AUTO",
    normalization: template.normalization && typeof template.normalization === "object" ? { ...template.normalization } : {},
    version: Number(template.version) || 1,
  };
}
async function save(template) { const all = await read(); const normalized = normalize(template); const safe = { ...normalized, id: normalized.id || `${normalized.platform}-${Date.now()}`, updatedAt: new Date().toISOString() }; const next = [...all.filter((x) => x.id !== safe.id && !(x.name === safe.name && x.platform === safe.platform)), safe]; await fs.writeFile(FILE, JSON.stringify(next, null, 2), { mode: 0o600 }); return safe; }
async function remove(id) { const all = await read(); const next = all.filter((x) => x.id !== id); await fs.writeFile(FILE, JSON.stringify(next, null, 2), { mode: 0o600 }); return next.length !== all.length; }
module.exports = { list, save, remove, normalize };
