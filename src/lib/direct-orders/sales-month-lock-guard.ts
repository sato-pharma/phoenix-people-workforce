import { conflictError } from "@/lib/http/api-errors";

// ─────────────────────────────────────────────────────────────────────────────
// Booking a direct order into a sales month — the FROZEN-CLOSING rule.
//
// OWNER RULE, 2026-09-07: "since the monthly closing is published then no ever change in it ever
// never even if finance chose a direct order sales month of a published month it doesnt accept and
// shift to the next month."
//
// So the two directions are NOT symmetric, and that asymmetry is the whole design:
//
//   * INTO a frozen month — the booking is ACCEPTED but MOVED. The order lands in the first month
//     after it that is still open. Finance's decision that this order is real is honoured; only the
//     month is overruled, because the month it asked for is closed and announced.
//   * OUT OF a frozen month — REFUSED outright. Moving an order out means deleting its sales from a
//     published closing, which is the very thing the freeze exists to prevent. There is no "shift"
//     that can express it, so this one stops.
//
// WHY SHIFTING RATHER THAN REFUSING. The earlier rule refused both directions. That was safe for
// the closing and bad for the money: a refused booking leaves an approved order with NO sales month
// at all, sitting in Finance's queue, counted in no month — and the previous owner rule
// (2026-09-05, "the month Finance books is the month it counts") means an unbooked order is
// invisible everywhere. Shifting keeps the order in the business and puts it in the only month that
// can still legitimately take it.
//
// WHAT COUNTS AS FROZEN. An active row in `monthly_closing_locks` for that (line, period). Since
// 20260907140000 publishing a closing CREATES that row, so "published" and "frozen" are now the
// same question — and unpublishing does not release it. The caller supplies the predicate; this
// module holds only the rule, so it stays testable without a database and lives in one place
// rather than in whichever screen remembers to ask.
// ─────────────────────────────────────────────────────────────────────────────

/** How many months forward a booking may be carried before we give up and refuse. */
const MAX_LOOKAHEAD_MONTHS = 24;

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

export type SalesMonthBooking =
  | {
      ok: true;
      /** The month the order will actually be written to — may differ from what was asked for. */
      bookedMonth: string | null;
      /** What Finance asked for. */
      requestedMonth: string | null;
      /** The frozen months that were stepped over, in order. Empty when nothing was shifted. */
      shiftedOver: string[];
    }
  | { ok: false; lockedPeriods: string[]; message: string };

/** The month after `period`. `2026-12` -> `2027-01`. */
export function nextPeriod(period: string): string {
  const trimmed = String(period ?? "").trim();
  if (!PERIOD_PATTERN.test(trimmed)) {
    throw new Error(`Not a period: ${trimmed || "(blank)"}`);
  }
  const year = Number(trimmed.slice(0, 4));
  const month = Number(trimmed.slice(5, 7));
  return month >= 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * The periods a sales-month change touches: the one it leaves and the one it enters.
 *
 * De-duplicated, blanks dropped — setting a month for the first time touches exactly one period,
 * and clearing one also touches exactly one.
 */
export function periodsTouchedBySalesMonthChange(
  previousMonth: string | null | undefined,
  nextMonth: string | null | undefined,
): string[] {
  const cleaned = [previousMonth, nextMonth]
    .map((month) => String(month ?? "").trim())
    .filter((month) => month !== "");
  return [...new Set(cleaned)];
}

/**
 * Decide which month a direct order is actually booked into.
 *
 * `isPeriodFrozen` is asked about THIS ORDER'S LINE — a lock is per (line, period), so another
 * line's frozen August is none of this order's business.
 */
export function resolveSalesMonthBooking(input: {
  isPeriodFrozen: (period: string) => boolean;
  line?: string | null;
  maxLookahead?: number;
  previousMonth: string | null;
  requestedMonth: string | null;
}): SalesMonthBooking {
  const line = String(input.line ?? "").trim();
  const previousMonth = String(input.previousMonth ?? "").trim() || null;
  const requestedMonth = String(input.requestedMonth ?? "").trim() || null;

  // ── leaving a frozen month is refused, in every case ──────────────────────────────────────
  // Including when the order is merely being cleared: removing its sales from a published closing
  // is the same edit whether or not another month receives them.
  if (previousMonth && input.isPeriodFrozen(previousMonth)) {
    return {
      ok: false,
      lockedPeriods: [previousMonth],
      message:
        `The ${line ? `${line} ` : ""}Monthly Closing for ${previousMonth} is published and frozen. `
        + `This order is already counted in it, so it cannot be moved out — that would change a `
        + `month that has already been announced. Unlock ${previousMonth} on the Monthly Closing `
        + `screen first if the closing genuinely has to be reopened.`,
    };
  }

  // ── clearing the month, or a month that is open: nothing to do ────────────────────────────
  if (!requestedMonth) {
    return { ok: true, bookedMonth: null, requestedMonth: null, shiftedOver: [] };
  }
  if (!PERIOD_PATTERN.test(requestedMonth)) {
    return {
      ok: false,
      lockedPeriods: [],
      message: `"${requestedMonth}" is not a sales month. Use YYYY-MM.`,
    };
  }
  if (!input.isPeriodFrozen(requestedMonth)) {
    return { ok: true, bookedMonth: requestedMonth, requestedMonth, shiftedOver: [] };
  }

  // ── booking into a frozen month: carry it forward to the first open one ────────────────────
  const limit = input.maxLookahead ?? MAX_LOOKAHEAD_MONTHS;
  const shiftedOver: string[] = [];
  let candidate = requestedMonth;
  for (let step = 0; step < limit; step += 1) {
    shiftedOver.push(candidate);
    candidate = nextPeriod(candidate);
    if (!input.isPeriodFrozen(candidate)) {
      return { ok: true, bookedMonth: candidate, requestedMonth, shiftedOver };
    }
  }

  return {
    ok: false,
    lockedPeriods: shiftedOver,
    message:
      `Every month from ${requestedMonth} onwards is a published, frozen closing, so this order has `
      + `nowhere to go. That should not be possible — tell the owner before doing anything else.`,
  };
}

/**
 * A one-line explanation of a shift, for Finance and for the audit row. Null when nothing moved.
 *
 * Said plainly on purpose: the screen must never silently save a different month from the one that
 * was picked, or the next person to open the order reads it as Finance's own choice.
 */
export function describeSalesMonthShift(booking: SalesMonthBooking): string | null {
  if (!booking.ok || booking.shiftedOver.length === 0) return null;
  const skipped = booking.shiftedOver;
  const subject =
    skipped.length === 1
      ? `${skipped[0]} is a published closing and is frozen`
      : `${skipped.join(", ")} are published closings and are frozen`;
  return (
    `${subject}, so this order was booked into ${booking.bookedMonth} instead. A published month `
    + `never changes, and the sales still have to count somewhere.`
  );
}

/** The refusal as a thrown 409 — the shape the API route already renders. */
export function assertSalesMonthBookingAllowed(booking: SalesMonthBooking): void {
  if (!booking.ok) throw conflictError(booking.message, "closing_locked");
}
