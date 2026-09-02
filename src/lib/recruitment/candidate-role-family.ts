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
  "national_sales_manager",
  "medical_rep",
  "product_manager",
  "sales",
  "pharmacist",
  "human_resources",
  "finance",
  "office_coordinator",
  "other",
] as const;

export type CandidateRoleFamily = (typeof candidateRoleFamilies)[number];

export const candidateRoleFamilyLabels: Record<CandidateRoleFamily, string> = {
  area_regional_manager: "Area / Regional Manager",
  district_manager: "District Manager",
  finance: "Finance & Accounting",
  human_resources: "Human Resources",
  medical_rep: "Medical Representative",
  national_sales_manager: "National Sales Manager",
  office_coordinator: "Office Coordinator",
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

  // National sales manager runs FIRST, because every title that holds it also holds a word another
  // family owns. Measured against production 2026-08-28, all 7 people carrying "national" landed in
  // `sales` — the catch-all that runs last — including two compound titles that name a second job
  // outright ("Head of Sales (National Sales Manager)", "Market Access & National Sales Manager")
  // and one spelled "National Sales Manger", which `normalizeJobTitle` repairs before this sees it.
  // Adding the family moves exactly those 7 out of `sales` and into field-force leadership, which is
  // what an NSM is; nobody else moves, because no other title contains the phrase.
  //
  // "National Sales Head" is included for the same reason "area/regional" accepts `head`: it is the
  // same seat under a different word. Deliberately NOT a bare \bnsm\b — like the \bmr\b and \bkam\b
  // left out further down, the abbreviation is ambiguous and nothing in this pool needs it: zero
  // candidates carry it, verified in the same measurement.
  if (/\bnational\s+sales\s+(manager|head|director)\b/.test(t)) return "national_sales_manager";

  // District first: "Medical Sales Professional | District Manager" and "Pharmaceutical Area /
  // District Sales Manager" both name a second job that would otherwise claim them.
  if (/\bdistrict\b/.test(t) && /\bmanager|supervisor\b/.test(t)) return "district_manager";
  if (/\bdsm\b/.test(t)) return "district_manager";

  // "Area (Sales) Manager/Supervisor/Head" is this industry's own name for the same first-line
  // field-manager seat Phoenix calls District Manager — not the tier above it. Owner correction,
  // 2026-08-28, reversing the area_regional_manager placement shipped hours earlier (#2502): an
  // "Area Sales Manager" candidate is a district-manager fit, and only "Regional/Zone(al)" earns
  // the seat above (see the area_regional_manager branch further down). Measured against
  // production 2026-08-28: 10 of 11 titled candidates carrying the word "area" (7 distinct
  // spellings — Area Manager, Area Sales Manager, Area Supervisor, and case/typo variants) were
  // sitting in area_regional_manager and move here; the 11th, "Pharmaceutical Area / District
  // Sales Manager", already matched the \bdistrict\b rule above and is unaffected.
  if (/\barea\s+(?:sales\s+)?(manager|supervisor|head)\b/.test(t)) return "district_manager";

  // Medical rep before area/regional, because this pool's own data equates the two names:
  // "Medical representative ( territory manager )" is one person writing both on one line.
  if (/\bmedical\s+(sales\s+)?(rep|reps|representative|representatives)\b/.test(t)) return "medical_rep";
  // Deliberately NOT a bare "mr": it is the honorific far more often than it is Medical Rep, and
  // nothing in this pool needs it — every rep here writes "medical rep" or longer.
  if (/\bmed\s+rep\b|\bmedical\s+rep\b/.test(t)) return "medical_rep";
  if (/\bproduct\s+specialist\b/.test(t)) return "medical_rep";
  if (/\bterritory\s+manager\b/.test(t)) return "medical_rep";

  // "Sales" is allowed to sit between the region word and the seniority word, and nothing else is:
  // "Regional Sales Manager" is this pool's own name for the RSM field-force role (see
  // screening-order.ts's field_force band), so requiring the two words to be adjacent was missing
  // it — measured against production 2026-08-28, 7 of 345 titled candidates (all "Regional"/"Zonal"
  // shapes) resolve here. "Area" is deliberately NOT in this alternation: see the district_manager
  // branch above, where the owner corrected that placement the same day — an "Area (Sales) Manager"
  // is a district-manager fit here, not a regional one, despite reading like a synonym at first
  // glance. Widening this to any word between the region word and the seniority word (mirroring the
  // district branch's two-independent-tests shape) would go too far the other way: "Regional
  // Collection Manager" also carries "regional" and "manager" but is a collections role, not a
  // field one, and stays "other" precisely because nothing here forces it.
  if (/\b(regional|zone|zonal)\s+(?:sales\s+)?(manager|supervisor|head)\b/.test(t)) return "area_regional_manager";
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

  // The office/admin seat, added 2026-09-02 for the Sheraton Office Coordinator opening. It runs
  // AFTER human_resources and finance deliberately: "HR & Admin Officer" is the one title in
  // production this branch would otherwise claim, and it is an HR job — the hr rule above takes it
  // first, which is why adding this family moves NOBODY out of the family they already had.
  // Measured against production 2026-09-02: of 632 candidates the patterns below match exactly one
  // title, and that title is the HR one already spoken for.
  //
  // "Secretary" and "receptionist" are here because they are the same front-office seat under this
  // industry’s own older names, and an applicant writing either is applying for this job.
  // Deliberately NOT a bare admin word on its own: it sweeps in warehouse, IT and system admins, so
  // every pattern below anchors on a second word naming the SEAT rather than the department.
  if (/\boffice\s+(coordinator|administrator|admin|manager)\b/.test(t)) return "office_coordinator";
  if (/\b(administrative|admin)\s+(coordinator|assistant|officer|specialist)\b/.test(t)) return "office_coordinator";
  if (/\bexecutive\s+(assistant|secretary)\b/.test(t)) return "office_coordinator";
  if (/\breceptionist\b|\bsecretary\b/.test(t)) return "office_coordinator";

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
