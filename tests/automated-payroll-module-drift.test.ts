import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  columnLabel,
  describeModuleDrift,
  describeModuleDriftBlock,
  detectModuleDrift,
  mergeModuleDrift,
  MODULE_SOURCED_STEP_KEYS,
  pricedMoneyField,
  RECOMMENDED_AT_CONFIRM_KEY,
  snapshotFromSummary,
  snapshotRecommendations,
  takeCurrentModuleFigures,
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
  const atConfirm = snapshotRecommendations("p2_crm", [
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

  // ---- HEADLINE 2: NOTHING -> SOMETHING, the direction the push gate made normal -----------------
  //
  // The step emits NO ROW at all for an employee worth 0.00 (recommendFingerprint's own
  // "value === 0 && days === 0 && nothing saved -> continue"), so that employee is ABSENT from the
  // snapshot rather than present with a zero. The first version of this check skipped an absent
  // employee, which read as "nothing to compare" and was in fact "everything to compare".
  //
  // Under the push gate (owner rule 2026-09-22) that is the COMMON case, not an edge one: a step is
  // confirmed, the Super Admin pushes a line days later, and the module starts proposing a figure
  // for somebody it proposed nothing for. Measured on the live September 2026 run, 2026-10-06 —
  // p1_fingerprint confirmed 2026-09-24 with an empty snapshot, eight lines worth 3,333.32 EGP
  // pushed on 2026-10-06, and this report silent.
  const pushedAfterConfirm = detectModuleDrift({
    stepKey: "p1_fingerprint",
    rows: [row({ hrId: "A-9", recommended: { fingerprintValue: 2133.33 }, values: { fingerprintValue: 2133.33 } })],
    snapshot: {},
    chargedByCompact: { a9: {} },
  });
  assert.equal(
    pushedAfterConfirm.rows.length,
    1,
    "an employee the step proposed nothing for at confirm, and proposes real money for now, is " +
      "the whole point of the check — skipping them is what let 3,333.32 EGP go unreported",
  );
  assert.equal(pushedAfterConfirm.rows[0]?.proposedAtConfirm, 0);
  assert.equal(pushedAfterConfirm.rows[0]?.proposedNow, 2133.33);
  assert.equal(
    pushedAfterConfirm.rows[0]?.charged,
    0,
    "the DRAFT is what the sheet pays. `values` falls back to the live recommendation when the " +
      "column is null, so reading it alone would report 2133.33 as the charge and call the row an " +
      "override nobody made",
  );
  assert.equal(pushedAfterConfirm.staleCharges, 1, "and it is a stale charge, not a human's decision");

  // The same row once HR has actually re-confirmed the step: the draft now carries the figure, so
  // the module and the run agree and the report goes quiet again.
  const reconfirmed = detectModuleDrift({
    stepKey: "p1_fingerprint",
    rows: [row({ hrId: "A-9", recommended: { fingerprintValue: 2133.33 }, values: { fingerprintValue: 2133.33 } })],
    snapshot: { a9: { fingerprintValue: 2133.33 } },
    chargedByCompact: { a9: { fingerprintValue: 2133.33 } },
  });
  assert.deepEqual(reconfirmed.rows, [], "re-confirming the step is what settles it");

  // A snapshot that is present but empty is NOT the same as no snapshot: the first says the step
  // proposed nothing for anybody, the second says the step predates snapshots entirely.
  const absentAndUnchanged = detectModuleDrift({
    stepKey: "p1_fingerprint",
    rows: [row({ hrId: "A-9", recommended: { fingerprintValue: 0 }, values: { fingerprintValue: 0 } })],
    snapshot: {},
  });
  assert.deepEqual(absentAndUnchanged.rows, [], "nothing then, nothing now — silence is correct");

  // ---- HEADLINE 3: A CHARGE THE MODULE PROPOSES NOTHING FOR, AND NEVER DID (2026-10-09) ----------
  //
  // BOTH SIDES OF THE COMPARISON ARE 0.00, so "has the module changed its mind" had nothing to
  // compare and returned early — hiding real money from this report, from the Part 2 gate, and from
  // takeCurrentModuleFigures, whose remedy a `pick(draft, recommended)` re-confirm makes a no-op.
  //
  // Measured on the live September 2026 run, 2026-10-09: Nahed Tarek Hassan Omar Hattab (A-10) was
  // charged 2,931.00 in Part 1 Other Deductions → Other with no `other` candidate in that month at
  // all, beside a CORRECT 2,933.32 in the Fingerprint column for the same six approved late days —
  // the same lateness charged twice. Hossam Mohamed Reda AboElftouh Abdelghafar (A-9) carried 400.00
  // the same way against a correct 400.00 of fingerprint. 3,331.00 EGP, every existing check silent.
  const unbacked = detectModuleDrift({
    stepKey: "p1_other_deductions",
    rows: [row({ hrId: "A-10", fullName: "Nahed", recommended: { p1odOtherValue: 0 } })],
    snapshot: {},
    chargedByCompact: { a10: { p1odOtherValue: 2931 } },
  });
  assert.equal(
    unbacked.rows.length,
    1,
    "a charge with no approved deduction behind a piastre of it must be REPORTED — the module " +
      "proposing nothing at confirm AND nothing now is exactly what hid 3,331.00 EGP",
  );
  assert.equal(unbacked.unbackedCharges, 1);
  assert.equal(unbacked.rows[0]?.charged, 2931, "and what the run charges is stated plainly");
  assert.equal(unbacked.rows[0]?.proposedNow, 0);
  assert.equal(
    unbacked.staleCharges,
    0,
    "it must NEVER block Part 2: HR may enter a manual deduction straight onto the Other tab with " +
      "no candidate behind it by design, so the figure can be perfectly deliberate",
  );
  assert.equal(
    unbacked.overriddenButMoved,
    0,
    "and it is not counted as the module moving — it did not move at all, and these counters are " +
      "what the one sentence a person reads is built from",
  );
  assert.match(describeModuleDrift(unbacked), /no approved deduction behind them/);
  assert.match(describeModuleDrift(unbacked), /2931\.00/, "the sentence names the money, not a count");

  // A LOAN typed on Part 1 is already inside the frozen first part once Part 1 is confirmed — paid,
  // nothing left to clear (owner, 2026-11-09: Mahmoud Ibrahim Ahmed Mohamed (A-1), 1,250.00 loan,
  // "already deducted from him first part"). Hidden then; still shown before; "Other" never hidden.
  const typedLoan = (part1Confirmed: boolean, field: string) =>
    detectModuleDrift({
      stepKey: "p1_other_deductions",
      rows: [row({ hrId: "A-1", fullName: "Mahmoud", recommended: { [field]: 0 } })],
      snapshot: {},
      chargedByCompact: { a1: { [field]: 1250 } },
      part1Confirmed,
    }).unbackedCharges;
  assert.equal(typedLoan(true, "p1odLoanValue"), 0, "a typed Part 1 loan is not reported once Part 1 is paid");
  assert.equal(typedLoan(false, "p1odLoanValue"), 1, "before Part 1 is confirmed it can still be cleared, so it is shown");
  assert.equal(
    typedLoan(true, "p1odOtherValue"),
    1,
    "a typed Other figure is still reported after Part 1 — September's double-charged lateness was exactly that",
  );

  // Reported, never REWRITTEN. Zeroing it would silently delete a hand-entered manual deduction —
  // the mirror of the bug this whole file opens with.
  const unbackedRows = [
    row({ hrId: "A-10", fullName: "Nahed", values: { p1odOtherValue: 2931 }, recommended: { p1odOtherValue: 0 } }),
  ];
  assert.equal(
    takeCurrentModuleFigures({
      stepKey: "p1_other_deductions",
      rows: unbackedRows,
      snapshot: {},
      chargedByCompact: { a10: { p1odOtherValue: 2931 } },
    })[0].values.p1odOtherValue,
    2931,
    "a re-confirm leaves an unbacked charge exactly as it is — only the person who entered it may clear it",
  );

  // THE SIGNAL-QUALITY HALF: a zero column is not an unbacked charge. Every one of the 104 people on
  // a real run carries 0.00 in most columns, so reporting those would put the banner permanently on.
  const unbackedZero = detectModuleDrift({
    stepKey: "p1_other_deductions",
    rows: [row({ hrId: "B-3", recommended: { p1odOtherValue: 0 } })],
    snapshot: {},
    chargedByCompact: { b3: { p1odOtherValue: 0 } },
  });
  assert.deepEqual(unbackedZero.rows, [], "nothing charged and nothing proposed — silence");

  // Nor is a figure trimmed from a REAL proposal: the module proposing 900 and still proposing 900
  // while HR charges 700 is their decision, and the module standing still is not news about it.
  // This is the case `quiet` below pins, repeated here because it is the boundary of the new rule.
  const trimmedNotUnbacked = detectModuleDrift({
    stepKey: "p2_crm",
    rows: [row({ hrId: "B-2", recommended: { crm: 900 } })],
    snapshot: { b2: { crm: 900 } },
    chargedByCompact: { b2: { crm: 700 } },
  });
  assert.deepEqual(trimmedNotUnbacked.rows, [], "a trimmed proposal is not an unbacked charge");

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
  // A differing figure is NOT called hand-entered here: the summary cannot know who set it, and on
  // 2026-10-07 it named two CRM figures a step confirm had written as somebody's own. Only the cell
  // history may say "typed" — see describeChargeSource in tests/automated-payroll-cell-history.test.ts.
  assert.match(describeModuleDrift(merged), /different from the one confirmed, which still stands/);
  assert.doesNotMatch(describeModuleDrift(merged), /by hand/);
  assert.doesNotMatch(describeModuleDriftBlock(merged), /by hand/);
  assert.equal(
    describeModuleDrift({ rows: [], staleCharges: 0, overriddenButMoved: 0, unbackedCharges: 0 }),
    "Every confirmed figure still matches the Deductions module.",
  );

  // ---- A STALE CHARGE BLOCKS THE PART 2 CONFIRM (owner decision 2026-10-06) ------------------------
  // The banner alone was the right strength while a figure could only go stale because somebody
  // changed their mind. Under the push gate it goes stale by the ORDINARY order of work, so the run
  // was free to pay a number the module had already replaced.
  const blocking = detectModuleDrift({
    stepKey: "p1_fingerprint",
    rows: [
      row({ hrId: "A-9", fullName: "Nahed", recommended: { fingerprintValue: 2133.33 } }),
      // A human's own figure moved too — reported, never blocking.
      row({ hrId: "B-2", fullName: "Second", recommended: { crm: 500 }, values: { crm: 700 } }),
    ],
    snapshot: { b2: { crm: 900 } },
    chargedByCompact: { a9: {}, b2: { crm: 700 } },
  });
  assert.equal(blocking.staleCharges, 1);
  assert.equal(blocking.overriddenButMoved, 1);
  const refusal = describeModuleDriftBlock(blocking);
  assert.ok(refusal.includes("Nahed"), "the refusal names who, not a count");
  assert.ok(refusal.includes("2133.33"), "and what the module says now");
  assert.ok(
    refusal.includes("Fingerprint"),
    "and WHICH step to re-confirm — a block that does not say how to clear it is a dead end",
  );
  assert.ok(
    refusal.includes("not blocking"),
    "the hand-entered row is reported beside the refusal and explicitly said not to be the cause",
  );

  // Part 2 confirm must actually refuse. The whole decision is one call site.
  const confirmSource = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const part2Start = confirmSource.indexOf("export async function confirmPart2");
  assert.ok(part2Start > 0, "confirmPart2 must be found");
  const part2Body = confirmSource.slice(part2Start, confirmSource.indexOf("export async function getReconciliation", part2Start));
  assert.ok(part2Body.length > 500, "the slice must reach the body");
  assert.ok(
    part2Body.includes("describeModuleDriftBlock") && part2Body.includes("staleCharges > 0"),
    "confirming Part 2 must refuse a run carrying a figure the Deductions module no longer proposes",
  );

  // ---- The confirm must actually RECORD the snapshot ---------------------------------------------------
  // Everything above tests the comparison. None of it can tell whether anything is being recorded:
  // remove the write and the report simply says "nothing drifted" forever, which is the one failure
  // shape this whole check exists to avoid. Measured directly on the confirm path's own source,
  // bounded so it cannot quietly widen to the whole file.
  const runServiceSource = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const confirmStart = runServiceSource.indexOf("export async function confirmStep");
  // The end marker is the function that DIRECTLY follows confirmStep. It used to be summarizeStep,
  // three functions further down, so the slice silently swallowed getModuleDrift and
  // getPayrollDayCollisions too — and tipped past the 8,000-char bound the moment getModuleDrift
  // grew, failing with "the slice must stay bounded" on a change that had nothing to do with the
  // confirm. A bound that fires on an unrelated edit is a bound nobody trusts.
  const confirmEnd = runServiceSource.indexOf("export async function getModuleDrift", confirmStart);
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

  // ---- The watched step list must match the steps a module actually feeds ----------------------------
  // Adding a module-fed step without adding it here would leave that step silently unwatched — the
  // one failure this check cannot detect about itself. A module reaches the recommendation engine
  // through exactly two loaders: `loadConfirmedDeductions` (the Deductions module) and, since
  // 2026-10-09, `loadDisputeRefunds` (the Dispute Center's refund into Additions → Other additions).
  // Both are watched, because both can move after a step is confirmed — which is the only property
  // this check cares about. Scanning for one of them alone is what left `p2_additions` off the list
  // while its confirm froze a 0.00 over money the company owed back.
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
    if (caseKey && (line.includes("loadConfirmedDeductions") || line.includes("loadDisputeRefunds"))) fed.add(caseKey);
  }
  assert.deepEqual(
    [...fed].sort(),
    [...MODULE_SOURCED_STEP_KEYS].sort(),
    "every step that reads a module feeder must be watched for drift, and only those — a new " +
      "module-fed step added without this list would go unwatched with nothing to show it",
  );

  // ---- RE-CONFIRMING A STEP TAKES THE MODULE'S CURRENT FIGURE (2026-10-07) ---------------------
  // The live September 2026 run had 13 blocking lines and the block's own remedy — re-confirm the
  // step — could clear none of them: a step shows and confirms `pick(draft, recommended)`, so the
  // saved figure won and was stored again. And the re-confirm wrote the NEW proposal as the
  // snapshot, so the old figure then read as a deliberate override and the block LIFTED while the
  // run still paid it.
  const staleSnapshot = { b1: { p1odCrmValue: 0 }, b2: { p1odCrmValue: 900 } };
  const staleDrafts = { b1: { p1odCrmValue: 0 }, b2: { p1odCrmValue: 700 } };
  const staleRows = [
    // Frozen at 0.00 by the confirm; the module now proposes 733.33. Nobody chose the 0.00.
    row({ hrId: "B-1", fullName: "Frozen", values: { p1odCrmValue: 0 }, recommended: { p1odCrmValue: 733.33 } }),
    // Somebody set 700 against a proposal of 900, and the module has since moved to 1000.
    row({ hrId: "B-2", fullName: "Overridden", values: { p1odCrmValue: 700 }, recommended: { p1odCrmValue: 1000 } }),
  ];
  const taken = takeCurrentModuleFigures({
    stepKey: "p1_crm",
    rows: staleRows,
    snapshot: staleSnapshot,
    chargedByCompact: staleDrafts,
  });
  assert.equal(taken[0].values.p1odCrmValue, 733.33, "a stale line takes the module's current figure");
  assert.equal(taken[1].values.p1odCrmValue, 700, "a figure that differs from the confirm is somebody's decision and stays");
  assert.equal(staleRows[0].values.p1odCrmValue, 0, "the input rows are not mutated");
  assert.equal(
    takeCurrentModuleFigures({ stepKey: "p1_crm", rows: staleRows, snapshot: null, chargedByCompact: staleDrafts }),
    staleRows,
    "a step never confirmed is returned exactly as it is",
  );

  // What the re-confirm then stores, read back the way the next load reads it: nothing is stale and
  // nothing new reads as an override — the block clears because the money moved, not because the
  // check went blind.
  const afterReconfirm = detectModuleDrift({
    stepKey: "p1_crm",
    rows: taken.map((r) => ({ ...r })),
    snapshot: snapshotRecommendations("p1_crm", taken),
    chargedByCompact: { b1: { p1odCrmValue: taken[0].values.p1odCrmValue }, b2: { p1odCrmValue: 700 } },
  });
  assert.equal(afterReconfirm.staleCharges, 0);
  assert.equal(
    afterReconfirm.rows.find((r) => r.fullName === "Frozen"),
    undefined,
    "after the re-confirm the formerly stale line charges what the module proposes",
  );

  // Both the step view and its confirm go through it — the grid shows what the confirm stores.
  const runService = runServiceSource;
  const confirmStepBody = runService.slice(
    runService.indexOf("export async function confirmStep("),
    runService.indexOf("export async function getModuleDrift("),
  );
  assert.match(confirmStepBody, /withCurrentModuleFigures\(/, "confirmStep must take the module's current figures");
  const viewBody = runService.slice(
    runService.indexOf("export async function getStepRecommendation("),
    runService.indexOf("function assertStepPhaseAllowed("),
  );
  assert.match(viewBody, /withCurrentModuleFigures\(/, "the step view must show what the confirm will store");

  // ---- A DISPLAY-ONLY FIELD HAS NO CHARGE, SO IT CANNOT DRIFT (2026-10-09) ---------------------
  // `p1odCrmWorkingDays` is the COMPLEMENT of the chargeable days — days in the month minus them —
  // and it has no column on the draft row at all (`notPersisted`). So `charged` reads 0.00 for ever
  // while the recommendation is a real 30, and the comparison reported a stale charge of 30.00
  // against an employee being charged nothing. The direction is inverted, which is what made it
  // bite: the fewer the CRM deduction days, the LARGER the fake drift.
  //
  // Live September 2026 run, 2026-10-09: all 11 rows blocking the Part 2 confirm were working-days
  // fields — "set to 0.00 and the Deductions module now says 30.00" — with 0.00 of money among them,
  // and no re-confirm could clear one, because there is no column to write the 30 into.
  const displayOnly = detectModuleDrift({
    stepKey: "p1_crm",
    // Absent from the snapshot entirely: the step was confirmed before this employee joined its
    // population, which is precisely how the live 11 arose.
    rows: [
      row({
        hrId: "AI-0008",
        fullName: "Magdy El Senosey",
        recommended: { p1odCrmWorkingDays: 30, p1odCrmDays: 0, p1odCrmValue: 0 },
        values: { p1odCrmWorkingDays: 30, p1odCrmDays: 0, p1odCrmValue: 0 },
      }),
    ],
    snapshot: {},
    chargedByCompact: { ai0008: {} },
  });
  assert.deepEqual(
    displayOnly.rows.map((r) => r.field),
    [],
    "a notPersisted display field charges nothing, so it must raise no drift row at all — it blocked " +
      "the live September 2026 Part 2 confirm 11 times with 0.00 of money behind it",
  );
  assert.equal(displayOnly.staleCharges, 0, "and therefore must not block the Part 2 confirm");

  // The money beside it is still watched: the exclusion is the column, never the step.
  const moneyBesideIt = detectModuleDrift({
    stepKey: "p1_crm",
    rows: [
      row({
        hrId: "AI-0008",
        recommended: { p1odCrmWorkingDays: 28, p1odCrmDays: 2, p1odCrmValue: 733.33 },
        values: { p1odCrmWorkingDays: 28, p1odCrmDays: 2, p1odCrmValue: 0 },
      }),
    ],
    snapshot: {},
    chargedByCompact: { ai0008: { p1odCrmDays: 0, p1odCrmValue: 0 } },
  });
  assert.deepEqual(
    moneyBesideIt.rows.map((r) => r.field).sort(),
    ["p1odCrmDays", "p1odCrmValue"],
    "a real CRM deduction approved after the confirm must still be caught, days and value both",
  );
  assert.equal(
    moneyBesideIt.staleCharges,
    1,
    "and must still block — on the MONEY. The day count beside it is reported and never blocks on " +
      "its own (2026-10-09): it pays nothing, and whenever it matters the money moved too, which is " +
      "this very row",
  );

  // Nor is it recorded in the first place, so a snapshot written from now on carries no phantom.
  assert.deepEqual(
    snapshotRecommendations("p1_crm", [
      row({ hrId: "AI-0008", recommended: { p1odCrmWorkingDays: 30, p1odCrmDays: 0, p1odCrmValue: 0 } }),
    ]),
    { ai0008: { p1odCrmDays: 0, p1odCrmValue: 0 } },
    "the confirm must not record what a column with no draft column was proposing",
  );

  // ---- AN UNBACKED CHARGE IS MONEY BEING CHARGED, NOT MONEY BEING PAID (2026-10-09) -----------
  // The unbacked-charge report shipped the same day and every one of the 5 rows it produced on the
  // live run was an ADDITION: 65,947.00 of money being PAID, reported as "charges with no approved
  // deduction behind them". No module proposes an Incentive, a Bonus or Overtime — `recommendAdditions`
  // recommends `overtime: 0` for the entire population — so every overtime HR entered tripped it.
  const additions = detectModuleDrift({
    stepKey: "p2_additions",
    rows: [
      row({
        hrId: "A-12",
        fullName: "Ali Mohamed Ali Elsayed",
        recommended: { incentive: 0, bonus: 0, overtime: 0, otherAdditions: 0 },
        values: { incentive: 60000, bonus: 0, overtime: 0, otherAdditions: 0 },
      }),
      row({
        hrId: "AI-0012",
        fullName: "Hanan Safwat SalahEldeen Hassan",
        recommended: { incentive: 0, bonus: 0, overtime: 0, otherAdditions: 0 },
        values: { incentive: 0, bonus: 0, overtime: 2133, otherAdditions: 0 },
      }),
    ],
    snapshot: { a12: { incentive: 0 }, ai0012: { overtime: 0 } },
    chargedByCompact: { a12: { incentive: 60000 }, ai0012: { overtime: 2133 } },
  });
  assert.equal(
    additions.unbackedCharges,
    0,
    "an Incentive and an Overtime are money PAID — no approved deduction could ever stand behind " +
      "one, so the question has no answer and the report is pure noise on a payroll confirm screen",
  );
  assert.equal(
    describeModuleDrift(additions),
    "Every confirmed figure still matches the Deductions module.",
    "and the summary must not mention them at all",
  );

  // Additions stays WATCHED, though: a stale dispute refund still blocks (owner, 2026-10-09).
  const staleRefund = detectModuleDrift({
    stepKey: "p2_additions",
    rows: [row({ hrId: "B-170", recommended: { otherAdditions: 1548 }, values: { otherAdditions: 0 } })],
    snapshot: {},
    chargedByCompact: { b170: { otherAdditions: 0 } },
  });
  assert.equal(staleRefund.staleCharges, 1, "a refund the Dispute Center owes back must still block the confirm");

  // A DAY COUNT IS AN INPUT, NOT A CHARGE. `p1odOtherDays` is recommended as a hard-coded 0 whatever
  // the module says, so a day count HR typed read as "2.00 with no approved deduction behind it" —
  // two EGP, in a sentence about money. The money column beside it carries the charge.
  const typedDays = detectModuleDrift({
    stepKey: "p1_other_deductions",
    rows: [
      row({
        hrId: "A-10",
        fullName: "Nahed Tarek Hassan Omar Hattab",
        recommended: { p1odOtherDays: 0, p1odOtherValue: 0 },
        values: { p1odOtherDays: 2, p1odOtherValue: 2931 },
      }),
    ],
    snapshot: { a10: { p1odOtherDays: 0, p1odOtherValue: 0 } },
    chargedByCompact: { a10: { p1odOtherDays: 2, p1odOtherValue: 2931 } },
  });
  assert.deepEqual(
    typedDays.rows.filter((r) => r.proposedNow === 0 && r.charged > 0).map((r) => r.field),
    ["p1odOtherValue"],
    "the money is the charge worth reporting; the days beside it are an input",
  );
  assert.equal(typedDays.unbackedCharges, 1, "and the case the check was built for must still be reported");
  assert.match(
    describeModuleDrift(typedDays),
    /2931\.00 in Other Deductions \(Loan & Other\) → Other Value/,
    "the sentence must name the COLUMN, not only the step — a deduction step carries more than one " +
      "money column, and its own instruction is to check the other columns on the same row",
  );

  // ---- A DAY COUNT NEVER BLOCKS THE PART 2 CONFIRM ON ITS OWN (2026-10-09) --------------------
  // Measured on the live September 2026 run minutes after the display-field fix shipped: the only two
  // rows still blocking were both `resignationCrmDays` — Aisha Ehab Mamdouh Hussein (B-79) 2.50 days
  // and Ahmed Elsayed Ahmed Ibrahim (PD-0010) 1.00 day, each with a NULL day column — while the MONEY
  // beside each was a figure somebody chose that the same panel declared "still stands" (1,250.00
  // against the module's 1,458.33; 1,050.00 against 1,166.67). So the month was held up over a number
  // that pays nothing, attached to a figure already decided, and the only way out was a re-confirm
  // writing the module's day count next to that money — leaving the row reading "2.50 non-working days
  // priced at 1,250.00".
  const chosenMoneyStaleDays = {
    stepKey: "p1_resignation_crm" as const,
    rows: [
      row({
        hrId: "B-79",
        fullName: "Aisha Ehab Mamdouh Hussein",
        recommended: { resigCrmWorkingDays: 27.5, resignationCrmDays: 2.5, crm: 1458.33 },
        // What the run really carries: the chosen 1,250.00 and a day column nobody filled.
        values: { resigCrmWorkingDays: 30, resignationCrmDays: 0, crm: 1250 },
      }),
    ],
    snapshot: {},
    chargedByCompact: { b79: { crm: 1250 } },
  };
  const dayBesideChosenMoney = detectModuleDrift(chosenMoneyStaleDays);
  assert.equal(
    dayBesideChosenMoney.staleCharges,
    0,
    "a day count pays nothing, so it must not stop the month — and the money beside it is a figure " +
      "somebody chose, which the owner's 2026-10-06 rule says still stands",
  );
  assert.deepEqual(
    dayBesideChosenMoney.rows.map((r) => r.field).sort(),
    ["crm", "resignationCrmDays"],
    "both are still REPORTED — a stale day count beside a chosen figure is worth seeing",
  );
  assert.equal(
    dayBesideChosenMoney.overriddenButMoved,
    1,
    "and the money row reads as the override it is, not as a block",
  );
  assert.match(
    describeModuleDrift(dayBesideChosenMoney),
    /^No confirmed figure is stale./,
    "so the summary must not open by announcing stale figures",
  );

  // AND THE REMEDY MUST NOT WRITE THE DAY COUNT NEXT TO THAT MONEY. Clearing the block by
  // re-confirming was the only route offered, and it would have changed a displayed day count on a
  // row whose money nobody is allowed to touch.
  const afterTakingNothing = takeCurrentModuleFigures(chosenMoneyStaleDays);
  assert.equal(afterTakingNothing[0].values.crm, 1250, "the chosen money stays exactly as it is");
  assert.equal(
    afterTakingNothing[0].values.resignationCrmDays,
    0,
    "and the day count is NOT taken beside it — a re-confirm that prices 2.50 days at 1,250.00 is " +
      "the trap, not the remedy",
  );

  // THE GENUINE CASE IS UNTOUCHED: a deduction the module proposes and the sheet froze at zero moves
  // the MONEY column too, so that row still blocks — and the re-confirm takes the day count WITH the
  // money, never leaving 733.33 priced at 0.00 days.
  const moneyFrozenAtZero = {
    stepKey: "p1_resignation_crm" as const,
    rows: [
      row({
        hrId: "B-58",
        fullName: "Ahmed Abdallah",
        recommended: { resigCrmWorkingDays: 28, resignationCrmDays: 2, crm: 733.33 },
        values: { resigCrmWorkingDays: 30, resignationCrmDays: 0, crm: 0 },
      }),
    ],
    snapshot: {},
    chargedByCompact: { b58: { resignationCrmDays: 0, crm: 0 } },
  };
  const frozenReport = detectModuleDrift(moneyFrozenAtZero);
  assert.equal(frozenReport.staleCharges, 1, "the money the sheet froze at 0.00 must still block");
  assert.deepEqual(
    frozenReport.rows.filter((r) => !r.overridden).map((r) => r.field).sort(),
    ["crm", "resignationCrmDays"],
    "the day row is reported beside it — only the money one counts toward the block",
  );
  assert.match(
    describeModuleDriftBlock(frozenReport),
    /^1 figure\(s\) on this run no longer match .* is set to 0\.00 and the Deductions module now says 733\.33/,
    "and the refusal counts and quotes the money, never the day count",
  );
  const afterTakingBoth = takeCurrentModuleFigures(moneyFrozenAtZero);
  assert.equal(afterTakingBoth[0].values.crm, 733.33, "the re-confirm takes the module's money");
  assert.equal(
    afterTakingBoth[0].values.resignationCrmDays,
    2,
    "and the day count that prices it comes along, so the row never reads 733.33 against 0.00 days",
  );
  assert.equal(pricedMoneyField("p1_resignation_crm", "resignationCrmDays"), "crm");
  assert.equal(
    pricedMoneyField("p1_resignation_crm", "crm"),
    undefined,
    "money prices nothing — the link is one-way, from the day count to its own money column",
  );

  // ---- THE PANEL NAMES THE COLUMN, NOT ONLY THE STEP ------------------------------------------
  // "the module now says 2.50" sat in the same list as a line that genuinely was 1,458.33 EGP, both
  // labelled only "Resignations CRM" — so 2.50 days read as 2.50 EGP.
  assert.equal(columnLabel("p1_resignation_crm", "resignationCrmDays"), "Resignations CRM → Non-Working Days");
  assert.equal(columnLabel("p1_resignation_crm", "crm"), "Resignations CRM → CRM Value");
  assert.equal(
    columnLabel("p1_resignation_crm", "noSuchField"),
    "Resignations CRM",
    "an unrecognised key falls back to the step title rather than printing undefined",
  );
  const wizardSource = readFileSync("src/components/automated-payroll/automated-payroll-wizard.tsx", "utf8");
  assert.equal(
    wizardSource.split("columnLabel(row.stepKey, row.field)").length - 1,
    2,
    "both drift branches in the Show-who panel must name the column — the unbacked charge and the " +
      "drifted figure alike",
  );
  assert.ok(
    !wizardSource.includes("stepDefinition(row.stepKey).title"),
    "and neither may go back to naming the step alone",
  );
}
