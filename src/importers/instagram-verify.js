const { config } = require("../config");

async function verifyInstagramSession(page) {
  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const url = page.url();
    if (/\/accounts\/login/i.test(url)) return { active: false, reason: "redirected to login" };
    if (!/instagram\.com/i.test(url)) return { active: false, reason: "did not remain on instagram.com" };
    return { active: true, reason: "reached Instagram without a login redirect" };
  } catch (error) {
    return { active: false, reason: `verification failed: ${error.message}` };
  }
}

module.exports = { verifyInstagramSession };
