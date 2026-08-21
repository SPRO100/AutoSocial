const { chromium } = require("playwright");
const { config } = require("./config");

// ---------------------------------------------------------------------------
// Persona Studio browser adapter.
//
// Persona is the single owner of browser identity/session for any account
// mapped to a Persona profile: it launches and persists the real Chromium
// process and its user-data-dir; AutoSocial only ever CONNECTS to it over
// CDP and drives it with Playwright. AutoSocial must never treat a Persona-
// owned browser as something it launched itself.
//
// Three distinct lifecycle operations, on purpose (see the brief this
// module implements):
//  - attach     -> ask Persona to open/adopt the profile, connect Playwright.
//  - disconnect -> release AutoSocial's Playwright client only. Persona and
//                   its browser process keep running untouched.
//  - stop       -> ask Persona to actually terminate the profile's browser
//                   process (POST /stop). Only ever called when the caller
//                   genuinely means "shut this profile down", never as part
//                   of normal upload/login-check completion.
// ---------------------------------------------------------------------------

class PersonaApiError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = "PersonaApiError";
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function personaApiBaseUrl() {
  return config.personaApiUrl;
}

async function personaRequest(path, options = {}) {
  const url = `${personaApiBaseUrl()}${path}`;
  const controller = new AbortController();
  // Persona's own /attach handler waits up to ~20s for DevTools to come up
  // before answering - this timeout must stay comfortably above that, or a
  // slow-but-legitimate attach would be reported as a false failure.
  const timeoutMs = config.personaAttachTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      signal: controller.signal,
      ...options,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new PersonaApiError(
        `Persona API timed out after ${timeoutMs}ms calling ${path}. ` +
        `Is persona-api.service healthy?`,
        { cause: error }
      );
    }
    throw new PersonaApiError(
      `Could not reach Persona API at ${personaApiBaseUrl()} (${error.code || error.message}). ` +
      `Is persona-api.service running?`,
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    let detail = text || response.statusText;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail || parsed.message || detail;
    } catch {
      // Not JSON - use the raw text as-is.
    }
    if (response.status === 404) {
      throw new PersonaApiError(`Persona profile not found: ${detail}`, { status: 404 });
    }
    if (response.status === 409) {
      throw new PersonaApiError(
        `Persona profile is busy: ${detail} ` +
        `(it may be running outside of attach - stop it in Persona Studio first).`,
        { status: 409 }
      );
    }
    throw new PersonaApiError(`Persona API ${response.status}: ${detail}`, { status: response.status });
  }

  return text ? JSON.parse(text) : {};
}

// Real per-profile checkout guard (this Node process only, not a
// cross-process lock). Two independent AutoSocial call sites (e.g. a
// dashboard-driven login session left open, and a daemon-triggered upload
// firing at the same time) attaching the SAME Persona profile concurrently
// would each get their own connectOverCDP() connection and independently
// grab context.pages()[0] - two Playwright clients silently driving the
// same real browser tab at once. Legacy launchPersistentContext() already
// fails loudly in this situation (Chromium's own ProcessSingleton lock
// rejects the second launch); this guard gives Persona-backed sessions the
// same fail-loudly-not-silently-share behavior instead of a new, worse
// failure mode unique to Persona sharing. Reserved synchronously (before
// any await) so two near-simultaneous calls can never both pass the check.
const checkedOutProfiles = new Set();

// Persona's own /attach handler is idempotent once a profile is actually
// attached (see server.py's attach_profile) - but the FIRST attach still
// has a real window before that's true: two concurrent HTTP requests for a
// profile that isn't running yet can both pass its is_running() check and
// each spawn their own subprocess for the same user-data-dir. The checkout
// guard above already prevents this (it reserves synchronously before the
// first await), but this in-flight-request memoization is kept as a second,
// independent layer in case a future caller ever reaches attachRequest()
// without going through the guard.
const inFlightAttachRequests = new Map();

function attachRequest(profileId, headless) {
  if (inFlightAttachRequests.has(profileId)) {
    return inFlightAttachRequests.get(profileId);
  }
  const promise = personaRequest(
    `/api/profiles/${encodeURIComponent(profileId)}/attach`,
    {
      method: "POST",
      body: JSON.stringify({ headless }),
    }
  ).finally(() => {
    inFlightAttachRequests.delete(profileId);
  });
  inFlightAttachRequests.set(profileId, promise);
  return promise;
}

/**
 * Attaches (or reuses an already-attached) Persona profile and connects
 * Playwright to it over CDP. Returns the profile's existing persistent
 * context - never creates a new one - so real cookies/storage are
 * preserved exactly as Persona has them.
 */
async function attachPersonaProfile(profileId, { headless = true } = {}) {
  if (!profileId) {
    throw new Error("Persona profileId is required.");
  }
  if (checkedOutProfiles.has(profileId)) {
    throw new PersonaApiError(
      `Persona profile ${profileId} is already in use by another operation in this ` +
      `AutoSocial process (e.g. an open login session, or a concurrent upload). ` +
      `Finish or close that operation first.`
    );
  }
  // Reserved synchronously, before the first await - see the guard's own
  // comment above for why this makes the check-then-reserve race-free.
  checkedOutProfiles.add(profileId);

  try {
    const info = await attachRequest(profileId, headless);

    if (!info.port) {
      throw new PersonaApiError(
        `Persona did not return a CDP port for profile ${profileId}.`
      );
    }

    let browser;
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${info.port}`);
    } catch (error) {
      // Persona genuinely attached (the HTTP call above succeeded) but
      // Playwright couldn't connect - the profile would otherwise be left
      // stuck "attached" from Persona's point of view (its own /attach is
      // idempotent-while-running, so every retry would get back this same
      // bad port forever). Stop it so the next attempt starts clean.
      await stopPersonaProfile(profileId).catch(() => {});
      throw new PersonaApiError(
        `Persona attached profile ${profileId} on port ${info.port}, but Playwright ` +
        `could not connect over CDP: ${error.message}. The profile has been stopped ` +
        `so the next attempt can start clean.`,
        { cause: error }
      );
    }

    const context = browser.contexts()[0];
    if (!context) {
      // Disconnect only - Persona still owns whatever it launched. See
      // disconnectPersonaBrowser() for why .close() is safe here.
      await browser.close().catch(() => {});
      throw new PersonaApiError(
        `Persona browser for profile ${profileId} has no persistent context.`
      );
    }

    const page = context.pages()[0] || (await context.newPage());

    return {
      profileId,
      browser,
      context,
      page,
      info,
    };
  } catch (error) {
    // Attach failed end to end - release the checkout so a later real
    // attempt isn't wrongly told the profile is "in use".
    checkedOutProfiles.delete(profileId);
    throw error;
  }
}

/**
 * Disconnects AutoSocial's Playwright client from a Persona-backed session
 * WITHOUT touching Persona's ownership of the underlying browser process.
 *
 * Verified against the installed playwright-core (1.58.2) source: for a
 * Browser obtained via chromium.connectOverCDP(), Browser.close() resolves
 * to closing the local WebSocket transport only (see
 * lib/server/chromium.js's `browserProcess = { close: doClose, kill: doClose }`,
 * where doClose just calls chromeTransport.closeAndWait() - no CDP
 * `Browser.close` command is ever sent to the real browser). This differs
 * from a browser Playwright itself LAUNCHED, where close() really does shut
 * the process down. Re-verify this if playwright-core is ever upgraded.
 *
 * Deliberately does NOT call context.close() - closing the adopted
 * persistent context IS a real, destructive command against Persona's own
 * browser tabs, unlike browser.close() here.
 */
async function disconnectPersonaBrowser(session) {
  if (!session || !session.browser) return;
  try {
    await session.browser.close().catch(() => {});
  } finally {
    if (session.profileId) checkedOutProfiles.delete(session.profileId);
  }
}

/**
 * Dashboard-facing "Start" action - attaches the profile (so Persona's
 * real browser is genuinely up, exactly as if an upload/login-session had
 * started one) then immediately disconnects AutoSocial's own Playwright
 * client, releasing the checkout so a real upload/login-session can still
 * use the profile afterward. Persona keeps the browser running - this
 * never holds a live connection open on the dashboard's behalf. Composed
 * entirely from the same attach/disconnect primitives every other caller
 * uses, never a second attach implementation.
 */
async function startPersonaBrowser(profileId, { headless = true } = {}) {
  const session = await attachPersonaProfile(profileId, { headless });
  await disconnectPersonaBrowser(session);
  return { profileId, port: session.info.port };
}

/**
 * Explicit, intentional shutdown of a Persona profile's browser process.
 * Only call this when the caller genuinely means to stop the profile
 * (e.g. an operator-triggered "stop" action) - never as part of routine
 * disconnect after a normal upload/login-check completes.
 */
async function stopPersonaProfile(profileId) {
  if (!profileId) return;
  return personaRequest(
    `/api/profiles/${encodeURIComponent(profileId)}/stop`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  );
}

/**
 * Creates a brand-new Persona profile via the real Persona API
 * (POST /api/profiles) and returns it, stripped to the same safe fields as
 * every other read in this module (see toSafeProfileSummary below).
 *
 * Persona mints the profile id server-side when none is supplied (confirmed
 * against server.py's batch_create, which explicitly pops any incoming
 * "id" with the comment "always mint a server-side id" - the single-create
 * route relies on the same dash.save() behavior) - callers must never
 * invent their own id.
 */
async function createPersonaProfile({ name, tags } = {}) {
  const body = {};
  if (name) body.name = name;
  if (Array.isArray(tags)) body.tags = tags;
  const created = await personaRequest("/api/profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!created || !created.id) {
    throw new PersonaApiError("Persona did not return an id for the new profile.");
  }
  return toSafeProfileSummary(created);
}

/**
 * Imports cookies into a Persona profile via the real Persona API
 * (POST /api/profiles/{pid}/cookies). Persona's own importer (see
 * engine/persona/cookies.py, read in full while designing this) accepts
 * EITHER a raw text blob (Playwright storage-state JSON, browser-extension
 * export JSON, or Netscape cookies.txt - it detects the format itself) or a
 * `cookies` array of raw cookie objects - both are normalized identically
 * on Persona's side, so this function is a thin, format-agnostic pass
 * through and must stay that way.
 *
 * Requires the profile to NOT be running (Persona's own /cookies handler
 * 409s otherwise) - callers must import cookies before ever attaching.
 *
 * Never logs `text`/`cookies` - both may contain live session secrets.
 */
async function importPersonaCookies(profileId, { text, cookies, clear = false } = {}) {
  if (!profileId) {
    throw new Error("Persona profileId is required.");
  }
  const body = { clear };
  if (typeof text === "string" && text) {
    body.text = text;
  } else if (Array.isArray(cookies)) {
    body.cookies = cookies;
  } else {
    throw new Error("importPersonaCookies requires text or a cookies array.");
  }
  return personaRequest(`/api/profiles/${encodeURIComponent(profileId)}/cookies`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Permanently deletes a Persona profile (DELETE /api/profiles/{pid}) -
 * Persona's own real rollback primitive (stops it first if running, then
 * removes both the engine-side profile dir and the dashboard record). Used
 * by the import pipeline to clean up an orphaned profile when a later
 * pipeline step fails after the profile was already created - never used
 * on a profile that might already be in real use.
 */
async function deletePersonaProfile(profileId) {
  if (!profileId) return;
  try {
    await personaRequest(`/api/profiles/${encodeURIComponent(profileId)}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (error instanceof PersonaApiError && error.status === 404) return;
    throw error;
  }
}

/**
 * Strips a real Persona profile record down to the fields that are ever
 * safe to leave this module - id/name/status/tags. Persona's real record
 * can carry a `proxy: {..., user, pass, ...}` block (confirmed against
 * persona-studio's server.py - _proxy_to_dash() puts the real proxy
 * password in plaintext right on the profile object Persona's own
 * /api/profiles returns) plus other engine-internal fields no caller here
 * has ever needed. Every real caller of listPersonaProfiles() (dashboard
 * routes, personaProfileExists) only ever needs these four - projecting
 * here, once, at the single point Persona's raw data enters this
 * process, means no future caller can accidentally forward a credential
 * just by trusting "the list" was already safe.
 */
function toSafeProfileSummary(profile) {
  return {
    id: profile.id,
    name: profile.name ?? null,
    status: profile.status ?? "unknown",
    tags: Array.isArray(profile.tags) ? profile.tags : [],
  };
}

/**
 * Real, current list of every Persona profile - id/name/status/tags only
 * (see toSafeProfileSummary; Persona's real record can carry plaintext
 * proxy credentials, which never leave this function). Includes each
 * profile's real running/stopped status, computed by Persona. The one
 * real fetch every other read in this module is built from - never a
 * second, independently-maintained copy. Throws PersonaApiError if
 * Persona API cannot be reached; callers decide how to degrade (see
 * dashboard-server.js's /api/persona/overview and account-manager.js's
 * hasSavedPlatformSession, which each pick their own fail-open/honest-
 * unknown policy for their own use case).
 */
async function listPersonaProfiles() {
  const profiles = await personaRequest("/api/profiles");
  return Array.isArray(profiles) ? profiles.map(toSafeProfileSummary) : [];
}

/**
 * Read-only existence check against Persona's real profile list - used as
 * the source of truth for "does this account have a real Persona
 * session/identity", instead of AutoSocial's own (irrelevant, for a
 * Persona-backed account) .profiles Cookies DB. Throws PersonaApiError if
 * Persona API cannot be reached at all; callers decide how to treat that
 * (see account-manager.js#hasSavedPlatformSession's fail-open policy).
 */
async function personaProfileExists(profileId) {
  if (!profileId) return false;
  const profiles = await listPersonaProfiles();
  return profiles.some((p) => p.id === profileId);
}

module.exports = {
  PersonaApiError,
  attachPersonaProfile,
  disconnectPersonaBrowser,
  startPersonaBrowser,
  stopPersonaProfile,
  listPersonaProfiles,
  personaProfileExists,
  createPersonaProfile,
  importPersonaCookies,
  deletePersonaProfile,
};
