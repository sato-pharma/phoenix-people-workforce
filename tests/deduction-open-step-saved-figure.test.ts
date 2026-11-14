import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { upsertDraftRows } from "../src/lib/automated-payroll/draft-store.ts";
import {
  describeReopenedPart1Block,
  MODULE_SOURCED_STEP_KEYS,
  reopenedPart1DeductionSteps,
  stepOpenDuringPart2,
} from "../src/lib/automated-payroll/module-sourced-steps.ts";
import { stepEditToPatch } from "../src/lib/automated-payroll/run-service.ts";
import {
  figureGroups,
  untouchedFigureFields,
  writeIsUntouched,
  type FigureWrite,
} from "../src/lib/automated-payroll/saved-figures.ts";
import type { DraftRowPatch, StepKey } from "../src/lib/automated-payroll/types.ts";

// The September 2026 run (2026-10-07). The "Any more deductions?" step was saved as a whole grid of
// 103 rows on 6 October while the module proposed 0.00 for every line not yet pushed, so it wrote
// 0.00 for everybody, and 8,405.17 EGP approved later for two employees stayed behind a 0.00 nobody
// typed. deduction-resync.ts now keeps a saved figure only when the cell history says a PERSON saved
// it — so a save must write only what somebody changed, or every untouched row reads as typed.
//
// And Part 2 was confirmable while a Part 1 deduction step a decision had re-opened sat with its
// figure cleared, which the sheet reads as 0.00.

function write(fields: {
  written: Record<string, number | null>;
  proposed?: Record<string, number>;
  before?: Record<string, number | null>;
  shown?: Record<string, number>;
}): FigureWrite {
  return {
    compact: "e0001",
    written: fields.written,
    proposed: fields.proposed ?? {},
    before: fields.before ?? {},
    shown: fields.shown ?? {},
  };
}

type CapturedRequest = { host: string; columns: string[]; rows: Array<Record<string, unknown>> };

/**
 * Runs `body` against the REAL admin client with every request captured instead of sent: a stand-in
 * project URL and key, and a global fetch that records the PostgREST column list and body. Both are
 * restored afterwards, and the client memo is keyed on the URL and key, so nothing downstream keeps
 * talking to the stand-in.
 */
async function capturingAdminRequests(body: () => Promise<void>): Promise<CapturedRequest[]> {
  const requests: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  const realUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const realKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54399";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in-key-never-sent";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const columns = (url.searchParams.get("columns") ?? "")
      .split(",")
      .filter(Boolean)
      .map((column) => column.replace(/^"|"$/g, ""));
    const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : [];
    requests.push({
      host: url.host,
      columns,
      rows: (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>,
    });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = realUrl;
    if (realKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = realKey;
  }
  return requests;
}

export async function runDeductionOpenStepSavedFigureTests() {
  // ── 1. A save writes only what somebody changed (saved-figures.ts) ─────────────────────────────
  assert.equal(
    writeIsUntouched(write({ written: { manualOtherDeductions: 0 }, proposed: { manualOtherDeductions: 0 }, before: { manualOtherDeductions: null } })),
    true,
    "THE SEPTEMBER ROW: the grid carried the proposed 0.00 into an empty cell — nobody chose it, so it is not written and the step keeps following the module",
  );
  assert.equal(
    writeIsUntouched(write({ written: { manualOtherDeductions: 500 }, proposed: { manualOtherDeductions: 0 }, before: { manualOtherDeductions: null } })),
    false,
    "a figure typed over the proposal is a person's choice and is written",
  );
  assert.equal(
    writeIsUntouched(write({ written: { manualOtherDeductions: 300 }, proposed: { manualOtherDeductions: 0 }, before: { manualOtherDeductions: 300 } })),
    true,
    "a figure the draft already holds is carried, not re-written — re-writing it would stamp a fresh 'person saved it' entry",
  );
  assert.equal(
    writeIsUntouched(write({ written: { manualOtherDeductions: 0 }, proposed: { manualOtherDeductions: 0 }, before: { manualOtherDeductions: 300 } })),
    false,
    "typing the proposal over a DIFFERENT stored figure changes the sheet, so it is written — leaving it unwritten would keep the 300",
  );
  assert.equal(
    writeIsUntouched(write({ written: { manualOtherDeductions: 100 }, before: { manualOtherDeductions: null } })),
    false,
    "a figure where the screen proposed nothing is typed",
  );
  assert.equal(
    writeIsUntouched(write({ written: { manualOtherDeductions: null }, before: { manualOtherDeductions: 300 } })),
    false,
    "clearing a stored figure is a change",
  );
  assert.equal(
    writeIsUntouched(write({ written: { manualOtherDeductions: null }, before: { manualOtherDeductions: null } })),
    true,
    "clearing an empty cell changes nothing",
  );
  assert.equal(
    writeIsUntouched(
      write({
        written: { fingerprintDays: 2, fingerprintValue: 700 },
        proposed: { fingerprintDays: 2, fingerprintValue: 640 },
        before: { fingerprintDays: null, fingerprintValue: null },
      }),
    ),
    false,
    "a day count and its money are judged together: one typed figure writes the whole row",
  );
  assert.equal(
    writeIsUntouched(write({ written: { manualOtherDeductions: 120.004 }, proposed: { manualOtherDeductions: 120 }, before: {} })),
    true,
    "money is stored to the piastre, so half a piastre is the same figure",
  );
  assert.equal(
    writeIsUntouched(write({ written: { fingerprintValue: 640 }, before: { fingerprintValue: 500 }, shown: { fingerprintValue: 640 } })),
    true,
    "the module's figure the step shows in front of a stale confirmed one is sent back untouched — not a person's choice",
  );
  assert.equal(
    writeIsUntouched(write({ written: { fingerprintValue: 700 }, before: { fingerprintValue: 500 }, shown: { fingerprintValue: 640 } })),
    false,
    "a figure typed over what the step shows is still a person's choice",
  );

  // Judged per day-and-money group, not per row: "Other Part 1 deductions" carries a loan pair and an
  // "other" pair on one row, and typing the loan must not stamp the other pair's 0.00 as typed — that
  // stamp would keep a later "other" approval out of the step exactly as in September.
  const loanTyped = write({
    written: { p1odLoanDays: 1, p1odLoanValue: 400, p1odOtherDays: 0, p1odOtherValue: 0 },
    proposed: { p1odLoanDays: 0, p1odLoanValue: 0, p1odOtherDays: 0, p1odOtherValue: 0 },
    before: { p1odLoanDays: null, p1odLoanValue: null, p1odOtherDays: null, p1odOtherValue: null },
  });
  assert.deepEqual(
    untouchedFigureFields(loanTyped, figureGroups("p1_other_deductions", Object.keys(loanTyped.written))).sort(),
    ["p1odOtherDays", "p1odOtherValue"],
    "THE OTHER PAIR: typing the loan writes the loan pair only — the untouched 'other' pair is left out",
  );
  assert.deepEqual(
    figureGroups("p1_unpaid_vacation", ["p1odVacationDays", "p1odVacationValue", "unpaidVacations"]),
    [["p1odVacationDays", "p1odVacationValue", "unpaidVacations"]],
    "a Part-1-settled employee's vacation is ONE figure across both vacation columns, judged together",
  );

  // ── 1b. The vacation figure lives in ONE column, and the other is cleared (run-service.ts) ───────
  // Everyone on "Unpaid Vacation" is settled in Part 1: a leaver's figure lives on unpaid_vacations,
  // anyone else's on p1od_vacation_value, and assemble.ts deducts BOTH columns. Someone who became a
  // leaver after the step was confirmed still carries the old column, so it must be cleared on purpose —
  // the one bulk write used to clear it by accident, and upsertDraftRows now sends only named columns.
  const leaverPatch = stepEditToPatch(
    "p1_unpaid_vacation",
    { hrId: "E-0005", values: { p1odVacationDays: 0, p1odVacationValue: 1000 } },
    true,
  );
  assert.equal(leaverPatch.unpaidVacations, 1000, "a leaver's vacation lands on unpaid_vacations");
  assert.ok(
    "p1odVacationValue" in leaverPatch && leaverPatch.p1odVacationValue === null,
    "THE DOUBLE DEDUCTION: a leaver's p1od_vacation_value is written as NULL, never left holding the figure from before they resigned",
  );
  const stayerPatch = stepEditToPatch(
    "p1_unpaid_vacation",
    { hrId: "E-0006", values: { p1odVacationDays: 0, p1odVacationValue: 1000 } },
    false,
  );
  assert.equal(stayerPatch.p1odVacationValue, 1000, "anyone else's vacation lands on p1od_vacation_value");
  assert.ok(
    "unpaidVacations" in stayerPatch && stayerPatch.unpaidVacations === null,
    "and their unpaid_vacations is written as NULL, so a withdrawn resignation does not deduct the vacation twice",
  );
  const reasonOnly = stepEditToPatch("p1_unpaid_vacation", { hrId: "E-0007", reasons: { p1odVacationReason: "note" } }, true);
  assert.equal(
    "unpaidVacations" in reasonOnly || "p1odVacationValue" in reasonOnly,
    false,
    "an edit that carries no vacation figure touches neither column",
  );

  // ── 2. The bulk write never blanks a figure a row left out (draft-store.ts) ────────────────────
  // C already holds a typed 1,000.00 and was untouched on this save, so its figures are stripped; A
  // was typed. In ONE bulk request PostgREST lists the union of columns and writes NULL into C's
  // manual_other_deductions — paying C 1,000.00 more than HR decided.
  const typed: DraftRowPatch = {
    employeeHrId: "E-0001",
    manualOtherDeductions: 500,
    manualReason: "typed on this save",
    editedBy: "HR-TEST",
    writeReason: "step_saved",
    writeStepKey: "p2_manual_deductions",
  };
  const untouched: DraftRowPatch = {
    employeeHrId: "E-0003",
    manualReason: "kept",
    editedBy: "HR-TEST",
    writeReason: "step_saved",
    writeStepKey: "p2_manual_deductions",
  };
  const requests = await capturingAdminRequests(() => upsertDraftRows("run-test", [typed, untouched]));
  const untouchedRequest = requests.find((request) => request.rows.some((row) => row.employee_hr_id === "E-0003"));
  assert.ok(untouchedRequest, "the untouched row is still written (its reason and who-saved-it)");
  assert.equal(
    untouchedRequest.columns.includes("manual_other_deductions"),
    false,
    "THE ERASE: the untouched row's request must not name manual_other_deductions, or its stored 1,000.00 becomes NULL",
  );
  assert.equal(requests.length, 2, "the typed row and the untouched row carry different columns, so they go in separate requests");
  for (const request of requests) {
    assert.equal(request.host, "127.0.0.1:54399", "every request went to the stand-in, never a real project");
    for (const row of request.rows) {
      assert.deepEqual(
        [...request.columns].sort(),
        Object.keys(row).sort(),
        "a request names exactly the columns each of its rows carries — a column a row left out is never written as NULL",
      );
    }
  }

  // ── 3. The Part 2 block and the step it points at (module-sourced-steps.ts) ─────────────────────
  const states = (open: StepKey[]) =>
    [...MODULE_SOURCED_STEP_KEYS, "p1_new_hires" as StepKey, "p1_holds" as StepKey].map((stepKey) => ({
      stepKey,
      status: open.includes(stepKey) ? "pending" : "confirmed",
    }));
  assert.deepEqual(
    reopenedPart1DeductionSteps(states(["p1_fingerprint", "p1_unpaid_vacation"])),
    ["p1_fingerprint", "p1_unpaid_vacation"],
    "THE SEPTEMBER STATE: both re-opened Part 1 deduction steps are named, so Part 2 refuses until they are confirmed again",
  );
  assert.deepEqual(reopenedPart1DeductionSteps(states([])), [], "with every step confirmed, Part 2 is not blocked");
  assert.deepEqual(
    reopenedPart1DeductionSteps(states(["p2_manual_deductions"])),
    [],
    "a Part 2 step is Part 2's own gate, not this one",
  );
  assert.equal(stepOpenDuringPart2("p1_fingerprint", states(["p1_fingerprint"])), true, "a re-opened Part 1 deduction step can be confirmed during Part 2");
  assert.equal(stepOpenDuringPart2("p1_fingerprint", states([])), false, "a confirmed Part 1 step stays locked during Part 2");
  assert.equal(
    stepOpenDuringPart2("p1_holds", states(["p1_holds"])),
    false,
    "only a step the Deductions module feeds is opened — nothing else in Part 1 may move after the first instalment is paid",
  );
  const message = describeReopenedPart1Block(["p1_fingerprint", "p1_unpaid_vacation"]);
  assert.match(message, /"Fingerprint deductions" and "Unpaid Vacation" are open again in Part 1/, "the block names each step by its title");
  assert.match(message, /confirm it again/, "the block says what clears it");
  assert.match(message, /overpaid/, "the block warns that anyone paid whole in Part 1 meets the overpaid gate next");
  assert.doesNotMatch(message, /unconfirm/i, "never send HR to Unconfirm Part 1, which re-freezes the paid first instalment and loses the deduction");

  // ── 4. Source pins: the wiring that a pure test cannot see ───────────────────────────────────────
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const saveStep = runService.slice(runService.indexOf("export async function saveStep("), runService.indexOf("export async function confirmStep("));
  assert.match(saveStep, /loadStepView\(access, runId, stepKey\)/, "saveStep reads the draft rows it judges against");
  assert.match(saveStep, /MODULE_SOURCED_STEP_KEYS\.includes\(stepKey\)/, "only a step fed by the Deductions module strips untouched figures");
  assert.match(
    saveStep,
    /stripFigures\(patch, untouchedFigureFields\(write, figureGroups\(stepKey, Object\.keys\(write\.written\)\)\)\);/,
    "an untouched figure group is not written",
  );
  const confirmPart2 = runService.slice(runService.indexOf("export async function confirmPart2("));
  const gateAt = confirmPart2.indexOf("reopenedPart1DeductionSteps(states)");
  assert.ok(gateAt > 0, "confirmPart2 refuses while a Part 1 deduction step is open again");
  assert.ok(gateAt < confirmPart2.indexOf("assertPayrollDataAcknowledged"), "the block runs before Part 2 changes anything");

  const draftStore = readFileSync("src/lib/automated-payroll/draft-store.ts", "utf8");
  const upsert = draftStore.slice(draftStore.indexOf("export async function upsertDraftRows("));
  assert.match(upsert.slice(0, 1200), /groupRowsByColumnSet\(rows\)/, "upsertDraftRows writes one column set at a time");

  const grid = readFileSync("src/components/automated-payroll/recommendation-step.tsx", "utf8");
  assert.match(grid, /recommended: row\.recommended,/, "the grid sends what it proposed with every save");

  const wizard = readFileSync("src/components/automated-payroll/automated-payroll-wizard.tsx", "utf8");
  const stepLocked = wizard.slice(wizard.indexOf("const stepLocked = "), wizard.indexOf("const stepLocked = ") + 900);
  assert.match(stepLocked, /stepOpenDuringPart2\(stepKey, stepStates\)/, "the wizard keeps a re-opened Part 1 deduction step open during Part 2, so the block has a button that clears it");

  // The server half (audit, 14 Nov 2026): the lock above was the browser's alone, so a stale tab or a
  // re-uploaded file could still save a locked Part 1 step during Part 2 and move the month unseen.
  const service = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");
  const gate = service.slice(service.indexOf("async function assertPart1StepOpenDuringPart2("));
  assert.match(
    gate.slice(0, 700),
    /if \(run\.phase !== "part2" \|\| stepPhase\(stepKey\) !== "part1"\) return;[\s\S]*if \(!stepOpenDuringPart2\(stepKey, states\)\) \{\s*throw new Error\(/,
    "HEADLINE: during Part 2 the server refuses a Part 1 step the screen keeps locked",
  );
  for (const writer of ["export async function saveStep(", "export async function confirmStep(", "export async function importStepUpload("]) {
    const body = service.slice(service.indexOf(writer), service.indexOf(writer) + 1500);
    assert.match(
      body,
      /assertStepPhaseAllowed\(run, stepKey\);\s*await assertPart1StepOpenDuringPart2\(run, stepKey\);/,
      `${writer.replace("export async function ", "").replace("(", "")} asks the same question before it writes`,
    );
  }
  const part2Confirm = wizard.slice(wizard.indexOf("const confirmPart2WithOverpaidGate = "));
  const refusal = part2Confirm.slice(0, part2Confirm.indexOf('throw new Error(data.error ?? "Action failed.");'));
  assert.match(
    refusal.slice(refusal.lastIndexOf("if (data.requiresOverpaidAcknowledgment)")),
    /await loadRun\(month, year\);/,
    "a refused Part 2 confirm reloads the step states first, so a step re-opened since the page loaded is unlocked when HR goes to it",
  );

  const browserSafe = readFileSync("src/lib/automated-payroll/module-sourced-steps.ts", "utf8");
  const imports = browserSafe.match(/^import .* from "(.*)";$/gm) ?? [];
  assert.deepEqual(
    imports.map((line) => line.replace(/^.* from "(.*)";$/, "$1")).sort(),
    ["./step-definitions.ts", "./types.ts"],
    "the wizard imports this file, so it may reach nothing that reaches the database client",
  );
}
