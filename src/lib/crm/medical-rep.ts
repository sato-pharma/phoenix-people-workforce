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
// ── THIS FILE IS THE ONLY ANSWER. THERE WERE BRIEFLY TWO ────────────────────
//
// Two implementations of "medical reps only" shipped within a minute of each
// other on 2026-09-03 — this one, and `isMedicalRepTitle` in crm/kpis-filters.ts
// from the KPIs premium rebuild. They were written on parallel branches against
// the same owner instruction and neither author saw the other. They agreed on
// every live row and disagreed on one branch, which is the exact shape of drift
// that got Doctor Coverage retired: two boards answering one question, agreeing
// until the day they do not, with nothing on screen to say which is right.
//
// Consolidated here on 2026-09-03. crm/kpis-filters.ts now holds no rule of its
// own — it stays dependency-free, and this module imports nothing, so a
// `"use client"` filter bar can still reach it without dragging a server module
// graph into the browser bundle.
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
//
// ── AND NO SEAT PLUS NO TITLE IS THE THIRD ARM ──────────────────────────────
//
// This is the one branch the two implementations answered differently, so it is
// worth being exact about who is in it. The KPIs version KEPT an unrecorded
// title, reasoning that "a CRM agent with no matching employee record" would
// otherwise be "removed from his own manager's board with no error and no
// marker". That instinct is the right one, and it is the instinct this whole
// file is built on. But measured against production on 2026-09-03, the
// population it describes does not exist, and the population that IS there
// cannot reach a manager's board at all. Every CRM agent that logged a visit
// since 1 August:
//
//   hr id -> employee -> job title recorded     126 agents   18,684 visits
//   hr id, but NO employee record                 0 agents
//   employee record, but NO job title             0 agents
//   no hr id on the visit at all                 45 agents        67 visits
//
// The middle two buckets are EMPTY, so a row carrying an hr id always has a
// title and can never reach this arm. The only way in is the last bucket — and
// 43 of those 45 are CRM territory placeholders rather than people
// ("( Sharkia 2 / F )", "Main Store ( Others MR / F )", "Shobra"), each holding
// exactly one visit on one day. The other two are real reps whose CRM account
// has not been mapped to an hr id yet, and both are already hidden upstream by
// the departed-agent exclusion in crm/reads.ts.
//
// Such an agent is invisible to every scope except `company` — isAgentInScope
// fails closed without a key — so he has no manager's board to be dropped from,
// only the company-wide one. And an unidentifiable agent already has a channel
// louder than a board row: the unmapped-agent alert in crm/admin.ts selects on
// `agent_hr_id IS NULL` precisely so this is REPORTED rather than inferred from
// a short board. reads.ts puts it the same way — until the roster row exists,
// "their visits show as unmapped, which is the honest state".
//
// So: not shown. Being invisibly too strict is genuinely worse than being
// visibly too generous — that is why the seat arm has a title fallback at all.
// But this arm is not that trade. It is a row nobody can attribute to anybody,
// kept off a board that names people, and reported where unmapped agents belong.
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

/**
 * Narrow a board's rows to the medical reps, for a caller with NO organogram to consult.
 *
 * The KPIs board is that caller: it joins the call rate to the doctor lists and stamps the employee
 * directory over the result, and the seat model never enters it. Every row there takes the title
 * arm — which is what `placement: null` says out loud, rather than leaving the next reader to infer
 * it from the absence of a field.
 *
 * Call it at the SOURCE, before facets and totals are built, never as a preselected filter chip.
 * The whole page then describes one population: the "Showing X of Y" denominator, the gauge tiles,
 * the podiums and each tab's headline all count the same people. A chip would leave the totals
 * describing one population and the table another — the version of this that goes unnoticed. It
 * also puts the narrowing ABOVE the filter layer, so no query string can undo it.
 *
 * Measured on production 2026-09-03 at Super Admin scope, the September board was 70 rows: 63
 * medical representatives kept, 6 district sales managers and 1 product manager dropped. A manager
 * carries no doctor plan of his own, so he lands at "No plan" on two of the three measures and
 * drags the team averages toward a number that describes nobody.
 *
 * That still holds for the REP rows. Since 2026-10-20 (owner: "add manager row and every dm kpis is
 * calculated based on his reps averag") the KPIs board also lists its managers — but as a separate
 * list of AVERAGES of the rep rows this function keeps (crm/kpis-manager-rows.ts), never by letting a
 * manager back through here, so his own thin CRM activity is still never scored as a rep's.
 */
export function keepMedicalRepsOnly<T extends { jobTitle: string | null }>(rows: readonly T[]): T[] {
  return rows.filter((row) => isMedicalRep({ placement: null, jobTitle: row.jobTitle }));
}
