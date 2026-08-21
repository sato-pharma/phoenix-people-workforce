import { isSingleEmailAddress } from "@/lib/recruitment/contact-review";
import type { Candidate, Requisition } from "@/lib/recruitment/types";

/**
 * Everything the HR "Add Employee" form can already know about a new hire.
 *
 * Hiring someone today means reading their CV back to yourself and retyping it into a form the
 * recruitment module is standing right next to — which is part of why nobody has ever completed
 * a hire through this pipeline. This carries the facts across.
 *
 * It deliberately does NOT create the employee. An employee record carries a salary breakdown,
 * bank details, insurance numbers and a contract type, none of which recruitment knows; a
 * recruitment-side mini-form would create a live, half-configured employee that payroll then runs
 * on. So this fills in the part we know and the real form collects the rest.
 *
 * NOTHING here derives a salary. basicSalary/baseSalary/netSalary are left empty on purpose —
 * every salary derivation in this system lives in src/lib/payroll/policy.ts and stays there. The
 * offer's agreed figure is carried as grossSalary, exactly as it was recorded, and nothing else.
 */

export type HireDraft = {
  areaId: string;
  birthDate: string;
  departmentId: string;
  education: string;
  fullName: string;
  gender: string;
  grossSalary: string;
  hireDate: string;
  jobTitle: string;
  lineId: string;
  managerHrId: string;
  mobileNumber: string;
  nationalId: string;
  positionId: string;
  residenceAddress: string;
  teamId: string;
  workEmail: string;
};

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function id(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * A CV writes gender any number of ways. Only the two the employee record actually stores are
 * carried over; anything else is left for a human, because a wrong guess here is silent.
 */
function normalizeGender(value: string | null | undefined): string {
  const raw = text(value).toLowerCase();
  if (raw === "male" || raw === "m" || raw === "ذكر") return "male";
  if (raw === "female" || raw === "f" || raw === "أنثى") return "female";
  return "";
}

/** "BSc Pharmacy — Faculty of Pharmacy — Cairo University", from whichever parts the CV gave. */
export function composeEducation(candidate: Pick<Candidate, "degree" | "faculty" | "university">): string {
  return [text(candidate.degree), text(candidate.faculty), text(candidate.university)]
    .filter((part) => part.length > 0)
    .join(" — ");
}

export function buildHireDraft(input: {
  candidate: Pick<
    Candidate,
    | "address"
    | "dateOfBirth"
    | "degree"
    | "email"
    | "faculty"
    | "fullName"
    | "gender"
    | "nationalId"
    | "phone"
    | "university"
    | "whatsapp"
  >;
  offer: { jobTitle: string | null; monthlyGross: number | null; startDate: string | null } | null;
  requisition: Pick<
    Requisition,
    "areaId" | "departmentId" | "hiringManagerHrId" | "jobTitle" | "lineId" | "positionId" | "teamId"
  > | null;
}): HireDraft {
  const { candidate, offer, requisition } = input;

  return {
    fullName: text(candidate.fullName),
    // A CV that listed two addresses is not a work email. Same single-value rule the contact
    // review uses, and for the same reason: work_email is UNIQUE.
    workEmail: isSingleEmailAddress(candidate.email) ? text(candidate.email) : "",
    mobileNumber: text(candidate.phone) || text(candidate.whatsapp),
    nationalId: text(candidate.nationalId),
    birthDate: text(candidate.dateOfBirth),
    gender: normalizeGender(candidate.gender),
    residenceAddress: text(candidate.address),
    education: composeEducation(candidate),

    // The offer is the authority on the terms; the requisition's title is the fallback for an
    // application hired without one (the direct-hire path from offer_initiated).
    jobTitle: text(offer?.jobTitle) || text(requisition?.jobTitle),
    hireDate: text(offer?.startDate),
    grossSalary:
      typeof offer?.monthlyGross === "number" && Number.isFinite(offer.monthlyGross)
        ? String(offer.monthlyGross)
        : "",

    // Where the seat sits. Straight from the requisition, which inherited it from the organogram
    // vacancy when it was opened.
    lineId: id(requisition?.lineId),
    areaId: id(requisition?.areaId),
    departmentId: id(requisition?.departmentId),
    positionId: id(requisition?.positionId),
    teamId: id(requisition?.teamId),
    managerHrId: text(requisition?.hiringManagerHrId),
  };
}
