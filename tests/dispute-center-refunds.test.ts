import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { disputeRefundsByCompact, type DisputeRefundRow } from "../src/lib/automated-payroll/dispute-refunds.ts";
import { recommendAdditions, type PopulationMember } from "../src/lib/automated-payroll/recommend.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";
import {
  buildDisputeCenterAttachmentPath,
  disputeCenterAttachmentUrl,
  DISPUTE_ATTACHMENT_MAX_FILES,
} from "../src/lib/dispute-center/attachment-rules.ts";

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
    ["B77", { employeeHrIdCompact: "B77", otherAdditions: 0, additionsReason: null } as DraftRow],
  ]);
  const [overridden] = recommendAdditions([member("B-77", "B77")], saved, new Map(), refunds);
  assert.equal(overridden?.values.otherAdditions, 0, "a figure HR saved is never overwritten by a refund row");
  assert.equal(overridden?.recommended.otherAdditions, 420.5, "but the recommendation still shows what was owed");
  assert.equal(overridden?.reason, null, "and the refund's reason is not attached to HR's different figure");

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
