import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { assertNotDecidingOwnRequest } from "@/lib/marketing-requests/service";
import type { MarketingRequest } from "@/lib/marketing-requests/types";

// ─────────────────────────────────────────────────────────────────────────────
// Nobody approves their own marketing spend.
//
// Production carries MKT-REQ-20260811-FF5B0719: raised by A-9 (Marketing Manager) with A-9 assigned
// to its own `marketing_review` rung. A role-resolved rung lands on whoever holds the role, and the
// requester can BE that person. A live count of the condition returned 1 of 2 requests, and nothing
// anywhere refused it.
//
// Three layers, and the test covers all three because each can fail independently:
//   1. the chain builder      — never opens a self-assigned rung (submit time)
//   2. the service guard      — tells the approver on the way IN, not after they decide
//   3. the decision RPC       — the real boundary; the chain is data and can drift
// ─────────────────────────────────────────────────────────────────────────────

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function migrationSource() {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith("_marketing_refuse_self_approval.sql"));
  assert.ok(file, "the self-approval migration must exist");
  return readFileSync(new URL(file, dir), "utf8");
}

function requestOf(requesterHrId: string): MarketingRequest {
  return { requesterHrId } as unknown as MarketingRequest;
}

export async function runMarketingSelfApprovalTests() {
  const serviceSource = source("src/lib/marketing-requests/service.ts");
  const sql = migrationSource().toLowerCase();

  /* ---------------------------------------------------------------------- */
  /* Layer 2 — the service guard, tested behaviourally                       */
  /* ---------------------------------------------------------------------- */

  assert.throws(
    () => assertNotDecidingOwnRequest(requestOf("A-9"), "A-9"),
    /you raised this marketing request/i,
    "the person who raised a request must not be able to decide it",
  );

  // employees(hr_id) is case-sensitive and this module has already shipped one FK bug over it —
  // `a-9` and `A-9` are the same human. A guard that misses on casing is not a guard.
  assert.throws(
    () => assertNotDecidingOwnRequest(requestOf("A-9"), "a-9"),
    /you raised this marketing request/i,
    "casing must not defeat the self-approval guard",
  );
  assert.throws(
    () => assertNotDecidingOwnRequest(requestOf(" a-9 "), "A-9"),
    /you raised this marketing request/i,
    "surrounding whitespace must not defeat the self-approval guard",
  );

  // And it must not over-block: a real approver deciding someone else's request is the normal path.
  assert.doesNotThrow(
    () => assertNotDecidingOwnRequest(requestOf("B-184"), "AA"),
    "a different person must still be able to decide the request",
  );

  // Wired into BOTH callers — the decision page and the decide path. Guarding only the write path
  // would still show the approver the buttons and fail after they had done the work.
  const guardCalls = (serviceSource.match(/assertNotDecidingOwnRequest\(request, actorHrId\)/g) ?? []).length;
  assert.equal(
    guardCalls,
    2,
    `the guard must run on both the decision summary and the decide path (found ${guardCalls})`,
  );

  /* ---------------------------------------------------------------------- */
  /* Layer 1 — the chain builder never opens a self-assigned rung            */
  /* ---------------------------------------------------------------------- */

  assert.match(
    serviceSource,
    /const isSelfApproval\s*=\s*\n?\s*!input\.isCc && normalizeHrId\(storedHrId\) === normalizeHrId\(params\.request\.requesterHrId\)/,
    "the chain builder must detect a rung that resolves to the requester",
  );
  assert.match(
    serviceSource,
    /status: input\.isCc \|\| isSelfApproval \? "skipped" : "pending"/,
    "a self-assigned rung must be materialised as skipped, not pending",
  );
  // Kept, not dropped: erasing the rung would hide that a gate ever existed.
  assert.match(
    serviceSource,
    /Skipped automatically: the assigned approver raised this request/,
    "a skipped self-approval rung must say WHY, so the chain does not show a silent gap",
  );
  // The first gating rung must skip over it, or the request opens on a rung nobody may decide.
  assert.match(
    serviceSource,
    /rows\.find\(\(row\) => row\.is_cc === false && row\.status === "pending"\)/,
    "the opening rung must be the first PENDING gate — a skipped self-rung must not become 'current'",
  );
  // And if every gate resolved to the requester, fail loudly rather than submit into limbo.
  assert.match(
    serviceSource,
    /marketing_requester_is_sole_approver/,
    "a request whose every gate is the requester must be refused at submit, not parked in pending_approval with no actionable rung",
  );

  /* ---------------------------------------------------------------------- */
  /* Layer 3 — the RPC, which is the real boundary                           */
  /* ---------------------------------------------------------------------- */

  assert.match(
    sql,
    /marketing_self_approval_refused/,
    "the decision RPC must refuse a self-decision — the chain is data and the service fix only shapes rows at submit time",
  );
  assert.match(
    sql,
    /lower\(btrim\(v_requester_hr_id\)\) = lower\(btrim\(coalesce\(p_decided_by, ''\)\)\)/,
    "the RPC comparison must be case-insensitive and trimmed",
  );

  // Ordering matters: the optimistic-lock UPDATE stamps decision_by/decision_at onto the step. The
  // exception would roll that back, but checking first means a refused decision never touches it.
  const guardAt = sql.indexOf("marketing_self_approval_refused");
  const stampAt = sql.indexOf("update marketing_request_approval_steps set");
  assert.ok(guardAt > -1 && stampAt > -1, "expected both the guard and the stamping update");
  assert.ok(
    guardAt < stampAt,
    "the self-approval guard must run BEFORE the step is stamped, so a refused decision never writes to the row",
  );

  // The caller must surface it as a 403 with a reason, not raw Postgres text.
  assert.match(
    serviceSource,
    /marketing_self_approval_refused[\s\S]{0,220}?forbiddenError/,
    "the RPC refusal must be mapped to a 403 with an explanation, never leaked as a Postgres error",
  );
}
