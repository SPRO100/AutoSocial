const path = require("path");
const { config } = require("./config");
const uiLabels = require("./platform-ui-labels");
const {
  getActiveAccount,
  getAccountById,
  hasSavedPlatformSession,
} = require("./account-manager");
const { acquireBrowserSession } = require("./browser-session");
const { verifyInstagramSession } = require("./importers/instagram-verify");

const REALISTIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const INSTAGRAM_LEGACY_LAUNCH_OPTIONS = {
  userAgent: REALISTIC_USER_AGENT,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
  ],
};

let loginSession = null;
let loginSessionAccountId = null;

async function openBrowserSession(accountId) {
  return acquireBrowserSession("instagram", {
    accountId,
    legacyLaunchOptions: INSTAGRAM_LEGACY_LAUNCH_OPTIONS,
  });
}

/**
 * Navigate with retry logic and exponential backoff.
 * On 429 / network errors, waits and retries up to `maxRetries` times.
 */
async function navigateWithRetry(page, url, { maxRetries = 3, waitUntil = "domcontentloaded" } = {}) {
  const backoffMs = [5000, 15000, 30000];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil, timeout: 60000 });
      if (response && response.status() === 429) {
        throw new Error("HTTP 429 - Instagram rate limit");
      }
      // Random human-like pause after navigation (1.5-3.5 s)
      await page.waitForTimeout(1500 + Math.random() * 2000);
      return response;
    } catch (error) {
      if (attempt >= maxRetries) {
        throw error;
      }
      const delay = backoffMs[attempt] || 30000;
      console.log(
        `Instagram navigation failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. ` +
        `Retrying in ${delay / 1000}s...`
      );
      await page.waitForTimeout(delay);
    }
  }
}

async function gotoUploadPage(page) {
  await navigateWithRetry(page, config.instagramUploadPageUrl);
}

async function startLoginSession() {
  const activeAccount = await getActiveAccount();
  if (loginSession && loginSessionAccountId !== activeAccount.id) {
    const previous = loginSession;
    loginSession = null;
    loginSessionAccountId = null;
    await previous.disconnect().catch(() => { });
  }

  if (loginSession) {
    return { ok: true, alreadyOpen: true };
  }

  const session = await openBrowserSession(activeAccount.id);
  loginSession = session;
  loginSessionAccountId = activeAccount.id;
  const clearIfCurrent = () => {
    if (loginSession === session) {
      loginSession = null;
      loginSessionAccountId = null;
    }
  };
  if (session.browser) {
    session.browser.on("disconnected", clearIfCurrent);
  } else {
    session.context.on("close", clearIfCurrent);
  }

  // Navigate to the homepage first; less suspicious than going straight to /create/.
  await navigateWithRetry(session.page, "https://www.instagram.com/");
  return { ok: true, alreadyOpen: false, url: session.page.url() };
}

async function getLoginSessionStatus() {
  const activeAccount = await getActiveAccount();
  const saved = await hasSavedPlatformSession("instagram", activeAccount.id);
  return {
    open: Boolean(loginSession) && loginSessionAccountId === activeAccount.id,
    saved,
  };
}

async function closeLoginSession() {
  if (!loginSession) {
    return { ok: true, alreadyClosed: true };
  }
  const session = loginSession;
  loginSession = null;
  loginSessionAccountId = null;
  await session.disconnect().catch(() => { });
  return { ok: true, alreadyClosed: false };
}

async function clickFirstVisibleEnabledLocator(page, locator) {
  const total = await locator.count();
  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) continue;
    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
      await candidate.click({ timeout: 5000 });
      return true;
    } catch {
      try {
        await candidate.click({ timeout: 5000, force: true });
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}

async function ensureCreateFlowInput(page) {
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) > 0) return input;

  const createPattern = uiLabels.pattern("create");
  const postFormatPattern = uiLabels.pattern("instagramPostFormat", "instagramReelFormat");
  const createEntryPoints = [
    page.getByRole("link", { name: createPattern }),
    page.getByRole("button", { name: createPattern }),
    page.locator('a[href*="/create"]').filter({ hasText: createPattern }),
    page.locator('nav a, nav [role="link"], nav button, nav [role="button"]').filter({
      hasText: createPattern,
    }),
  ];

  for (const entry of createEntryPoints) {
    const clicked = await clickFirstVisibleEnabledLocator(page, entry);
    if (!clicked) continue;
    console.log("Instagram create entry clicked.");
    await page.waitForTimeout(1200);
    if ((await input.count()) > 0) return input;
  }

  // Some flows open a chooser first (post/reel/story).
  const formatPickers = [
    ...uiLabels
      .terms("instagramPostFormat", "instagramReelFormat")
      .map((term) => page.getByText(term, { exact: true })),
    page.getByRole("button", { name: postFormatPattern }),
    page.getByRole("menuitem", { name: postFormatPattern }),
    page.getByRole("button", { name: /reel|reels/i }),
    page.locator('[role="menuitem"], [role="option"], button, a').filter({
      hasText: postFormatPattern,
    }),
  ];
  for (const picker of formatPickers) {
    const clicked = await clickFirstVisibleEnabledLocator(page, picker);
    if (!clicked) continue;
    console.log("Instagram post format selected (Post/Reel).");
    await page.waitForTimeout(1200);
    if ((await input.count()) > 0) return input;
  }

  const createButtons = [
    page.getByRole("button", { name: uiLabels.pattern("create", "instagramPostFormat") }),
    page.locator('[role="button"]').filter({ hasText: uiLabels.pattern("create", "instagramPostFormat") }),
    page.locator("a, [role='link']").filter({ hasText: uiLabels.pattern("create", "instagramPostFormat") }),
  ];

  for (const button of createButtons) {
    const clicked = await clickFirstVisibleEnabledLocator(page, button);
    if (clicked) {
      await page.waitForTimeout(1200);
      if ((await input.count()) > 0) return input;
    }
  }

  return input;
}

async function setMediaFiles(page, mediaPaths) {
  const paths = Array.isArray(mediaPaths) ? mediaPaths : [mediaPaths];
  let input = await ensureCreateFlowInput(page);
  if ((await input.count()) > 0) {
    await input.waitFor({ state: "attached", timeout: 120000 });
    await input.setInputFiles(paths);
    return;
  }

  // Fallback: use file chooser event if no file input is exposed yet.
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10000 }).catch(() => null);
  const uploadTriggerPattern = uiLabels.pattern("instagramUploadTrigger");
  const uploadTriggers = [
    page.getByRole("button", { name: uploadTriggerPattern }),
    page.locator('button, [role="button"]').filter({
      hasText: uploadTriggerPattern,
    }),
  ];

  for (const trigger of uploadTriggers) {
    const clicked = await clickFirstVisibleEnabledLocator(page, trigger);
    if (clicked) {
      console.log("Instagram upload trigger clicked.");
      break;
    }
  }

  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(paths);
    return;
  }

  // One last attempt to locate input after opening dialogs.
  input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 120000 });
  await input.setInputFiles(paths);
}

async function clickNextButtons(page) {
  const nextSelectors = [
    page.getByRole("button", { name: uiLabels.pattern("next") }),
    page.locator("button").filter({ hasText: uiLabels.pattern("next") }),
  ];

  for (let pass = 0; pass < 3; pass += 1) {
    let clicked = false;
    for (const selector of nextSelectors) {
      const didClick = await clickFirstVisibleEnabledLocator(page, selector);
      if (didClick) {
        clicked = true;
        await page.waitForTimeout(1200);
        break;
      }
    }
    if (!clicked) break;
  }
}

async function setCaption(page, caption) {
  if (!caption) return;
  const candidates = [
    uiLabels.attrSelector("textarea", "aria-label", "captionAttribute"),
    uiLabels.attrSelector("textarea", "placeholder", "captionAttribute"),
    'textarea',
    'div[contenteditable="true"]',
  ];

  for (const selector of candidates) {
    const target = page.locator(selector).first();
    if ((await target.count()) === 0) continue;
    try {
      await target.click({ timeout: 8000 });
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Delete");
      await target.type(caption, { delay: 10 });
      return;
    } catch {
      // next
    }
  }
}

async function clickShare(page) {
  const sharePattern = uiLabels.pattern("share");
  const shareLocators = [
    page.getByRole("button", { name: sharePattern }),
    page.locator("button").filter({ hasText: sharePattern }),
    page.locator('[role="button"]').filter({ hasText: sharePattern }),
  ];

  for (const locator of shareLocators) {
    const clicked = await clickFirstVisibleEnabledLocator(page, locator);
    if (clicked) return true;
  }
  return false;
}

async function waitForPostConfirmation(page, startedUrl) {
  // Wait up to 60 * 1500ms = 90 seconds for upload processing
  for (let i = 0; i < 60; i += 1) {
    const text = await page.locator("body").innerText().catch(() => "");
    if (uiLabels.pattern("posted").test(text)) {
      return { ok: true };
    }
    if (uiLabels.pattern("error").test(text)) {
      return { ok: false, reason: "Instagram reported an error while posting." };
    }

    const currentUrl = page.url();
    if (currentUrl !== startedUrl && !/\/create\//i.test(currentUrl)) {
      return { ok: true };
    }
    await page.waitForTimeout(1500);
  }
  return { ok: false, reason: "No reliable Instagram post confirmation within timeout." };
}

async function uploadMedia({ mediaPaths, caption, accountId, publicationType = "video" }) {
  const absoluteMediaPaths = (Array.isArray(mediaPaths) ? mediaPaths : [mediaPaths]).map((file) => path.resolve(file));
  let session = null;
  const telemetry = {
    phase: "SESSION_ACQUIRE",
    attempt: 1,
    externalActionStarted: false,
    postClick: false,
    navigationStarted: false,
    mediaUploadStarted: false,
  };
  let closeHoldMs = 0;

  try {
    session = await openBrowserSession(accountId);
    const { page } = session;

    // Defense in depth (real incident, 2026-08-26): CONTENT-OS's preflight
    // already runs a fresh session check before requesting a publish, but a
    // real human Approval step can sit between preflight and this call -
    // the session can genuinely change state in that window. Media upload
    // must never begin against an unauthenticated session regardless of
    // what an earlier check reported; this reuses the SAME authoritative
    // verifier session-check.js uses, never a second/looser check.
    const account = await getAccountById(accountId).catch(() => null);
    const verification = await verifyInstagramSession(page, account ? account.name : null);
    if (!verification.active) {
      throw new Error(`Instagram session requires login: ${verification.reason}`);
    }

    telemetry.phase = "NAVIGATION";
    telemetry.navigationStarted = true;
    await gotoUploadPage(page);
    telemetry.phase = "MEDIA_UPLOAD";
    telemetry.mediaUploadStarted = true;
    await setMediaFiles(page, absoluteMediaPaths);
    await page.waitForTimeout(Math.max(config.postDelayMs, 5000));
    await clickNextButtons(page);
    telemetry.phase = "CAPTION_ENTRY";
    await setCaption(page, caption || config.defaultCaption);

    const startedUrl = page.url();
    telemetry.phase = "PRE_PUBLISH";
    const shared = await clickShare(page);
    if (!shared) {
      throw new Error("Could not find/click Instagram Share button.");
    }
    // The click is the irreversible external-action boundary. Everything
    // before it (including selecting a local file in the browser) is safe to
    // retry and must remain explicitly false in telemetry.
    telemetry.phase = "POST_CLICK";
    telemetry.externalActionStarted = true;
    telemetry.postClick = true;

    telemetry.phase = "POST_CONFIRMATION";
    const confirmation = await waitForPostConfirmation(page, startedUrl);
    if (!confirmation.ok) {
      throw new Error(confirmation.reason);
    }

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-instagram-upload-success.png"
    );
    await page.screenshot({ path: successScreenshotPath, fullPage: true }).catch(() => { });

    // Hold the browser open so background processing finishes
    closeHoldMs = Math.max(config.postPublishHoldMs || 15000, 15000);
    return { ok: true, publicationType, ...telemetry };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-instagram-upload-error.png"
    );
    if (session?.page) await session.page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });

    closeHoldMs = Math.max(config.failureHoldMs, 0);
    return {
      ok: false,
      error: error.message,
      screenshotPath,
      ...telemetry,
    };
  } finally {
    if (closeHoldMs > 0) {
      console.log(`Holding browser for ${closeHoldMs / 1000}s before closing...`);
      await session?.page?.waitForTimeout(closeHoldMs).catch(() => { });
    }
    if (session) await session.disconnect();
  }
}

async function uploadVideo(input) {
  return uploadMedia({ ...input, mediaPaths: input.videoPath, publicationType: "video" });
}

module.exports = {
  uploadVideo,
  uploadMedia,
  startLoginSession,
  getLoginSessionStatus,
  closeLoginSession,
};
