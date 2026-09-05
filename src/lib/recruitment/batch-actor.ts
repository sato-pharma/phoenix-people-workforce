// Recruitment / ATS — telling an automated sweep apart from a person.
//
// ── WHY THIS MATTERS MORE THAN IT LOOKS ─────────────────────────────────────────────────────────
//
// `ats_candidate_status_events.actor_hr_id` holds two kinds of value: an HR id when a person moved a
// candidate, and an operation name when a script did. On 28 August 2026 the sweep
// `ops:non-egyptian-reject-20260828` rejected 65 candidates in one pass.
//
// Anything that counts "decisions" and cannot tell those apart reports a sweep as a week's work.
// That is not hypothetical: the screening throughput trend shipped without this check and showed 138
// decisions for the week of 08-29 against a true 73 — telling the owner his backlog had SHRUNK BY 69
// when it had held level at -4. Worse than a wrong number, it rewards the wrong action: a screener
// reading that week as a triumph learns that running another sweep is how the line goes down.
//
// The same artefact reached the plan for hiring analytics, where "email converts at 50% against
// WhatsApp's 16%" turned out to be 23% against 18% once the sweep was excluded — a 3x advantage that
// would have justified moving recruitment spend, and was 58 swept CVs.
//
// ── THE PREFIX IS THE CONTRACT ──────────────────────────────────────────────────────────────────
//
// Anything before the colon names the operation, and no HR id looks like this. Matching the whole
// string instead would go stale the next time a batch runs under a new name, and that batch's rows
// would silently start counting as human work again.
//
// ── AND THE ACTOR IS ON THE EVENT, NEVER THE CANDIDATE ROW ──────────────────────────────────────
//
// All 65 swept candidates carry a NULL `ats_candidates.status_changed_by_hr_id`. The marker exists
// only on the status event. A caller reading the candidate row sees null, concludes "not a batch",
// and is wrong — quietly, and about every row that matters.

export const BATCH_ACTOR_PREFIX = "ops:";

/** True when this actor is an automated operation rather than a person. */
export function isBatchActor(actor: string | null | undefined): boolean {
  return String(actor ?? "").trim().toLowerCase().startsWith(BATCH_ACTOR_PREFIX);
}
