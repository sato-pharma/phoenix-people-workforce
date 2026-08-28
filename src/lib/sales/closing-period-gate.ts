/**
 * THE CLOSING GOLDEN RULE — a month's closing happens only AFTER that month has closed.
 *
 * Owner's rule, stated 2026-08-28, in his words: "no closing is ever done or sent during the
 * month. Closing after the month closes."
 *
 * So the August closing may not be published on 28 August. It becomes publishable on
 * 1 September, Cairo time — not one day earlier. The same holds for every line and every month.
 *
 * WHY THIS IS A GATE AND NOT A NOTE. Publishing is not a private act. `publishClosing` releases
 * the (line, period) to every sales and product manager's portal, fires
 * `notifyClosingPublished` to that audience, and arms the CEO/Super-Admin Source-of-Sales BI
 * report that `runSosMonthlyClosingReportCheck` sends once every line for the period is
 * published. A mid-month publish therefore distributes a PARTIAL month as if it were the final
 * number — to the exact people who make decisions on it — and the send cannot be recalled.
 * Unpublishing afterwards hides the page; it does not unsend the mail.
 *
 * Until this file existed there was no date check anywhere in the publish path: the route
 * (`app/api/sales/monthly-closing/publish/route.ts`) checked only that the actor was the admin,
 * and `publishClosing` upserted whatever period string it was handed. Publishing `2026-08` on
 * 28 August was one button press, and nothing in the product would have objected.
 *
 * WHAT IS AND IS NOT BLOCKED. This gate sits on RELEASE, not on preparation. The admin can still
 * import, review, correct and preview the running month as much as he likes — he has to, in
 * order to have anything worth publishing on the 1st. What he cannot do is hand it to anyone
 * else before the month is over.
 *
 * A FUTURE period is refused by the same comparison, for the same reason: a month that has not
 * happened has no closing at all.
 *
 * `unpublishClosing` is deliberately NOT gated. It is the recovery path, and a recovery path
 * that stops working when you need it is not a recovery path.
 *
 * Cairo, not UTC. The server runs UTC; Cairo is UTC+2/+3. Between 21:00 and 23:59 UTC on
 * 31 August the server already believes it is September while Cairo is still in August — so a
 * UTC-based check would open the gate up to three hours early, on the one night of the month it
 * matters most. `currentCairoDateParts` is the repo's single Cairo-wall-clock primitive.
 *
 * Pinned by `tests/closing-period-gate.test.ts`, which runs inside `pnpm run test` — the
 * required CI `validate` check — so a PR that removes the gate cannot merge.
 */

import { currentCairoDateParts } from "@/lib/i18n/format";

/** Plain-language statement of the rule, for humans and for the pinning test. */
export const CLOSING_GOLDEN_RULE = Object.freeze({
  statedOn: "2026-08-28",
  statedBy: "owner",
  summary:
    "A monthly closing is never produced for release or sent during the month it covers. "
    + "The closing for a month becomes publishable on the first day of the FOLLOWING month, "
    + "Africa/Cairo time.",
  clauses: Object.freeze([
    "The closing for period YYYY-MM may be published only from the first day of the next month, Cairo time.",
    "A period that has not yet ended is refused, and so is a period that has not yet begun.",
    "The gate is on release (publish/notify/report), never on importing or previewing a running month.",
    "Unpublishing is never gated — it is the recovery path.",
  ]),
});

const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

export type ClosingPeriodParts = { year: number; month: number };

/** Parse a `YYYY-MM` period. Returns null when the string is not a real calendar month. */
export function parseClosingPeriod(period: string | null | undefined): ClosingPeriodParts | null {
  const match = PERIOD_PATTERN.exec(String(period ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** Months since year 0 — makes "is this period strictly before that one" a single comparison. */
function monthIndex(parts: ClosingPeriodParts): number {
  return parts.year * 12 + (parts.month - 1);
}

/**
 * True when `period` is a month that has completely ended in Africa/Cairo — i.e. Cairo's
 * current month is strictly later than the period. False for the running month and for any
 * future month.
 */
export function isClosingPeriodComplete(
  period: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const parts = parseClosingPeriod(period);
  if (!parts) return false;
  const cairo = currentCairoDateParts(now);
  return monthIndex(parts) < monthIndex({ year: cairo.year, month: cairo.month });
}

/**
 * The first day on which `period` may be published — the 1st of the following month, Cairo.
 * Null when the period is not a real month. December rolls the YEAR, not a 13th month.
 */
export function closingPeriodOpensOn(period: string | null | undefined): string | null {
  const parts = parseClosingPeriod(period);
  if (!parts) return null;
  const opensYear = parts.month === 12 ? parts.year + 1 : parts.year;
  const opensMonth = parts.month === 12 ? 1 : parts.month + 1;
  return `${opensYear}-${String(opensMonth).padStart(2, "0")}-01`;
}

/** The message shown when the gate refuses. Names the date the period actually opens. */
export function closingPeriodGateMessage(
  period: string | null | undefined,
  now: Date = new Date(),
): string {
  const parts = parseClosingPeriod(period);
  if (!parts) {
    return `"${String(period ?? "").trim()}" is not a valid closing period (expected YYYY-MM).`;
  }
  const opensOn = closingPeriodOpensOn(period) ?? "";
  const cairo = currentCairoDateParts(now);
  const today = `${cairo.year}-${String(cairo.month).padStart(2, "0")}-${String(cairo.day).padStart(2, "0")}`;
  const tense = monthIndex(parts) > monthIndex({ year: cairo.year, month: cairo.month })
    ? "has not started yet"
    : "is still running";

  return (
    `The ${period} closing cannot be published: that month ${tense}. `
    + `A closing is only ever released after its month has closed, so ${period} becomes publishable `
    + `on ${opensOn} (Cairo). Today is ${today}.`
  );
}

/** Throw unless `period` is a month that has fully ended in Cairo. */
export function assertClosingPeriodComplete(
  period: string | null | undefined,
  now: Date = new Date(),
): void {
  if (!isClosingPeriodComplete(period, now)) {
    throw new Error(closingPeriodGateMessage(period, now));
  }
}
