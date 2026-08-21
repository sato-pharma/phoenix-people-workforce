/**
 * What KIND of thing is an iReports360 `speciality` value?
 *
 * The vendor ships one free-text `speciality` column and puts three different kinds of thing in it:
 * a doctor's medical specialty, a place (pharmacy, hospital, polyclinic), and a commercial account
 * (Contract, Health Insurance). Doctor Coverage treated all three as "specialty", so the mix panel
 * ranked pharmacies against paediatricians and — more seriously — the coverage norm (A-grade = 2
 * visits a month, B/C = 1) was applied to a pharmacy exactly as to a physician.
 *
 * Measured on production 2026-08-08 across the graded panel (12,419 contacts, Mar–Aug 2026):
 *   78.8% true medical specialty · 19.0% institutions · 2.1% commercial accounts · 0.1% blank.
 * So a fifth of the "doctor panel", and of the coverage denominator, was never a doctor.
 *
 * Owner's rule (2026-08-08, verbatim): "all specialities SP, pharmacy and hospitals contract and
 * insurance HCP". SP = the doctor. HCP = the account you call on.
 *
 * WHY UNKNOWN VALUES ARE NOT DEFAULTED. The vendor adds values without notice — that is exactly how
 * "Contract" and "Health Insurance" ended up being scored as doctors in the first place. A value
 * this module has never seen therefore resolves to `unclassified` and is COUNTED AND SURFACED on
 * the board, never quietly folded into either bucket. Guessing is what produced the defect.
 */

export type CrmContactKind = "sp" | "hcp" | "unclassified";

/** Normalise a raw vendor string for lookup: trim, collapse inner whitespace, lowercase. */
function normalizeSpecialityKey(value: string | null | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * SP — a human doctor's medical specialty. Every value here was observed on production
 * 2026-08-08; the long tail (Cardiology, Orthopedic Surgery, Tropical medicine) matters because
 * the board's old rank-based "Other" bucket buried roughly 780 real physicians.
 */
const SP_VALUES = [
  "internal medicine",
  "pediatrics",
  "ent",
  "neurology",
  "chest",
  "general practitioner",
  "urology",
  "general surgery",
  "psychiatry",
  "neuro surgery",
  "vascular surgery",
  "gastroenterologist",
  "ophthalmologist",
  "neuropedia",
  "cardiology",
  "nicu",
  "orthopedic surgery",
  "tropical medicine",
  // — added 2026-08-21, confirmed against production (4 contacts: 3 nephrology, 1 dermatologist) —
  "dermatologist",
  "nephrology",
] as const;

/**
 * HCP — a place or an account, not a person. Owner named "pharmacy and hospitals contract and
 * insurance"; the hospital variants below are all hospitals, so they follow that rule directly.
 *
 * Two entries are an INFERENCE from the rule rather than values the owner named one by one, and
 * are called out here so they can be corrected in one edit: `polyclinics` (a facility, like a
 * hospital) and `educational institute` (a place, and certainly not a medical specialty).
 */
const HCP_VALUES = [
  "pharmacy",
  "hospital",
  "private hospital",
  "university hospital",
  "educational hospital",
  "armed forces hospital",
  "police hospital",
  "contract",
  "health insurance",
  // — inferred from the owner's rule, see the note above —
  "polyclinics",
  "educational institute",
] as const;

const KIND_BY_VALUE = new Map<string, CrmContactKind>([
  ...SP_VALUES.map((value) => [value, "sp"] as const),
  ...HCP_VALUES.map((value) => [value, "hcp"] as const),
]);

/**
 * Classify one raw `speciality` value.
 *
 * A blank/absent speciality is `unclassified`, the same as an unrecognised one: the board already
 * reports those contacts separately ("Unspecified"), and inventing a kind for them would be the
 * same guess this module exists to prevent.
 */
export function classifyCrmContactSpeciality(speciality: string | null | undefined): CrmContactKind {
  const key = normalizeSpecialityKey(speciality);
  if (!key) return "unclassified";
  return KIND_BY_VALUE.get(key) ?? "unclassified";
}

/** True when this contact is a human doctor — the population the visit norms were written for. */
export function isDoctorSpeciality(speciality: string | null | undefined): boolean {
  return classifyCrmContactSpeciality(speciality) === "sp";
}

/**
 * HCP is one bucket, but it holds two different things: places you visit (a hospital) and accounts
 * you bill (a contract, an insurer). Pharmacy Search has to tell them apart, because "hospitals
 * near this pharmacy" is a question about places.
 *
 * Deliberately derived FROM `HCP_VALUES` rather than written out again: a hospital is by definition
 * an HCP, so the two lists cannot be allowed to drift. `isHospitalSpeciality` is therefore false
 * for anything the module does not already class as HCP, unclassified values included — the same
 * refusal to guess that governs the rest of this file.
 */
const HOSPITAL_VALUES = HCP_VALUES.filter((value) => value.endsWith("hospital"));

/** True when this contact is a hospital — a strict subset of HCP. */
export function isHospitalSpeciality(speciality: string | null | undefined): boolean {
  if (classifyCrmContactSpeciality(speciality) !== "hcp") return false;
  return HOSPITAL_VALUES.includes(normalizeSpecialityKey(speciality) as (typeof HOSPITAL_VALUES)[number]);
}

/** Display label for a kind, used by the board's two mix panels. */
export const CRM_CONTACT_KIND_LABELS: Record<CrmContactKind, string> = {
  sp: "Doctors (SP)",
  hcp: "Pharmacies, hospitals & accounts (HCP)",
  unclassified: "Unclassified",
};

/** Every value this module knows, for the test that pins it against production. */
export const KNOWN_SP_SPECIALITIES: readonly string[] = SP_VALUES;
export const KNOWN_HCP_SPECIALITIES: readonly string[] = HCP_VALUES;
export const KNOWN_HOSPITAL_SPECIALITIES: readonly string[] = HOSPITAL_VALUES;
