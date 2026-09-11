import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeModuleDrift,
  detectModuleDrift,
  mergeModuleDrift,
  MODULE_SOURCED_STEP_KEYS,
  RECOMMENDED_AT_CONFIRM_KEY,
  snapshotFromSummary,
  snapshotRecommendations,
} from "../src/lib/automated-payroll/module-drift.ts";
import type { StepRow } from "../src/lib/automated-payroll/types.ts";

/**
 * A CONFIRMED DEDUCTION MUST NOT GO ON BEING CHARGED AFTER THE MODULE WITHDRAWS IT.
 *
 * THE MECHANISM, and the reason the obvious fix is wrong. Confirming a step copies the figure the
 * Deductions module proposes onto the run's own row, and `assembleRows` reads that row — never the
 * module — when it works out what everybody is paid. So the copy cannot simply be stopped: a
 * cleared column does not fall through to the module, it reads as ZERO, which would wipe every
 * deduction HR accepted rather than typed by hand. That was built, tested, and thrown away on
 * 2026-09-11 after checking where the assembler actually gets its numbers.
 *
 * What is actually wrong is that the copy is taken once and never looked at again. Mark a candidate
 * "Do Not Take Action" afterwards and the employee is still charged, with the breakdown underneath
 * showing no lines at all. Approve one afterwards and it contributes nothing.
 *
 * WHY A SNAPSHOT. Comparing the stored figure against the module's answer now cannot separate a
 * figure somebody deliberately overrode from one the module has since changed — both merely
 * "differ". So the confirm records what was being proposed at the time, and the comparison is
 * between the module's answer THEN and NOW. Without that, every deliberate override raises a
 * warning, the warning is always on, and it stops being read.
 */

function row(overrides: Partial<StepRow> = {}): StepRow {
  return {
    hrId: "B-1",
    fullName: "Test Employee",
    jobTitle: "Medical Representative",
    line: "Anti Infective",
    area: "Cairo",
    lifecycle: "regular",
    context: {},
    values: {},
    recommended: {},
    details: [],
    onHold: false,
    reason: null,
    readOnly: false,
    ...overrides,
  } as unknown as StepRow;
}

export function runAutomatedPayrollModuleDriftTests() {
  // ---- The snapshot records what was proposed, per employee ------------------------------------
  const atConfirm = snapshotRecommendations([
    row({ hrId: "B-1", recommended: { crm: 450 }, values: { crm: 450 } }),
    row({ hrId: "B-2", recommended: { crm: 900 }, values: { crm: 700 } }),
    // A read-only row is informational and never persisted, so it is not part of the record either.
    row({ hrId: "B-9", recommended: { crm: 100 }, values: { crm: 100 }, readOnly: true } as Partial<StepRow>),
  ]);
  assert.deepEqual(atConfirm, { b1: { crm: 450 }, b2: { crm: 900 } });

  // ---- HEADLINE: a withdrawn candidate is still being charged ------------------------------------
  const withdrawn = detectModuleDrift({
    stepKey: "p2_crm",
    rows: [row({ hrId: "B-1", recommended: { crm: 0 }, values: { crm: 450 } })],
    snapshot: { b1: { crm: 450 } },
  });
  assert.equal(withdrawn.staleCharges, 1);
  assert.equal(
    withdrawn.rows[0]?.charged,
    450,
    "the run still charges the copy taken at confirm, which is exactly the complaint: the module " +
      "now proposes nothing and the employee is billed anyway",
  );
  assert.equal(withdrawn.rows[0]?.proposedNow, 0);
  assert.equal(withdrawn.rows[0]?.overridden, false, "nobody chose 450 by hand — it was accepted");

  // The mirror case: a candidate approved after the step was confirmed contributes nothing.
  const approvedLate = detectModuleDrift({
    stepKey: "p2_crm",
    rows: [row({ hrId: "B-1", recommended: { crm: 600 }, values: { crm: 0 } })],
    snapshot: { b1: { crm: 0 } },
  });
  assert.equal(approvedLate.staleCharges, 1);
  assert.equal(approvedLate.rows[0]?.charged, 0, "the run charges nothing while the module asks for 600");

  // ---- THE SIGNAL-QUALITY INVARIANT: an override is not a problem --------------------------------
  // This is the half that decides whether the warning is worth having. HR typed 700 over a proposed
  // 900; the module has since moved to 500. Their decision still stands and still wins, so this is
  // reported as context and must NOT be counted as a stale charge.
  const overridden = detectModuleDrift({
    stepKey: "p2_crm",
    rows: [row({ hrId: "B-2", fullName: "Second", recommended: { crm: 500 }, values: { crm: 700 } })],
    snapshot: { b2: { crm: 900 } },
  });
  assert.equal(
    overridden.staleCharges,
    0,
    "a figure a human entered is their decision — counting it as stale would put the banner " +
      "permanently on, and a warning that is always on is one nobody reads",
  );
  assert.equal(overridden.overriddenButMoved, 1, "it is still shown, because the module did move");
  assert.equal(overridden.rows[0]?.charged, 700, "and what the run charges is stated plainly");

  // ---- A module that has not moved says nothing --------------------------------------------------
  const quiet = detectModuleDrift({
    stepKey: "p2_crm",
    rows: [
      row({ hrId: "B-1", recommended: { crm: 450 }, values: { crm: 450 } }),
      // Unchanged proposal, human override in force: still nothing to say.
      row({ hrId: "B-2", recommended: { crm: 900 }, values: { crm: 700 } }),
    ],
    snapshot: { b1: { crm: 450 }, b2: { crm: 900 } },
  });
  assert.deepEqual(quiet.rows, [], "nothing moved, so there is nothing to report");

  // ---- A step confirmed before snapshots existed reports nothing ---------------------------------
  // Silence is correct: with no record of what was proposed at the time, every comparison would be
  // a guess, and a guess presented as a finding is worse than no finding at all.
  const noSnapshot = detectModuleDrift({
    stepKey: "p2_crm",
    rows: [row({ hrId: "B-1", recommended: { crm: 0 }, values: { crm: 450 } })],
    snapshot: null,
  });
  assert.deepEqual(noSnapshot.rows, []);
  assert.equal(snapshotFromSummary(undefined), null);
  assert.equal(snapshotFromSummary({ employees: 12, total: 900 }), null, "an older summary carries no snapshot");

  // ---- The snapshot survives a round trip through jsonb --------------------------------------------
  // It is stored inside the step state's summary, so it comes back as untyped JSON.
  const summary: Record<string, unknown> = { employees: 2, [RECOMMENDED_AT_CONFIRM_KEY]: atConfirm };
  const restored = snapshotFromSummary(JSON.parse(JSON.stringify(summary)) as Record<string, unknown>);
  assert.deepEqual(restored, atConfirm, "what was recorded is what comes back");
  // Numbers arriving as strings must still compare — jsonb round trips are not always faithful.
  assert.deepEqual(
    snapshotFromSummary({ [RECOMMENDED_AT_CONFIRM_KEY]: { b1: { crm: "450" } } }),
    { b1: { crm: 450 } },
  );

  // ---- Biggest movement first, and stable ----------------------------------------------------------
  const ordered = detectModuleDrift({
    stepKey: "p2_crm",
    rows: [
      row({ hrId: "B-1", fullName: "Small", recommended: { crm: 440 }, values: { crm: 450 } }),
      row({ hrId: "B-2", fullName: "Large", recommended: { crm: 0 }, values: { crm: 900 } }),
    ],
    snapshot: { b1: { crm: 450 }, b2: { crm: 900 } },
  });
  assert.deepEqual(
    ordered.rows.map((entry) => entry.fullName),
    ["Large", "Small"],
    "the figure that moved furthest is the one to look at first",
  );

  // ---- Merging across steps keeps the counts honest --------------------------------------------------
  const merged = mergeModuleDrift([withdrawn, overridden, quiet]);
  assert.equal(merged.rows.length, 2);
  assert.equal(merged.staleCharges, 1);
  assert.equal(merged.overriddenButMoved, 1);

  // ---- The sentence a person reads ------------------------------------------------------------------
  assert.match(describeModuleDrift(merged), /no longer match the Deductions module/);
  assert.match(describeModuleDrift(merged), /entered by hand, which still stands/);
  assert.equal(
    describeModuleDrift({ rows: [], staleCharges: 0, overriddenButMoved: 0 }),
    "Every confirmed figure still matches the Deductions module.",
  );

  // ---- The confirm must actually RECORD the snapshot ---------------------------------------------------
  // Everything above tests the comparison. None of it can tell whether anything is being recorded:
  // remove the write and the report simply says "nothing drifted" forever, which is the one failure
  // shape this whole check exists to avoid. Measured directly on the confirm path's own source,
  // bounded so it cannot quietly widen to the whole file.
  const runServiceSource = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const confirmStart = runServiceSource.indexOf("export async function confirmStep");
  const confirmEnd = runServiceSource.indexOf("function summarizeStep", confirmStart);
  assert.ok(confirmStart > 0 && confirmEnd > confirmStart, "confirmStep and its end marker must both be found");
  const confirmBody = runServiceSource.slice(confirmStart, confirmEnd);
  assert.ok(confirmBody.length < 8000, "the slice must stay bounded to confirmStep");
  assert.ok(
    confirmBody.includes(RECOMMENDED_AT_CONFIRM_KEY) || confirmBody.includes("RECOMMENDED_AT_CONFIRM_KEY"),
    "confirming a module-sourced step must record what the module was proposing at that moment — " +
      "without it the drift report can only ever answer 'nothing changed'",
  );
  assert.ok(
    confirmBody.includes("snapshotRecommendations"),
    "and it must record it from the rows the SERVER computed, not from anything the browser sent",
  );

  // ---- The watched step list must match the steps the module actually feeds ---------------------------
  // Adding a module-sourced step without adding it here would leave that step silently unwatched —
  // the one failure this check cannot detect about itself. `loadConfirmedDeductions` is the
  // module's only entry point into the recommendation engine, so the two lists are the same list.
  const recommendSource = readFileSync("src/lib/automated-payroll/recommend.ts", "utf8");
  const switchBody = recommendSource.slice(
    recommendSource.indexOf("async function recommendStepRows"),
    recommendSource.indexOf("export async function settlementBasisFor") > 0
      ? recommendSource.indexOf("export async function settlementBasisFor")
      : recommendSource.length,
  );
  assert.ok(switchBody.length > 500 && switchBody.length < 20000, "the slice must stay bounded to the dispatcher");
  const fed = new Set<string>();
  let caseKey: string | null = null;
  for (const line of switchBody.split("\n")) {
    const match = /^\s*case "([a-z0-9_]+)":/.exec(line);
    if (match) caseKey = match[1];
    if (caseKey && line.includes("loadConfirmedDeductions")) fed.add(caseKey);
  }
  assert.deepEqual(
    [...fed].sort(),
    [...MODULE_SOURCED_STEP_KEYS].sort(),
    "every step that reads the Deductions module must be watched for drift, and only those — a " +
      "new module-sourced step added without this list would go unwatched with nothing to show it",
  );
}
