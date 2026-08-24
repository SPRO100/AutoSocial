async function verifyThreadsSession(page) {
  try {
    await page.goto("https://www.threads.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const url = page.url();
    if (/login|accounts/i.test(url)) return { active: false, reason: "redirected to login" };
    if (!/threads\.(com|net)/i.test(url)) return { active: false, reason: "did not remain on threads.com" };
    return { active: true, reason: "reached Threads without a login redirect" };
  } catch (error) {
    return { active: false, reason: `verification failed: ${error.message}` };
  }
}

module.exports = { verifyThreadsSession };
