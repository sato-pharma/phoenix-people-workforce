// Recruitment — the ONE definition of "does this CV match what was typed in the pool's search box".
//
// It lives here, outside the workspace component, because two screens now have to agree about it.
// The pool searches the CVs that are still on the shelf-free half of the partition; the "also filed
// in folders" band searches the half that was taken off it. Those two answering from two copies of
// the predicate is exactly how a person becomes findable in one place and not the other — which is
// the bug this file exists to close, not a new one to introduce.
//
// WHY THE BAND EXISTS AT ALL. Filing a CV to a folder deliberately removes it from the pool: the
// owner's requirement, in his own words, is *"the CV that I push to a folder ... it is not appearing
// now on the main page."* That rule is untouched here and must stay untouched. What it never meant
// is that the person stops being findable: on 2026-09-03 the pool held 734 CVs, 150 of them filed,
// and typing a filed applicant's own name into the search box returned nothing at all — the Folders
// tab has no search of its own, so there was no screen in the application that could find them. A
// CV nobody can look up is indistinguishable from a CV that was lost, which is precisely what the
// owner reported.

import { candidateRowAppliedFor } from "@/lib/recruitment/applied-for";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * Normalize what the user typed. Returns "" when the box is effectively empty, which every caller
 * reads as "no search is running" — so an all-whitespace query never opens the filed band.
 */
export function normalizeCandidatePoolQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * The fields the pool's search box looks at, in one place.
 *
 * The DERIVED role is searched as well as the stored one. Searching "district manager" has to find
 * the rows whose only statement of it is the intake subject line, otherwise the column answers on
 * screen while the search box says there is nobody.
 */
export function candidateMatchesPoolQuery(candidate: Candidate, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return [
    candidate.fullName,
    candidate.email,
    candidate.phone,
    candidateStatusLabel(candidate.status),
    candidate.source,
    candidate.nationalId,
    candidate.appliedForJobTitle,
    candidateRowAppliedFor(candidate).text,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalizedQuery));
}
