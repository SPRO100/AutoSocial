const path = require("path");
const { config } = require("./config");
const { acquireBrowserSession } = require("./browser-session");

// Shared, deliberately conservative primitives for browser-managed platforms.
// Platform adapters supply only their DOM semantics; this module owns
// bounded waits, safe locator selection, overlay fail-closed behavior and
// structured result classification.
async function visibleEnabled(locator) {
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (await candidate.isDisabled().catch(() => false)) continue;
    return candidate;
  }
  return null;
}

async function dismissKnownOverlays(page) {
  const dialogs = page.getByRole("dialog");
  const count = await dialogs.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const dialog = dialogs.nth(i);
    if (!(await dialog.isVisible().catch(() => false))) continue;
    const text = (await dialog.innerText().catch(() => "")).trim();
    const safeAction = visibleEnabled(dialog.getByRole("button", { name: /^(close|dismiss|not now|got it|cancel)$/i }));
    if (!safeAction) {
      return { ok: false, code: "UNKNOWN_BLOCKING_MODAL", message: `Unrecognized blocking dialog: ${text.slice(0, 160)}` };
    }
    await safeAction.click({ timeout: 5000 });
    await page.waitForTimeout(250);
    if (await dialog.isVisible().catch(() => false)) return { ok: false, code: "BLOCKING_MODAL_UNRESOLVED", message: "Known dialog remained visible after safe dismissal." };
  }
  return { ok: true };
}

async function setOptionalMedia(page, mediaPaths) {
  const paths = (mediaPaths || []).map((value) => path.resolve(value));
  if (!paths.length) return true;
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) === 0) return false;
  await input.setInputFiles(paths);
  return true;
}

async function publishBrowserPost({ platform, accountId, text, mediaPaths = [], publicationType = "TEXT", selectors }) {
  const session = await acquireBrowserSession(platform, { accountId });
  const { page } = session;
  let actionStarted = false;
  try {
    await page.goto(selectors.composeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    const overlay = await dismissKnownOverlays(page);
    if (!overlay.ok) return { ok: false, finalStatus: "failed", code: overlay.code, phase: "composer_overlays", error: overlay.message, externalActionStarted: false, postClick: false, safeToRetry: true };
    const editor = await visibleEnabled(page.getByRole("textbox", { name: selectors.editorName }));
    if (!editor) return { ok: false, finalStatus: "failed", code: "COMPOSER_NOT_FOUND", phase: "composer", externalActionStarted: false, postClick: false, safeToRetry: true };
    if (text) await editor.fill(text);
    if (!(await setOptionalMedia(page, mediaPaths))) return { ok: false, finalStatus: "failed", code: "MEDIA_INPUT_NOT_FOUND", phase: "media", externalActionStarted: false, postClick: false, safeToRetry: true };
    await page.waitForTimeout(500);
    const finalOverlay = await dismissKnownOverlays(page);
    if (!finalOverlay.ok) return { ok: false, finalStatus: "failed", code: finalOverlay.code, phase: "pre_publish_overlays", error: finalOverlay.message, externalActionStarted: false, postClick: false, safeToRetry: true };
    const publish = await visibleEnabled(page.getByRole("button", { name: selectors.publishName }));
    if (!publish) return { ok: false, finalStatus: "failed", code: "PUBLISH_CONTROL_NOT_FOUND", phase: "pre_publish", externalActionStarted: false, postClick: false, safeToRetry: true };
    actionStarted = true;
    await publish.click({ timeout: 5000 });
    for (let i = 0; i < 20; i += 1) {
      const body = await page.locator("body").innerText().catch(() => "");
      if (selectors.confirmation.test(body) || page.url() !== selectors.composeUrl) {
        return { ok: true, finalStatus: "published", platform, publicationType, externalActionStarted: true, postClick: true, safeToRetry: false, remotePostId: null, remotePostUrl: null };
      }
      await page.waitForTimeout(1000);
    }
    return { ok: false, finalStatus: "unconfirmed", code: "PUBLISH_CONFIRMATION_TIMEOUT", phase: "confirmation", externalActionStarted: true, postClick: true, safeToRetry: false };
  } catch (error) {
    return { ok: false, finalStatus: actionStarted ? "unconfirmed" : "failed", code: actionStarted ? "PUBLISH_UNCONFIRMED" : "BROWSER_PUBLISH_FAILED", phase: "browser", error: error.message, externalActionStarted: actionStarted, postClick: actionStarted, safeToRetry: !actionStarted };
  } finally {
    await session.disconnect().catch(() => {});
  }
}

const adapters = {
  threads: {
    types: ["TEXT", "IMAGE", "VIDEO"],
    publish: (input) => publishBrowserPost({ ...input, platform: "threads", selectors: { composeUrl: "https://www.threads.com/", editorName: /what's new|start a thread|text/i, publishName: /post|share/i, confirmation: /posted|your thread/i } }),
  },
  x: {
    types: ["TEXT", "IMAGE", "VIDEO", "MULTI_MEDIA"],
    publish: (input) => publishBrowserPost({ ...input, platform: "x", selectors: { composeUrl: "https://x.com/compose/post", editorName: /post text|what is happening/i, publishName: /^post$/i, confirmation: /posted|view post/i } }),
  },
};

function getBrowserAdapter(platform) { return adapters[String(platform || "").toLowerCase()] || null; }

module.exports = { getBrowserAdapter, dismissKnownOverlays, publishBrowserPost };
