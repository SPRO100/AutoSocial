// Deterministic, bounded Session Recovery Pipeline - the ONE place that
// turns a verifier's classification into a recovery attempt, shared by the
// bulk import pipeline (importers/pipeline.js) and the on-demand "Check
// session" path (session-check.js). Neither of those re-implements any of
// this; both hand it a platform verifier + a platform recovery module and
// get back a final, terminal classification plus a full, safe attempt
// history.
//
// Contract this module drives (see importers/instagram-verify.js and
// importers/instagram-recovery.js for the concrete Instagram
// implementation - any future platform recovery support follows the same
// two-part shape):
//   verify(page, username, { skipNavigation }) -> {
//     active, state, reason, url?, code?, recoverable?
//   }
//   recover.SAFE_RECOVERABLE_STATES: Set<string>
//   recover.attemptRecovery(page, state) -> { performed, action, detail }
//
// Loop, exactly as specified:
//   verify -> classify -> READY? finish.
//   state in SAFE_RECOVERABLE_STATES? perform ONE recovery action,
//     re-verify WITHOUT forcing navigation (skipNavigation: true - continue
//     inspecting the current browser state, never abandon an unfinished
//     flow with another goto), loop.
//   otherwise (security/manual/policy state, or recovery exhausted, or a
//     redirect loop was detected): stop. Every non-READY outcome is
//     terminal and actionable - never guessed, never silently retried
//     forever.
//
// Loop-termination guarantees (defense in depth - any ONE of these alone
// already prevents an infinite loop):
//   1. maxAttempts hard-caps total verify calls regardless of anything else.
//   2. A (state, url) signature seen twice in the same run stops immediately
//      as REDIRECT_LOOP (or BLOCKED_CHALLENGE - see below), even if
//      attempts remain in the budget.
//   3. A recovery action that reports performed:false (nothing safe found
//      to click) stops immediately as RECOVERY_EXHAUSTED - never retried
//      with the same action against the same state.
const MAX_ATTEMPTS_DEFAULT = 3;

// Real production forensic finding (2026-08-26, brenda9875428/bruna118564):
// a cookie-consent click's own promise resolving is not evidence that
// Instagram's server-side consent transaction has settled - the very next
// verify() call could read a still-transitioning page. This is a bounded,
// fixed pause between "action performed" and "re-verify", not a retry or a
// navigation - it changes nothing about WHAT gets classified, only WHEN the
// read happens.
//
// Env-overridable the same way cookie-adapter.js's header-cookie TTL is -
// callers (pipeline.js, session-check.js) never pass this explicitly, so
// production always gets the real default; tests set
// AUTOSOCIAL_RECOVERY_SETTLE_DELAY_MS=0 (module-cache-substitution
// convention, same as every other test in this suite) so real recovery
// runs don't sit through several real seconds per test.
const DEFAULT_SETTLE_DELAY_MS = 2500;

function resolveSettleDelayMsDefault() {
  const raw = process.env.AUTOSOCIAL_RECOVERY_SETTLE_DELAY_MS;
  if (raw === undefined || raw === "") return DEFAULT_SETTLE_DELAY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[session-recovery] Ignoring invalid AUTOSOCIAL_RECOVERY_SETTLE_DELAY_MS=${JSON.stringify(raw)} ` +
      `(must be a non-negative number of milliseconds) - using the default of ${DEFAULT_SETTLE_DELAY_MS}ms instead.`
    );
    return DEFAULT_SETTLE_DELAY_MS;
  }
  return parsed;
}

const SETTLE_DELAY_MS_DEFAULT = resolveSettleDelayMsDefault();

// Real production forensic finding (2026-08-26): a manually-driven session
// showed Instagram's own server oscillating between a consent/cookie screen
// and its scraping_warning anti-automation challenge - confirmed via
// DevTools Network tab as genuine server-side 302 redirects, not a client
// bug. Our automated recovery never drives a session that far (it only ever
// acts on COOKIE_CONSENT_REQUIRED), but if a future verify/re-verify ever
// observes two DIFFERENT members of this family within one recovery run,
// that is materially different from - and more severe than - either a
// plain repeated state (REDIRECT_LOOP) or a single, first-seen
// SCRAPING_WARNING/PRIVACY_CHOICE_REQUIRED: it means the session itself is
// stuck oscillating between a policy/cookie decision and a security
// challenge, which no automated retry can resolve. Never added to any
// SAFE_RECOVERABLE_STATES set - this classification exists to stop
// harder/more clearly, never to unlock a new automated action.
const CHALLENGE_OSCILLATION_FAMILY = new Set(["SCRAPING_WARNING", "PRIVACY_CHOICE_REQUIRED", "COOKIE_CONSENT_REQUIRED"]);

function nowIso() {
  return new Date().toISOString();
}

function safeMessage(error) {
  return error && error.message ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One entry per verify/recovery step - the exact shape the product
// requirement asks every recovery attempt to persist/return. Never includes
// a page URL fragment beyond the plain URL itself (Instagram's own URLs
// carry no secrets/tokens in this codebase's flows) and never a cookie/
// password/2FA value - callers only ever pass verifier output here, which
// is already safe by instagram-verify.js's own contract.
function recordAttempt({ account, platform, personaProfileId, attempt, classification, action, result, nextAction }) {
  return {
    account: account || null,
    platform: platform || null,
    personaProfileId: personaProfileId || null,
    state: classification.state || null,
    url: classification.url || null,
    attempt,
    action: action ? action.action : "verify_only",
    actionPerformed: action ? Boolean(action.performed) : false,
    actionDetail: action ? action.detail : null,
    result,
    reason: classification.reason || null,
    timestamp: nowIso(),
    nextAction,
  };
}

// account/platform/personaProfileId are carried through purely for the
// attempt log (recordAttempt above) - this module never uses them to look
// anything up itself, keeping it a pure function of (page, verify, recover).
async function recoverSession({
  verify,
  recover,
  page,
  username,
  account = null,
  platform = null,
  personaProfileId = null,
  maxAttempts = MAX_ATTEMPTS_DEFAULT,
  settleDelayMs = SETTLE_DELAY_MS_DEFAULT,
}) {
  const attempts = [];
  const seenSignatures = new Set();
  const seenFamilyStates = new Set();
  let attemptNumber = 0;

  let classification;
  try {
    classification = await verify(page, username);
  } catch (error) {
    // The verifier's own contract already fails closed internally (see
    // instagram-verify.js's catch) - reaching HERE means something broke
    // calling it at all (e.g. the page itself is unusable). Distinct FAILED
    // outcome, never silently reported as NEEDS_LOGIN.
    attemptNumber += 1;
    const failed = { active: false, state: "FAILED", reason: `recovery could not run verification: ${safeMessage(error)}` };
    attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification: failed, action: null, result: "FAILED", nextAction: "stop - infrastructure error" }));
    return { ...failed, attempts };
  }
  attemptNumber += 1;

  for (;;) {
    if (classification.active) {
      attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification, action: null, result: "READY", nextAction: "none - session ready" }));
      return { ...classification, attempts };
    }

    // Computed BEFORE this iteration's own bookkeeping mutates
    // seenFamilyStates, so it only ever reflects a DIFFERENT family member
    // seen in an EARLIER iteration - never the current one counting itself.
    const isFamilyMember = CHALLENGE_OSCILLATION_FAMILY.has(classification.state);
    const sawDifferentFamilyMemberBefore = isFamilyMember && [...seenFamilyStates].some((s) => s !== classification.state);

    const signature = `${classification.state}|${classification.url || ""}`;
    if (seenSignatures.has(signature)) {
      const finalState = sawDifferentFamilyMemberBefore ? "BLOCKED_CHALLENGE" : "REDIRECT_LOOP";
      const loopState = {
        ...classification,
        state: finalState,
        reason: finalState === "BLOCKED_CHALLENGE"
          ? `Instagram is oscillating between a consent/cookie screen and its anti-automation challenge (last: ${classification.state}) - this requires manual/account-level resolution, not an automated retry`
          : `detected a repeated state/URL during recovery (last: ${classification.state}) - stopping to avoid an infinite loop`,
      };
      attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification: loopState, action: null, result: finalState, nextAction: terminalNextAction(finalState) }));
      return { ...loopState, active: false, attempts };
    }
    seenSignatures.add(signature);
    if (isFamilyMember) seenFamilyStates.add(classification.state);

    const recoverable = recover && recover.SAFE_RECOVERABLE_STATES.has(classification.state);
    if (!recoverable) {
      const finalState = sawDifferentFamilyMemberBefore ? "BLOCKED_CHALLENGE" : classification.state;
      const finalClassification = sawDifferentFamilyMemberBefore
        ? { ...classification, state: "BLOCKED_CHALLENGE", reason: `Instagram is oscillating between a consent/cookie screen and its anti-automation challenge (currently: ${classification.state}) - this requires manual/account-level resolution, not an automated retry` }
        : classification;
      attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification: finalClassification, action: null, result: finalState, nextAction: terminalNextAction(finalState) }));
      return { ...finalClassification, attempts };
    }

    if (attemptNumber >= maxAttempts) {
      const exhausted = { ...classification, state: "RECOVERY_EXHAUSTED", reason: `retry budget (${maxAttempts}) exhausted while still at ${classification.state}` };
      attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification: exhausted, action: null, result: "RECOVERY_EXHAUSTED", nextAction: "operator review required" }));
      return { ...exhausted, active: false, attempts };
    }

    let action;
    try {
      action = await recover.attemptRecovery(page, classification.state);
    } catch (error) {
      action = { performed: false, action: "recovery_error", detail: safeMessage(error) };
    }

    if (!action.performed) {
      attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification, action, result: "RECOVERY_EXHAUSTED", nextAction: "operator review required" }));
      return { ...classification, active: false, state: "RECOVERY_EXHAUSTED", reason: `no safe recovery action available for ${classification.state} (${action.detail})`, attempts };
    }

    attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification, action, result: "RECOVERY_RETRYABLE", nextAction: "re-verify after recovery action" }));

    // Real production forensic finding (2026-08-26): give Instagram's
    // server-side consent transaction a bounded chance to settle before
    // reading the resulting state - a click's promise resolving is not
    // evidence the transition is complete. Never a retry, never extra
    // navigation - only WHEN the next read happens changes. 0 in tests.
    if (settleDelayMs > 0) await sleep(settleDelayMs);

    attemptNumber += 1;
    try {
      // skipNavigation:true - continue inspecting the page the recovery
      // action just interacted with; never re-navigate over an unfinished
      // flow.
      classification = await verify(page, username, { skipNavigation: true });
    } catch (error) {
      const failed = { active: false, state: "FAILED", reason: `recovery could not re-verify: ${safeMessage(error)}` };
      attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification: failed, action: null, result: "FAILED", nextAction: "stop - infrastructure error" }));
      return { ...failed, attempts };
    }
  }
}

function terminalNextAction(state) {
  switch (state) {
    case "PRIVACY_CHOICE_REQUIRED":
      return "operator/policy decision required (account-wide privacy or subscription choice)";
    case "SCRAPING_WARNING":
      return "operator review required (Instagram anti-automation check)";
    case "SECURITY_CHALLENGE":
    case "TWO_FACTOR_REQUIRED":
    case "CAPTCHA_REQUIRED":
      return "operator must resolve this manually through Instagram's own flow - never automated";
    case "LOGIN_REQUIRED":
      return "operator must re-authenticate this account";
    case "BLOCKED_CHALLENGE":
      return "operator/account-level review required - the session is oscillating between consent and a security challenge, do not retry automatically";
    case "ACCOUNT_SUSPENDED":
      return "this Instagram account has been suspended by Instagram - operator must review/appeal directly through Instagram, never automated";
    case "UNKNOWN":
      return "session could not be positively verified - operator should manually inspect this account before assuming it is ready";
    default:
      return "operator review required";
  }
}

// --- Legacy-compatible status mapping ---------------------------------
// Every EXISTING caller/consumer (pipeline.js's four-value `status`,
// account-manager.js's five-value `sessionStatus`) predates the granular
// `state` field and must keep working unchanged for any verifier that
// doesn't produce one - TikTok's verifyTikTokSession only ever returns
// {active, reason}, never {state, challenge}. Falling back to the OLD
// active/challenge-based logic for those (rather than defaulting an absent
// state to CHALLENGE_REQUIRED) is what keeps TikTok's behavior byte-for-
// byte identical to before this module existed - verified by
// test/importers-pipeline.test.js's pre-existing TikTok assertions.

function mapToPipelineStatus(classification) {
  if (classification.active) return "READY";
  if (classification.state) {
    if (classification.state === "LOGIN_REQUIRED") return "NEEDS_LOGIN";
    if (classification.state === "FAILED") return "FAILED";
    // The bulk-import pipeline's status vocabulary is a fixed legacy
    // 4-value set (READY/NEEDS_LOGIN/CHALLENGE_REQUIRED/FAILED, mirrored by
    // content-os's ImportRecordResult.status) - UNKNOWN has no dedicated
    // bucket there. NEEDS_LOGIN is the closest legacy fit: same operator
    // action either way (re-check/re-authenticate this account), and it is
    // NOT the CHALLENGE_REQUIRED bucket, which specifically implies a known
    // recognizable gate exists to resolve - UNKNOWN has none.
    if (classification.state === "UNKNOWN") return "NEEDS_LOGIN";
    // ACCOUNT_SUSPENDED and every other granular state fall through here
    // deliberately - CHALLENGE_REQUIRED is the correct legacy bucket for
    // "not ready, not simply needs-login, requires operator review".
    return "CHALLENGE_REQUIRED";
  }
  return classification.challenge ? "CHALLENGE_REQUIRED" : "NEEDS_LOGIN";
}

function mapToSessionStatus(classification) {
  if (classification.active) return "ready";
  if (classification.state) {
    if (classification.state === "LOGIN_REQUIRED") return "needs_login";
    if (classification.state === "FAILED") return "error";
    // Unlike the pipeline mapping above, the account-manager/Dashboard
    // coarse status already HAS a semantically correct bucket for this:
    // "unknown" (session-check.js's own contract already documents
    // "unknown" as the honest state when nothing conclusive is known - this
    // just also covers "checked, but could not conclude" alongside "never
    // checked"). Already fail-closed everywhere it's consumed (see
    // content-os's publish-readiness.service.ts, which blocks both
    // "unknown" and "error").
    if (classification.state === "UNKNOWN") return "unknown";
    return "challenge_required";
  }
  return classification.challenge ? "challenge_required" : "needs_login";
}

module.exports = { recoverSession, mapToPipelineStatus, mapToSessionStatus, MAX_ATTEMPTS_DEFAULT, SETTLE_DELAY_MS_DEFAULT, CHALLENGE_OSCILLATION_FAMILY };
