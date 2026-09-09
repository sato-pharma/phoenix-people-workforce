// Recruitment / ATS — the seat a candidate is applying INTO, and who is therefore allowed to
// receive their CV.
//
// THE OWNER, 2026-09-09, on finding district managers reading applications for their own job:
// *"the district managers receive medical reps and the national sales managers receive district
// managers and medical reps. A district manager never receives district manager."*
//
// Measured against production the same day, and this is why it is worth a module rather than an
// `if`: of the 537 CVs eligible to reach a folder, 135 name a district-manager job — 106 in
// `applied_for_job_title`, a further 29 in `current_job_title` alone. Every one of them was being
// filed into the folders of the very district managers whose post they were applying for, on up to
// three lines at once. Two named district managers were each holding a dozen applicants for their
// own seat, in their own region, presented to them as candidates to screen.
//
// ── THE RULE IS A LADDER, NOT A LIST ────────────────────────────────────────────────────────────
//
// He named two rungs; the company has four. Written as "a DM gets reps, an NSM gets DMs and reps"
// the rule cannot say where a REGIONAL sales manager's application goes, and Pedia has a live RSM
// seat with three districts under it. So it is stated once, as a rank: A MANAGER RECEIVES ONLY
// APPLICANTS FOR SEATS STRICTLY BELOW HIS OWN. That is the same shape as the standing scope rule
// the doctor-coverage boards already run on — scope runs downward only, never at or above your own
// rank — and it answers the RSM without a decision being invented on his behalf.
//
// ── WHAT IS DELIBERATELY *NOT* RANKED ───────────────────────────────────────────────────────────
//
// This answers `null` for everybody who is not applying for a field-force MANAGER post — a medical
// rep, a pharmacist, an accountant, and the CVs that carry no readable title at all. `null` is not
// "we could not tell": it is "nothing here says this person is applying over a district manager's
// head", and it routes exactly as it did before this module existed. That asymmetry is the whole
// safety of the change — it can only ever REMOVE a CV from a district manager's folder, never empty
// one. Requiring a positive `medical_rep` read instead would have emptied the folders, because most
// CVs in this pool have no title to read at all.

import { candidateAppliedFor, type CandidateAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateRoleFamily } from "@/lib/recruitment/candidate-role-family";

/**
 * The seats of the sales organisation, junior first.
 *
 * These are `au_v_org_tree`'s own tier codes, deliberately — the receiving side of this rule reads a
 * seat row, and a second vocabulary between the two halves is how the two drift apart. `ACTING_DM`
 * is a real seat here (a rep acts as district manager on Anti Infective Upper Egypt 1) and ranks
 * exactly with `DM`: he does the district manager's job, so he must not read applications for it
 * either.
 */
const SEAT_TIER_RANK: Record<string, number> = {
  ACTING_DM: 1,
  // Present so a CEO seat SORTS, never so a CV can reach it. Nothing is routed to the CEO — see
  // `managerSeatCanReceive`, which stops below this rung on purpose.
  CEO: 4,
  DM: 1,
  NSM: 3,
  REP: 0,
  RSM: 2,
};

/** The rank of an org-tree seat tier, or null for a tier this ladder does not know. */
export function seatTierRank(tier: string | null | undefined): number | null {
  const key = String(tier ?? "").trim().toUpperCase();
  if (!key) return null;
  const rank = SEAT_TIER_RANK[key];
  return rank === undefined ? null : rank;
}

/** Named once so the exclusion below cannot be spelled a second way. */
const CEO_TIER_RANK = SEAT_TIER_RANK.CEO;

/**
 * The manager post a candidate is applying for. Returned as the org tree's own tier code so the
 * caller compares ranks rather than words.
 */
export type CandidateManagerSeatTier = "DM" | "RSM" | "NSM";

/** Just enough of a candidate row to read the job they are asking us for. */
export type SeatRankCandidate = {
  /** `ats_candidates.applied_for_job_title` — a human typed it. Outranks everything else. */
  appliedForJobTitle?: string | null;
  /** `ats_candidates.current_job_title` — the job they hold today. The last rung, and it matters. */
  currentJobTitle?: string | null;
  /** The intake envelope, which carries the forwarded `Subject( … )` the sender wrote. */
  fullName?: string | null;
  /** Already resolved by a fuller loader, when one ran. Preferred over re-reading the columns. */
  appliedFor?: CandidateAppliedFor | null;
};

/**
 * The job this candidate is asking us for, read from what is on the row and nothing else.
 *
 * NO DATABASE ROUND TRIP, and that is a measured choice rather than a shortcut. The folder loader
 * reads ~600 candidate rows with `select("*")` and joins nothing; pulling in the source-context
 * table would be a second paged query on every page load. Measured against production 2026-09-09,
 * the email subject line names a district-manager job for ZERO candidates that these three fields do
 * not already answer, so the join would have bought nothing. `appliedFor` is still preferred when a
 * richer loader has already filled it, so a surface that DID read the CV extraction keeps its better
 * answer instead of falling back to a thinner one.
 */
function resolveAppliedForTitle(candidate: SeatRankCandidate): string | null {
  if (candidate.appliedFor?.text) return candidate.appliedFor.text;
  return candidateAppliedFor({
    // The ladder's own order, unchanged: what a person typed, then the sender's own envelope, then —
    // last, and a different kind of fact — the role they hold today.
    cvCurrentJobTitle: candidate.currentJobTitle,
    fullName: candidate.fullName,
    statedJobTitle: candidate.appliedForJobTitle,
  }).text;
}

/**
 * Which manager post this CV is for — `null` for everyone else, which is most of the pool.
 *
 * The three families that map to a rung are the field-force management families and only those.
 * `product_manager` is NOT one of them despite the word: a Product Manager is a head-office
 * marketing seat that manages nobody in the field, and routing one over a district manager's head
 * would be an invention rather than a reading.
 */
export function candidateManagerSeatTier(candidate: SeatRankCandidate): CandidateManagerSeatTier | null {
  const title = resolveAppliedForTitle(candidate);
  if (!title) return null;
  switch (candidateRoleFamily(title)) {
    case "area_regional_manager":
      return "RSM";
    case "district_manager":
      return "DM";
    case "national_sales_manager":
      return "NSM";
    default:
      return null;
  }
}

/**
 * May a manager sitting in `seatTier` receive an application for `candidateTier`?
 *
 * STRICTLY BELOW, AND NEVER THE CEO. The strictness is the owner's own sentence — a district manager
 * never receives a district manager — and it falls out of the same comparison that sends a district
 * manager's application up to the national sales manager. The CEO is excluded outright rather than
 * by rank: he is the top of the tree, so every application would otherwise reach him, and the
 * standing rule here is that nothing is routed to or decided by the CEO.
 */
export function managerSeatCanReceive(
  seatTier: string | null | undefined,
  candidateTier: CandidateManagerSeatTier,
): boolean {
  const seat = seatTierRank(seatTier);
  const wanted = seatTierRank(candidateTier);
  if (seat === null || wanted === null) return false;
  if (seat >= CEO_TIER_RANK) return false;
  return seat > wanted;
}
