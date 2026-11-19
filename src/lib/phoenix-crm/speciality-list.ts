/**
 * A Phoenix CRM customer's speciality — ONE fixed list, plus "Other".
 *
 * Owner, 2026-11-19, after the specialty audit found 111 spellings for about thirty specialties on the
 * live lists ("Pedia", "pedia", "Pediatric", "اطفال", "بيديا" for one of them): *"fix specialities and
 * fix this chaos and make the speciality not typable fixed drop list"*, and for what fits none of
 * them: *"add other and under other make him able to type"*.
 *
 * So the speciality is picked from {@link specialityChoices}, and only "Other" opens a box to type in.
 * Whatever reaches the server — the pick, an "Other" text, an uploaded sheet's cell, an old client
 * still sending free text — goes through {@link normalizeSpeciality} first, which turns every spelling
 * this module knows (English abbreviations, Arabic, hidden right-to-left marks, two specialties in one
 * box) into the ONE name on the list. Only a text that matches nothing is kept as typed, and that is
 * exactly the "Other" the owner asked for.
 *
 * The names are the ones the old CRM already used (crm/contact-taxonomy.ts classifies them, case
 * folded), so cleaning a customer's speciality never moves him between the doctor and the account
 * buckets.
 */

/** A doctor's medical specialty — the PM list's people, and the doctors an AM account also lists. */
export const DOCTOR_SPECIALITIES = [
  "Internal Medicine",
  "Pediatrics",
  "ENT",
  "Neurology",
  "Chest",
  "General Practitioner",
  "Urology",
  "General Surgery",
  "Psychiatry",
  "Neuro Surgery",
  "Vascular Surgery",
  "Gastroenterologist",
  "Ophthalmologist",
  "Neuropedia",
  "Cardiology",
  "NICU",
  "Orthopedic Surgery",
  "Tropical Medicine",
  "Dermatologist",
  "Nephrology",
] as const;

/** A place or an account you call on — never a person. */
export const ACCOUNT_SPECIALITIES = [
  "Hospital",
  "Private Hospital",
  "University Hospital",
  "Educational Hospital",
  "Armed Forces Hospital",
  "Police Hospital",
  "Polyclinics",
  "Contract",
  "Health Insurance",
  "Educational Institute",
] as const;

/**
 * A pharmacy has its own list (the Pharmacy list type), so a rep's AM or PM pick-list never offers it —
 * that is how a pharmacy ends up counted as a contact. A manager's own list has no list type, so his
 * pick-list does offer it.
 */
export const PHARMACY_SPECIALITY = "Pharmacy";

export const OTHER_SPECIALITY_LABEL = "Other";
/** The longest speciality kept — the database rows were written to 80 by the rep's screens. */
export const SPECIALITY_TEXT_MAX = 80;

/**
 * Which pick-list a form draws: the customer's own list type (AM, PM or Pharmacy), or a manager's own list,
 * which has none. Taking the list type as it is — never narrowed to AM-or-PM — keeps a pharmacy a pharmacy.
 */
export type SpecialityListKind = "AM" | "PM" | "Pharmacy" | "manager";

export type SpecialityGroup = { label: string; items: readonly string[] };

/**
 * The pick-list, in the order the person meets it: a PM (doctor) list opens on the doctors, an AM
 * list on the places and accounts, and each still offers the other group — an AM account names the
 * doctor met there, and a wrongly filed customer must still be pickable before it is moved.
 */
export function specialityChoices(kind: SpecialityListKind | null): SpecialityGroup[] {
  // The words "doctor" and "account" are the retired names of the PM and AM lists and never reach a
  // screen (tests/phoenix-crm-am-pm-words.test.ts), so the two groups are named by what they hold.
  const medical: SpecialityGroup = { label: "Medical specialities", items: DOCTOR_SPECIALITIES };
  const places: SpecialityGroup = {
    label: "Hospitals, contracts and insurance",
    items: kind === "manager" || kind === "Pharmacy" ? [...ACCOUNT_SPECIALITIES, PHARMACY_SPECIALITY] : ACCOUNT_SPECIALITIES,
  };
  return kind === "AM" ? [places, medical] : [medical, places];
}

/** True when `value` is one of the names this kind of list offers — anything else shows as "Other". */
export function isListedSpeciality(value: string | null | undefined, kind: SpecialityListKind | null): boolean {
  if (!value) return false;
  return specialityChoices(kind).some((group) => group.items.includes(value));
}

const CANONICAL = [...DOCTOR_SPECIALITIES, ...ACCOUNT_SPECIALITIES, PHARMACY_SPECIALITY];

/**
 * Every other spelling seen on the live lists (production, 2026-11-19), keyed as {@link keyOf} folds
 * it. Two specialties written in one box keep the FIRST one named; the rep can change it from the list.
 */
const ALIASES: Record<string, string> = {
  // Internal Medicine
  im: "Internal Medicine",
  "internal medecin": "Internal Medicine",
  "internal medicin": "Internal Medicine",
  "internal medecine": "Internal Medicine",
  "diabetes specialist": "Internal Medicine",
  "باطنه": "Internal Medicine",
  "باطنة": "Internal Medicine",
  "باطنيه": "Internal Medicine",
  "باطنه عامه": "Internal Medicine",
  "باطنة عامة": "Internal Medicine",
  "امراض الباطنه": "Internal Medicine",
  "امراض باطنه": "Internal Medicine",
  "استشاري الامراض الباطنيه": "Internal Medicine",
  "استشاري الباطنه": "Internal Medicine",
  // Pediatrics
  pedia: "Pediatrics",
  pediatric: "Pediatrics",
  ped: "Pediatrics",
  peds: "Pediatrics",
  paediatrics: "Pediatrics",
  pediatrician: "Pediatrics",
  "اطفال": "Pediatrics",
  "طب الاطفال": "Pediatrics",
  "بيديا": "Pediatrics",
  // ENT
  "ent chest": "ENT",
  "انف واذن": "ENT",
  "انف واذن وحنجره": "ENT",
  "انف واذن وحنجرة": "ENT",
  // Neurology
  neuro: "Neurology",
  nero: "Neurology",
  neurological: "Neurology",
  neurologist: "Neurology",
  cns: "Neurology",
  "neuro physicatiry": "Neurology",
  "neuro psychiatry": "Neurology",
  "neuropsychiatry": "Neurology",
  "مخ واعصاب": "Neurology",
  "مخ واعصاب والطب النفسي": "Neurology",
  // Chest
  "صدر": "Chest",
  "صدريه": "Chest",
  "امراض صدريه": "Chest",
  "شيست": "Chest",
  "استشاري الصدر": "Chest",
  // General Practitioner
  gp: "General Practitioner",
  "ممارس عام": "General Practitioner",
  // Urology
  uro: "Urology",
  uero: "Urology",
  ueuro: "Urology",
  "مسالك": "Urology",
  "مسالك بوليه": "Urology",
  "جراحه مسالك": "Urology",
  "جراحه مسالك والكلي": "Urology",
  // General Surgery
  surgery: "General Surgery",
  sur: "General Surgery",
  "جراحه": "General Surgery",
  "جراحة": "General Surgery",
  "جراحه عامه": "General Surgery",
  "جراحة عامة": "General Surgery",
  "استشاري الجراحه العامه": "General Surgery",
  "جراحه جهاز هضمي والسمنه": "General Surgery",
  // Neuro Surgery
  neurosurgery: "Neuro Surgery",
  neurosurger: "Neuro Surgery",
  "جراحه مخ واعصاب": "Neuro Surgery",
  // Orthopedic Surgery
  orthopedic: "Orthopedic Surgery",
  orthopedics: "Orthopedic Surgery",
  ortho: "Orthopedic Surgery",
  "عظام": "Orthopedic Surgery",
  // Tropical Medicine (حميات, the fever hospitals' specialty)
  "حميات": "Tropical Medicine",
  // Cardiology
  cardio: "Cardiology",
  "قلب": "Cardiology",
  // Psychiatry
  "نفسيه": "Psychiatry",
  "طب نفسي": "Psychiatry",
  // NICU
  "حضانه": "NICU",
  // Places and accounts
  "government hospital": "Hospital",
  "مستشفى": "Hospital",
  "poly clinic": "Polyclinics",
  polyclinic: "Polyclinics",
  "التأمين الصحي": "Health Insurance",
  "التامين الصحي": "Health Insurance",
  "chain pharmacy": PHARMACY_SPECIALITY,
  "صيدليه": PHARMACY_SPECIALITY,
  "صيدلية": PHARMACY_SPECIALITY,
};

/** Invisible direction marks and isolates a phone keyboard leaves in a word ("‏pedia" is not "pedia"). */
const DIRECTION_MARKS = /[؜​-‏‪-‮⁦-⁩﻿]/g;

/** Collapse whitespace and drop the direction marks — the text as it is SAVED. */
function cleaned(value: string): string {
  return value.replace(DIRECTION_MARKS, "").replace(/\s+/g, " ").trim();
}

/** How a spelling is looked up: cleaned, lower case, Arabic letter forms folded, end dots dropped. */
function keyOf(value: string): string {
  return cleaned(value)
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[.،,;:]+$/g, "")
    .trim();
}

const CANONICAL_BY_KEY = new Map<string, string>([
  ...CANONICAL.map((name) => [keyOf(name), name] as const),
  ...Object.entries(ALIASES).map(([alias, name]) => [keyOf(alias), name] as const),
]);

/** Where two specialties typed in one box are split: + & , / ، and the words "and" / "و". */
const COMBINED_SEPARATOR = /\s*(?:\+|&|,|،|\/|\band\b)\s*|\s+و(?=\S)/i;

/**
 * The ONE name on the list for any spelling of a speciality, or the text itself (cleaned) when it
 * matches none — that is an "Other" speciality and it is kept as he wrote it. Blank, and a box holding
 * only dots, is null.
 */
export function normalizeSpeciality(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = cleaned(value);
  if (!text || /^[.\-_\s]+$/.test(text)) return null;
  const whole = CANONICAL_BY_KEY.get(keyOf(text));
  if (whole) return whole;
  // Two specialties in one box: the first one named, when it is one the list knows.
  const first = text.split(COMBINED_SEPARATOR)[0];
  if (first && first !== text) {
    const named = CANONICAL_BY_KEY.get(keyOf(first));
    if (named) return named;
  }
  return text.slice(0, SPECIALITY_TEXT_MAX);
}
