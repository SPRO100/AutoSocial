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
//
// Second real incident (2026-08-27, bruna118564): Instagram navigated to a
// real, fully-rendered /accounts/suspended/ page - genuine account-level
// enforcement, not a login/signup/checkpoint gate. No GATE below recognized
// it, so the OLD "no known problem => active:true" fallthrough reported
// READY. This is the same class of mistake as the 2026-08-26 incident
// (default-open on the unknown case), just on the OTHER end of the
// function - the fix there was adding a gate; the fix here (see
// hasPositiveAuthenticatedEvidence below) is architectural: reaching the
// bottom of this function with NO matched gate no longer means READY by
// default. It only means READY when at least one independent, already-
// established positive signal (the authenticated <nav> shell, or the
// caller's own username found among the page's internal links) is present.
// Neither signal is trusted alone (a markup change removing <nav> must
// never alone produce a false needs_login) - they are OR'd together
// specifically so no single selector is a point of failure in either
// direction. Absence of BOTH means UNKNOWN (see STATES), never READY and
// never a guessed failure state either - a distinct, honest "could not
// prove this" outcome, fail-closed for publishing exactly like every other
// non-READY state.

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
  // Real production finding (2026-08-27, bruna118564): a genuine Instagram
  // account-enforcement page (/accounts/suspended/), distinct from every
  // gate above - never a login/consent/security-challenge screen, never
  // resolvable by any automated action, never READY. Terminal, not in
  // instagram-recovery.js's SAFE_RECOVERABLE_STATES, and deliberately not
  // folded into SECURITY_CHALLENGE (which implies a resolvable-by-the-user
  // checkpoint) - an operator needs to know "this account was suspended by
  // Instagram", not "this needs a checkpoint answered".
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  // Real production finding (2026-08-27, Account Operations milestone,
  // 2 real accounts): Instagram's own interactive "Confirm you're human to
  // use your account" checkpoint renders at the SAME /accounts/suspended/
  // URL as a genuine ACCOUNT_SUSPENDED enforcement page - text is what
  // actually disambiguates them (see the human_verification GATE below,
  // matched on text BEFORE the URL-only account_suspended fallback). This
  // is a solvable interactive checkpoint ("Continue", "Takes about 30
  // seconds"), not a terminal enforcement action - reporting it as
  // ACCOUNT_SUSPENDED would wrongly steer an otherwise-recoverable account
  // toward permanent archive/delete. Never auto-resolved (see
  // ../importers/instagram-recovery.js's SAFE_RECOVERABLE_STATES, which
  // does not include this state) - the checkpoint itself may require a
  // real device/CAPTCHA verification this codebase must never attempt to
  // bypass.
  HUMAN_VERIFICATION_REQUIRED: "HUMAN_VERIFICATION_REQUIRED",
  // The fail-closed outcome for "reached instagram.com, matched no known
  // gate, and found no positive authenticated evidence either" - see
  // hasPositiveAuthenticatedEvidence below - and for a navigation/runtime
  // exception where we never even reached a page to classify. Neither case
  // is evidence of a login requirement specifically (that would be
  // overclaiming what we actually observed), so both report UNKNOWN, not
  // LOGIN_REQUIRED. Never in SAFE_RECOVERABLE_STATES, never auto-retried -
  // requires a human to actually look at the account.
  UNKNOWN: "UNKNOWN",
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
  // Real observed flow (2026-08-27, bruna118564): a genuine, fully-rendered
  // https://www.instagram.com/accounts/suspended/?next=... page - not a
  // navigation error, not a login/consent gate. URL-matched only (this
  // module has never captured this page's body text from a real run - no
  // text pattern is added here without that evidence; see this module's own
  // header comment on not inventing unconfirmed signatures). Never
  // recoverable - see instagram-recovery.js's SAFE_RECOVERABLE_STATES.
  // Text-matched only (never a URL match - see this gate's own STATES
  // comment) so it is checked, and wins, BEFORE the URL-only
  // account_suspended fallback immediately below whenever this specific
  // interactive-checkpoint text is present at that same URL. A genuine
  // suspension page with different body text still falls through to
  // account_suspended unchanged.
  {
    name: "human_verification",
    state: STATES.HUMAN_VERIFICATION_REQUIRED,
    code: "instagram_human_verification_required",
    reason: "Instagram is requiring interactive human verification ('Confirm you're human') before this account can be used - a solvable checkpoint, not a confirmed suspension",
    url: /(?!)/,
    text: /confirm you.?re human/i,
  },
  {
    name: "account_suspended",
    state: STATES.ACCOUNT_SUSPENDED,
    code: "instagram_account_suspended",
    reason: "Instagram has suspended this account (enforcement action) - this is not a session/login problem",
    url: /\/accounts\/suspended\//i,
    text: null,
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
      // Leaving instagram.com entirely is not evidence of specifically a
      // login requirement - it could be a proxy/DNS oddity, a third-party
      // interstitial, anything. UNKNOWN is the honest, fail-closed report;
      // never overclaim LOGIN_REQUIRED for something this module never
      // actually saw a login page for.
      return { active: false, state: STATES.UNKNOWN, reason: `did not remain on instagram.com (${safeHostname(url)})`, url };
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

    // POSITIVE evidence signal #1: Instagram's logged-in home renders a real
    // <nav> landmark; its logged-out landing page does not. Never trusted
    // ALONE (a markup change removing it must never alone flip a genuinely
    // fine account to non-ready) - see hasPositiveAuthenticatedEvidence
    // below, which OR's this with signal #2.
    let hasAuthenticatedShell = false;
    try {
      hasAuthenticatedShell = (await page.locator("nav").count()) > 0;
    } catch {
      // Diagnostic only.
    }

    // Identity binding + POSITIVE evidence signal #2, when the caller
    // supplies the imported username (both real call sites always do - see
    // instagram-uploader.js and session-check.js/pipeline.js). A MISMATCH
    // still fails closed immediately as before (never a different account
    // mistaken for this one). A CONFIRMED match (the expected handle found
    // among the page's own internal links) is now also independent positive
    // evidence this session is authenticated as that specific user - not
    // just a negative override. Diagnostic-only on any DOM-inspection
    // failure or when no profile links are observable at all (never blocks
    // an otherwise-clean result, never fabricates a match).
    let identityConfirmed = false;
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
        if (handles.length && handles.includes(expected)) identityConfirmed = true;
      } catch {
        // Diagnostic only - navigation/gate result remains the source of truth.
      }
    }

    // PRIMARY GOAL of this hardening (2026-08-27, real bruna118564 incident):
    // reaching here means no known gate matched - that is NOT, by itself,
    // evidence of an authenticated session (an unrecognized enforcement/
    // interstitial page also matches no gate). READY now requires AT LEAST
    // ONE positive, independent signal. Neither signal is a single brittle
    // selector on its own - they are OR'd specifically so one drifting
    // (e.g. a future Instagram markup change removing <nav>) does not by
    // itself produce a false negative, while requiring at least one keeps
    // "we saw nothing wrong" from ever being treated as "we confirmed it's
    // fine" (see this module's own header comment: a false READY is a real
    // external-publish mistake; a false non-READY only costs a re-check).
    const hasPositiveAuthenticatedEvidence = hasAuthenticatedShell || identityConfirmed;
    if (!hasPositiveAuthenticatedEvidence) {
      return {
        active: false,
        state: STATES.UNKNOWN,
        url,
        reason: "reached Instagram with no recognized gate and no positive authenticated-session evidence - failing closed",
      };
    }

    return {
      active: true,
      state: STATES.READY,
      url,
      reason: identityConfirmed
        ? "reached Instagram's authenticated app shell with a confirmed identity match and no login/signup/checkpoint gate"
        : "reached Instagram's authenticated app shell with no login/signup/checkpoint gate",
    };
  } catch (error) {
    // An unexpected navigation/runtime error here (e.g. ERR_TOO_MANY_
    // REDIRECTS) means we never even reached a page to classify - that is
    // NOT evidence of specifically a login requirement (real incident,
    // 2026-08-27, brenda9875428: this used to be folded into LOGIN_REQUIRED
    // unconditionally, overclaiming a login page was seen when it wasn't).
    // UNKNOWN is the honest, fail-closed report; every existing caller
    // already treats any non-READY, non-CHALLENGE_REQUIRED state as
    // "not publish-ready, operator should look" (see session-check.js's
    // safeVerifyReason - the "verification failed:" prefix is preserved so
    // that rewrite still applies). FAILED is reserved for the recovery
    // pipeline's OWN infrastructure failures (e.g. a recovery action itself
    // erroring), never assigned by this module.
    return { active: false, state: STATES.UNKNOWN, reason: `verification failed: ${error.message}` };
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
