import { isSingleEmailAddress } from "@/lib/recruitment/contact-review";
import { buildCvHireFacts, type CvHireFacts } from "@/lib/recruitment/cv-hire-facts";
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
 *
 * ── The PERSON moved out of this file ────────────────────────────────────────────────────────────
 * Who they are — national id, birth date and place, gender, mobile, address, city and the four
 * education boxes — is now `cv-hire-facts.ts`, because the OFFER door needs the identical mapping
 * and a second copy of it is a second thing to keep in step. This file keeps what only an
 * application knows: the offer's terms and the requisition's seat.
 *
 * `composeEducation` lived here and is GONE. It joined degree, faculty and university into one
 * string — right when `education` was the form's only education box, wrong the moment #4828 gave
 * each of the three a box of its own on 2026-09-30. See `collegeNameFromCv`.
 */

export type HireDraft = CvHireFacts & {
  areaId: string;
  departmentId: string;
  fullName: string;
  grossSalary: string;
  hireDate: string;
  jobTitle: string;
  lineId: string;
  managerHrId: string;
  positionId: string;
  teamId: string;
  workEmail: string;
};

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function id(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
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
    | "governorate"
    | "graduationYear"
    | "nationalId"
    | "phone"
    | "placeOfBirth"
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
    // Who they are — one mapping, shared with the offer door.
    ...buildCvHireFacts(candidate),

    fullName: text(candidate.fullName),
    // A CV that listed two addresses is not a work email. Same single-value rule the contact
    // review uses, and for the same reason: work_email is UNIQUE.
    //
    // THIS DOOR ALONE fills it, as it has since #2283: a recruiter arriving from the application
    // has just read the CV and is looking at that address as the form opens. `cv-hire-facts.ts`
    // does not carry it, so the offer door — where nobody has the CV in front of them — leaves the
    // company address to the mailbox task that opens it.
    workEmail: isSingleEmailAddress(candidate.email) ? text(candidate.email) : "",

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
