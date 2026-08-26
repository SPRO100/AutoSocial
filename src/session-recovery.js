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
//      as REDIRECT_LOOP, even if attempts remain in the budget.
//   3. A recovery action that reports performed:false (nothing safe found
//      to click) stops immediately as RECOVERY_EXHAUSTED - never retried
//      with the same action against the same state.
const MAX_ATTEMPTS_DEFAULT = 3;

// Every recovery-eligible verify result MUST be one of these before the
// pipeline will attempt anything - never inferred from the reason string,
// never expanded implicitly. Kept as a plain re-export point rather than a
// second source of truth: callers pass their own platform's
// SAFE_RECOVERABLE_STATES (from e.g. importers/instagram-recovery.js).

function nowIso() {
  return new Date().toISOString();
}

function safeMessage(error) {
  return error && error.message ? error.message : String(error);
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
}) {
  const attempts = [];
  const seenSignatures = new Set();
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

    const signature = `${classification.state}|${classification.url || ""}`;
    if (seenSignatures.has(signature)) {
      const loopState = { ...classification, state: "REDIRECT_LOOP", reason: `detected a repeated state/URL during recovery (last: ${classification.state}) - stopping to avoid an infinite loop` };
      attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification: loopState, action: null, result: "REDIRECT_LOOP", nextAction: "operator review required" }));
      return { ...loopState, active: false, attempts };
    }
    seenSignatures.add(signature);

    const recoverable = recover && recover.SAFE_RECOVERABLE_STATES.has(classification.state);
    if (!recoverable) {
      attempts.push(recordAttempt({ account, platform, personaProfileId, attempt: attemptNumber, classification, action: null, result: classification.state, nextAction: terminalNextAction(classification.state) }));
      return { ...classification, attempts };
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
    return "CHALLENGE_REQUIRED";
  }
  return classification.challenge ? "CHALLENGE_REQUIRED" : "NEEDS_LOGIN";
}

function mapToSessionStatus(classification) {
  if (classification.active) return "ready";
  if (classification.state) {
    if (classification.state === "LOGIN_REQUIRED") return "needs_login";
    if (classification.state === "FAILED") return "error";
    return "challenge_required";
  }
  return classification.challenge ? "challenge_required" : "needs_login";
}

module.exports = { recoverSession, mapToPipelineStatus, mapToSessionStatus, MAX_ATTEMPTS_DEFAULT };
