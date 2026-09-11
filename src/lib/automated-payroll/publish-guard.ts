import { roundCurrency } from "@/lib/payroll/money";

/**
 * PUBLISH MUST WRITE THE MONTH PART 2 CONFIRMED, NOT WHATEVER TODAY'S DATA SAYS.
 *
 * Publish re-assembles every row live from current employee, deduction and expense data. That is
 * deliberate and correct as far as it goes, but it means publish had nothing to compare against:
 * its only check was that the run's phase was `ready`. It re-ran no pre-flight validation, no
 * reconciliation, no split check and no overpaid acknowledgement, while the underlying data was
 * free to move between the confirm and the click.
 *
 * So the sheet and both bank files finance downloaded at Part 2 confirm could differ from the
 * payslips written at publish, and nothing anywhere would record that they ever differed. The
 * employee sees one number, the bank sent another.
 *
 * The fix is a stamp and a comparison. Part 2 confirm records the totals of the sheet it confirmed
 * into its own audit row; publish recomputes them and refuses if they have moved. The audit trail
 * is the right home for the stamp because it is append-only and run-scoped, so the figure publish
 * reads is the figure confirm wrote.
 *
 * A CENT OF TOLERANCE, AND NO MORE. These are sums of already-rounded per-row figures, so exact
 * equality is the honest expectation; the tolerance exists only so floating-point addition order
 * cannot fail a month that is genuinely identical.
 */

/** Where the confirmed totals live inside the `part2_confirmed` audit row's `detail`. */
export const PART2_TOTALS_KEY = "confirmedTotals";

export type ConfirmedTotals = {
  employees: number;
  firstPart: number;
  secondPart: number;
  monthSalary: number;
  net: number;
};

type TotalsSource = {
  totalFirstPart: number;
  totalSecondPart: number;
  totalMonthSalary: number;
  totalNet: number;
};

/** The shape stamped at Part 2 confirm. */
export function part2Totals(employees: number, totals: TotalsSource): ConfirmedTotals {
  return {
    employees,
    firstPart: roundCurrency(totals.totalFirstPart),
    secondPart: roundCurrency(totals.totalSecondPart),
    monthSalary: roundCurrency(totals.totalMonthSalary),
    net: roundCurrency(totals.totalNet),
  };
}

/** Read a stamp back out of an audit row's `detail`, or null when the run predates the stamp. */
export function readConfirmedTotals(detail: unknown): ConfirmedTotals | null {
  if (!detail || typeof detail !== "object") return null;
  const raw = (detail as Record<string, unknown>)[PART2_TOTALS_KEY];
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const read = (key: string): number | null => {
    const value = Number(record[key]);
    return Number.isFinite(value) ? value : null;
  };
  const employees = read("employees");
  const firstPart = read("firstPart");
  const secondPart = read("secondPart");
  const monthSalary = read("monthSalary");
  const net = read("net");
  if (
    employees == null ||
    firstPart == null ||
    secondPart == null ||
    monthSalary == null ||
    net == null
  ) {
    return null;
  }
  return { employees, firstPart, secondPart, monthSalary, net };
}

const TOLERANCE = 0.01;

export type TotalsDrift = {
  field: keyof ConfirmedTotals;
  confirmed: number;
  atPublish: number;
};

/** What moved between Part 2 confirm and publish. Empty is the healthy answer. */
export function compareConfirmedTotals(
  confirmed: ConfirmedTotals,
  atPublish: ConfirmedTotals,
): TotalsDrift[] {
  const fields: Array<keyof ConfirmedTotals> = [
    "employees",
    "firstPart",
    "secondPart",
    "monthSalary",
    "net",
  ];
  const drift: TotalsDrift[] = [];
  for (const field of fields) {
    const before = confirmed[field];
    const after = atPublish[field];
    const moved = field === "employees" ? before !== after : Math.abs(before - after) > TOLERANCE;
    if (moved) drift.push({ field, confirmed: before, atPublish: after });
  }
  return drift;
}

const LABELS: Record<keyof ConfirmedTotals, string> = {
  employees: "employees on the sheet",
  firstPart: "total first instalment",
  secondPart: "total second instalment",
  monthSalary: "total month salary",
  net: "total net salary",
};

/** What the person clicking Publish reads. Names the figures, because the fix is to look at them. */
export function describeTotalsDrift(drift: TotalsDrift[]): string {
  const listed = drift
    .map((one) => `${LABELS[one.field]} ${one.confirmed.toLocaleString()} → ${one.atPublish.toLocaleString()}`)
    .join("; ");
  return (
    `This month has changed since Part 2 was confirmed: ${listed}. ` +
    "Finance may already have executed the bank files built from the confirmed figures, so " +
    "publishing now would write payslips that disagree with what was paid. Reopen Part 2, look at " +
    "what moved, and confirm again."
  );
}
