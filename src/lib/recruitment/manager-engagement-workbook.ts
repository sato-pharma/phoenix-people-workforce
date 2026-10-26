// Recruitment / ATS — the silent manager-engagement report as an XLSX.
//
// THREE SHEETS, and the third is the reason the file exists at all. "Cover" carries the provenance
// (who exported it, when, in what scope, under which filter) plus the one caveat without which the
// numbers are misread. "Managers" is the table on screen. "CVs" is every expanded row flattened —
// one line per (manager, CV) — which is the sheet somebody can actually sort and filter to answer
// "which unopened CVs are the oldest, and who is sitting on them".
//
// IT MATCHES THE SCREEN, BY CONSTRUCTION. The manager filter, the area grouping, the inactive
// wording and the Cairo date all come from manager-engagement-presentation.ts, the same module the
// page renders from. The totals on the Cover are recomputed from the rows this workbook actually
// writes rather than copied off the report — a filtered export whose cover quoted the unfiltered
// report's totals would state a number its own sheets do not add up to.
//
// STILL SILENT. Building this reads the report and nothing else: no CV is fetched, so no "opened"
// mark is written, and the export cannot pollute the very signal it is measuring. See the header of
// manager-cv-engagement.ts for why that matters.
//
// NO OUTLINE GROUPS AND NO IMAGES, deliberately. ExcelJS emits two schema-invalid OOXML fragments —
// `outlineProperties` alongside `pageSetup.fitToPage` writes the children of <sheetPr> out of
// sequence, and `addImage` always writes `editAs` on <xdr:oneCellAnchor> — and either makes Excel
// silently "repair" the workbook on open. This builder uses neither, so the bytes need no
// post-processing of the .xlsx zip.

import ExcelJS from "exceljs";

// The HOUSE helpers for the cover and the tables — SATO-DIS-2026-01 v1.0. `phoenix-xlsx-style`
// keeps serving the families that still read it, and its helpers reach `sales-workbook-kit`,
// which the LOCKED Weekly Summarized Report shares — so it is not changed here.
import { buildHouseCoverSheet, writeHouseTable } from "@/lib/export/house-table-workbook";

import { systemLegalEntity } from "@/config/system-settings";
import {
  phoenixBandHeader,
  sanitizeSheetName,
  UNITS_FMT,
  type CellValue,
  type TableColumn,
} from "@/lib/export/phoenix-xlsx-style";
import { candidateStatusLabel } from "@/lib/recruitment/candidate-status";
import { managerLabel } from "@/lib/recruitment/person-labels";
import type { ManagerCvEngagementReport, ManagerCvEngagementRow } from "@/lib/recruitment/manager-cv-engagement";
import { distinctEngagementTotals } from "@/lib/recruitment/manager-cv-engagement-totals";
import {
  cairoCalendarDay,
  cairoEngagementStamp,
  groupEngagementCandidatesByArea,
  managerStatusText,
} from "@/lib/recruitment/manager-engagement-presentation";

/** Excel's day 0 is 1899-12-30; a UTC-anchored instant divided into days lands on its serial. */
const EXCEL_EPOCH_OFFSET_DAYS = 25_569;
const MS_PER_DAY = 86_400_000;

/**
 * A Cairo calendar day as an Excel date serial, so the Arrived column SORTS.
 *
 * Written as a number with a `dd mmm yyyy` format rather than as the display text: the whole point
 * of the CVs sheet is to sort by arrival and find the oldest thing nobody opened, and "05 Sep 2026"
 * as text sorts alphabetically. The Cairo day is resolved first and only then anchored at UTC
 * midnight — an Excel date carries no zone, so anchoring it any other way is what makes a CV that
 * arrived at 01:00 Cairo show up in the sheet on the previous day.
 */
export function cairoDateSerial(iso: string | null | undefined): number | null {
  const day = cairoCalendarDay(iso);
  if (!day) return null;
  return Date.UTC(day.year, day.month - 1, day.day) / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS;
}

const DATE_FMT = "dd mmm yyyy";

/**
 * The one caveat that must travel with the file. Without it the "Not opened" column reads as an
 * accusation rather than as a backlog: opens are only counted from the day the feature shipped, so a
 * CV a manager read on paper months ago still reads as not-opened. Kept in step with the amber band
 * the screen shows above the same table.
 */
export const ENGAGEMENT_READING_NOTE =
  "“Received” is every CV in the manager’s My Candidates folder — the ones in their areas plus " +
  "anything sent straight to them — not only what was hand-pushed. A CV counts as “Opened” once they " +
  "open it in the app. Nothing recorded an open before tracking began, so a CV that arrived before then " +
  "shows as not opened even if it was read. “Answered” has full history — it reads the candidate’s " +
  "recorded decision — so an older CV can show not opened yet answered. The totals count each CV once: " +
  "a CV sent to two managers is one CV there, and appears in both managers’ rows.";

const CONFIDENTIAL_NOTE =
  "Confidential — this report names managers and measures whether they are reading the CVs sent to them. " +
  "The managers it measures are not shown it. Do not forward this file to them.";

export type ManagerEngagementExportMeta = {
  /** When the export was taken, as an instant — rendered in Cairo on the Cover. */
  generatedAtIso: string;
  /** Who took it, human-readable, falling back to the HR_ID when the directory has no name. */
  exportedBy: string;
  /** Their role, so the Cover says what scope the numbers were produced under. */
  role: string;
  /** The manager filter that was in the search box, verbatim; blank when the sheet covers everyone. */
  filterQuery: string;
};

const MANAGER_COLUMNS: TableColumn[] = [
  { label: "Manager", width: 28 },
  { label: "Job title", width: 26 },
  { label: "Area", width: 18 },
  { label: "Line", width: 16 },
  { label: "Status", width: 26 },
  { label: "Received", numFmt: UNITS_FMT, right: true, width: 11 },
  { label: "Opened", numFmt: UNITS_FMT, right: true, width: 10 },
  { label: "Not opened", numFmt: UNITS_FMT, dataBar: true, right: true, width: 13 },
  { label: "Answered", numFmt: UNITS_FMT, right: true, width: 11 },
];

const CV_COLUMNS: TableColumn[] = [
  { label: "Manager", width: 28 },
  { label: "Area", width: 22 },
  { label: "Candidate", width: 30 },
  { label: "Arrived", numFmt: DATE_FMT, width: 14 },
  { label: "Opened", width: 12 },
  { label: "Answered", width: 12 },
  { label: "Decision", width: 18 },
];

/**
 * The manager's display name, exactly as the screen resolves it.
 *
 * Routed through the SHARED helper rather than kept as a second copy: the owner's rule is that an
 * export matches the screen, and this function's whole reason for existing is that promise. It used
 * to fall back to the HR_ID, and so did the screen — so the two agreed, on a raw code the rule
 * forbids. They still agree, now on words.
 */
function managerRowLabel(row: ManagerCvEngagementRow): string {
  return managerLabel(row.managerName);
}

function managerRows(rows: readonly ManagerCvEngagementRow[]): CellValue[][] {
  return rows.map((row) => [
    managerRowLabel(row),
    row.managerJobTitle ?? "",
    row.managerArea ?? "",
    row.managerLine ?? "",
    managerStatusText(row),
    row.received,
    row.opened,
    row.notOpened,
    row.answered,
  ]);
}

/**
 * Every CV behind every manager, flattened — manager order, then the screen's area order, then the
 * newest CV first inside each area. Both orderings come from the report and the shared grouper, so
 * scrolling this sheet walks the page's expanded rows top to bottom.
 */
function candidateRows(rows: readonly ManagerCvEngagementRow[]): CellValue[][] {
  const flat: CellValue[][] = [];
  for (const row of rows) {
    const name = managerRowLabel(row);
    for (const group of groupEngagementCandidatesByArea(row.candidates)) {
      for (const candidate of group.list) {
        flat.push([
          name,
          group.area,
          candidate.candidateName || "Unnamed candidate",
          cairoDateSerial(candidate.arrivedAt),
          candidate.opened ? "Opened" : "Not opened",
          candidate.answered ? "Answered" : "Awaiting",
          candidateStatusLabel(candidate.status),
        ]);
      }
    }
  }
  return flat;
}

/**
 * Fold the rows this workbook writes into the headline counts its Cover quotes — each CV once, however
 * many managers hold it, exactly as the screen's tiles count them.
 */
function totalsOf(rows: readonly ManagerCvEngagementRow[]) {
  return distinctEngagementTotals(rows);
}

export async function buildManagerEngagementWorkbook(input: {
  report: ManagerCvEngagementReport;
  meta: ManagerEngagementExportMeta;
}): Promise<Buffer> {
  const { meta } = input;
  const rows = input.report.rows;
  const totals = totalsOf(rows);
  const stamp = cairoEngagementStamp(meta.generatedAtIso);
  const scopeLabel = input.report.scoped ? "Your line only" : "All lines";
  const filterLabel = meta.filterQuery.trim();

  const workbook = new ExcelJS.Workbook();

  buildHouseCoverSheet(workbook, {
    title: "Manager CV Engagement",
    subtitle: `${stamp} · ${scopeLabel}`,
    confidentialNote: CONFIDENTIAL_NOTE,
    rows: [
      ["Generated", stamp],
      ["Generated by", `${meta.exportedBy} · ${meta.role}`],
      ["Scope", scopeLabel],
      // Named even when nothing was typed. An export must match the screen, and a sheet that is
      // silent about a filter is one somebody later reads as the whole company.
      ["Manager filter", filterLabel ? `“${filterLabel}”` : "None — every manager in scope"],
      ["Managers", String(totals.managers)],
      ["CVs received", String(totals.received)],
      ["Opened", String(totals.opened)],
      ["Not opened", String(totals.notOpened)],
      ["Answered", String(totals.answered)],
      ["Reading these numbers", ENGAGEMENT_READING_NOTE],
    ],
  });

  const managerSheet = workbook.addWorksheet(sanitizeSheetName("Managers"), {
    properties: { defaultColWidth: 16 },
  });
  phoenixBandHeader(managerSheet, MANAGER_COLUMNS.length, "Manager CV Engagement", `${stamp} · ${scopeLabel}`);
  writeHouseTable(managerSheet, 4, {
    columns: MANAGER_COLUMNS,
    rows: managerRows(rows),
    title: "Managers",
    // Distinct CVs, like the Cover: a CV two managers hold is one CV here, so this line can be lower
    // than the column above it adds up to.
    totals: ["Total CVs, each counted once", "", "", "", "", totals.received, totals.opened, totals.notOpened, totals.answered],
    note: ENGAGEMENT_READING_NOTE,
  });
  managerSheet.views = [{ state: "frozen", ySplit: 5, showGridLines: false }];

  const cvSheet = workbook.addWorksheet(sanitizeSheetName("CVs"), { properties: { defaultColWidth: 16 } });
  phoenixBandHeader(cvSheet, CV_COLUMNS.length, "Manager CV Engagement — every CV", `${stamp} · ${scopeLabel}`);
  const cvRows = candidateRows(rows);
  writeHouseTable(cvSheet, 4, {
    columns: CV_COLUMNS,
    rows: cvRows,
    title: "CVs behind the numbers",
    note:
      cvRows.length === 0
        ? "No CVs in scope."
        : "One line per manager and CV. A CV that reached two managers appears once under each of them.",
  });
  cvSheet.views = [{ state: "frozen", ySplit: 5, showGridLines: false }];
  // AutoFilter over the header row: this is the sheet somebody sorts by Arrived to find the oldest
  // thing nobody opened, which is the whole reason it is here rather than only the summary above.
  if (cvRows.length > 0) {
    cvSheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + cvRows.length, column: CV_COLUMNS.length } };
  }

  // The file's author and company are the COMPANY that issued it, not the software that rendered it.
  workbook.creator = systemLegalEntity.legalNameEn;
  workbook.company = systemLegalEntity.legalNameEn;
  workbook.created = new Date(meta.generatedAtIso);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** `manager-cv-engagement-2026-09-05.xlsx` — the Cairo day the file was taken, never a UTC one. */
export function managerEngagementExportFilename(generatedAtIso: string): string {
  // An unparseable stamp falls back to TODAY's Cairo day rather than to a UTC one — the filename is
  // the only date most readers of a saved file ever look at.
  const day = cairoCalendarDay(generatedAtIso) ?? cairoCalendarDay(new Date().toISOString());
  if (!day) return "manager-cv-engagement.xlsx";
  const two = (value: number) => String(value).padStart(2, "0");
  return `manager-cv-engagement-${day.year}-${two(day.month)}-${two(day.day)}.xlsx`;
}
