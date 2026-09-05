// Recruitment / ATS — search what the CV SAYS, not just who sent it.
//
// ── WHAT THE PLAN ASSUMED, AND WHAT IS ACTUALLY THERE ───────────────────────────────────────────
//
// This was planned as "full-text search over extracted CV text", on the premise that the text exists
// and is merely unsearchable. Measured on production 2026-09-05, that premise is wrong: there is no
// raw CV text anywhere. `ats_candidate_cv_extractions` holds `extracted_fields` jsonb and nothing
// else, and `ats_files` holds metadata while the document itself lives in Drive.
//
// What exists is the structured reading — job title, employer, university, degree, faculty, skills,
// work history, education — 514 kB across 581 live candidates. For this purpose that is BETTER than
// raw text: "cardiology" found in a parsed skills list is a fact about the person, whereas the same
// word in raw text might be a former employer's letterhead.
//
// ── WHY THE SERVER, WHEN THE EXISTING SEARCH IS INSTANT AND LOCAL ───────────────────────────────
//
// The screening page already ships roughly 683 kB of candidate data. The searchable CV text is
// another 514 kB — a 75% increase on every page load, for a search most visits never run. So the
// existing box stays exactly as it was (names, roles, phones, instantly, with no round trip) and
// this is a SEPARATE, explicit action: nothing about the fast path changes, and the slow path is
// only paid for when somebody asks for it.

import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { recruitmentDb } from "@/lib/recruitment/db";

/** The most candidates one CV search will return. Mirrored in the database function. */
export const CV_SEARCH_LIMIT = 200;

/** The shortest useful query. One character matches nearly every CV and means nothing. */
export const CV_SEARCH_MIN_LENGTH = 2;

export type CvSearchHit = {
  candidateId: string;
  /** A slice of the text that was searched, so the screen can say WHY this candidate matched. */
  matchedOn: string;
};

export type CvSearchResult = {
  query: string;
  hits: CvSearchHit[];
  /**
   * True when the result was cut off at the cap.
   *
   * Reported rather than hidden: "pharma" returns more than 200 on production today, and a list
   * silently truncated at 200 reads as a complete answer. A recruiter who believes they have seen
   * every match stops looking — which is the same failure as a search returning nothing, wearing
   * better clothes.
   */
  truncated: boolean;
};

/**
 * Candidates whose newest CV reading contains EVERY term in the query.
 *
 * ── THE PERMISSION IS THE SAME ONE THE POOL USES ────────────────────────────────────────────────
 *
 * `candidates: read`, asserted here before anything is read. Search must never become a way around
 * the gate on the pool: a caller who may not list candidates must not be able to ask "who has
 * cardiology on their CV" and get a list of ids back, which is the same disclosure by another route.
 *
 * ── AND / NOT OR ────────────────────────────────────────────────────────────────────────────────
 *
 * "pharmacist cairo" means both. Measured on staging: `pharmacist` alone returns 31 and
 * `pharmacist cairo` returns 4. An OR would have returned most of the pool for any two-word query
 * and taught the recruiter that search does not work.
 */
export async function searchCandidateCvs(
  access: AccessContext,
  query: string,
  limit: number = CV_SEARCH_LIMIT,
): Promise<CvSearchResult> {
  await assertPermission(access, "candidates", "read");

  const cleaned = String(query ?? "").trim().replace(/\s+/g, " ");
  // Short-circuited here as well as in SQL, so a one-character query costs no round trip at all.
  // The database refuses it too — this is the cheap half of the same rule, not the only half.
  if (cleaned.length < CV_SEARCH_MIN_LENGTH) {
    return { hits: [], query: cleaned, truncated: false };
  }

  const capped = Math.max(1, Math.min(limit, CV_SEARCH_LIMIT));
  // Asks for ONE more than the cap, so "there are more than this" is a fact rather than a guess.
  // Reading exactly `capped` rows cannot distinguish "exactly 200 matches" from "at least 200".
  const { data, error } = await recruitmentDb().rpc("ats_search_candidate_cvs", {
    p_limit: capped + 1,
    p_query: cleaned,
  });
  if (error) throw error;

  const rows = (data ?? []) as Array<{ candidate_id?: string | null; matched_on?: string | null }>;
  const hits = rows
    .map((row) => ({
      candidateId: String(row.candidate_id ?? ""),
      matchedOn: String(row.matched_on ?? "").trim(),
    }))
    .filter((hit) => hit.candidateId.length > 0);

  return {
    hits: hits.slice(0, capped),
    query: cleaned,
    truncated: hits.length > capped,
  };
}
