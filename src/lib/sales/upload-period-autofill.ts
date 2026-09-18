// Sales Upload — which month the page may fill into the Month/Year picker after Validate (PURE, no I/O,
// unit-tested in tests/sales-upload-redated-rows.test.ts).
//
// Only the sheet's own single month. For a sheet spanning several months the preview's `period` is
// just the month with the most rows (dominantPeriod), and filling it in chose, for the operator, to
// re-date every other month's rows into it, under a green "Auto-detected" chip. The next Validate then
// passed with no word about the other months, and Confirm imported them as the majority month's sales.
// Left blank, the report's "This sheet spans N months" error stands until the operator picks a month
// (and is told which rows that re-dates) or uploads one month per file.

export type PreviewPeriods = {
  /** The month with the most coded rows, or null when no row carries a date. */
  period: string | null;
  /** Coded rows per month, as the sheet dated them. */
  periods?: readonly { period: string; rows: number }[];
};

export function periodToAutoFill(preview: PreviewPeriods | null | undefined, picked: string): string | null {
  if (!preview?.period || picked) return null;
  return (preview.periods?.length ?? 0) <= 1 ? preview.period : null;
}
