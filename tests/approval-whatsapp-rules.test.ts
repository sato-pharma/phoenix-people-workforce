import assert from "node:assert/strict";

import { systemDeployment } from "../src/config/system-settings.ts";
import {
  APPROVAL_REMINDER_OPEN_URL,
  APPROVAL_REMINDER_TEMPLATE_BODY,
  approvalReminderStatusPatch,
  cairoReminderDay,
  reminderLockReason,
  reminderTemplateRefusal,
  reminderTimeRefusal,
  tallyApprovers,
  waitingDirectOrderItems,
  waitingExcuseItems,
  waitingLeaveItems,
  waitingMarketingItems,
  type ApproverLoginRow,
  type ApproverPersonRow,
  type DirectStepRow,
  type LeaveStepRow,
  type MarketingStepRow,
  type WaitingApprovalItem,
} from "../src/lib/approvals/urgent-whatsapp-rules.ts";

const NOW = new Date("2026-11-03T08:11:00.000Z");

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function leaveStep(request_id: string, step_key: string, step_order: number, status: string, approver_hr_id: string, reachedHoursAgo: number, decidedHoursAgo: number | null = null): LeaveStepRow {
  return { approver_hr_id, decided_at: decidedHoursAgo === null ? null : hoursAgo(decidedHoursAgo), request_id, status, step_key, step_order, updated_at: hoursAgo(reachedHoursAgo) };
}

function directStep(request_id: string, step_order: number, status: string, who: { hr?: string; role?: string }, reachedHoursAgo: number, decidedHoursAgo: number | null = null): DirectStepRow {
  return {
    approver_hr_id: who.hr ?? null,
    approver_kind: who.role ? "role" : "person",
    approver_role: who.role ?? null,
    decided_at: decidedHoursAgo === null ? null : hoursAgo(decidedHoursAgo),
    request_id,
    status,
    step_order,
    updated_at: hoursAgo(reachedHoursAgo),
  };
}

const PEOPLE: ApproverPersonRow[] = [
  { active: true, hrId: "A-1", mobileNumber: "01012345678" },
  { active: true, hrId: "A-2", mobileNumber: "01112345678" },
  { active: true, hrId: "CEO-1", mobileNumber: "01212345678" },
  { active: true, hrId: "SFE-1", mobileNumber: "01512345678" },
  { active: true, hrId: "SFE-2", mobileNumber: "01512345679" },
  { active: false, hrId: "GONE-1", mobileNumber: "01012345670" },
  { active: true, hrId: "B-10", mobileNumber: "01012345671" },
  { active: true, hrId: "NO-LOGIN", mobileNumber: "01012345672" },
  { active: true, hrId: "NO-NUMBER", mobileNumber: "not a number" },
  { active: true, hrId: "DM-1", mobileNumber: "01012345673" },
];

const LOGINS: ApproverLoginRow[] = [
  { hrId: "a-1", isActive: true, role: "Group Product Manager" },
  { hrId: "A-2", isActive: true, role: "National Sales Manager" },
  { hrId: "CEO-1", isActive: true, role: "CEO" },
  { hrId: "SFE-1", isActive: true, role: "SFE Manager" },
  { hrId: "SFE-2", isActive: true, role: "SFE Manager" },
  { hrId: "GONE-1", isActive: true, role: "National Sales Manager" },
  { hrId: "B-10", isActive: true, role: "Super Admin" },
  { hrId: "PHX-1", isActive: true, role: "Super Admin" },
  { hrId: "NO-NUMBER", isActive: true, role: "National Sales Manager" },
  { hrId: "DM-1", isActive: true, role: "District Manager" },
];

function tally(items: WaitingApprovalItem[]) {
  return tallyApprovers({
    items,
    logins: LOGINS,
    now: NOW,
    people: PEOPLE,
    roleCanDecideExcuse: (role) => role !== "District Manager" && role !== "Regional Manager",
  });
}

const item = (over: Partial<WaitingApprovalItem>): WaitingApprovalItem => ({
  approverHrId: "A-1",
  approverRole: null,
  chain: "leave",
  reachedAt: hoursAgo(100),
  requestId: "r",
  ...over,
});

function testTemplateWords() {
  assert.equal(APPROVAL_REMINDER_OPEN_URL, `${systemDeployment.productionUrl}/`, "the link in the message is the production address");
  assert.ok(APPROVAL_REMINDER_TEMPLATE_BODY.includes(APPROVAL_REMINDER_OPEN_URL), "and the message carries it");
  assert.ok(APPROVAL_REMINDER_TEMPLATE_BODY.includes("{{count}}"), "the one blank is the count");
  assert.equal(APPROVAL_REMINDER_TEMPLATE_BODY.match(/\{\{/gu)?.length, 1, "no name, no reason and no other blank can reach the message");
  assert.ok(!/approvals waiting \{\{count\}\}|have \{\{count\}\} approvals/u.test(APPROVAL_REMINDER_TEMPLATE_BODY), "the sentence reads correctly for a count of one");
  assert.ok(APPROVAL_REMINDER_TEMPLATE_BODY.endsWith("This number does not read replies."), "it says nobody reads this number");
}

function testLeaveCountsOnlyTheStepThatCanDecideNow() {
  const parents = [{ id: "open", status: "pending_manager" }];
  const steps = [
    leaveStep("open", "direct_manager", 1, "pending", "A-1", 200),
    leaveStep("open", "manager_of_manager", 2, "pending", "A-2", 200),
    leaveStep("open", "hr", 3, "pending", "B-10", 200),
  ];
  const items = waitingLeaveItems(parents, steps);
  assert.deepEqual(items.map((row) => row.approverHrId), ["A-1"], "a later rung and the HR step read pending too, and neither can decide yet");

  const handedOn = waitingLeaveItems(parents, [
    leaveStep("open", "direct_manager", 1, "approved", "A-1", 200, 10),
    leaveStep("open", "manager_of_manager", 2, "pending", "A-2", 200),
    leaveStep("open", "hr", 3, "pending", "B-10", 200),
  ]);
  assert.deepEqual(handedOn.map((row) => row.approverHrId), ["A-2"], "the first yes moves it to the second rung");
  assert.equal(handedOn[0]?.reachedAt, hoursAgo(10), "and the clock starts at that yes, not at the raise");

  const atHr = waitingLeaveItems([{ id: "open", status: "pending_hr" }], [
    leaveStep("open", "direct_manager", 1, "approved", "A-1", 200, 150),
    leaveStep("open", "manager_of_manager", 2, "approved", "A-2", 200, 90),
    leaveStep("open", "hr", 3, "pending", "B-10", 200),
  ]);
  assert.deepEqual(atHr.map((row) => row.approverHrId), ["B-10"], "HR is reached only after every management step");
  assert.equal(atHr[0]?.reachedAt, hoursAgo(90));
}

function testDeadRowsNeverCount() {
  const steps = [leaveStep("dead", "hr", 3, "pending", "B-10", 500), leaveStep("dead", "manager_of_manager", 2, "pending", "A-2", 500)];
  for (const status of ["rejected", "cancelled", "approved", "returned"]) {
    assert.deepEqual(waitingLeaveItems([{ id: "dead", status }], steps), [], `leave ${status}: leftover pending steps are nobody's to decide`);
  }

  const marketing: MarketingStepRow[] = [{ assigned_hr_id: "A-1", is_cc: false, request_id: "dead", status: "current", updated_at: hoursAgo(500) }];
  for (const status of ["rejected", "returned", "active", "finance_hold", "cancelled"]) {
    assert.deepEqual(waitingMarketingItems([{ id: "dead", status }], marketing), [], `marketing ${status}`);
  }

  const direct = [directStep("dead", 1, "pending", { role: "CEO" }, 500)];
  for (const status of ["rejected", "returned", "cancelled", "held", "approved"]) {
    assert.deepEqual(waitingDirectOrderItems([{ id: "dead", status }], direct), [], `direct order ${status}`);
  }

  assert.deepEqual(
    waitingExcuseItems([{ created_at: hoursAgo(500), id: "dead", manager_hr_id: "A-1", status: "rejected", updated_at: hoursAgo(500) }]),
    [],
    "excuse rejected",
  );
}

function testMarketingAndDirectOrders() {
  const marketing = waitingMarketingItems([{ id: "m", status: "pending_approval" }], [
    { assigned_hr_id: "A-1", is_cc: false, request_id: "m", status: "current", updated_at: hoursAgo(80) },
    { assigned_hr_id: "A-2", is_cc: false, request_id: "m", status: "pending", updated_at: hoursAgo(300) },
    { assigned_hr_id: "CEO-1", is_cc: true, request_id: "m", status: "current", updated_at: hoursAgo(300) },
  ]);
  assert.deepEqual(marketing.map((row) => row.approverHrId), ["A-1"], "a later rung and a CC step hold nothing");
  assert.equal(marketing[0]?.reachedAt, hoursAgo(80));

  const direct = waitingDirectOrderItems([{ id: "d", status: "pending_approval" }], [
    directStep("d", 1, "approved", { role: "SFE Manager" }, 300, 90),
    directStep("d", 2, "pending", { hr: "A-1" }, 300),
    directStep("d", 3, "pending", { role: "CEO" }, 300),
  ]);
  assert.deepEqual(direct.map((row) => row.approverHrId), ["A-1"], "only the lowest pending rung");
  assert.equal(direct[0]?.reachedAt, hoursAgo(90), "counted from the rung before it");

  const roleRung = waitingDirectOrderItems([{ id: "d", status: "pending_approval" }], [directStep("d", 1, "pending", { role: "SFE Manager" }, 100)]);
  const told = tally(roleRung);
  assert.deepEqual(told.due.map((row) => row.hrId), ["SFE-1", "SFE-2"], "a role rung reaches everyone who holds the role");
  assert.ok(!told.due.some((row) => row.hrId === "B-10"), "the Super Admin can decide any rung, but is not nagged about every rung");

  const open = waitingMarketingItems([{ id: "lost", status: "pending_approval" }], []);
  assert.equal(tally(open).unaddressed, 1, "an open request with no step is counted, never dropped");
}

function testTheThreeDayClock() {
  assert.equal(tally([item({ reachedAt: hoursAgo(72) })]).due.length, 0, "exactly three days is not more than three days");
  assert.equal(tally([item({ reachedAt: hoursAgo(72) })]).notYetDue, 1);
  assert.equal(tally([item({ reachedAt: hoursAgo(72.01) })]).due.length, 1, "just past three days counts");
  assert.equal(tally([item({ reachedAt: null })]).unaddressed, 1, "no date is counted, never dropped");
  assert.equal(tally([item({ reachedAt: "garbage" })]).unaddressed, 1);
}

function testWhoCanBeTold() {
  assert.equal(tally([item({ approverHrId: "GONE-1" })]).due.length, 0, "a departed approver never counts");
  assert.equal(tally([item({ approverHrId: "GONE-1" })]).unaddressed, 1, "and the request is counted as nobody told");
  assert.equal(tally([item({ approverHrId: "NOT-IN-MASTER" })]).unaddressed, 1, "nor someone the employee master does not hold");
  assert.equal(tally([item({ approverHrId: "NO-LOGIN" })]).unaddressed, 1, "nor someone who cannot sign in to decide it");
  assert.equal(tally([item({ approverHrId: null })]).unaddressed, 1, "a step naming nobody");

  const excuse = item({ approverHrId: "DM-1", chain: "excuse" });
  assert.equal(tally([excuse]).unaddressed, 1, "a District Manager has no excuse authority, so a legacy row is not theirs to be told about");
  assert.equal(tally([item({ approverHrId: "DM-1" })]).due.length, 1, "while their leave step still counts");

  const noNumber = tally([item({ approverHrId: "NO-NUMBER" })]);
  assert.equal(noNumber.due.length, 1, "no readable number is still due");
  assert.equal(noNumber.due[0]?.waId, null, "so the run can record it rather than skip it");

  const zero = tallyApprovers({ items: [item({})], logins: LOGINS, now: NOW, people: [{ active: true, hrId: "A-1", mobileNumber: "1012345678" }], roleCanDecideExcuse: () => true });
  assert.equal(zero.due[0]?.waId, "201012345678", "a number that lost its leading zero is repaired");
}

function testOnePersonOneRow() {
  const result = tally([
    item({ approverHrId: "A-1", chain: "leave", requestId: "1" }),
    item({ approverHrId: "a-1", chain: "marketing", requestId: "2" }),
    item({ approverHrId: "A-1", chain: "marketing", requestId: "3" }),
    item({ approverHrId: "PHX-1", chain: "direct_order", requestId: "4" }),
    item({ approverHrId: "b-10", chain: "leave", requestId: "5" }),
  ]);
  assert.deepEqual(
    result.due.map((row) => [row.hrId, row.total]),
    [["A-1", 3], ["B-10", 2]],
    "case and the console alias are one person with one message",
  );
  assert.deepEqual(result.due[0]?.counts, { direct_order: 0, excuse: 0, leave: 1, marketing: 2 });
  assert.equal(tally([item({ approverHrId: null, approverRole: "Super Admin" })]).due[0]?.total, 1, "two logins for one person count one item once");
}

function testTheMorningWindow() {
  assert.equal(reminderTimeRefusal(NOW), null, "Tuesday 10:11 Cairo");
  assert.equal(reminderTimeRefusal(new Date("2026-11-08T08:11:00.000Z")), null, "Sunday is a working day");
  assert.ok(reminderTimeRefusal(new Date("2026-11-06T08:11:00.000Z")), "Friday");
  assert.ok(reminderTimeRefusal(new Date("2026-11-07T08:11:00.000Z")), "Saturday");
  assert.ok(reminderTimeRefusal(new Date("2026-11-03T07:59:00.000Z")), "09:59 Cairo");
  assert.ok(reminderTimeRefusal(new Date("2026-11-03T10:00:00.000Z")), "12:00 Cairo");
  assert.equal(cairoReminderDay(new Date("2026-11-03T22:30:00.000Z")), "2026-11-04", "the day is Cairo's, not UTC's");
}

function testTheLocks() {
  assert.equal(reminderLockReason({ lineConfigured: true, production: true, switchOn: true }), null);
  assert.ok(reminderLockReason({ lineConfigured: true, production: true, switchOn: false })?.includes("switch"));
  assert.ok(reminderLockReason({ lineConfigured: true, production: false, switchOn: true })?.includes("production"));
  assert.ok(reminderLockReason({ lineConfigured: false, production: true, switchOn: true })?.includes("number"));
  assert.equal(reminderTemplateRefusal("approved"), null);
  for (const status of ["missing", "pending", "rejected"] as const) assert.ok(reminderTemplateRefusal(status), status);
}

function testDeliveryTicks() {
  assert.deepEqual(approvalReminderStatusPatch({ errorCode: null, status: "delivered", wamid: "w" })?.from, ["accepted"], "a late delivered tick cannot overwrite read or failed");
  assert.deepEqual(approvalReminderStatusPatch({ errorCode: null, status: "read", wamid: "w" })?.from, ["accepted", "delivered"]);
  const failed = approvalReminderStatusPatch({ errorCode: "131026", status: "failed", wamid: "w" });
  assert.equal(failed?.status, "failed", "a number not on WhatsApp fails after Meta accepted it");
  assert.ok(failed?.failureReason?.includes("131026"));
  assert.equal(approvalReminderStatusPatch({ errorCode: null, status: "sent", wamid: "w" }), null, "sent adds nothing to accepted");
}

export async function runApprovalWhatsAppRulesTests() {
  testTemplateWords();
  testLeaveCountsOnlyTheStepThatCanDecideNow();
  testDeadRowsNeverCount();
  testMarketingAndDirectOrders();
  testTheThreeDayClock();
  testWhoCanBeTold();
  testOnePersonOneRow();
  testTheMorningWindow();
  testTheLocks();
  testDeliveryTicks();
}
