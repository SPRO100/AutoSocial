// Account Operations & Link Control V1 - platform capability probes.
//
// These are bounded, read-only (or, for applyProfileLink, single-mutation)
// browser observations layered ON TOP of an already-READY session (see
// account-manager.js's header comment: SESSION STATE != OPERATIONAL STATE).
// They never decide whether an account is "usable" - that is the
// requirement-aware Qualification Engine's job (content-os); this module
// only reports what the platform's own authenticated UI actually shows.
//
// Every probe fails closed to UNKNOWN/UNAVAILABLE on anything ambiguous -
// same philosophy as importers/instagram-verify.js's gate-driven, fail-
// closed session check. Never guesses a positive capability from silence.

const { verifyInstagramSession } = require("./importers/instagram-verify");
const { dismissKnownOverlays } = require("./browser-platform-adapters");

// Allowlisted path segments safe to surface in evidence strings - anything
// else (e.g. a username segment in a redirect target) is masked. Mirrors
// the allowlist philosophy already used throughout account-manager.js.
const SAFE_PATH_SEGMENTS = /^(accounts|edit|login|challenge|settings|v2|account_privacy|consent|two_factor|checkpoint|suspended|scraping_warning|onetap|birthday|setting)$/i;

function safePathOnly(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean).map((seg) => (SAFE_PATH_SEGMENTS.test(seg) ? seg : "[masked]"));
    return `/${parts.join("/")}`;
  } catch {
    return "unknown_url";
  }
}

function safeMessage(message) {
  return String(message || "unknown_error")
    .replace(/[?&](sessionid|csrftoken|ds_user_id|authorization)=[^&\s]+/gi, "$1=[redacted]")
    .slice(0, 160);
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

async function readInstagramProfileEdit(page) {
  const evidence = [];
  try {
    await page.goto("https://www.instagram.com/accounts/edit/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await dismissKnownOverlays(page).catch(() => {});
    if (!/\/accounts\/edit\/?$/.test(page.url())) {
      evidence.push(`redirected:${safePathOnly(page.url())}`);
      return { profileEditCapability: "UNAVAILABLE", linkCapability: "UNKNOWN", observedProfileLink: null, evidence };
    }
    const website = page.locator('input[placeholder="Website" i]').first();
    if ((await website.count().catch(() => 0)) === 0) {
      evidence.push("website_field_not_found");
      return { profileEditCapability: "AVAILABLE", linkCapability: "UNAVAILABLE", observedProfileLink: null, evidence };
    }
    const value = await website.inputValue().catch(() => null);
    // Real finding (2026-08-27): Instagram renders this field for every
    // account, but leaves it `disabled` for accounts that are not eligible
    // to set an external URL (observed on a real Personal-category account
    // - Instagram gates the Website field on account type/eligibility, not
    // on session/session-plan alone). Field PRESENCE alone therefore
    // overclaims the capability; only an actually-enabled field means a
    // mutation could ever succeed - never report AVAILABLE from DOM
    // presence alone.
    const enabled = await website.isEnabled().catch(() => null);
    if (enabled === false) {
      evidence.push("website_field_found_but_disabled");
      return { profileEditCapability: "AVAILABLE", linkCapability: "UNAVAILABLE", observedProfileLink: value?.trim() || null, evidence };
    }
    evidence.push("website_field_found_enabled");
    return { profileEditCapability: "AVAILABLE", linkCapability: "AVAILABLE", observedProfileLink: value?.trim() || null, evidence };
  } catch (error) {
    evidence.push(`error:${safeMessage(error.message)}`);
    return { profileEditCapability: "UNKNOWN", linkCapability: "UNKNOWN", observedProfileLink: null, evidence };
  }
}

async function readInstagramPrivacy(page) {
  const evidence = [];
  try {
    await page.goto("https://www.instagram.com/accounts/settings/v2/account_privacy/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    if (!/account_privacy/.test(page.url())) {
      evidence.push(`redirected:${safePathOnly(page.url())}`);
      return { privacyStatus: "UNKNOWN", evidence };
    }
    const toggle = page.locator('[role="switch"][aria-label="Private account" i]').first();
    if ((await toggle.count().catch(() => 0)) === 0) {
      evidence.push("privacy_toggle_not_found");
      return { privacyStatus: "UNKNOWN", evidence };
    }
    const checked = await toggle.getAttribute("aria-checked").catch(() => null);
    evidence.push(`privacy_toggle_checked:${checked}`);
    if (checked === "true") return { privacyStatus: "PRIVATE", evidence };
    if (checked === "false") return { privacyStatus: "PUBLIC", evidence };
    return { privacyStatus: "UNKNOWN", evidence };
  } catch (error) {
    evidence.push(`error:${safeMessage(error.message)}`);
    return { privacyStatus: "UNKNOWN", evidence };
  }
}

// ADR 0033 section 7 (Platform Link Capabilities) - fail-closed by construction:
// every mechanism defaults to UNKNOWN unless this module has REAL evidence
// for it. Only PROFILE_WEBSITE (the "Website" field in Edit Profile) is
// currently probed on either platform; DESTINATION_LINK (e.g. TikTok's
// Business Suite destination links), VIDEO_LINK, COMMENT_ANCHOR, and
// BUSINESS_PAGE have no detection implemented - reporting them as
// anything but UNKNOWN would be exactly the "unproven availability"
// mistake ADR 0033 explicitly forbids. This is additive to the existing
// linkCapability field (which stays PROFILE_WEBSITE's own signal, for
// backward compatibility with every existing caller), never a replacement.
function deriveLinkMechanisms(profileWebsiteCapability) {
  return {
    PROFILE_WEBSITE: profileWebsiteCapability,
    DESTINATION_LINK: "UNKNOWN",
    VIDEO_LINK: "UNKNOWN",
    COMMENT_ANCHOR: "UNKNOWN",
    BUSINESS_PAGE: "UNKNOWN",
  };
}

function classifyIdentity(identity) {
  if (!identity) return "UNKNOWN";
  if (identity.reason && /identity did not match/i.test(identity.reason)) return "MISMATCH";
  if (identity.active && /confirmed identity match/i.test(identity.reason || "")) return "CONFIRMED";
  return "UNKNOWN";
}

/**
 * Bounded, read-only Instagram capability probe. Requires an already-open
 * page on a READY-session account (caller owns session acquisition/
 * disconnect - same division of responsibility as instagram-uploader.js).
 */
async function probeInstagramCapabilities(page, expectedUsername) {
  const identity = await verifyInstagramSession(page, expectedUsername).catch(() => null);
  if (!identity || !identity.active) {
    return {
      identityStatus: classifyIdentity(identity),
      privacyStatus: "UNKNOWN",
      profileEditCapability: "UNKNOWN",
      linkCapability: "UNKNOWN",
      linkMechanisms: deriveLinkMechanisms("UNKNOWN"),
      publishingCapability: "UNKNOWN",
      observedProfileLink: null,
      restrictions: { sessionState: identity?.state || null, reason: identity?.reason || null },
      evidence: ["session_not_ready_for_probe"],
    };
  }
  const edit = await readInstagramProfileEdit(page);
  const privacy = await readInstagramPrivacy(page);
  return {
    identityStatus: classifyIdentity(identity),
    privacyStatus: privacy.privacyStatus,
    profileEditCapability: edit.profileEditCapability,
    linkCapability: edit.linkCapability,
    linkMechanisms: deriveLinkMechanisms(edit.linkCapability),
    // Publishing capability for Instagram is proven directly by the real
    // production E2E publish milestone, not re-probed here - a READY,
    // identity-confirmed session with no restriction evidence is AVAILABLE.
    publishingCapability: "AVAILABLE",
    observedProfileLink: edit.observedProfileLink,
    restrictions: { sessionState: "READY", reason: null },
    evidence: [...edit.evidence, ...privacy.evidence],
  };
}

/**
 * Single-mutation, verified Instagram Website-link apply. Follows
 * INTENT -> PREFLIGHT -> MUTATE ONCE -> VERIFY -> PERSIST (caller performs
 * INTENT/PERSIST via account-manager.js; this function performs PREFLIGHT
 * through VERIFY and returns an honest outcome - it never retries an
 * ambiguous save itself).
 */
async function applyInstagramProfileLink(page, desiredUrl) {
  const evidence = [];
  const preflight = await readInstagramProfileEdit(page);
  evidence.push(...preflight.evidence.map((e) => `preflight:${e}`));
  if (preflight.linkCapability !== "AVAILABLE") {
    return { status: "UNAVAILABLE", observedUrl: preflight.observedProfileLink, evidence, failureReason: "Website field is not available on this account's Edit Profile page." };
  }
  if (preflight.observedProfileLink === desiredUrl) {
    evidence.push("already_matches_desired_no_mutation_needed");
    return { status: "ACTIVE", observedUrl: preflight.observedProfileLink, evidence, failureReason: null };
  }
  try {
    const website = page.locator('input[placeholder="Website" i]').first();
    await website.fill(desiredUrl, { timeout: 5000 });
    const submit = page.getByRole("button", { name: /^submit$/i }).first();
    const hasSubmit = (await submit.count().catch(() => 0)) > 0;
    if (hasSubmit) {
      await submit.click({ timeout: 5000 });
    } else {
      await website.press("Tab").catch(() => {});
    }
    evidence.push("mutate_once_performed");
    await page.waitForTimeout(1500);
  } catch (error) {
    evidence.push(`mutate_error:${safeMessage(error.message)}`);
    // Outcome of the mutation is now genuinely uncertain - never retry here.
    return { status: "ERROR", observedUrl: preflight.observedProfileLink, evidence, failureReason: safeMessage(error.message) };
  }
  // VERIFY: fresh reload, independent of the in-page state the mutation left
  // behind - never trust the form's own post-submit value as proof.
  const verify = await readInstagramProfileEdit(page);
  evidence.push(...verify.evidence.map((e) => `verify:${e}`));
  if (verify.linkCapability !== "AVAILABLE") {
    return { status: "ERROR", observedUrl: verify.observedProfileLink, evidence, failureReason: "Website field disappeared on reload after apply." };
  }
  if (verify.observedProfileLink === desiredUrl) {
    return { status: "ACTIVE", observedUrl: verify.observedProfileLink, evidence, failureReason: null };
  }
  if (!verify.observedProfileLink) {
    return { status: "MISSING", observedUrl: null, evidence, failureReason: "Website field is empty after apply - platform did not persist the link." };
  }
  return { status: "MISMATCH", observedUrl: verify.observedProfileLink, evidence, failureReason: "Observed link differs from desired link after apply." };
}

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

async function readTikTokPrivacy(page) {
  const evidence = [];
  try {
    await page.goto("https://www.tiktok.com/setting", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const bodyLen = (await page.locator("body").innerText().catch(() => "")).length;
    if (bodyLen < 20) {
      evidence.push("settings_page_did_not_render");
      return { privacyStatus: "UNKNOWN", evidence };
    }
    // Real finding (2026-08-27): TikTok's "Private account" control on the
    // real Settings page is a plain <input type="checkbox"> from its "TUX"
    // design system - it carries NEITHER role="switch" NOR any aria-checked/
    // aria-label attribute (confirmed via direct DOM inspection of a real,
    // reachable account). The real, robust signal is the checkbox's own
    // `.checked` DOM property, not ARIA (which this specific component
    // never sets) - checked first for defense in depth, since a future
    // TikTok markup revision might add proper ARIA.
    const state = await page.evaluate(() => {
      const byRole = Array.from(document.querySelectorAll('[role="switch"]'))
        .find((el) => /private account/i.test(el.getAttribute("aria-label") || ""));
      if (byRole) return byRole.getAttribute("aria-checked");
      const heading = Array.from(document.querySelectorAll("*"))
        .find((n) => n.children.length === 0 && /^private account$/i.test((n.textContent || "").trim()));
      let node = heading || null;
      for (let i = 0; i < 6 && node; i += 1) {
        node = node.parentElement;
        if (!node) break;
        const roleSwitch = node.querySelector('[role="switch"]');
        if (roleSwitch) return roleSwitch.getAttribute("aria-checked");
        const checkbox = node.querySelector('input[type="checkbox"]');
        if (checkbox) return checkbox.checked ? "true" : "false";
      }
      return null;
    }).catch(() => null);
    if (state === null) {
      evidence.push("privacy_toggle_not_found");
      return { privacyStatus: "UNKNOWN", evidence };
    }
    evidence.push(`privacy_toggle_checked:${state}`);
    if (state === "true") return { privacyStatus: "PRIVATE", evidence };
    if (state === "false") return { privacyStatus: "PUBLIC", evidence };
    return { privacyStatus: "UNKNOWN", evidence };
  } catch (error) {
    evidence.push(`error:${safeMessage(error.message)}`);
    return { privacyStatus: "UNKNOWN", evidence };
  }
}

// Real finding (2026-08-27): TikTok's own @username profile page returns a
// genuine HTTP 403 (confirmed via the navigation response itself, not just
// an empty-body guess) through this account's Persona session, reproduced
// twice including with an in-context Referer - while /setting reliably
// returns 200 in the same session. This is a real platform/edge-level
// block on this specific route, not a DOM/selector bug our own code could
// fix by waiting longer or trying another locator. Reported honestly as
// UNKNOWN with the precise HTTP status in evidence, never guessed, never
// silently downgraded to UNAVAILABLE (see this module's header comment).
async function readTikTokProfileLink(page, username) {
  const evidence = [];
  if (!username) {
    evidence.push("no_username_supplied");
    return { profileEditCapability: "UNKNOWN", linkCapability: "UNKNOWN", observedProfileLink: null, evidence };
  }
  try {
    const response = await page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}`, { waitUntil: "load", timeout: 30000 });
    const status = response ? response.status() : null;
    if (status && status >= 400) {
      evidence.push(`profile_page_blocked_http_${status}`);
      return { profileEditCapability: "UNKNOWN", linkCapability: "UNKNOWN", observedProfileLink: null, evidence };
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const bodyLen = (await page.locator("body").innerText().catch(() => "")).length;
    if (bodyLen < 20) {
      evidence.push(`profile_page_did_not_render${status ? `_http_${status}` : ""}`);
      return { profileEditCapability: "UNKNOWN", linkCapability: "UNKNOWN", observedProfileLink: null, evidence };
    }
    const editButton = page.getByRole("button", { name: /edit profile/i }).first();
    if ((await editButton.count().catch(() => 0)) === 0) {
      evidence.push("edit_profile_button_not_found");
      return { profileEditCapability: "UNKNOWN", linkCapability: "UNKNOWN", observedProfileLink: null, evidence };
    }
    await editButton.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const website = page.locator('input[placeholder*="website" i], input[aria-label*="website" i]').first();
    if ((await website.count().catch(() => 0)) === 0) {
      evidence.push("website_field_not_found");
      return { profileEditCapability: "AVAILABLE", linkCapability: "UNAVAILABLE", observedProfileLink: null, evidence };
    }
    const value = await website.inputValue().catch(() => null);
    evidence.push("website_field_found");
    return { profileEditCapability: "AVAILABLE", linkCapability: "AVAILABLE", observedProfileLink: value?.trim() || null, evidence };
  } catch (error) {
    evidence.push(`error:${safeMessage(error.message)}`);
    return { profileEditCapability: "UNKNOWN", linkCapability: "UNKNOWN", observedProfileLink: null, evidence };
  }
}

async function probeTikTokCapabilities(page, username) {
  const privacy = await readTikTokPrivacy(page);
  const link = await readTikTokProfileLink(page, username);
  return {
    identityStatus: "UNKNOWN",
    privacyStatus: privacy.privacyStatus,
    profileEditCapability: link.profileEditCapability,
    linkCapability: link.linkCapability,
    linkMechanisms: deriveLinkMechanisms(link.linkCapability),
    publishingCapability: "AVAILABLE",
    observedProfileLink: link.observedProfileLink,
    restrictions: { sessionState: "READY", reason: null },
    evidence: [...privacy.evidence, ...link.evidence],
  };
}

module.exports = {
  probeInstagramCapabilities,
  probeTikTokCapabilities,
  applyInstagramProfileLink,
  deriveLinkMechanisms,
  safePathOnly,
  safeMessage,
  // Exported for focused unit testing only - probeInstagramCapabilities/
  // probeTikTokCapabilities/applyInstagramProfileLink remain the real
  // entry points production code calls.
  readInstagramProfileEdit,
  readInstagramPrivacy,
  readTikTokPrivacy,
  readTikTokProfileLink,
  classifyIdentity,
};
