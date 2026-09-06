import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  canReopenRejectedMarketingRequest,
  isMarketingRequestReopenable,
  isRungClosedOutByRefusal,
  viewerMayReopenMarketingRequests,
} from "../src/lib/marketing-requests/reopen-rule.ts";
import { reopenRejectedMarketingRequest } from "../src/lib/marketing-requests/service.ts";

// Reopening a REFUSED marketing request. Until 2026-09-06 `rejected` was terminal and the only way
// back was hand-written SQL against production, which is what the owner asked to be replaced with a
// button. These assertions cover the two things that make it safe rather than merely possible:
// who may press it, and which `skipped` rungs a reopen is allowed to restore.

const SOME_REQUEST_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Every role that must NOT be able to reopen. CEO is deliberately in this list and is the one worth
 * arguing with: the CEO seat is who REFUSES at `ceo_approval`, so "the person who rejected it can
 * undo it" is the intuitive rule — and it is not the rule the owner chose. He said, 2026-09-06,
 * "the reopen is only a super admin feature". If this line is ever relaxed it must be by his
 * decision, not by someone restoring symmetry.
 */
const NON_REOPEN_ROLES = [
  "CEO",
  "Employee",
  "Medical Rep",
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Marketing Manager",
  "Finance Manager",
  "SFE Manager",
  "Training Manager",
  "HR Advisory",
  "HR Operations",
  "Manager",
] as const;

function roleOf(role: string) {
  return createAccessContext({ hrId: "TEST-1", role }).role;
}

function testOnlySuperAdminMayReopen() {
  assert.equal(viewerMayReopenMarketingRequests(roleOf("Super Admin")), true, "Super Admin may reopen");
  for (const role of NON_REOPEN_ROLES) {
    assert.equal(
      viewerMayReopenMarketingRequests(roleOf(role)),
      false,
      `${role} must not be able to reopen a refused marketing request`,
    );
  }
}

function testOnlyARefusalIsReopenable() {
  assert.equal(isMarketingRequestReopenable("rejected"), true, "a refusal is reopenable");
  // `returned` has its own way home (resubmitReturnedMarketingRequest, requester-driven, after an
  // edit). Routing it through reopen would skip the edit entirely.
  for (const status of ["returned", "pending_approval", "pending_validation", "approved", "active", "draft", "closed", "finance_hold", "archived", "", null, undefined]) {
    assert.equal(isMarketingRequestReopenable(status), false, `${String(status)} must not be reopenable`);
  }
}

function testTheAffordanceNeedsBothHalves() {
  assert.equal(
    canReopenRejectedMarketingRequest({ role: roleOf("Super Admin"), status: "rejected" }),
    true,
    "Super Admin + rejected is the one case that draws the control",
  );
  assert.equal(
    canReopenRejectedMarketingRequest({ role: roleOf("Super Admin"), status: "approved" }),
    false,
    "an approved request offers no reopen, even to a Super Admin",
  );
  assert.equal(
    canReopenRejectedMarketingRequest({ role: roleOf("CEO"), status: "rejected" }),
    false,
    "the CEO refuses requests but does not reopen them",
  );
}

/**
 * The trap this whole test file exists for.
 *
 * `skipped` means three different things on `marketing_request_approval_steps`, and restoring the
 * wrong one is not cosmetic — a self-approval rung put back to `pending` becomes the current rung
 * whose only holder is the one person `phx_decide_marketing_request_step` refuses to let decide it,
 * so the request is stranded with no legal next move.
 */
function testOnlyRefusalClosedRungsAreRestored() {
  assert.equal(
    isRungClosedOutByRefusal({ decisionNote: null, isCc: false, status: "skipped" }),
    true,
    "a rung the refusal closed out carries no note and must come back",
  );
  assert.equal(
    isRungClosedOutByRefusal({
      decisionNote: "Skipped automatically: the assigned approver raised this request, and nobody approves their own spend.",
      isCc: false,
      status: "skipped",
    }),
    false,
    "a self-approval rung must stay skipped — restoring it strands the request forever",
  );
  assert.equal(
    isRungClosedOutByRefusal({ decisionNote: null, isCc: true, status: "skipped" }),
    false,
    "a CC row is never a gate and is never restored",
  );
  assert.equal(
    isRungClosedOutByRefusal({ decisionNote: null, isCc: false, status: "pending" }),
    false,
    "a rung that is already pending is not a restore candidate",
  );
  assert.equal(
    isRungClosedOutByRefusal({ decisionNote: "  ", isCc: false, status: "skipped" }),
    true,
    "a whitespace-only note is not a note",
  );
}

/**
 * The SQL does the restore, so the executable predicate above is a second copy of the rule. This
 * pins them together: if the migration ever loses the `decision_note` filter, the self-approval
 * case silently starts being restored and only this assertion notices.
 */
function testTheSqlCarriesTheSameFilter() {
  const raw = readFileSync(
    new URL("../supabase/migrations/20260906120000_marketing_reopen_rejected_request.sql", import.meta.url),
    "utf8",
  );
  // Strip `--` comments FIRST, line by line. Without this these assertions pass on the file's own
  // PROSE: the header explains that the restore "filters on `decision_note is null`", so deleting
  // the real clause still left every match satisfied and the test green. Found by breaking it on
  // purpose — which is the only reason this comment exists rather than a false green.
  // `String.fromCharCode(10)` rather than a newline escape: this file is generated through a
  // shell heredoc, which eats the backslash and turns the escape into a real line break inside
  // the string literal — a syntax error that costs a debugging round trip every time.
  const nl = String.fromCharCode(10);
  const sql = raw
    .split(nl)
    .map((line) => (line.includes("--") ? line.slice(0, line.indexOf("--")) : line))
    .join(nl);

  // Isolate the RESTORE statement, so a filter present ELSEWHERE in the function cannot stand in
  // for one missing here.
  const from = sql.indexOf("status     = 'pending'");
  const to = sql.indexOf("get diagnostics v_restored");
  assert.ok(from > 0 && to > from, "the migration must still carry a restore statement setting rungs back to pending");
  const restore = sql.slice(from, to);

  assert.ok(
    restore.includes("decision_note is null"),
    "the restore must exclude self-approval rungs by their note, or reopening strands the request",
  );
  assert.ok(restore.includes("is_cc"), "the restore must exclude CC rows");
  assert.ok(restore.includes("'skipped'"), "the restore only touches skipped rungs");

  assert.ok(sql.includes("order  by sequence desc") || sql.includes("order by sequence desc"),
    "the reopened rung must be the LATEST refusal, not the first");
  assert.ok(sql.includes("marketing_reopen_reason_required"), "the RPC must refuse a reopen with no reason");
}

/** Real service function. Every one of these throws before any Supabase call, so no database. */
async function testServiceRefusesTheWrongCallers() {
  for (const role of NON_REOPEN_ROLES) {
    const access = createAccessContext({ hrId: "TEST-1", role });
    await assert.rejects(
      () => reopenRejectedMarketingRequest(access, { reason: "second look", requestId: SOME_REQUEST_ID }),
      /Forbidden/i,
      `${role} must not be able to reopen a refused marketing request through the service`,
    );
  }
}

async function testServiceRequiresAReason() {
  const access = createAccessContext({ hrId: "B-10", role: "Super Admin" });
  for (const reason of [null, "", "   "]) {
    await assert.rejects(
      () => reopenRejectedMarketingRequest(access, { reason, requestId: SOME_REQUEST_ID }),
      /reason is required/i,
      "a reopen with no reason must be refused — it is the only record of why a refusal was undone",
    );
  }
}

async function testServiceRequiresARequestId() {
  const access = createAccessContext({ hrId: "B-10", role: "Super Admin" });
  await assert.rejects(
    () => reopenRejectedMarketingRequest(access, { reason: "second look", requestId: "  " }),
    /Marketing request ID is required/i,
    "a reopen with no request id must be refused",
  );
}

export async function runMarketingReopenRejectedRequestTests() {
  testOnlySuperAdminMayReopen();
  testOnlyARefusalIsReopenable();
  testTheAffordanceNeedsBothHalves();
  testOnlyRefusalClosedRungsAreRestored();
  testTheSqlCarriesTheSameFilter();
  await testServiceRefusesTheWrongCallers();
  await testServiceRequiresAReason();
  await testServiceRequiresARequestId();
}
