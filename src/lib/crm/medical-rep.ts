// ─────────────────────────────────────────────────────────────────────────────
// WHO COUNTS AS A MEDICAL REP — the one answer every CRM board asks for.
//
// The owner's instruction, 2026-09-03: "only show medical reps in this page",
// of the Reps Plans and KPIs boards. Both list one row per CRM agent who logged
// a visit, and the CRM has an account for anyone who ever used it — so District
// Managers, an RSM, three NSMs and a scattering of head-office people were being
// listed beside the field force they manage.
//
// Reps List is NOT in scope and needs no change: its roster comes from the
// coverage filter tree, which already drops every seat that is not `REP`
// (crm/coverage-filters.ts). This module exists so the other two boards reach
// the same answer by the same rule instead of each inventing one.
//
// ── THE RULE IS TWO ARMS, AND THE SECOND ONE IS LOAD-BEARING ────────────────
//
// The obvious implementation is `seatTier === "REP"`, which is what `scored`
// already means. Measured against production's August 2026 visits before
// writing this, that alone would have been a quiet disaster:
//
//   REP seat                              65 agents   15,476 visits   kept
//   HR id, NO org seat                    43 agents    1,577 visits   ← at risk
//   DM seat                               14 agents      495 visits   dropped
//   NSM seat                               3 agents        9 visits   dropped
//   RSM seat                               1 agent         3 visits   dropped
//   no hr id on the visit at all          47 agents       52 visits   dropped
//
// Of those 43 unseated agents, 26 hold the HR job title "Medical Representative"
// and logged 1,412 visits between them — about 9% of every rep visit that month.
// A seat-only filter deletes them from the board with no error and no marker,
// and the board still looks perfectly reasonable, which is the worst shape a
// bug of this kind can take. They are real reps whose organogram seat is
// missing, not managers.
//
// So: the SEAT answers when there is one, and the HR job title answers only when
// the organogram is silent. That ordering matters in both directions — a seated
// District Manager stays out even if his HR title is stale, and an unseated
// Medical Representative stays in.
//
// The title is still free text, and crm/call-rate-service.ts is right that a KPI
// DENOMINATOR built on it would move the moment somebody fixed a spelling. This
// is not a denominator. `scored` is untouched, so an unseated rep is listed with
// his real activity and measured against nothing, exactly as the owner ruled on
// 2026-08-28 — the title decides only whether a person is SHOWN.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Titles that are a medical rep's. Production carries exactly one spelling today
 * — "Medical Representative", on 126 employees — and no variants at all; the
 * looser match is for the ones a future import will invent ("Medical Rep",
 * "Senior Medical Representative").
 */
const MEDICAL_REP_TITLE = /\bmedical\s+rep/;

/**
 * Words that make a title a manager's whatever else it says.
 *
 * No production title matches both patterns today. This is here so that the day
 * one does — "Medical Representatives Manager" is the obvious candidate — it
 * lands OUT rather than in. The exclusion is the safe direction: a manager shown
 * on the board is a visible mistake somebody reports, and a rep hidden from it
 * is an invisible one nobody does.
 */
const MANAGER_TITLE = /\b(manager|supervisor|director|head|chief|lead)\b/;

/** Whether an HR job title is a medical rep's. Case- and spacing-insensitive. */
export function isMedicalRepJobTitle(jobTitle: string | null | undefined): boolean {
  const normalized = (jobTitle ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return false;
  if (MANAGER_TITLE.test(normalized)) return false;
  return MEDICAL_REP_TITLE.test(normalized);
}

/**
 * PURE CORE. Whether this person belongs on a medical-rep board.
 *
 * `placement` is null when the organogram has no seat for the person at all —
 * NOT when it has a seat that happens to be a manager's. Passing a seated
 * manager as null would let his HR title readmit him, which is the one way this
 * function can be got wrong from a call site.
 */
export function isMedicalRep(input: {
  placement: { hasRepSeat: boolean } | null;
  jobTitle: string | null | undefined;
}): boolean {
  // Seated: the organogram is the authority the owner maintains by hand, and it
  // outranks a directory field nobody has looked at in months.
  if (input.placement) return input.placement.hasRepSeat;
  // Unseated: the directory is the only evidence there is. No title means no
  // evidence, and no evidence means not shown.
  return isMedicalRepJobTitle(input.jobTitle);
}
