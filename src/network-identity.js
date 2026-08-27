const crypto = require("crypto");

function text(value, max = 80) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v ? v.slice(0, max) : null;
}

function hostFingerprint(host) {
  const value = text(host, 255);
  return value ? crypto.createHash("sha256").update(value).digest("hex") : null;
}

/** Secret-free requested network identity projection. */
function summarizeProxy(proxy, expected = {}) {
  if (!proxy || typeof proxy !== "object") {
    return { proxyConfigured: false, networkContinuityState: "UNCONFIGURED" };
  }
  const host = text(proxy.host || proxy.hostname, 255);
  const type = text(proxy.type || proxy.protocol, 30);
  const country = text(proxy.country, 30);
  const out = {
    proxyConfigured: Boolean(host),
    proxyType: type,
    proxyHostFingerprint: hostFingerprint(host),
    proxyPort: Number.isFinite(Number(proxy.port)) ? Number(proxy.port) : null,
    proxyCountry: country,
    expectedCountry: text(expected.country || proxy.expectedCountry, 30),
    networkContinuityState: host ? "REQUESTED" : "UNCONFIGURED",
  };
  if (expected.provider) out.proxyProvider = text(expected.provider, 80);
  return out;
}

module.exports = { summarizeProxy, hostFingerprint };
