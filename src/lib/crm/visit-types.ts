// iReports360 visit-type codes — the CRM domain's single source of truth for
// "what kind of visit is this, and what do we call it on screen".
//
// WHY THIS FILE EXISTS. The vendor's API documents nine visit-type codes and
// sends a real `visitTypeDescription` for each. It also sends SEVEN codes it
// never documented, and for every one of those the description it sends is the
// literal string "Unknown". Measured against production on 2026-08-21 that is
// 2,965 visits: -30 (868 rows), -5 (1,633), -20 (171), -7 (148), -19 (91),
// -21 (28), -6 (26). An eighth, -16, first appeared on 2026-09-12: its first 54
// visits (8 reps, to 2026-09-17) were all commented "Training", and the owner
// ruled it Training on 2026-09-17.
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
// Visit Type filter matches the vendor's own descriptions on that column (see
// CRM_VISIT_TYPE_OPTIONS), so a stored label would change what a filter returns.
// The Vacations dataset once matched `%vacation%` there too, and storing the
// label "Vacations & Leaves" would have pulled all 1,659 public-holiday and
// casual-leave rows into it; it selects on code -4 since 2026-09-14.
//
// They are also NOT attendance or payroll semantics. Whether a code counts as a
// working day or as leave is decided by the one visit-type table in
// src/lib/crm/visit-type-meaning.ts, which every attendance and payroll map
// reads. Renaming a label here must
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
// The vendor's OWN documented meeting code, description "Meeting" (1,359 live rows on production,
// 2026-09-21). -19 is its undocumented twin — same activity, 96 rows, description "Unknown" — and
// the owner ruled on 2026-09-21 that the two are one thing and must share one dropdown entry. Kept
// as a named constant rather than a literal so the pair reads as deliberate: see
// CRM_VISIT_TYPE_FILTER_CODES, where "Meeting" selects both by code.
export const VENDOR_MEETING_TYPE = -11;
export const ADMIN_WORK_TYPE = -20;
export const BRM_TYPE = -21;
// Real field visits (doctor/pharmacy call notes) that iReports360 never assigned
// a description to. Counted as productive, same as REGULAR_TYPE ("put it in its
// normal place") — pharmacy-flavored comments get their own distinct label.
export const UNLABELED_FIELD_VISIT_TYPE = -30;
// Training that the vendor sends as "Unknown" (owner ruling 2026-09-17). Same label and
// bucket as TRAINING_TYPE; a separate constant because its stored description differs.
export const UNLABELED_TRAINING_TYPE = -16;

export type VisitBucket = "regular" | "campaign" | "training" | "admin";
export type VisitClassification = { label: string; bucket: VisitBucket };

// -7's own comments carry no single consistent meaning (owner-confirmed) — read
// the free-text comment itself to route it: "sales day" -> Health Day, a leave
// mention -> Vacations & Leaves, a meeting mention -> Meeting. Anything else
// falls back to Admin Work (no clearer signal available in the text).
function classifyAmbiguousComment(comment: string | null): string {
  const c = (comment ?? "").toLowerCase();
  if (c.includes("sales day") || c.includes("health day")) return "Health Day";
  if (c.includes("اجازه") || c.includes("اجازة") || c.includes("excuse") || c.includes("leave")) return "Vacations & Leaves";
  if (c.includes("meeting") || c.includes("اجتماع")) return "Meeting";
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
  if (type === UNLABELED_TRAINING_TYPE) return { label: "Training", bucket: "training" };
  if (type === HOLIDAY_TYPE) return { label: "Vacations & Leaves", bucket: "admin" };
  if (type === CASUAL_LEAVE_TYPE) return { label: "Vacations & Leaves", bucket: "admin" };
  if (type === VENDOR_MEETING_TYPE) return { label: "Meeting", bucket: "admin" };
  if (type === MEETING_TYPE) return { label: "Meeting", bucket: "admin" };
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
 *
 * TWO vendor entries select by code as well, for the same reason — the vendor's
 * documented code and its undocumented twin are the same activity, and a text
 * match could only ever return half of it:
 *
 *   "Training"  -9 (stored "Training") + -16 (stored "Unknown")
 *   "Meeting"  -11 (stored "Meeting")  + -19 (stored "Unknown")
 *
 * On production (2026-09-17) the stored "Training" description sat on -9 rows only
 * (298 of 298), and on 2026-09-21 the stored "Meeting" description sat on -11 rows
 * only (1,359 of 1,359, against -19's 96), so selecting both codes drops nothing
 * the text found and adds exactly the twin.
 *
 * The Meeting pair is an OWNER RULING (2026-09-21). The dropdown carried two
 * entries one letter apart — "Meeting" matching the text and "Meetings" matching
 * code -19 — which returned different rows and read as a typo. He chose to merge
 * them rather than rename one, so "Meetings" is gone from the vocabulary entirely.
 * "Group Meeting" (-2, 77 rows) is a different activity and keeps its own entry.
 */
export const CRM_VISIT_TYPE_FILTER_CODES: ReadonlyMap<string, readonly number[]> = new Map<
  string,
  readonly number[]
>([
  ["Training", [TRAINING_TYPE, UNLABELED_TRAINING_TYPE]],
  ["Vacations & Leaves", [HOLIDAY_TYPE, CASUAL_LEAVE_TYPE]],
  ["Meeting", [VENDOR_MEETING_TYPE, MEETING_TYPE]],
  ["Admin Work", [ADMIN_WORK_TYPE]],
  ["Business Review (BRM)", [BRM_TYPE]],
  ["Unlabeled Field Visit", [UNLABELED_FIELD_VISIT_TYPE]],
  ["Sales / Leave Day", [AMBIGUOUS_TYPE]],
]);

/**
 * Fixed options for the Visit Type dropdown: the vendor's documented enum, which
 * is matched against the stored description, followed by the Phoenix-resolved
 * codes above, which are matched against the numeric column. "Training" and
 * "Meeting" appear in both lists and are offered once, in their vendor position —
 * the Set below is what deduplicates them, so an entry added to the map under a
 * name the vendor already uses widens that entry instead of doubling it.
 *
 * "Unknown" is deliberately NOT here any more. It was never a kind of visit —
 * it was seven different kinds of visit wearing one name.
 */
export const CRM_VISIT_TYPE_OPTIONS: readonly string[] = [
  ...new Set([
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
  ]),
];
