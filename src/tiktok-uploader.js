const path = require("path");
const { config } = require("./config");
const uiLabels = require("./platform-ui-labels");
const {
  getActiveAccount,
  hasSavedPlatformSession,
} = require("./account-manager");
const { acquireBrowserSession } = require("./browser-session");

let loginSession = null;
let loginSessionAccountId = null;

async function openBrowserSession(accountId) {
  return acquireBrowserSession("tiktok", { accountId });
}

async function gotoUploadPage(page) {
  await page.goto(config.uploadPageUrl, { waitUntil: "domcontentloaded" });
}

async function setVideoFile(page, videoPath) {
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 120000 });
  await fileInput.setInputFiles(videoPath);
}

async function setCaption(page, caption) {
  if (!caption) {
    return;
  }

  const selectors = [
    '.caption-editor [role="combobox"][contenteditable="true"]',
    '.caption-markup [contenteditable="true"]',
    '.public-DraftEditor-content[contenteditable="true"]',
    '[role="textbox"][contenteditable="true"][aria-label*="caption" i]',
    '[role="textbox"][contenteditable="true"][aria-label*="description" i]',
    '[role="combobox"][contenteditable="true"][aria-label*="caption" i]',
    '[role="combobox"][contenteditable="true"][aria-label*="description" i]',
    'textarea[aria-label*="caption" i], textarea[placeholder*="caption" i], textarea[placeholder*="description" i]',
  ];
  let editorObserved = false;

  for (let pass = 0; pass < 3; pass += 1) {
    await resolveBlockingOverlays(page);

    for (const selector of selectors) {
      // Fresh locator after every overlay transition; never retain an
      // ElementHandle across TikTok's React/DraftJS rerenders.
      const matches = page.locator(selector);
      const count = Math.min(await matches.count(), 5);
      for (let index = 0; index < count; index += 1) {
        const target = matches.nth(index);
        if (!(await target.isVisible().catch(() => false))) continue;
        if (!(await target.isEditable().catch(() => false))) continue;
        editorObserved = true;

        try {
          // fill() supports both textarea and contenteditable and emits the
          // input events DraftJS consumes. Keyboard fallback covers current
          // Studio builds that wrap DraftJS with custom event handling.
          await target.fill(caption, { timeout: 4000 });
        } catch {
          try {
            await target.click({ timeout: 3000 });
            await page.keyboard.press("Control+A");
            await page.keyboard.press("Delete");
            await page.keyboard.type(caption, { delay: 10 });
          } catch {
            continue;
          }
        }

        const actual = await target.evaluate((el) => {
          if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
          return el.innerText || el.textContent || "";
        }).catch(() => "");
        if (actual.trim() === caption.trim()) {
          console.log(`Caption editor filled and verified (${caption.length} characters).`);
          return;
        }
      }
    }
    await page.waitForTimeout(500);
  }

  if (editorObserved) throw workflowError("CAPTION_VERIFICATION_FAILED", "Caption editor was found but its value could not be set and verified.");
  throw workflowError("CAPTION_INPUT_FAILED", "Could not find a supported TikTok caption editor.");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickFirstVisibleEnabledLocator(page, locator) {
  const total = await locator.count();
  if (total === 0) {
    return false;
  }

  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) {
      continue;
    }

    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
      await page.waitForTimeout(250);
      await candidate.click({ timeout: 5000 });
      return true;
    } catch {
      try {
        await candidate.click({ timeout: 5000, force: true });
        return true;
      } catch {
        // Continue to next candidate.
      }
    }
  }

  return false;
}

function normalizeUiText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function workflowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeDialogSummary(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "unidentified dialog";
}

function selectKnownDialogAction(dialogText, buttonTexts) {
  const text = normalizeUiText(dialogText);
  const buttons = buttonTexts.map((value) => ({ raw: value, normalized: normalizeUiText(value) }));
  const find = (...labels) => buttons.find(({ normalized }) => labels.includes(normalized));

  // Incident fixture: enabling content checks is optional. Prefer the
  // non-mutating Cancel choice and never opt into a setting on the account.
  if (/automatic content checks|music copyright check|content check lite/.test(text)) {
    return find("cancel", "not now", "skip", "decline");
  }

  // Known informational TikTok Studio hints may be acknowledged. Keep this
  // deliberately narrow: unknown dialogs fail closed below.
  if (/new editing features|what(?:'|\u2019)s new|welcome to tiktok studio/.test(text)) {
    return find("got it", "close", "not now", "skip");
  }

  return null;
}

function selectSafeCookieAction(buttons) {
  const safe = new Set([
    "decline optional cookies", "reject optional cookies", "reject all",
    "only necessary", "necessary only", "close", "dismiss",
  ]);
  return buttons
    .map((raw) => ({ raw, normalized: normalizeUiText(raw) }))
    .find(({ normalized }) => safe.has(normalized));
}

async function findCookieBanner(page) {
  const candidates = page.locator(
    "[role='dialog'], [class*='cookie' i], [id*='cookie' i], [data-testid*='cookie' i], [aria-label*='cookie' i]"
  );
  let best = null;
  let bestTextLength = Number.POSITIVE_INFINITY;
  const inspect = async (candidateLocator) => {
    const count = await candidateLocator.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = candidateLocator.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const text = await candidate.innerText().catch(() => "");
      if (!/allow cookies from tiktok|optional cookies|cookies policy/i.test(text)) continue;
      if (await candidate.locator("button, [role='button']").count() === 0) continue;
      if (text.length < bestTextLength) {
        best = candidate;
        bestTextLength = text.length;
      }
    }
  };
  await inspect(candidates);
  // Some consent UIs intentionally use generated class names and no dialog
  // role.  A text-scoped fallback remains bounded and still requires a
  // semantic cookie phrase plus an explicit button before any action.
  if (!best) {
    await inspect(page.locator("body div").filter({ hasText: /allow cookies from tiktok|optional cookies|cookies policy/i }));
  }
  return best;
}

// TikTok can leave an informational dialog mounted behind a newer blocking
// modal. DOM order/"first visible" is therefore not a safe stacking signal:
// Playwright will find the button but the click is covered and times out.
// Select the live topmost dialog using rendered z-index and geometry, then
// re-query it again immediately before every action.
async function findTopmostVisibleDialog(page, selector = "[role='dialog'], [aria-modal='true'], [class*='modal' i], [class*='dialog' i]") {
  const dialogs = page.locator(selector);
  const count = await dialogs.count();
  let best = null;
  let bestScore = null;
  for (let i = 0; i < count; i += 1) {
    const candidate = dialogs.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const info = await candidate.evaluate((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const z = Number.parseInt(style.zIndex, 10);
      return { z: Number.isFinite(z) ? z : 0, area: rect.width * rect.height, top: rect.top, left: rect.left };
    }).catch(() => null);
    if (!info) continue;
    const score = [info.z, info.area, -info.top, -info.left];
    if (!bestScore || score.some((value, index) => value > bestScore[index] && score.slice(0, index).every((v, j) => v === bestScore[j]))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

async function resolveCookieBanner(page, { disappearTimeoutMs = 3000 } = {}) {
  const banner = await findCookieBanner(page);
  if (!banner) return false;
  const bannerText = await banner.innerText().catch(() => "");
  const actions = banner.locator("button, [role='button']");
  const actionTexts = [];
  const actionCount = await actions.count();
  for (let i = 0; i < actionCount; i += 1) {
    const action = actions.nth(i);
    if (await action.isVisible().catch(() => false)) actionTexts.push(await action.innerText().catch(() => ""));
  }
  const selected = selectSafeCookieAction(actionTexts);
  if (!selected) {
    throw workflowError("COOKIE_BANNER_FAILED", `TikTok cookie banner has no safe dismiss action: ${safeDialogSummary(bannerText)}`);
  }

  // Re-find the banner and its action after every DOM transition. Never keep
  // an ElementHandle across the consent UI's React update.
  const liveBanner = await findCookieBanner(page);
  if (!liveBanner) return true;
  const liveActions = liveBanner.locator("button, [role='button']");
  let clicked = false;
  for (let i = 0; i < await liveActions.count(); i += 1) {
    const action = liveActions.nth(i);
    if (normalizeUiText(await action.innerText().catch(() => "")) !== normalizeUiText(selected.raw)) continue;
    if (!(await action.isVisible().catch(() => false)) || await action.isDisabled().catch(() => false)) continue;
    await action.click({ timeout: 3000 });
    clicked = true;
    break;
  }
  if (!clicked) throw workflowError("COOKIE_BANNER_FAILED", `TikTok cookie banner action "${normalizeUiText(selected.raw)}" was unavailable.`);

  const deadline = Date.now() + disappearTimeoutMs;
  while (Date.now() <= deadline) {
    if (!await findCookieBanner(page)) return true;
    await page.waitForTimeout(100);
  }
  throw workflowError("COOKIE_BANNER_FAILED", "TikTok cookie banner remained after safe dismiss action.");
}

async function resolveBlockingOverlays(page, { maxPasses = 3, disappearTimeoutMs = 3000 } = {}) {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    // Cookie consent is often not marked role=dialog and can sit above the
    // editor modal. Resolve it first, then re-evaluate the live DOM.
    await resolveCookieBanner(page, { disappearTimeoutMs });
    // Locators, not ElementHandles: every pass re-evaluates the live DOM.
    const visibleDialog = await findTopmostVisibleDialog(page);

    if (!visibleDialog) return { resolved: true, passes: pass };

    const dialogText = await visibleDialog.innerText().catch(() => "");
    const actions = visibleDialog.locator("button, [role='button']");
    const actionCount = await actions.count();
    const buttonTexts = [];
    for (let i = 0; i < actionCount; i += 1) {
      const action = actions.nth(i);
      if (await action.isVisible().catch(() => false)) {
        buttonTexts.push(await action.innerText().catch(() => ""));
      }
    }

    const selected = selectKnownDialogAction(dialogText, buttonTexts);
    if (!selected) {
      throw workflowError(
        "BLOCKING_MODAL_UNRESOLVED",
        `Unknown blocking TikTok dialog: ${safeDialogSummary(dialogText)}`
      );
    }

    const selectedText = normalizeUiText(selected.raw);
    let clicked = false;
    // Re-query the dialog and its actions immediately before clicking. Scope
    // to the same dialog summary so a second modal's identically named
    // Cancel button can never be selected accidentally.
    const liveDialogs = page.locator(
      "[role='dialog'], [aria-modal='true'], [class*='modal' i], [class*='dialog' i]"
    );
    let liveDialog = null;
    const liveDialogCount = await liveDialogs.count();
    const expectedSummary = safeDialogSummary(dialogText);
    for (let i = 0; i < liveDialogCount; i += 1) {
      const candidate = liveDialogs.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const summary = safeDialogSummary(await candidate.innerText().catch(() => ""));
      if (summary === expectedSummary) {
        liveDialog = candidate;
        break;
      }
    }
    if (!liveDialog) {
      // The original dialog disappeared on its own; restart from the live DOM.
      continue;
    }
    const liveActions = liveDialog.locator("button, [role='button']");
    const liveCount = await liveActions.count();
    for (let i = 0; i < liveCount; i += 1) {
      const action = liveActions.nth(i);
      const actionText = normalizeUiText(await action.innerText().catch(() => ""));
      if (actionText !== selectedText || !(await action.isVisible().catch(() => false))) continue;
      if (await action.isDisabled().catch(() => false)) continue;
      try {
        await action.click({ timeout: 3000 });
        clicked = true;
        break;
      } catch (error) {
        // A React transition may have replaced/covered the action. Re-read
        // the dialog before deciding whether it disappeared or must fail
        // closed; never force-click through a possible blocking layer.
        const liveAfterFailure = await findTopmostVisibleDialog(page);
        if (!liveAfterFailure) continue;
        throw workflowError("BLOCKING_MODAL_UNRESOLVED", `TikTok dialog action "${selectedText}" was not safely clickable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!clicked) {
      throw workflowError(
        "BLOCKING_MODAL_UNRESOLVED",
        `Known TikTok dialog action "${selectedText}" was unavailable.`
      );
    }

    const deadline = Date.now() + disappearTimeoutMs;
    let disappeared = false;
    while (Date.now() <= deadline) {
      const currentDialogs = page.locator(
        "[role='dialog'], [aria-modal='true'], [class*='modal' i], [class*='dialog' i]"
      );
      const currentCount = await currentDialogs.count();
      let originalStillVisible = false;
      for (let i = 0; i < currentCount; i += 1) {
        const candidate = currentDialogs.nth(i);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const summary = safeDialogSummary(await candidate.innerText().catch(() => ""));
        if (summary === expectedSummary) {
          originalStillVisible = true;
          break;
        }
      }
      if (!originalStillVisible) {
        disappeared = true;
        break;
      }
      await page.waitForTimeout(100);
    }
    if (!disappeared) {
      throw workflowError(
        "BLOCKING_MODAL_UNRESOLVED",
        `TikTok blocking dialog remained after safe action "${selectedText}".`
      );
    }
  }

  throw workflowError("BLOCKING_MODAL_UNRESOLVED", `TikTok blocking dialogs exceeded ${maxPasses} resolution passes.`);
}

function getPublishCandidateScore(info, publishTerms = uiLabels.terms("tiktokPublish")) {
  const text = normalizeUiText(info?.text || info?.ariaLabel);
  if (!text || info?.disabled || info?.inNavigation) {
    return -1;
  }

  const tagName = normalizeUiText(info?.tagName);
  const role = normalizeUiText(info?.role);
  if (!["button", "a"].includes(tagName) && role !== "button") {
    return -1;
  }

  const href = normalizeUiText(info?.href);
  if (href && /\/(post|posts|analytics|comment|home|inspiration|monetization|academy|sound|feedback)(\/|$|\?)/i.test(href)) {
    return -1;
  }

  if (text === "posts") {
    return -1;
  }

  const labels = publishTerms.map(normalizeUiText).filter(Boolean);
  const exactMatch = labels.includes(text);
  const nonAmbiguousMatch = labels
    .filter((label) => label !== "post")
    .some((label) => text.includes(label));
  if (!exactMatch && !nonAmbiguousMatch) {
    return -1;
  }

  const rect = info?.rect || {};
  const viewportWidth = Number(info?.viewportWidth) || 0;
  const viewportHeight = Number(info?.viewportHeight) || 0;
  const left = Number(rect.left) || 0;
  const top = Number(rect.top) || 0;
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  const right = Number(rect.right) || left + width;
  const mainContentBoundary = viewportWidth >= 900 ? Math.min(300, viewportWidth * 0.25) : 0;

  if (viewportWidth >= 900 && right <= mainContentBoundary) {
    return -1;
  }

  const isBottomAction = viewportHeight > 0 && top >= viewportHeight * 0.5;
  const isCtaSized = width >= 80 && height >= 28;
  const className = normalizeUiText(info?.className);
  const hasPublishCue = /\b(post|publish|submit)\b/.test(className);

  if (text === "post" && viewportHeight >= 600 && !isBottomAction && !hasPublishCue) {
    return -1;
  }

  let score = 0;
  if (exactMatch) score += 30;
  if (nonAmbiguousMatch) score += 20;
  if (tagName === "button") score += 20;
  if (normalizeUiText(info?.type) === "submit") score += 20;
  if (hasPublishCue) score += 20;
  if (isCtaSized) score += 15;
  if (isBottomAction) score += 60;
  if (viewportWidth >= 900 && left >= mainContentBoundary) score += 20;
  score += Math.min(20, Math.max(0, top / 40));

  return score;
}

function isLikelyPublishCandidateInfo(info, publishTerms = uiLabels.terms("tiktokPublish")) {
  return getPublishCandidateScore(info, publishTerms) >= 0;
}

async function getPublishCandidateInfo(candidate) {
  return candidate.evaluate((el) => {
    const clickable = el.closest("button, [role='button'], a") || el;
    const rect = clickable.getBoundingClientRect();
    const className = (clickable.className || "").toString();
    const dataAttributes = Array.from(clickable.attributes || [])
      .filter((attr) => attr.name.startsWith("data-"))
      .map((attr) => `${attr.name}=${attr.value}`)
      .join(" ");
    const inNavigation = Boolean(
      clickable.closest(
        [
          "nav",
          "aside",
          "[role='navigation']",
          "[role='menu']",
          "[role='menubar']",
          "[class*='sidebar' i]",
          "[class*='side-bar' i]",
          "[class*='sidenav' i]",
          "[class*='side-nav' i]",
          "[class*='side_nav' i]",
          "[class*='menu' i]",
          "[class*='navigation' i]",
          "[class*='nav-item' i]",
          "[class*='nav_item' i]",
          "[data-e2e*='nav' i]",
          "[data-e2e*='side' i]",
          "[data-testid*='nav' i]",
          "[data-testid*='side' i]",
        ].join(", ")
      )
    );
    const anchor = clickable.closest("a");
    return {
      ariaLabel: clickable.getAttribute("aria-label") || "",
      className,
      dataAttributes,
      disabled: Boolean(clickable.disabled) || clickable.getAttribute("aria-disabled") === "true",
      href: anchor ? anchor.getAttribute("href") || "" : "",
      inNavigation,
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      role: clickable.getAttribute("role") || "",
      tagName: clickable.tagName,
      type: clickable.getAttribute("type") || "",
      text: clickable.textContent || "",
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
}

async function clickFirstLikelyPublishLocator(page, locator, publishTerms = uiLabels.terms("tiktokPublish"), onExternalActionBoundary) {
  const total = await locator.count();
  if (total === 0) {
    return false;
  }

  const candidates = [];
  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const info = await getPublishCandidateInfo(candidate).catch(() => null);
    const score = getPublishCandidateScore(info, publishTerms);
    if (score < 0) {
      continue;
    }

    candidates.push({ candidate, info, score });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (Number(b.info?.rect?.top) || 0) - (Number(a.info?.rect?.top) || 0);
  });

  for (const entry of candidates) {
    const { candidate, info, score } = entry;

    await candidate.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(250);
    onExternalActionBoundary?.();
    try {
      await candidate.click({ timeout: 5000 });
      const rect = info?.rect || {};
      console.log(
        `Publish candidate clicked: "${normalizeUiText(info?.text || info?.ariaLabel)}" score=${score.toFixed(1)} ` +
          `rect=${Math.round(Number(rect.left) || 0)},${Math.round(Number(rect.top) || 0)},` +
          `${Math.round(Number(rect.width) || 0)}x${Math.round(Number(rect.height) || 0)}`
      );
      return true;
    } catch (error) {
      // Never force-click or try another candidate after a validated Post
      // click was attempted: Playwright may throw after dispatching it.
      throw workflowError("POST_CLICK_UNCONFIRMED", `Post click outcome could not be observed: ${error.message}`);
    }
  }

  return false;
}

async function addDefaultSound(page, source) {
  if (source === "instant-post") {
    console.log("Skipping auto-add sound: Post triggered via Instant Post (video already has sound).");
    return;
  }

  if (!config.autoAddSound) {
    console.log("Auto-add sound disabled by config.");
    return;
  }

  const query = (config.defaultSoundQuery || "").trim();
  if (!query) {
    console.log("Auto-add sound enabled, but DEFAULT_SOUND_QUERY is empty; skipping sound change.");
    return;
  }

  console.log(`Adding sound flow started${query ? `: ${query}` : ""}`);

  async function clickUploadEditorSoundsButton() {
    // Strict targeting for the editor action row under the preview.
    const rowPattern = uiLabels.pattern("tiktokEdit");
    const soundsPattern = uiLabels.pattern("tiktokSounds");
    const textPattern = uiLabels.pattern("tiktokText");

    const rowCandidates = page
      .locator("div, section")
      .filter({ hasText: rowPattern })
      .filter({ hasText: soundsPattern })
      .filter({ hasText: textPattern });

    const rowCount = await rowCandidates.count();
    for (let i = 0; i < rowCount; i += 1) {
      const row = rowCandidates.nth(i);
      const rowVisible = await row.isVisible().catch(() => false);
      if (!rowVisible) {
        continue;
      }

      const box = await row.boundingBox().catch(() => null);
      if (!box) {
        continue;
      }

      // Keep only right-side rows near the phone preview area.
      if (box.x < 520) {
        continue;
      }

      const exactSounds = row.locator(
        uiLabels.textSelector("button", "tiktokSounds") +
          ", " +
          uiLabels.textSelector('[role="button"]', "tiktokSounds")
      );
      const clickedExact = await clickFirstVisibleEnabledLocator(page, exactSounds);
      if (clickedExact) {
        console.log("Sound panel open strategy: strict editor row");
        return true;
      }

      const looseSounds = row.locator("button, [role='button'], div").filter({
        hasText: soundsPattern,
      });
      const clickedLoose = await clickFirstVisibleEnabledLocator(page, looseSounds);
      if (clickedLoose) {
        console.log("Sound panel open strategy: editor row fallback");
        return true;
      }
    }

    // Last resort: right-side clickable element named Sounds/Audio, never nav/aside.
    const soundLabels = uiLabels.terms("tiktokSounds").map((term) => term.toLowerCase());
    const clicked = await page.evaluate((labels) => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const nodes = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const el of nodes) {
        const text = (el.textContent || "").trim().toLowerCase();
        if (!labels.includes(text)) {
          continue;
        }
        if (el.closest("nav, aside, [role='navigation']")) {
          continue;
        }
        if (!isVisible(el)) {
          continue;
        }

        const rect = el.getBoundingClientRect();
        // Stronger right-side lock so it cannot hit left menu.
        if (rect.left < window.innerWidth * 0.65) {
          continue;
        }

        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return true;
      }

      return false;
    }, soundLabels);

    if (clicked) {
      console.log("Sound panel open strategy: right-side hard fallback");
      return true;
    }

    return false;
  }

  const previousUrl = page.url();
  const opened = await clickUploadEditorSoundsButton();

  if (!opened) {
    console.log("Could not open sound panel; continuing without sound change.");
    return;
  }

  await page.waitForTimeout(700);
  // Guard: if wrong control caused navigation, jump back to upload page and skip sound.
  if (!page.url().includes("/upload")) {
    console.log(`Sounds click navigated away (${page.url()}); returning to upload page.`);
    await gotoUploadPage(page);
    await page.waitForTimeout(1000);
    return;
  }

  if (page.url() !== previousUrl) {
    console.log(`Upload page URL changed after sounds click: ${page.url()}`);
  }

  await page.waitForTimeout(1000);

  let added = false;

  // The "Use this sound" button in the sound panel is the ArrowLeftRight icon button.
  // The PlusBold icon button is typically disabled. We target both but prefer ArrowLeftRight.
  const useButtonSelector = [
    'button:has([data-testid="ArrowLeftRight"])',
    'button:has([data-icon="ArrowLeftRight"])',
  ].join(", ");

  // Step 1: try direct row match first (avoids flaky input focus/autocomplete issues).
  const queryPattern = new RegExp(escapeRegExp(query), "i");
  const directRow = page
    .locator('[role="listitem"], .MusicPanelMusicItem__wrap')
    .filter({ hasText: queryPattern });
  const directUse = directRow.locator(useButtonSelector);
  added = await clickFirstVisibleEnabledLocator(page, directUse);
  if (added) {
    console.log(`Sound used directly from visible "${query}" row (ArrowLeftRight).`);
    await page.waitForTimeout(1500);
  }

  // Step 2: fallback to search when direct row is unavailable.
  if (!added) {
    const soundSearchInput = page.getByPlaceholder(uiLabels.pattern("tiktokSearchSounds")).first();
    const inputVisible = await soundSearchInput.isVisible().catch(() => false);

    if (!inputVisible) {
      console.log("Sound search input not visible; skipping search.");
    } else {
      const queryPrefix = query.split(/\s+/).slice(0, 2).join(" ");
      const searchQueries = Array.from(new Set([query, queryPrefix].filter(Boolean)));

      for (const currentQuery of searchQueries) {
        await soundSearchInput.click({ timeout: 3000 });
        await page.waitForTimeout(300);

        await soundSearchInput.evaluate((el) => {
          el.focus();
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForTimeout(200);

        await page.keyboard.type(currentQuery, { delay: 30 });
        await page.waitForTimeout(300);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2000);

        const typedValue = await soundSearchInput.inputValue().catch(() => "");
        console.log(`Sound search typed: "${typedValue}" (wanted: "${currentQuery}")`);

        const rows = page
          .locator('[role="listitem"], .MusicPanelMusicItem__wrap')
          .filter({ hasText: new RegExp(escapeRegExp(currentQuery), "i") });
        const rowCount = await rows.count();
        if (rowCount === 0) {
          console.log(`No rows found for "${currentQuery}".`);
          continue;
        }

        const maxRowsToTry = Math.min(rowCount, 5);
        for (let i = 0; i < maxRowsToTry; i += 1) {
          const row = rows.nth(i);
          const rowVisible = await row.isVisible().catch(() => false);
          if (!rowVisible) continue;

          const addStrategies = [
            row.locator(useButtonSelector),
            row.locator(".MusicPanelMusicItem__operation button").first(),
          ];

          for (const locator of addStrategies) {
            added = await clickFirstVisibleEnabledLocator(page, locator);
            if (added) {
              console.log(`Sound "${currentQuery}" applied via use-button.`);
              await page.waitForTimeout(1500);
              break;
            }
          }
          if (added) break;
        }
        if (added) break;
      }
    }
  }

  // Step 3: hard fallback - click first enabled use-button in the panel.
  if (!added) {
    const firstUse = page.locator(
      `.MusicPanelMusicItem__operation ${useButtonSelector}`
    );
    added = await clickFirstVisibleEnabledLocator(page, firstUse);
    if (added) {
      console.log("Sound applied via first visible ArrowLeftRight fallback.");
      await page.waitForTimeout(1500);
    }
  }

  if (!added) {
    throw new Error(`Could not click use-button for sound "${query}".`);
  }

  // Step 4: Click "Save" to confirm the sound selection.
  // The sound panel is an overlay; the Publish button may be visible behind it,
  // so we must NOT rely on publishVisible to decide if we are done.
  let saved = false;
  const saveLocator = page.locator("button.Button__root--type-primary, button").filter({
    hasText: uiLabels.pattern("tiktokSave"),
  });

  // Retry a few times with waits; the button may need a moment after the sound loads.
  for (let attempt = 0; attempt < 5; attempt++) {
    saved = await clickFirstVisibleEnabledLocator(page, saveLocator);
    if (saved) {
      console.log(`Sound saved via Save (attempt ${attempt + 1}).`);
      break;
    }
    console.log(`Save not ready yet, waiting... (attempt ${attempt + 1}/5)`);
    await page.waitForTimeout(1500);
  }

  if (!saved) {
    // Last resort: try clicking via page.evaluate to force-find and click the button.
    const saveTerms = uiLabels.terms("tiktokSave").map((term) => term.toLowerCase());
    saved = await page.evaluate((labels) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const saveBtn = buttons.find(
        (b) =>
          labels.includes((b.textContent || "").trim().toLowerCase())
      );
      if (saveBtn && !saveBtn.disabled) {
        saveBtn.scrollIntoView();
        saveBtn.click();
        return true;
      }
      return false;
    }, saveTerms);
    if (saved) {
      console.log("Sound saved via evaluate fallback.");
    }
  }

  if (!saved) {
    // Check if the panel actually closed on its own.
    const soundSearchStillVisible = await page
      .getByPlaceholder(uiLabels.pattern("tiktokSearchSounds"))
      .first()
      .isVisible()
      .catch(() => false);
    const cancelVisible = await page
      .locator("button")
      .filter({ hasText: uiLabels.pattern("tiktokCancel") })
      .first()
      .isVisible()
      .catch(() => false);

    if (!soundSearchStillVisible && !cancelVisible) {
      console.log("Sound panel closed on its own after applying sound.");
      await page.waitForTimeout(800);
      return;
    }

    console.log(
      "WARNING: Could not click Save. Trying Cancel to avoid stuck panel."
    );
    await clickFirstVisibleEnabledLocator(
      page,
      page.locator("button").filter({ hasText: uiLabels.pattern("tiktokCancel") })
    );
    throw new Error("Could not click Save in sound editor.");
  }

  await page.waitForTimeout(1500);
}

async function disableShortContentCheck(page) {
  const labelPattern =
    uiLabels.pattern("tiktokShortContentCheck");
  const section = page
    .locator("section, div, li, form")
    .filter({ hasText: labelPattern })
    .first();

  if ((await section.count()) === 0) {
    console.log("Short content check toggle not found; continuing.");
    return;
  }

  async function readSwitchState(candidate) {
    return candidate.evaluate((el) => {
      const ariaChecked = (el.getAttribute("aria-checked") || "").toLowerCase();
      if (ariaChecked === "true") {
        return true;
      }
      if (ariaChecked === "false") {
        return false;
      }

      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        return el.checked;
      }

      const className = (el.className || "").toString().toLowerCase();
      if (
        className.includes("checked") ||
        className.includes("active") ||
        className.includes("enabled") ||
        className.includes("on")
      ) {
        return true;
      }
      if (
        className.includes("disabled") ||
        className.includes("inactive") ||
        className.includes("off")
      ) {
        return false;
      }

      return null;
    });
  }

  const switchCandidates = [
    section.locator('[role="switch"]'),
    section.locator('button[aria-checked], button[class*="switch" i], button[class*="toggle" i]'),
    section.locator('input[type="checkbox"]'),
  ];

  for (const pool of switchCandidates) {
    const count = await pool.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = pool.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { });
      const before = await readSwitchState(candidate).catch(() => null);
      if (before === false) {
        console.log("Short content check already disabled.");
        return;
      }

      await candidate.click({ timeout: 3000, force: true }).catch(() => { });
      await page.waitForTimeout(800);
      const after = await readSwitchState(candidate).catch(() => null);

      if (after === false || (before === true && after !== true)) {
        console.log("Short content check disabled.");
        return;
      }
    }
  }

  console.log("Short content check toggle found but could not be switched off.");
}

async function dismissInterferingOverlays(page) {
  return resolveBlockingOverlays(page);
}

async function scrollToBottom(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
}

async function tryClickPublishButton(page, onExternalActionBoundary) {
  // Strategy 1: exact text buttons (most reliable on TikTok Studio)
  const exactSelectors = [
    uiLabels.textSelector("button", "tiktokPublish"),
    uiLabels.textSelector('[role="button"]', "tiktokPublish"),
  ];

  for (const selector of exactSelectors) {
    const locator = page.locator(selector);
    const clicked = await clickFirstLikelyPublishLocator(page, locator, uiLabels.terms("tiktokPublish"), onExternalActionBoundary);
    if (clicked) {
      console.log(`Publish click strategy: exact selector ${selector}`);
      return true;
    }
  }

  // Strategy 2: role-based labels.
  const roleTexts = [
    uiLabels.pattern("tiktokPublish"),
  ];

  for (const textPattern of roleTexts) {
    const button = page.getByRole("button", { name: textPattern });
    const clicked = await clickFirstLikelyPublishLocator(page, button, uiLabels.terms("tiktokPublish"), onExternalActionBoundary);
    if (clicked) {
      console.log(`Publish click strategy: role ${textPattern}`);
      return true;
    }
  }

  // Strategy 3: CSS selectors for the red publish button
  const cssSelectors = [
    'button[class*="publish" i]',
    'button[class*="post-btn" i]',
    'button[class*="submit" i]',
    'div[class*="publish" i] button',
    'div[class*="btn-post" i]',
  ];

  for (const selector of cssSelectors) {
    const el = page.locator(selector);
    const clicked = await clickFirstLikelyPublishLocator(page, el, uiLabels.terms("tiktokPublish"), onExternalActionBoundary);
    if (clicked) {
      console.log(`Publish click strategy: css ${selector}`);
      return true;
    }
  }

  // Strategy 4: find by visible text content (any clickable element)
  const textLabels = uiLabels.terms("tiktokPublish");

  for (const label of textLabels) {
    const el = page.locator(`text="${label}"`);
    const clicked = await clickFirstLikelyPublishLocator(page, el, uiLabels.terms("tiktokPublish"), onExternalActionBoundary);
    if (clicked) {
      console.log(`Publish click strategy: text ${label}`);
      return true;
    }
  }

  return false;
}

async function clickPublish(page, { onExternalActionBoundary } = {}) {
  await dismissInterferingOverlays(page);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await scrollToBottom(page);
    await page.waitForTimeout(500);
    // TikTok can mount a modal or cookie layer during scrolling. Resolve it
    // immediately before discovery so the Post locator is always derived
    // from the current, unobstructed DOM.
    await dismissInterferingOverlays(page);

    const clicked = await tryClickPublishButton(page, onExternalActionBoundary);
    if (clicked) {
      console.log(`Publish button clicked on attempt ${attempt + 1}.`);
      return;
    }

    await dismissInterferingOverlays(page);
    await page.waitForTimeout(2000);
  }

  throw workflowError("POST_BUTTON_UNAVAILABLE", "Could not find an enabled Publish/Post button after 6 attempts.");
}

function hasSuccessCueText(text) {
  const successPatterns = [
    uiLabels.pattern("tiktokPublished"),
  ];

  return successPatterns.some((pattern) => pattern.test(text));
}

function hasFailureCueText(text) {
  const failurePatterns = [
    uiLabels.pattern("tiktokFailed"),
  ];

  return failurePatterns.some((pattern) => pattern.test(text));
}

function isLikelyPublishApiResponse(response) {
  const url = response.url().toLowerCase();
  const method = response.request().method().toUpperCase();

  if (!["POST", "PUT", "PATCH"].includes(method)) {
    return false;
  }

  const urlPatterns = [
    "/publish",
    "/post",
    "/aweme",
    "/upload",
    "/creator",
    "/studio",
    "/web/project",
    "/web/post",
  ];

  return urlPatterns.some((pattern) => url.includes(pattern));
}

function createPublishResponseTracker(page) {
  let publishApiSuccess = false;
  let publishApiFailure = null;

  const responseHandler = (response) => {
    if (!isLikelyPublishApiResponse(response)) {
      return;
    }

    const status = response.status();
    const url = response.url();

    if (status >= 200 && status < 300) {
      publishApiSuccess = true;
      console.log(`Publish API success: ${status} ${url}`);
      return;
    }

    if (status >= 400) {
      publishApiFailure = `Publish API returned ${status}: ${url}`;
      console.log(publishApiFailure);
    }
  };

  page.on("response", responseHandler);

  return {
    dispose() {
      page.off("response", responseHandler);
    },
    failure() {
      return publishApiFailure;
    },
    success() {
      return publishApiSuccess;
    },
  };
}

async function trySecondaryPublishConfirm(page) {
  const confirmTerms = uiLabels
    .terms("tiktokConfirm")
    .filter((term) => normalizeUiText(term) !== "post");
  const confirmPattern = new RegExp(confirmTerms.map(escapeRegExp).join("|"), "i");
  const scopedConfirmLocator = page
    .locator(
      [
        "[role='dialog']",
        "[aria-modal='true']",
        "[class*='modal' i]",
        "[class*='dialog' i]",
        "[class*='popover' i]",
        "[class*='drawer' i]",
      ].join(", ")
    )
    .locator("button, [role='button']")
    .filter({ hasText: confirmPattern });
  const scopedClicked = await clickFirstLikelyPublishLocator(
    page,
    scopedConfirmLocator,
    confirmTerms
  );
  if (scopedClicked) {
    await page.waitForTimeout(500);
    return true;
  }

  const confirmLocator = page.getByRole("button", {
    name: confirmPattern,
  });
  const clicked = await clickFirstLikelyPublishLocator(
    page,
    confirmLocator,
    confirmTerms
  );
  if (clicked) {
    await page.waitForTimeout(500);
    return true;
  }

  return false;
}

async function waitForPublishConfirmation(page, responseTracker) {
  const startedUrl = page.url();
  const tracker = responseTracker || createPublishResponseTracker(page);
  const ownsTracker = !responseTracker;
  let secondaryConfirmAttempted = false;

  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const bodyText = await page
        .locator("body")
        .innerText()
        .then((value) => value || "")
        .catch(() => "");
      if (hasFailureCueText(bodyText)) {
        return {
          ok: false,
          reason: "TikTok displayed an error after publish click.",
        };
      }

      const publishApiFailure = tracker.failure();
      if (publishApiFailure) {
        return {
          ok: false,
          reason: publishApiFailure,
        };
      }

      if (tracker.success()) {
        return {
          ok: true,
          reason: "Publish API call succeeded.",
        };
      }

      if (hasSuccessCueText(bodyText)) {
        return {
          ok: true,
          reason: "Success confirmation text found.",
        };
      }

      if (!secondaryConfirmAttempted) {
        secondaryConfirmAttempted = await trySecondaryPublishConfirm(page);
      }

      const urlChanged = page.url() !== startedUrl;
      if (urlChanged && !page.url().includes("/upload")) {
        return {
          ok: true,
          reason: `Navigation changed to ${page.url()}.`,
        };
      }

      await page.waitForTimeout(2000);
    }

    return {
      ok: false,
      reason: "No reliable publish confirmation observed within timeout.",
    };
  } finally {
    if (ownsTracker) {
      tracker.dispose();
    }
  }
}

async function waitForUploadReady(page) {
  await page.waitForTimeout(Math.max(config.postDelayMs, 5000));
}

async function holdBrowserBeforeClose(page, holdMs, reason) {
  if (!Number.isFinite(holdMs) || holdMs <= 0) {
    return;
  }

  console.log(`Holding browser for ${holdMs}ms (${reason}).`);
  await page.waitForTimeout(holdMs).catch(() => { });
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
  // Persona-backed sessions have no Context "close" to rely on (Persona
  // keeps the context open even after we disconnect) - listen on whichever
  // real event this backend actually fires when the session goes away.
  if (session.browser) {
    session.browser.on("disconnected", clearIfCurrent);
  } else {
    session.context.on("close", clearIfCurrent);
  }
  await gotoUploadPage(session.page);

  return { ok: true, alreadyOpen: false, url: session.page.url() };
}

async function getLoginSessionStatus() {
  const activeAccount = await getActiveAccount();
  const saved = await hasSavedPlatformSession("tiktok", activeAccount.id);
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

async function startLoginSessionCli() {
  const result = await startLoginSession();

  console.log("");
  console.log("Log in to TikTok in the opened browser window.");
  console.log("After login is complete, press Ctrl+C in this terminal.");
  console.log("Your session will be reused for future automated posts.");
  console.log("");

  if (result.alreadyOpen) {
    return;
  }

  await new Promise(() => {
    // Keep process alive until manual interruption.
  });
}

async function uploadVideo({ videoPath, caption, source, accountId }) {
  const absoluteVideoPath = path.resolve(videoPath);
  const session = await openBrowserSession(accountId);
  const { page } = session;
  let closeHoldMs = 0;
  let publishResponseTracker = null;
  let externalActionStarted = false;
  let stage = "browser";

  try {
    stage = "upload_page";
    await gotoUploadPage(page);
    stage = "upload";
    await setVideoFile(page, absoluteVideoPath);
    await waitForUploadReady(page);
    stage = "editor_overlays";
    await resolveBlockingOverlays(page);
    stage = "caption";
    await setCaption(page, caption || config.defaultCaption);
    stage = "editor_overlays";
    await addDefaultSound(page, source).catch((error) => {
      console.log(`Sound step failed softly: ${error.message}`);
    });
    await disableShortContentCheck(page);
    publishResponseTracker = createPublishResponseTracker(page);
    stage = "post_click";
    await clickPublish(page, { onExternalActionBoundary: () => { externalActionStarted = true; } });
    stage = "confirmation";
    const confirmation = await waitForPublishConfirmation(page, publishResponseTracker);
    if (!confirmation.ok) {
      throw new Error(`Publish verification failed: ${confirmation.reason}`);
    }

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-upload-success.png"
    );
    await page
      .screenshot({ path: successScreenshotPath, fullPage: true })
      .catch(() => { });

    closeHoldMs = Math.max(config.postPublishHoldMs, 0);
    return { ok: true };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-upload-error.png"
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => { });
    closeHoldMs = Math.max(config.failureHoldMs, 0);
    const diagnosticCode = error.code || (
      externalActionStarted ? "POST_CLICK_UNCONFIRMED"
        : stage === "upload" ? "UPLOAD_FAILED"
          : stage === "caption" ? "CAPTION_INPUT_FAILED"
            : "PRE_CLICK_BROWSER_FAILURE"
    );
    return {
      ok: false,
      error: error.message,
      diagnosticCode,
      phase: stage,
      screenshotPath,
      externalActionStarted,
    };
  } finally {
    if (publishResponseTracker) {
      publishResponseTracker.dispose();
    }
    await holdBrowserBeforeClose(page, closeHoldMs, "post-finalization");
    await session.disconnect().catch((error) => {
      console.error(`Browser session disconnect failed: ${error.message}`);
    });
  }
}

module.exports = {
  startLoginSession: startLoginSessionCli,
  startDashboardLoginSession: startLoginSession,
  getLoginSessionStatus,
  closeLoginSession,
  uploadVideo,
  _private: {
    getPublishCandidateScore,
    isLikelyPublishCandidateInfo,
    resolveBlockingOverlays,
    resolveCookieBanner,
    selectKnownDialogAction,
    setCaption,
    waitForPublishConfirmation,
  },
};
