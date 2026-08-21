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
} = require("./account-manager");
const { stopPersonaProfile } = require("./persona-browser");

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

  app.use(express.json());
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
