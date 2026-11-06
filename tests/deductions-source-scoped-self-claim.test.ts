// A SOURCE-SCOPED COLLECTOR MUST NOT COUNT ITS OWN LIVE ROWS AS ALREADY-CHARGED DAYS.
//
// The same defect `deductions-vacation-self-retire.test.ts` pins for the two vacation collectors,
// one scope narrower: `collect.ts` registers the district-manager no-record and holiday-bridge
// collectors with `reconcilesSourceScope`, so each run's own live rows are that run's to keep or to
// retire — a day set the fresh scan no longer produces IS superseded. Both connectors, however, read
// every live candidate of the month as "already deducted", their own rows included. So a re-run saw
// the days it had charged last time, treated them as taken, emitted nothing for them, and reconcile
// then retired those rows for being absent from the fresh scan. Every second run flipped the set,
// and the owner's decision on each retired row went with it.
//
// PRODUCTION EVIDENCE (Supabase ozucdzovmcqvepbozvqf, `deductions_candidates` where
// `source_system = 'dsm_no_record'` and `month_key = '2026-09'`): the rows created 2026-10-03 20:01
// and 2026-10-06 03:40, 04:55, 23:35 and 23:40 UTC alternate. Dina Hamdy Fadel Mohamed Bdair,
// Mohamed Alaa Eleiwa Abozaid and Nermeen Salah Abdelaty Abohussien were re-created and superseded
// on alternate runs — their latest rows are superseded — while Sameh Shabaan El Hoseiny El Hoseiny
// flips the opposite way.
//
// THE EXCLUSION IS KEYED ON SOURCE SYSTEM, NEVER ON CATEGORY, because neither collector owns its
// category: `dsm_no_record` shares `crm` with `crm_visits_mirror`, and `holiday_bridge` shares
// `other` with `manual_hr`. A sibling writer's row survives the run, so its day is genuinely taken.
// Excluding by category would delete another writer's work — the reason `collect.ts` scopes these
// two to a source in the first place.
//
// AND A LOCKED OWN ROW STILL CLAIMS ITS DAY. Reconcile refuses to supersede a candidate with
// `locked_at` (published money is never retracted automatically), so that row is live after the run.
// Re-charging its day puts two live candidates on one employee-day, which `findDayCollisions` cannot
// see — it reports only a day claimed by more than one CATEGORY — and which surfaces as a raw
// unique_violation mid-publish from `deductions_publication_lines_guard_day_overlap`.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  collectClaimedLedgerDays,
  ledgerRowStillClaimsItsDaysBySource,
  MANUAL_ENTRY_SOURCE_SYSTEM,
} from "../src/lib/deductions/conflict.ts";
import { DEDUCTION_COLLECTORS } from "../src/lib/deductions/collect.ts";
import { DSM_NO_RECORD_SOURCE_SYSTEM } from "../src/lib/deductions/connectors/dsm-no-record.ts";
import { HOLIDAY_BRIDGE_SOURCE_SYSTEM } from "../src/lib/deductions/connectors/holiday-bridge.ts";

export function runDeductionsSourceScopedSelfClaimTests(): void {
  // ── 1. THE DEFECT ITSELF, through the real ledger shape ────────────────────
  // A ledger holding the collector's OWN unlocked row, a LOCKED own row, and another writer's row
  // in the SAME category. Only the first must stop claiming its days.
  for (const scope of [
    { source: DSM_NO_RECORD_SOURCE_SYSTEM, siblingSource: "crm_visits_mirror", label: "district-manager no-record" },
    { source: HOLIDAY_BRIDGE_SOURCE_SYSTEM, siblingSource: MANUAL_ENTRY_SOURCE_SYSTEM, label: "holiday bridge" },
  ]) {
    const claimed = collectClaimedLedgerDays(
      [
        // This run's own row, still Pending. Reconcile is about to replace it.
        { employee_hr_id_compact: "b100", dates: ["2026-09-07", "2026-09-08"], locked_at: null, source_system: scope.source },
        // This run's own row, PUBLISHED. Reconcile will not retract it, so it stays live.
        { employee_hr_id_compact: "b200", dates: ["2026-09-09"], locked_at: "2026-10-01T09:15:00.000Z", source_system: scope.source },
        // Another writer in the same category. Untouched by this run, so its day is taken.
        { employee_hr_id_compact: "b300", dates: ["2026-09-10"], locked_at: null, source_system: scope.siblingSource },
      ],
      (row) =>
        ledgerRowStillClaimsItsDaysBySource(
          { sourceSystem: row.source_system ?? null, lockedAt: row.locked_at ?? null },
          [scope.source],
        ),
    );

    for (const day of ["2026-09-07", "2026-09-08"]) {
      assert.ok(
        !claimed.has(`b100:${day}`),
        `${scope.label}: this run's OWN unlocked row must NOT claim ${day}. Reconcile is about to ` +
          "supersede it for being absent from the fresh scan, so counting it is what makes the scan " +
          "omit the day — the row is retired, its replacement never created, and the owner's " +
          "decision is lost. That is the alternating 2026-09 production chain.",
      );
    }
    assert.ok(
      claimed.has("b200:2026-09-09"),
      `${scope.label}: a LOCKED own row must keep claiming its day. Reconcile refuses to retract ` +
        "published money, so that row is still live after this run and re-charging its day puts two " +
        "live candidates on one employee-day — invisible to findDayCollisions and a raw " +
        "unique_violation mid-publish.",
    );
    // A manual_hr row claims nothing at all (its date is a 1st-of-month placeholder), which is why
    // the holiday-bridge sibling case asserts only on the dsm/crm pairing below.
    if (scope.siblingSource !== MANUAL_ENTRY_SOURCE_SYSTEM) {
      assert.ok(
        claimed.has("b300:2026-09-10"),
        `${scope.label}: another writer's row in the SAME category must still claim its day — this ` +
          "run does not reconcile that source, so the row survives and the day is genuinely taken. " +
          "Excluding by category instead of by source would delete that writer's work.",
      );
    }
  }

  // ── 2. THE PREDICATE, case by case ─────────────────────────────────────────
  assert.equal(
    ledgerRowStillClaimsItsDaysBySource({ sourceSystem: DSM_NO_RECORD_SOURCE_SYSTEM, lockedAt: null }, [
      DSM_NO_RECORD_SOURCE_SYSTEM,
    ]),
    false,
    "An unlocked row of the source being reconciled does not survive the run, so it must not claim its days.",
  );
  assert.equal(
    ledgerRowStillClaimsItsDaysBySource(
      { sourceSystem: DSM_NO_RECORD_SOURCE_SYSTEM, lockedAt: "2026-10-01T09:15:00.000Z" },
      [DSM_NO_RECORD_SOURCE_SYSTEM],
    ),
    true,
    "A LOCKED row of the reconciled source survives the run — published money is never retracted — so its day stays claimed.",
  );
  // The sibling writers in each shared category, locked or not.
  for (const sourceSystem of ["crm_visits_mirror", MANUAL_ENTRY_SOURCE_SYSTEM, "fingerprint_report", "vacation_balance"]) {
    for (const lockedAt of [null, "2026-10-01T09:15:00.000Z"]) {
      assert.equal(
        ledgerRowStillClaimsItsDaysBySource({ sourceSystem, lockedAt }, [DSM_NO_RECORD_SOURCE_SYSTEM]),
        true,
        `A "${sourceSystem}" row (lockedAt=${JSON.stringify(lockedAt)}) must claim its day during a ` +
          "dsm_no_record run: that source is not in this run's reconcile scope, so the row survives it.",
      );
    }
  }
  // Fail CLOSED. The expensive mistake is retiring a decided row, so an unreadable source is left alone.
  for (const sourceSystem of [null, "", "   ", "something_new"]) {
    assert.equal(
      ledgerRowStillClaimsItsDaysBySource({ sourceSystem, lockedAt: null }, [DSM_NO_RECORD_SOURCE_SYSTEM]),
      true,
      `A row whose source_system is ${JSON.stringify(sourceSystem)} must still claim its day — fail ` +
        "closed. Reading an unrecognised row as this run's own is how a decided candidate gets retired.",
    );
  }

  // ── 3. THE CONSTANTS MATCH WHAT collect.ts RECONCILES ──────────────────────
  // The exclusion is only correct while it names exactly the sources reconcile will supersede. A
  // literal that drifted in either direction is silent: too narrow re-opens the flip, too wide
  // deletes a sibling writer's day.
  for (const [key, expected] of [
    ["dsm_no_record", DSM_NO_RECORD_SOURCE_SYSTEM],
    ["holiday_bridge", HOLIDAY_BRIDGE_SOURCE_SYSTEM],
  ] as const) {
    const collector = DEDUCTION_COLLECTORS.find((entry) => entry.key === key);
    assert.ok(collector, `collect.ts must still register the "${key}" collector`);
    assert.deepEqual(
      collector.reconcilesSourceScope?.sourceSystems,
      [expected],
      `The "${key}" collector must reconcile exactly ["${expected}"] — the same source its ` +
        "already-claimed ledger read excludes. The two halves drifting apart is invisible: a wider " +
        "scope retires a sibling writer's row, a narrower one brings back the alternating flip.",
    );
    assert.equal(
      collector.reconcilesWholeCategory,
      undefined,
      `The "${key}" collector must stay source-scoped — its category has another writer, so ` +
        "reconciling the whole category would delete that writer's candidates.",
    );
  }

  // ── 4. WIRING ──────────────────────────────────────────────────────────────
  // The predicate proves the rule and nothing about the connectors applying it, which is the whole
  // defect. EXECUTABLE lines only: both files document the incident at length in comments that a
  // raw-text match would happily satisfy.
  for (const [file, sourceSystemsConstant] of [
    ["src/lib/deductions/connectors/dsm-no-record.ts", "DSM_NO_RECORD_SOURCE_SYSTEMS"],
    ["src/lib/deductions/connectors/holiday-bridge.ts", "HOLIDAY_BRIDGE_SOURCE_SYSTEMS"],
  ] as const) {
    const code = stripComments(readFileSync(file, "utf8"));

    assert.match(
      code,
      /\.select\(\s*"(?:id,\s*)?employee_hr_id_compact,\s*dates,\s*locked_at,\s*source_system"\s*\)/,
      `${file}: the ledger read must select "locked_at" AND "source_system". Dropping locked_at is ` +
        "silent and inverts the exception — the predicate reads undefined, Boolean(undefined) is " +
        "false, and a PUBLISHED row stops claiming its day, so the connector re-charges money " +
        "already paid. Dropping source_system makes every row look foreign and restores the flip.",
    );
    assert.match(
      code,
      new RegExp(
        String.raw`collectClaimedLedgerDays\([\s\S]{0,200}?ledgerRowStillClaimsItsDaysBySource\(\s*\{\s*sourceSystem:\s*row\.source_system[\s\S]{0,120}?\},\s*${sourceSystemsConstant}\s*,?\s*\)`,
      ),
      `${file}: the claimed-day set must be built with ledgerRowStillClaimsItsDaysBySource as its ` +
        `keepRow, keyed on the row's own source_system and locked_at and on ${sourceSystemsConstant}. ` +
        "Without it the set contains this run's own replaceable rows and every second run flips the " +
        "set — the 2026-09 production defect.",
    );
    assert.match(
      code,
      /\.is\(\s*"superseded_at",\s*null\s*\)/,
      `${file}: the ledger read must stay restricted to LIVE candidates — a withdrawn candidate frees its day.`,
    );
    // One ledger read per connector. A second, unfiltered one would reintroduce the defect on
    // whichever path used it while every assertion above still passed.
    const reads = code.split("deductions_candidates").length - 1;
    assert.equal(
      reads,
      1,
      `${file}: expected exactly 1 read of deductions_candidates in executable code, found ${reads}. ` +
        "A new read is not covered by the assertions above — route it through the same exclusion.",
    );
  }
}
