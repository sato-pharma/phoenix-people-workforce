import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  heldBalancesForRun,
  payrollReleasedByHeldMonth,
  type EnteredHeld,
  type HeldSettlement,
} from "../src/lib/automated-payroll/held-settlements.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * HELD IN A MONTH THAT DID NOT RECORD NAMES (owner decision, 2026-11-09: HR types the held amount).
 *
 * July and August 2026 were published before the payroll kept each held person's amounts — their
 * `published` audit row is only {batchId, heldExcluded, publishedCount}. So Ahmed Helal, held in both
 * months, had no balance, never appeared on Held Salary Release, and no release could be saved for him.
 * HR now enters the amount on the step (automated_payroll_held_entered).
 *
 * What must hold:
 *   (a) a run that kept only the count owes what HR entered for it, less anything settled by hand and
 *       anything payroll already released;
 *   (b) a run that HAS a held list ignores an entered amount — a typed figure can never double one the
 *       system recorded;
 *   (c) an amount entered against another month is not this month's money;
 *   (d) the route is behind the wizard's HR gate and same-origin on every write, and the access
 *       registry declares it.
 */

const JULY = "run-jul";
const AUGUST = "run-aug";

function entered(overrides: Partial<EnteredHeld> = {}): EnteredHeld {
  return {
    heldRunId: JULY,
    hrId: "B-3",
    compact: "b3",
    name: "Ahmed Helal",
    amount: 9800,
    note: "July sheet, held after resignation",
    recordedBy: "B-10",
    updatedAt: "2026-11-09T08:00:00.000Z",
    ...overrides,
  };
}

function settlement(amount: number): HeldSettlement {
  return {
    id: "s-1",
    runId: JULY,
    employeeHrId: "B-3",
    employeeHrIdCompact: "b3",
    amount,
    paidOn: "2026-10-01",
    method: "bank",
    reference: null,
    note: null,
    recordedBy: "B-10",
    updatedAt: "2026-10-01T08:00:00.000Z",
  };
}

/** The count-only detail the July and August 2026 runs really carry. */
const COUNT_ONLY = { batchId: "batch-jul", heldExcluded: 2, publishedCount: 98 } as Record<string, unknown>;

export function runAutomatedPayrollHeldEnteredTests() {
  // ---- (a) A COUNT-ONLY RUN OWES WHAT HR ENTERED ---------------------------------------------------
  const released = payrollReleasedByHeldMonth([
    { payingRunId: "run-oct", payingRunPhase: "published", heldRunId: JULY, compact: "b3", amount: 1500 },
    // A cancelled run paid nobody, so it takes nothing off.
    { payingRunId: "run-sep", payingRunPhase: "cancelled", heldRunId: JULY, compact: "b3", amount: 4000 },
  ]);
  const [balance, ...rest] = heldBalancesForRun({
    runId: JULY,
    month: 7,
    year: 2026,
    detail: COUNT_ONLY,
    settlements: new Map([["b3", settlement(2000)]]),
    releasedByPayroll: released,
    corrections: [],
    entered: [entered()],
  });
  assert.equal(rest.length, 0, "one entry, one balance");
  assert.ok(balance, "a month that kept only the count lists the person HR entered — before this, nobody");
  assert.equal(balance.compact, "b3");
  assert.equal(balance.name, "Ahmed Helal");
  assert.equal(balance.secondPartWithheld, 9800, "the entered amount is what that month withheld");
  assert.equal(balance.reason, "July sheet, held after resignation", "the note is the reason the step shows");
  assert.equal(balance.settled?.amount, 2000);
  assert.equal(balance.releasedByPayroll, 1500, "a cancelled run's release counts for nothing");
  assert.equal(
    balance.outstanding,
    6300,
    "outstanding = entered 9,800 less 2,000 settled by hand less 1,500 released by payroll",
  );

  // Nothing entered: a count-only run still owes nothing it can name (the state before this change).
  assert.equal(
    heldBalancesForRun({
      runId: JULY,
      month: 7,
      year: 2026,
      detail: COUNT_ONLY,
      settlements: new Map(),
      releasedByPayroll: new Map(),
      corrections: [],
    }).length,
    0,
  );

  // ---- (b) A RUN WITH A HELD LIST IGNORES AN ENTERED AMOUNT ----------------------------------------
  const recorded = heldBalancesForRun({
    runId: JULY,
    month: 7,
    year: 2026,
    detail: {
      held: [{ hrId: "B-3", name: "Ahmed Helal", firstPartAlreadyPaid: 0, firstPartWithheld: 0, secondPartWithheld: 5000 }],
    },
    settlements: new Map(),
    releasedByPayroll: new Map(),
    corrections: [],
    entered: [entered(), entered({ hrId: "B-9", compact: "b9", name: "Not On The List", amount: 4000 })],
  });
  assert.equal(recorded.length, 1, "a run that recorded each held person lists only them, never an entered stranger");
  assert.equal(
    recorded[0]?.secondPartWithheld,
    5000,
    "the recorded figure stands alone — an entered amount for a run with a held list must never double it",
  );
  assert.equal(recorded[0]?.outstanding, 5000);

  // An EMPTY held list is still a list: that run recorded that it held nobody.
  assert.equal(
    heldBalancesForRun({
      runId: JULY,
      month: 7,
      year: 2026,
      detail: { held: [] },
      settlements: new Map(),
      releasedByPayroll: new Map(),
      corrections: [],
      entered: [entered()],
    }).length,
    0,
    "a run whose held list is empty recorded that it held nobody — an entered amount does not override it",
  );

  // ---- (c) ANOTHER MONTH'S ENTRY IS NOT THIS MONTH'S MONEY -----------------------------------------
  const otherMonth = heldBalancesForRun({
    runId: JULY,
    month: 7,
    year: 2026,
    detail: COUNT_ONLY,
    settlements: new Map(),
    releasedByPayroll: new Map(),
    corrections: [],
    entered: [entered({ heldRunId: AUGUST })],
  });
  assert.equal(otherMonth.length, 0, "an amount entered against August is not owed from July");

  // ---- (d) THE ROUTE AND ITS REGISTRY ENTRY ---------------------------------------------------------
  const route = stripComments(
    readFileSync(
      path.join(process.cwd(), "app", "api", "automated-payroll", "runs", "[runId]", "held-entered", "route.ts"),
      "utf8",
    ),
  );
  const getBody = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  assert.match(getBody, /assertAutomatedPayrollHrActor\(access\)/, "GET names people and salary figures: the wizard's HR gate");
  for (const method of ["POST", "DELETE"]) {
    const start = route.indexOf(`export async function ${method}`);
    assert.ok(start >= 0, `the route exports ${method}`);
    const next = route.indexOf("export async function", start + 10);
    const body = route.slice(start, next === -1 ? undefined : next);
    assert.match(body, /assertSameOriginMutation\(request\)/, `${method} changes what the company owes: same-origin only`);
    assert.match(body, /jsonError\(error,/, `${method} answers through jsonError, never String(error)`);
  }
  assert.doesNotMatch(route, /String\(error\)|error\.message/, "a route never sends the raw error");

  const registry = readFileSync(path.join(process.cwd(), "src", "lib", "security", "access-registry.ts"), "utf8");
  const declarations = registry
    .split(/\r?\n/)
    .filter((line) => line.includes('pattern: "/api/automated-payroll/runs/:runId/held-entered"'));
  assert.equal(declarations.length, 2, "the access registry declares the read and the writes of held-entered");
  assert.ok(
    declarations.some((line) => line.includes('methods: ["GET"]') && line.includes('"access-read"')),
    "GET is declared as an access read",
  );
  assert.ok(
    declarations.some(
      (line) => line.includes('methods: ["POST", "DELETE"]') && line.includes('"mutation"') && line.includes("csrfRequired: true"),
    ),
    "POST and DELETE are declared as CSRF-checked mutations",
  );
}
