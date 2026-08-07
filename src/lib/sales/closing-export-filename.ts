import { monthLabel } from "@/lib/sales/monthly-closing-export";

/**
 * What a downloaded Monthly Closing workbook is called.
 *
 * The owner's order is MONTH, LINE, REGION:
 *   phoenix-monthly-closing-jul-2026-anti-infective-delta-2.xlsx
 *
 * A workbook that names its own scope survives being forwarded. Several files all called
 * "phoenix-monthly-closing.xlsx" sitting in one mail thread do not — and month, line and region is
 * exactly what someone has to ask about when they cannot tell two of them apart.
 */

/** Slug for one filename segment: lowercase, hyphenated, never empty. */
function slugSegment(value: string | null | undefined): string {
  return (
    (value ?? "all")
      .toString()
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "all"
  );
}

/**
 * The single region a workbook covers, or "all regions" when it spans more than one.
 *
 * Names, never codes — "Delta (2)", not "D2". Callers pass whatever region labels their own rows
 * carry (the matrix's region groups for the admin workbook, the detail rows' region names for the
 * scoped one), so a filtered export is named for the region it was actually narrowed to.
 *
 * Short-circuits on the second distinct name: the details workbook can hold tens of thousands of
 * rows and this only ever needs to know "one, or more than one".
 */
export function regionScopeLabel(regionNames: Iterable<string | null | undefined>): string {
  const distinct = new Set<string>();
  for (const name of regionNames) {
    const trimmed = (name ?? "").trim();
    if (trimmed) distinct.add(trimmed);
    if (distinct.size > 1) return "all regions";
  }
  const [only] = distinct;
  return only ?? "all regions";
}

/**
 * Build the download name. `kind: "details"` marks the row-level workbook the scoped sales roles
 * get, so it cannot be confused with the full matrix export of the same month, line and region.
 */
export function closingFileName(parts: {
  kind?: "details";
  line: string | null | undefined;
  period: string | null | undefined;
  region: string;
}): string {
  const stem = parts.kind ? `phoenix-monthly-closing-${parts.kind}` : "phoenix-monthly-closing";
  // monthLabel turns "2026-07" into "Jul 2026" — the same wording the sheets inside use, so the
  // file and its contents never disagree about which month this is.
  const month = slugSegment(monthLabel((parts.period ?? "").trim()));
  return `${stem}-${month}-${slugSegment(parts.line)}-${slugSegment(parts.region)}.xlsx`;
}
