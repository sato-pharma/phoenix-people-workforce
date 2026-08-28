// Recruitment / ATS — which job family a candidate's free-text current title belongs to.
//
// The owner asked to filter on "Upper Egypt district managers". Searching the title text for
// "district manager" is what the pool's search box already does, and it is wrong in both
// directions. Measured against production 2026-08-24, of the 27 people whose title says district
// manager it MISSES nine:
//
//   "district manger" / "district Manger" / "District Manger"   <- spelled that way on the CV
//   "District sales manager" / "District Sales Manager"          <- six people, no such substring
//
// and it would sweep in "Assistant Manager, Driver Performance" for anyone searching "manager".
// So the family is decided by rule, not by substring, and the misspelling is repaired before
// matching rather than being listed as its own pattern.
//
// Titles here are genuinely messy: 177 of 426 filled, free text, mixed case, Arabic, and compound
// forms joined by "|", "/" or "-" that name two jobs at once ("Medical Sales Professional |
// District Manager"). Order below is therefore most-specific-first, and every branch is anchored on
// a word the family owns rather than on a word it merely contains.

export const candidateRoleFamilies = [
  "district_manager",
  "area_regional_manager",
  "medical_rep",
  "product_manager",
  "sales",
  "pharmacist",
  "human_resources",
  "finance",
  "other",
] as const;

export type CandidateRoleFamily = (typeof candidateRoleFamilies)[number];

export const candidateRoleFamilyLabels: Record<CandidateRoleFamily, string> = {
  area_regional_manager: "Area / Regional Manager",
  district_manager: "District Manager",
  finance: "Finance & Accounting",
  human_resources: "Human Resources",
  medical_rep: "Medical Representative",
  other: "Other",
  pharmacist: "Pharmacist",
  product_manager: "Product Manager",
  sales: "Sales & Business Development",
};

/**
 * Title reduced to a comparable phrase: lowercase, punctuation and compound separators flattened to
 * single spaces, and "manger" repaired to "manager".
 *
 * The repair is deliberate and narrow. "Manger" is a real English word, but no one in a pharma
 * candidate pool holds a job called manger, and three people in production have it on their CV —
 * leaving it alone means their records are invisible to the one filter built to find them.
 */
export function normalizeJobTitle(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\bmanger\b/g, "manager")
    .replace(/\bmgr\b/g, "manager")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * The family a title belongs to. Never null: a title that matches nothing is "other", and a blank
 * title is "other" too — but callers filtering the pool must treat a BLANK title separately, since
 * "we do not know this person's job" is not the same claim as "their job is none of these".
 * `candidateRoleFamilyOrNull` below draws that line.
 */
export function candidateRoleFamily(raw: string | null | undefined): CandidateRoleFamily {
  const t = normalizeJobTitle(raw);
  if (!t) return "other";

  // District first: "Medical Sales Professional | District Manager" and "Pharmaceutical Area /
  // District Sales Manager" both name a second job that would otherwise claim them.
  if (/\bdistrict\b/.test(t) && /\bmanager|supervisor\b/.test(t)) return "district_manager";
  if (/\bdsm\b/.test(t)) return "district_manager";

  // Medical rep before area/regional, because this pool's own data equates the two names:
  // "Medical representative ( territory manager )" is one person writing both on one line.
  if (/\bmedical\s+(sales\s+)?(rep|reps|representative|representatives)\b/.test(t)) return "medical_rep";
  // Deliberately NOT a bare "mr": it is the honorific far more often than it is Medical Rep, and
  // nothing in this pool needs it — every rep here writes "medical rep" or longer.
  if (/\bmed\s+rep\b|\bmedical\s+rep\b/.test(t)) return "medical_rep";
  if (/\bproduct\s+specialist\b/.test(t)) return "medical_rep";
  if (/\bterritory\s+manager\b/.test(t)) return "medical_rep";

  // "Sales" is allowed to sit between the region word and the seniority word, and nothing else is:
  // "Regional Sales Manager" and "Area Sales Manager" are this pool's own names for the RSM/ASM
  // field-force role (see screening-order.ts's field_force band), so requiring the two words to be
  // adjacent was missing them — measured against production 2026-08-28, 12 of 345 titled candidates
  // (9 distinct titles, all "Regional/Area (Sales) Manager" shapes) were falling through to the
  // `sales` catch-all below and sorting behind every medical rep in the screening queue. Widening
  // to any word here (mirroring the district branch's two-independent-tests shape) would go too
  // far the other way: "Regional Collection Manager" also carries "regional" and "manager" but is
  // a collections role, not a field one, and stays "other" precisely because nothing here forces it.
  if (/\b(regional|area|zone|zonal)\s+(?:sales\s+)?(manager|supervisor|head)\b/.test(t)) return "area_regional_manager";
  if (/\bline\s+(manager|supervisor)\b/.test(t)) return "area_regional_manager";
  if (/\bsupervisor\s+for\s+\w+\s+line\b/.test(t)) return "area_regional_manager";

  if (/\b(product|brand|marketing)\s+manager\b/.test(t)) return "product_manager";

  // HR before finance: payroll and compensation are HR work here, and several titles carry both
  // ("Sr. Payroll & Personnel Specialist | HR Operations | Comp & Ben").
  if (/\bhr\b|\bhrbp\b|human resource|human resources/.test(t)) return "human_resources";
  if (/\bpersonnel\b|talent acquisition|\brecruit(er|ment)?\b|\bpayroll\b/.test(t)) return "human_resources";

  if (/\baccountant\b|\baccounting\b|\baccounts\b|\bfinance\b|\bfinancial\b|\btax\b|\baudit(or)?\b/.test(t)) {
    return "finance";
  }
  if (/\u0645\u062d\u0627\u0633\u0628/.test(t)) return "finance"; // محاسب — accountant

  if (/\bpharmacist\b|\bpharmacy\b/.test(t)) return "pharmacist";

  // Sales runs LAST, and that placement is the whole design of this family. Every branch above
  // names a specific job; "sales" is a word most of them also carry ("District Sales Manager",
  // "Medical sales representative", "Pharmacy Sales Representative", "DISTRICT MANAGER |
  // Pharmaceutical Sales"). Checking it last means only a title NOTHING else claimed can land
  // here, so adding this family moved nobody out of the family they already had — verified against
  // production 2026-08-24 by re-bucketing all 177 titled candidates before and after.
  //
  // \bsales\b does not match "salesforce" — there is no word boundary inside it — which is what
  // keeps "Salesforce Developer | Salesforce Technical Consultant" out of a sales bucket without
  // needing a special case. The SFE guard is a different problem: "Sales Force Effectiveness"
  // really does contain the word, but SFE is its own discipline here (the company has an SFE
  // Manager) and not a selling role, so it is excluded by name.
  //
  // Deliberately NOT here: a bare \bkam\b. Like the \bmr\b left out above, the abbreviation is
  // ambiguous and nothing in this pool needs it — the one key-account title is spelled in full.
  if (/sales\s+force\s+effectiveness|\bsfe\b/.test(t)) return "other";
  if (/\bsales\b/.test(t)) return "sales";
  if (/\bbusiness\s+development\b|\bbdm\b/.test(t)) return "sales";
  if (/\bkey\s+account\b/.test(t)) return "sales";

  return "other";
}

/**
 * Same call, but null when there is no title to judge. The pool has 249 people with no title at
 * all, and showing them under "Other" would read as a decision that was never made.
 */
export function candidateRoleFamilyOrNull(raw: string | null | undefined): CandidateRoleFamily | null {
  return normalizeJobTitle(raw) ? candidateRoleFamily(raw) : null;
}
