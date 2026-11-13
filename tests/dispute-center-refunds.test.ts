import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  additionsCandidatesFromStepRows,
  assertAdditionsReasonsPresent,
} from "../src/lib/automated-payroll/additions-reason.ts";
import { disputeRefundsByCompact, type DisputeRefundRow } from "../src/lib/automated-payroll/dispute-refunds.ts";
import { MODULE_SOURCED_STEP_KEYS, takeCurrentModuleFigures } from "../src/lib/automated-payroll/module-drift.ts";
import { recommendAdditions, type PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow, StepRow } from "../src/lib/automated-payroll/types.ts";
import {
  buildDisputeCenterAttachmentPath,
  disputeCenterAttachmentUrl,
  DISPUTE_ATTACHMENT_MAX_FILES,
} from "../src/lib/dispute-center/attachment-rules.ts";
import { payrollCharge } from "../src/lib/dispute-center/charge.ts";

/**
 * MONEY BACK AFTER A DISPUTE IS WON LATE.
 *
 * The owner's ruling, 2026-10-09, asked as a direct question and answered in his own words: a
 * deduction whose month is already PUBLISHED and PAID is still reopened and still decided — and if
 * the employee wins, the money comes back in the NEXT month's payroll, "in additions, other".
 *
 * What that forbids is the tempting shortcut: rewriting a published month so the figures agree. A
 * paid month is a historical record of what was paid; it is never edited to fix a later decision.
 * So the refund is a RECOMMENDATION into the next open run's Other Additions cell — HR sees it with
 * its reason and confirms the step, exactly like the standing additions register. Nothing here pays
 * anybody by itself.
 */

const p = (year: number, month: number) => ({ year, month });

function member(hrId: string, compact: string): PopulationMember {
  return {
    employee: { hrId, fullName: "Test Person", jobTitle: "Medical Rep", lineName: null, hireDate: "2025-09-01" },
    compact,
    lifecycle: "continuing",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  } as unknown as PopulationMember;
}

const REFUND: DisputeRefundRow = {
  amount: 420.5,
  employeeHrIdCompact: "B77",
  reason: "Fingerprint deduction cancelled when the dispute was reopened and accepted",
  sourceMonthKey: "2026-09",
  status: "recommended",
  targetMonthKey: "2026-10",
};

export async function runDisputeCenterRefundsTests() {
  // Due in its target month, and in no other month — a refund must never be paid twice because a
  // later run also reads the row.
  assert.equal(disputeRefundsByCompact([REFUND], p(2026, 10)).get("B77")?.amount, 420.5, "October pays it");
  assert.equal(disputeRefundsByCompact([REFUND], p(2026, 11)).get("B77"), undefined, "November does not");
  assert.equal(disputeRefundsByCompact([REFUND], p(2026, 9)).get("B77"), undefined, "nor the month it came from");

  // The reason says which month's deduction it gives back, in words — the employee and HR both read
  // this cell, and "420.50" with no explanation is unauditable.
  const reason = disputeRefundsByCompact([REFUND], p(2026, 10)).get("B77")?.reason ?? "";
  assert.match(reason, /September 2026/, "the reason names the month in words, never 2026-09");
  assert.match(reason, /Fingerprint deduction cancelled/, "…and carries the decision's own reason");

  // A CANCELLED refund is never due. This is the path that matters when a reopened dispute is
  // decided a second time the other way: the recommendation is cancelled, not paid and then clawed.
  assert.equal(
    disputeRefundsByCompact([{ ...REFUND, status: "cancelled" }], p(2026, 10)).get("B77"),
    undefined,
    "a cancelled refund is not money owed",
  );
  assert.equal(
    disputeRefundsByCompact([{ ...REFUND, amount: 0 }], p(2026, 10)).get("B77"),
    undefined,
    "a zero refund is not an addition",
  );
  assert.equal(
    disputeRefundsByCompact([{ ...REFUND, amount: -50 }], p(2026, 10)).get("B77"),
    undefined,
    "and a NEGATIVE refund is refused outright — an addition step never takes money",
  );
  assert.equal(
    disputeRefundsByCompact([{ ...REFUND, employeeHrIdCompact: "" }], p(2026, 10)).size,
    0,
    "a row with no employee on it is dropped rather than paid to a blank key",
  );

  // Two refunds for one person in one month add up, and both reasons are carried.
  const two = disputeRefundsByCompact(
    [REFUND, { ...REFUND, amount: 100.25, reason: "Late-arrival deduction reduced to half a day", sourceMonthKey: "2026-08" }],
    p(2026, 10),
  ).get("B77");
  assert.equal(two?.amount, 520.75, "the amounts are summed to the cent");
  assert.match(two?.reason ?? "", /September 2026/);
  assert.match(two?.reason ?? "", /August 2026/, "both months are named, so neither refund becomes invisible");

  // ---- THE ADDITIONS STEP: it lands in Other Additions, with its reason ---------------------------
  const refunds = disputeRefundsByCompact([REFUND], p(2026, 10));
  const [owed, untouched] = recommendAdditions([member("B-77", "B77"), member("B-1", "B1")], new Map(), new Map(), refunds);
  assert.equal(owed?.values.otherAdditions, 420.5, "the Other Additions cell is pre-filled with what is owed back");
  assert.equal(owed?.recommended.otherAdditions, 420.5);
  assert.match(owed?.reason ?? "", /September 2026/, "with the reason, so the confirm rule is satisfied honestly");
  assert.equal(untouched?.values.otherAdditions, 0, "nobody else is given anything");
  assert.equal(untouched?.reason, null);

  // HR's own figure always wins — the Dispute Center recommends, HR decides, exactly like the
  // standing additions register.
  const saved = new Map<string, DraftRow>([
    ["B77", { employeeHrIdCompact: "B77", otherAdditions: 250, additionsReason: null } as DraftRow],
  ]);
  const [overridden] = recommendAdditions([member("B-77", "B77")], saved, new Map(), refunds);
  assert.equal(overridden?.values.otherAdditions, 250, "a figure HR saved is never overwritten by a refund row");
  assert.equal(overridden?.recommended.otherAdditions, 420.5, "but the recommendation still shows what was owed");
  assert.equal(overridden?.reason, null, "and the refund's reason is not attached to HR's different figure");

  // ---- THE FROZEN ZERO — a refund that falls due AFTER the Additions step was confirmed -----------
  //
  // `confirmStep` persists every visible row, so the first Additions confirm writes
  // `other_additions = 0.00` for the whole population. `pick` then prefers that saved zero over the
  // feeder for ever: a refund recommended afterwards appeared nowhere, was never paid, and nothing
  // in the run said so. Being on MODULE_SOURCED_STEP_KEYS is what tells a zero nobody chose from a
  // figure somebody typed — the confirm records what the feeder was proposing at the time.
  assert.ok(
    MODULE_SOURCED_STEP_KEYS.includes("p2_additions"),
    "the Additions step is module-fed: without this its confirm records no snapshot, and a refund " +
      "arriving after it stays frozen behind a 0.00 for ever",
  );
  const additionsRow = (hrId: string, otherAdditions: number) =>
    ({
      fullName: "Test Person",
      hrId,
      recommended: { bonus: 0, incentive: 0, otherAdditions: 420.5, overtime: 0 },
      values: { bonus: 0, incentive: 0, otherAdditions, overtime: 0 },
    }) as unknown as StepRow;
  const takenBack = takeCurrentModuleFigures({
    // Both rows were confirmed while the feeder proposed nothing; the refund arrived afterwards.
    chargedByCompact: { b1: { otherAdditions: 250 }, b77: { otherAdditions: 0 } },
    rows: [additionsRow("B-77", 0), additionsRow("B-1", 250)],
    snapshot: { b1: { otherAdditions: 0 }, b77: { otherAdditions: 0 } },
    stepKey: "p2_additions",
  });
  assert.equal(
    takenBack[0]?.values.otherAdditions,
    420.5,
    "re-confirming the step takes the refund the frozen 0.00 was hiding",
  );
  assert.equal(
    takenBack[1]?.values.otherAdditions,
    250,
    "and a figure HR typed against that same proposal is somebody's decision — left exactly alone",
  );

  // …and the re-confirm the drift block asks for must not then be REFUSED for a missing reason,
  // which is what a suppressed refund reason did: money with no explanation is rejected at confirm.
  const frozen = new Map<string, DraftRow>([
    ["B77", { additionsReason: null, employeeHrIdCompact: "B77", otherAdditions: 0 } as DraftRow],
  ]);
  const [frozenRow] = recommendAdditions([member("B-77", "B77")], frozen, new Map(), refunds);
  assert.match(
    frozenRow?.reason ?? "",
    /September 2026/,
    "a saved ZERO never suppresses the refund's reason — a zero explains nothing and needs no " +
      "explanation of its own, and the confirm that takes the refund back would otherwise be refused",
  );
  assert.doesNotThrow(
    () =>
      assertAdditionsReasonsPresent(
        additionsCandidatesFromStepRows([
          { hrId: "B-77", reason: frozenRow?.reason ?? null, values: { otherAdditions: 420.5 } },
        ]),
      ),
    "so the swapped-back refund confirms, reason and all",
  );
  assert.throws(
    () =>
      assertAdditionsReasonsPresent(
        additionsCandidatesFromStepRows([{ hrId: "B-77", reason: null, values: { otherAdditions: 420.5 } }]),
      ),
    /needs a reason/,
    "the rule itself is unchanged: an unexplained addition is still refused",
  );

  // A refund and a standing addition in the same month never overwrite one another.
  const bothFeeders = recommendAdditions(
    [member("B-77", "B77")],
    new Map(),
    new Map([["B77", { incentive: 1_000, bonus: 0, reason: "Quarterly incentive" }]]),
    refunds,
  )[0];
  assert.equal(bothFeeders?.values.incentive, 1_000, "the standing addition keeps its own cell");
  assert.equal(bothFeeders?.values.otherAdditions, 420.5, "and the refund keeps its own");
  assert.match(bothFeeders?.reason ?? "", /Quarterly incentive/);
  assert.match(bothFeeders?.reason ?? "", /September 2026/, "both reasons reach the one reason field");

  // ---- Wiring: the step reads the feeder, and the feeder fails CLOSED ------------------------------
  const recommend = readFileSync("src/lib/automated-payroll/recommend.ts", "utf8");
  assert.match(
    recommend,
    /case "p2_additions":\s*return recommendAdditions\(input\.members, drafts, await loadStandingAdditions\(input\.period\), await loadDisputeRefunds\(input\.period\)\);/,
    "without this the refunds exist and nothing ever reads them",
  );
  const feeder = readFileSync("src/lib/automated-payroll/dispute-refunds.ts", "utf8");
  assert.ok(
    feeder.includes("if (isMissingTableError(error)) return new Map();") && feeder.includes("throw error;"),
    "a read error throws — a refund silently reading as zero is money owed back that nobody pays",
  );

  // ---- WHAT A DEDUCTION CHARGES IS ITS DECISION, NEVER THE PAYSLIP LINE --------------------------
  //
  // owner, 2026-10-07 (deductions-source.ts `buildDeductionBuckets`): "a candidate counts iff its
  // decision is 'Approved for Payroll' … Whether the line was pushed is not read here at all". The
  // dispute path measured every refund against the LINE instead, and the two disagree in both
  // directions — each one real money on a real payslip:
  //   * approved but never pushed → no active line, so "charged before" read 0.00 and a dispute the
  //     employee WON refunded nothing while payroll charged the month in full;
  //   * line withdrawn by an earlier decision → 0.00 again, so the next decision read as money going
  //     back and recommended a second refund on top of the one already live.
  const asCandidate = (fields: Record<string, unknown>) => fields as unknown as Parameters<typeof payrollCharge>[0];
  const asDecision = (fields: Record<string, unknown> | null) => fields as unknown as Parameters<typeof payrollCharge>[1];
  const twoDays = asCandidate({
    category: "fingerprint",
    dates: ["2026-09-03", "2026-09-04"],
    estimated_amount: 2800,
    raw_value: 2,
    unit: "days",
  });
  assert.deepEqual(
    payrollCharge(
      twoDays,
      asDecision({ applied_amount: 2800, applied_dates: null, applied_value: 2, decision_status: "Approved for Payroll" }),
    ),
    { amount: 2800, value: 2 },
    "an approved deduction charges its decision — no payslip line anywhere in the answer",
  );
  assert.deepEqual(
    payrollCharge(
      twoDays,
      asDecision({ applied_amount: 1400, applied_dates: ["2026-09-03"], applied_value: 1, decision_status: "Approved for Payroll" }),
    ),
    { amount: 1400, value: 1 },
    "a decision narrowed to one day charges that one day",
  );
  assert.deepEqual(
    payrollCharge(
      twoDays,
      asDecision({ applied_amount: 2800, applied_dates: null, applied_value: 2, decision_status: "Do Not Take Action" })),
    { amount: 0, value: 0 },
    "a cancelled deduction charges nothing, whatever figures its row still carries",
  );
  assert.deepEqual(
    payrollCharge(twoDays, asDecision({ applied_amount: null, applied_dates: null, applied_value: null, decision_status: "Pending" })),
    { amount: 0, value: 0 },
    "and an undecided one fails CLOSED — payroll charges nothing nobody confirmed",
  );
  assert.deepEqual(
    payrollCharge(twoDays, asDecision(null)),
    { amount: 0, value: 0 },
    "no decision row at all is the same answer, never the detected figure",
  );
  assert.deepEqual(
    payrollCharge(
      asCandidate({ category: "loans", dates: [], estimated_amount: 900, raw_value: 900, unit: "amount" }),
      asDecision({ applied_amount: 900, applied_dates: null, applied_value: 900, decision_status: "Approved for Payroll" }),
    ),
    { amount: 900, value: 900 },
    "for an amount deduction the value IS the money — the reduce ceiling is read in that same unit",
  );

  // ---- A PAID month is never rewritten -------------------------------------------------------------
  const deduction = readFileSync("src/lib/dispute-center/deduction.ts", "utf8");
  assert.ok(
    deduction.includes("recommendDisputeRefund("),
    "money owed back after a paid month becomes a recommendation into a later payroll",
  );
  const refundsLib = readFileSync("src/lib/dispute-center/refunds.ts", "utf8");
  assert.ok(
    !/update\(\{[^}]*published/.test(refundsLib) && !refundsLib.includes("payroll_runs"),
    "and nothing in the refund path reaches back into a published run",
  );

  // The decision WITHDRAWS the live line before it records a new decision — a deduction locked by a
  // publication refuses a decision outright, so the order is the whole mechanism, not a nicety.
  const decideStart = deduction.indexOf("export async function decideDeductionDispute");
  assert.ok(decideStart > 0, "the deduction decision exists");
  const decide = deduction.slice(decideStart, deduction.indexOf("\nexport ", decideStart + 10));
  const withdrawAt = decide.indexOf("withdrawDeduction(");
  const recordAt = decide.indexOf("recordDecision(");
  assert.ok(withdrawAt > 0 && recordAt > 0, "it both withdraws and records");
  assert.ok(withdrawAt < recordAt, "the live line is withdrawn BEFORE the new decision is recorded");
  assert.ok(
    decide.includes("resolveDecisionCharge") || decide.includes("appliedValue"),
    "a REDUCE decision charges the days he typed, through the deductions module's own charge rule",
  );

  // The decision note is OPTIONAL (owner, 2026-10-18) — approve, reduce or reject with or without words.
  assert.ok(
    !/if \(!note\) throw/.test(decide) && decide.includes("noteSuffix"),
    "a deduction dispute decision never refuses an empty note",
  );
  const panel = readFileSync("src/components/disputes/dispute-decision-panel.tsx", "utf8");
  assert.ok(
    !panel.includes("!note.trim()"),
    "no decision or reopen button in the dispute panel waits for a note",
  );
  for (const file of [
    "src/lib/dispute-center/deduction.ts",
    "src/lib/dispute-center/calendar.ts",
    "src/lib/dispute-center/digest.ts",
    "src/lib/private-calendar/disputes.ts",
  ]) {
    assert.ok(!/if \(!note\) throw/.test(readFileSync(file, "utf8")), `${file} never refuses an empty decision or reopen note`);
  }
  assert.ok(
    !readFileSync("src/components/admin/private-calendar-disputes-workspace.tsx", "utf8").includes("decision note is required"),
    "the calendar disputes workspace does not demand a note either",
  );

  // Every money figure in the decision comes from payrollCharge, and the LINE is never the basis.
  assert.ok(
    decide.includes("const before = payrollCharge(candidate, decisionBefore);") &&
      decide.includes("const chargedBefore = before.amount;"),
    "what was charged before the decision is the DECISION's figure — the refund is this minus what " +
      "is charged after, so a line-shaped basis is a wrong refund every time the two disagree",
  );
  assert.ok(
    !/chargedBefore\s*=\s*.*applied_amount/.test(decide) && !/ceiling\s*=\s*activeLine/.test(decide),
    "neither the refund basis nor the reduce ceiling may read the publication line again",
  );
  // The detected figure is the ceiling ONLY for a deduction nobody has decided (owner, 2026-11-13: an
  // employee may dispute before the money is taken) — it has no decided figure to stay under. A
  // DECIDED one, approved or narrowed, is still capped at what it charges now.
  assert.ok(
    decide.includes("const ceiling = undecided ? num(candidate.raw_value) : before.value;") &&
      decide.includes("const undecided = isUndecidedDeductionStatus(decisionBefore?.decision_status);"),
    "REDUCE is measured against what the deduction charges NOW, so it can only ever lower it — the " +
      "old ceiling was the DETECTED figure whenever no line was live, which let a deduction already " +
      "cut to 1 day be 'reduced' to 3 of its 4 detected days",
  );
  assert.ok(
    decide.includes("There is nothing to reduce"),
    "…and a deduction charging nothing cannot be reduced at all, rather than reduced from zero",
  );

  // A DECIDED case is decided again only after a reopen — the gate digest.ts has had all along.
  assert.ok(
    decide.includes("isDecidedByEvents(events)") &&
      decide.includes("conflictError(ALREADY_DECIDED)") &&
      deduction.includes("Reopen it first, then decide it again."),
    "without this a decided case could be decided twice over, and each decision measured what it " +
      "owed against what the last one left — a second refund stacked on the first",
  );

  // REJECT is a statement about the money: where an earlier decision on the same dispute lowered the
  // deduction, rejecting now puts it back, from the figure that decision's own event recorded.
  assert.ok(
    decide.includes('details.chargedValueBefore') && decide.includes("chargedValueBefore: before.value"),
    "the decision records the FIGURE behind the amount, because that is what a later reject restores " +
      "— an amount alone cannot be restored through recordDecision",
  );
  assert.ok(
    decide.includes("Dispute rejected — the deduction stands as it was charged"),
    "rejecting after an accept re-charges the deduction; otherwise the employee is told it stands " +
      "while payroll charges nothing and the earlier refund stays live",
  );
  assert.ok(
    decide.includes('events.find((event) => event.eventType === "decided")'),
    "and it restores from the FIRST decision's own event — the only record of what this deduction " +
      "charged before the dispute touched it, since the decision row is overwritten each time",
  );

  // Half a decision must never pass as a whole one (F-PAY-005): a failure after the first write puts
  // the whole before-state back, and where even that fails the case is marked, never left reading open.
  // The behaviour itself is pinned by tests/dispute-and-deduction-atomic.test.ts.
  assert.ok(
    decide.includes("Everything it had started to change was put back") &&
      decide.includes("could NOT be put back") &&
      decide.includes('eventType: "decision_interrupted"'),
    "a failed decision after a successful write is undone, or reported as the state it leaves behind",
  );

  // One live refund per case is a database rule, and a PAID one cannot be cancelled to make room.
  assert.ok(
    /if \(replaced\.alreadyPaid\)/.test(refundsLib) && /refund: null,/.test(refundsLib),
    "recommending over a refund that was already paid answers with no refund and a sentence — it " +
      "used to discard cancelLiveRefund's answer and raise a 23505 after the money had moved",
  );
  assert.ok(
    decide.includes("if (recommended.refund) refundSentence = recommended.sentence;") &&
      decide.includes("else payrollNotices.push(recommended.sentence);"),
    "…and that sentence reaches HR as something to settle, never the employee as money on the way",
  );

  // ---- Pictures: the storage key never carries a file name -----------------------------------------
  const path = buildDisputeCenterAttachmentPath({
    attachmentId: "11111111-2222-3333-4444-555555555555",
    caseKind: "calendar",
    caseRef: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    contentType: "image/jpeg",
  });
  assert.equal(
    path,
    "calendar/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/11111111-2222-3333-4444-555555555555.jpg",
    "a picture is keyed on its case and its own uuid, so an uploaded name can never collide or traverse",
  );
  assert.equal(
    buildDisputeCenterAttachmentPath({
      attachmentId: "../../etc/passwd",
      caseKind: "digest",
      caseRef: "4821",
      contentType: "image/png",
    }),
    "digest/4821/etcpasswd.png",
    "anything that is not a letter, a digit or a hyphen is stripped — a traversal cannot survive it",
  );
  assert.throws(
    () => buildDisputeCenterAttachmentPath({ attachmentId: "", caseKind: "calendar", caseRef: "x", contentType: "image/png" }),
    /without the dispute it belongs to/,
    "a picture with no id is refused rather than written to a guessable key",
  );
  assert.throws(
    () =>
      buildDisputeCenterAttachmentPath({
        attachmentId: "abc",
        caseKind: "deduction" as unknown as "calendar",
        caseRef: "x",
        contentType: "image/png",
      }),
    /unknown kind of dispute/,
    "deduction pictures keep their own store — they must never be written into this one",
  );
  assert.equal(
    disputeCenterAttachmentUrl("11111111-2222-3333-4444-555555555555"),
    "/api/dispute-center/attachments/11111111-2222-3333-4444-555555555555",
    "a picture is served through the route that checks who is asking, never a storage link",
  );
  assert.ok(DISPUTE_ATTACHMENT_MAX_FILES > 0, "a message can carry pictures at all");
  // Every uploaded picture is sniffed by the ONE rule the deductions module already uses, where the
  // request is read — so a file refused on one dispute screen can never be accepted on another.
  const http = readFileSync("src/lib/dispute-center/http.ts", "utf8");
  assert.ok(
    http.includes("checkDisputeImage({ bytes: new Uint8Array(await file.arrayBuffer()), name: file.name })"),
    "a picture is checked as it is read off the request, by the shared sniffing rule",
  );
  assert.ok(
    http.includes("DISPUTE_ATTACHMENT_MAX_FILES"),
    "…and a message cannot carry more pictures than the rule allows",
  );
}
