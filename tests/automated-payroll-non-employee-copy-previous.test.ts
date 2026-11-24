import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { planPreviousRunCopy } from "../src/lib/automated-payroll/non-employee-recurring.ts";
import { isRunHoldAction, RUN_HOLD_ACTIONS } from "../src/lib/automated-payroll/transition-claim.ts";
import type { NonEmployeePayrollRow, RecurringNonEmployeeRow } from "../src/lib/automated-payroll/types.ts";

/**
 * NOVEMBER'S PART 1 OPENED WITH NO NON-EMPLOYEES (owner, 2026-11-24: "in automated salary the non
 * employees in part 1 disappeared").
 *
 * A new run copies its non-employees from the STANDING list. All seven standing entries were removed
 * between 6 October and 13 November 2026 — the per-run rows of September and October lost their link to
 * the list at the same time, which is the database's `on delete set null` — so the November run, opened
 * on 22 November, copied nobody. Nothing recorded who removed them: the standing list wrote no audit row.
 *
 * Two things are pinned here:
 *
 *  1. Last published month's list can be brought back from the screen. `planPreviousRunCopy` is the whole
 *     decision of who may be copied — a person already on this month's list is never copied twice
 *     (matched on the account OR either name, per part), a part whose money is out is never added to,
 *     and a paid entry with no bank is named, never copied.
 *  2. Every change to the standing list now writes an audit row, so the next removal says who did it.
 */

const RECURRING_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/automated-payroll/non-employee-recurring.ts", import.meta.url)),
  "utf8",
);
const ROUTE_SOURCE = readFileSync(
  fileURLToPath(
    new URL("../app/api/automated-payroll/runs/[runId]/non-employees/previous/route.ts", import.meta.url),
  ),
  "utf8",
);
const PANEL_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/automated-payroll/non-employees-panel.tsx", import.meta.url)),
  "utf8",
);
const REGISTRY_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/security/access-registry.ts", import.meta.url)),
  "utf8",
);

let seq = 0;
function paid(overrides: Partial<NonEmployeePayrollRow> = {}): NonEmployeePayrollRow {
  seq += 1;
  return {
    id: `prev-${seq}`,
    runId: "run-october",
    part: "first",
    fullNameAr: "اسم",
    fullNameEn: `Person ${seq}`,
    totalSalary: 7000,
    bankName: "CIB",
    bankAccount: `100${seq}`,
    recurringId: null,
    standingTransferId: null,
    createdBy: "B-10",
    createdAt: "2026-10-06T23:26:24Z",
    updatedAt: "2026-10-06T23:26:24Z",
    ...overrides,
  };
}

function standing(overrides: Partial<RecurringNonEmployeeRow> = {}): RecurringNonEmployeeRow {
  return {
    id: "standing-1",
    part: "first",
    fullNameAr: "",
    fullNameEn: "",
    totalSalary: 7000,
    bankName: "CIB",
    bankAccount: null,
    active: true,
    note: null,
    createdBy: "B-10",
    createdAt: "2026-08-30T00:00:00Z",
    updatedAt: "2026-08-30T00:00:00Z",
    ...overrides,
  };
}

export function runAutomatedPayrollNonEmployeeCopyPreviousTests() {
  // ---- HEADLINE: November 2026 — October's seven, an empty standing list, an empty run ---------
  const october = [
    paid({ fullNameEn: "Adel Mohamed Ali Elsayed", totalSalary: 60361, bankAccount: "A1" }),
    paid({ fullNameEn: "Anwar Ibrahim Ahmed Ibrahim Gaweesh", totalSalary: 158487, bankAccount: "A2" }),
    paid({ fullNameEn: "Anwar Ibrahim Ahmed Ibrahim Gaweesh", totalSalary: 90000, bankAccount: "A2", part: "second" }),
    paid({ fullNameEn: "Medhat Makram", bankName: "QNB", bankAccount: "A3" }),
    paid({ fullNameEn: "Nabil Adly", bankName: "QNB", bankAccount: "A4" }),
    paid({ fullNameEn: "Sahar Khalil Kamel Mohamed Kamel", totalSalary: 53687, bankAccount: "A5" }),
    paid({ fullNameEn: "Walaa Abdelwahab", totalSalary: 5000, bankName: "Instapay", bankAccount: "A6" }),
  ];
  const november = planPreviousRunCopy({ previous: october, roster: [], current: [], phase: "part1" });
  assert.equal(november.length, 7, "every person October paid is offered");
  assert.ok(
    november.every((row) => row.blockedReason === null && !row.alreadyOnThisRun && row.standingEntryId === null),
    "with the run in Part 1, all seven can be copied — the Part 2 entry too, since that money is not out yet",
  );
  assert.equal(
    november.reduce((sum, row) => sum + row.totalSalary, 0),
    381535,
    "the same 381,535 October and every month before it paid",
  );

  // ---- Never twice: someone already on this month's list, under any shared key, per part ------
  const typedByHand = planPreviousRunCopy({
    previous: [
      paid({ fullNameEn: "Medhat Makram", bankAccount: "QNB-77" }),
      paid({ fullNameEn: "Nabil Adly", bankAccount: "QNB-88" }),
      paid({ fullNameEn: "Sahar Kamel", bankAccount: "CIB-99", part: "second" }),
    ],
    roster: [],
    current: [
      // Same account, name spelt differently.
      { part: "first", fullNameEn: "Medhat Makram Wahba", bankAccount: "QNB 77" },
      // Same name, no account typed.
      { part: "first", fullNameEn: "  nabil   ADLY ", bankAccount: null },
      // Same person, but on the OTHER part — a split salary is two payments.
      { part: "first", fullNameEn: "Sahar Kamel", bankAccount: "CIB-99" },
    ],
    phase: "part1",
  });
  assert.equal(typedByHand[0].alreadyOnThisRun, true, "matched on the account, whatever the spelling");
  assert.equal(typedByHand[1].alreadyOnThisRun, true, "matched on the name, whatever the spacing and case");
  assert.equal(typedByHand[2].alreadyOnThisRun, false, "a Part 1 row never hides the Part 2 payment");

  // ---- A part whose money is out is never added to -------------------------------------------
  const inPart2 = planPreviousRunCopy({
    previous: [paid({ part: "first" }), paid({ part: "second" })],
    roster: [],
    current: [],
    phase: "part2",
  });
  assert.match(String(inPart2[0].blockedReason), /Part 1 is already confirmed/);
  assert.equal(inPart2[1].blockedReason, null, "Part 2 is still open in Part 2");
  const ready = planPreviousRunCopy({ previous: [paid({ part: "second" })], roster: [], current: [], phase: "ready" });
  assert.match(String(ready[0].blockedReason), /Part 2 is already confirmed/);

  // ---- A paid entry with nowhere to send the money is named, never copied --------------------
  const noBank = planPreviousRunCopy({
    previous: [paid({ bankName: null }), paid({ bankAccount: "" })],
    roster: [],
    current: [],
    phase: "part1",
  });
  assert.match(String(noBank[0].blockedReason), /bank is required/);
  assert.match(String(noBank[1].blockedReason), /account number is required/);
  assert.ok(noBank.every((row) => !/^Validation:/.test(String(row.blockedReason))), "said in words, not as a code");

  // ---- A standing entry the person still has is reused, switched off or not ------------------
  const reused = planPreviousRunCopy({
    previous: [paid({ fullNameEn: "Walaa Abdelwahab", bankAccount: "IP-1" }), paid({ fullNameEn: "Walaa Abdelwahab", bankAccount: "IP-1", part: "second" })],
    roster: [standing({ id: "walaa-p1", fullNameEn: "walaa abdelwahab", active: false })],
    current: [],
    phase: "part1",
  });
  assert.equal(reused[0].standingEntryId, "walaa-p1", "matched by name on the same part");
  assert.equal(reused[1].standingEntryId, null, "a Part 1 entry is not the Part 2 entry");

  // ---- A standing-transfer line is part of an employee's salary, never the payee's own entry ----
  // December 2026: November paid Anwar Gaweesh his own salary AND the 1,500 transfer line from Omar
  // Gawish's First Part, both to one account. The transfer seeds December's line by itself, so copying
  // it would pay 1,500 twice and make it a permanent standing entry; and the transfer line already on
  // December's run must not make his own salary read as "already on this run".
  const anwarOwn = paid({ fullNameEn: "Anwar Ibrahim Ahmed Ibrahim Gaweesh", totalSalary: 158487, bankAccount: "100023050538" });
  const anwarTransfer = paid({
    fullNameEn: "Anwar Ibrahim Ahmed Ibrahim Gaweesh",
    totalSalary: 1500,
    bankAccount: "100023050538",
    standingTransferId: "transfer-part1",
  });
  const decemberTransfer: NonEmployeePayrollRow = { ...anwarTransfer, id: "dec-transfer", runId: "run-december" };
  const december = planPreviousRunCopy({
    previous: [anwarOwn, anwarTransfer],
    roster: [],
    current: [decemberTransfer],
    phase: "part1",
  });
  assert.deepEqual(
    december.map((row) => row.id),
    [anwarOwn.id],
    "the transfer line is never offered for copying — the transfer seeds it every month it is due",
  );
  assert.equal(
    december[0].alreadyOnThisRun,
    false,
    "the transfer line on this run is not the payee being on this run — his own salary can still be copied",
  );

  // ---- The write: under the run's hold, re-planned inside it ---------------------------------
  assert.equal(isRunHoldAction(RUN_HOLD_ACTIONS.nonEmployeeCopy), true, "Confirm waits for a copy under way");
  assert.match(
    RECURRING_SOURCE,
    /holdRun\(\{ runId, expected: \[run\.phase\], action: RUN_HOLD_ACTIONS\.nonEmployeeCopy \}, async \(\) => \{\s*const fresh = await requireOpenRun\(runId\);\s*const plan = await loadPreviousRunPlan\(fresh\);/,
    "the copy holds the run and works the plan out again inside the hold",
  );
  assert.match(RECURRING_SOURCE, /\.eq\("phase", "published"\)\s*\.lt\("month_key", run\.monthKey\)/, "copies from the last PAID month");
  assert.match(RECURRING_SOURCE, /action: "non_employee_copied_from_previous_run"/, "the copy is recorded on the run");

  // ---- Every standing-list change is recorded, a removal included -----------------------------
  for (const action of ["non_employee_recurring_added", "non_employee_recurring_updated", "non_employee_recurring_deleted"]) {
    assert.match(RECURRING_SOURCE, new RegExp(`auditRosterChange\\(access, "${action}"`), `${action} is written`);
  }
  assert.match(
    RECURRING_SOURCE,
    /const before = await readRosterEntry\(id\);\s*const \{ error \} = await getSupabaseAdmin\(\)\.from\(TABLE\)\.delete\(\)/,
    "a removal reads the entry first, so its record names who was removed",
  );

  // ---- Route, registry and screen ------------------------------------------------------------
  assert.match(ROUTE_SOURCE, /assertAutomatedPayrollHrActor\(access\);\s*const parsed = await parseJsonBody\(request, CopyBodySchema\)/);
  assert.match(REGISTRY_SOURCE, /pattern: "\/api\/automated-payroll\/runs\/:runId\/non-employees\/previous"/);
  assert.match(PANEL_SOURCE, /<PreviousMonthNonEmployees runId=\{runId\} onCopied=\{\(\) => load\(\)\} \/>/);
}
