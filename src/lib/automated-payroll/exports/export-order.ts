import { compactHrKey } from "@/lib/payroll/copilot/feeders.ts";

/**
 * Owner-provided fixed HR-ID execution order for every downloaded Automated
 * Payroll sheet (2026-07-24). The pasted list carried a leading row-number
 * column that does not correspond to anything in the system (and skipped a
 * row) — only the HR_ID sequence below is meaningful; row numbers are not
 * reproduced anywhere, rows are simply emitted in this order.
 *
 * Any employee HR ID present in a run but not listed here is appended AFTER
 * the last listed employee, in whatever order they already arrive in
 * (stable) — see sortForExport below.
 */
export const FIXED_EXPORT_HR_ID_ORDER: readonly string[] = [
  "A-1", "A-2", "A-9", "A-3", "A-4", "A-7", "A-8", "A-10", "A-12", "A-13",
  "A-16", "B-122", "B-155", "B-157", "OF-0001", "PD-0001",
  "B-1", "B-3", "B-5", "B-7", "B-10", "B-12", "B-13", "B-14", "B-15", "B-23",
  "B-25", "B-28", "B-34", "B-40", "B-43", "B-55", "B-58", "B-52", "B-59",
  "B-65", "B-74", "B-76", "B-79", "B-82", "B-91", "B-95", "B-94", "B-96",
  "B-100", "B-97", "B-112", "B-111", "B-104", "B-115", "B-107", "B-113",
  "B-120", "B-108", "B-105", "B-116", "B-119", "B-118", "B-117", "B-125",
  "B-110", "B-124", "B-126", "B-129", "B-130", "B-128", "B-131", "B-151",
  "B-132", "B-133", "B-135", "B-143", "B-139", "B-141", "B-136", "B-144",
  "B-142", "B-140", "B-152", "B-154", "B-145", "B-137", "B-156", "B-161",
  "B-146", "B-147", "B-148", "B-158", "B-169", "B-164", "B-171", "B-162",
  "B-172", "B-166", "B-184", "B-170", "B-167", "B-175", "B-181", "B-176",
  "B-177", "B-182", "B-186", "B-179", "B-187", "B-178", "B-189", "PD-0005",
  "B-188", "CN-0002", "PD-0004", "AI-0001", "AI-0002", "CN-0001", "CN-0003",
  "CN-0004", "PD-0003", "A-14", "B-183", "B-106", "B-127", "B-138", "B-153",
];

const ORDER_INDEX = new Map<string, number>(
  FIXED_EXPORT_HR_ID_ORDER.map((hrId, index) => [compactHrKey(hrId), index]),
);

/**
 * Sorts rows for export by the fixed HR-ID order above.
 *
 * The owner's sequence stays authoritative for everyone it lists. Anyone NOT
 * listed is placed after them — but ordered by `fallbackKey` (line, then hire
 * date, then HR_ID) rather than by whatever arbitrary order they happened to
 * arrive in. That matters because the list is hand-maintained and drifts: as of
 * 2026-07-25 it held 123 IDs against 132 active employees, so every new hire
 * lands in this tail until someone edits this file. Deterministic grouping
 * keeps that tail readable for finance instead of random.
 *
 * Use `unlistedExportHrIds` to surface the drift itself — silently sorting it
 * nicely is not the same as anyone knowing the list is stale.
 */
export function sortForExport<T>(
  rows: readonly T[],
  hrIdOf: (row: T) => string,
  options?: { fallbackKey?: (row: T) => string },
): T[] {
  const withRank = rows.map((row, originalIndex) => ({
    row,
    originalIndex,
    rank: ORDER_INDEX.get(compactHrKey(hrIdOf(row))) ?? Number.POSITIVE_INFINITY,
    fallback: options?.fallbackKey ? options.fallbackKey(row) : "",
  }));
  withRank.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // Only unlisted rows share a rank (POSITIVE_INFINITY); listed ranks are unique.
    if (a.fallback !== b.fallback) return a.fallback < b.fallback ? -1 : 1;
    return a.originalIndex - b.originalIndex;
  });
  return withRank.map((entry) => entry.row);
}

/**
 * HR IDs present in the run but missing from FIXED_EXPORT_HR_ID_ORDER, in the
 * order they appear. Non-empty means the hand-maintained list has drifted and
 * these people are being appended to the end of finance's sheet.
 */
export function unlistedExportHrIds<T>(rows: readonly T[], hrIdOf: (row: T) => string): string[] {
  const unlisted: string[] = [];
  for (const row of rows) {
    const hrId = hrIdOf(row);
    if (!ORDER_INDEX.has(compactHrKey(hrId))) unlisted.push(hrId);
  }
  return unlisted;
}
