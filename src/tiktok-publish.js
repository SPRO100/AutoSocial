// First real single-video TikTok publish, driven from the Dashboard.
// Orchestration only - reuses the existing, already-production TikTok
// uploader (tiktok-uploader.js#uploadVideo, the same function the queue/
// daemon flow uses) and the existing session verifier
// (session-check.js#checkSessionUnlocked, which itself reuses
// importers/tiktok-verify.js#verifyTikTokSession - the one and only
// verifier in this codebase). No second uploader, no second verifier.
//
// Canonical mapping: every function here takes only an accountId - the
// Persona profile id is always resolved server-side, the same discipline
// as account-deletion.js.
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const accountManager = require("./account-manager");
const { checkSessionUnlocked } = require("./session-check");
const { uploadVideo } = require("./tiktok-uploader");
const accountLock = require("./account-lock");

function safeMessage(error) {
  return error && error.message ? error.message : String(error);
}

// Maps tiktok-uploader.js's own real confirmation reasons (see its
// waitForPublishConfirmation) to a safe, human-readable operational
// message - never the raw internal string, but never a fabricated generic
// either when a more specific one is known.
function classifyPublishError(rawMessage, externalActionStarted = false) {
  const message = String(rawMessage || "");
  if (/no reliable publish confirmation observed within timeout/i.test(message)) {
    return { status: "unconfirmed", reason: "Publish confirmation timed out." };
  }
  if (/displayed an error after publish click/i.test(message)) {
    return { status: "failed", reason: "TikTok rejected the publish." };
  }
  if (/publish (api call )?fail/i.test(message)) {
    return { status: "failed", reason: "TikTok rejected the publish." };
  }
  if (/set.*video file|video file input|could not.*video/i.test(message)) {
    return { status: "failed", reason: "Video upload failed." };
  }
  if (externalActionStarted) {
    return { status: "unconfirmed", reason: "The publish action started but its outcome could not be confirmed." };
  }
  return { status: "failed", reason: "Publish failed." };
}

// Preconditions only - read-only, never mutates anything, never attaches.
// Used both as the first gate in publish() below and as a way for the
// Dashboard to show "why publish is disabled" without actually running one.
async function checkPublishPreconditions(accountId) {
  const account = await accountManager.getAccountById(accountId);
  if (!account) {
    return { ok: false, error: "Account not found." };
  }
  if (account.importPlatform !== "tiktok") {
    return { ok: false, error: "This account is not a TikTok automation account." };
  }
  if (!account.personaProfileId) {
    return { ok: false, error: "This account has no linked Persona profile." };
  }
  return { ok: true, account };
}

// videoBuffer: raw bytes already on this server (see dashboard-server.js's
// upload route - never persisted longer than this call needs). caption:
// plain text. Returns a safe result; never throws.
async function publish(accountId, { videoBuffer, filename, caption } = {}) {
  // Same per-account lock session-check.js's checkSession() uses - a
  // concurrent "Check session" click (or a second publish) for this exact
  // account is rejected here rather than racing this call's own fresh
  // verification/upload against it. Held for this whole call (verification
  // AND upload), not just the verification step.
  if (!accountLock.tryLock(accountId)) {
    return { ok: false, error: "A publish for this account is already in progress." };
  }

  let tempVideoPath = null;
  try {
    const pre = await checkPublishPreconditions(accountId);
    if (!pre.ok) return pre;
    const { account } = pre;

    // Fresh, server-side verification immediately before publish - never
    // trust a cached/frontend-reported status. Uses the exact same core
    // logic as the Dashboard's own "Check session" button
    // (checkSessionUnlocked - this call already holds the account lock
    // checkSession() would otherwise try to acquire itself); its Persona
    // running/stopped-state preservation applies here too.
    const check = await checkSessionUnlocked(accountId);
    if (!check.ok) {
      return { ok: false, error: `Could not verify the TikTok session before publishing: ${check.error}` };
    }
    if (check.sessionStatus !== "ready") {
      return {
        ok: false,
        error: check.sessionStatus === "needs_login"
          ? "Session expired - update session required."
          : "Could not confirm the TikTok session is authenticated.",
        sessionStatus: check.sessionStatus,
      };
    }

    if (!videoBuffer || !videoBuffer.length) {
      return { ok: false, error: "No video file was provided." };
    }

    const startedAt = new Date().toISOString();
    const safeExt = /\.(mp4|mov|webm)$/i.test(filename || "") ? path.extname(filename) : ".mp4";
    tempVideoPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "autosocial-publish-")), `video${safeExt}`);
    await fs.writeFile(tempVideoPath, videoBuffer);

    let uploadResult;
    try {
      uploadResult = await uploadVideo({
        videoPath: tempVideoPath,
        caption: caption || "",
        accountId,
      });
    } catch (error) {
      uploadResult = { ok: false, error: safeMessage(error) };
    }

    const finishedAt = new Date().toISOString();

    if (uploadResult.ok) {
      await accountManager.setPublishStatus(accountId, { status: "published", at: finishedAt }).catch(() => {});
      return {
        ok: true,
        accountId,
        platform: "tiktok",
        finalStatus: "published",
        startedAt,
        finishedAt,
      };
    }

    const classified = classifyPublishError(uploadResult.error, uploadResult.externalActionStarted);
    await accountManager.setPublishStatus(accountId, {
      status: classified.status,
      reason: classified.reason,
      at: finishedAt,
    }).catch(() => {});

    return {
      ok: true, // the publish ATTEMPT completed and was safely classified - not an API/precondition failure
      accountId,
      platform: "tiktok",
      finalStatus: classified.status,
      reason: classified.reason,
      startedAt,
      finishedAt,
    };
  } finally {
    accountLock.unlock(accountId);
    if (tempVideoPath) {
      await fs.rm(path.dirname(tempVideoPath), { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { publish, checkPublishPreconditions };
