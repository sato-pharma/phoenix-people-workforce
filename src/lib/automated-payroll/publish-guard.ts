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

/**
 * Where a comparison against the Part 2 stamp is being made. Publish writes payslips; a bank-file
 * download hands finance a transfer file. The refusal says which one it stopped.
 */
export type ConfirmCheckContext = "publish" | "bank_file";

/** What the person clicking Publish (or downloading a bank file) reads. Names the figures, because the fix is to look at them. */
export function describeTotalsDrift(drift: TotalsDrift[], context: ConfirmCheckContext = "publish"): string {
  const listed = drift
    .map((one) => `${LABELS[one.field]} ${one.confirmed.toLocaleString()} → ${one.atPublish.toLocaleString()}`)
    .join("; ");
  const consequence =
    context === "bank_file"
      ? "This bank file is rebuilt from today's data, so downloading it now would send the bank figures " +
        "nobody confirmed. No file was produced."
      : "Finance may already have executed the bank files built from the confirmed figures, so " +
        "publishing now would write payslips that disagree with what was paid.";
  return (
    `This month has changed since Part 2 was confirmed: ${listed}. ${consequence} Reopen Part 2, look at ` +
    "what moved, and confirm again."
  );
}

/**
 * A run in `ready` with no stamp at all. Before 2026-10-23 publish let this through and recorded
 * only that it could not compare; the stamp is now written inside the confirm's own claim, so a
 * confirmed run without one means the confirm predates the stamp or its write was lost. Either way
 * nothing proves the figures are the confirmed ones, and re-confirming Part 2 writes a fresh stamp.
 */
export function describeMissingPart2Stamp(context: ConfirmCheckContext = "publish"): string {
  const what = context === "bank_file" ? "build this bank file" : "publish";
  return (
    `There is no record of the totals Part 2 confirmed for this run, so it is not possible to ${what} ` +
    "and prove the figures are the ones that were confirmed. Reopen Part 2 and confirm it again — that " +
    "records the totals — then try again. Nothing was changed."
  );
}

/**
 * When the stamp started being written: #3706 merged 2026-09-11 20:18 Cairo. A run whose Part 2 was
 * confirmed before then never had one, and refusing it for that would block a month that did nothing
 * wrong — it keeps the old behaviour (compared when a stamp exists, recorded as uncompared otherwise).
 * Every confirm since has one, and from 2026-10-23 one written inside its claim.
 */
export const PART2_STAMP_FIRST_WRITTEN_AT = "2026-09-11T17:18:30Z";

/** Whether a run's Part 2 confirm is older than the stamp itself, so a missing stamp is expected. */
export function confirmedBeforeStampExisted(part2ConfirmedAt: string | null | undefined): boolean {
  if (!part2ConfirmedAt) return false;
  const at = Date.parse(part2ConfirmedAt);
  return Number.isFinite(at) && at < Date.parse(PART2_STAMP_FIRST_WRITTEN_AT);
}

/**
 * Whether a downloaded Part 2 file — the full finance sheet, the Part 2 FAB and CIB files — matches the
 * stamp. Held only while the run is `ready`, the window in which finance is handed these files to
 * execute. A PUBLISHED month is not: its payslips are the record of what was paid, a re-download
 * rebuilt from today's data is a copy, and the only remedy a refusal could name (reopen Part 2) is not
 * open to a published run — so July and August, published before the stamp existed, would otherwise
 * never download again, and September would stop the first time a salary is edited.
 */
export function assertPart2FileMatchesStamp(
  run: { phase: string; part2ConfirmedAt?: string | null },
  stamp: ConfirmedTotals | null,
  current: ConfirmedTotals,
): void {
  if (run.phase !== "ready") return;
  if (!stamp && confirmedBeforeStampExisted(run.part2ConfirmedAt)) return;
  assertMatchesPart2Confirm(stamp, current, "bank_file");
}

/**
 * THE ONE CHECK publish and every Part-2-scoped bank file run against the stamp. Throws a Conflict
 * when the stamp is missing or the month has moved; returns quietly only when the figures match.
 */
export function assertMatchesPart2Confirm(
  confirmed: ConfirmedTotals | null,
  current: ConfirmedTotals,
  context: ConfirmCheckContext,
): void {
  if (!confirmed) throw new Error(`Conflict: ${describeMissingPart2Stamp(context)}`);
  const drift = compareConfirmedTotals(confirmed, current);
  if (drift.length > 0) throw new Error(`Conflict: ${describeTotalsDrift(drift, context)}`);
}
