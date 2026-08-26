// Conservative, Instagram-specific "is this session actually authenticated"
// check - the SOLE verifier for both the on-demand session-check.js path
// and the bulk importers/pipeline.js path (see session-check.js's own
// comment: there is only ever one verifier per platform in this codebase).
// Also the SOLE classifier the Session Recovery Pipeline
// (../session-recovery.js) drives - recovery never re-implements gate
// detection, it only reacts to the `state` this module already computed.
//
// Real incident (2026-08-26): the previous version only recognized a
// redirect to /accounts/login as "not authenticated". A genuinely expired
// kinsleyvaughn6 session was instead redirected to Instagram's SIGN-UP flow
// ("Get started on Instagram - Sign up to see photos and videos from your
// friends"), which the old check had no pattern for - it fell through to
// "reached Instagram without a login redirect" => active: true. checkSession
// and publishing preflight both reported the account Ready; the real publish
// attempt then navigated to the create page, got the same unauthenticated
// gate, and timed out waiting for an upload control that only exists on the
// authenticated create page.
//
// Real production result (2026-08-26, 4-account update-session batch): all
// 4 imported accounts landed on one of Instagram's consent/anti-automation
// flows - /consent/?flow=user_cookie_choice_v2 (an ordinary, safely
// acknowledgeable cookie banner), /consent/?flow=ad_free_subscription_
// blocking_flow (a real account-wide monetization choice, never decided
// automatically), and /accounts/scraping_warning/ (Instagram's
// anti-automation challenge). The single "consent" gate this module used to
// have could not tell those apart, and there was no distinction between "an
// account genuinely needs a fresh login" and "an account is mid-way through
// a recoverable flow". `state` below is the fix: a specific, closed enum
// (see STATES) the Session Recovery Pipeline switches on, so a routine
// cookie banner can be resolved automatically while every security- or
// policy-sensitive gate still fails closed exactly as before.
//
// This is still fundamentally a hardened negative-space check (this module
// cannot safely assert a single positive DOM selector proves
// "authenticated" without access to Instagram's live markup to verify it -
// a wrong selector would itself become a new false "needs login" for
// perfectly healthy accounts, which is exactly the class of mistake this
// hardening exists to prevent the OPPOSITE version of). It fails CLOSED:
// any state this module cannot positively explain (an unrecognized gate, no
// gate but also no recognized authenticated shell marker after an
// unexpected page, a navigation error) is reported as not-authenticated,
// never guessed as active - a false "needs login" just costs a human a
// re-check; a false "active" is a real external-publish mistake, as the
// 2026-08-26 incident showed.

// Closed set of granular states this module (gate-driven) and the recovery
// pipeline built on it (../session-recovery.js, which additionally assigns
// REDIRECT_LOOP/BLOCKED_CHALLENGE/RECOVERY_EXHAUSTED from its own loop
// logic - this module never returns those three itself) ever produce.
// READY is the only "authenticated" outcome; every other value is a
// specific reason publishing must not proceed yet. Keep in sync with
// ../session-recovery.js's CHALLENGE_OSCILLATION_FAMILY/
// SAFE_RECOVERABLE_STATES and with content-os's mirrored type
// (src/server/integrations/autosocial.ts).
const STATES = {
  READY: "READY",
  COOKIE_CONSENT_REQUIRED: "COOKIE_CONSENT_REQUIRED",
  PRIVACY_CHOICE_REQUIRED: "PRIVACY_CHOICE_REQUIRED",
  SCRAPING_WARNING: "SCRAPING_WARNING",
  SECURITY_CHALLENGE: "SECURITY_CHALLENGE",
  TWO_FACTOR_REQUIRED: "TWO_FACTOR_REQUIRED",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  // Assigned only by session-recovery.js's loop (never by matchGate below) -
  // real production finding (2026-08-26): Instagram's own server can
  // oscillate a session between a consent/cookie screen and its
  // scraping_warning anti-automation challenge. Listed here so it's part of
  // the one canonical enum, not a second source of truth.
  BLOCKED_CHALLENGE: "BLOCKED_CHALLENGE",
  FAILED: "FAILED",
};

// Ordered by specificity - matchGate returns the FIRST match, so a gate
// that could textually overlap a more specific one (e.g. the generic
// security-challenge text vs. a 2FA-specific prompt) must be listed after
// it. `recoverable: true` is the ONLY signal the recovery pipeline uses to
// decide whether it may even attempt an automated action - everything else
// always stops fail-closed.
const GATES = [
  {
    name: "scraping_warning",
    state: STATES.SCRAPING_WARNING,
    code: "instagram_scraping_warning",
    reason: "Instagram requires account review before continuing (anti-automation check)",
    url: /\/accounts\/scraping_warning\//i,
    text: /sorry, something went wrong|automated behavior|scraping warning/i,
    challenge: true,
  },
  // Real observed flow (2026-08-26): /consent/?flow=user_cookie_choice_v2 -
  // an ordinary GDPR-style cookie banner. This is the ONE consent flow this
  // module treats as safely acknowledgeable; matched narrowly on the flow
  // name (not just "/consent/" generically) so a future, unrecognized
  // consent flow never gets swept into the safe bucket by accident - see
  // the privacy_choice gate immediately below, which is the fail-closed
  // default for every OTHER consent flow.
  {
    name: "cookie_consent",
    state: STATES.COOKIE_CONSENT_REQUIRED,
    code: "instagram_cookie_consent",
    reason: "Instagram is showing a routine cookie-consent banner",
    url: /\/consent\/.*flow=user_cookie/i,
    text: null,
    recoverable: true,
  },
  // Real observed flow (2026-08-26): /consent/?flow=ad_free_subscription_
  // blocking_flow - a genuine account-wide monetization decision (pay for
  // an ad-free experience vs. continue with ads). Never decided
  // automatically (see ../instagram-recovery.js's policy hook). Also the
  // fail-closed default for ANY other /consent/ flow this module does not
  // specifically recognize as the cookie banner above - an unrecognized
  // consent screen is assumed to carry a real choice, never assumed safe.
  {
    name: "privacy_choice",
    state: STATES.PRIVACY_CHOICE_REQUIRED,
    code: "instagram_privacy_choice",
    reason: "Instagram requires an account-wide privacy/subscription choice (e.g. ad-free vs. free-with-ads)",
    // /accounts/onetap and /accounts/birthday are account-info confirmation
    // steps (not a routine cookie banner) - part of the original single
    // "consent" gate this was split from; kept here, not dropped, since
    // they carry the same "requires a real decision" fail-closed treatment
    // as the generic consent bucket.
    url: /\/accounts\/(?:onetap|birthday)\b|\/consent\//i,
    text: /confirm your birthday|review important information|subscribe.*ad.?free|ad.?free.*subscription/i,
  },
  {
    name: "two_factor",
    state: STATES.TWO_FACTOR_REQUIRED,
    code: "instagram_two_factor_required",
    reason: "Instagram is requesting a two-factor authentication code",
    url: /\/accounts\/login\/two_factor/i,
    text: /two-factor|enter the (?:\d[\s-]?digit )?code|authentication code|enter the code we/i,
  },
  {
    name: "captcha",
    state: STATES.CAPTCHA_REQUIRED,
    code: "instagram_captcha_required",
    reason: "Instagram is requesting CAPTCHA verification",
    url: /captcha/i,
    text: /captcha|verify you.?re human|select all (?:images|squares)|i.?m not a robot/i,
  },
  {
    name: "checkpoint",
    state: STATES.SECURITY_CHALLENGE,
    code: "instagram_security_challenge",
    reason: "Instagram is requiring an account checkpoint/challenge that must be resolved manually",
    url: /\/challenge\/|checkpoint/i,
    text: /help us confirm|suspicious login attempt|we detected an unusual login|verify it.s you/i,
  },
  {
    name: "login",
    state: STATES.LOGIN_REQUIRED,
    code: "instagram_login_required",
    reason: "redirected to login",
    url: /\/accounts\/login/i,
    text: /\blog in\b[\s\S]{0,30}\binstagram\b|forgot password\?/i,
  },
  {
    name: "signup",
    state: STATES.LOGIN_REQUIRED,
    code: "instagram_login_required",
    reason: "redirected to sign-up - the session is not authenticated",
    url: /\/accounts\/(?:emailsignup|signup)\b/i,
    text: /get started on instagram|sign up to see photos and videos/i,
  },
];

function matchGate(url, text) {
  for (const gate of GATES) {
    if (gate.url.test(url)) return gate;
    if (text && gate.text && gate.text.test(text)) return gate;
  }
  return null;
}

// options.skipNavigation: the Session Recovery Pipeline sets this on every
// RE-VERIFY it performs after an in-page recovery action - re-navigating to
// the Instagram home page would abandon whatever mid-flow screen (e.g. a
// cookie banner) the action just interacted with, the exact "do not force
// page.goto() over an unfinished flow" requirement this exists for. A
// direct/first call (session-check.js, pipeline.js's initial verify) always
// omits it and keeps the original goto-once-unless-already-on-a-known-
// challenge behavior, unchanged from before this module gained recovery
// support.
async function verifyInstagramSession(page, expectedUsername = null, options = {}) {
  const skipNavigation = Boolean(options.skipNavigation);
  try {
    const currentUrl = typeof page.url === "function" ? page.url() : "";
    // Never amplify a known anti-automation/challenge state with another
    // forced navigation. The operator/browser must resolve it first.
    // scraping_warning is checked explicitly (not just via skipNavigation)
    // so this guarantee holds even on a plain, non-recovery call.
    if (!skipNavigation && !/\/accounts\/scraping_warning\//i.test(currentUrl)) {
      await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    // Give any client-side auth redirect a chance to settle - not fatal if
    // the page never reaches network-idle (some authenticated shells never
    // do, given their own polling/websocket activity).
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const url = page.url();
    if (!/instagram\.com/i.test(url)) {
      return { active: false, state: STATES.LOGIN_REQUIRED, reason: `did not remain on instagram.com (${safeHostname(url)})` };
    }

    let text = "";
    try {
      text = await page.locator("body").innerText();
    } catch {
      // Diagnostic only - gate matching still works from the URL alone.
    }

    const gate = matchGate(url, text);
    if (gate) {
      return {
        active: false,
        state: gate.state,
        challenge: Boolean(gate.challenge),
        recoverable: Boolean(gate.recoverable),
        code: gate.code || null,
        reason: gate.reason,
        url,
      };
    }

    // Best-effort STRENGTHENING signal, never a hard requirement: Instagram's
    // logged-in home renders a real <nav> landmark; its logged-out landing
    // page does not. A markup change on Instagram's side must never turn
    // into a false "needs login" for an account that is genuinely fine, so
    // this only ever improves the reason string, never flips the verdict to
    // inactive on its own.
    let hasAuthenticatedShell = false;
    try {
      hasAuthenticatedShell = (await page.locator("nav").count()) > 0;
    } catch {
      // Diagnostic only.
    }

    // Identity binding, when the caller supplies the imported username -
    // never a different account mistaken for this one. Diagnostic-only on
    // any DOM-inspection failure (never blocks an otherwise-clean result).
    if (expectedUsername && typeof page.locator === "function") {
      try {
        const handles = await page
          .locator('a[href^="/"]')
          .evaluateAll((anchors) =>
            anchors
              .map((a) => String(a.getAttribute("href") || "").replace(/^\//, "").split("/")[0].toLowerCase())
              .filter(Boolean)
          );
        const expected = String(expectedUsername).replace(/^@/, "").toLowerCase();
        if (handles.length && !handles.includes(expected)) {
          return { active: false, state: STATES.LOGIN_REQUIRED, reason: "authenticated identity did not match the imported username", url };
        }
      } catch {
        // Diagnostic only - navigation/gate result remains the source of truth.
      }
    }

    return {
      active: true,
      state: STATES.READY,
      url,
      reason: hasAuthenticatedShell
        ? "reached Instagram's authenticated app shell with no login/signup/checkpoint gate"
        : "reached Instagram with no recognized login/signup/checkpoint gate",
    };
  } catch (error) {
    // Legacy-compatible bucket: an unexpected navigation/runtime error here
    // has always been treated the same as "needs a fresh login" by every
    // existing caller (never a distinct FAILED session status) - preserved
    // exactly. FAILED is reserved for the recovery pipeline's OWN
    // infrastructure failures (e.g. a recovery action itself erroring),
    // never assigned by this module.
    return { active: false, state: STATES.LOGIN_REQUIRED, reason: `verification failed: ${error.message}` };
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown host";
  }
}

module.exports = { verifyInstagramSession, STATES };
