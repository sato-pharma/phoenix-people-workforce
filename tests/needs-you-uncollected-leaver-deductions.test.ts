import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CLOSED_COHORT_FLOOR,
  selectUncollectedLeaverDeductions,
} from "../src/lib/deductions/uncollected-leaver-deductions.ts";
import { needsYouDestinations, needsYouSourceIds, needsYouSourceLabels } from "../src/lib/needs-you/types.ts";

/**
 * THE PREVENTIVE LEAVER-DEDUCTION BOARD ROW (owner decision 2026-10-07).
 *
 * "He leaves and he takes the money — nothing to do. We audit the history, learn, and build something
 * that prevents this again." So this source surfaces a leaver ONLY while their final settlement is
 * plausibly still open (a rolling window), from the closed-cohort floor forward (the August-2026
 * leavers were settled off-system and are closed), and it NEVER states an EGP figure.
 */
export function runNeedsYouUncollectedLeaverDeductionsTests() {
  const now = new Date("2026-10-07T09:00:00Z");

  const leavers = [
    // A — departed, inside the window, an uncollected CRM (Aug) and an uncollected "other" (Sep).
    { hrId: "B-58", compact: "b58", name: "Ahmed Hemdan", lastWorkingDate: "2026-09-30", employmentStatus: "resigned" },
    // B — departed, inside the window, but its one approved month WAS collected.
    { hrId: "B-15", compact: "b15", name: "Aml Mohamed", lastWorkingDate: "2026-09-17", employmentStatus: "resigned" },
    // C — the CLOSED August cohort (before the floor): never surfaced, however uncollected.
    { hrId: "B-900", compact: "b900", name: "August Leaver", lastWorkingDate: "2026-08-15", employmentStatus: "terminated" },
    // D — departed but still ACTIVE status handling: an active employee is never a leaver here.
    { hrId: "B-20", compact: "b20", name: "Still Here", lastWorkingDate: "2026-09-30", employmentStatus: "active" },
  ];

  const approved = [
    { compact: "b58", monthKey: "2026-08", category: "crm" },
    { compact: "b58", monthKey: "2026-09", category: "other" },
    { compact: "b15", monthKey: "2026-08", category: "crm" }, // collected below
    { compact: "b900", monthKey: "2026-08", category: "crm" }, // closed cohort
    { compact: "b20", monthKey: "2026-09", category: "crm" }, // active, not a leaver
  ];

  // B's August CRM was collected (the `crm` column on its salary record is > 0).
  const collected = new Set<string>(["b15:2026-08:crm"]);

  const result = selectUncollectedLeaverDeductions({ now, leavers, approved, collected });

  // Only A survives: B is collected, C is the closed cohort, D is active.
  assert.equal(result.length, 1, "only the departed, in-window leaver with an uncollected deduction is surfaced");
  const [row] = result;
  assert.equal(row.hrId, "B-58");
  assert.equal(row.name, "Ahmed Hemdan");
  assert.deepEqual(row.months, ["2026-08", "2026-09"], "both uncollected months are aggregated, oldest first");
  assert.deepEqual(row.categories, ["crm", "other"], "its distinct categories are carried for the note");

  // 🔴 NO MONEY. The shape carries no amount at all — a structural guarantee, not a convention.
  assert.ok(!("amount" in row) && !("estimatedAmount" in row) && !("est" in row), "no EGP field may exist on a board row");

  // The floor is the closed-cohort boundary, and C sits before it.
  assert.ok("2026-08-15" < CLOSED_COHORT_FLOOR, "the August cohort's last working date is before the floor, so it is excluded");

  // A collected month must clear the row — flip B's collection off and it appears.
  const withBUncollected = selectUncollectedLeaverDeductions({ now, leavers, approved, collected: new Set() });
  assert.equal(withBUncollected.length, 2, "with nothing collected, both departed in-window leavers surface");
  assert.ok(withBUncollected.some((r) => r.hrId === "B-15"), "B surfaces once its deduction is no longer collected");

  // The rolling window prevents a growing ledger: far in the future, A is gone and settled, so nothing
  // shows even though the floor would still admit it.
  const future = selectUncollectedLeaverDeductions({ now: new Date("2027-03-01T09:00:00Z"), leavers, approved, collected });
  assert.equal(future.length, 0, "a leaver older than the rolling window is gone — never a standing row");

  // An unknown category is treated as NOT collected (shown) — the safe, over-reporting direction.
  const unknownCategory = selectUncollectedLeaverDeductions({
    now,
    leavers: [leavers[0]],
    approved: [{ compact: "b58", monthKey: "2026-09", category: "mystery_future_category" }],
    collected: new Set<string>(["b58:2026-09:crm"]), // a DIFFERENT column is collected, not this one
  });
  assert.equal(unknownCategory.length, 1, "a category with no known salary column is never assumed collected");

  // ── Board wiring ──────────────────────────────────────────────────────────
  assert.ok(
    needsYouSourceIds.includes("uncollected-leaver-deductions"),
    "the source must be in the closed union, or the never-under-reports pairing test fails",
  );
  assert.equal(needsYouSourceLabels["uncollected-leaver-deductions"], "Leavers with an uncollected deduction");
  assert.equal(
    needsYouDestinations["uncollected-leaver-deductions"].href,
    "/admin/deductions",
    "the row links to the only screen a human can settle one on — it never acts itself",
  );

  // ── The salary_records select is a LITERAL, not a runtime-joined template ──
  // supabase-js parses the select string at COMPILE time, so a `${SALARY_DEDUCTION_COLUMNS.join()}`
  // select yields a ParserError type and the read loses its typing — TS2352, which the CI typecheck
  // rejects (it did). Pin that the spelled-out literal names every deduction column and the batch
  // embed, and that the select carries no interpolation at all.
  const producerSrc = readFileSync(
    new URL("../src/lib/deductions/uncollected-leaver-deductions.ts", import.meta.url),
    "utf8",
  );
  for (const column of ["crm", "unpaid_vacations", "finger_print", "loans", "other_deductions"]) {
    assert.match(
      producerSrc,
      new RegExp(`SALARY_RECORDS_SELECT[\\s\\S]*?"[^"]*\\b${column}\\b`),
      `the salary_records select literal must name ${column}, or a deduction collected in that column reads as uncollected`,
    );
  }
  assert.doesNotMatch(
    producerSrc,
    /\.select\(`[^`]*\$\{/,
    "the salary_records select must be a static literal, never a template with an interpolation (that yields a ParserError type — TS2352)",
  );
}
