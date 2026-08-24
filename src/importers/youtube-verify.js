const { config } = require("../config");

async function verifyYouTubeSession(page) {
  try {
    await page.goto(config.youtubeUploadPageUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    const url = page.url();
    if (/accounts\.google\.com|ServiceLogin|signin/i.test(url)) return { active: false, reason: "redirected to Google login" };
    if (!/youtube\.com/i.test(url)) return { active: false, reason: "did not remain on youtube.com" };
    return { active: true, reason: "reached YouTube Studio without a login redirect" };
  } catch (error) {
    return { active: false, reason: `verification failed: ${error.message}` };
  }
}

module.exports = { verifyYouTubeSession };
