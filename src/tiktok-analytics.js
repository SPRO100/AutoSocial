// Read-only TikTok Studio content analytics. This intentionally uses the
// existing authenticated Persona session and never clicks post/edit/action
// controls. Matching is fail-closed: account identity, exact caption and a
// narrow publication-time window must identify one row, otherwise UNRESOLVED.
const { acquireBrowserSession } = require("./browser-session");
const accountLock = require("./account-lock");

function parseMetric(value) {
  const text = String(value || "").trim().replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?[KMB]?$/.test(text)) return null;
  const suffix = text.slice(-1).toUpperCase();
  const n = Number(suffix === "K" || suffix === "M" || suffix === "B" ? text.slice(0, -1) : text);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1));
}

function safeAccountPath(href, accountId) {
  try { return new URL(href, "https://www.tiktok.com").pathname.split("/").filter(Boolean)[0] === `@${accountId}`; } catch { return false; }
}

function parseStudioDate(value, referenceDate = new Date()) {
  // TikTok Studio uses a narrow no-break space between the time and AM/PM.
  // Normalize Unicode whitespace before handing the locale-rendered value to
  // Date; otherwise V8 treats the otherwise valid date as Invalid Date.
  const normalized = String(value || "").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  // Studio omits the year for recent posts. V8 supplies 2001 in that case;
  // anchor the displayed month/day/time to the canonical publication year.
  if (!/\b\d{4}\b/.test(normalized) && referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime())) {
    parsed.setFullYear(referenceDate.getFullYear());
  }
  return parsed;
}

function timezoneOffsetDeviation(rowDate, canonicalDate) {
  const minutes = Math.abs(canonicalDate.getTime() - rowDate.getTime()) / 60000;
  // Browser locale offsets are normally whole/half/quarter hours. The row
  // only has minute precision, so prefer the candidate with the most
  // plausible offset before using absolute distance as a tie-breaker.
  const remainder = minutes % 15;
  return Math.min(remainder, 15 - remainder);
}

async function readRows(page, accountId) {
  return page.locator('[data-tt="components_PostTable_Absolute"]').evaluateAll((rows, expectedAccountId) => rows.map((row) => {
    const link = row.querySelector('a[data-tt="components_PostInfoCell_a"][href*="/video/"]');
    if (!link) return null;
    const href = link.getAttribute("href");
    const dateText = row.querySelector('[data-tt="components_PublishStageLabel_TUXText"]')?.textContent?.trim() || null;
    const thumbnail = row.querySelector('source[data-tt="VideoCover_index_source"]')?.getAttribute("srcset") || row.querySelector('img')?.getAttribute("src") || null;
    const cells = [...row.querySelectorAll('[data-tt="components_ItemRow_TUXText"]')].map((el) => el.textContent?.trim() || "");
    const metrics = cells.slice(-3);
    return { caption: link.textContent?.trim() || "", href, dateText, thumbnail, metrics, accountPath: href ? new URL(href, "https://www.tiktok.com").pathname.split("/").filter(Boolean)[0] : null, expectedAccountId };
  }).filter(Boolean), accountId);
}

async function collectTikTokPublicationAnalytics(input) {
  const accountId = String(input.accountId || "");
  const caption = String(input.caption || "").trim();
  const publishedAt = new Date(input.publishedAt);
  if (!accountId || !caption || Number.isNaN(publishedAt.getTime())) return { state: "UNRESOLVED", reason: "accountId, exact caption and publishedAt are required for deterministic matching." };
  if (!accountLock.tryLock(accountId)) return { state: "BUSY", reason: "Account has another browser operation in progress." };
  let session;
  try {
    session = await acquireBrowserSession("tiktok", { accountId });
    const page = session.page;
    await page.goto("https://www.tiktok.com/tiktokstudio/content", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    if (/\/login/i.test(page.url())) return { state: "AUTH_REQUIRED", reason: "TikTok redirected the authenticated session to login." };
    const rows = await readRows(page, accountId);
    const candidates = rows.filter((row) => {
      if (row.caption !== caption || !safeAccountPath(row.href, accountId) || !row.dateText) return false;
      const rowDate = parseStudioDate(row.dateText, publishedAt);
      // Studio renders in the browser profile's locale/timezone, while the
      // canonical timestamp is UTC. Allow the timezone offset, but keep a
      // strict nearest-row decision below so two same-caption posts remain
      // ambiguous rather than being guessed.
      return !Number.isNaN(rowDate.getTime()) && Math.abs(rowDate.getTime() - publishedAt.getTime()) <= 14 * 60 * 60 * 1000;
    });
    if (candidates.length === 0) return { state: "UNRESOLVED", reason: "No TikTok Studio post matched exact account, caption and publication time.", candidateCount: 0 };
    const ranked = candidates.map((row) => {
      const rowDate = parseStudioDate(row.dateText, publishedAt);
      return { row, distance: Math.abs(rowDate.getTime() - publishedAt.getTime()), offsetDeviation: timezoneOffsetDeviation(rowDate, publishedAt) };
    }).sort((a, b) => a.offsetDeviation - b.offsetDeviation || a.distance - b.distance);
    if (ranked.length > 1 && ranked[1].offsetDeviation === ranked[0].offsetDeviation && ranked[1].distance - ranked[0].distance < 10 * 60 * 1000) return { state: "UNRESOLVED", reason: "More than one TikTok Studio post is equally close to the canonical publication time; attribution is ambiguous.", candidateCount: candidates.length };
    const match = ranked[0].row;
    return { state: "COLLECTED", source: "autosocial-tiktok-studio", remotePostId: String(match.href).match(/\/video\/(\d+)/)?.[1] || null, remotePostUrl: new URL(match.href, "https://www.tiktok.com").toString(), thumbnailUrl: match.thumbnail, metrics: { views: parseMetric(match.metrics[0]), likes: parseMetric(match.metrics[1]), comments: parseMetric(match.metrics[2]) }, raw: { dateText: match.dateText, caption: match.caption, metricsLabels: ["views", "likes", "comments"], thumbnailUrl: match.thumbnail } };
  } catch (error) {
    return { state: "FAILED", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    if (session) await session.disconnect().catch(() => {});
    accountLock.unlock(accountId);
  }
}

module.exports = { collectTikTokPublicationAnalytics, parseMetric, parseStudioDate };
