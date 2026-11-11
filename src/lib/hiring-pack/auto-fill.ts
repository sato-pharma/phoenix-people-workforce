/**
 * WHAT THE PAPERS CAN WORK OUT FOR THEMSELVES — filled before anything is printed, so HR types only
 * what the system genuinely does not know.
 *
 * ── Why this exists ──
 * Every derivation below already existed, and none of them reached a paper: they lived in
 * `enrichForReadiness`, which nothing called. Measured on production 2026-11-11, across the 132
 * current staff: محل الميلاد printed blank for 124 people while the national ID named the
 * governorate for 120 of them and the Employee Master held a typed birthplace for 46; المؤهل printed
 * blank for 95 while 94 had their education on record; the Arabic job title was blank for 22 whose
 * English title has an owner-confirmed Arabic wording; and Form 1's محافظة was blank for all 132
 * while 131 had their governorate in `residence_city`. Each of those was a box somebody filled by
 * hand, on every paper, for every joiner.
 *
 * ── The rule: a blank is filled, an answer is never touched ──
 * Every value here is used ONLY when the stored one is empty. A stored value is somebody's answer
 * and outranks anything worked out, so calling this twice, or on a complete record, changes nothing.
 *
 * ── Where each value comes from, in order ──
 * - birth date: the record, else the national ID (a decode, not a guess — `national-id.ts`).
 * - birthplace: the hiring profile, else the Employee Master's own `birth_place` (typed by HR,
 *   so more precise — "قنا - مركز نجع حمادي"), else the national ID's governorate of birth.
 * - Arabic job title: the hiring profile, else the owner's CONFIRMED wording for the English title
 *   (`arabic-lookups.ts`). Never a colleague's typed title: those carry the colleague's gender
 *   (production holds مندوبة دعاية طبية), and the owner's wording is the decided masculine generic.
 * - qualification: the hiring profile, else the Employee Master's `qualification` or `education`
 *   through the owner's confirmed Arabic (an English "Bachelor" has no answer and stays blank).
 * - governorate of residence (Form 1): the hiring profile, else `residence_city` (never the address).
 *
 * Nationality is NOT here: the renderers already resolve it at print time (`nationality.ts`), and
 * writing it onto the profile would freeze مصري / مصرية against a gender that can still be corrected.
 *
 * Pure, so `tests/hiring-pack-auto-fill.test.ts` drives it with no database.
 */

import { resolveJobTitleAr, resolveQualificationAr } from "@/lib/hiring-pack/arabic-lookups";
import { fillFromNationalId, governorateArForPlace } from "@/lib/hiring-pack/national-id";
import type { HiringPackEmployeeFacts, HiringPackProfile } from "@/lib/hiring-pack/types";

/** Which value was filled without anybody typing it, so the screen can say so. */
export type AutoFilledValue =
  | "birthDate"
  | "birthPlace"
  | "jobTitleAr"
  | "qualification"
  | "addressGovernorate";

/** What the fill screen says beside a value it did not store, in the order the form asks for them. */
export const AUTO_FILLED_LABELS: Record<AutoFilledValue, { labelEn: string; source: string }> = {
  birthDate: { labelEn: "Date of birth", source: "the national ID" },
  birthPlace: { labelEn: "Place of birth", source: "the employee record or the national ID" },
  jobTitleAr: { labelEn: "Arabic job title", source: "the confirmed Arabic for the job title" },
  qualification: { labelEn: "Qualification", source: "the education on the employee record" },
  addressGovernorate: { labelEn: "Governorate", source: "the city on the employee record" },
};

function present(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/**
 * Fill every blank the system can answer. Returns NEW objects; the inputs are never mutated.
 */
export function autoFillHiringPackFacts(
  employee: HiringPackEmployeeFacts,
  profile: HiringPackProfile,
): { employee: HiringPackEmployeeFacts; profile: HiringPackProfile; autoFilled: AutoFilledValue[] } {
  const autoFilled: AutoFilledValue[] = [];

  // The Employee Master's typed birthplace goes in as though stored, so the ID only fills what
  // neither copy answers — and it is still reported, because the hiring profile did not hold it.
  const recordBirthPlace = present(profile.birthPlace) ? null : present(employee.recordBirthPlace);
  const fromId = fillFromNationalId({
    nationalId: employee.nationalId,
    birthDate: employee.birthDate,
    birthPlace: present(profile.birthPlace) ?? recordBirthPlace,
  });
  if (fromId.derived.includes("birthDate")) autoFilled.push("birthDate");
  if (recordBirthPlace || fromId.derived.includes("birthPlace")) autoFilled.push("birthPlace");

  let jobTitleAr = present(profile.jobTitleAr);
  if (!jobTitleAr) {
    jobTitleAr = resolveJobTitleAr(employee.jobTitle);
    if (jobTitleAr) autoFilled.push("jobTitleAr");
  }

  let qualification = present(profile.qualification);
  if (!qualification) {
    qualification =
      resolveQualificationAr(employee.recordQualification) ?? resolveQualificationAr(employee.education);
    if (qualification) autoFilled.push("qualification");
  }

  let addressGovernorate = present(profile.addressGovernorate);
  if (!addressGovernorate) {
    // The city box only, never the free-text address: the vocabulary matches town fragments
    // (بدر is in two governorates), which is safe on a one-word city and not on a street address.
    addressGovernorate = governorateArForPlace(employee.residenceCity);
    if (addressGovernorate) autoFilled.push("addressGovernorate");
  }

  return {
    employee: { ...employee, birthDate: fromId.birthDate },
    profile: {
      ...profile,
      birthPlace: fromId.birthPlace,
      jobTitleAr,
      qualification,
      addressGovernorate,
    },
    autoFilled,
  };
}
