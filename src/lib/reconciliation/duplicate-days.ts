export type EmployeeDayClaim = {
  employeeHrIdCompact: string;
  employeeHrId: string;
  employeeName: string | null;
  category: string;
  sourceSystem: string;
  dates: readonly string[];
};

export type DuplicateEmployeeDay = {
  employeeHrId: string;
  employeeName: string | null;
  date: string;
  /** Every claim on that day as "category/source_system", so the reader can see which feeder to correct. */
  claims: string[];
};

/**
 * Every (employee, day) claimed by more than one candidate, regardless of category.
 *
 * Deliberately NOT built on findDayCollisions, and deliberately not sharing its rule. That gate
 * only reports a day when categories.size > 1, on the stated assumption that a same-category
 * duplicate "cannot reach here" because of the unique index. The assumption is false:
 * deductions_candidates_live_key_idx is unique on (category, candidate_key), and candidate_key
 * includes source_system — so two different feeders inside ONE category (unpaid_vacation is fed by
 * both vacation_balance and crm_vacation_signal; crm by both crm_visits_mirror and dsm_no_record)
 * can each claim the same employee-day, and publishing charges that day twice with no warning.
 *
 * Keeping this derivation independent is the whole point: if it reused the gate's own rule it
 * would agree with the gate by construction and prove nothing. Pure and dependency-free so it can
 * be unit-tested without a database.
 */
export function findDuplicateEmployeeDays(claims: readonly EmployeeDayClaim[]): DuplicateEmployeeDay[] {
  const seen = new Map<
    string,
    { employeeHrId: string; employeeName: string | null; date: string; claims: string[] }
  >();

  for (const claim of claims) {
    for (const rawDate of claim.dates) {
      if (typeof rawDate !== "string") continue;
      const date = rawDate.trim();
      if (!date) continue;
      // Keyed on the COMPACT HR id, never the name: production holds candidates with a null stored
      // name, and grouping on the name once reported two different people as one duplicate.
      const key = `${claim.employeeHrIdCompact}:${date}`;
      const entry = seen.get(key) ?? {
        employeeHrId: claim.employeeHrId,
        employeeName: claim.employeeName,
        date,
        claims: [],
      };
      entry.claims.push(`${claim.category}/${claim.sourceSystem}`);
      seen.set(key, entry);
    }
  }

  return [...seen.values()]
    .filter((entry) => entry.claims.length > 1)
    .sort((left, right) => left.employeeHrId.localeCompare(right.employeeHrId) || left.date.localeCompare(right.date));
}
