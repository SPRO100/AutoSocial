const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function getBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return value.toString().toLowerCase() === "true";
}

const projectRoot = path.resolve(__dirname, "..");

function resolveOptionalProjectPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return path.resolve(projectRoot, trimmed);
}

const config = {
  projectRoot,
  queueDir: path.resolve(projectRoot, process.env.QUEUE_DIR || "queue/default/tiktok/pending"),
  postedDir: path.resolve(projectRoot, process.env.POSTED_DIR || "queue/default/tiktok/posted"),
  failedDir: path.resolve(projectRoot, process.env.FAILED_DIR || "queue/default/tiktok/failed"),
  profileDir: path.resolve(projectRoot, process.env.BROWSER_PROFILE_DIR || ".profile"),
  instagramQueueDir: path.resolve(
    projectRoot,
    process.env.INSTAGRAM_QUEUE_DIR || "queue/default/instagram/pending"
  ),
  instagramPostedDir: path.resolve(
    projectRoot,
    process.env.INSTAGRAM_POSTED_DIR || "queue/default/instagram/posted"
  ),
  instagramFailedDir: path.resolve(
    projectRoot,
    process.env.INSTAGRAM_FAILED_DIR || "queue/default/instagram/failed"
  ),
  instagramProfileDir: path.resolve(
    projectRoot,
    process.env.INSTAGRAM_PROFILE_DIR || ".profile-instagram"
  ),
  youtubeQueueDir: path.resolve(
    projectRoot,
    process.env.YOUTUBE_QUEUE_DIR || "queue/default/youtube/pending"
  ),
  youtubePostedDir: path.resolve(
    projectRoot,
    process.env.YOUTUBE_POSTED_DIR || "queue/default/youtube/posted"
  ),
  youtubeFailedDir: path.resolve(
    projectRoot,
    process.env.YOUTUBE_FAILED_DIR || "queue/default/youtube/failed"
  ),
  youtubeProfileDir: path.resolve(
    projectRoot,
    process.env.YOUTUBE_PROFILE_DIR || ".profile-youtube"
  ),
  cronExpression: process.env.CRON_EXPRESSION || "0 */2 * * *",
  instagramCronExpression: process.env.INSTAGRAM_CRON_EXPRESSION || "0 */2 * * *",
  youtubeCronExpression: process.env.YOUTUBE_CRON_EXPRESSION || "0 */2 * * *",
  timezone: process.env.TZ || "UTC",
  browserLocale: process.env.BROWSER_LOCALE || "en-US",
  headless: getBoolean(process.env.HEADLESS, false),
  postDelayMs: Number(process.env.POST_DELAY_MS || 15000),
  postPublishHoldMs: Number(process.env.POST_PUBLISH_HOLD_MS || 25000),
  failureHoldMs: Number(process.env.FAILURE_HOLD_MS || 8000),
  autoAddSound: getBoolean(process.env.AUTO_ADD_SOUND, false),
  randomQueueOrder: getBoolean(process.env.RANDOM_QUEUE_ORDER, false),
  defaultSoundQuery: process.env.DEFAULT_SOUND_QUERY || "",
  defaultCaption: process.env.DEFAULT_CAPTION || "",
  uploadPageUrl:
    process.env.TIKTOK_UPLOAD_URL || "https://www.tiktok.com/tiktokstudio/upload",
  instagramUploadPageUrl:
    process.env.INSTAGRAM_UPLOAD_URL || "https://www.instagram.com/create/style/",
  youtubeUploadPageUrl:
    process.env.YOUTUBE_UPLOAD_URL || "https://studio.youtube.com",
  // Persona Studio integration (see src/persona-browser.js) - when an
  // account is mapped to a Persona profile, Persona owns the browser
  // identity/session instead of AutoSocial's own persistent-profile
  // directories.
  personaApiUrl: process.env.PERSONA_API_URL || "http://127.0.0.1:8787",
  personaAttachTimeoutMs: Number(process.env.PERSONA_ATTACH_TIMEOUT_MS || 30000),
  dashboardHost: process.env.DASHBOARD_HOST || "127.0.0.1",
  dashboardPort: Number(process.env.DASHBOARD_PORT || 3000),
  dashboardAllowRemote: getBoolean(process.env.DASHBOARD_ALLOW_REMOTE, false),
  uniquifyInputDir: path.resolve(
    projectRoot,
    process.env.UNIQUIFY_INPUT_DIR || "queue/uniquify-input"
  ),
  uniquifyOutputDir: path.resolve(
    projectRoot,
    process.env.UNIQUIFY_OUTPUT_DIR || "queue/uniquify-output"
  ),
  uniquifyLogoImage: resolveOptionalProjectPath(process.env.UNIQUIFY_LOGO_IMAGE),
  uniquifyIntroSeconds: Number(process.env.UNIQUIFY_INTRO_SECONDS || 1),
  uniquifyEndHoldSeconds: Number(process.env.UNIQUIFY_END_HOLD_SECONDS || 0.4),

  // Auto-download pipeline
  autoDownload: {
    channel: process.env.WATCH_CHANNEL || "",
    interval: Number(process.env.WATCH_INTERVAL || 10),
    maxVideos: Number(process.env.WATCH_MAX_VIDEOS || 5),
    minViews: Number(process.env.WATCH_MIN_VIEWS || 0),
    platforms: (process.env.AUTO_POST_PLATFORMS || "tiktok")
      .split(",")
      .map((p) => p.trim().toLowerCase()),
  },
};

// Map platform names to their queue directories
config.platformQueues = {
  tiktok: config.queueDir,
  instagram: config.instagramQueueDir,
  youtube: config.youtubeQueueDir,
};

module.exports = {
  config,
};
