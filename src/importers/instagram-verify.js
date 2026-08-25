const { config } = require("../config");

async function verifyInstagramSession(page, expectedUsername = null) {
  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const url = page.url();
    if (/\/accounts\/login/i.test(url)) return { active: false, reason: "redirected to login" };
    if (!/instagram\.com/i.test(url)) return { active: false, reason: "did not remain on instagram.com" };
    // When the authenticated shell exposes a profile link, bind the session
    // to the imported identity. If Instagram changes its shell and no
    // identity marker is available, keep the conservative navigation result
    // but explicitly report that identity was not observable (never guess a
    // different account from caption/name text).
    if (expectedUsername && typeof page.locator === "function") {
      try {
        const handles = await page.locator('a[href^="/"]').evaluateAll((anchors) => anchors.map((a) => String(a.getAttribute("href") || "").replace(/^\//, "").split("/")[0].toLowerCase()).filter(Boolean));
        const expected = String(expectedUsername).replace(/^@/, "").toLowerCase();
        if (handles.length && !handles.includes(expected)) return { active: false, reason: "authenticated identity did not match the imported username" };
        return { active: true, reason: handles.length ? "reached Instagram and matched the imported identity" : "reached Instagram; identity marker was unavailable" };
      } catch {
        // DOM inspection is diagnostic only; navigation/auth redirect remains
        // the source of truth when a page implementation lacks locators.
      }
    }
    return { active: true, reason: "reached Instagram without a login redirect" };
  } catch (error) {
    return { active: false, reason: `verification failed: ${error.message}` };
  }
}

module.exports = { verifyInstagramSession };
