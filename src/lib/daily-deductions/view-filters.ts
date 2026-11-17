// Daily Deductions module: the two VIEW filters the Super Admin reviews with (owner, 2026-11-17: "In
// daily deductions, make an option to exclude fingerprint or filter by exclude fingerprint or filter by
// exclude head office employees").
//
//   - Exclude fingerprint   — hides every deduction whose source is the fingerprint device (the
//                             `fingerprint` connector: late, absent, missing punch). CRM no-activity,
//                             no-weekly-plan, the vacations and no-records all stay.
//   - Exclude Head Office   — hides every deduction of an employee the employee master files under the
//                             Head Office line (`isHeadOfficeRow`, src/lib/reports/organogram.ts: line
//                             id 4, else a line named "Head Office" / "Office"). The set is read on the
//                             server by head-office.ts and handed to the screen; this file never guesses it.
//
// Both are off by default, independent, and combine. They are VIEW filters only: nothing here changes,
// releases, withdraws or re-prices a deduction. What they DO decide is the scope every count, total,
// tick and bulk release on the screen works from — the workspace derives everything from the lines this
// returns, so a deduction hidden by a filter can never ride along in a "Release ticked" click.
//
// Pure and browser-safe (no database, no server-only import): the workspace imports it and the unit
// test loads it directly. The state lives in the URL query (`excludeFingerprint=1`,
// `excludeHeadOffice=1`) so a refresh or a shared link keeps it.

import { compactDeductionsHrId } from "../deductions/candidate-key.ts";

export type DailyDeductionViewFilters = {
  excludeFingerprint: boolean;
  excludeHeadOffice: boolean;
};

export const DAILY_DEDUCTION_VIEW_FILTERS_OFF: DailyDeductionViewFilters = {
  excludeFingerprint: false,
  excludeHeadOffice: false,
};

/** The query keys the filters live under. */
export const DAILY_DEDUCTION_VIEW_FILTER_PARAMS = {
  excludeFingerprint: "excludeFingerprint",
  excludeHeadOffice: "excludeHeadOffice",
} as const;

/** The category whose source is the fingerprint device — the only one the fingerprint filter hides. */
export const FINGERPRINT_DEDUCTION_CATEGORY = "fingerprint";

type QueryValue = string | string[] | null | undefined;

/**
 * A query value reads as ON only when it says so: `1`, `true`, `yes` or `on`. Anything else — absent,
 * blank, `0`, a typo — is OFF, so a stray parameter can never hide deductions the owner did not ask to
 * hide. A repeated parameter reads its first value.
 */
export function readViewFilterFlag(raw: QueryValue): boolean {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/** Reads the filters from a page's `searchParams` record or a `URLSearchParams`. */
export function parseDailyDeductionViewFilters(
  params: URLSearchParams | Record<string, QueryValue> | null | undefined,
): DailyDeductionViewFilters {
  if (!params) return { ...DAILY_DEDUCTION_VIEW_FILTERS_OFF };
  const get = (key: string): QueryValue =>
    params instanceof URLSearchParams ? params.get(key) : (params as Record<string, QueryValue>)[key];
  return {
    excludeFingerprint: readViewFilterFlag(get(DAILY_DEDUCTION_VIEW_FILTER_PARAMS.excludeFingerprint)),
    excludeHeadOffice: readViewFilterFlag(get(DAILY_DEDUCTION_VIEW_FILTER_PARAMS.excludeHeadOffice)),
  };
}

/**
 * Writes the filters into a query string, keeping every other parameter as it was. An OFF filter is
 * removed rather than written as `=0`, so the plain page address stays the plain page.
 */
export function writeDailyDeductionViewFilters(search: string, filters: DailyDeductionViewFilters): string {
  const params = new URLSearchParams(search);
  for (const key of Object.keys(DAILY_DEDUCTION_VIEW_FILTER_PARAMS) as Array<keyof DailyDeductionViewFilters>) {
    const name = DAILY_DEDUCTION_VIEW_FILTER_PARAMS[key];
    if (filters[key]) params.set(name, "1");
    else params.delete(name);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function isAnyDailyDeductionViewFilterOn(filters: DailyDeductionViewFilters): boolean {
  return filters.excludeFingerprint || filters.excludeHeadOffice;
}

type FilterableLine = {
  category: string;
  employeeHrIdCompact: string;
};

/**
 * The per-type totals of the lines the filters leave — what the "Released to employees" type chips show
 * while a filter is on (owner, 2026-11-17: "fix the fingerprint chip so it follows the filter"). A type
 * with nothing left is absent, so its chip disappears; each total is rounded to the piastre like every
 * other figure on the screen.
 */
export function categoryTotalsOfLines<C extends string>(
  lines: ReadonlyArray<{ category: C; amount: number }>,
): Partial<Record<C, number>> {
  const sums = new Map<C, number>();
  for (const line of lines) sums.set(line.category, (sums.get(line.category) ?? 0) + Number(line.amount ?? 0));
  const totals: Partial<Record<C, number>> = {};
  for (const [category, sum] of sums) {
    const rounded = Math.round(sum * 100) / 100;
    if (rounded > 0) totals[category] = rounded;
  }
  return totals;
}

export function isFingerprintDeduction(line: Pick<FilterableLine, "category">): boolean {
  return line.category === FINGERPRINT_DEDUCTION_CATEGORY;
}

/** Is this line's employee in the Head Office set? Both sides go through the deductions' own HR-id key. */
export function isHeadOfficeDeduction(
  line: Pick<FilterableLine, "employeeHrIdCompact">,
  headOfficeCompacts: ReadonlySet<string>,
): boolean {
  const key = compactDeductionsHrId(line.employeeHrIdCompact);
  return key !== null && headOfficeCompacts.has(key);
}

export type DailyDeductionViewFilterResult<T> = {
  /** What the screen shows and counts, ticks and releases from. */
  lines: T[];
  /** What the filters hid — said on the screen, never silently dropped. */
  hidden: T[];
  /**
   * True when "Exclude Head Office" is on but the Head Office list could not be read. Nothing is hidden
   * for it then — the screen says the filter is not applied, rather than guessing who is Head Office.
   */
  headOfficeUnavailable: boolean;
};

/**
 * Narrows deduction lines by the two view filters. The order of `lines` is kept. `headOfficeCompacts`
 * is the compact HR ids head-office.ts read on the server; `null` means that read failed.
 */
export function applyDailyDeductionViewFilters<T extends FilterableLine>(
  lines: readonly T[],
  filters: DailyDeductionViewFilters,
  headOfficeCompacts: ReadonlySet<string> | null,
): DailyDeductionViewFilterResult<T> {
  const headOfficeUnavailable = filters.excludeHeadOffice && headOfficeCompacts === null;
  const kept: T[] = [];
  const hidden: T[] = [];
  for (const line of lines) {
    const hide =
      (filters.excludeFingerprint && isFingerprintDeduction(line)) ||
      (filters.excludeHeadOffice && headOfficeCompacts !== null && isHeadOfficeDeduction(line, headOfficeCompacts));
    (hide ? hidden : kept).push(line);
  }
  return { lines: kept, hidden, headOfficeUnavailable };
}
