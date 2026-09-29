import { canonicalHrIdKey } from "@/lib/hr-id";

// ─────────────────────────────────────────────────────────────────────────────
// Senior medical reps — the roster behind the "Senior" badge.
//
// A senior rep is a distinction the owner grants a rep by name. It is NOT a job
// title (their title stays "Medical Representative") and NOT an org seat, so it
// lives here as a small canonical roster rather than in the org tree or the
// employee master — nothing derives it, and the badge simply reads it.
//
// Keys are canonical HR-id keys (lowercase, alias-resolved) so a call site can
// pass whatever casing it holds. Add an HR id here to mark another senior rep;
// the badge then surfaces on every surface that renders that rep's name.
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical HR-id keys of the senior medical reps. */
export const SENIOR_REP_HR_ID_KEYS: ReadonlySet<string> = new Set<string>([
  canonicalHrIdKey("B-7")!, // Aya Ibrahim Mohamed Salam — Medical Rep, Delta (1)
]);

/** True when this HR id belongs to a senior medical rep. Casing-insensitive. */
export function isSeniorRep(hrId: string | null | undefined): boolean {
  const key = canonicalHrIdKey(hrId);
  return key ? SENIOR_REP_HR_ID_KEYS.has(key) : false;
}

/** The label the badge renders. Kept here so every surface reads one wording. */
export const SENIOR_REP_BADGE_LABEL = "Senior";
