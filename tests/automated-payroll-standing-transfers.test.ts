import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { seedRunFromRecurring } from "../src/lib/automated-payroll/non-employee-recurring.ts";
import {
  recommendManualDeductions,
  recommendSpecialSituations,
  type PopulationMember,
} from "../src/lib/automated-payroll/recommend.ts";
import {
  isStandingTransferDue,
  seedRunFromStandingTransfers,
  standingTransfersByCompact,
  type StandingTransfer,
} from "../src/lib/automated-payroll/standing-transfers.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * PART OF AN EMPLOYEE'S SALARY, PAID TO A NON-EMPLOYEE, EVERY MONTH FOR A WINDOW.
 *
 * Owner request 2026-11-24: 1,500 EGP from each part of Omar Gawish's salary, paid to Anwar Ibrahim
 * Ahmed Ibrahim Gaweesh on that part's Non-Employees list, "starting from november 2026 and 11 months
 * ahead" — November 2026 to October 2027.
 *
 * Pinned here: the window; the two pre-fills (Part 1 on Special Situations as a FIRST-PART deduction,
 * Part 2 on "Any more deductions?") with HR's saved figure always winning; the payee lines seeded once
 * per run and never onto a confirmed part; and that the transfer line never makes the roster skip the
 * payee's OWN salary, which goes to the same account.
 */

const p = (year: number, month: number) => ({ year, month });

function transfer(part: "first" | "second", overrides: Partial<StandingTransfer> = {}): StandingTransfer {
  return {
    id: `st-${part}`,
    employeeHrId: "B-10",
    employeeHrIdCompact: "B10",
    part,
    amount: 1_500,
    firstMonthKey: "2026-11",
    lastMonthKey: "2027-10",
    payeeFullNameEn: "Anwar Ibrahim Ahmed Ibrahim Gaweesh",
    payeeFullNameAr: "أنور إبراهيم أحمد إبراهيم جاويش",
    payeeBankName: "CIB",
    payeeBankAccount: "100023050538",
    reason: "Transfer to Anwar",
    active: true,
    ...overrides,
  };
}

function registerRow(part: "first" | "second", overrides: Record<string, unknown> = {}) {
  return {
    id: `st-${part}`,
    employee_hr_id: "B-10",
    employee_hr_id_compact: "b10",
    part,
    amount: 1500,
    first_month_key: "2026-11",
    last_month_key: "2027-10",
    payee_full_name_en: "Anwar Ibrahim Ahmed Ibrahim Gaweesh",
    payee_full_name_ar: "أنور إبراهيم أحمد إبراهيم جاويش",
    payee_bank_name: "CIB",
    payee_bank_account: "100023050538",
    reason: "Transfer to Anwar",
    active: true,
    ...overrides,
  };
}

function member(hrId: string, compact: string): PopulationMember {
  return {
    employee: { hrId, fullName: "Test Person", jobTitle: "Super Admin", lineName: null, hireDate: "2025-09-01" },
    compact,
    lifecycle: "continuing",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  } as unknown as PopulationMember;
}

const RUN = "run-november";

export async function runAutomatedPayrollStandingTransfersTests() {
  const both = [transfer("first"), transfer("second")];

  // ---- HEADLINE: November 2026 and the 11 months after it, nothing either side ---------------------
  const dueIn = (year: number, month: number) => standingTransfersByCompact(both, p(year, month)).get("b10");
  assert.equal(dueIn(2026, 10), undefined, "October 2026 is before the window");
  assert.deepEqual(
    [dueIn(2026, 11)?.first, dueIn(2026, 11)?.second],
    [1_500, 1_500],
    "November 2026 takes 1,500 from each part",
  );
  assert.deepEqual([dueIn(2027, 10)?.first, dueIn(2027, 10)?.second], [1_500, 1_500], "October 2027 is the twelfth and last month");
  assert.equal(dueIn(2027, 11), undefined, "November 2027 owes nothing");
  let months = 0;
  for (let index = 0; index < 24; index += 1) {
    const year = 2026 + Math.floor((10 + index) / 12);
    const month = ((10 + index) % 12) + 1;
    if (dueIn(year, month)) months += 1;
  }
  assert.equal(months, 12, "exactly twelve months — November and 11 months ahead");

  // The register's casing is not the key: the run keys every employee by compactHrKey, lower case.
  assert.equal(standingTransfersByCompact(both, p(2026, 11)).get("B10"), undefined);
  assert.match(dueIn(2026, 11)?.firstReason ?? "", /Anwar Ibrahim Ahmed Ibrahim Gaweesh.*Part 1/, "the reason names the payee and the part");

  assert.equal(isStandingTransferDue(transfer("first", { active: false }), p(2026, 11)), false, "an inactive entry is never due");
  assert.equal(isStandingTransferDue(transfer("first", { amount: 0 }), p(2026, 11)), false);
  assert.equal(isStandingTransferDue(transfer("first", { firstMonthKey: "bad" }), p(2026, 11)), false);

  // ---- PART 1: Special Situations pre-fills a FIRST-PART deduction ---------------------------------
  const due = standingTransfersByCompact(both, p(2026, 11));
  const [omar, other] = recommendSpecialSituations(
    [member("B-10", "b10"), member("A-1", "a1")],
    new Map(),
    new Map(),
    due,
  );
  assert.equal(omar?.values.specialDeductionValue, 1_500, "the Part 1 deduction is pre-filled");
  assert.equal(omar?.recommended.specialDeductionValue, 1_500);
  assert.equal(omar?.selects?.specialSituationPart, "first", "and applied to the FIRST part — the only way Part 1 takes it");
  assert.equal(omar?.details?.length, 1, "with one breakdown line saying where the money goes");
  assert.equal(omar?.details?.[0]?.Category, "Standing transfer");
  assert.equal(other?.values.specialDeductionValue, 0, "nobody else is touched");
  assert.equal(other?.selects?.specialSituationPart, "second", "and their default part is unchanged");
  assert.equal(other?.details, undefined);

  // HR's saved figure and part win — November's step was confirmed at 0 / Second before this existed.
  const savedP1 = new Map<string, DraftRow>([
    ["b10", { employeeHrIdCompact: "b10", specialDeductionValue: 0, specialSituationPart: "second" } as DraftRow],
  ]);
  const [kept] = recommendSpecialSituations([member("B-10", "b10")], new Map(), savedP1, due);
  assert.equal(kept?.values.specialDeductionValue, 0, "a figure HR saved is never overwritten by the register");
  assert.equal(kept?.selects?.specialSituationPart, "second", "nor the part HR chose");
  assert.equal(kept?.recommended.specialDeductionValue, 1_500, "but the recommendation still shows what is due");

  // ---- PART 2: "Any more deductions?" pre-fills on top of the approved loan / other -------------------
  const [omarP2, otherP2] = recommendManualDeductions(
    [member("B-10", "b10"), member("A-1", "a1")],
    new Map(),
    new Map(),
    new Map(),
    due,
  );
  assert.equal(omarP2?.values.manualOtherDeductions, 1_500, "the Part 2 deduction is pre-filled");
  assert.equal(omarP2?.recommended.manualOtherDeductions, 1_500);
  assert.match(omarP2?.reason ?? "", /Part 2/, "with a reason, so the confirm rule is satisfied honestly");
  assert.ok(omarP2?.details?.some((line) => line.Category === "Standing transfer"));
  assert.equal(otherP2?.values.manualOtherDeductions, 0);
  assert.equal(otherP2?.reason, null);

  const savedP2 = new Map<string, DraftRow>([
    ["b10", { employeeHrIdCompact: "b10", manualOtherDeductions: 200, manualReason: null } as DraftRow],
  ]);
  const [keptP2] = recommendManualDeductions([member("B-10", "b10")], new Map(), new Map(), savedP2, due);
  assert.equal(keptP2?.values.manualOtherDeductions, 200, "HR's saved Part 2 figure wins");
  assert.equal(keptP2?.reason, null, "and a reason written for 1,500 is not attached to HR's different figure");

  // An employee settled in Part 1 has no Part 2 to take it from.
  const oneSettled = new Map<string, DraftRow>([["b10", { employeeHrIdCompact: "b10", settledInPart1: true } as DraftRow]]);
  const [settled] = recommendManualDeductions([member("B-10", "b10")], new Map(), new Map(), oneSettled, due);
  assert.equal(settled?.values.manualOtherDeductions, 0);

  // ---- THE PAYEE'S LINES: seeded once per run, never onto a confirmed part ---------------------------
  const world = fakeSupabaseClient({
    automated_payroll_standing_transfers: [registerRow("first"), registerRow("second"), registerRow("first", { id: "st-old", active: false })],
    automated_payroll_non_employees: [],
  });
  const first = await seedRunFromStandingTransfers({ runId: RUN, actorHrId: "B-10", phase: "part1", period: p(2026, 11), client: world as never });
  assert.equal(first.inserted.length, 2, "one line per part");
  const lines = world.rows("automated_payroll_non_employees");
  assert.deepEqual(
    lines.map((row) => `${String(row.part)}|${String(row.total_salary)}|${String(row.bank_account)}|${String(row.standing_transfer_id)}`).sort(),
    ["first|1500|100023050538|st-first", "second|1500|100023050538|st-second"],
  );
  assert.equal(world.rows("automated_payroll_audit").length, 1, "the seed is audited, to the same client");

  const again = await seedRunFromStandingTransfers({ runId: RUN, actorHrId: "B-10", phase: "part1", period: p(2026, 11), client: world as never });
  assert.equal(again.inserted.length, 0, "a second press adds nothing");
  assert.equal(world.rows("automated_payroll_non_employees").length, 2);

  const outside = fakeSupabaseClient({ automated_payroll_standing_transfers: [registerRow("first")], automated_payroll_non_employees: [] });
  await seedRunFromStandingTransfers({ runId: RUN, actorHrId: "B-10", phase: "part1", period: p(2027, 11), client: outside as never });
  assert.equal(outside.rows("automated_payroll_non_employees").length, 0, "nothing outside the window");

  const part2 = fakeSupabaseClient({
    automated_payroll_standing_transfers: [registerRow("first"), registerRow("second")],
    automated_payroll_non_employees: [],
  });
  const late = await seedRunFromStandingTransfers({ runId: RUN, actorHrId: "B-10", phase: "part2", period: p(2026, 11), client: part2 as never });
  assert.deepEqual(late.heldBackPartClosed, ["Anwar Ibrahim Ahmed Ibrahim Gaweesh (first)"], "Part 1's money is out — named, not added");
  assert.deepEqual(part2.rows("automated_payroll_non_employees").map((row) => row.part), ["second"]);

  // ---- THE TRANSFER LINE NEVER MAKES THE ROSTER SKIP THE PAYEE'S OWN SALARY -------------------------
  // Same person, same account, same part: without the provenance check the roster would read his
  // salary as a duplicate of the 1,500 line and leave him unpaid.
  const roster = fakeSupabaseClient({
    automated_payroll_non_employee_recurring: [
      {
        id: "rec-anwar-first",
        part: "first",
        full_name_ar: "أنور إبراهيم أحمد إبراهيم جاويش",
        full_name_en: "Anwar Ibrahim Ahmed Ibrahim Gaweesh",
        total_salary: 158_487,
        bank_name: "CIB",
        bank_account: "100023050538",
        active: true,
        note: null,
      },
    ],
    automated_payroll_non_employees: [
      {
        run_id: RUN,
        recurring_id: null,
        standing_transfer_id: "st-first",
        part: "first",
        full_name_ar: "أنور إبراهيم أحمد إبراهيم جاويش",
        full_name_en: "Anwar Ibrahim Ahmed Ibrahim Gaweesh",
        total_salary: 1_500,
        bank_name: "CIB",
        bank_account: "100023050538",
      },
    ],
  });
  const rosterSeed = await seedRunFromRecurring({ runId: RUN, actorHrId: "B-10", phase: "part1", client: roster as never });
  assert.equal(rosterSeed.inserted, 1, "his own salary is still seeded beside the transfer line");
  assert.deepEqual(rosterSeed.skippedAsDuplicate, []);

  // ---- The wiring and the migration ---------------------------------------------------------------
  const recommendSource = readFileSync(new URL("../src/lib/automated-payroll/recommend.ts", import.meta.url), "utf8");
  assert.match(recommendSource, /recommendSpecialSituations\(input\.members, input\.sources, drafts, await loadStandingTransfers\(input\.period\)\)/);
  assert.match(recommendSource, /drafts,\s*await loadStandingTransfers\(input\.period\),\s*\);/);
  const runService = readFileSync(new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url), "utf8");
  assert.match(runService, /try\s*\{\s*await seedRunFromStandingTransfers\(/, "a new run seeds the transfers, best-effort");
  const recurring = readFileSync(new URL("../src/lib/automated-payroll/non-employee-recurring.ts", import.meta.url), "utf8");
  assert.match(recurring, /seedRunFromStandingTransfers\(\{/, "and the panel's Sync adds them to a run opened before them");

  const migration = stripSqlComments(
    readFileSync(new URL("../supabase/migrations/20261124075155_automated_payroll_standing_transfers.sql", import.meta.url), "utf8"),
  );
  assert.match(migration, /create table if not exists public\.automated_payroll_standing_transfers/);
  assert.match(migration, /alter table public\.automated_payroll_standing_transfers enable row level security/);
  assert.match(migration, /automated_payroll_standing_transfers_phx_employee_fkey\s+foreign key \(employee_hr_id\) references public\.employees\(hr_id\)/);
  assert.match(migration, /add column if not exists standing_transfer_id uuid/);
  assert.match(migration, /on public\.automated_payroll_non_employees \(run_id, standing_transfer_id\)\s+where standing_transfer_id is not null/);
  assert.match(migration, /insert into recovery\.protected_tables/);
  assert.match(migration, /'b10', p\.part, 1500, '2026-11', '2027-10'/, "the owner's two entries: 1,500 a part, November 2026 to October 2027");
  assert.match(migration, /values \('first'\), \('second'\)/);
  assert.doesNotMatch(migration, /grant[^;]*\bto (anon|authenticated)\b/i, "no grant to anon or authenticated");
}
