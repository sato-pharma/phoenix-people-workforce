import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertSalesMonthClosingsOpen,
  deriveSalesMonthLockRefusal,
  periodsTouchedBySalesMonthChange,
} from "../src/lib/direct-orders/sales-month-lock-guard.ts";

/**
 * OWNER GOLDEN RULE, 2026-09-05 — the month Finance books is the month the order COUNTS, at that
 * pharmacy's own brick and area. The month and the sales are one decision.
 *
 * `setDirectOrderSalesMonth` moves them in two steps that are not one transaction: it writes
 * `sales_month`, then rebuilds Source of Sales for every period the move touched. A locked closing
 * makes the second step fail while the first has already committed — the order booked for Finance
 * and missing from the closing, the export and the rep's achievement, with nothing to retry it.
 *
 * These blocks fail loudly if the guard or its rollback is removed.
 */

export async function runDirectOrderSalesMonthLockGuardTests() {
  // ── the periods a move touches ─────────────────────────────────────────────
  assert.deepEqual(periodsTouchedBySalesMonthChange("2026-07", "2026-08"), ["2026-07", "2026-08"]);
  assert.deepEqual(periodsTouchedBySalesMonthChange(null, "2026-08"), ["2026-08"], "first booking touches one period");
  assert.deepEqual(periodsTouchedBySalesMonthChange("2026-08", null), ["2026-08"], "clearing touches one period");
  assert.deepEqual(periodsTouchedBySalesMonthChange("2026-08", "2026-08"), ["2026-08"], "de-duplicated");
  assert.deepEqual(periodsTouchedBySalesMonthChange("  ", null), [], "blanks are not periods");

  // ── an open month books normally ───────────────────────────────────────────
  assert.equal(
    deriveSalesMonthLockRefusal({
      line: "Anti Infective",
      lockedPeriods: [],
      nextMonth: "2026-08",
      previousMonth: null,
    }).ok,
    true,
    "nothing locked must not refuse a booking",
  );

  // A lock on a month this move does not touch is none of its business.
  assert.equal(
    deriveSalesMonthLockRefusal({
      line: "Anti Infective",
      lockedPeriods: ["2026-06"],
      nextMonth: "2026-08",
      previousMonth: "2026-07",
    }).ok,
    true,
    "a lock on an untouched period must not refuse",
  );

  // ── booking INTO a frozen month is refused ─────────────────────────────────
  const intoFrozen = deriveSalesMonthLockRefusal({
    line: "Anti Infective",
    lockedPeriods: ["2026-08"],
    nextMonth: "2026-08",
    previousMonth: null,
  });
  assert.equal(intoFrozen.ok, false, "booking into a locked closing must be refused");
  if (intoFrozen.ok) throw new Error("unreachable");
  assert.deepEqual(intoFrozen.lockedPeriods, ["2026-08"]);
  assert.match(intoFrozen.message, /2026-08/);
  assert.match(intoFrozen.message, /Anti Infective/);
  assert.match(
    intoFrozen.message,
    /not saved/i,
    "the refusal must say the month was NOT saved — that is the whole point of refusing early",
  );

  // ── moving OUT of a frozen month is refused too ────────────────────────────
  // The rebuild deletes the order's rows from the month it leaves, which the same trigger blocks.
  const outOfFrozen = deriveSalesMonthLockRefusal({
    line: "Pedia",
    lockedPeriods: ["2026-07"],
    nextMonth: "2026-08",
    previousMonth: "2026-07",
  });
  assert.equal(outOfFrozen.ok, false, "moving a booking out of a locked closing must be refused");
  if (outOfFrozen.ok) throw new Error("unreachable");
  assert.deepEqual(outOfFrozen.lockedPeriods, ["2026-07"]);
  assert.match(outOfFrozen.message, /remove/i, "leaving a frozen month is a REMOVAL, and must read as one");

  // ── both ends frozen names both ────────────────────────────────────────────
  const bothFrozen = deriveSalesMonthLockRefusal({
    line: "Anti Infective",
    lockedPeriods: ["2026-07", "2026-08"],
    nextMonth: "2026-08",
    previousMonth: "2026-07",
  });
  assert.equal(bothFrozen.ok, false);
  if (bothFrozen.ok) throw new Error("unreachable");
  assert.deepEqual(bothFrozen.lockedPeriods, ["2026-07", "2026-08"]);
  assert.match(bothFrozen.message, /2026-07 and 2026-08/);

  // ── the thrown form is a 409 the API route already renders ─────────────────
  assert.throws(
    () =>
      assertSalesMonthClosingsOpen({
        line: "Anti Infective",
        lockedPeriods: ["2026-08"],
        nextMonth: "2026-08",
        previousMonth: null,
      }),
    (error: unknown) => {
      const api = error as { status?: number; code?: string };
      assert.equal(api.status, 409, "a locked closing is a state conflict, not a bad request");
      assert.equal(api.code, "closing_locked");
      return true;
    },
  );
  assertSalesMonthClosingsOpen({
    line: "Anti Infective",
    lockedPeriods: [],
    nextMonth: "2026-08",
    previousMonth: null,
  });

  // ── the wiring: the guard runs BEFORE the month is written ─────────────────
  //
  // Pinned by ORDER of landmarks, never by byte offset — a source-pinning test that slices a fixed
  // window false-fails the moment the file shifts. If the guard were moved below the update, or the
  // rollback deleted, the invariant would be gone while every assertion above still passed.
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const setMonthAt = service.indexOf("export async function setDirectOrderSalesMonth");
  assert.ok(setMonthAt > 0, "setDirectOrderSalesMonth must exist");
  const body = service.slice(setMonthAt, service.indexOf("export async function", setMonthAt + 1));

  const guardAt = body.indexOf("assertSalesMonthClosingsOpen(");
  const updateAt = body.indexOf("sales_month: nextMonth");
  assert.ok(guardAt > 0, "setDirectOrderSalesMonth must consult the locked-closing guard");
  assert.ok(updateAt > 0, "setDirectOrderSalesMonth must still write the month");
  assert.ok(
    guardAt < updateAt,
    "the locked-closing guard must run BEFORE sales_month is written — after it, the month is already saved",
  );

  const rollbackAt = body.indexOf("sales_month: previousMonth");
  assert.ok(
    rollbackAt > updateAt,
    "a rebuild failure must put the month back — the guard narrows the window, the rollback closes it",
  );
  assert.match(
    body.slice(updateAt),
    /phx_rebuild_direct_order_sos_batch/,
    "the rebuild must still run for every touched period",
  );
}
