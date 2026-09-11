/**
 * Whether an employee may still be dropped from a payroll run.
 *
 * `excludeEmployeeFromRun` exists for one case: a row whose Gross Salary is 0 or less hard-blocks
 * Part 2 for the whole run, with nothing to acknowledge past. Exclusion takes that one person out of
 * every step, sheet, bank file, reconciliation, validation and publish of this run.
 *
 * Nothing stopped it after Part 1 was confirmed (audit finding 39). Part 1 confirm freezes each
 * person's first instalment, and finance then pays it from the Part 1 bank files. Excluding somebody
 * after that erased them from every output of the month with the money already in their account: no
 * salary record, no ledger entry, no line in the published detail. The payment left the company with
 * nothing in payroll saying it had.
 *
 * So once Part 1 is confirmed, a person carrying a frozen first instalment above zero cannot be
 * excluded. Zero stays excludable on purpose: that is exactly the no-salary row this escape hatch was
 * built for, and nothing was paid to them. A null frozen value means they were not in the population
 * when Part 1 froze (excluded before it, or added after), so nothing was paid either. A value that is
 * not a number cannot show that nothing was paid, so it refuses.
 *
 * Pure, so the rule is tested directly; `excludeEmployeeFromRun` supplies the run and the draft row.
 */
export function exclusionRefusal(input: {
  part1ConfirmedAt: string | null;
  firstPartFrozen: number | null | undefined;
}): string | null {
  if (!input.part1ConfirmedAt) return null;
  const frozen = input.firstPartFrozen;
  if (frozen === null || frozen === undefined) return null;
  if (Number.isFinite(frozen) && frozen <= 0) return null;

  const what = Number.isFinite(frozen)
    ? `their first instalment of EGP ${frozen.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is already frozen for payment`
    : "their frozen first instalment could not be read, so it cannot be shown that nothing was paid";
  return (
    `Validation: this employee cannot be excluded. Part 1 is confirmed and ${what}. ` +
    "Excluding them now would erase money paid out from every sheet, bank file and record of this month. " +
    "If they should not receive the rest of the month, put them on hold in Hold review instead: a held employee stays on the record."
  );
}
