import { monthLabel } from "@/lib/sales/monthly-closing-export";

/**
 * What a downloaded Monthly Closing workbook is called.
 *
 * Two shapes, by what the workbook covers (owner, 2026-10-20: "when exporting it by region,
 * manager-region-type; if the total sheet, then line name-month-type"):
 *
 *   one region   <manager>-<region>-<type>-<month>      mohamed-ali-delta-2-monthly-closing-jul-2026.xlsx
 *   the total    <line>-<month>-<type>                  anti-infective-jul-2026-monthly-closing.xlsx
 *
 * The MONTH is kept at the end of the region shape although the owner's pattern did not list it: the
 * reader saves one region's file for several months, and without it they would all share one name.
 * The manager is the one who runs that region on the line's organogram; where none can be named the
 * region leads, so the name never carries a blank or a code.
 *
 * A workbook that names its own scope survives being forwarded. Several files all called
 * "phoenix-monthly-closing.xlsx" sitting in one mail thread do not.
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

/** The label `regionScopeLabel` gives a workbook that spans more than one region, or none. */
const ALL_REGIONS_LABEL = "all regions";

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
    if (distinct.size > 1) return ALL_REGIONS_LABEL;
  }
  const [only] = distinct;
  return only ?? ALL_REGIONS_LABEL;
}

/** True when `region` names one region, as `regionScopeLabel` returns it. */
export function coversOneRegion(region: string | null | undefined): boolean {
  const label = (region ?? "").trim().toLowerCase();
  return label !== "" && label !== ALL_REGIONS_LABEL;
}

/**
 * Build the download name. `kind` marks a workbook that is not the default matrix export, so two files
 * covering the same month, line and region cannot be confused with each other:
 *   "details" — the row-level workbook the scoped sales roles get.
 *   "premium" — the reader's ten-sheet workbook behind the closing screen's SECOND export button.
 *   "consolidated" / "premium-consolidated" — the same two workbooks with several months added
 *   together. `period` is then the span as words ("Jul 2026 to Sep 2026"), which monthLabel passes
 *   through unchanged, so the file reads jul-2026-to-sep-2026 and can never pass for a single month.
 */
export function closingFileName(parts: {
  /**
   * The name of the manager who runs the one region this workbook covers. Ignored for a workbook
   * that spans several regions. Names, never codes; null names no one and the region leads.
   */
  manager?: string | null;
  /**
   * "xlsm" (the default for the premium workbook) or "xlsx". The premium workbook is the owner's
   * macro-enabled engine and can be served either way. The .xlsm keeps his button bar live — 36
   * buttons across 11 drawings, Export PDF among them, and Export PDF has no macro-free equivalent
   * inside a workbook. The .xlsx removes the buttons rather than ship shortcuts that cannot fire,
   * since a .xlsx holds no code and a button in one can never be made to work. Either way the
   * extension has to follow what was actually built.
   */
  extension?: "xlsm" | "xlsx";
  kind?: "details" | "premium" | "consolidated" | "premium-consolidated";
  line: string | null | undefined;
  period: string | null | undefined;
  region: string;
}): string {
  const type = parts.kind ? `monthly-closing-${parts.kind}` : "monthly-closing";
  // monthLabel turns "2026-07" into "Jul 2026" — the same wording the sheets inside use, so the
  // file and its contents never disagree about which month this is.
  const month = slugSegment(monthLabel((parts.period ?? "").trim()));
  const extension = parts.extension ?? "xlsx";
  if (!coversOneRegion(parts.region)) return `${slugSegment(parts.line)}-${month}-${type}.${extension}`;
  const manager = (parts.manager ?? "").trim();
  const lead = manager ? [slugSegment(manager), slugSegment(parts.region)] : [slugSegment(parts.region)];
  return `${[...lead, type, month].join("-")}.${extension}`;
}
