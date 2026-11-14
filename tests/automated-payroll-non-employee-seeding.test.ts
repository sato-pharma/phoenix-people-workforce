import assert from "node:assert/strict";

import { seedRunFromRecurring } from "../src/lib/automated-payroll/non-employee-recurring.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * THE NON-EMPLOYEE ROSTER MUST NOT PAY SOMEBODY TWICE, OR ADD TO AN INSTALMENT ALREADY PAID.
 *
 * Non-Employees Payroll is a parallel money path: people with no HR record who are paid a monthly
 * salary through the FAB and CIB bank files. It never becomes a salary record and never passes the
 * pre-flight validator, so the guards on the employee sheet do not cover it at all.
 *
 * FINDING 16 — the duplicate guard matched only on the roster reference. A person typed in by hand
 * carries no reference, so seeding the standing list inserted them a SECOND time. Both rows reach
 * the bank file, and the sheet's totals row counts both.
 *
 * FINDING 17 — the sync refused only a published or cancelled run. Pressing it during Part 2
 * inserted a first-instalment row onto a Part 1 that finance had already executed. The per-part
 * edit lock in non-employees.ts then made that row impossible to change or delete: a first-part
 * entry is only editable while the run is in Part 1, and the run had left it.
 *
 * NEITHER HAS FIRED. Production's two published months each carry six first-part entries worth
 * 291,535 and one second-part entry worth 90,000, every one of them added while its own part was
 * still open, with no duplicates. July's were all typed by hand and August's were all seeded, so
 * the two provenances have never yet met on one run — which is exactly the arrangement that would
 * have paid somebody twice.
 *
 * ONE PERSON LEGITIMATELY APPEARS IN BOTH PARTS. Anwar Ibrahim Ahmed Ibrahim Gaweesh is on both
 * months as a first entry and a second entry, because his salary is split across the instalments.
 * Duplicate detection is therefore scoped to the part; a rule that ignored the part would refuse
 * to seed half his pay.
 *
 * THIS FILE ONCE WROTE TO THE REAL AUDIT LOG (fixed 2026-10-01). Every seed was read and written
 * through the fake below except its last step, the `non_employee_recurring_seeded` audit row,
 * which always went to the real admin client. A local run loads `.env.local`, which is production,
 * so every local run of this file sent five inserts to production's automated_payroll_audit;
 * Postgres refused them only because `run-september` is not a uuid. CI and the CI box hold no
 * Supabase credentials, so there the write failed before leaving the machine. The audit row now
 * goes to the same client as every other write, and the assertions below find it in the fake.
 */

const RUN = "run-september";

// Every paid entry carries an account since the standing list took the per-run bank rule (payroll audit
// 2026-11-14, finding 11), so the fixtures give each person one, derived from the name so that the same
// person on the roster and on the run is recognised by it, as in production.
const accountFor = (overrides: Record<string, unknown>) => `ACC-${String(overrides.full_name_en ?? "Roster Person")}`;

function rosterEntry(overrides: Record<string, unknown>) {
  return {
    id: `rec-${String(overrides.full_name_en ?? "x")}-${String(overrides.part ?? "first")}`,
    part: "first",
    full_name_ar: "اسم",
    full_name_en: "Roster Person",
    total_salary: 1000,
    bank_name: "CIB",
    bank_account: accountFor(overrides),
    active: true,
    note: null,
    created_by: "B-10",
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function runEntry(overrides: Record<string, unknown>) {
  return {
    run_id: RUN,
    recurring_id: null,
    part: "first",
    full_name_ar: "اسم",
    full_name_en: "Roster Person",
    total_salary: 1000,
    bank_name: "CIB",
    bank_account: accountFor(overrides),
    ...overrides,
  };
}

function world(roster: Array<Record<string, unknown>>, onTheRun: Array<Record<string, unknown>>) {
  return fakeSupabaseClient({
    automated_payroll_non_employee_recurring: roster,
    automated_payroll_non_employees: onTheRun,
  });
}

/** What the run's list holds after a seed, as `name|part`. */
function rowsOn(client: ReturnType<typeof fakeSupabaseClient>): string[] {
  return client
    .rows("automated_payroll_non_employees")
    .map((row) => `${String(row.full_name_en)}|${String(row.part)}`)
    .sort();
}

export async function runAutomatedPayrollNonEmployeeSeedingTests() {
  // ---- HEADLINE: a person already typed in by hand is not seeded on top of themselves ----------
  const handTyped = world(
    [rosterEntry({ full_name_en: "Medhat Makram", total_salary: 9500 })],
    [runEntry({ full_name_en: "Medhat Makram", total_salary: 9500 })],
  );
  const afterHandTyped = await seedRunFromRecurring({
    runId: RUN,
    actorHrId: "B-10",
    phase: "part1",
    client: handTyped as never,
  });
  assert.equal(
    afterHandTyped.inserted,
    0,
    "somebody already on the run for this part must not be seeded again — the old guard matched " +
      "only on the roster reference, which a hand-typed row does not carry, so both rows reached " +
      "the bank file",
  );
  assert.deepEqual(afterHandTyped.skippedAsDuplicate, ["Medhat Makram"], "and they are named, not just counted");
  assert.deepEqual(rowsOn(handTyped), ["Medhat Makram|first"], "the run still holds exactly one of them");
  assert.equal(handTyped.rows("automated_payroll_audit").length, 0, "nothing was seeded, so nothing is audited");

  // The bank account wins over the name, because it is what the money is actually sent to.
  const renamed = world(
    [rosterEntry({ full_name_en: "Nabil Adly", bank_account: "100 200 300" })],
    [runEntry({ full_name_en: "Nabil  ADLY  ", bank_account: "100200300" })],
  );
  await seedRunFromRecurring({ runId: RUN, actorHrId: "B-10", phase: "part1", client: renamed as never });
  assert.deepEqual(
    rowsOn(renamed),
    ["Nabil  ADLY  |first"],
    "the same account is the same person however the name was typed",
  );

  // ---- THE SAME PERSON IN BOTH PARTS IS NOT A DUPLICATE ----------------------------------------
  // Production carries exactly this: one person split across the two instalments.
  const split = world(
    [
      rosterEntry({ full_name_en: "Anwar Gaweesh", part: "first", total_salary: 41535 }),
      rosterEntry({ full_name_en: "Anwar Gaweesh", part: "second", total_salary: 90000 }),
    ],
    [],
  );
  const afterSplit = await seedRunFromRecurring({
    runId: RUN,
    actorHrId: "B-10",
    phase: "part1",
    client: split as never,
  });
  assert.equal(afterSplit.inserted, 2, "a salary split across both instalments is two entries, not a duplicate");
  assert.deepEqual(afterSplit.skippedAsDuplicate, []);
  assert.deepEqual(rowsOn(split), ["Anwar Gaweesh|first", "Anwar Gaweesh|second"]);

  // ---- THE AUDIT ROW GOES TO THE CLIENT THE SEED WAS GIVEN -----------------------------------------
  // Found in the fake, not sent to the real database: before 2026-10-01 this row always went to the
  // real admin client, so the fake held no audit row at all and a local run wrote to production.
  assert.deepEqual(
    split.rows("automated_payroll_audit").map((row) => ({
      action: row.action,
      inserted: (row.detail as { inserted?: unknown }).inserted,
      runId: row.run_id,
    })),
    [{ action: "non_employee_recurring_seeded", inserted: 2, runId: RUN }],
    "the seed's audit row must land in the client the seed was handed, like every other write it makes",
  );

  // ---- A PART WHOSE MONEY IS OUT CANNOT BE ADDED TO ---------------------------------------------
  const afterPart1 = world(
    [
      rosterEntry({ full_name_en: "Late First", part: "first", total_salary: 5000 }),
      rosterEntry({ full_name_en: "Fine Second", part: "second", total_salary: 7000 }),
    ],
    [],
  );
  const duringPart2 = await seedRunFromRecurring({
    runId: RUN,
    actorHrId: "B-10",
    phase: "part2",
    client: afterPart1 as never,
  });
  assert.deepEqual(
    duringPart2.heldBackPartClosed,
    ["Late First"],
    "a first-instalment entry must not be added once Part 1 is confirmed — that money has left the " +
      "company, and the per-part edit lock would make the row impossible to remove afterwards",
  );
  assert.deepEqual(
    rowsOn(afterPart1),
    ["Fine Second|second"],
    "the second-instalment entry is still perfectly addable, because that money has not gone out",
  );

  // A second entry seeded while the run is still in Part 1 is the normal case and must keep working.
  // Production's August run seeded all seven three hours before Part 1 was confirmed.
  const normalMonth = world(
    [
      rosterEntry({ full_name_en: "Six First", part: "first" }),
      rosterEntry({ full_name_en: "One Second", part: "second" }),
    ],
    [],
  );
  const atRunStart = await seedRunFromRecurring({
    runId: RUN,
    actorHrId: "B-10",
    phase: "part1",
    client: normalMonth as never,
  });
  assert.equal(atRunStart.inserted, 2, "both parts seed at run creation, exactly as they always did");
  assert.deepEqual(atRunStart.heldBackPartClosed, []);

  // Once Part 2 is confirmed the run is `ready`, and neither part may grow.
  const ready = world(
    [
      rosterEntry({ full_name_en: "Too Late First", part: "first" }),
      rosterEntry({ full_name_en: "Too Late Second", part: "second" }),
    ],
    [],
  );
  const afterReady = await seedRunFromRecurring({
    runId: RUN,
    actorHrId: "B-10",
    phase: "ready",
    client: ready as never,
  });
  assert.equal(afterReady.inserted, 0, "a run whose sheet is assembled takes no new money at all");
  assert.deepEqual(afterReady.heldBackPartClosed.sort(), ["Too Late First", "Too Late Second"]);

  // ---- The original guard still works ------------------------------------------------------------
  // An entry already seeded from the SAME roster row is skipped as before, and is not reported as a
  // duplicate — nothing is wrong with it, it is simply already there.
  const reSync = world(
    [rosterEntry({ full_name_en: "Already Here", part: "first" })],
    [runEntry({ full_name_en: "Already Here", recurring_id: "rec-Already Here-first" })],
  );
  const afterReSync = await seedRunFromRecurring({
    runId: RUN,
    actorHrId: "B-10",
    phase: "part1",
    client: reSync as never,
  });
  assert.equal(afterReSync.inserted, 0);
  assert.equal(afterReSync.skipped, 1, "already seeded from this roster row — the pre-existing guard");
  assert.deepEqual(afterReSync.skippedAsDuplicate, [], "and that is not a duplicate, it is the same row");

  // ---- Another run's entries are not this run's --------------------------------------------------
  const otherRun = world(
    [rosterEntry({ full_name_en: "Shared Name", part: "first" })],
    [runEntry({ run_id: "run-august", full_name_en: "Shared Name" })],
  );
  const afterOtherRun = await seedRunFromRecurring({
    runId: RUN,
    actorHrId: "B-10",
    phase: "part1",
    client: otherRun as never,
  });
  assert.equal(
    afterOtherRun.inserted,
    1,
    "being on LAST month's list is not being on this one — every month pays them again",
  );

  // ---- A row with nothing to identify it is seeded, not guessed at ---------------------------------
  // Refusing on a blank name and a blank account would drop a real payment on no evidence.
  // Unpaid (0) so the bank rule below does not hold it back: this case is about identity alone.
  const nameless = world(
    [rosterEntry({ full_name_en: "", full_name_ar: "", bank_account: null, total_salary: 0, id: "rec-blank" })],
    [runEntry({ full_name_en: "", full_name_ar: "", bank_account: null, total_salary: 0 })],
  );
  const afterNameless = await seedRunFromRecurring({
    runId: RUN,
    actorHrId: "B-10",
    phase: "part1",
    client: nameless as never,
  });
  assert.equal(afterNameless.inserted, 1, "an unidentifiable row cannot be proven a duplicate, so it is paid");

  // ---- A PAID ENTRY WITH NOWHERE TO SEND THE MONEY IS HELD BACK, AND NAMED (finding 11) ------------
  // The standing list did not check the bank until 2026-11-14, so an older entry can still lack one.
  // Copied into a run, the sheet counted the person as paid while no bank file carried them.
  const noBank = world(
    [
      rosterEntry({ full_name_en: "No Account", bank_account: null, total_salary: 5000 }),
      rosterEntry({ full_name_en: "No Bank Name", bank_name: "  ", total_salary: 4000 }),
      rosterEntry({ full_name_en: "Unpaid This Month", bank_account: null, total_salary: 0 }),
      rosterEntry({ full_name_en: "Fully Set Up", total_salary: 3000 }),
    ],
    [],
  );
  const afterNoBank = await seedRunFromRecurring({ runId: RUN, actorHrId: "B-10", phase: "part1", client: noBank as never });
  assert.deepEqual(
    afterNoBank.heldBackNoBank.sort(),
    ["No Account", "No Bank Name"],
    "a paid standing entry with no bank or no account must not be copied into the run — no bank file can carry it",
  );
  assert.deepEqual(
    rowsOn(noBank),
    ["Fully Set Up|first", "Unpaid This Month|first"],
    "an entry paying nothing needs no bank, and a fully set-up entry seeds as before",
  );
  assert.equal(afterNoBank.skipped, 0, "held back is reported as held back, not folded into the skipped count");
  assert.deepEqual(
    (noBank.rows("automated_payroll_audit")[0]?.detail as { heldBackNoBank?: unknown }).heldBackNoBank,
    ["No Account", "No Bank Name"],
    "and the audit row names who was held back",
  );
}
