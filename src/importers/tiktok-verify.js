// Conservative, TikTok-specific "is this session actually authenticated"
// check for the bulk importer (src/importers/pipeline.js).
//
// Platform-specific on purpose - see detector.js's comment on why supplier
// format is isolated per-adapter; the same isolation applies to session
// verification, so adding Instagram/YouTube import later means adding a
// sibling file here, not touching this one or the pipeline.
//
// Fails CLOSED: any ambiguity (navigation error, unexpected timeout,
// unrecognized page) is reported as not-authenticated rather than guessed
// as active. A false "NEEDS LOGIN" just means a human re-checks the
// account; a false "Active" would be a real security mistake.
const { config } = require("../config");

async function verifyTikTokSession(page) {
  try {
    await page.goto(config.uploadPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Give TikTok's own auth redirect (if any) a chance to complete. Not
    // fatal if the page never reaches network-idle (some pages never do).
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const finalUrl = page.url();
    if (/\/login/i.test(finalUrl)) {
      return { active: false, reason: "redirected to login" };
    }
    if (!finalUrl.includes("tiktok.com")) {
      return { active: false, reason: `navigated away from tiktok.com (${new URL(finalUrl).hostname})` };
    }
    if (!finalUrl.includes("/upload")) {
      return { active: false, reason: "did not land on the upload page" };
    }
    return { active: true, reason: "reached the upload page without a login redirect" };
  } catch (error) {
    return { active: false, reason: `verification failed: ${error.message}` };
  }
}

module.exports = { verifyTikTokSession };
