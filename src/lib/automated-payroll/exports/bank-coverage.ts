import type { AssembledRow } from "../assemble.ts";
import type { NonEmployeePayrollRow } from "../types.ts";

/**
 * Who the bank files carry, and — the part that did not exist before — who they DON'T.
 *
 * THE DEFECT THIS CLOSES, measured on production 2026-09-10. `fabRowsForScope` and
 * `cibRowsForScope` route on an exact, case-folded match of the words "FAB" and "CIB", and both
 * silently drop everything else. The only check on either finished file is whether it came out
 * completely EMPTY (run-service.ts). So a file missing a fifth of the payable population builds,
 * opens, is named normally, and reports nothing — not in the download, not on the sheet, not in the
 * audit table, not in a log.
 *
 * That is not hypothetical. Three people on the August standing roster are paid every month and
 * appear in neither file: Medhat Makram and Nabil Adly are recorded on "QNB", Walaa Abdelwahab on
 * "Instapay". EGP 19,000 a month. The finance sheet's TOTALS row still counts their money, because
 * it filters on the amount column and never on the bank — so the sheet certifies a payment the bank
 * files cannot make, and has done for two months with nothing anywhere saying so.
 *
 * WHAT THIS MODULE DOES AND DOES NOT DO. It does not change who is paid. `resolveBankRoute` returns
 * exactly the same FAB/CIB decision the two sheet builders already made, so the files are
 * byte-identical. What it adds is the third answer — `unroutable`, with a reason — and a total that
 * has to reconcile: every payable row in a part is FAB, or CIB, or named on a list. There is no
 * fourth outcome and nothing falls off the edge.
 *
 * WHY NOT SIMPLY REFUSE A NON-FAB/CIB BANK. Because it would be wrong. Those three people really are
 * paid, through a route the company genuinely uses and this system does not model. Rejecting the
 * bank name would break the standing roster for people who are owed money; hiding them is what the
 * system does today. Naming them is the honest third option, and it is the one that lets finance act.
 */

/** FAB, CIB, or neither. `unroutable` always carries a reason. */
export type BankRoute = "FAB" | "CIB" | "unroutable";

export type BankRouteDecision = {
  route: BankRoute;
  /** Why this row reaches no bank file. Null when it does. */
  reason: string | null;
};

/**
 * The single routing decision, shared by both sheet builders and the coverage report.
 *
 * Deliberately identical to the predicate the two builders already used — `trim().toUpperCase()`
 * against the literal words, plus a non-empty account — so adopting this changes no file's
 * contents. The reasons are written for finance to read, not for a log.
 */
export function resolveBankRoute(input: {
  bankName: string | null | undefined;
  bankAccount: string | null | undefined;
}): BankRouteDecision {
  const bank = (input.bankName ?? "").trim();
  const account = (input.bankAccount ?? "").trim();

  if (!bank) {
    return { route: "unroutable", reason: "No bank recorded" };
  }

  const normalized = bank.toUpperCase();
  if (normalized !== "FAB" && normalized !== "CIB") {
    return {
      route: "unroutable",
      reason: `Paid through ${bank}, which has no bulk transfer file`,
    };
  }

  // The account test comes AFTER the bank test on purpose: "FAB with no account number" and
  // "QNB" are different problems for whoever has to fix them, and collapsing them into one
  // message sends finance looking in the wrong place.
  if (!account) {
    return { route: "unroutable", reason: `${normalized} account number is missing` };
  }

  return { route: normalized, reason: null };
}

export type BankCoverageEntry = {
  name: string;
  /** Null for a Non-Employees Payroll entry, which by definition has no HR record. */
  hrId: string | null;
  kind: "employee" | "non-employee";
  bankName: string;
  amount: number;
  reason: string;
};

export type BankCoverage = {
  scope: "part1" | "part2";
  /** Rows and money each file will actually carry. */
  fab: { rows: number; total: number };
  cib: { rows: number; total: number };
  /** Everyone payable this part who reaches neither file, named. */
  unroutable: BankCoverageEntry[];
  unroutableTotal: number;
  /** FAB + CIB + unroutable. The figure the finance sheet's own total must agree with. */
  payableRows: number;
  payableTotal: number;
  /** True when every payable row reaches a file. The one thing finance needs to read. */
  covered: boolean;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Classify every payable row in one part of a run.
 *
 * Held and excluded employees are deliberately NOT here. They are not unroutable — they are
 * unpaid by decision, which is a different question with a different answer, and folding the two
 * together would bury a hold inside a bank-routing problem. Held people are recorded separately at
 * publish (see held-record.ts).
 *
 * A zero or negative amount is not payable and is not reported either: a leaver fully settled in
 * Part 1 legitimately has a Part-2 amount of 0, and listing him as "missing from the bank file"
 * would be noise that trains finance to ignore the list.
 */
export function buildBankCoverage(input: {
  rows: AssembledRow[];
  nonEmployees: NonEmployeePayrollRow[];
  scope: "part1" | "part2";
}): BankCoverage {
  const part = input.scope === "part1" ? "first" : "second";
  const fab = { rows: 0, total: 0 };
  const cib = { rows: 0, total: 0 };
  const unroutable: BankCoverageEntry[] = [];

  const take = (entry: {
    name: string;
    hrId: string | null;
    kind: "employee" | "non-employee";
    bankName: string | null;
    bankAccount: string | null;
    amount: number;
  }) => {
    if (!(entry.amount > 0)) return;
    const decision = resolveBankRoute({ bankName: entry.bankName, bankAccount: entry.bankAccount });
    if (decision.route === "FAB") {
      fab.rows += 1;
      fab.total = round(fab.total + entry.amount);
      return;
    }
    if (decision.route === "CIB") {
      cib.rows += 1;
      cib.total = round(cib.total + entry.amount);
      return;
    }
    unroutable.push({
      name: entry.name,
      hrId: entry.hrId,
      kind: entry.kind,
      bankName: (entry.bankName ?? "").trim() || "—",
      amount: round(entry.amount),
      reason: decision.reason ?? "Reaches no bank file",
    });
  };

  for (const entry of input.rows) {
    if (heldForScope(entry, input.scope)) continue;
    take({
      name: entry.row.fullName,
      hrId: entry.row.hrId,
      kind: "employee",
      bankName: entry.bankName,
      bankAccount: entry.bankAccount,
      amount: input.scope === "part1" ? entry.row.firstPart : entry.row.secondPart,
    });
  }

  for (const entry of input.nonEmployees) {
    if (entry.part !== part) continue;
    take({
      name: entry.fullNameEn,
      hrId: null,
      kind: "non-employee",
      bankName: entry.bankName,
      bankAccount: entry.bankAccount,
      amount: entry.totalSalary,
    });
  }

  const unroutableTotal = round(unroutable.reduce((sum, row) => sum + row.amount, 0));

  return {
    scope: input.scope,
    fab,
    cib,
    unroutable,
    unroutableTotal,
    payableRows: fab.rows + cib.rows + unroutable.length,
    payableTotal: round(fab.total + cib.total + unroutableTotal),
    covered: unroutable.length === 0,
  };
}

/**
 * One sentence for a download response or a sheet cover. Always says the whole truth: a covered
 * part says so explicitly rather than saying nothing, because "no warning" and "not checked" have
 * looked identical here for two months.
 */
export function describeBankCoverage(coverage: BankCoverage): string {
  const partLabel = coverage.scope === "part1" ? "Part 1" : "Part 2";
  if (coverage.covered) {
    return `${partLabel}: all ${coverage.payableRows} payable rows reach a bank file (FAB ${coverage.fab.rows}, CIB ${coverage.cib.rows}).`;
  }
  const names = coverage.unroutable.map((row) => `${row.name} (${row.reason}, ${row.amount.toFixed(2)})`);
  return (
    `${partLabel}: ${coverage.unroutable.length} of ${coverage.payableRows} payable rows reach NO bank file, ` +
    `totalling ${coverage.unroutableTotal.toFixed(2)}. They must be paid another way: ${names.join("; ")}`
  );
}

/**
 * Whether a row is left out of one part's bank file as held. Part 1 is decided by the hold AT Part 1
 * confirm (owner, 2026-10-26): someone held then and released later was not paid their first
 * instalment, so a Part 1 file rebuilt afterwards must still leave them out — it is the record of what
 * left the bank. A run confirmed before that was recorded falls back to the live hold, as before.
 */
export function heldForScope(entry: AssembledRow, scope: "part1" | "part2"): boolean {
  if (scope === "part1") return entry.part1Withheld ?? entry.onHold;
  return entry.onHold;
}
