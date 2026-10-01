/**
 * The ORGANOGRAM's own job title for a seat tier — one vocabulary, shared.
 *
 * This is the title the organogram prints on a node (`org-chart.tsx` renders `positionTitle ??
 * jobTitle`, and `organogram-au-source.ts` fills both from this map), so anything else that names a
 * sales person's role reads it from here rather than inventing a second wording. The owner asked for
 * exactly that on 2026-10-01, of the Phoenix CRM visit card: *"put actual titles from the
 * organogram"* — it was showing "Manager" and "Senior manager", which are slots on a visit, not
 * anybody's job.
 *
 * DELIBERATELY DEPENDENCY-FREE. `organogram-au-source.ts` pulls the whole AU read behind it; a CRM
 * server module that imported the map from there would drag that chain in for six strings. Keep this
 * file free of imports.
 *
 * NOT the only tier vocabulary in the repo, and the others are not mistakes: `crm/org-placement.ts`
 * labels a PLACEMENT board ("District Manager", "Medical Rep") and `spotlight/org.ts` labels the
 * spotlight picker. Those name a tier for a filter; this names the person's JOB, as the organogram
 * states it. Do not merge them without the owner — three screens would change wording at once.
 *
 * ACTING_DM reads "District Sales Manager" because the organogram draws an acting district manager
 * as the district manager he is acting as — his own REP seat is collapsed into that node. That is the
 * organogram's own choice (see `organogram-au-source.ts`), not a ruling about his HR job title, which
 * stays whatever HR recorded (an acting DM remains a medical rep on paper — owner, settled).
 */

/** The seat tiers `au.v_org_tree` returns. */
export type OrgSeatTier = "CEO" | "NSM" | "RSM" | "DM" | "ACTING_DM" | "REP";

export const ORG_SEAT_TITLE: Record<OrgSeatTier, string> = {
  CEO: "CEO",
  NSM: "National Sales Manager",
  RSM: "Regional Sales Manager",
  DM: "District Sales Manager",
  ACTING_DM: "District Sales Manager",
  REP: "Medical Representative",
};

/**
 * How senior a tier is, highest first — used where a person holds more than one seat.
 *
 * One person legitimately holds two: an acting district manager holds the ACTING_DM seat AND the REP
 * seat beneath it. The organogram shows him once, at the higher one, so a title resolved from his
 * seats must do the same or the two screens would disagree about the same person.
 */
const TIER_RANK: Record<OrgSeatTier, number> = {
  CEO: 0,
  NSM: 1,
  RSM: 2,
  DM: 3,
  ACTING_DM: 3,
  REP: 4,
};

function asTier(tier: string | null | undefined): OrgSeatTier | null {
  const key = (tier ?? "").trim().toUpperCase();
  return key in ORG_SEAT_TITLE ? (key as OrgSeatTier) : null;
}

/**
 * The organogram's title for one seat tier, or null for a tier the view grew since this was written.
 *
 * NULL rather than the raw code or "undefined": a caller shows the slot it already had ("Manager")
 * instead, which is a true sentence about the visit. Printing `ACTING_DM` on a card would break the
 * owner's names-never-codes rule, and that is the direction a `?? tier` fallback fails in.
 */
export function orgSeatTitle(tier: string | null | undefined): string | null {
  const key = asTier(tier);
  return key === null ? null : ORG_SEAT_TITLE[key];
}

/**
 * The title for the highest seat of a set a person holds, or null when none of them is a tier this
 * knows. Pass every seat the person occupies; the order they arrive in does not matter.
 */
export function highestSeatTitle(tiers: Iterable<string | null | undefined>): string | null {
  let best: OrgSeatTier | null = null;
  for (const raw of tiers) {
    const tier = asTier(raw);
    if (tier === null) continue;
    if (best === null || TIER_RANK[tier] < TIER_RANK[best]) best = tier;
  }
  return best === null ? null : ORG_SEAT_TITLE[best];
}
