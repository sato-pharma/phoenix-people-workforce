// Naming a CONSOLIDATED closing — several months of one line added together — in both workbooks.
//
// Owner, 2026-09-14: from the closing screen, pick several months of one line and download one
// consolidated file, in the closing's own workbook AND in the premium one. Super Admin and the CEO
// only. The whole workbook, summed; any month on the screen; the store split worked out per month
// and then added.
//
// Pure: no database, so the rules and the labelling can be tested on their own. The loading lives in
// monthly-closing-consolidated-export.ts and closing-consolidated-premium-export.ts.
//
// Both workbooks are written by builders that know about ONE month. Rather than teach either of them
// a second vocabulary, each is built for the LATEST month of the selection and then relabelled here,
// so a file covering July to September can never say "September" where it means all three:
//
//   - the premium engine fill is a plain object of cell values, so its captions are rewritten before
//     the engine is filled — never the engine itself;
//   - the normal workbook stamps `Month: 2026-09` in every sheet's band header, and that exact text is
//     replaced inside the finished file's XML parts.

import JSZip from "jszip";

import type { ClosingEngineFill, EngineSheetFill, EngineValue } from "@/lib/sales/closing-engine-fill";
import { MAX_PERIOD_SELECTION, parsePeriodSelection, periodLabel } from "@/lib/sales/monthly-closing-period-merge";

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Who may download a consolidated closing. Owner, 2026-09-14, asked and answered: "Super Admin + CEO".
 *
 * Asked of the ROLE and nothing wider. `sales:export` reaches down to Medical Rep and system scope is
 * not a person, so neither is a stand-in for this answer. Both routes and the screen ask this one
 * function, so the button can never be offered to someone the route refuses.
 */
export function canExportConsolidatedClosing(role: string | null | undefined): boolean {
  return role === "Super Admin" || role === "CEO";
}

/** One month is the ordinary closing, which already has its own three buttons. */
export const MIN_CONSOLIDATED_MONTHS = 2;

/** A selection the consolidated export cannot build — answered as a 400 with this message. */
export class ConsolidatedClosingSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsolidatedClosingSelectionError";
  }
}

/** Read the months off a request body: 2 to 12 real `YYYY-MM` periods, sorted and de-duplicated. */
export function resolveConsolidatedPeriods(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map((value) => String(value ?? "")) : typeof raw === "string" ? raw : null;
  const periods = parsePeriodSelection(list).filter((period) => PERIOD.test(period));
  if (periods.length < MIN_CONSOLIDATED_MONTHS) {
    throw new ConsolidatedClosingSelectionError("Pick at least two months to download a consolidated closing.");
  }
  if (periods.length > MAX_PERIOD_SELECTION) {
    throw new ConsolidatedClosingSelectionError(
      `A consolidated closing covers at most ${MAX_PERIOD_SELECTION} months. Pick fewer months.`,
    );
  }
  return periods;
}

function orderedPeriods(periods: readonly string[]): string[] {
  return Array.from(new Set(periods.map((period) => String(period ?? "").trim()).filter((period) => PERIOD.test(period)))).sort();
}

function monthNumber(period: string): number {
  return Number(period.slice(5, 7));
}

function monthIndex(period: string): number {
  return Number(period.slice(0, 4)) * 12 + monthNumber(period);
}

function shortLabel(period: string): string {
  return `${SHORT_MONTHS[monthNumber(period) - 1] ?? ""} ${period.slice(0, 4)}`.trim();
}

function isContiguous(ordered: readonly string[]): boolean {
  return ordered.every((period, index) => index === 0 || monthIndex(period) === monthIndex(ordered[index - 1]) + 1);
}

/**
 * The span, short — for the premium workbook's captions, which sit in A1 beside the emblem and have
 * no room to spare: "Jul–Sep 2026", "Nov 2025–Feb 2026", or for a selection with a gap in it
 * "Jul, Sep 2026".
 *
 * Never a "·": the premium Contents sheet splits Overview's A1 on its last dot, so a dot in the month
 * would cut the title in the wrong place. A gap is listed rather than drawn as a range, because
 * "Jul–Sep" over July and September claims an August that was not selected.
 */
export function consolidatedSpanLabel(periods: readonly string[]): string {
  const ordered = orderedPeriods(periods);
  if (ordered.length === 0) return "";
  if (ordered.length === 1) return shortLabel(ordered[0]);
  if (isContiguous(ordered)) {
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    return first.slice(0, 4) === last.slice(0, 4)
      ? `${SHORT_MONTHS[monthNumber(first) - 1]}–${shortLabel(last)}`
      : `${shortLabel(first)}–${shortLabel(last)}`;
  }
  const byYear = new Map<string, string[]>();
  for (const period of ordered) {
    const year = period.slice(0, 4);
    byYear.set(year, [...(byYear.get(year) ?? []), SHORT_MONTHS[monthNumber(period) - 1]]);
  }
  return [...byYear.entries()].map(([year, names]) => `${names.join(", ")} ${year}`).join(", ");
}

/**
 * The span, in full — for the normal workbook's band headers and the notes, which wrap:
 * "July 2026 to September 2026 (3 months)", or "July 2026, September 2026 (2 months)" with a gap.
 */
export function describeConsolidatedMonths(periods: readonly string[]): string {
  const ordered = orderedPeriods(periods);
  if (ordered.length === 0) return "";
  if (ordered.length === 1) return periodLabel(ordered[0]);
  const months = `(${ordered.length} months)`;
  return isContiguous(ordered)
    ? `${periodLabel(ordered[0])} to ${periodLabel(ordered[ordered.length - 1])} ${months}`
    : `${ordered.map((period) => periodLabel(period)).join(", ")} ${months}`;
}

/** The span as a filename's month segment: "Jul 2026 to Sep 2026" → jul-2026-to-sep-2026. */
export function consolidatedFilePeriod(periods: readonly string[]): string {
  const ordered = orderedPeriods(periods);
  if (ordered.length === 0) return "";
  if (ordered.length === 1) return ordered[0];
  return `${shortLabel(ordered[0])} to ${shortLabel(ordered[ordered.length - 1])}`;
}

type NamedOption = { code: string; label?: string; name?: string };

/** The on-screen filter in human names — names, never codes (standing owner rule). */
export function consolidatedFilterParts(
  filter: { areaCodes: readonly string[]; productCodes: readonly string[]; regionCodes: readonly string[]; search: string },
  options: { areas: readonly NamedOption[]; products: readonly NamedOption[]; regions: readonly NamedOption[] },
): string[] {
  const nameOf = (list: readonly NamedOption[], code: string) => {
    const found = list.find((item) => item.code.trim().toUpperCase() === code.trim().toUpperCase());
    return found?.name ?? found?.label ?? code;
  };
  const parts: string[] = [];
  if (filter.regionCodes.length > 0) {
    parts.push(`Region: ${filter.regionCodes.map((code) => nameOf(options.regions, code)).join(", ")}`);
  }
  if (filter.areaCodes.length > 0) {
    parts.push(`Area: ${filter.areaCodes.map((code) => nameOf(options.areas, code)).join(", ")}`);
  }
  if (filter.productCodes.length > 0) {
    parts.push(`Product: ${filter.productCodes.map((code) => nameOf(options.products, code)).join(", ")}`);
  }
  if (filter.search.trim()) parts.push(`Area search: "${filter.search.trim()}"`);
  return parts;
}

/**
 * The note every sheet of a consolidated workbook carries.
 *
 * Always present, filtered or not, because a total several months deep is the first thing a reader
 * has to know before trusting it — and a month that was asked for but had no closing is named here
 * rather than silently missing from the sum.
 */
export function describeConsolidatedClosing(input: {
  filterParts: readonly string[];
  /** Single-month sheets this workbook leaves out. */
  leftOutSheets?: readonly string[];
  line: string | null;
  /** True for the premium workbook, whose growth columns compare against one prior month. */
  noPriorComparison?: boolean;
  periods: readonly string[];
  skipped: readonly string[];
  /** Months the store split was not applied to, left out of the Store Split sheets. */
  storeSplitOmitted?: readonly string[];
}): string {
  const list = (periods: readonly string[]) => orderedPeriods(periods).map((period) => periodLabel(period)).join(", ");
  const parts = [
    `Consolidated closing${input.line ? ` for ${input.line}` : ""}: ${describeConsolidatedMonths(input.periods)}, added together.`
      + " Each month is worked out exactly as its own closing is, store split included, and only then added.",
  ];
  if (input.skipped.length > 0) {
    parts.push(`Not included, because the closing has no data for them: ${list(input.skipped)}.`);
  }
  if (input.storeSplitOmitted && input.storeSplitOmitted.length > 0) {
    parts.push(`The Store Split sheets leave out ${list(input.storeSplitOmitted)}, which the split did not apply to.`);
  }
  if (input.noPriorComparison) {
    parts.push("There is no prior-month comparison: a span of months has no single month before it.");
  }
  if (input.filterParts.length > 0) {
    parts.push(`This workbook covers only: ${input.filterParts.join(" · ")}.`);
  }
  if (input.leftOutSheets && input.leftOutSheets.length > 0) {
    parts.push(`Left out, because each describes a single month: ${input.leftOutSheets.join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * The captions a consolidated premium workbook must not print as they are.
 *
 * The engine names "the month before this one" in these cells and measures growth against it. A span
 * has no single month before it, so the cells say so instead of naming a month the figures beside
 * them were never compared with. The growth figure itself is blanked for the same reason.
 */
export const CONSOLIDATED_PRIOR_CELLS: Record<string, Record<string, EngineValue>> = {
  Overview: {
    H8: "Prior value",
    I4: "Against prior month",
    I5: null,
    I8: "Against prior month",
  },
  "Rep Card": { N4: "The prior month" },
  "Rep Ranking": { J4: "Against prior month" },
};

/**
 * Rewrite a premium engine fill built for the LATEST month so it names the whole span.
 *
 * Every caption cell and footnote carrying that month's label ("September 2026") gets the span
 * instead, and the prior-month captions are neutralised. Data rows are left alone: they carry
 * figures and names, and Family by Month's rows are genuinely one column per month. Family by Month's
 * NOTES are left alone too, because they name where its month-by-month series starts.
 */
export function consolidateEngineFill(
  fill: ClosingEngineFill,
  input: { latestPeriod: string | null; periods: readonly string[] },
): ClosingEngineFill {
  const latest = input.latestPeriod ? periodLabel(input.latestPeriod) : "";
  const span = consolidatedSpanLabel(input.periods);
  const monthCount = orderedPeriods(input.periods).length;
  const swap = (value: EngineValue): EngineValue =>
    typeof value === "string" && latest && span ? value.split(latest).join(span) : value;

  const sheets: Record<string, EngineSheetFill> = {};
  for (const [name, sheet] of Object.entries(fill.sheets)) {
    const next: EngineSheetFill = { ...sheet };
    if (sheet.cells) {
      next.cells = Object.fromEntries(Object.entries(sheet.cells).map(([ref, value]) => [ref, swap(value)]));
    }
    if (sheet.notes && name !== "Family by Month") {
      next.notes = sheet.notes.map((note) => String(swap(note)));
    }
    const prior = CONSOLIDATED_PRIOR_CELLS[name];
    if (prior) {
      next.cells = {
        ...next.cells,
        ...prior,
        ...(name === "Overview" ? { I6: `not compared: ${monthCount} months added together` } : {}),
      };
    }
    sheets[name] = next;
  }
  return { ...fill, sheets };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Relabel a finished normal closing workbook built for the LATEST month of a selection.
 *
 * Every sheet's band header reads `Month: 2026-09`; that exact text becomes
 * `Months: July 2026 to September 2026 (3 months)`. Only the shared-string table and the worksheet
 * parts are touched, and only that literal, so no figure, formula or style can move.
 */
export async function relabelConsolidatedWorkbook(
  buffer: Buffer,
  input: { latestPeriod: string; periods: readonly string[] },
): Promise<Buffer> {
  const from = `Month: ${input.latestPeriod}`;
  const to = escapeXml(`Months: ${describeConsolidatedMonths(input.periods)}`);
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files).filter(
    (name) => name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );
  for (const name of parts) {
    const xml = await zip.file(name)!.async("string");
    if (xml.includes(from)) zip.file(name, xml.split(from).join(to));
  }
  return Buffer.from(await zip.generateAsync({ compression: "DEFLATE", type: "nodebuffer" }));
}
