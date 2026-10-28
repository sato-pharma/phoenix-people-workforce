import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sickLeaveTurnForViewer } from "../src/lib/vacation/approval-flow.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * 2026-10-28: a sick leave filed on 27 Oct (Mahmoud ElHassanin, CNS) could not be found in HR's
 * approvals list, and one filed on 3 Oct had sat there unseen for 25 days. Sick leave runs on the
 * legacy PARALLEL flow — the managers and HR decide side by side and the status stays
 * `pending_manager` until the last of them does — but the hub read HR's turn as `pending_hr`, a
 * status a sick leave never reaches. Its detail page was read-only for the same reason, so even the
 * direct link had nothing to press.
 *
 * The turn is now read from the pending approval steps by the rule the server applies when the
 * decision is posted. The rule is pure and driven here; the wiring is pinned at source level, since
 * this suite runs with production credentials and driving the hub would read live leave requests.
 */
export function runSickLeaveReachesHrApprovalsTests() {
  // ── The rule ────────────────────────────────────────────────────────────────
  const managerPending = { matchesViewer: false, stepKey: "direct_manager" as const };
  const hrPendingOther = { matchesViewer: false, stepKey: "hr" as const };

  assert.equal(
    sickLeaveTurnForViewer({ isHrActor: true, pendingSteps: [managerPending, hrPendingOther] }),
    "hr",
    "HR sees a sick leave the day it is filed — the manager's step still pending does not hide HR's",
  );
  assert.equal(
    sickLeaveTurnForViewer({ isHrActor: true, pendingSteps: [{ matchesViewer: false, stepKey: "manager_of_manager" }, hrPendingOther] }),
    "hr",
    "the 3 Oct case: direct manager done, manager's manager and HR still pending — HR's turn",
  );
  assert.equal(
    sickLeaveTurnForViewer({ isHrActor: true, pendingSteps: [managerPending] }),
    null,
    "once HR has decided (no pending HR step), it is no longer HR's to decide",
  );
  assert.equal(
    sickLeaveTurnForViewer({ isHrActor: false, pendingSteps: [{ matchesViewer: true, stepKey: "direct_manager" }, hrPendingOther] }),
    "management",
    "the direct manager's own pending step is a management turn",
  );
  assert.equal(
    sickLeaveTurnForViewer({ isHrActor: false, pendingSteps: [{ matchesViewer: true, stepKey: "manager_of_manager" }, hrPendingOther] }),
    "management",
    "the manager's manager decides a sick leave too — the old check looked only at the direct manager",
  );
  assert.equal(
    sickLeaveTurnForViewer({ isHrActor: false, pendingSteps: [managerPending, hrPendingOther] }),
    null,
    "a manager with no pending step of their own has no turn, and a non-HR viewer never takes HR's step",
  );
  assert.equal(
    sickLeaveTurnForViewer({ isHrActor: true, pendingSteps: [{ matchesViewer: true, stepKey: "direct_manager" }, hrPendingOther] }),
    "management",
    "an HR actor who is also the direct manager decides as the manager first, as the server does",
  );

  // ── The wiring ──────────────────────────────────────────────────────────────
  const HUB = "src/lib/approvals-hub/service.ts";
  const hub = stripComments(readFileSync(new URL(`../${HUB}`, import.meta.url), "utf8"));
  const bodyOf = (signature: string) => {
    const start = hub.indexOf(signature);
    assert.ok(start >= 0, `${signature} not found in ${HUB}`);
    const end = hub.indexOf("\n}\n", start);
    return hub.slice(start, end < 0 ? undefined : end);
  };

  const partition = bodyOf("async function partitionVacationApprovals(");
  assert.ok(
    partition.includes("getSickLeaveTurnsForViewer(access, sickCandidates)"),
    "the list and the badge read the sick-leave turn from the pending steps",
  );
  assert.ok(
    !/status\s*===\s*"pending_hr"/.test(partition),
    "a sick leave never reaches pending_hr — reading HR's turn from it hid every sick leave from HR",
  );

  const detail = bodyOf("export async function getVacationApprovalDetail(");
  assert.ok(
    /getSickLeaveTurnsForViewer\(access, \[record\]\)/.test(detail),
    "the detail page asks whose turn the sick leave is before falling to read-only",
  );
  assert.ok(
    detail.indexOf("getSickLeaveTurnsForViewer(") < detail.indexOf("readOnlyReasonForStatus("),
    "the sick-leave turn is decided before the read-only branch",
  );
}
