/**
 * The Automated Payroll screens' one way of writing money and dates.
 *
 * Before this file each panel carried its own `money()` (0–2 decimals) and the drift lines used a
 * bare `toFixed(2)` with no thousands separator, so one screen showed 1250, 1,250 and 1250.00 for
 * the same figure. A payroll figure is always written to the piastre: "1,250.00".
 *
 * Browser-safe and dependency-free on purpose — every client component here imports it.
 */

const MONEY = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "1,250.00". A non-finite input prints an em dash rather than "NaN" — a blank is safer than a guess. */
export function formatPayrollMoney(value: number): string {
  return Number.isFinite(value) ? MONEY.format(value) : "—";
}

/** "1,250.00 EGP" — for totals that stand on their own, away from a column that already says EGP. */
export function formatPayrollMoneyEgp(value: number): string {
  return Number.isFinite(value) ? `${MONEY.format(value)} EGP` : "—";
}

/** "1 employee" / "6 employees". */
export function peopleCount(count: number): string {
  return `${count} ${count === 1 ? "employee" : "employees"}`;
}

const CAIRO_DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * "5 Oct 2026" from a stored date ("2026-10-05") or timestamp. A plain calendar date is read as
 * that calendar day (never shifted by a timezone); anything unreadable is returned as written, so
 * a marker such as "—" survives untouched.
 */
export function formatPayrollDay(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const text = String(value);
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const date = plain
    ? new Date(Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]), 12))
    : new Date(text);
  return Number.isNaN(date.getTime()) ? text : CAIRO_DAY.format(date);
}

/** A hold or exclusion reason that is only punctuation — "-", "—", "." — says nothing. */
export function isPlaceholderReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.trim().length > 0 && /^[\s\-–—.]*$/.test(reason);
}
