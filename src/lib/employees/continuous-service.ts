import { canonicalHrIdKey } from "@/lib/hr-id";

/**
 * One person, two HR records: the EARLIER record's history belongs to the person's current account.
 *
 * WHY (owner, 2026-11-05, Omayma Wael El Habashy): she resigned from the Anti Infective line as
 * AI-0009 on 31 Oct 2026 and was re-hired onto Pedia through a new offer, which opened a new record,
 * PD-0039, starting 7 Nov 2026. "This is the same person": her August and September payslips and her
 * vacation history must show in her new account, and her vacation balance counts from her first day,
 * 17 Aug 2026.
 *
 * 🔴 PAYROLL NEVER READS THIS. `employees.hire_date` stays the new record's own first day, because
 * payroll puts a person in a month by that date (`resolvePayrollPopulationAndSources`): with 17 Aug on
 * PD-0039 the open October run counted her as a full October employee BESIDE AI-0009, paid twice.
 * Payroll history also stays as it was paid — the earlier rows keep their own HR id, and the
 * portal reads them through this link instead of being moved.
 *
 * What reads it: the employee portal's payslip list and payslip view (`fetchPortalPayslips`, the SELF
 * branch of `resolvePayrollAccessFilter`), her own vacation history, the vacation balance
 * (`getVacationBalancePeriod`, `calculateVacationPayment`, `isWithinFirstSixMonths`) and the portal's
 * "Hire date".
 *
 * A new entry is one line here, in a reviewed PR — never inferred from a matching name or national ID.
 */
type ContinuousServiceLink = {
  /** The person's current record. */
  hrId: string;
  /** Records the same person held before, oldest first. */
  earlierHrIds: readonly string[];
  /** The first day of the person's unbroken service: the earliest record's hire date. */
  serviceStartDate: string;
  decidedOn: string;
};

const CONTINUOUS_SERVICE_LINKS: readonly ContinuousServiceLink[] = [
  { hrId: "PD-0039", earlierHrIds: ["AI-0009"], serviceStartDate: "2026-08-17", decidedOn: "2026-11-05" },
];

/** The canonical key with its punctuation dropped: the portal's access ids carry no hyphen ("pd0039"). */
function compactHrId(value: string | null | undefined): string {
  return (canonicalHrIdKey(value) ?? "").replace(/[^a-z0-9]+/g, "");
}

function linkFor(hrId: string | null | undefined): ContinuousServiceLink | null {
  const key = compactHrId(hrId);
  if (!key) return null;
  return CONTINUOUS_SERVICE_LINKS.find((link) => compactHrId(link.hrId) === key) ?? null;
}

/** The same person's earlier HR ids, as stored (upper-case), or none. */
export function earlierRecordHrIds(hrId: string | null | undefined): string[] {
  return [...(linkFor(hrId)?.earlierHrIds ?? [])];
}

/** The person's own HR id followed by every earlier one of theirs. */
export function ownAndEarlierRecordHrIds(hrId: string | null | undefined): string[] {
  const own = String(hrId ?? "").trim();
  if (!own) return [];
  return [own, ...earlierRecordHrIds(own)];
}

/**
 * The date the person's service counts from, for leave and for what the portal shows as "Hire date":
 * the linked start when it is EARLIER than the record's own hire date, otherwise the hire date itself.
 */
export function continuousServiceStartDate(
  hrId: string | null | undefined,
  hireDate: string | null | undefined,
): string | null {
  const own = hireDate ? String(hireDate).slice(0, 10) : null;
  const linked = linkFor(hrId)?.serviceStartDate ?? null;
  if (!linked) return own;
  if (!own) return linked;
  return linked < own ? linked : own;
}
