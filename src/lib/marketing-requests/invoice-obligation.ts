import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import type { MarketingInvoiceStatus } from "@/lib/marketing-requests/types";

/**
 * Is the invoice a marketing approval obliges actually late?
 *
 * Approving a marketing request records an invoice deadline (migration 20260829180000). Nothing
 * then acted on it: `invoice_status` was only ever written `'pending'` at approval or `'submitted'`
 * when the evidence arrived, so a request eighteen days past its deadline read as calmly "Pending"
 * on every surface — in the portal tab where the person who owes it uploads the file, and in the
 * Marketing Requests export where the Super Admin would go looking for it.
 *
 * DERIVED, NOT STORED — and deliberately so.
 *
 * "Overdue" is a pure function of two values already on the row: the status, and whether the
 * deadline has passed in Cairo. Nothing accumulates, nothing arrives from outside. A nightly job
 * flipping the column would add a moving part that can only be wrong: this repository has twice
 * had a cron that ran perfectly and did nothing for days without anyone noticing, and a stored
 * flag would also go stale the moment a deadline is corrected forward — healing only on the next
 * run, if that run happens. Computing it at read time is right every time, needs no scheduler
 * entry, and cannot drift from the deadline it is derived from.
 *
 * The consequence is written down rather than left to be discovered: the `'overdue'` value the
 * table's CHECK constraint has always allowed stays unused in the database. Every reader goes
 * through this module instead, which is what keeps the screen and the export saying the same
 * thing (owner rule: an export must match the screen). A future reader of the raw column must
 * call this too — that is what `tests/marketing-invoice-overdue-marker.test.ts` pins.
 */

export type MarketingInvoiceObligation = {
  /** Whole days past the deadline; 0 when it is not overdue. */
  daysOverdue: number;
  /** Whole days until the deadline, 0 on the day itself; null when nothing is pending or dated. */
  daysUntilDue: number | null;
  /** What the status IS today — `'overdue'` in place of a `'pending'` whose deadline has passed. */
  effectiveStatus: MarketingInvoiceStatus;
  isOverdue: boolean;
};

/**
 * Only a `pending` obligation can go overdue.
 *
 * - `submitted` / `cleared` — the invoice arrived. Nothing is owed, however late it was.
 * - `not_required` — nothing was ever owed.
 * - `hold` — a human deliberately paused this one. Nagging about a pause someone chose is how a
 *   marker earns itself ignored, so a hold is left exactly as it is.
 */
const CAN_GO_OVERDUE: ReadonlySet<string> = new Set(["pending"]);

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is earlier. */
function daysBetweenDateOnly(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Resolve what an invoice obligation's status is *today*.
 *
 * `today` is injected so the boundary is assertable rather than dependent on when the suite runs.
 * It defaults to Cairo's calendar date, never the runtime clock's: an approval deadline of the 2nd
 * is still the 2nd for a user in Cairo when a UTC server has already rolled over.
 *
 * The deadline day itself is NOT overdue. A deadline of the 2nd means "by the end of the 2nd", so
 * the marker appears on the 3rd. Off-by-one here would tell somebody they are late on the day they
 * are still on time, which is the fastest way for a marker to stop being believed.
 */
export function resolveMarketingInvoiceObligation(
  input: {
    invoiceDeadlineDate: string | null | undefined;
    invoiceStatus: MarketingInvoiceStatus | string | null | undefined;
  },
  today: string = currentCairoDateOnlyIso(),
): MarketingInvoiceObligation {
  const status = (String(input.invoiceStatus ?? "not_required").trim().toLowerCase() ||
    "not_required") as MarketingInvoiceStatus;

  const deadline = input.invoiceDeadlineDate ? String(input.invoiceDeadlineDate).slice(0, 10) : null;
  const settled = { daysOverdue: 0, daysUntilDue: null, effectiveStatus: status, isOverdue: false } as const;

  // An undated obligation can never be late. The one production row in this state predates the
  // approval-time deadline and already carries its invoice; inventing a deadline for it here would
  // manufacture a debt nobody agreed to.
  if (!CAN_GO_OVERDUE.has(status) || !deadline) return { ...settled };

  const remaining = daysBetweenDateOnly(today, deadline);
  if (remaining === null) return { ...settled };

  if (remaining >= 0) {
    return { daysOverdue: 0, daysUntilDue: remaining, effectiveStatus: status, isOverdue: false };
  }

  return {
    daysOverdue: Math.abs(remaining),
    daysUntilDue: remaining,
    effectiveStatus: "overdue",
    isOverdue: true,
  };
}

/** The status a surface should show — `'overdue'` where the stored column still says `'pending'`. */
export function effectiveMarketingInvoiceStatus(
  input: {
    invoiceDeadlineDate: string | null | undefined;
    invoiceStatus: MarketingInvoiceStatus | string | null | undefined;
  },
  today: string = currentCairoDateOnlyIso(),
): MarketingInvoiceStatus {
  return resolveMarketingInvoiceObligation(input, today).effectiveStatus;
}

/**
 * Short, fixed-width-ish label for a table cell: "2 Sep", "Due today", "18d late".
 *
 * Kept to a few characters on purpose — owner rule: no ellipsis and no wrapping anywhere in the
 * UI, and this sits in a narrow column beside the upload control.
 */
export function marketingInvoiceDueLabel(
  input: {
    invoiceDeadlineDate: string | null | undefined;
    invoiceStatus: MarketingInvoiceStatus | string | null | undefined;
  },
  today: string = currentCairoDateOnlyIso(),
): string {
  const obligation = resolveMarketingInvoiceObligation(input, today);
  if (obligation.isOverdue) return `${obligation.daysOverdue}d late`;
  if (obligation.daysUntilDue === 0) return "Due today";
  if (obligation.daysUntilDue === null) return "-";

  // Formatted from a fixed table rather than Intl on purpose. Node's en-GB ICU renders September
  // as "Sept" — four characters where every other month is three — and which spelling you get
  // depends on the ICU data the runtime was built with, so the same cell could differ between this
  // laptop, CI and the Railway container. A narrow column with a no-wrap rule cannot afford that.
  const deadline = String(input.invoiceDeadlineDate ?? "").slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deadline);
  if (!match) return "-";
  const month = MONTHS_SHORT[Number(match[2]) - 1];
  if (!month) return "-";
  return `${Number(match[3])} ${month}`;
}
