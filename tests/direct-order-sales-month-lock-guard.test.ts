import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertSalesMonthBookingAllowed,
  describeSalesMonthShift,
  nextPeriod,
  periodsTouchedBySalesMonthChange,
  resolveSalesMonthBooking,
} from "../src/lib/direct-orders/sales-month-lock-guard.ts";

/**
 * OWNER RULE, 2026-09-07 — a published closing never changes again, and a direct order aimed at one
 * "doesnt accept and shift to the next month".
 *
 * This replaces the earlier rule, which refused BOTH directions. It was written after August 2026
 * was published and announced with a workbook built 5 September, and Finance then booked ten more
 * Anti Infective direct orders into the same month on 6 September — 490 units, 32,795.70 EGP moving
 * underneath a sheet managers already had.
 *
 * The asymmetry is the whole design and is what these blocks pin:
 *   INTO a frozen month  -> ACCEPTED, carried forward to the first open month.
 *   OUT OF a frozen month -> REFUSED, because it would delete sales from a published closing.
 */

const frozen = (...periods: string[]) => (period: string) => periods.includes(period);

export async function runDirectOrderSalesMonthLockGuardTests() {
  // ── the periods a move touches ─────────────────────────────────────────────
  assert.deepEqual(periodsTouchedBySalesMonthChange("2026-07", "2026-08"), ["2026-07", "2026-08"]);
  assert.deepEqual(periodsTouchedBySalesMonthChange(null, "2026-08"), ["2026-08"], "first booking touches one period");
  assert.deepEqual(periodsTouchedBySalesMonthChange("2026-08", null), ["2026-08"], "clearing touches one period");
  assert.deepEqual(periodsTouchedBySalesMonthChange("2026-08", "2026-08"), ["2026-08"], "de-duplicated");
  assert.deepEqual(periodsTouchedBySalesMonthChange("  ", null), [], "blanks are not periods");

  // ── walking a month forward, including over a year boundary ────────────────
  assert.equal(nextPeriod("2026-08"), "2026-09");
  assert.equal(nextPeriod("2026-12"), "2027-01", "December must roll into the next January, not month 13");
  assert.equal(nextPeriod("2026-01"), "2026-02");
  assert.throws(() => nextPeriod("2026-8"), /Not a period/, "a malformed period must not silently become a month");

  // ── an open month books exactly what was asked for ─────────────────────────
  const open = resolveSalesMonthBooking({
    isPeriodFrozen: frozen(),
    line: "Anti Infective",
    previousMonth: null,
    requestedMonth: "2026-08",
  });
  assert.equal(open.ok, true);
  if (!open.ok) throw new Error("unreachable");
  assert.equal(open.bookedMonth, "2026-08", "nothing frozen must book the month Finance picked");
  assert.deepEqual(open.shiftedOver, [], "an open month is not a shift");
  assert.equal(describeSalesMonthShift(open), null, "no shift, nothing to explain");

  // A lock on a month this move does not touch is none of its business.
  const untouched = resolveSalesMonthBooking({
    isPeriodFrozen: frozen("2026-06"),
    line: "Anti Infective",
    previousMonth: "2026-07",
    requestedMonth: "2026-08",
  });
  assert.equal(untouched.ok, true, "a lock on an untouched period must not interfere");
  if (!untouched.ok) throw new Error("unreachable");
  assert.equal(untouched.bookedMonth, "2026-08");

  // ── booking INTO a frozen month is SHIFTED, not refused ────────────────────
  // This is the August case: Finance picks 2026-08, which is published, so it lands in September.
  const shifted = resolveSalesMonthBooking({
    isPeriodFrozen: frozen("2026-08"),
    line: "Anti Infective",
    previousMonth: null,
    requestedMonth: "2026-08",
  });
  assert.equal(shifted.ok, true, "booking into a published month must be ACCEPTED, not refused");
  if (!shifted.ok) throw new Error("unreachable");
  assert.equal(shifted.bookedMonth, "2026-09", "a frozen August must carry the order into September");
  assert.equal(shifted.requestedMonth, "2026-08", "what Finance asked for must survive for the audit row");
  assert.deepEqual(shifted.shiftedOver, ["2026-08"]);

  const note = describeSalesMonthShift(shifted);
  assert.ok(note, "a shift must be explained — the screen must never silently save a different month");
  assert.match(note, /2026-08/, "the explanation must name the month that was refused");
  assert.match(note, /2026-09/, "the explanation must name the month it was booked into");

  // ── consecutive frozen months are walked over ──────────────────────────────
  const walked = resolveSalesMonthBooking({
    isPeriodFrozen: frozen("2026-08", "2026-09", "2026-10"),
    line: "Pedia",
    previousMonth: null,
    requestedMonth: "2026-08",
  });
  assert.equal(walked.ok, true);
  if (!walked.ok) throw new Error("unreachable");
  assert.equal(walked.bookedMonth, "2026-11", "the walk must continue to the FIRST open month");
  assert.deepEqual(walked.shiftedOver, ["2026-08", "2026-09", "2026-10"]);

  // ── a shift that crosses a year boundary ───────────────────────────────────
  const crossYear = resolveSalesMonthBooking({
    isPeriodFrozen: frozen("2026-12"),
    line: "CNS",
    previousMonth: null,
    requestedMonth: "2026-12",
  });
  assert.equal(crossYear.ok, true);
  if (!crossYear.ok) throw new Error("unreachable");
  assert.equal(crossYear.bookedMonth, "2027-01");

  // ── moving OUT of a frozen month is still REFUSED ──────────────────────────
  // Shifting cannot express this: the sales would have to leave a month that has been announced.
  const outOfFrozen = resolveSalesMonthBooking({
    isPeriodFrozen: frozen("2026-07"),
    line: "Pedia",
    previousMonth: "2026-07",
    requestedMonth: "2026-08",
  });
  assert.equal(outOfFrozen.ok, false, "moving a booking out of a published closing must be refused");
  if (outOfFrozen.ok) throw new Error("unreachable");
  assert.deepEqual(outOfFrozen.lockedPeriods, ["2026-07"]);
  assert.match(outOfFrozen.message, /Pedia/);
  assert.match(outOfFrozen.message, /cannot be moved out/i, "leaving a frozen month must read as a removal");

  // Clearing the month is the same edit — the sales still leave a published month.
  const clearedFromFrozen = resolveSalesMonthBooking({
    isPeriodFrozen: frozen("2026-07"),
    line: "Pedia",
    previousMonth: "2026-07",
    requestedMonth: null,
  });
  assert.equal(clearedFromFrozen.ok, false, "un-booking out of a frozen month must be refused too");

  // Leaving an OPEN month for a frozen one still shifts — the refusal is about the month it leaves.
  const openToFrozen = resolveSalesMonthBooking({
    isPeriodFrozen: frozen("2026-08"),
    line: "Anti Infective",
    previousMonth: "2026-07",
    requestedMonth: "2026-08",
  });
  assert.equal(openToFrozen.ok, true);
  if (!openToFrozen.ok) throw new Error("unreachable");
  assert.equal(openToFrozen.bookedMonth, "2026-09");

  // ── clearing a month that is open is always allowed ────────────────────────
  const cleared = resolveSalesMonthBooking({
    isPeriodFrozen: frozen("2026-08"),
    line: "Anti Infective",
    previousMonth: "2026-07",
    requestedMonth: null,
  });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) throw new Error("unreachable");
  assert.equal(cleared.bookedMonth, null);

  // ── nowhere left to go is refused rather than looping forever ──────────────
  const exhausted = resolveSalesMonthBooking({
    isPeriodFrozen: () => true,
    line: "CNS",
    maxLookahead: 6,
    previousMonth: null,
    requestedMonth: "2026-08",
  });
  assert.equal(exhausted.ok, false, "an endless run of frozen months must refuse, never spin");
  if (exhausted.ok) throw new Error("unreachable");
  assert.match(exhausted.message, /nowhere to go/i);

  // ── the thrown form is the 409 the API route already renders ───────────────
  assert.throws(
    () =>
      assertSalesMonthBookingAllowed(
        resolveSalesMonthBooking({
          isPeriodFrozen: frozen("2026-07"),
          line: "Anti Infective",
          previousMonth: "2026-07",
          requestedMonth: "2026-08",
        }),
      ),
    (error: unknown) => {
      const api = error as { status?: number; code?: string };
      assert.equal(api.status, 409, "a frozen closing is a state conflict, not a bad request");
      assert.equal(api.code, "closing_locked");
      return true;
    },
  );
  // A shift is NOT an error — it must pass straight through the assert.
  assertSalesMonthBookingAllowed(shifted);

  // ── the wiring: the rule runs BEFORE the month is written ──────────────────
  //
  // Pinned by ORDER of landmarks, never by byte offset — a source-pinning test that slices a fixed
  // window false-fails the moment the file shifts. If the rule were moved below the update, or the
  // rollback deleted, the invariant would be gone while every assertion above still passed.
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const setMonthAt = service.indexOf("export async function setDirectOrderSalesMonth");
  assert.ok(setMonthAt > 0, "setDirectOrderSalesMonth must exist");
  const body = service.slice(setMonthAt, service.indexOf("export async function", setMonthAt + 1));

  const guardAt = body.indexOf("resolveSalesMonthBooking(");
  const updateAt = body.indexOf("sales_month: bookedMonth");
  assert.ok(guardAt > 0, "setDirectOrderSalesMonth must resolve the booking against frozen closings");
  assert.ok(updateAt > 0, "setDirectOrderSalesMonth must write the BOOKED month, not the requested one");
  assert.ok(
    guardAt < updateAt,
    "the frozen-closing rule must run BEFORE sales_month is written — after it, the month is already saved",
  );
  assert.ok(
    !/sales_month: nextMonth\b/.test(body),
    "the requested month must never reach the write — that is how a shift gets silently undone",
  );

  const rollbackAt = body.indexOf("sales_month: previousMonth");
  assert.ok(
    rollbackAt > updateAt,
    "a rebuild failure must put the month back — the rule narrows the window, the rollback closes it",
  );
  assert.match(
    body.slice(updateAt),
    /phx_rebuild_direct_order_sos_batch/,
    "the rebuild must still run for every touched period",
  );

  // ── the shift has to reach Finance's screen ────────────────────────────────
  //
  // A silent shift is worse than a refusal: the order moves month and the person who moved it is
  // told it did not. The route reports the SAVED month and flags the shift; the control renders
  // what came back rather than what it sent.
  const route = readFileSync(
    new URL("../app/api/direct-orders/[id]/sales-month/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    route,
    /salesMonth: updated\.salesMonth/,
    "the route must return the month that was SAVED, not the month that was requested",
  );
  assert.match(route, /shifted: true/, "the route must flag a shift so the screen can explain it");

  const control = readFileSync(
    new URL("../src/components/direct-orders/direct-order-sales-month-control.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    control,
    /const saved = data\.salesMonth \?\? null;/,
    "the control must read the saved month off the response",
  );
  assert.ok(
    !/setOk\(next \?/.test(control),
    "the control must never announce the month it SENT — with a shift that is the wrong month",
  );
  assert.match(
    control,
    /data\.shifted/,
    "the control must say why the month changed, or Finance reads the shift as its own choice",
  );
}
