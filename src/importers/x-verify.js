async function verifyXSession(page) {
  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
    const url = page.url();
    if (/login|i\/flow\/login/i.test(url)) return { active: false, reason: "redirected to login" };
    if (!/(^|\.)x\.com/i.test(new URL(url).hostname)) return { active: false, reason: "did not remain on x.com" };
    return { active: true, reason: "reached X without a login redirect" };
  } catch (error) {
    return { active: false, reason: `verification failed: ${error.message}` };
  }
}

module.exports = { verifyXSession };
