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
  "hr_section_head",
  "talent_acquisition",
  "finance",
  "office_coordinator",
  // Added 2026-10-31 for the Personnel Specialist / Senior Personnel Specialist opening (Sheraton).
  "personnel",
  "other",
] as const;

export type CandidateRoleFamily = (typeof candidateRoleFamilies)[number];

export const candidateRoleFamilyLabels: Record<CandidateRoleFamily, string> = {
  area_regional_manager: "Area / Regional Manager",
  district_manager: "District Manager",
  finance: "Finance & Accounting",
  hr_section_head: "HR Section Head",
  human_resources: "Human Resources",
  medical_rep: "Medical Representative",
  national_sales_manager: "National Sales Manager",
  office_coordinator: "Office Coordinator",
  other: "Other",
  personnel: "Personnel Specialist",
  pharmacist: "Pharmacist",
  product_manager: "Product Manager",
  sales: "Sales & Business Development",
  talent_acquisition: "Talent Acquisition",
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

  // HR Section Head, added 2026-10-06 for the HR Section Head opening (the seat under the HR Manager
  // that leads Talent Acquisition, Personnel and the Office Coordinator). It runs BEFORE Talent
  // Acquisition and Human Resources because a title naming the section-head seat is the applied-for
  // job even when it also says HR or recruitment. Deliberately NARROW: it needs "section" next to
  // head/manager/lead/chief and an HR word, so "HR Manager", "Head of HR" and "Sales Section Head"
  // keep the family they already had — nobody moves out of a bucket except the exact seat.
  if (/\b(hr|human\s+resources?)\s+section\s+(head|manager|lead|chief)\b/.test(t)) return "hr_section_head";
  if (/\bsection\s+(head|manager|lead|chief)\s+(of\s+|for\s+)?(hr|human\s+resources?)\b/.test(t)) {
    return "hr_section_head";
  }

  // Talent Acquisition before the HR families, added 2026-09-22 for the TA Specialist opening. A
  // recruiter IS an HR seat, but the owner wants these CVs in their own bucket rather than folded
  // into Human Resources, so a title that names the recruiting work outright ("Talent Acquisition
  // Specialist", "Senior Recruiter", "Recruitment Coordinator") lands here — including one that
  // also says HR ("Talent Acquisition & HR Manager"), because the specific word is the applied-for
  // job. Payroll and personnel are NOT here: they are HR operations, not recruiting — their own family below.
  if (/talent\s+acquisition|\brecruit(er|ment|ing)?\b/.test(t)) return "talent_acquisition";

  // Personnel before the generic HR words, added 2026-10-31 for the Personnel Specialist / Senior
  // Personnel Specialist opening. Payroll and personnel administration are that seat's work, so a
  // title naming either ("Sr. Payroll & Personnel Specialist | HR Operations | Comp & Ben", "HR &
  // Payroll Officer") is the applied-for job even when it also says HR — the reasoning that put
  // Talent Acquisition above. It stays AFTER Talent Acquisition, so "Personnel & Recruitment
  // Specialist" keeps the recruiting family it had, and after the section-head seat.
  // HR before finance still holds: payroll and compensation are HR work here, never Finance.
  if (/\bpersonnel\b|\bpayroll\b/.test(t)) return "personnel";
  if (/\bhr\b|\bhrbp\b|human resource|human resources/.test(t)) return "human_resources";

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
 * SEAT NOUNS — the words that make a piece of text a JOB rather than a sentence.
 *
 * This list answers a different question from `candidateRoleFamily` above and must not be confused
 * with it. That function asks *which of our eleven families is this* and always answers, because
 * "other" is a real answer for a real job. This asks *is this a job at all*, and it exists because
 * one caller — the automated folder suggestion — names a FOLDER after the text and therefore cannot
 * treat "we could not place it" and "this is not a job title" as the same thing.
 *
 * A title is a noun phrase built around a seat: Regulatory Affairs SPECIALIST, Technical Support and
 * infrastructure ENGINEER, Project - Account MANAGER. A WhatsApp reply is not: "بخصوص الإعلان دا"
 * ("regarding this ad") names no seat, and neither does "reservation (arrange & book hotels
 * accommodation for employees)", which describes duties. Both are real production values sitting in
 * `applied_for_job_title` today.
 *
 * DEPARTMENTS ARE DELIBERATELY ABSENT. "Quality", "regulatory", "logistics" and the rest name a part
 * of a company, not a seat in it, and a bare department is genuinely ambiguous — refusing it and
 * letting a recruiter name the folder is the right answer, not a gap. The departments that DO matter
 * here are already covered one level up, because `candidateRoleFamily` claims them by pattern:
 * anything carrying sales, marketing, pharmacy, HR, finance or accounting resolves to a family
 * before this list is ever consulted.
 *
 * English entries are matched as WHOLE WORDS against the normalised text's own tokens. Arabic
 * entries are matched as SUBSTRINGS instead, because the word arrives carrying prefixes and
 * suffixes a token comparison would miss — "الصيدلي" is the same seat as "صيدلي" — and because `\b`
 * in JavaScript is defined over ASCII word characters, so a word-boundary escape around an Arabic
 * word does not mean what it reads as.
 */
const occupationSeatWords = [
  "accountant", "administrator", "adviser", "advisor", "agent", "analyst", "architect",
  "assistant", "associate", "attendant", "auditor", "buyer", "cashier", "chemist", "clerk",
  "consultant", "controller", "coordinator", "designer", "developer", "dietitian", "director",
  "doctor", "driver", "editor", "engineer", "executive", "head", "inspector", "instructor",
  "intern", "interpreter", "lawyer", "lead", "leader", "lecturer", "manager", "nurse", "officer",
  "operator", "paramedic", "pharmacist", "physician", "physiotherapist", "planner", "practitioner",
  "professor", "programmer", "promoter", "receptionist", "rep", "reps", "representative",
  "researcher", "scientist", "secretary", "specialist", "storekeeper", "supervisor", "surveyor",
  "teacher", "technician", "technologist", "therapist", "trainee", "trainer", "translator",
  "treasurer", "tutor", "veterinarian", "writer",
] as const;

/** The same question in Arabic, matched as substrings — see the note above. */
const occupationSeatWordsArabic = [
  "\u0645\u062d\u0627\u0645", // محام — the stem shared by محامي and المحامي (lawyer); one in production
  "\u0645\u0646\u062f\u0648\u0628", // مندوب — representative
  "\u0645\u0645\u062b\u0644", // ممثل — representative
  "\u0645\u062f\u064a\u0631", // مدير — manager
  "\u0645\u0634\u0631\u0641", // مشرف — supervisor
  "\u0623\u062e\u0635\u0627\u0626\u064a", // أخصائي — specialist
  "\u0627\u062e\u0635\u0627\u0626\u064a", // اخصائي — the same word without the hamza, as typed
  "\u0635\u064a\u062f\u0644", // صيدل — the stem shared by صيدلي and صيدلاني (pharmacist)
  "\u0645\u062d\u0627\u0633\u0628", // محاسب — accountant
  "\u0645\u0647\u0646\u062f\u0633", // مهندس — engineer
  "\u0641\u0646\u064a", // فني — technician
  "\u0633\u0643\u0631\u062a\u064a\u0631", // سكرتير — secretary
  "\u0645\u0648\u0638\u0641", // موظف — employee / clerk
  "\u0637\u0628\u064a\u0628", // طبيب — doctor
  "\u0645\u0645\u0631\u0636", // ممرض — nurse
  "\u0633\u0627\u0626\u0642", // سائق — driver
  "\u0645\u0633\u0624\u0648\u0644", // مسؤول — officer / person responsible
  "\u0645\u0633\u0626\u0648\u0644", // مسئول — the same word, the other spelling
] as const;

/**
 * Does this text name a job?
 *
 * TRUE whenever `candidateRoleFamily` can already place it — every pattern in that function names a
 * seat, so a title it claims is a title by construction — or when the text carries a seat noun of
 * its own. FALSE for a blank, for a sentence, and for a description of duties.
 *
 * WHY A REFUSAL IS THE SAFE ANSWER, and why this list being incomplete is survivable: the only
 * caller is the automated suggestion, and the cost of answering FALSE about a real title is that
 * the CV stays in the pool with the reason on screen for a recruiter to file by hand — one field,
 * free text, unchanged by any of this. The cost of answering TRUE about a WhatsApp reply is a
 * folder named after that reply, sitting beside the real ones, that nobody ever opens. Those two
 * are not symmetrical, so this list may grow but must never become a guess.
 */
export function namesAnOccupation(raw: string | null | undefined): boolean {
  const t = normalizeJobTitle(raw);
  if (!t) return false;
  if (candidateRoleFamily(t) !== "other") return true;
  // WHOLE WORDS, by set membership rather than a regex. `normalizeJobTitle` has already reduced the
  // text to lowercase words separated by single spaces, so the words ARE the tokens — which makes
  // "rep" firing inside "prepare" impossible without needing a word-boundary escape at all. That
  // matters beyond tidiness: the first draft of this line used one, a heredoc ate the backslash
  // (AGENTS.md §2.1), and the surviving `\b` matched NOTHING — every real title was refused and the
  // code read as correct. A Set cannot fail that way.
  const words = new Set(t.split(" "));
  if (occupationSeatWords.some((word) => words.has(word))) return true;
  return occupationSeatWordsArabic.some((word) => t.includes(word));
}

/**
 * Same call, but null when there is no title to judge. The pool has 249 people with no title at
 * all, and showing them under "Other" would read as a decision that was never made.
 */
export function candidateRoleFamilyOrNull(raw: string | null | undefined): CandidateRoleFamily | null {
  return normalizeJobTitle(raw) ? candidateRoleFamily(raw) : null;
}
