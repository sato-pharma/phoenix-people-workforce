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
 * 🔴 EVERY EXISTING READER OF `list_type` IS A BINARY — `row.list_type === "AM" ? "AM" : "PM"` — and
 * there are **26 of them, across 17 files** (counted 2026-10-02; 25 inside `src/lib/phoenix-crm`,
 * and `server/plan-history.ts` carries two on ONE line, which is why the ratchet counts occurrences
 * and not lines).
 * Every one files a pharmacy under PM, silently, which is precisely the golden rule's failure mode,
 * and **widening the `PhoenixCrmListType` union does not catch a single one** — they all narrow to
 * `"AM" | "PM"` and keep compiling. So the compiler cannot help here and a ratchet test does the
 * work instead: `tests/phoenix-crm-pharmacy-calls.test.ts` pins the count and lets it FALL, never
 * rise, as each surface is converted to {@link parseListType} and decides for itself whether it
 * shows pharmacies at all.
 *
 * That is why the import migration is not a complete feature on its own: until a surface has been
 * converted, it would file an imported pharmacy among the doctors.
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
