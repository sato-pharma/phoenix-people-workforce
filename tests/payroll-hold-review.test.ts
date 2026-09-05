import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildHoldReview } from "../src/lib/automated-payroll/hold-review.ts";
import { formatCarriedForwardReason } from "../src/lib/automated-payroll/hold-reason.ts";
import type { PayrollPeriod, StepRow } from "../src/lib/automated-payroll/types.ts";

/**
 * The pre-publish held-employee review — who this run is NOT paying, and why.
 *
 * The reconciliation strip reports holds as a bare count, and a count cannot
 * separate a settled owner ruling from an unanswered question. Measured on
 * production 2026-09-06, the OPEN August 2026 run read "Held: 13" while those
 * thirteen were three different populations: 2 continuing a July ruling
 * (B-156, B-3, rescued by carry-forward), 10 held for the first time, and 1 with
 * no previous run at all. A held row is dropped at publish and writes no
 * payslip, so this panel is the last place the reason can be read.
 *
 * These pin the classification and the ordering. The headline is the ordering:
 * an unexplained hold is the only one that needs work before the run can be
 * confirmed, so it must not sort alphabetically into the middle of the settled
 * ones.
 */

const AUGUST: PayrollPeriod = { month: 8, year: 2026 };

function holdRow(over: Partial<StepRow> & { hrId: string; fullName: string }): StepRow {
  return {
    jobTitle: null,
    line: null,
    context: {},
    values: {},
    recommended: {},
    reason: null,
    onHold: true,
    ...over,
  } as StepRow;
}

export function runPayrollHoldReviewTests() {
  // ---- only held rows, and never a row that is not persisted --------------
  const basic = buildHoldReview({
    period: AUGUST,
    rows: [
      holdRow({ hrId: "B-144", fullName: "Ahmed Fathy", reason: "Settled in cash" }),
      holdRow({ hrId: "B-90", fullName: "Nour Hassan", onHold: false }),
      holdRow({ hrId: "B-77", fullName: "Omar Adel", readOnly: true }),
    ],
  });
  assert.deepEqual(
    basic.held.map((entry) => entry.hrId),
    ["B-144"],
    "a row nobody is holding is not in the review, and a read-only row is never persisted or published so it is not someone this run declines to pay",
  );
  assert.equal(basic.heldCount, 1);

  // ---- the month labels are human-readable, and roll over correctly -------
  assert.equal(basic.monthLabel, "August 2026");
  assert.equal(basic.priorMonthLabel, "July 2026", "the prior month is named, never printed as a number");
  assert.equal(
    buildHoldReview({ period: { month: 1, year: 2026 }, rows: [] }).priorMonthLabel,
    "December 2025",
    "January inherits from December of the PREVIOUS year, not month 0 of this one",
  );

  // ---- continuity: held last month, or new here --------------------------
  const mixed = buildHoldReview({
    period: AUGUST,
    rows: [
      holdRow({
        hrId: "B-156",
        fullName: "Sara Samir",
        reason: "Carried forward from July 2026 — Not paid through this system at all",
        reasonCarriedForward: true,
        priorHold: { hrId: "B-156", reason: "Not paid through this system at all", month: 7, year: 2026 },
      }),
      holdRow({ hrId: "B-144", fullName: "Ahmed Fathy", reason: "Resigned; settled 2026-08-31" }),
    ],
  });
  const sara = mixed.held.find((entry) => entry.hrId === "B-156");
  const ahmed = mixed.held.find((entry) => entry.hrId === "B-144");
  assert.equal(sara?.continuity, "continued", "a hold the previous run also carried is a continuation");
  assert.equal(ahmed?.continuity, "new", "a hold with no prior row is a fresh decision, and reads as one");
  assert.equal(mixed.continuedCount, 1);
  assert.equal(mixed.unexplainedCount, 0, "both of these carry a reason");

  // A hold explained only by last month must still be MARKED as inherited, so
  // the panel never presents a stale note as a current assertion.
  assert.equal(sara?.carriedForward, true);
  assert.equal(ahmed?.carriedForward, false);

  // The label has to survive the round trip. Once a carried reason is SAVED it
  // comes back as an ordinary stored reason with no flag on the row — only its
  // own text still says where it came from. Reading the flag alone would let a
  // continuation quietly start reading as a fresh assertion about this month.
  const reloaded = buildHoldReview({
    period: AUGUST,
    rows: [
      holdRow({
        hrId: "B-3",
        fullName: "Mona Salah",
        reason: formatCarriedForwardReason("July 2026", "Owner ruling 2026-08-28"),
        // reasonCarriedForward deliberately absent — this is a reloaded saved row.
        priorHold: { hrId: "B-3", reason: "Owner ruling 2026-08-28", month: 7, year: 2026 },
      }),
    ],
  });
  assert.equal(
    reloaded.held[0]?.carriedForward,
    true,
    "a saved carried-forward reason is still recognised as inherited from its own text, not only from the row flag",
  );

  // ---- unexplained: counted, and sorted to the top ------------------------
  // The headline. Alphabetically "Ahmed" precedes "Zeinab"; the unexplained row
  // must still come first, because it is the only one blocking the confirm.
  const ordering = buildHoldReview({
    period: AUGUST,
    rows: [
      holdRow({ hrId: "B-1", fullName: "Ahmed Fathy", reason: "Settled in cash, owner ruling" }),
      holdRow({ hrId: "B-2", fullName: "Zeinab Omar", reason: null }),
      holdRow({
        hrId: "B-3",
        fullName: "Mona Salah",
        reason: "Continuing",
        priorHold: { hrId: "B-3", reason: "Owner ruling", month: 7, year: 2026 },
      }),
    ],
  });
  assert.deepEqual(
    ordering.held.map((entry) => entry.fullName),
    ["Zeinab Omar", "Mona Salah", "Ahmed Fathy"],
    "unexplained first (it blocks the confirm), then continuations, then by name — never plain alphabetical",
  );
  assert.equal(ordering.unexplainedCount, 1, "exactly the rows with no reason at all");

  // A prior month that held them and recorded nothing is still a continuation,
  // and is still unexplained — "held again, still not explained" is the reading.
  const neverExplained = buildHoldReview({
    period: AUGUST,
    rows: [
      holdRow({
        hrId: "B-23",
        fullName: "Mona Salah",
        reason: null,
        priorHold: { hrId: "B-23", reason: null, month: 7, year: 2026 },
      }),
    ],
  });
  assert.equal(neverExplained.held[0]?.continuity, "continued");
  assert.equal(
    neverExplained.unexplainedCount,
    1,
    "a prior hold with no reason carries nothing, so this row is still unexplained — no invented reason",
  );

  // ---- an all-clear run reports zero, not a missing section ---------------
  const clean = buildHoldReview({ period: AUGUST, rows: [holdRow({ hrId: "B-9", fullName: "Ali Kamal", onHold: false })] });
  assert.equal(clean.heldCount, 0);
  assert.equal(clean.unexplainedCount, 0);
  assert.deepEqual(clean.held, []);

  // ---- the route is a real server boundary, not a UI-only surface ---------
  // Payroll re-checks the caller in the SERVICE (permissions.ts), so the review
  // must go through getHoldReview rather than the route reading rows itself.
  const route = readFileSync(
    path.join(process.cwd(), "app", "api", "automated-payroll", "runs", "[runId]", "hold-review", "route.ts"),
    "utf8",
  );
  assert.match(route, /getHoldReview/, "the route delegates to the service, which is where the access gate lives");
  assert.match(route, /jsonError/, "errors map to their status codes rather than leaking a 500");

  const service = readFileSync(
    path.join(process.cwd(), "src", "lib", "automated-payroll", "run-service.ts"),
    "utf8",
  );
  const start = service.indexOf("export async function getHoldReview(");
  assert.notEqual(start, -1, "getHoldReview not found — the anchor moved, not the rule");
  const body = service.slice(start, service.indexOf("\nexport ", start + 40));
  assert.equal(
    body.includes("export async function getPopulationDiff("),
    false,
    "the slice is bounded — an unbounded one would match anything and certify nothing",
  );
  assert.match(
    body,
    /assertAutomatedPayrollHrActor\(access\)/,
    "the held review names every unpaid employee and their reason, so it is gated like the rest of payroll",
  );
  assert.match(
    body,
    /recommendStep\(/,
    "the review reads the hold step through recommendStep — the same call confirmStep makes — so the panel cannot show a reason the confirm gate would reject",
  );
}
