/**
 * The Arabic wording the contract needs, answered once per KIND of person instead of once per person.
 *
 * ── Why this exists ──
 * `collectHiringPackGaps` blocks the contract on `jobTitleAr` (المسمى الوظيفي) and `qualification`
 * (المؤهل). Measured on production the day this was written: 108 active employees carry only **20
 * distinct job titles** and **10 distinct education values** — and four of those ten are the same
 * answer in different letter cases (`Vet`, `vet`, `Veterinary`, `veterinary`). So the real question
 * is not 108 questions, it is about 25, asked once and reused for everybody who follows.
 *
 * ── THESE ARE THE OWNER'S WORDS. DO NOT "TIDY" THEM ──
 * Every seed below was answered by the owner on 2026-09-03, from the workbook
 * `scripts/hr-forms-arabic-questions.ts` generates. Several he rewrote, and the rewrites are the
 * point: a District Sales Manager is contracted as مدير دعاية طبية, not the literal مدير مبيعات
 * منطقة that was proposed, because that is what the trade calls the job and what the Ministry
 * expects to read. An editor who "corrects" one of these back to a more literal translation is
 * changing the wording on a signed employment contract. `tests/hr-forms-readiness.test.ts` pins
 * every one of them, so that edit fails CI rather than reaching a contract.
 *
 * `confirmed` stays in the type and is still honoured: anything ADDED later ships false and prints
 * nothing until it is answered the same way. A new job title is a new question, not a free guess.
 *
 * ── How this relates to the suggestion that already existed ──
 * `loadSuggestedJobTitleAr` already offers the Arabic title somebody typed for the same English
 * title on a previous contract, and that keeps precedence: a human answer that exists beats a seed,
 * always. This table is the fallback for the case that mechanism cannot cover — the FIRST person
 * with a given job title, where there is nothing earlier to copy.
 */

import { containsArabic } from "@/lib/geo/egypt-locations";

export type ArabicSeed = {
  /** The English value as the data actually spells it. Matched case-insensitively — see `key`. */
  en: string;
  /**
   * The proposed Arabic. INERT until `confirmed` is true.
   *
   * Written as a starting point for the owner's review, in the wording Egyptian pharmaceutical HR
   * ordinarily uses. It is a draft of an answer, not the answer.
   */
  ar: string;
  /** True only once the owner has confirmed this exact wording. Nothing else may print. */
  confirmed: boolean;
  /** How many active people carried this value when the seed was written — context for the sheet. */
  people: number;
};

/**
 * Fold a lookup value to its comparison key.
 *
 * CASE-FOLDING IS NOT COSMETIC HERE. Production holds `Science` and `science`, and `Vet`, `vet`,
 * `Veterinary` and `veterinary` — four spellings of one qualification. Keying on the raw string
 * would make the owner answer the same question four times and would still miss the fifth spelling
 * the next import invents.
 */
function key(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Arabic job titles — المسمى الوظيفي.
 *
 * `en` is spelled exactly as `employees.job_title` spells it, including the two the data gets wrong
 * (`Regulatory Affairs Supervisior`, `Qppv`). That is on purpose: this table's job is to MATCH the
 * data, not to correct it. Fixing the English spelling is a separate change to the employee record,
 * and doing it here would silently stop the lookup matching the very rows it exists for.
 */
export const JOB_TITLE_AR_SEEDS: readonly ArabicSeed[] = [
  { en: "Medical Representative", ar: "مندوب دعاية طبية", confirmed: true, people: 70 },
  { en: "District Sales Manager", ar: "مدير دعاية طبية", confirmed: true, people: 16 }, // his wording, not the proposal
  { en: "National Sales Manager", ar: "مدير مبيعات طبية", confirmed: true, people: 3 }, // his wording, not the proposal
  { en: "Admin Assistant", ar: "مساعد إداري", confirmed: true, people: 2 },
  { en: "Product Manager", ar: "مدير تسويق", confirmed: true, people: 2 }, // his wording, not the proposal
  { en: "Buffet", ar: "عامل بوفيه", confirmed: true, people: 1 },
  { en: "Ceo", ar: "الرئيس التنفيذي", confirmed: true, people: 1 },
  { en: "Finance and Admin Manager", ar: "مدير الشئون المالية والإدارية", confirmed: true, people: 1 },
  { en: "Financial Advisor", ar: "مستشار مالي", confirmed: true, people: 1 },
  { en: "Group Product Manager", ar: "مدير تسويق", confirmed: true, people: 1 }, // his wording, not the proposal
  { en: "HR Business Partner", ar: "مشرف موارد بشرية", confirmed: true, people: 1 }, // his wording, not the proposal
  { en: "HR Operations Coordinator", ar: "اخصائي موارد بشرية", confirmed: true, people: 1 }, // his wording, not the proposal
  // 2026-10-20: the holder of the title above moved to the new HR Operations Specialist seat and
  // carries the SAME Arabic he confirmed for her — the company still contracts her as an HR
  // specialist. The row above stays: contracts already signed name it, and this table matches the
  // data rather than correcting it.
  { en: "HR Operations Specialist", ar: "اخصائي موارد بشرية", confirmed: true, people: 1 }, // his wording, carried with her
  // The old seat's new title. Nobody holds it yet; the Arabic is the owner's own pick, 2026-10-20,
  // for whoever is hired into it.
  { en: "HR Generalist", ar: "أخصائي موارد بشرية", confirmed: true, people: 0 }, // his wording
  // His own title, 2026-10-09: "give HR Manager the Arabic مدير ادارة الموارد البشرية". He was
  // promoted from HR Section Head that day and `employees.job_title` for B-10 moved with it, so the
  // seed has to move too — this table matches `employees.job_title` exactly, and a title with no
  // seed prints an HR paper with no المسمى الوظيفي.
  { en: "HR Manager", ar: "مدير ادارة الموارد البشرية", confirmed: true, people: 1 }, // his wording, not the proposal
  // Nobody holds this title any more — measured on production the same day, `employees.job_title`
  // returns ZERO rows for it, which is why the count reads 0 rather than the 1 of 2026-09-03. The
  // row stays because it is the seat he is RECRUITING for: the next holder's wording is his to give,
  // and until then carrying the same Arabic as HR Manager is deliberate, not a copy-paste.
  { en: "HR Section Head", ar: "مدير ادارة الموارد البشرية", confirmed: true, people: 0 }, // his wording, not the proposal
  { en: "Marketing Manager", ar: "مدير التسويق", confirmed: true, people: 1 },
  { en: "Qppv", ar: "المسئول عن التيقظ الدوائي", confirmed: true, people: 1 },
  { en: "R And D Manager", ar: "مدير البحث والتطوير", confirmed: true, people: 1 },
  { en: "Regional Sales Manager", ar: "مدير مبيعات إقليمي", confirmed: true, people: 1 },
  { en: "Regulatory Affairs Supervisior", ar: "مشرف الشئون التنظيمية", confirmed: true, people: 1 },
  { en: "Sfe Manager", ar: "مدير فعالية القوى البيعية", confirmed: true, people: 1 },
  { en: "Training Manager", ar: "مدير التدريب", confirmed: true, people: 1 },

  // ── Answered 2026-09-06, from `xlsx/arabic-job-titles-outstanding-2026-09-06.xlsx` ────────────
  //
  // The 2026-09-06 backfill wrote his 2026-09-03 answers onto 176 of 185 employees and could not
  // answer these five, so they went back to him as a workbook. Four he accepted as proposed; the
  // fifth he reworded, and the rewording is the point again — see `Talent Acquisition` below.
  //
  // 🔴 TWO OF THESE ARE NEW ROWS FOR A JOB THAT ALREADY HAD AN ANSWER, and that is deliberate.
  // `R&D Manager` is the same job as `R And D Manager` above and carries the identical Arabic; the
  // employee record simply spells it with an ampersand, and `key()` folds case and whitespace but
  // NOT punctuation, so the existing row could never match it. The same goes for `Admin Assist`
  // against `Admin Assistant`. EDITING the older row instead would have been wrong twice over: it
  // is the wording on contracts already signed against it, and this table's stated job is to MATCH
  // the data rather than to correct it. Two rows, one answer, no row rewritten.
  // Nobody holds "R&D Manager" since 2026-11-10: the owner renamed Dr. Sahar Khalil's seat (the
  // position keeps its code r_and_d_manager). The row stays, because papers already signed carry it.
  { en: "R&D Manager", ar: "مدير البحث والتطوير", confirmed: true, people: 0 },
  // THE OWNER'S OWN WORDING, 2026-11-11, for the title he gave that seat on 2026-11-10. `en` must
  // match employees.job_title character for character, brackets included: `key()` does not fold
  // punctuation. Do not "simplify" it to a literal rendering of "toll manufacturing".
  { en: "Toll Manufacturing Manager (TMM)", ar: "مدير التصنيع لدى الغير", confirmed: true, people: 1 },
  { en: "Regulatory Affairs", ar: "أخصائي الشئون التنظيمية", confirmed: true, people: 2 },
  // HIS WORDING, NOT THE PROPOSAL. The draft read أخصائي استقطاب المواهب, a literal rendering of
  // "talent acquisition". He answered اخصائي موارد بشرية — the same title he confirmed for
  // `HR Operations Coordinator` on 2026-09-03: the company contracts this person as an HR
  // specialist, and that is what the Ministry expects to read. Do not "restore" the literal one.
  { en: "Talent Acquisition", ar: "اخصائي موارد بشرية", confirmed: true, people: 1 },
  { en: "Office Coordinator", ar: "منسق إداري", confirmed: true, people: 1 },
  { en: "Admin Assist", ar: "مساعد إداري", confirmed: true, people: 1 },
];

/**
 * Qualifications — المؤهل.
 *
 * The stored values are faculty names rather than degrees (`Science`, `Pharmacy`), and the form asks
 * for the qualification, so each proposal names the degree the faculty grants. The case variants
 * collapse through `key`, which is why `vet` and `Veterinary` are not separate rows.
 *
 * One live value is ALREADY Arabic — a free-text degree somebody typed in full. `resolveQualification
 * Ar` returns any Arabic value unchanged rather than looking it up, so a value that is already the
 * answer does not need a seed and does not need the owner's time.
 */
export const QUALIFICATION_AR_SEEDS: readonly ArabicSeed[] = [
  { en: "Science", ar: "بكالوريوس علوم", confirmed: true, people: 49 },
  { en: "Pharmacy", ar: "بكالوريوس صيدلة", confirmed: true, people: 19 },
  { en: "Vet", ar: "بكالوريوس طب بيطري", confirmed: true, people: 16 },
  { en: "Dentist", ar: "بكالوريوس طب أسنان", confirmed: true, people: 2 },
  { en: "Commerce", ar: "بكالوريوس تجارة", confirmed: true, people: 1 },
];

/**
 * `Veterinary` and `veterinary` are the same qualification as `Vet`, spelled out.
 *
 * Kept as an explicit alias list rather than by adding rows, so the owner is asked about the
 * QUALIFICATION once and the data's spelling drift stays a data problem rather than becoming three
 * more questions. A new spelling added here needs no new confirmation — it points at a seed he has
 * already answered.
 */
const QUALIFICATION_ALIASES: Readonly<Record<string, string>> = {
  veterinary: "Vet",
  "veterinary medicine": "Vet",
  vetrinary: "Vet",
  "faculty of science": "Science",
  "faculty of pharmacy": "Pharmacy",
  pharmacist: "Pharmacy",
  dentistry: "Dentist",
};

function findSeed(seeds: readonly ArabicSeed[], value: string | null | undefined): ArabicSeed | null {
  const wanted = key(value);
  if (!wanted) return null;
  return seeds.find((seed) => key(seed.en) === wanted) ?? null;
}

/**
 * The Arabic job title for an English one, or null when there is no CONFIRMED answer.
 *
 * Null is the honest answer for both "no seed" and "seed not yet confirmed", because both mean the
 * same thing to the caller: the gap stands and a human has to supply it.
 */
export function resolveJobTitleAr(englishJobTitle: string | null | undefined): string | null {
  const seed = findSeed(JOB_TITLE_AR_SEEDS, englishJobTitle);
  return seed?.confirmed ? seed.ar : null;
}

/**
 * The Arabic qualification for a stored education value, or null when there is no confirmed answer.
 *
 * A value that is already Arabic is returned unchanged — somebody wrote the answer directly into the
 * employee record and there is nothing to translate.
 */
export function resolveQualificationAr(education: string | null | undefined): string | null {
  const raw = String(education ?? "").trim();
  if (!raw) return null;
  if (containsArabic(raw)) return raw;

  const aliased = QUALIFICATION_ALIASES[key(raw)] ?? raw;
  const seed = findSeed(QUALIFICATION_AR_SEEDS, aliased);
  return seed?.confirmed ? seed.ar : null;
}

/** Every seed still waiting on the owner, for the question workbook and for the readiness board. */
export function unconfirmedSeeds(): { jobTitles: ArabicSeed[]; qualifications: ArabicSeed[] } {
  return {
    jobTitles: JOB_TITLE_AR_SEEDS.filter((seed) => !seed.confirmed),
    qualifications: QUALIFICATION_AR_SEEDS.filter((seed) => !seed.confirmed),
  };
}

/**
 * How many questions on the sheet are still unanswered.
 *
 * A COUNT OF QUESTIONS, NOT OF PEOPLE, and that distinction is the whole reason this is not the
 * obvious thing. Summing `people` across both lists reaches 195 against a headcount of 108, because
 * somebody missing both their job title and their qualification is counted once on each list. Put on
 * a board beside "108 active employees", that number is not merely useless — it is wrong in the
 * direction that makes the backlog look worse than it is. The PEOPLE figure is counted from the rows
 * instead, in `summarizeReadiness`, where each person is one person.
 */
export function arabicAnswersOutstanding(): number {
  const waiting = unconfirmedSeeds();
  return waiting.jobTitles.length + waiting.qualifications.length;
}

/** Exposed so the question script and the tests agree on how a value is matched. */
export const lookupKey = key;
