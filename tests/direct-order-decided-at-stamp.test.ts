import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DIRECT_ORDER_DECIDING_STATUSES,
  decidedStatusPatch,
} from "../src/lib/direct-orders/approval-flow.ts";

/**
 * A direct order that reaches a DECIDING status has been decided, so it must carry `decided_at`.
 * The "Decided" column, the approval fields, the approved-order email and the report export all
 * read that column, and the request-history query orders by it.
 *
 * Most requests are decided through the approval chain, but four write paths set a deciding status
 * DIRECTLY — a venue ruled false, an expired hold, a withdrawn hold, and duplicate cleanup. Only
 * duplicate cleanup remembered the stamp, so 8 production rows ended up terminal-but-undated
 * (7 rejected in one venue-rejection sweep on 2026-08-05, 1 cancelled on 2026-08-13) and rendered
 * a blank "Decided". These tests pin both halves: the patch always stamps, and no write path may
 * go back to setting a deciding status without it.
 */

const NEVER_DECIDING = ["draft", "pending_approval", "returned", "held", "reversed"];

export function runDirectOrderDecidedAtStampTests() {
  // 1. The headline: every deciding status produces a decided_at, always.
  for (const status of DIRECT_ORDER_DECIDING_STATUSES) {
    const patch = decidedStatusPatch(status);
    assert.equal(patch.status, status, `decidedStatusPatch must preserve the status it was given`);
    assert.ok(
      typeof patch.decided_at === "string" && patch.decided_at.length > 0,
      `a ${status} request has been decided, so the patch must stamp decided_at`,
    );
    assert.ok(
      Number.isFinite(Date.parse(patch.decided_at)),
      `${status} decided_at must be a parseable timestamp, not a placeholder`,
    );
  }

  // 2. An explicit instant is honoured — a backfill or a replayed decision must be datable to when
  //    it actually happened, never to "now".
  const at = new Date("2026-08-05T17:05:09.125Z");
  assert.equal(
    decidedStatusPatch("rejected", at).decided_at,
    at.toISOString(),
    "an explicitly supplied decision time must survive verbatim",
  );

  // 3. An in-flight status is NOT a decision and must not be stampable through this helper —
  //    stamping decided_at on a pending row would be the mirror-image bug.
  for (const status of NEVER_DECIDING) {
    assert.ok(
      !(DIRECT_ORDER_DECIDING_STATUSES as readonly string[]).includes(status),
      `${status} is not a decision — it must never appear in DIRECT_ORDER_DECIDING_STATUSES`,
    );
  }

  // 4. The wiring, which is the half that actually shipped broken: no write path may set a
  //    deciding status as a bare status-only patch. That literal form is the regression.
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  for (const status of DIRECT_ORDER_DECIDING_STATUSES) {
    assert.ok(
      !service.includes(`.update({ status: "${status}" })`),
      `direct-orders/service.ts sets ${status} without decided_at — route it through decidedStatusPatch`,
    );
  }
  assert.ok(
    service.includes("decidedStatusPatch("),
    "direct-orders/service.ts must build its deciding-status patches through decidedStatusPatch",
  );
}
