// Instagram-specific SAFE recovery actions - the only module in this
// codebase allowed to click anything on a consent/challenge screen. Paired
// 1:1 with instagram-verify.js's STATES: every action here corresponds to
// exactly one state ../session-recovery.js's orchestrator is willing to
// attempt automatically (see SAFE_RECOVERABLE_STATES below), and this
// module is the only place that decides HOW to act, never whether to.
//
// Hard boundary (do not weaken): this module NEVER interacts with a
// security/identity verification surface (2FA code entry, CAPTCHA, account
// checkpoint) and NEVER makes an account-wide privacy/subscription choice
// (e.g. ad-free vs. free-with-ads) on the operator's behalf. Both are
// classified by instagram-verify.js but have no corresponding action here -
// the recovery orchestrator stops on them by construction, since
// SAFE_RECOVERABLE_STATES simply does not list them.
const { STATES } = require("./instagram-verify");

// Only a routine cookie-consent banner is ever auto-resolved. Every other
// state instagram-verify.js can produce (privacy/subscription choice,
// scraping_warning, any security challenge, login/signup) has no action
// here and is therefore never attempted - see session-recovery.js, which
// only calls attemptRecovery() for a state in this set.
const SAFE_RECOVERABLE_STATES = new Set([STATES.COOKIE_CONSENT_REQUIRED]);

// Ordered by preference, not just possibility: a data-minimizing "decline
// optional cookies" choice is tried before a blanket "allow all", since
// both are equally legitimate ways to dismiss the SAME routine banner (this
// is not a security or monetization decision - it is the cookie choice
// itself the banner exists to collect) and a narrower, non-tracking default
// is the more conservative one to make on the operator's behalf without
// explicit configuration. If Instagram's real button copy ever drifts from
// every pattern below, no click is attempted - see performCookieConsent's
// closing comment.
const COOKIE_CONSENT_BUTTON_PATTERNS = [
  /decline optional cookies/i,
  /only allow essential cookies/i,
  /manage cookies?$/i,
  /allow essential and optional cookies/i,
  /allow all cookies/i,
  /accept all/i,
  /accept cookies/i,
];

// Searches buttons/links/role=button elements for the first one whose
// visible text matches, in COOKIE_CONSENT_BUTTON_PATTERNS order (not DOM
// order) - so the preferred, more conservative option is chosen even if it
// happens to render second. Returns { match: null, texts } (never throws)
// if nothing recognizable is found, so the caller can fail closed instead
// of guessing - `texts` is a bounded, deduplicated sample of what WAS
// actually on the page (Recovery V2, 2026-08-27 - real incident:
// bruna731302 hit exactly this "nothing recognized" path with zero
// captured evidence of what it actually saw, which permanently blocked any
// future fix of the pattern list; diagnostic only, never used to decide
// what is safe to click).
async function findCookieConsentButton(page) {
  const candidates = page.locator('button, [role="button"], a');
  const count = await candidates.count().catch(() => 0);
  if (!count) return { match: null, texts: [] };

  const rawTexts = [];
  for (let i = 0; i < count; i += 1) {
    const text = await candidates.nth(i).innerText().catch(() => "");
    rawTexts.push(String(text || "").trim());
  }

  for (const pattern of COOKIE_CONSENT_BUTTON_PATTERNS) {
    const index = rawTexts.findIndex((text) => text && pattern.test(text));
    if (index >= 0) return { match: { locator: candidates.nth(index), matchedText: rawTexts[index] }, texts: [] };
  }
  const sample = [...new Set(rawTexts.filter(Boolean))].slice(0, 4);
  return { match: null, texts: sample };
}

// Returns { performed, action, detail, transitionObserved?, transitionElapsedMs? }
// - performed:false (with a diagnostic detail, never a raw page dump)
// whenever nothing safe to click was found, so the orchestrator can
// distinguish "we tried and there was genuinely nothing recognizable" from
// "we tried and clicked something".
//
// Recovery V2 (2026-08-27+): after a real click, best-effort BOUNDED wait
// for the exact element we just clicked to leave the DOM - a direct,
// evidence-grounded proxy for "the consent flow visibly resolved", without
// guessing at what replaces it or inventing any new selector. Bounded by
// the caller's own settle budget (transitionWaitMs, the same
// AUTOSOCIAL_RECOVERY_SETTLE_DELAY_MS-controlled value session-recovery.js
// already uses) so this can never add unbounded latency. Never throws,
// never retried, never re-clicked - a timeout here just means
// transitionObserved:false, which session-recovery.js falls back to
// treating exactly like Recovery V1 (sleep its own full settle window).
async function performCookieConsent(page, { transitionWaitMs = 0 } = {}) {
  const { match, texts } = await findCookieConsentButton(page);
  if (!match) {
    const suffix = texts.length
      ? `; observed candidates: ${texts.map((t) => JSON.stringify(t.slice(0, 30))).join(", ")}`
      : "";
    return { performed: false, action: "cookie_consent", detail: `no recognized cookie-consent control found on the page${suffix}` };
  }
  try {
    await match.locator.click({ timeout: 5000 });
  } catch (error) {
    return { performed: false, action: "cookie_consent", detail: `click failed: ${error.message}` };
  }

  const transitionStarted = Date.now();
  let transitionObserved = false;
  if (transitionWaitMs > 0) {
    try {
      await match.locator.waitFor({ state: "detached", timeout: transitionWaitMs });
      transitionObserved = true;
    } catch {
      // Bounded, best-effort only - still attached (or the check itself
      // failed) after the wait. session-recovery.js's own fixed buffer
      // covers the remainder; never retried or re-clicked here.
    }
  }

  return {
    performed: true,
    action: "cookie_consent",
    detail: `clicked control matching "${match.matchedText.slice(0, 60)}"`,
    transitionObserved,
    transitionElapsedMs: Date.now() - transitionStarted,
  };
}

// ---------------------------------------------------------------------------
// Privacy/subscription choice policy hook (PRIVACY_CHOICE_REQUIRED).
//
// Deliberately inert right now: this always reports "no policy configured",
// and even a configured policy value is NOT wired to any click action in
// this module yet - see the product requirement this was built against
// ("Until a policy is explicitly configured, return PRIVACY_CHOICE_REQUIRED
// and stop"). The hook exists so a FUTURE, explicitly-authorized milestone
// can define an allowed choice (centrally, e.g. per Project/Offer policy -
// see ubt-os's ADR 0026) without touching instagram-verify.js or
// session-recovery.js again. Reading AUTOSOCIAL_INSTAGRAM_PRIVACY_POLICY is
// the ONE extension point; nothing currently acts on its value.
// ---------------------------------------------------------------------------
function getPrivacyChoicePolicy() {
  const raw = (process.env.AUTOSOCIAL_INSTAGRAM_PRIVACY_POLICY || "").trim();
  return { configured: Boolean(raw), value: raw || null };
}

// options.transitionWaitMs: forwarded from session-recovery.js's own
// settleDelayMs (Recovery V2) - see performCookieConsent's header comment.
// Any recovery action that doesn't use it (there is currently only one)
// simply ignores the option.
async function attemptRecovery(page, state, options = {}) {
  if (state === STATES.COOKIE_CONSENT_REQUIRED) return performCookieConsent(page, options);
  return { performed: false, action: "none", detail: `no automated recovery action exists for state ${state}` };
}

module.exports = { SAFE_RECOVERABLE_STATES, attemptRecovery, getPrivacyChoicePolicy };
