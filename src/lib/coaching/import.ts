import type ExcelJS from "exceljs";

import { type AccessContext, normalizeHrId } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  type EmployeeDirectoryRow,
  getEmployeeDirectoryRows,
} from "@/lib/employees/employee-directory";
import {
  coachingMaxItemScore,
  coachingMinItemScore,
  coachingScoreItems,
  type CoachingScoreItemKey,
} from "@/lib/coaching/constants";
import {
  excelCellText,
  loadExcelWorkbook,
  readableExcelCellValue,
} from "@/lib/uploads/exceljs-rows";
import {
  archivedEvaluationKey,
  insertArchivedCoachingEvaluations,
  loadArchivedEvaluationKeys,
  type CoachingArchivedEvaluationInput,
} from "@/lib/coaching/archived";
import {
  acknowledgeImportedCoachingReport,
  createDraftCoachingReport,
  submitCoachingReport,
} from "@/lib/coaching/service";

/**
 * Importer for the historical "Field Coaching Report" Excel template.
 *
 * The template uses a two-row header (row 1 = category, row 2 = sub-item) and one
 * data row per medical rep. Each of the 20 scoring items is scored 1-5 and is read
 * verbatim — no rescaling. Rows whose HR-ID resolves to an active employee become
 * real coaching reports; rows with no/unresolved HR-ID (resignations) are archived
 * so the coach's written effort is preserved.
 */

// Fixed column layout of the standardised template. Score columns map 1:1 to the
// in-app score item keys; the "Total" columns are derived and intentionally ignored.
const SCORE_COLUMNS: Array<{ key: CoachingScoreItemKey; column: string }> = [
  { key: "medical_patient_knowledge", column: "D" },
  { key: "product_knowledge", column: "E" },
  { key: "competitor_knowledge", column: "F" },
  { key: "opening_patient_profile_attractive_approach", column: "I" },
  { key: "asking_questions_probing", column: "J" },
  { key: "presentation_skills", column: "K" },
  { key: "closing_asking_for_business", column: "L" },
  { key: "handling_customer_objection", column: "O" },
  { key: "body_language_tone_of_voice", column: "P" },
  { key: "professional_pharmacy_feedback", column: "Q" },
  { key: "assertiveness_asking_for_business", column: "R" },
  { key: "customer_adaptation_relationship", column: "S" },
  { key: "time_territory_planning", column: "V" },
  { key: "using_promotional_material", column: "W" },
  { key: "pre_call_planning", column: "X" },
  { key: "execution_follow_up", column: "Y" },
  { key: "appearance", column: "AB" },
  { key: "dress_code", column: "AC" },
  { key: "attitude", column: "AD" },
  { key: "discipline", column: "AE" },
];

const META_COLUMNS = {
  areaOfDevelopment: "AH",
  coachingDate: "C",
  generalRemarks: "AJ",
  hrId: "B",
  name: "A",
  overall: "AG",
  strengthPoints: "AI",
} as const;

const scoreItemLabel = new Map(coachingScoreItems.map((item) => [item.key, item.label]));

export type CoachingImportClassification = "matched" | "archived" | "skipped";

export type CoachingImportRawRow = {
  areaOfDevelopment: string | null;
  claimedHrId: string | null;
  coachingDate: string | null;
  coachingDateRaw: string;
  generalRemarks: string | null;
  overallScore: number | null;
  repCode: string | null;
  repName: string | null;
  rowNumber: number;
  scoreIssues: string[];
  scores: Partial<Record<CoachingScoreItemKey, number>>;
  sourceName: string;
  strengthPoints: string | null;
  territory: string | null;
};

export type CoachingImportClassifiedRow = CoachingImportRawRow & {
  classification: CoachingImportClassification;
  coachingQuarter: number | null;
  coachingYear: number | null;
  issues: string[];
  resolvedHrId: string | null;
  resolvedName: string | null;
  unmatchedReason: string | null;
};

export type CoachingImportPreview = {
  rows: CoachingImportClassifiedRow[];
  sheetName: string | null;
  totals: {
    archived: number;
    matched: number;
    skipped: number;
    total: number;
  };
};

export type CoachingImportCommitResult = {
  archived: number;
  created: Array<{
    acknowledged: boolean;
    finalScorePercent: number | null;
    hrId: string;
    performanceZone: string | null;
    repName: string | null;
    reportId: string;
    reportNumber: string;
    rowNumber: number;
  }>;
  duplicates: Array<{ hrId: string | null; reason: string; rowNumber: number; sourceName: string }>;
  errors: Array<{ error: string; rowNumber: number; sourceName: string }>;
  importBatchId: string;
  skipped: Array<{ reason: string; rowNumber: number; sourceName: string }>;
};

function parseRepName(source: string) {
  const match = source.match(/^(.*?)\s*\(\s*(.*?)\s*\/\s*([^)]*?)\s*\)\s*$/);
  if (match) {
    return {
      repCode: match[3].trim() || null,
      repName: match[1].trim() || null,
      territory: match[2].trim() || null,
    };
  }
  return { repCode: null, repName: source.trim() || null, territory: null };
}

export function parseCoachingDate(value: ExcelJS.CellValue): { date: string | null; display: string } {
  const readable = readableExcelCellValue(value);
  if (readable instanceof Date) {
    const iso = readable.toISOString().slice(0, 10);
    return { date: iso, display: iso };
  }
  const text = String(readable ?? "").trim();
  if (!text) return { date: null, display: "" };

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, display: text };

  // Day-first locale (Egypt): dd/mm/yyyy, d/m/yyyy, also "-" or "." separators.
  const dmy = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      return { date: `${dmy[3]}-${month}-${day}`, display: text };
    }
  }
  return { date: null, display: text };
}

function periodFromDate(date: string | null) {
  if (!date) return { quarter: null, year: null };
  const [year, month] = date.split("-").map(Number);
  if (!year || !month) return { quarter: null, year: null };
  return { quarter: Math.floor((month - 1) / 3) + 1, year };
}

function parseScoreCell(value: ExcelJS.CellValue): number | null {
  const text = excelCellText(value);
  if (!text) return null;
  const numeric = Number(text);
  if (
    !Number.isInteger(numeric) ||
    numeric < coachingMinItemScore ||
    numeric > coachingMaxItemScore
  ) {
    return null;
  }
  return numeric;
}

function cellText(worksheet: ExcelJS.Worksheet, column: string, rowNumber: number) {
  return excelCellText(worksheet.getCell(`${column}${rowNumber}`).value);
}

function findHeaderRow(worksheet: ExcelJS.Worksheet) {
  const limit = Math.min(worksheet.rowCount || 1, 15);
  for (let row = 1; row <= limit; row += 1) {
    if (cellText(worksheet, META_COLUMNS.name, row).toLowerCase() === "name") {
      return row;
    }
  }
  return 1;
}

/** Pure parse of the workbook into raw rows. No employee resolution, no DB access. */
export function parseCoachingWorkbookRows(
  workbook: ExcelJS.Workbook,
  options: { sheetName?: string } = {},
): { rows: CoachingImportRawRow[]; sheetName: string | null } {
  const worksheet = options.sheetName
    ? workbook.getWorksheet(options.sheetName)
    : workbook.worksheets[0];
  if (!worksheet) return { rows: [], sheetName: null };

  const headerRow = findHeaderRow(worksheet);
  const firstDataRow = headerRow + 2; // category row + sub-item row
  const rows: CoachingImportRawRow[] = [];

  for (let rowNumber = firstDataRow; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const sourceName = cellText(worksheet, META_COLUMNS.name, rowNumber);
    if (!sourceName) continue; // blank row / legend rows have no name

    const name = parseRepName(sourceName);
    const claimedHrId = cellText(worksheet, META_COLUMNS.hrId, rowNumber) || null;
    const parsedDate = parseCoachingDate(worksheet.getCell(`${META_COLUMNS.coachingDate}${rowNumber}`).value);

    const scores: Partial<Record<CoachingScoreItemKey, number>> = {};
    const scoreIssues: string[] = [];
    for (const { key, column } of SCORE_COLUMNS) {
      const score = parseScoreCell(worksheet.getCell(`${column}${rowNumber}`).value);
      if (score === null) {
        scoreIssues.push(`${scoreItemLabel.get(key) ?? key}: missing or out-of-range score (must be ${coachingMinItemScore}-${coachingMaxItemScore})`);
      } else {
        scores[key] = score;
      }
    }

    const overallText = cellText(worksheet, META_COLUMNS.overall, rowNumber);
    const overallScore = overallText && Number.isFinite(Number(overallText)) ? Number(overallText) : null;

    rows.push({
      areaOfDevelopment: cellText(worksheet, META_COLUMNS.areaOfDevelopment, rowNumber) || null,
      claimedHrId,
      coachingDate: parsedDate.date,
      coachingDateRaw: parsedDate.display,
      generalRemarks: cellText(worksheet, META_COLUMNS.generalRemarks, rowNumber) || null,
      overallScore,
      repCode: name.repCode,
      repName: name.repName,
      rowNumber,
      scoreIssues,
      scores,
      sourceName,
      strengthPoints: cellText(worksheet, META_COLUMNS.strengthPoints, rowNumber) || null,
      territory: name.territory,
    });
  }

  return { rows, sheetName: worksheet.name };
}

function buildDirectoryIndex(rows: EmployeeDirectoryRow[]) {
  const index = new Map<string, EmployeeDirectoryRow>();
  for (const row of rows) {
    const key = normalizeHrId(row.hrId);
    if (key) index.set(key, row);
  }
  return index;
}

/** Resolve + classify raw rows against the (active) employee directory. */
export function classifyCoachingImportRows(
  rows: CoachingImportRawRow[],
  directoryIndex: Map<string, EmployeeDirectoryRow>,
): CoachingImportClassifiedRow[] {
  return rows.map((row) => {
    const normalized = normalizeHrId(row.claimedHrId);
    const resolved = normalized ? directoryIndex.get(normalized) ?? null : null;
    const { quarter, year } = periodFromDate(row.coachingDate);

    const issues = [...row.scoreIssues];
    if (!row.coachingDate) {
      issues.push(`Coaching date missing or unparseable${row.coachingDateRaw ? ` ("${row.coachingDateRaw}")` : ""}`);
    }

    let classification: CoachingImportClassification;
    let unmatchedReason: string | null = null;

    if (resolved) {
      classification = issues.length === 0 ? "matched" : "skipped";
    } else {
      classification = "archived";
      unmatchedReason = row.claimedHrId
        ? `HR-ID "${row.claimedHrId}" not found among active employees (resigned/inactive).`
        : "No HR-ID in sheet — treated as resigned.";
    }

    return {
      ...row,
      classification,
      coachingQuarter: quarter,
      coachingYear: year,
      issues,
      resolvedHrId: resolved?.hrId ?? null,
      resolvedName: resolved?.fullName ?? null,
      unmatchedReason,
    };
  });
}

function summarize(rows: CoachingImportClassifiedRow[]): CoachingImportPreview["totals"] {
  return {
    archived: rows.filter((row) => row.classification === "archived").length,
    matched: rows.filter((row) => row.classification === "matched").length,
    skipped: rows.filter((row) => row.classification === "skipped").length,
    total: rows.length,
  };
}

export async function previewCoachingImport(buffer: ArrayBuffer): Promise<CoachingImportPreview> {
  const workbook = await loadExcelWorkbook(buffer);
  const { rows, sheetName } = parseCoachingWorkbookRows(workbook);
  const directory = await getEmployeeDirectoryRows();
  const classified = classifyCoachingImportRows(rows, buildDirectoryIndex(directory));
  return { rows: classified, sheetName, totals: summarize(classified) };
}

function reportDedupKey(hrId: string | null | undefined, date: string | null | undefined) {
  return `${normalizeHrId(hrId) ?? ""}|${(date ?? "").slice(0, 10)}`;
}

async function loadExistingReportKeys(): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin()
    .from("coaching_reports")
    .select("medical_rep_hr_id, coaching_date");
  if (error) throw error;
  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<{ coaching_date: string | null; medical_rep_hr_id: string }>) {
    keys.add(reportDedupKey(row.medical_rep_hr_id, row.coaching_date));
  }
  return keys;
}

export async function commitCoachingImport(
  buffer: ArrayBuffer,
  access: AccessContext,
  options: { sourceFile?: string | null } = {},
): Promise<CoachingImportCommitResult> {
  const workbook = await loadExcelWorkbook(buffer);
  const { rows } = parseCoachingWorkbookRows(workbook);
  const directory = await getEmployeeDirectoryRows();
  const classified = classifyCoachingImportRows(rows, buildDirectoryIndex(directory));

  const importBatchId = globalThis.crypto.randomUUID();
  const result: CoachingImportCommitResult = {
    archived: 0,
    created: [],
    duplicates: [],
    errors: [],
    importBatchId,
    skipped: [],
  };

  const existingReportKeys = await loadExistingReportKeys();
  const existingArchivedKeys = await loadArchivedEvaluationKeys();
  const seenArchivedKeys = new Set<string>();

  const archivedInputs: CoachingArchivedEvaluationInput[] = [];

  for (const row of classified) {
    if (row.classification === "skipped") {
      result.skipped.push({
        reason: row.issues.join("; ") || "Incomplete row.",
        rowNumber: row.rowNumber,
        sourceName: row.sourceName,
      });
      continue;
    }

    if (row.classification === "matched" && row.resolvedHrId) {
      const key = reportDedupKey(row.resolvedHrId, row.coachingDate);
      if (existingReportKeys.has(key)) {
        result.duplicates.push({
          hrId: row.resolvedHrId,
          reason: "A coaching report already exists for this rep and date.",
          rowNumber: row.rowNumber,
          sourceName: row.sourceName,
        });
        continue;
      }

      try {
        const draft = await createDraftCoachingReport(
          {
            areaOfDevelopment: row.areaOfDevelopment,
            coachingDate: row.coachingDate as string,
            generalRemarks: row.generalRemarks,
            medicalRepHrId: row.resolvedHrId,
            scores: row.scores,
            strengthPoints: row.strengthPoints,
          },
          access,
        );
        const reportId = draft.report.id;
        const submitted = await submitCoachingReport(reportId, null, access);
        existingReportKeys.add(key);

        // Historical reports were already reviewed in person — auto-acknowledge on
        // behalf of the rep so they land in the "reviewed_by_employee" state rather
        // than waiting in the rep's pending queue.
        let acknowledged = false;
        try {
          await acknowledgeImportedCoachingReport(reportId, row.resolvedHrId);
          acknowledged = true;
        } catch (ackError) {
          result.errors.push({
            error: `Report created but auto-acknowledge failed: ${ackError instanceof Error ? ackError.message : "unknown error"}`,
            rowNumber: row.rowNumber,
            sourceName: row.sourceName,
          });
        }

        result.created.push({
          acknowledged,
          finalScorePercent: Number(submitted.report.final_score_percent ?? draft.report.final_score_percent ?? 0),
          hrId: row.resolvedHrId,
          performanceZone: submitted.report.performance_zone ?? null,
          repName: row.resolvedName ?? row.repName,
          reportId,
          reportNumber: submitted.report.report_number,
          rowNumber: row.rowNumber,
        });
      } catch (error) {
        result.errors.push({
          error: error instanceof Error ? error.message : "Failed to create coaching report.",
          rowNumber: row.rowNumber,
          sourceName: row.sourceName,
        });
      }
      continue;
    }

    // Archived (resigned / unmatched)
    const archiveKey = archivedEvaluationKey(row.sourceName, row.coachingDate);
    if (existingArchivedKeys.has(archiveKey) || seenArchivedKeys.has(archiveKey)) {
      result.duplicates.push({
        hrId: row.claimedHrId,
        reason: "This resigned-rep evaluation is already archived.",
        rowNumber: row.rowNumber,
        sourceName: row.sourceName,
      });
      continue;
    }
    seenArchivedKeys.add(archiveKey);
    archivedInputs.push({
      areaOfDevelopment: row.areaOfDevelopment,
      claimedHrId: row.claimedHrId,
      coachHrId: access.hrId,
      coachingDate: row.coachingDate,
      coachingQuarter: row.coachingQuarter,
      coachingYear: row.coachingYear,
      createdBy: access.hrId,
      generalRemarks: row.generalRemarks,
      importBatchId,
      overallScore: row.overallScore,
      performanceBand: null,
      repCode: row.repCode,
      repName: row.repName,
      scores: row.scores,
      sourceFile: options.sourceFile ?? null,
      sourceName: row.sourceName,
      strengthPoints: row.strengthPoints,
      territory: row.territory,
      unmatchedReason: row.unmatchedReason,
    });
  }

  if (archivedInputs.length > 0) {
    const inserted = await insertArchivedCoachingEvaluations(archivedInputs);
    result.archived = inserted.length;
  }

  return result;
}
