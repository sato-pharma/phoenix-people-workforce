import type { VisitCountBucket } from "@/lib/crm/visit-count-buckets";

/**
 * Phoenix CRM — a PHARMACY CALL, with no I/O.
 *
 * Until now a pharmacy did not exist in Phoenix CRM as anything a rep could visit: it was a NAME he
 * typed as stock feedback ON a doctor's visit (`src/lib/phoenix-crm/day-detail.ts`). Measured on
 * production for September 2026, Delta (1) made 444 pharmacy calls — 15% of everything they did —
 * and Phoenix carried none of them, which is why a started team's Pharmacies figure has to be worded
 * "not recorded in Phoenix" rather than printed as 0 (`src/lib/crm/visit-count-buckets.ts`).
 *
 * This module is the one place that says what a pharmacy call IS, so that no surface re-derives it.
 * Everything in it is the owner's own ruling, and three of the four exist to REMOVE something a
 * reader would otherwise add by analogy with a doctor.
 *
 * ── 1. A PHARMACY IS A THIRD LIST, NEVER A ROW INSIDE AM OR PM ────────────────────────────────────
 * The AM · PM · Pharmacies golden rule (owner, 2026-09-21) is structural here rather than derived:
 * the customer's own `list_type` carries `Pharmacy`, the vendor's own spelling (`LIST_TYPES` in
 * `src/lib/crm/contacts-web-client.ts`), which is also where each rep's pharmacies are imported from.
 *
 * 🔴 EVERY READER OF `list_type` WAS A BINARY — `row.list_type === "AM" ? "AM" : "PM"` — and there
 * were **26 of them across 17 files** when the pharmacies were imported (25 inside
 * `src/lib/phoenix-crm`; `server/plan-history.ts` carried two on ONE line). Every one filed a
 * pharmacy among the DOCTORS, and **widening the `PhoenixCrmListType` union catches none of
 * them** — they all narrow to `"AM" | "PM"` and keep compiling, so the typechecker stays green
 * while the count is wrong.
 *
 * All 26 are converted, each with its own decision rather than one sweep:
 *   · {@link parseListType} where the value is a LABEL and the surface shows all three lists —
 *     the rep's list, a visit row, a customer's timeline, today's stops, what the field heard.
 *   · {@link doctorListType} where it feeds a PLAN, a capacity, a coverage or frequency figure,
 *     a grade target — and there the caller DROPS the row, because a pharmacy is in no KPI.
 * `tests/phoenix-crm-pharmacy-calls.test.ts` now holds the count at zero so it cannot come back.
 *
 * ── 2. A PHARMACY IS NEVER PLANNED ────────────────────────────────────────────────────────────────
 * Owner, 2026-10-02: *"the pharmacy is not added to the weekly plan. He can add any pharmacy, any
 * time … He don't plan it. We don't want extra."* This REVERSES his own earlier answer the same day
 * ("planned like doctors but never counted mixed with drs"), so a reader who finds that wording in a
 * hand-off note is reading the superseded half.
 *
 * It follows that there is no pharmacy row on a weekly plan, no pharmacy in the plan picker, and no
 * per-day cap for pharmacies — the cap he set that morning ("plan up to 10 pharmacies a day") was a
 * cap on PLANNING, and nothing is left for it to limit. Do not reintroduce it as a cap on visits:
 * that would be the "extra" he ruled out, and no number anywhere depends on it.
 *
 * ── 3. A PHARMACY CALL IS NEVER APPROVED ──────────────────────────────────────────────────────────
 * Owner, 2026-10-02: *"no approval for an unplanned pharmacy visit."* An off-plan DOCTOR visit waits
 * on his manager and then the SFE and counts in nothing until both agree
 * (`src/lib/phoenix-crm/unplanned-rules.ts`), because an unapproved visit would otherwise inflate a
 * figure somebody is judged on. A pharmacy call has no such figure (rule 4), so the approval would
 * protect nothing and cost the rep a step. It counts the moment it is saved.
 *
 * 🔴 This is the rule most likely to be "fixed" back, because the off-plan machinery is right next
 * door and a pharmacy call is, literally, a visit that is not on a plan. {@link visitApprovalKind}
 * exists so that the answer is given here rather than inferred there.
 *
 * ── 4. NO KPI READS A PHARMACY ────────────────────────────────────────────────────────────────────
 * Owner, 2026-10-02: *"we are not stuck to coverage of pharmacies … grab the reps' pharmacies from
 * iReports360 only as a database or as a reference, but no KPIs is counted on it."* So there is no
 * pharmacy coverage, frequency, monthly target, call rate or capacity, anywhere. The Pharmacies
 * figure of AM · PM · Pharmacies stays a PLAIN COUNT of calls made — never a rate, never a share of
 * a target, never a denominator.
 *
 * Pure: it imports one type and nothing else, so a client component may ask it as freely as a server
 * read.
 */

/** The three lists a Phoenix CRM customer can sit on. `Pharmacy` is the vendor's own spelling. */
export type PhoenixListType = "AM" | "PM" | "Pharmacy";

/** The `list_type` a pharmacy customer carries, in the database and in every payload. */
export const PHARMACY_LIST_TYPE = "Pharmacy" as const;

/** The lists a rep may put on a weekly plan. A pharmacy is deliberately not among them (rule 2). */
export const PLANNABLE_LIST_TYPES: ReadonlyArray<PhoenixListType> = ["AM", "PM"];

/**
 * The ONE parser for a stored `list_type`.
 *
 * It answers `PM` for anything it does not recognise, which is what every call site did before a
 * third list existed — so a row written by an older build still reads exactly as it used to. What it
 * will not do is swallow a pharmacy into PM.
 */
export function parseListType(value: unknown): PhoenixListType {
  if (value === "AM") return "AM";
  if (value === PHARMACY_LIST_TYPE) return PHARMACY_LIST_TYPE;
  return "PM";
}

export function isPharmacyListType(value: unknown): boolean {
  return parseListType(value) === PHARMACY_LIST_TYPE;
}

/** Whether a customer may be ticked on a weekly plan. False for a pharmacy, always (rule 2). */
export function isPlannableListType(value: unknown): boolean {
  return PLANNABLE_LIST_TYPES.includes(parseListType(value));
}

/**
 * The two halves of a rep's DAY — for a surface that measures doctors and accounts and must not see
 * a pharmacy at all: a plan, a capacity, a coverage or frequency figure, a grade target.
 *
 * It answers **null** for a pharmacy, and that is the whole point of it existing beside
 * {@link parseListType}. The binary it replaces answered `"PM"`, which is not a refusal but a wrong
 * answer — the pharmacy was counted, among the doctors, and nothing anywhere went red. A caller
 * handling `null` has to decide what to do with the row, which is the decision the binary hid.
 */
export function doctorListType(value: unknown): "AM" | "PM" | null {
  const listType = parseListType(value);
  return listType === PHARMACY_LIST_TYPE ? null : listType;
}

/** Which of the three figures a call to this customer belongs in. Never adds a pharmacy to AM or PM. */
export function visitCountBucketForListType(value: unknown): VisitCountBucket {
  const listType = parseListType(value);
  if (listType === PHARMACY_LIST_TYPE) return "Pharmacies";
  return listType;
}

/**
 * What a visit has to wait for before it counts.
 *
 *   none          — it counts the moment it is saved.
 *   manager_sfe   — his direct manager, then the SFE (the off-plan doctor visit).
 *   customer      — nothing of its own: it counts when the CUSTOMER is admitted (out of list).
 *
 * A pharmacy call is `none` whatever else is true of it — on a plan it cannot be on, off a plan it
 * was never on. That short-circuit is the whole point of asking here (rule 3).
 */
export type VisitApprovalKind = "none" | "manager_sfe" | "customer";

export function visitApprovalKind(input: {
  listType: unknown;
  /** The off-plan shape, when the visit is one. `null` for an ordinary planned visit. */
  unplannedKind?: "out_of_plan" | "out_of_list" | null;
}): VisitApprovalKind {
  if (isPharmacyListType(input.listType)) return "none";
  if (input.unplannedKind === "out_of_plan") return "manager_sfe";
  if (input.unplannedKind === "out_of_list") return "customer";
  return "none";
}

/**
 * The measures a pharmacy is kept out of (rule 4). Named rather than counted, so that adding a sixth
 * measure to the system is a decision about this list and not an oversight.
 */
export const KPIS_A_PHARMACY_IS_NEVER_IN = [
  "coverage",
  "frequency",
  "monthly_target",
  "call_rate",
  "capacity",
] as const;

export type PharmacyExcludedKpi = (typeof KPIS_A_PHARMACY_IS_NEVER_IN)[number];

/** False for every measure in {@link KPIS_A_PHARMACY_IS_NEVER_IN}. There is no exception to add. */
export function pharmacyCountsInKpi(_kpi: PharmacyExcludedKpi): false {
  return false;
}

/**
 * What the rep is told when he logs a pharmacy call. It names no approval and no plan, because there
 * is neither — and it says the one thing he might otherwise wonder about, which is whether it landed.
 */
export const PHARMACY_CALL_REP_NOTE = "Recorded. Pharmacy calls need no plan and no approval.";
