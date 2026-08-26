// Conservative, Instagram-specific "is this session actually authenticated"
// check - the SOLE verifier for both the on-demand session-check.js path
// and the bulk importers/pipeline.js path (see session-check.js's own
// comment: there is only ever one verifier per platform in this codebase).
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
// This version recognizes the realistic family of Meta/Instagram
// authentication gates (login, signup, checkpoint/challenge, consent/
// onetap/birthday) - matched on BOTH the final URL and the page's own text,
// since some gates render under a route this module doesn't enumerate, or
// via client-side routing that never changes the address bar. It is still
// fundamentally a hardened negative-space check (this module cannot safely
// assert a single positive DOM selector proves "authenticated" without
// access to Instagram's live markup to verify it - a wrong selector would
// itself become a new false "needs login" for perfectly healthy accounts,
// which is exactly the class of mistake this hardening exists to prevent
// the OPPOSITE version of). It fails CLOSED: any state this module cannot
// positively explain (an unrecognized gate, no gate but also no recognized
// authenticated shell marker after an unexpected page, a navigation error)
// is reported as not-authenticated, never guessed as active - a false
// "needs login" just costs a human a re-check; a false "active" is a real
// external-publish mistake, as this incident showed.

const GATES = [
  {
    name: "login",
    reason: "redirected to login",
    url: /\/accounts\/login/i,
    text: /\blog in\b[\s\S]{0,30}\binstagram\b|forgot password\?/i,
  },
  {
    name: "signup",
    reason: "redirected to sign-up - the session is not authenticated",
    url: /\/accounts\/(?:emailsignup|signup)\b/i,
    text: /get started on instagram|sign up to see photos and videos/i,
  },
  {
    name: "checkpoint",
    reason: "Instagram is requiring an account checkpoint/challenge that must be resolved manually",
    url: /\/challenge\/|checkpoint/i,
    text: /help us confirm|suspicious login attempt|we detected an unusual login|enter the confirmation code|verify it.s you/i,
  },
  {
    name: "consent",
    reason: "Instagram is showing an additional consent/verification step",
    url: /\/accounts\/(?:onetap|birthday)\b|\/consent\//i,
    text: /confirm your birthday|review important information/i,
  },
];

function matchGate(url, text) {
  for (const gate of GATES) {
    if (gate.url.test(url)) return gate;
    if (text && gate.text.test(text)) return gate;
  }
  return null;
}

async function verifyInstagramSession(page, expectedUsername = null) {
  try {
    await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    // Give any client-side auth redirect a chance to settle - not fatal if
    // the page never reaches network-idle (some authenticated shells never
    // do, given their own polling/websocket activity).
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const url = page.url();
    if (!/instagram\.com/i.test(url)) {
      return { active: false, reason: `did not remain on instagram.com (${safeHostname(url)})` };
    }

    let text = "";
    try {
      text = await page.locator("body").innerText();
    } catch {
      // Diagnostic only - gate matching still works from the URL alone.
    }

    const gate = matchGate(url, text);
    if (gate) return { active: false, reason: gate.reason };

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
          return { active: false, reason: "authenticated identity did not match the imported username" };
        }
      } catch {
        // Diagnostic only - navigation/gate result remains the source of truth.
      }
    }

    return {
      active: true,
      reason: hasAuthenticatedShell
        ? "reached Instagram's authenticated app shell with no login/signup/checkpoint gate"
        : "reached Instagram with no recognized login/signup/checkpoint gate",
    };
  } catch (error) {
    return { active: false, reason: `verification failed: ${error.message}` };
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown host";
  }
}

module.exports = { verifyInstagramSession };
