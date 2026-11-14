import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  approvalIdentity,
  approvalModules,
  approvalStampForTest,
  type ApprovalIdentity,
} from "../src/lib/approvals/raise-approval.ts";
import { isPhoenixCrmApprovalNotice } from "../src/lib/phoenix-crm/server/notifications.ts";

// ─────────────────────────────────────────────────────────────────────────────
// ONE WAY FOR A MODULE TO RAISE AN APPROVAL (enterprise audit REC-032, 14 Nov 2026).
// Every "a decision is waiting for you", "moved to the next step" and "approved / rejected / returned"
// notice goes through raiseApproval (src/lib/approvals/raise-approval.ts). The owner chose "Same notices
// only": the door changes nobody's notices — it hands the caller's own notice to the same sender and adds
// an `approval` tag to its metadata. This test pins three things:
//   1. the tag is metadata only, so no notice's event key (its de-duplication) changes;
//   2. how a status or event name is read into { step, decision } — `not_renewed` is a refusal;
//   3. each module's approval notifier sends through the door, never straight to the engine or an email.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

// The engine and email senders an approval notice must not call except through the door.
const SENDER = /\b(createSystemNotificationForRecipients|createSystemNotification|sendDurableEmail|sendTemplatedEmail|sendPhoenixEmail)\(/g;

/** Calls of a sender that are NOT the door's own `send: () => …` thunk, and not an import or a declaration. */
function directSends(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SENDER)) {
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    if (/send: \(\) => (?:await )?$/.test(before)) continue; // the door's direct-email form
    if (/function\s+$/.test(before)) continue;
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const line = source.slice(lineStart, source.indexOf("\n", match.index));
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    found.push(line.trim());
  }
  return found;
}

// Every file whose approval notices were moved onto the door, with the sends in it that are NOT approvals
// and so rightly stay direct. A new direct send in one of these files fails here: route it through
// raiseApproval if it is an approval, or add it below, named, if it is not.
const DOOR_FILES: Array<{ file: string; minDoor: number; notApprovals: number; why?: string }> = [
  { file: "src/lib/contracts/service.ts", minDoor: 1, notApprovals: 0 },
  { file: "src/lib/direct-orders/approved-email.ts", minDoor: 1, notApprovals: 0 },
  { file: "src/lib/direct-orders/service.ts", minDoor: 1, notApprovals: 0 },
  { file: "src/lib/early-birds/notify.ts", minDoor: 1, notApprovals: 0 },
  { file: "src/lib/excuses/service.ts", minDoor: 4, notApprovals: 0 },
  { file: "src/lib/market-awareness/notifications.ts", minDoor: 4, notApprovals: 0 },
  { file: "src/lib/marketing-requests/ceo-approvals-email-service.ts", minDoor: 2, notApprovals: 0 },
  { file: "src/lib/marketing-requests/service.ts", minDoor: 2, notApprovals: 0 },
  { file: "src/lib/offers/approval.ts", minDoor: 2, notApprovals: 0 },
  { file: "src/lib/outstation/service.ts", minDoor: 3, notApprovals: 1, why: "the departure-photo reminder" },
  { file: "src/lib/phoenix-crm/server/notifications.ts", minDoor: 1, notApprovals: 1, why: "the CRM notices that are not approvals (day start, first visit)" },
  { file: "src/lib/phoenix-crm/server/validation-reviews.ts", minDoor: 1, notApprovals: 0 },
  { file: "src/lib/probation/service.ts", minDoor: 1, notApprovals: 0 },
  { file: "src/lib/resignations/service.ts", minDoor: 2, notApprovals: 0 },
  { file: "src/lib/vacation/email.ts", minDoor: 8, notApprovals: 2, why: "the leave balance settlement email and its fallback" },
  { file: "src/lib/vacation/service.ts", minDoor: 4, notApprovals: 0 },
  { file: "src/lib/weekly-planning/service.ts", minDoor: 1, notApprovals: 0 },
];

export async function runApprovalsOneDoorTests() {
  // 1. The stamp is metadata only — everything the event key is made of is untouched.
  const notice = {
    actionUrl: "/hr/contracts/1",
    actorId: "B-10",
    eventType: "contract.workflow_updated",
    metadata: { idempotencyKey: "contract:1:hr_review", recordId: "1" },
    module: "contracts",
    recipientHrId: "A-1",
    title: "Contract waiting for review",
  };
  const identity: ApprovalIdentity = { module: "contract", step: "waiting" };
  const stamped = approvalStampForTest(notice, identity);
  for (const key of ["actionUrl", "actorId", "eventType", "module", "recipientHrId", "title"] as const) {
    assert.equal(stamped[key], notice[key], `the approval stamp must not change ${key}, which the event key is made of`);
  }
  assert.equal(stamped.metadata.idempotencyKey, "contract:1:hr_review", "the stamp must keep the caller's idempotency key");
  assert.equal(stamped.metadata.recordId, "1", "the stamp must keep the caller's own metadata");
  assert.deepEqual(stamped.metadata.approval, { decision: null, module: "contract", step: "waiting" });
  assert.equal(notice.metadata.idempotencyKey, "contract:1:hr_review");
  assert.equal("approval" in notice.metadata, false, "the stamp must not mutate the caller's notice");

  const system = read("src/lib/notifications/system.ts");
  const keyStart = system.indexOf("function eventKeyFor(");
  assert.notEqual(keyStart, -1, "eventKeyFor must still exist");
  const keyBody = system.slice(keyStart, system.indexOf("\n}\n", keyStart));
  assert.deepEqual(
    [...keyBody.matchAll(/metadata\??\.(\w+)/g)].map((m) => m[1]).filter((k, i, a) => a.indexOf(k) === i),
    ["idempotencyKey"],
    "eventKeyFor may read only metadata.idempotencyKey — reading metadata.approval would merge or split notices",
  );

  // 2. Reading a status or event name.
  const cases: Array<[string, Partial<ApprovalIdentity>]> = [
    ["hr_review", { step: "waiting" }],
    ["submitted", { step: "waiting" }],
    ["vacation.pending_manager", { step: "waiting" }],
    ["plan_manager_approved", { decision: "approved", step: "decided" }],
    ["renewed", { decision: "approved", step: "decided" }],
    ["not_renewed", { decision: "rejected", step: "decided" }],
    ["rejected", { decision: "rejected", step: "decided" }],
    ["declined", { decision: "rejected", step: "decided" }],
    ["withdrawn", { decision: "cancelled", step: "decided" }],
    ["returned", { decision: "returned", step: "returned" }],
    ["details_requested", { decision: "returned", step: "returned" }],
    ["acknowledged", { decision: "acknowledged", step: "decided" }],
    ["sla_reminder", { step: "reminder" }],
    ["overdue", { step: "reminder" }],
    ["informed", { step: "fyi" }],
    ["", { step: "fyi" }],
  ];
  for (const [signal, want] of cases) {
    const got = approvalIdentity("leave", signal);
    assert.equal(got.module, "leave");
    assert.equal(got.step, want.step, `"${signal}" must read as step ${want.step}`);
    assert.equal(got.decision ?? undefined, want.decision, `"${signal}" must read as decision ${want.decision ?? "none"}`);
  }
  assert.equal(approvalIdentity("contract", null).step, "fyi");
  assert.equal(new Set(approvalModules).size, approvalModules.length, "approval modules are listed once each");

  // 3. Each module's approval notices go through the door.
  for (const { file, minDoor, notApprovals, why } of DOOR_FILES) {
    const source = read(file);
    assert.match(source, /from "@\/lib\/approvals\/raise-approval"/, `${file} must import the approvals door`);
    const door = (source.match(/raiseApproval\(/g) ?? []).length;
    assert.ok(door >= minDoor, `${file} must send its ${minDoor} approval notice(s) through raiseApproval (found ${door})`);
    const direct = directSends(source);
    assert.equal(
      direct.length,
      notApprovals,
      `${file} must send approvals only through raiseApproval; direct sends found:\n  ${direct.join("\n  ")}` +
        (why ? `\n(the ${notApprovals} allowed: ${why})` : ""),
    );
  }

  // Phoenix CRM: the notices that ask for, answer or return a decision are approvals; the rest are not.
  for (const kind of ["plan_submitted", "plan_decided", "request_created", "request_returned", "unplanned_visit_raised", "visit_ask"] as const) {
    assert.equal(isPhoenixCrmApprovalNotice(kind), true, `the CRM "${kind}" notice is an approval`);
  }
  for (const kind of ["day_start", "first_visit", "forecast_sent", "rep_plan"] as const) {
    assert.equal(isPhoenixCrmApprovalNotice(kind), false, `the CRM "${kind}" notice is not an approval`);
  }
  const crm = read("src/lib/phoenix-crm/server/notifications.ts");
  assert.equal((crm.match(/await sendPhoenixCrmDelivery\(\n\s*notice,/g) ?? []).length, 2, "both CRM sends (real and test mirror) go through sendPhoenixCrmDelivery");
}
