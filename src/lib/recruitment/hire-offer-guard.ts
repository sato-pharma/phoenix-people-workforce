// Recruitment — the gate between the offer a Super Admin approved and the employee
// who actually gets paid.
//
// markApplicationHired links an application to an employee that the HR "Add Employee"
// flow created separately. Nothing connected the two. The workflow registry gates only
// the application STAGE, and that gate is runtime-editable from the workflow control
// centre: production's live recruitment module (version 8, read 2026-08-29) allows
// app_hire from `offer_initiated` — a stage meaning an offer was drafted and never
// approved, never sent and never accepted. The migration that seeded the registry
// allowed only `offer_accepted` and `pre_boarding`, so this is drift, and it is exactly
// why the rule below lives in code: a registry row is configuration, not a boundary.
//
// Two rules, deliberately different in strength:
//
//   * NO ACCEPTED OFFER  -> REFUSE. There is nothing to hire against, and proceeding
//     writes a hire nobody approved.
//   * TERMS DIFFER       -> FLAG, never refuse. A renegotiated figure is legitimate;
//     a silent one is not. The system flags and a human decides — the same shape as
//     the expense rule. The mismatch is written into the hire's own audit event and
//     returned to the caller.

/** The approved terms, as stored on the offer. */
export type OfferTermsForHire = {
  jobTitle: string | null;
  monthlyGross: number | null;
  startDate: string | null;
  response: string | null;
};

/** What the HR Add Employee flow actually recorded. */
export type HiredEmployeeTerms = {
  jobTitle: string | null;
  grossSalary: number | null;
  hireDate: string | null;
};

export type HireTermMismatchField = "employeeRecord" | "jobTitle" | "monthlyGross" | "startDate";

export type HireTermMismatch = {
  field: HireTermMismatchField;
  offered: string | number | null;
  hired: string | number | null;
  detail: string;
};

// Salaries are numeric(12,2); anything under a piastre is storage noise, not a
// renegotiation. Wider than float error, narrower than any real salary change.
const SALARY_EPSILON = 0.01;

function normalizeTitle(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Both columns are dates, but one arrives as a timestamp often enough to matter. */
function dateOnly(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match ? match[1] : raw;
}

/**
 * Refuse a hire that has no accepted offer behind it.
 *
 * Deliberately keyed on the OFFER's own recorded answer, not on the application stage:
 * the stage is what the editable registry already checks, and checking it twice would
 * inherit the same drift this guard exists to survive.
 */
export function assertOfferAcceptedForHire(offer: OfferTermsForHire | null): void {
  if (!offer) {
    throw new Error(
      "This application cannot be marked hired: no offer has been prepared for it. " +
        "Prepare the offer, have it approved, record it as sent, then record the candidate's answer.",
    );
  }
  if (offer.response !== "accepted") {
    const said = offer.response ? `the recorded answer is "${offer.response}"` : "no answer has been recorded yet";
    throw new Error(
      `This application cannot be marked hired: its offer has not been accepted — ${said}. ` +
        "Record the candidate's acceptance on the offer first.",
    );
  }
}

/**
 * Compare the approved offer against the employee that was created, and report every
 * difference. Never throws — the caller flags, it does not reject.
 *
 * Only terms the OFFER actually states are compared: if no salary was approved there is
 * no approved figure to violate. A missing employee record is itself reported, never
 * treated as "nothing to compare" — a lookup that silently finds nothing would disarm
 * this whole check.
 */
export function compareHireTermsToOffer(
  offer: OfferTermsForHire,
  employee: HiredEmployeeTerms | null,
): HireTermMismatch[] {
  if (!employee) {
    return [
      {
        field: "employeeRecord",
        offered: null,
        hired: null,
        detail:
          "No single employee record could be resolved for the HR_ID this hire was linked to, so the approved terms were checked against nothing.",
      },
    ];
  }

  const mismatches: HireTermMismatch[] = [];

  const offeredTitle = normalizeTitle(offer.jobTitle);
  if (offeredTitle) {
    const hiredTitle = normalizeTitle(employee.jobTitle);
    if (offeredTitle !== hiredTitle) {
      mismatches.push({
        field: "jobTitle",
        offered: offer.jobTitle,
        hired: employee.jobTitle,
        detail: `The offer was approved for "${offer.jobTitle}" but the employee was created as "${employee.jobTitle ?? "(no job title)"}".`,
      });
    }
  }

  if (typeof offer.monthlyGross === "number" && Number.isFinite(offer.monthlyGross)) {
    const hiredGross = employee.grossSalary;
    const comparable = typeof hiredGross === "number" && Number.isFinite(hiredGross);
    if (!comparable || Math.abs(hiredGross - offer.monthlyGross) > SALARY_EPSILON) {
      mismatches.push({
        field: "monthlyGross",
        offered: offer.monthlyGross,
        hired: comparable ? hiredGross : null,
        detail: comparable
          ? `The offer was approved at a monthly gross of ${offer.monthlyGross} but the employee was created at ${hiredGross}.`
          : `The offer was approved at a monthly gross of ${offer.monthlyGross} but the employee has no gross salary recorded.`,
      });
    }
  }

  const offeredStart = dateOnly(offer.startDate);
  if (offeredStart) {
    const hiredStart = dateOnly(employee.hireDate);
    if (offeredStart !== hiredStart) {
      mismatches.push({
        field: "startDate",
        offered: offer.startDate,
        hired: employee.hireDate,
        detail: `The offer was approved to start on ${offeredStart} but the employee's hire date is ${hiredStart || "(not set)"}.`,
      });
    }
  }

  return mismatches;
}

/** One line a human can read, for the audit event and the API response. */
export function describeHireTermMismatches(mismatches: readonly HireTermMismatch[]): string | null {
  if (mismatches.length === 0) return null;
  return mismatches.map((m) => m.detail).join(" ");
}
