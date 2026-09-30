// Recruitment / ATS — the ONE mapping from a CV to the boxes on HR's "Add Employee" form.
//
// ── Why this module exists at all ────────────────────────────────────────────────────────────────
//
// Add Employee has THREE doors, and until now each carried a different amount of the person:
//
//   ?fromApplication=<id>   the CV and the offer          (buildHireDraft — 17 fields)
//   ?fromOffer=<id>         the LETTER only               (buildOfferHireDraft — 10 fields,
//                                                          not ONE of them personal)
//   the seat's candidate picker on the form itself        (ten fields, hand-listed)
//
// So hiring the same person through the offer door meant typing their national id, birth date,
// mobile, address and every education field by hand, while the CV that holds all of it sat one
// table away — and the third door carried a subset of a subset. Three doors meant three answers to
// "what does the system already know about this person", which is three things to keep in step; the
// one that drifts is always the copy nobody is looking at.
//
// This is that answer, once. It is PURE — no database, no clock, no permission check — so the
// routes keep doing the reading and the `assertPermission`, exactly as `hire-draft.ts` is called.
//
// ── What it deliberately does NOT carry ──────────────────────────────────────────────────────────
//
// NO WORK EMAIL. The address on a CV is a personal one, usually a Gmail; `employees.work_email` is
// a COMPANY address and it is UNIQUE, and a new hire's mailbox is opened by its own task after the
// record is written (`openAndAnnounceNewHireMailboxes`). A personal address in that column looks
// filled in and is wrong. `buildHireDraft` still fills it on the application door, where it has
// always done so and is reviewed by the recruiter who just read the CV; nothing NEW starts doing it.
//
// NO MONEY, NO SEAT, NO TITLE, NO HIRE DATE. Those belong to the offer and the requisition, and the
// two draft builders own them. This is the PERSON, which is exactly the half neither of them knew.
//
// NO COLLEGE MAJOR. The form has a "College Major" box and the CV schema has no field for a
// specialisation distinct from the faculty — `faculty` IS the college. Filling the major with the
// college would put the same words in two boxes and read as confirmation rather than duplication,
// so the box stays empty and a human answers it.
//
// ── Measured, production, 2026-09-30 (1,262 candidates) ──────────────────────────────────────────
//
//   university      1,102    degree          1,039    graduation_year   987
//   governorate     1,047    faculty           894    address           737
//   phone           1,227    date_of_birth     392    place_of_birth      52
//   gender             63    national_id           8
//
// And on the employee side the five columns those first rows land in — `birth_place`,
// `qualification`, `university_name`, `college_major`, `senior_year` — read **0 of 201**. They are
// on the form, they are in the Employee Master workbook, and not one has ever been typed. That is
// what "much data auto populated" is worth here: the CV is the only place this company holds any of
// it.

import { matchDiscipline } from "@/lib/recruitment/candidate-background";
import type { Candidate } from "@/lib/recruitment/types";

/**
 * The person, in the employee form's OWN field names.
 *
 * Keys match `EmployeeFormState` exactly, so a door can spread this straight into the form state
 * and a renamed form field breaks the typecheck rather than silently emptying a box.
 *
 * Every value is a string, empty for "the CV does not say". Empty is never written over something
 * the form already holds — see `withCvHireFacts`.
 */
export type CvHireFacts = {
  birthDate: string;
  birthPlace: string;
  education: string;
  gender: string;
  mobileNumber: string;
  nationalId: string;
  qualification: string;
  residenceAddress: string;
  residenceCity: string;
  seniorYear: string;
  universityName: string;
};

/** Every key this module can fill, for the tests that prove the doors overlap in nothing. */
export const CV_HIRE_FACT_KEYS = [
  "birthDate",
  "birthPlace",
  "education",
  "gender",
  "mobileNumber",
  "nationalId",
  "qualification",
  "residenceAddress",
  "residenceCity",
  "seniorYear",
  "universityName",
] as const satisfies readonly (keyof CvHireFacts)[];

/** What this module reads off a candidate. Structural, so a fixture need not be a whole record. */
export type CvHireSubject = Pick<
  Candidate,
  | "address"
  | "dateOfBirth"
  | "degree"
  | "faculty"
  | "gender"
  | "governorate"
  | "graduationYear"
  | "nationalId"
  | "phone"
  | "placeOfBirth"
  | "university"
  | "whatsapp"
>;

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A CV writes gender any number of ways. Only the two the employee record actually stores are
 * carried over; anything else is left for a human, because a wrong guess here is silent.
 *
 * Moved here from `hire-draft.ts` unchanged, so both doors agree.
 */
export function normalizeCvGender(value: string | null | undefined): string {
  const raw = text(value).toLowerCase();
  if (raw === "male" || raw === "m" || raw === "ذكر") return "male";
  if (raw === "female" || raw === "f" || raw === "أنثى") return "female";
  return "";
}

/**
 * What `employees.education` — the box labelled **"College Name"** — already holds.
 *
 * 🔴 THIS COLUMN IS A ONE-WORD VOCABULARY, NOT FREE TEXT, and getting that wrong is the defect this
 * function exists to fix. Measured on production 2026-09-30, all 165 filled rows: Science 94,
 * Pharmacy 29, Vet 27, Commerce 4, Dentist 3, and eight one-off strings. Until this change the
 * application door wrote `composeEducation` into it — "BSc Pharmacy — Faculty of Pharmacy — Cairo
 * University" — a shape that column has never held. That was not wrong when it was written
 * (#2283, 2026-08-21): `education` was then the ONLY education field on the form, so a composed
 * string was the only way to carry three facts. The form grew `qualification`, `universityName`,
 * `collegeMajor` and `seniorYear` on **2026-09-30** (#4828) and nobody re-pointed the draft at
 * them, which is the whole of the bug. Each part now goes to its own box and nothing is lost.
 *
 * WHY `matchDiscipline` RATHER THAN A STRING OF MY OWN. It is this repo's authority on which of the
 * five disciplines a piece of free text names, and it already handles the two things a hand-rolled
 * strip cannot: Arabic ARABIC PRESENTATION FORMS, which is how `ﺣﻘﻮق` arrives out of PDF text
 * extraction, and the science false friends ("Computer Science", "Sciences Commerciales") that
 * would otherwise file a computing graduate as a Faculty of Science one. A second rule beside it is
 * a second thing to keep in step.
 *
 * The five words below are the EMPLOYEE column's spelling, which is not the candidate menu's:
 * `candidateBackgroundLabels` says "Veterinary" and "Dentistry" where 27 and 3 live employee rows
 * say "Vet" and "Dentist". The column is what this writes into, so the column's words win — a new
 * hire must count alongside the people already there.
 */
const COLLEGE_NAME_BY_DISCIPLINE = {
  dentistry: "Dentist",
  medicine: "Medicine",
  pharmacy: "Pharmacy",
  science: "Science",
  vet: "Vet",
} as const;

/**
 * "Faculty of Pharmacy" -> "Pharmacy". "كلية العلوم" -> "Science". "Faculty of Commerce" ->
 * "Commerce", unrecognised and kept as written.
 *
 * A discipline the five patterns do not know is NOT dropped: Commerce, Arts and Al-Alsun are all
 * live values, office hires are real, and the prefix-stripped words are exactly what somebody would
 * have typed. Only the ORDER matters — recognise first, so "Faculty of Veterinary Medicine" becomes
 * the "Vet" that 27 rows already use rather than a 28th spelling of it.
 */
export function collegeNameFromCv(subject: Pick<CvHireSubject, "degree" | "faculty">): string {
  const faculty = text(subject.faculty);
  const degree = text(subject.degree);

  // The faculty is the college, and it is the only field asked to name one. The degree is read as a
  // fallback because "BSc Pharmacy" names the college too, and 1,039 candidates carry a degree
  // against 894 a faculty — 145 people whose college is knowable only from the degree line.
  const discipline = matchDiscipline(faculty) ?? matchDiscipline(degree);
  if (discipline) return COLLEGE_NAME_BY_DISCIPLINE[discipline];

  return faculty.replace(/^\s*(faculty\s+of|college\s+of|كلية)\s+/iu, "").trim();
}

/**
 * A graduation year, or empty.
 *
 * `employees.senior_year` is TEXT and its own column guide says so — "Free text, so 2019/2020 is
 * fine" — but the CV column is an integer, so anything arriving here is already a number. The range
 * check is not defensive politeness: an extractor that read a page number or a phone fragment as a
 * year would otherwise put "7" or "202" on a permanent record, and a graduation year outside
 * 1950–2100 is not a graduation year.
 */
function graduationYearText(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isInteger(value)) return "";
  return value >= 1950 && value <= 2100 ? String(value) : "";
}

/**
 * Everything the CV knows about the person, in the form's own words.
 *
 * `residenceCity` <- `governorate`, which needs saying: the CV schema keeps the street address and
 * the governorate apart on purpose, and `employees.residence_city` is where the governorate goes —
 * its 50 live values are Cairo, Gharbia, Qena, "El Minia", "Abuhammad Elsharkia". So the column
 * holds a governorate under a narrower name, and the CV's is cleaner than most of what is in there.
 */
export function buildCvHireFacts(subject: CvHireSubject | null | undefined): CvHireFacts {
  if (!subject) {
    return {
      birthDate: "",
      birthPlace: "",
      education: "",
      gender: "",
      mobileNumber: "",
      nationalId: "",
      qualification: "",
      residenceAddress: "",
      residenceCity: "",
      seniorYear: "",
      universityName: "",
    };
  }

  return {
    birthDate: text(subject.dateOfBirth),
    birthPlace: text(subject.placeOfBirth),
    education: collegeNameFromCv(subject),
    gender: normalizeCvGender(subject.gender),
    // WhatsApp is the fallback and not a second field: 1,227 of 1,262 candidates carry a phone, and
    // the ones that do not arrived through WhatsApp, where the number IS the way to reach them.
    mobileNumber: text(subject.phone) || text(subject.whatsapp),
    nationalId: text(subject.nationalId),
    qualification: text(subject.degree),
    residenceAddress: text(subject.address),
    residenceCity: text(subject.governorate),
    seniorYear: graduationYearText(subject.graduationYear),
    universityName: text(subject.university),
  };
}

/** The facts that actually came across, in the words a recruiter reads. Empty when the CV said
 *  nothing — the screens use it to say what was filled instead of implying a full form. */
export function describeCvHireFacts(facts: CvHireFacts): string[] {
  const labels: Array<[keyof CvHireFacts, string]> = [
    ["nationalId", "national id"],
    ["birthDate", "date of birth"],
    ["birthPlace", "place of birth"],
    ["gender", "gender"],
    ["mobileNumber", "mobile"],
    ["residenceAddress", "address"],
    ["residenceCity", "city"],
    ["qualification", "qualification"],
    ["education", "college"],
    ["universityName", "university"],
    ["seniorYear", "graduation year"],
  ];
  return labels.filter(([key]) => facts[key].length > 0).map(([, label]) => label);
}

/**
 * Lay the CV's facts UNDER a draft that already exists, and never over it.
 *
 * Generic on purpose. The offer draft's type lives in `src/lib/offers/`, which
 * `tests/candidate-offer-pointer.test.ts` forbids from importing recruitment — the arrow is
 * recruitment -> offers and never back. A generic signature means this module needs no import in
 * either direction and still serves both doors.
 *
 * TWO RULES, both one-directional:
 *   - an EMPTY CV value is never written at all, so a blank CV field cannot blank a filled box;
 *   - a key the draft ALREADY carries with a non-empty value wins, always. The offer is the
 *     authority on the terms and the requisition on the seat; the CV is the authority on nobody.
 *
 * Today the two key sets are disjoint — the offer draft holds not one personal field — and a test
 * asserts that, so this precedence is a guard against the next field rather than live arithmetic.
 */
export function withCvHireFacts<T extends object>(draft: T, facts: CvHireFacts): T & Partial<CvHireFacts> {
  const filled: Partial<CvHireFacts> = {};
  for (const key of CV_HIRE_FACT_KEYS) {
    const value = facts[key];
    if (!value) continue;
    const existing = (draft as Record<string, unknown>)[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    filled[key] = value;
  }
  return { ...draft, ...filled };
}
