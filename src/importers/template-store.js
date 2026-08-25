const fs = require("fs/promises"); const path = require("path"); const { config } = require("../config");
const FILE = path.resolve(config.projectRoot, "importer-templates.json");
async function read() { try { const value = JSON.parse(await fs.readFile(FILE, "utf8")); return Array.isArray(value) ? value : []; } catch { return []; } }
async function list(platform) { const all = await read(); return platform ? all.filter((x) => x.platform === platform) : all; }
async function save(template) { const all = await read(); const safe = { id: template.id || `${template.platform}-${Date.now()}`, name: String(template.name || "Supplier template").slice(0, 80), platform: template.platform, delimiter: template.delimiter, fields: template.fields, version: 1, updatedAt: new Date().toISOString() }; const next = [...all.filter((x) => x.id !== safe.id && !(x.name === safe.name && x.platform === safe.platform)), safe]; await fs.writeFile(FILE, JSON.stringify(next, null, 2), { mode: 0o600 }); return safe; }
async function remove(id) { const all = await read(); const next = all.filter((x) => x.id !== id); await fs.writeFile(FILE, JSON.stringify(next, null, 2), { mode: 0o600 }); return next.length !== all.length; }
module.exports = { list, save, remove };
