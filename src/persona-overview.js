// Pure computation for the dashboard's Persona overview - kept separate
// from dashboard-server.js (which has no exported app factory and isn't
// itself unit-testable) so this real, non-trivial cross-referencing logic
// has real test coverage. No I/O here; callers do the real fetches
// (getAllAccounts, listPersonaProfiles) and pass the results in.

/**
 * Cross-references one account's personaProfileId against Persona's real
 * profile list (or the honest "unavailable" state) and returns the same
 * `persona` shape /api/persona/overview exposes. Never fabricates a
 * status - "unknown"/found:null only when Persona genuinely couldn't be
 * asked; found:false only when Persona was reachable and genuinely does
 * not have this profile (e.g. deleted in Persona Studio).
 */
function computeAccountPersona(account, profilesById, personaApiAvailable) {
  if (!account.personaProfileId) return null;
  if (!personaApiAvailable) {
    return { id: account.personaProfileId, name: null, status: "unknown", found: null };
  }
  const match = profilesById.get(account.personaProfileId);
  return match
    ? { id: match.id, name: match.name, status: match.status, found: true }
    : { id: account.personaProfileId, name: null, status: "unknown", found: false };
}

/**
 * Builds a Map keyed by profile id for O(1) lookups - the one real place
 * that turns Persona's real profile list into an index, shared by every
 * account's computation instead of a per-account scan.
 */
function indexProfilesById(profiles) {
  return new Map((profiles || []).map((p) => [p.id, p]));
}

module.exports = { computeAccountPersona, indexProfilesById };
