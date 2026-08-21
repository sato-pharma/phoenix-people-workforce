// iReports360 visit-type codes — the CRM domain's single source of truth for
// "what kind of visit is this, and what do we call it on screen".
//
// WHY THIS FILE EXISTS. The vendor's API documents nine visit-type codes and
// sends a real `visitTypeDescription` for each. It also sends SEVEN codes it
// never documented, and for every one of those the description it sends is the
// literal string "Unknown". Measured against production on 2026-08-21 that is
// 2,965 visits: -30 (868 rows), -5 (1,633), -20 (171), -7 (148), -19 (91),
// -21 (28), -6 (26).
//
// Phoenix has known what those seven mean since 2026-07-14 (PR #1061, confirmed
// with the business owner by reading the actual `comment` text on hundreds of
// sample rows — not guessed). But that knowledge lived inside Employee 360, so
// Employee 360 showed "Admin Work" while the CRM master, the employee portal,
// the NSM compliance board and SFE analytics all still showed "Unknown" for the
// very same row. Three separate label maps had grown up in parallel and
// disagreed. This module is the one they now share.
//
// WHAT THIS FILE MUST NOT BECOME. These labels are for DISPLAY. They are never
// written back to `ireports360_visits.visit_type_description` — the CRM master's
// vacation dataset selects on `.ilike("visit_type_description", "%vacation%")`,
// so storing the label "Vacations & Leaves" would silently pull all 1,659
// public-holiday and casual-leave rows into the Vacations dataset.
//
// They are also NOT attendance or payroll semantics. Whether a code counts as a
// working day or as leave is decided by VISIT_TYPE_TO_STATUS in
// src/lib/field-workforce-compliance/ireports360-source.ts (and its documented
// copy in src/lib/automated-payroll/recommend.ts). Renaming a label here must
// never change what an employee is paid; that mapping is owner-confirmed and is
// deliberately not imported from this file.

export const REGULAR_TYPE = 0;
export const CAMPAIGN_TYPE = -8;
export const TRAINING_TYPE = -9;

// Additional iReports360 visit-type codes that come back from the CRM's own API
// with the literal description "Unknown" (confirmed against production comment
// text with the business owner, 2026-07-14 — see PR #1061). Each was identified
// by reading the actual `comment` field on hundreds of sample rows, not guessed.
export const HOLIDAY_TYPE = -5;
export const CASUAL_LEAVE_TYPE = -6;
export const AMBIGUOUS_TYPE = -7; // split at runtime by comment text — see classifyAmbiguousComment
export const MEETING_TYPE = -19;
export const ADMIN_WORK_TYPE = -20;
export const BRM_TYPE = -21;
// Real field visits (doctor/pharmacy call notes) that iReports360 never assigned
// a description to. Counted as productive, same as REGULAR_TYPE ("put it in its
// normal place") — pharmacy-flavored comments get their own distinct label.
export const UNLABELED_FIELD_VISIT_TYPE = -30;

export type VisitBucket = "regular" | "campaign" | "training" | "admin";
export type VisitClassification = { label: string; bucket: VisitBucket };

// -7's own comments carry no single consistent meaning (owner-confirmed) — read
// the free-text comment itself to route it: "sales day" -> Health Day, a leave
// mention -> Vacations & Leaves, a meeting mention -> Meetings. Anything else
// falls back to Admin Work (no clearer signal available in the text).
function classifyAmbiguousComment(comment: string | null): string {
  const c = (comment ?? "").toLowerCase();
  if (c.includes("sales day") || c.includes("health day")) return "Health Day";
  if (c.includes("اجازه") || c.includes("اجازة") || c.includes("excuse") || c.includes("leave")) return "Vacations & Leaves";
  if (c.includes("meeting") || c.includes("اجتماع")) return "Meetings";
  return "Admin Work";
}

// "ص" (short for صيدلية/pharmacy) as its own token before a name is the reps'
// own shorthand for a pharmacy call (e.g. "ص السلامه", "ص. نور الرحمن"), seen
// consistently across -30 sample comments alongside "فارما"/"pharmacy". Best
// effort against free text — not perfect, but never fabricates a category.
const PHARMACY_COMMENT_PATTERN = /(^|\s)ص[\s.]|صيدلي|فارما|pharmacy/iu;
function isPharmacyComment(comment: string | null): boolean {
  return PHARMACY_COMMENT_PATTERN.test(comment ?? "");
}

// Single source of truth for "what is this visit" — both its display label
// (Activity Mix) and which counting bucket it belongs to (productive/admin/etc).
// Every place that used to compare visit_type directly must go through this
// so the two can never drift apart again.
export function classifyVisit(type: number | null, comment: string | null, rawDescription: string | null): VisitClassification {
  if (type === REGULAR_TYPE) return { label: "Regular", bucket: "regular" };
  if (type === CAMPAIGN_TYPE) return { label: "Campaign", bucket: "campaign" };
  if (type === TRAINING_TYPE) return { label: "Training", bucket: "training" };
  if (type === HOLIDAY_TYPE) return { label: "Vacations & Leaves", bucket: "admin" };
  if (type === CASUAL_LEAVE_TYPE) return { label: "Vacations & Leaves", bucket: "admin" };
  if (type === MEETING_TYPE) return { label: "Meetings", bucket: "admin" };
  if (type === ADMIN_WORK_TYPE) return { label: "Admin Work", bucket: "admin" };
  if (type === BRM_TYPE) return { label: "Business Review (BRM)", bucket: "admin" };
  if (type === AMBIGUOUS_TYPE) return { label: classifyAmbiguousComment(comment), bucket: "admin" };
  if (type === UNLABELED_FIELD_VISIT_TYPE) {
    return isPharmacyComment(comment) ? { label: "Pharmacy Visit", bucket: "regular" } : { label: "Regular", bucket: "regular" };
  }
  const trimmed = (rawDescription ?? "").trim();
  const label = trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : `Type ${type ?? "?"}`;
  return { label, bucket: "admin" };
}

/** The vendor's placeholder for "I have no description for this code". */
const VENDOR_UNKNOWN = "unknown";

/**
 * The label to SHOW a human for a visit.
 *
 * The vendor's own description always wins when it says anything real — this is
 * not a rename of the documented enum, and a Regular Visit still reads "Regular
 * Visit". It only fills the gap: when the vendor sends "Unknown" (or nothing at
 * all), fall back to what Phoenix already established the numeric code means.
 *
 * `comment` matters because two of the seven codes are only separable by the
 * rep's own free text — see classifyAmbiguousComment (-7) and isPharmacyComment
 * (-30). Pass it when the caller has it; passing null is safe and simply yields
 * the code's default label.
 */
export function resolveVisitTypeLabel(
  visitType: number | null | undefined,
  description: string | null | undefined,
  comment: string | null | undefined,
): string {
  const vendor = (description ?? "").trim();
  if (vendor && vendor.toLowerCase() !== VENDOR_UNKNOWN) return vendor;
  return classifyVisit(visitType ?? null, comment ?? null, description ?? null).label;
}

/**
 * The Visit Type filter entries that select on the numeric `visit_type` column
 * instead of the stored description, and the codes each one covers.
 *
 * These exist because the stored description for all seven is the same useless
 * string "Unknown" — filtering on the text can only ever return "all of them at
 * once", which is why the old dropdown had a single "Unknown" entry.
 *
 * Two entries are code-grouped rather than label-exact, because their rows are
 * split by comment text at render time: a -7 row displays whichever of Health
 * Day / Vacations & Leaves / Meetings / Admin Work its comment routes it to, and
 * a -30 row displays "Pharmacy Visit" or "Regular". Selecting these returns every
 * row of that code, which is the useful answer; the per-row label stays honest.
 */
export const CRM_VISIT_TYPE_FILTER_CODES: ReadonlyMap<string, readonly number[]> = new Map<
  string,
  readonly number[]
>([
  ["Vacations & Leaves", [HOLIDAY_TYPE, CASUAL_LEAVE_TYPE]],
  ["Meetings", [MEETING_TYPE]],
  ["Admin Work", [ADMIN_WORK_TYPE]],
  ["Business Review (BRM)", [BRM_TYPE]],
  ["Unlabeled Field Visit", [UNLABELED_FIELD_VISIT_TYPE]],
  ["Sales / Leave Day", [AMBIGUOUS_TYPE]],
]);

/**
 * Fixed options for the Visit Type dropdown: the vendor's documented enum, which
 * is matched against the stored description, followed by the Phoenix-resolved
 * codes above, which are matched against the numeric column.
 *
 * "Unknown" is deliberately NOT here any more. It was never a kind of visit —
 * it was seven different kinds of visit wearing one name.
 */
export const CRM_VISIT_TYPE_OPTIONS: readonly string[] = [
  "Regular Visit",
  "Campaign (Prospection)",
  "Meeting",
  "Group Meeting",
  "Conference",
  "Training",
  "Health Day",
  "Traveling",
  "Annual Vacation",
  ...CRM_VISIT_TYPE_FILTER_CODES.keys(),
];
