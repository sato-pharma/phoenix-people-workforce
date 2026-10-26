// ── Several sheets of ONE distributor, validated once ─────────────────────────────────────────────
//
// The owner, 2026-10-26: "make me able to upload bulk same distributor … I choose 5 or 6 same
// distributor sheet, and then do a once validate for the bulk." A distributor that sends its month as
// several files (one per branch, one per warehouse) used to need one full verify → validate → confirm
// per file — and because every confirm SUPERSEDES the distributor's earlier batch for that month, the
// second file replaced the first instead of joining it. Only one file per month ever survived.
//
// So the files are recognized one by one, and their rows are COMBINED before anything is checked:
//   • files of the same month become ONE batch — validated once, confirmed once, nothing superseded
//     between them;
//   • files of different months become one batch per month, all checked before any is stored.
//
// Everything here is pure, so the rules can be proven without uploading a file. The recognizing,
// validating and storing live in sales-upload.ts (analyzeMonthlyUploadFiles / commitMonthlyUploadFiles).

import type { NormalizeResult } from "@/lib/sales/normalizer/types";
import type { NormalizePreview } from "@/lib/sales/recognize";
import type { PeriodDecision } from "@/lib/sales/sales-upload";
import type { ValidationFinding, ValidationReport } from "@/lib/sales/upload-validation";

/** The most files one upload takes. Six is what he named; a little room above it, never unbounded. */
export const MAX_UPLOAD_FILES = 12;

// A combined result still has to say WHICH file a row came from, and every finding cites rows by
// `rawRowNumber`. So each file's rows are shifted into their own block of numbers: file 1 keeps its
// own, file 2 starts at 10,000,000, file 3 at 20,000,000. An Excel sheet holds 1,048,576 rows at most,
// so a block can never run into the next one. The shifted number lives only in memory — the stored
// rows are numbered by position (buildNormalizedImportRows) — and labelReportRows turns every cited
// row back into "<file> row <n>" before anyone sees it.
export const ROW_FILE_STRIDE = 10_000_000;

export function encodeFileRow(fileIndex: number, rawRowNumber: number): number {
  return fileIndex * ROW_FILE_STRIDE + rawRowNumber;
}

export function decodeFileRow(encoded: number): { fileIndex: number; rawRowNumber: number } {
  return { fileIndex: Math.floor(encoded / ROW_FILE_STRIDE), rawRowNumber: encoded % ROW_FILE_STRIDE };
}

/**
 * One NormalizeResult for several files of the same distributor, every row kept.
 *
 * Nothing is dropped or deduplicated here: two files that carry the same sale are a double count,
 * and the strict validator's duplicate check (run on this combined result) is what finds it. The one
 * thing merged is the customer→brick self-heal list, which is last-row-wins per customer within a
 * file already and stays so across files.
 */
export function mergeNormalizeResults(
  distributorCode: string,
  parts: readonly { fileIndex: number; result: NormalizeResult }[],
): NormalizeResult {
  const shift = <T extends { rawRowNumber: number }>(rows: readonly T[], fileIndex: number): T[] =>
    rows.map((r) => ({ ...r, rawRowNumber: encodeFileRow(fileIndex, r.rawRowNumber) }));
  const corrections = new Map<string, NormalizeResult["customerBrickCorrections"][number]>();
  for (const { result } of parts) {
    for (const c of result.customerBrickCorrections) {
      const key = `${c.distributorCode}|${c.customerCode}`;
      corrections.delete(key); // re-insert so the last file's correction is also the last in order
      corrections.set(key, c);
    }
  }
  const sum = (pick: (s: NormalizeResult["summary"]) => number) =>
    parts.reduce((total, p) => total + pick(p.result.summary), 0);
  const scanned = parts.every((p) => typeof p.result.summary.scannedDataRows === "number")
    ? sum((s) => s.scannedDataRows ?? 0)
    : undefined;
  const cellCorrections = parts.flatMap((p) => shift(p.result.cellCorrections ?? [], p.fileIndex));
  return {
    coded: parts.flatMap((p) => shift(p.result.coded, p.fileIndex)),
    distributorCode,
    exceptions: parts.flatMap((p) => shift(p.result.exceptions, p.fileIndex)),
    ignoredRows: parts.flatMap((p) => shift(p.result.ignoredRows, p.fileIndex)),
    blankCustomerRows: parts.flatMap((p) => shift(p.result.blankCustomerRows, p.fileIndex)),
    customerBrickCorrections: [...corrections.values()],
    ...(cellCorrections.length > 0 ? { cellCorrections } : {}),
    summary: {
      brickResolved: sum((s) => s.brickResolved),
      blankCustomerSkipped: sum((s) => s.blankCustomerSkipped),
      fullyCoded: sum((s) => s.fullyCoded),
      ignored: sum((s) => s.ignored),
      productResolved: sum((s) => s.productResolved),
      totalRows: sum((s) => s.totalRows),
      ...(scanned === undefined ? {} : { scannedDataRows: scanned }),
    },
  };
}

/** What the planner needs to know about one recognized file. */
export type UploadFileFacts = {
  fileName: string;
  /** Every distinct month its dated rows carry, "YYYY-MM". Empty when the sheet has no dates. */
  months: string[];
  /** The month most of its rows carry, or null. */
  dominantMonth: string | null;
};

export type UploadFileGroup = {
  /** Indexes into the files list, in upload order. */
  members: number[];
  decision: PeriodDecision;
};

export type UploadFilePlan = { ok: true; groups: UploadFileGroup[] } | { ok: false; message: string };

const VALID_PERIOD = /^\d{4}-\d{2}$/;

/**
 * Which batch each file lands in.
 *
 *  • A month is picked → every file is filed under it (as one file is today), unless the files are
 *    plainly of DIFFERENT months: filing six monthly files under one month would add half a year into
 *    it, so that is refused with the months named. A file whose own rows stray into a neighbouring
 *    month is still allowed; the re-dated-rows warning names those rows, exactly as for one file.
 *  • No month is picked and every file is of one month → one batch per month.
 *  • No month is picked and some file has no dates, or spans months → one combined group whose
 *    decision says so ("missing" / "multi"), so analyze shows the same refusal one file would and
 *    commit refuses it. A date-less file is never folded into its neighbours' month silently: its
 *    rows would carry no month and the store would leave them out.
 */
export function planUploadFiles(files: readonly UploadFileFacts[], override: string): UploadFilePlan {
  const picked = String(override ?? "").trim();
  if (VALID_PERIOD.test(picked)) {
    const dominant = [...new Set(files.map((f) => f.dominantMonth).filter((m): m is string => Boolean(m)))].sort();
    if (dominant.length > 1) {
      const byMonth = dominant.map((month) => `${month}: ${files.filter((f) => f.dominantMonth === month).map((f) => f.fileName).join(", ")}`);
      return {
        ok: false,
        message:
          `These ${files.length} files are for ${dominant.length} different months (${byMonth.join("; ")}), so they cannot all be filed under ${picked}. ` +
          "Clear the period to file each month as its own batch, or choose only that month's files.",
      };
    }
    return { ok: true, groups: [{ members: files.map((_, i) => i), decision: { kind: "ok", period: picked, consolidate: true } }] };
  }
  if (files.every((f) => f.months.length === 1)) {
    const byMonth = new Map<string, number[]>();
    files.forEach((f, i) => byMonth.set(f.months[0], [...(byMonth.get(f.months[0]) ?? []), i]));
    return {
      ok: true,
      groups: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([period, members]) => ({
        members,
        decision: { kind: "ok", period, consolidate: false },
      })),
    };
  }
  const all = files.map((_, i) => i);
  if (files.some((f) => f.months.length === 0)) return { ok: true, groups: [{ members: all, decision: { kind: "missing" } }] };
  const periods = [...new Set(files.flatMap((f) => f.months))].sort();
  return { ok: true, groups: [{ members: all, decision: { kind: "multi", periods } }] };
}

/** The figures that identify one sheet's contents, for the same-sheet-twice check. */
export type UploadFileFingerprint = { fileName: string; digest: string; rows: number; qty: number; value: number };

/**
 * The refusal when the same sheet is in the selection twice, or null.
 *
 * Picked twice, or saved twice under two names, a sheet would be counted twice in its month — and
 * the duplicate-row check cannot always see it, because a distributor whose rows carry no invoice
 * number keys duplicates by row position. So the same bytes, or the same rows, quantity and value to
 * the last decimal, refuse the upload. A double count is one of the two things that block (sales-imports).
 */
export function findRepeatedSheet(files: readonly UploadFileFingerprint[]): string | null {
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      const a = files[i];
      const b = files[j];
      const sameBytes = a.digest === b.digest;
      const sameFigures = a.rows > 0 && a.rows === b.rows && a.qty === b.qty && a.value === b.value;
      if (sameBytes || sameFigures) {
        const how = sameBytes ? "are the same file" : `carry the same ${a.rows.toLocaleString("en-US")} rows, quantity and value`;
        return `"${a.fileName}" and "${b.fileName}" ${how}, so the month would be counted twice. Remove one of them and validate again.`;
      }
    }
  }
  return null;
}

/** The name the combined batch is stored under: every file, in upload order. */
export function combinedFileName(fileNames: readonly string[]): string {
  return fileNames.join(" + ");
}

/** A finding with its cited rows named by file — "branch-2.xlsx row 14". */
export type LabelledFinding = ValidationFinding & { sampleRowLabels?: string[] };

function rowLabel(fileNames: readonly string[], encoded: number): string {
  const { fileIndex, rawRowNumber } = decodeFileRow(encoded);
  return `${fileNames[fileIndex] ?? `File ${fileIndex + 1}`} row ${rawRowNumber}`;
}

/**
 * Every "Row <n>" a sentence cites, named by its file — "Branch-2.xlsx row 14". The sentences that
 * write a row into the text (row-messages.ts, and the Normalizer's "Row 145: product … not mapped")
 * would read the shifted number otherwise. With one file the sentence is returned as it is.
 */
export function labelRowText(text: string, fileNames: readonly string[]): string {
  if (fileNames.length < 2) return text;
  return text.replace(/\bRow (\d+)/g, (_match, n: string) => {
    const label = rowLabel(fileNames, Number(n));
    return label.charAt(0).toUpperCase() + label.slice(1);
  });
}

/** One finding with its cited rows named by file. With one file it is returned as it is. */
export function labelFindingRows(finding: ValidationFinding, fileNames: readonly string[]): LabelledFinding {
  if (fileNames.length < 2) return finding;
  return {
    ...finding,
    detail: labelRowText(finding.detail, fileNames),
    sampleRows: finding.sampleRows.map((n) => decodeFileRow(n).rawRowNumber),
    sampleRowLabels: finding.sampleRows.map((n) => rowLabel(fileNames, n)),
  };
}

/**
 * Turn every row a report cites back into the row of its own file.
 *
 * sampleRows go back to the file's own row numbers, with a parallel sampleRowLabels naming the file;
 * the two sentences that write a row into the text ("Row 145: quantity …", row-messages.ts) are
 * rewritten the same way. With one file nothing changes.
 */
export function labelReportRows(report: ValidationReport, fileNames: readonly string[]): ValidationReport {
  if (fileNames.length < 2) return report;
  return { ...report, findings: report.findings.map((f) => labelFindingRows(f, fileNames)) };
}

/**
 * The preview's row numbers back to each file's own, with the file named on every ignored row (the
 * Ignored rows tab lists them by row number, and "row 14" means nothing across six files).
 */
export function labelPreviewRows(preview: NormalizePreview, fileNames: readonly string[]): NormalizePreview {
  if (fileNames.length < 2) return preview;
  return {
    ...preview,
    sampleCoded: preview.sampleCoded.map((r) => ({ ...r, rawRowNumber: decodeFileRow(r.rawRowNumber).rawRowNumber })),
    ignoredRows: preview.ignoredRows.map((r) => {
      const { fileIndex, rawRowNumber } = decodeFileRow(r.rowNumber);
      return { ...r, rowNumber: rawRowNumber, fileName: fileNames[fileIndex] ?? `File ${fileIndex + 1}` };
    }),
  };
}

/**
 * One report for several month batches: it passes only when every month passes, and each finding
 * says which month it is about. With one batch the report is returned as it is.
 */
export function combineMonthReports(reports: readonly { period: string | null; report: ValidationReport }[]): ValidationReport {
  if (reports.length === 1) return reports[0].report;
  return {
    ok: reports.every((r) => r.report.ok),
    errorCount: reports.reduce((n, r) => n + r.report.errorCount, 0),
    warningCount: reports.reduce((n, r) => n + r.report.warningCount, 0),
    infoCount: reports.reduce((n, r) => n + r.report.infoCount, 0),
    findings: reports.flatMap((r) => r.report.findings.map((f) => ({ ...f, title: `${r.period ?? "No month"} · ${f.title}` }))),
  };
}
