import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { SALES_LINES, resolveTargetLineCode } from "@/lib/sales/monthly-targets";
import { SALES_VS_TARGET_FLOOR, loadPublishedPeriodKeys } from "@/lib/sales/vs-target";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Who may read an unpublished month's sales, and which months count as released.
//
// Owner, 2026-11-04: sales of an unpublished month appear nowhere. His three rulings that day:
//   - the Business Review stays live for the Super Admin, the CEO and the SFE Manager; managers and
//     reps stop at the last published month;
//   - the admin tools keep unpublished figures for the Super Admin and the SFE Manager only; every
//     other role is refused, the CEO included, and a typed URL is refused the same way;
//   - the Direct Orders workflow screens are a work record and stay; Direct Orders in My Area and
//     sales figures elsewhere are gated.
//
// Every sales function in the database answers whether or not the month is published, so a surface
// gates itself with these. The closing's own screens keep their wider rule, readsUnpublishedClosings:
// the CEO, Finance and Marketing read a closing before it is published, on that page and nowhere else.
//
// January to June 2026 are released by being older than the floor. They have no publication row and
// never will, and his "Add Jan-Jun as history" ruling keeps them showing.
// ─────────────────────────────────────────────────────────────────────────────────────────────

type Viewer = Pick<AccessContext, "role" | "scope">;

/** Every field line. Head Office is not one: it has no line code and no publication of its own. */
function companyLineCodes(): string[] {
  return SALES_LINES.map((line) => line.code);
}

/** The Super Admin, the system itself and the SFE Manager. A missing viewer reads nothing. */
export function readsUnpublishedSalesTools(viewer: Viewer | null | undefined): boolean {
  if (!viewer) return false;
  return viewer.role === "Super Admin" || viewer.scope === "system" || viewer.role === "SFE Manager";
}

/** The Business Review's live view: the tools' readers and the CEO. */
export function readsLiveBusinessReview(viewer: Viewer | null | undefined): boolean {
  return readsUnpublishedSalesTools(viewer) || viewer?.role === "CEO";
}

/** A line's month is released once published, or by being older than the floor. A missing line is not. */
export function isSalesPeriodReleased(
  period: string,
  lineCode: string | null | undefined,
  publishedKeys: ReadonlySet<string>,
): boolean {
  if (period < SALES_VS_TARGET_FLOOR) return true;
  return Boolean(lineCode) && publishedKeys.has(`${lineCode}|${period}`);
}

/**
 * Released for ALL of these lines. Fails closed: one line still unpublished keeps the month closed,
 * because a figure added across the lines would carry its sale, and no lines at all opens nothing.
 */
export function isSalesPeriodReleasedForLines(
  period: string,
  lineCodes: Iterable<string | null | undefined>,
  publishedKeys: ReadonlySet<string>,
): boolean {
  if (period < SALES_VS_TARGET_FLOOR) return true;
  const codes = [...lineCodes];
  return codes.length > 0 && codes.every((code) => isSalesPeriodReleased(period, code, publishedKeys));
}

/** Released on every field line — for a figure that is company-wide, or has no line to ask about. */
export function isSalesPeriodReleasedCompanyWide(period: string, publishedKeys: ReadonlySet<string>): boolean {
  return isSalesPeriodReleasedForLines(period, companyLineCodes(), publishedKeys);
}

/** The line codes of a sales scope. A name that resolves to no line stays in as null, so it fails closed. */
export function salesScopeLineCodes(scope: {
  allowedLineNames: ReadonlySet<string> | null;
  canViewAllSales: boolean;
}): Array<string | null> {
  if (scope.canViewAllSales || !scope.allowedLineNames) return companyLineCodes();
  return [...scope.allowedLineNames].map((name) => resolveTargetLineCode(name));
}

/**
 * The months up to the first one that is not released, ascending.
 *
 * A range read returns every month between its two ends, so a window cannot step over a hole: with
 * August withdrawn and September published, July to September would still read August.
 */
export function releasedPeriodsUpToFirstHole(
  periods: readonly string[],
  publishedKeys: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const period of [...periods].sort()) {
    if (!isSalesPeriodReleasedCompanyWide(period, publishedKeys)) break;
    out.push(period);
  }
  return out;
}

/** The newest month published on all of these lines, or null. */
export function newestPeriodPublishedForLines(
  lineCodes: readonly string[],
  publishedKeys: ReadonlySet<string>,
): string | null {
  const periods = new Set([...publishedKeys].map((key) => key.slice(key.indexOf("|") + 1)));
  return (
    [...periods]
      .filter((period) => isSalesPeriodReleasedForLines(period, lineCodes, publishedKeys))
      .sort()
      .pop() ?? null
  );
}

/** The newest month published on every field line, or null. */
export function newestCompanyPublishedPeriod(publishedKeys: ReadonlySet<string>): string | null {
  return newestPeriodPublishedForLines(companyLineCodes(), publishedKeys);
}

/**
 * Every published (line, period) from the floor to this Cairo month.
 *
 * NOT caught here, for the reason loadPublishedPeriodKeys gives: an empty set would assert that a
 * published month never was. A caller that would rather degrade catches it and stays closed.
 */
export async function loadSalesReleaseKeys(): Promise<Set<string>> {
  const { year, month } = currentCairoDateParts();
  return loadPublishedPeriodKeys(SALES_VS_TARGET_FLOOR, `${year}-${String(month).padStart(2, "0")}`);
}
