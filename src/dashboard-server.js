const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const express = require("express");
const { config } = require("./config");
const { ensureDirectories } = require("./fs-utils");
const { UniquifierController } = require("./uniquifier-controller");
const { AutoDownloadController } = require("./autodownload-controller");
const { ProfileDownloadController } = require("./profile-download-controller");
const { getDaemons, getAllStatus } = require("./daemon-registry");
const { migrateQueueIfNeeded } = require("./migrate-queue");
const { createDashboardRequestGuard } = require("./request-guard");
const { buildSetupHealth, getAllowedSetupFolderPath } = require("./setup-health");
const {
  startDashboardLoginSession: startTikTokLoginSession,
  getLoginSessionStatus: getTikTokLoginSessionStatus,
  closeLoginSession: closeTikTokLoginSession,
} = require("./tiktok-uploader");
const {
  startLoginSession: startInstagramLoginSession,
  getLoginSessionStatus: getInstagramLoginSessionStatus,
  closeLoginSession: closeInstagramLoginSession,
} = require("./instagram-uploader");
const {
  startLoginSession: startYouTubeLoginSession,
  getLoginSessionStatus: getYouTubeLoginSessionStatus,
  closeLoginSession: closeYouTubeLoginSession,
} = require("./youtube-uploader");
const {
  getState,
  addAccount,
  selectAccount,
  getActiveAccount,
  getAllAccounts,
  ensureAccountDirs,
  setPersonaProfileId,
  clearPersonaProfileId,
  getPersonaProfileId,
  hasSavedPlatformSession,
  setPublishStatus,
  PLATFORMS,
} = require("./account-manager");
const {
  stopPersonaProfile,
  startPersonaBrowser,
  listPersonaProfiles,
} = require("./persona-browser");
const { computeAccountPersona, indexProfilesById } = require("./persona-overview");
const supplierLab = require("./supplier-lab");
const { detectFormat } = require("./importers/detector");
const manualMapping = require("./importers/manual-mapping");
const templateStore = require("./importers/template-store");
const { buildPreview, importBatch, selectRecords } = require("./importers/pipeline");
const { healthForAccount, qualitySummary, FRESHNESS_MS } = require("./account-health");
const uploadStore = require("./importers/upload-store");
const accountDeletion = require("./account-deletion");
const sessionCheck = require("./session-check");
const accountLock = require("./account-lock");
const tiktokPublish = require("./tiktok-publish");
const tiktokAnalytics = require("./tiktok-analytics");
const instagramUploader = require("./instagram-uploader");
const youtubeUploader = require("./youtube-uploader");
const { getBrowserAdapter } = require("./browser-platform-adapters");

// Playwright can surface page/dialog protocol failures as late rejected
// promises after a job's browser connection is already closing. Keep those
// failures bounded to the job/browser lifecycle and observable instead of
// allowing Node's default unhandled-rejection behavior to terminate every
// account served by this process.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled asynchronous job error (service kept alive):", reason);
});

// Upload content is a plain-text credentials file read client-side (see
// web/app.js's use of FileReader) and posted as JSON, not multipart - this
// avoids adding a file-upload dependency and means the raw bytes never
// touch disk server-side (see importers/upload-store.js). Cap generous
// enough for a 100+ account batch, small enough to bound memory.
const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
// The shared express.json() body limit (below) must stay comfortably above
// this - it bounds the whole JSON request (the `{"content": "..."}"`
// wrapper plus any other fields), not just the inner content string. If the
// two were equal, a content string right at MAX_IMPORT_FILE_BYTES would
// still exceed the parser's limit once wrapped, so the request would be
// rejected by body-parser's generic "request entity too large" before ever
// reaching the route's own, friendlier size check below.
const JSON_BODY_LIMIT_BYTES = MAX_IMPORT_FILE_BYTES + 64 * 1024;
// One manually-uploaded test video for milestone 2's single-video publish
// flow - generous enough for a real short-form clip, bounded so an
// oversized upload can't exhaust memory. Applied via express.raw() only on
// the one publish route below, never the shared JSON body parser.
const MAX_PUBLISH_VIDEO_BYTES = 200 * 1024 * 1024;

function openFolder(folderPath) {
  return new Promise((resolve, reject) => {
    const platform = os.platform();
    if (platform === "win32") {
      const child = spawn("explorer", [folderPath], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.unref();
      resolve();
      return;
    }
    if (platform === "darwin") {
      const child = spawn("open", [folderPath], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.unref();
      resolve();
      return;
    }
    const child = spawn("xdg-open", [folderPath], { detached: true, stdio: "ignore" });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

/**
 * Helper: resolve the active account and get its daemons from the registry.
 */
async function getActiveDaemons() {
  const active = await getActiveAccount();
  return getDaemons(active.id);
}

const SETTINGS_ENV_KEYS = new Set([
  "AUTO_ADD_SOUND",
  "DEFAULT_CAPTION",
  "DEFAULT_SOUND_QUERY",
  "RANDOM_QUEUE_ORDER",
]);

function serializeEnvValue(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@,-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function applyRuntimeSetting(envKey, value) {
  if (envKey === "AUTO_ADD_SOUND") {
    config.autoAddSound = String(value).toLowerCase() === "true";
  } else if (envKey === "DEFAULT_CAPTION") {
    config.defaultCaption = String(value ?? "");
  } else if (envKey === "DEFAULT_SOUND_QUERY") {
    config.defaultSoundQuery = String(value ?? "");
  } else if (envKey === "RANDOM_QUEUE_ORDER") {
    config.randomQueueOrder = String(value).toLowerCase() === "true";
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function ensureDashboardBindAllowed() {
  if (config.dashboardAllowRemote || isLoopbackHost(config.dashboardHost)) {
    return;
  }

  throw new Error(
    `Refusing to bind dashboard to "${config.dashboardHost}". ` +
    "Use DASHBOARD_HOST=127.0.0.1 or set DASHBOARD_ALLOW_REMOTE=true if you understand the risk."
  );
}

async function createServer() {
  // Run migration from old flat queue layout to per-profile structure
  await migrateQueueIfNeeded();

  // Ensure dirs for all existing accounts
  const allAccounts = await getAllAccounts();
  for (const acct of allAccounts) {
    await ensureAccountDirs(acct.id);
  }

  // Ensure uniquifier dirs
  await ensureDirectories([
    config.uniquifyInputDir,
    config.uniquifyOutputDir,
  ]);

  // Pre-initialize daemons for all existing accounts
  for (const acct of allAccounts) {
    await getDaemons(acct.id);
  }

  const app = express();
  const uniquifier = new UniquifierController();
  const autoDownloader = new AutoDownloadController();
  const profileDownloader = new ProfileDownloadController();

  // Default body-parser limit (100kb) is too small for the import preview
  // route's file content (see MAX_IMPORT_FILE_BYTES below, which enforces
  // the real intended cap) - raised here, at the one shared parser, since
  // this is a local single-operator dashboard, not a public multi-tenant
  // service.
  app.use(express.json({ limit: JSON_BODY_LIMIT_BYTES }));
  app.use(createDashboardRequestGuard());
  app.use(express.static(path.join(__dirname, "..", "web")));

  // TikTok endpoints (profile-aware)

  app.get("/api/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.tiktok.getStatus();
    res.json(status);
  });

  app.post("/api/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.tiktok.start();
    res.json(result);
  });

  app.post("/api/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.tiktok.stop();
    res.json(result);
  });

  app.post("/api/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.tiktok.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.tiktok.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Settings

  app.post("/api/settings/save", async (req, res) => {
    try {
      const { payload } = req.body || {};
      if (!payload || typeof payload !== "object") {
        return res.status(400).json({ ok: false, error: "Invalid payload." });
      }

      const envPath = path.resolve(config.projectRoot, ".env");
      let envContent = "";
      try {
        envContent = await fs.readFile(envPath, "utf-8");
      } catch (err) {
        // file might not exist
      }

      const lines = envContent.split("\n");
      for (const [key, value] of Object.entries(payload)) {
        const envKey = key.toUpperCase();
        if (!SETTINGS_ENV_KEYS.has(envKey)) {
          return res.status(400).json({ ok: false, error: `Unsupported setting: ${envKey}` });
        }

        const serializedValue = serializeEnvValue(value);
        let found = false;

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith(`${envKey}=`)) {
            lines[i] = `${envKey}=${serializedValue}`;
            found = true;
            break;
          }
        }

        if (!found) {
          lines.push(`${envKey}=${serializedValue}`);
        }

        applyRuntimeSetting(envKey, value);
      }

      await fs.writeFile(envPath, lines.join("\n").replace(/\n{2,}/g, "\n"));
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Account endpoints

  app.get("/api/accounts", async (req, res) => {
    const state = await getState();
    const active = await getActiveAccount();
    res.json({ ...state, activeAccount: active });
  });

  app.post("/api/accounts/add", async (req, res) => {
    try {
      const account = await addAccount(req.body?.name);
      // Pre-initialize daemons for the new account
      await getDaemons(account.id);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/select", async (req, res) => {
    try {
      const account = await selectAccount(req.body?.accountId);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Persona Studio profile mapping. Setting this reroutes the account's
  // browser identity/session to Persona (see src/browser-session.js);
  // clearing it restores the legacy persistent-profile behavior.
  app.post("/api/accounts/persona", async (req, res) => {
    try {
      const account = await setPersonaProfileId(
        req.body?.accountId,
        req.body?.personaProfileId
      );
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/accounts/persona/clear", async (req, res) => {
    try {
      const account = await clearPersonaProfileId(req.body?.accountId);
      const state = await getState();
      res.json({ ok: true, account, state });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Explicit, intentional shutdown of a linked account's Persona browser
  // process (see persona-browser.js#stopPersonaProfile) - the operator's
  // recovery path if a profile is stuck attached (e.g. after a CDP connect
  // failure) or they simply want to close it. Never called automatically.
  app.post("/api/accounts/persona/stop", async (req, res) => {
    try {
      const profileId = await getPersonaProfileId(req.body?.accountId);
      if (!profileId) {
        throw new Error("This account has no linked Persona profile.");
      }
      await stopPersonaProfile(profileId);
      res.json({ ok: true, profileId });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Account deletion (see src/account-deletion.js). Only ever takes an
  // accountId - the Persona profile id is always resolved server-side from
  // the real account record, never accepted from the request, so a
  // spoofed/wrong id can never be used to delete an unrelated profile.
  app.post("/api/accounts/delete", async (req, res) => {
    try {
      const accountId = req.body?.accountId;
      const mode = req.body?.mode;
      if (!accountId) {
        return res.status(400).json({ ok: false, error: "Missing accountId." });
      }
      if (mode !== "remove_only" && mode !== "delete_completely") {
        return res.status(400).json({ ok: false, error: "mode must be \"remove_only\" or \"delete_completely\"." });
      }
      const result = mode === "remove_only"
        ? await accountDeletion.removeAccountOnly(accountId)
        : await accountDeletion.deleteCompletely(accountId);
      if (!result.ok) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Manual "Check session" (see src/session-check.js) - reuses the exact
  // same verifier the import/Update Session pipeline uses, and restores
  // whatever running/stopped state the profile was already in.
  app.post("/api/accounts/check-session", async (req, res) => {
    try {
      const accountId = req.body?.accountId;
      if (!accountId) {
        return res.status(400).json({ ok: false, error: "Missing accountId." });
      }
      const result = await sessionCheck.checkSession(accountId, typeof req.body?.platform === "string" ? req.body.platform.toLowerCase() : undefined);
      if (!result.ok) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Provider capability truth is deliberately explicit. Unsupported browser
  // flows are returned as such rather than being advertised as READY.
  app.get("/api/platform-capabilities", (_req, res) => {
    res.json({ ok: true, capabilities: [
      { platform: "tiktok", provider: "autosocial", types: ["video"], status: "READY" },
      { platform: "instagram", provider: "autosocial", types: ["reel", "post_video", "post_image"], status: "READY" },
      { platform: "instagram", provider: "autosocial", types: ["story_image", "story_video", "carousel"], status: "UNSUPPORTED_BROWSER_FLOW" },
      { platform: "threads", provider: "autosocial", types: ["text", "image", "video"], status: "IMPLEMENTED_AWAITING_REAL_ACCEPTANCE" },
      { platform: "youtube", provider: "autosocial", types: ["short", "video"], status: "READY" },
      { platform: "x", provider: "autosocial", types: ["text", "image", "video", "multi_media"], status: "IMPLEMENTED_AWAITING_REAL_ACCEPTANCE" },
    ] });
  });

  // Read-only TikTok Studio insights for an already-published post. The
  // caller supplies canonical attribution anchors; the adapter never uses
  // destructive controls and returns UNRESOLVED when the browser has zero or
  // multiple matches.
  app.post("/api/analytics/tiktok/publication", async (req, res) => {
    try {
      const result = await tiktokAnalytics.collectTikTokPublicationAnalytics({
        accountId: req.body?.accountId,
        caption: req.body?.caption,
        publishedAt: req.body?.publishedAt,
      });
      res.status(200).json({ ok: true, ...result });
    } catch (error) {
      res.status(200).json({ ok: true, state: "FAILED", reason: error.message });
    }
  });

  // First real single-video TikTok publish (see src/tiktok-publish.js).
  // Raw video bytes as the request body (see the express.raw() middleware
  // registered for this exact path below) - accountId/filename/caption via
  // query string, since a binary body can't also carry JSON fields.
  app.post("/api/publish/tiktok", express.raw({ type: "*/*", limit: MAX_PUBLISH_VIDEO_BYTES }), async (req, res) => {
    try {
      const accountId = req.query?.accountId;
      if (!accountId || typeof accountId !== "string") {
        return res.status(400).json({ ok: false, error: "Missing accountId." });
      }
      const filename = typeof req.query?.filename === "string" ? req.query.filename : "";
      const caption = typeof req.query?.caption === "string" ? req.query.caption : "";
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ ok: false, error: "No video file was provided." });
      }
      const result = await tiktokPublish.publish(accountId, { videoBuffer: req.body, filename, caption });
      if (!result.ok) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Generic browser boundary for the uploaders that already exist in this
  // service. It intentionally supports only their proven video flows;
  // Threads/X and unsupported Instagram types fail closed with a structured
  // status instead of a fake publish implementation.
  app.post("/api/publish/:platform", express.raw({ type: "*/*", limit: MAX_PUBLISH_VIDEO_BYTES }), async (req, res) => {
    const platform = String(req.params.platform || "").toLowerCase();
    if (platform === "tiktok") return res.status(404).json({ ok: false, error: "Use the TikTok publish route." });
    const accountId = req.query?.accountId;
    const publicationType = String(req.query?.publicationType || "video").toLowerCase();
    const caption = typeof req.query?.caption === "string" ? req.query.caption : "";
    if (!accountId || (!Buffer.isBuffer(req.body) && !["threads", "x"].includes(platform))) return res.status(400).json({ ok: false, error: "Missing accountId or media." });
    if (platform === "instagram" && !["reel", "post_video", "post_image", "video"].includes(publicationType)) {
      return res.status(501).json({ ok: false, finalStatus: "failed", code: "UNSUPPORTED_BROWSER_FLOW", phase: "capability", safeToRetry: true, externalActionStarted: false, postClick: false });
    }
    if (platform !== "instagram" && platform !== "youtube" && !getBrowserAdapter(platform)) {
      return res.status(501).json({ ok: false, finalStatus: "failed", code: "UNSUPPORTED_BROWSER_FLOW", phase: "capability", safeToRetry: true, externalActionStarted: false, postClick: false });
    }
    if (!accountLock.tryLock(accountId)) {
      return res.status(409).json({ ok: false, finalStatus: "failed", code: "ACCOUNT_BUSY", phase: "concurrency", safeToRetry: true, externalActionStarted: false, postClick: false });
    }
    const filename = typeof req.query?.filename === "string" ? req.query.filename : `${platform}-upload.mp4`;
    const tempPath = path.join(config.projectRoot, "queue", `api-${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    try {
      const hasMedia = Buffer.isBuffer(req.body) && req.body.length > 0;
      if (hasMedia) {
        await fs.mkdir(path.dirname(tempPath), { recursive: true });
        await fs.writeFile(tempPath, req.body);
      }
      const result = platform === "instagram"
        ? await instagramUploader.uploadMedia({ mediaPaths: tempPath, caption, accountId, publicationType })
        : platform === "youtube"
          ? await youtubeUploader.uploadVideo({ videoPath: tempPath, caption, accountId })
          : await getBrowserAdapter(platform).publish({ accountId, text: caption, mediaPaths: hasMedia ? [tempPath] : [], publicationType: publicationType.toUpperCase() });
      if (!result.ok) {
        const finalStatus = result.externalActionStarted ? "unconfirmed" : "failed";
        await setPublishStatus(accountId, { status: finalStatus, reason: result.error }).catch(() => {});
        return res.status(result.externalActionStarted ? 500 : 400).json({ ok: false, finalStatus, code: result.externalActionStarted ? "BROWSER_PUBLISH_UNCONFIRMED" : "BROWSER_PUBLISH_FAILED", phase: result.phase, error: result.error, diagnosticArtifact: result.screenshotPath, safeToRetry: !result.externalActionStarted, externalActionStarted: Boolean(result.externalActionStarted), postClick: Boolean(result.postClick), navigationStarted: Boolean(result.navigationStarted), mediaUploadStarted: Boolean(result.mediaUploadStarted) });
      }
      await setPublishStatus(accountId, { status: "published" }).catch(() => {});
      return res.json({ ok: true, finalStatus: "published", platform, publicationType, accountId, phase: result.phase, externalActionStarted: true, postClick: true, safeToRetry: false, remotePostId: result.remotePostId ?? null, remotePostUrl: result.remotePostUrl ?? null });
    } catch (error) {
      await setPublishStatus(accountId, { status: "failed", reason: error.message }).catch(() => {});
      return res.status(500).json({ ok: false, finalStatus: "failed", code: "BROWSER_PUBLISH_FAILED", phase: "SESSION_ACQUIRE", error: error.message, safeToRetry: true, externalActionStarted: false, postClick: false });
    } finally {
      accountLock.unlock(accountId);
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  });

  // Explicit "Start" action - attaches (so Persona's real browser is
  // genuinely up) then immediately releases AutoSocial's own connection,
  // leaving Persona owning a running, visible browser the operator can
  // drive directly (e.g. to log in) without the dashboard holding a
  // Playwright client open on their behalf.
  app.post("/api/persona/attach", async (req, res) => {
    try {
      const profileId = await getPersonaProfileId(req.body?.accountId);
      if (!profileId) {
        throw new Error("This account has no linked Persona profile.");
      }
      // Dashboard runs as a server worker and may not have a graphical
      // DISPLAY. Use the same headless Persona handshake as check-session;
      // a visible operator session can still be started from Persona Studio.
      const result = await startPersonaBrowser(profileId, { headless: true });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Real, current Persona profiles - used both for the "Persona Profiles"
  // list and to populate the link-an-account picker (never requires typing
  // a profile id by hand).
  app.get("/api/persona/profiles", async (req, res) => {
    try {
      const profiles = await listPersonaProfiles();
      res.json({ ok: true, profiles });
    } catch (error) {
      res.status(200).json({ ok: false, error: error.message, profiles: [] });
    }
  });

  // One aggregated read for the dashboard's Persona section: every
  // AutoSocial account, its Persona mapping (if any) cross-referenced
  // against Persona's real, single profile-list fetch (not a fetch per
  // account), and per-platform saved-session status. Degrades honestly
  // when Persona API is unreachable - the account list and legacy
  // platform status still return; Persona-derived fields become "unknown"
  // rather than a fabricated true/false, and personaApiAvailable/
  // personaApiError tell the UI exactly what happened.
  app.get("/api/persona/overview", async (req, res) => {
    const accounts = await getAllAccounts();
    let profiles = null;
    let personaApiError = null;
    try {
      profiles = await listPersonaProfiles();
    } catch (error) {
      personaApiError = error.message;
    }
    const profileById = indexProfilesById(profiles);
    const personaApiAvailable = profiles !== null;

    const accountRows = await Promise.all(
      accounts.map(async (account) => {
        const persona = computeAccountPersona(account, profileById, personaApiAvailable);

        const platforms = {};
        for (const platform of PLATFORMS) {
          if (account.personaProfileId) {
            // Same identity backs every platform for this account - avoid
            // a redundant Persona call per platform when the one profiles
            // fetch above already answered this.
            platforms[platform] = { saved: persona.found === null ? null : persona.found };
          } else {
            platforms[platform] = { saved: await hasSavedPlatformSession(platform, account.id) };
          }
        }

        return {
          id: account.id,
          name: account.name,
          platform: account.importPlatform || null,
          personaProfileId: account.personaProfileId || null,
          persona,
          platforms,
          // Safe, non-secret operational history - see account-manager.js's
          // normalizeAccount. Never a cookie/password/token value.
          sessionStatus: account.sessionStatus || "unknown",
          sessionCheckedAt: account.sessionCheckedAt || null,
          sessionReason: account.sessionReason || null,
          // Session Recovery Pipeline record (see session-recovery.js) -
          // granular state and the safe, non-secret attempt history. Both
          // null for any account never processed through recovery (every
          // account checked before this milestone, or a platform with no
          // recoverable states).
          sessionState: account.sessionState || null,
          sessionRecoveryAttempts: account.sessionRecoveryAttempts || null,
          importedAt: account.importedAt || null,
          supplierFormat: account.supplierFormat || null,
          supplierBatchId: account.supplierBatchId || null,
          sessionSource: account.sessionSource || null,
          sessionIntegrity: account.sessionIntegrity || null,
          networkIdentity: account.networkIdentity || null,
          firstVerifiedAt: account.firstVerifiedAt || null,
          firstSessionStatus: account.firstSessionStatus || null,
          lastReadyAt: account.lastReadyAt || null,
          health: { ...healthForAccount(account), lastCheckedAt: account.sessionCheckedAt || null },
          failureCount: account.failureCount || 0,
          failureClass: account.failureClass || null,
          quarantineReason: account.quarantineReason || null,
          quarantinedAt: account.quarantinedAt || null,
          lastPublishStatus: account.lastPublishStatus || null,
          lastPublishAt: account.lastPublishAt || null,
          lastPublishError: account.lastPublishError || null,
        };
      })
    );

    res.json({
      ok: true,
      personaApiAvailable: profiles !== null,
      personaApiError,
      accounts: accountRows,
    });
  });

  // Read-only operational projection for supplier/account quality. It is
  // intentionally separate from the account CRUD response so consumers can
  // render compact health summaries without receiving credentials.
  app.get("/api/accounts/health", async (req, res) => {
    const accounts = await getAllAccounts();
    res.json({
      ok: true,
      freshnessMs: FRESHNESS_MS,
      accounts: accounts.filter((account) => account.importPlatform).map((account) => ({
        id: account.id,
        name: account.name,
        platform: account.importPlatform,
        importedAt: account.importedAt || null,
        supplierFormat: account.supplierFormat || null,
        supplierBatchId: account.supplierBatchId || null,
        sessionSource: account.sessionSource || null,
        sessionIntegrity: account.sessionIntegrity || null,
        networkIdentity: account.networkIdentity || null,
        firstVerifiedAt: account.firstVerifiedAt || null,
        firstSessionStatus: account.firstSessionStatus || null,
        lastReadyAt: account.lastReadyAt || null,
        sessionStatus: account.sessionStatus || "unknown",
        sessionState: account.sessionState || null,
        sessionCheckedAt: account.sessionCheckedAt || null,
        sessionReason: account.sessionReason || null,
        health: healthForAccount(account),
        failureCount: account.failureCount || 0,
        failureClass: account.failureClass || null,
        quarantineReason: account.quarantineReason || null,
        quarantinedAt: account.quarantinedAt || null,
      })),
      quality: qualitySummary(accounts),
    });
  });

  // Secret-free, append-only Supplier Lab projections. Posting an observation
  // never starts a browser or performs recovery; a scheduler may submit the
  // same checkpoint repeatedly and receive the existing observation.
  app.get("/api/supplier-lab/experiments", async (_req, res) => {
    res.json({ ok: true, experiments: await supplierLab.listExperiments() });
  });
  app.post("/api/supplier-lab/experiments", async (req, res) => {
    try { res.status(201).json({ ok: true, experiment: await supplierLab.createExperiment(req.body || {}) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.get("/api/supplier-lab/experiments/:id", async (req, res) => {
    const experiment = await supplierLab.getExperiment(req.params.id);
    if (!experiment) return res.status(404).json({ ok: false, error: "Supplier experiment not found." });
    res.json({ ok: true, experiment, scorecard: supplierLab.scorecard(experiment) });
  });
  app.post("/api/supplier-lab/experiments/:id/observations", async (req, res) => {
    try { res.status(201).json({ ok: true, observation: await supplierLab.recordObservation(req.params.id, req.body || {}) }); }
    catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  // Bulk account import (see src/importers/). Two steps: preview (parse +
  // detect format, return a secret-free summary, hold the real records
  // in-memory only - see upload-store.js) then confirm (consume that
  // held batch exactly once and run the real pipeline). Never echoes a
  // password or cookie value back to the client at any point.

  app.post("/api/import/preview", async (req, res) => {
    try {
      const content = req.body?.content;
      if (typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ ok: false, error: "No file content was provided." });
      }
      if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_FILE_BYTES) {
        return res.status(400).json({ ok: false, error: "File is too large." });
      }
      const hintedPlatform = typeof req.body?.platform === "string" ? req.body.platform.toLowerCase() : undefined;
      let supplier = detectFormat(content, { platform: hintedPlatform });
      let templateName = null;
      if (hintedPlatform) {
        const templates = await templateStore.list(hintedPlatform);
        const ordered = req.body?.templateId ? [...templates.filter((x) => x.id === req.body.templateId), ...templates.filter((x) => x.id !== req.body.templateId)] : templates;
        for (const template of ordered) {
          const applied = manualMapping.parse(content, hintedPlatform, template);
          if (applied.records.length) { supplier = { id: `template-${template.id}`, parse: () => applied }; templateName = template.name; break; }
          // A user-selected template is still useful even when this upload
          // needs review (for example a changed header or record layout). Do
          // not discard the saved structural mapping or fall through to the
          // old universal detector; return an actionable review state.
          if (req.body?.templateId === template.id) {
            return res.json({ ok: true, requiresMapping: true, code: "PARSE_REVIEW_REQUIRED", platform: hintedPlatform, templateId: template.id, templateName: template.name, mapping: { ...manualMapping.suggest(content, hintedPlatform), delimiter: template.delimiter, fields: template.fields, recordMode: template.recordMode || "AUTO" }, error: `Saved template "${template.name}" needs review for this file.` });
          }
        }
      }
      if (!supplier) {
        if (typeof req.body?.platform === "string" && req.body.platform.trim()) {
          return res.json({ ok: true, requiresMapping: true, code: "PARSE_REVIEW_REQUIRED", platform: req.body.platform, mapping: manualMapping.suggest(content, req.body.platform), error: `Format needs review: ${req.body.platform} was detected, but account fields need confirmation.` });
        }
        return res.status(400).json({
          ok: false,
          error: "This file's format was not recognized by any supported supplier adapter.",
        });
      }
      // hintedPlatform is passed through as a second argument - every
      // existing platform-specific adapter's parse(text) ignores extra
      // arguments; only the generic credentials-auto adapter (which has no
      // platform signal of its own) reads it.
      const { records, errors, ignoredMetadata = 0, classifications = null } = supplier.parse(content, hintedPlatform);
      if (!records.length) {
        return res.status(400).json({
          ok: false,
          error: "No valid account records were found in that file.",
          parseErrors: errors,
        });
      }
      const preview = await buildPreview(records);
      const importId = uploadStore.put(records, { format: supplier.id, template: templateName });
      res.json({
        ok: true,
        importId,
        format: supplier.id,
        total: records.length,
        ignoredMetadata,
        classifications,
        templateName,
        parseErrors: errors,
        preview,
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/import/mapping/preview", async (req, res) => {
    try {
      const content = req.body?.content; const platform = String(req.body?.platform || "").toLowerCase(); const mapping = req.body?.mapping;
      if (typeof content !== "string" || !content.trim() || !platform || !mapping) return res.status(400).json({ ok: false, error: "Content, platform and mapping are required." });
      const parsed = manualMapping.parse(content, platform, mapping);
      if (!parsed.records.length) return res.status(400).json({ ok: false, code: "PARSE_REVIEW_REQUIRED", error: parsed.errors[0]?.reason || "Mapping produced no valid account records.", mapping: manualMapping.suggest(content, platform) });
      const preview = await buildPreview(parsed.records); const importId = uploadStore.put(parsed.records, { format: `manual-${platform}`, template: mapping.templateName || null });
      res.json({ ok: true, requiresMapping: false, importId, format: `manual-${platform}`, total: parsed.records.length, ignoredMetadata: parsed.ignoredMetadata || 0, parseErrors: parsed.errors, preview });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/import/templates", async (req, res) => {
    try { res.json({ ok: true, templates: await templateStore.list(typeof req.body?.platform === "string" ? req.body.platform : undefined) }); } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });
  app.get("/api/import/templates", async (req, res) => { try { res.json({ ok: true, templates: await templateStore.list(typeof req.query?.platform === "string" ? req.query.platform : undefined) }); } catch (error) { res.status(400).json({ ok: false, error: error.message }); } });
  app.delete("/api/import/templates/:id", async (req, res) => { try { res.json({ ok: true, removed: await templateStore.remove(req.params.id) }); } catch (error) { res.status(400).json({ ok: false, error: error.message }); } });
  app.post("/api/import/templates/save", async (req, res) => {
    try {
      const template = req.body?.template;
      if (!template?.platform || !template?.delimiter || !template?.fields) return res.status(400).json({ ok: false, error: "Structural template fields are required." });
      res.json({ ok: true, template: await templateStore.save(template) });
    } catch (error) { res.status(400).json({ ok: false, error: error.message }); }
  });

  app.post("/api/import/confirm", async (req, res) => {
    try {
      const importId = req.body?.importId;
      if (!importId) {
        return res.status(400).json({ ok: false, error: "Missing importId." });
      }
      // A preview is safe by default: an explicit selection is required for
      // the Dashboard's current operator flow. Keep omitted selectedKeys
      // backward-compatible for trusted/internal callers, but never consume
      // an upload when the UI submits an empty selection.
      if (Array.isArray(req.body?.selectedKeys) && req.body.selectedKeys.length === 0) {
        return res.status(400).json({ ok: false, error: "Select at least one account before confirming import." });
      }
      const entry = uploadStore.take(importId);
      if (!entry) {
        return res.status(400).json({
          ok: false,
          error: "This import has expired or was already processed. Upload the file again.",
        });
      }
      const concurrency = Number(req.body?.concurrency) || undefined;
      // Explicit, per-record opt-in for Update Session on an already-
      // imported (platform, username) - see importers/pipeline.js. Never
      // applied automatically; an empty/missing list means every duplicate
      // stays the existing safe default (SKIPPED_DUPLICATE).
      const updateSessionKeys = Array.isArray(req.body?.updateSessionKeys)
        ? req.body.updateSessionKeys.filter((k) => typeof k === "string")
        : [];
      const selectedRecords = selectRecords(entry.records, req.body?.selectedKeys);
      if (!selectedRecords.length) {
        return res.status(400).json({ ok: false, error: "No valid selected account records remain in this preview." });
      }
      const selectedKeySet = new Set(selectedRecords.map((record) => `${String(record.platform).toLowerCase()}:${String(record.username).toLowerCase()}`));
      const selectedUpdateSessionKeys = updateSessionKeys.filter((key) => selectedKeySet.has(key.toLowerCase()));
      const report = await importBatch(selectedRecords, {
        concurrency,
        updateSessionKeys: selectedUpdateSessionKeys,
        importMeta: { ...(entry.meta || {}), batchId: importId, importedAt: new Date().toISOString() },
      });
      for (const result of report.results) {
        if (result.accountId) {
          try {
            await getDaemons(result.accountId);
          } catch {
            // Daemon pre-init is a convenience, not required for the
            // account/profile/cookie import itself to have succeeded.
          }
        }
      }
      res.json({ ok: true, report });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Login endpoints (TikTok)

  app.post("/api/tiktok/login", async (req, res) => {
    try {
      const result = await startTikTokLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/tiktok/login/status", async (req, res) => {
    res.json(await getTikTokLoginSessionStatus());
  });

  app.post("/api/tiktok/login/close", async (req, res) => {
    try {
      const result = await closeTikTokLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Instagram endpoints (profile-aware)

  app.get("/api/instagram/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.instagram.getStatus();
    res.json(status);
  });

  app.post("/api/instagram/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.instagram.start();
    res.json(result);
  });

  app.post("/api/instagram/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.instagram.stop();
    res.json(result);
  });

  app.post("/api/instagram/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.instagram.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/instagram/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instagram/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/instagram/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.instagram.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Login endpoints (Instagram)

  app.post("/api/instagram/login", async (req, res) => {
    try {
      const result = await startInstagramLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/instagram/login/status", async (req, res) => {
    res.json(await getInstagramLoginSessionStatus());
  });

  app.post("/api/instagram/login/close", async (req, res) => {
    try {
      const result = await closeInstagramLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // YouTube endpoints (profile-aware)

  app.get("/api/youtube/status", async (req, res) => {
    const daemons = await getActiveDaemons();
    const status = await daemons.youtube.getStatus();
    res.json(status);
  });

  app.post("/api/youtube/start", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.youtube.start();
    res.json(result);
  });

  app.post("/api/youtube/stop", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = daemons.youtube.stop();
    res.json(result);
  });

  app.post("/api/youtube/run-once", async (req, res) => {
    const daemons = await getActiveDaemons();
    const result = await daemons.youtube.runOnce("dashboard");
    res.json(result);
  });

  app.post("/api/youtube/schedule", async (req, res) => {
    try {
      const { expression } = req.body;
      if (!expression) {
        return res.status(400).json({ ok: false, error: "Missing expression" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setSchedule(expression);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/youtube/schedule-plan", async (req, res) => {
    try {
      const { type, times } = req.body || {};
      if (type !== "daily-times") {
        return res.status(400).json({ ok: false, error: "Unsupported schedule plan type." });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setDailyTimes(times);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/youtube/instant-post", async (req, res) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ ok: false, error: "Missing 'enabled' (boolean)" });
      }
      const daemons = await getActiveDaemons();
      const result = await daemons.youtube.setInstantPost(enabled);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Login endpoints (YouTube)

  app.post("/api/youtube/login", async (req, res) => {
    try {
      const result = await startYouTubeLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/youtube/login/status", async (req, res) => {
    res.json(await getYouTubeLoginSessionStatus());
  });

  app.post("/api/youtube/login/close", async (req, res) => {
    try {
      const result = await closeYouTubeLoginSession();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Overview endpoint (aggregates all profiles)

  app.get("/api/overview", async (req, res) => {
    try {
      const allStatus = await getAllStatus();
      res.json(allStatus);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // First-run setup and health endpoints

  app.get("/api/setup/health", async (req, res) => {
    try {
      res.json(await buildSetupHealth());
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/setup/open-folder", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const folderPath = getAllowedSetupFolderPath(req.body?.key, active.id);
      if (!folderPath) {
        return res.status(400).json({ ok: false, error: "Unsupported setup folder key." });
      }

      await fs.mkdir(folderPath, { recursive: true });
      await openFolder(folderPath);
      res.json({ ok: true, path: folderPath });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Uniquifier endpoints

  app.get("/api/uniquifier/status", async (req, res) => {
    const status = await uniquifier.getStatus();
    res.json(status);
  });

  app.post("/api/uniquifier/start", async (req, res) => {
    try {
      const { inputDir, outputDir, logoImage } = req.body || {};
      const result = await uniquifier.start({ inputDir, outputDir, logoImage });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/uniquifier/stop", (req, res) => {
    const result = uniquifier.stop();
    res.json(result);
  });

  app.post("/api/uniquifier/open-folder", async (req, res) => {
    try {
      const { kind, folderPath } = req.body || {};
      const status = await uniquifier.getStatus();
      const targetPath =
        folderPath ||
        (kind === "output" ? status.outputDir : kind === "input" ? status.inputDir : null);
      if (!targetPath) {
        return res.status(400).json({ ok: false, error: "Missing folder path or kind." });
      }
      await openFolder(targetPath);
      res.json({ ok: true, path: targetPath });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Auto-download endpoints
  app.get("/api/autodownload/status", (req, res) => {
    res.json(autoDownloader.getStatus());
  });

  app.post("/api/autodownload/start", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const result = await autoDownloader.start({ accountId: req.body?.accountId || active.id });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/autodownload/stop", (req, res) => {
    const result = autoDownloader.stop();
    res.json(result);
  });

  app.post("/api/autodownload/configure", async (req, res) => {
    try {
      const active = await getActiveAccount();
      const payload = { ...(req.body || {}) };
      if (!payload.accountId) {
        payload.accountId = active.id;
      }
      const result = await autoDownloader.configure(payload);
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  // Profile download endpoints
  app.get("/api/profile-download/status", (req, res) => {
    res.json(profileDownloader.getStatus());
  });

  app.post("/api/profile-download/start", async (req, res) => {
    try {
      const { channel, minViews, maxVideos, scanOnly } = req.body || {};
      const result = await profileDownloader.start({ channel, minViews, maxVideos, scanOnly });
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/profile-download/open-folder", async (req, res) => {
    try {
      const status = profileDownloader.getStatus();
      await openFolder(status.downloadsDir);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message });
  });

  ensureDashboardBindAllowed();
  app.listen(config.dashboardPort, config.dashboardHost, () => {
    console.log(
      `Dashboard running at http://${config.dashboardHost}:${config.dashboardPort}`
    );
  });
}

createServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
