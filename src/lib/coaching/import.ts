import { hrIdForStorage } from "@/lib/hr-id";
import type ExcelJS from "exceljs";

import { type AccessContext, normalizeHrId, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  type EmployeeDirectoryRow,
  getEmployeeDirectoryRows,
} from "@/lib/employees/employee-directory";
import {
  coachingImportCoachHrId,
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
import { calculateCoachingScore, toCoachingScoreRows } from "@/lib/coaching/scoring";
import { refuseOldCoachingFormCreate } from "@/lib/coaching/old-form-retired";
import type { CoachingScoreResult } from "@/lib/coaching/types";

/**
 * Importer for the historical "Field Coaching Report" Excel template.
 *
 * The template uses a two-row header (row 1 = category, row 2 = sub-item) and one
 * data row per medical rep. Each of the 20 scoring items is scored 0-5 and is read
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

export type CoachingImportClassification = "matched" | "archived" | "duplicate" | "skipped";

export type CoachingImportRawRow = {
  areaOfDevelopment: string | null;
  claimedHrId: string | null;
  coachingDate: string | null;
  coachingDateRaw: string;
  dateCorrected: boolean;
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
  duplicateReason: string | null;
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
    duplicate: number;
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

type PendingReportImport = {
  employee: EmployeeDirectoryRow;
  reportId: string;
  row: CoachingImportClassifiedRow;
  scoreResult: CoachingScoreResult;
};

type InsertedReportRow = {
  id: string;
  report_number: string;
};

const bulkInsertChunkSize = 500;

function actorId(access: AccessContext) {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role;
}

function chunks<T>(rows: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    output.push(rows.slice(index, index + size));
  }
  return output;
}

async function insertRowsInChunks(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  table: string,
  rows: Array<Record<string, unknown>>,
) {
  for (const chunk of chunks(rows, bulkInsertChunkSize)) {
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw error;
  }
}

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

export function parseCoachingDate(
  value: ExcelJS.CellValue,
  today: string = cairoTodayIso(),
): { corrected: boolean; date: string | null; display: string } {
  const readable = readableExcelCellValue(value);
  if (readable instanceof Date) {
    const iso = readable.toISOString().slice(0, 10);
    const [year, month, day] = iso.split("-").map(Number);
    // Coaches enter dates day-first (dd/mm/yyyy). Excel under a US (mm/dd) locale
    // silently re-stores some of them as a real date with day and month swapped —
    // but only when the coach's day was <= 12 (a larger day stays text and is parsed
    // correctly below). When both fields are <= 12 the stored date is ambiguous, so
    // recover the intended day-first date by swapping month and day. The adjustment
    // is flagged and shown in the import preview for verification.
    if (month >= 1 && month <= 12 && day >= 1 && day <= 12 && month !== day) {
      const swapped = `${year}-${String(day).padStart(2, "0")}-${String(month).padStart(2, "0")}`;
      // A coaching session cannot have happened after the day it is imported, so a swap
      // that lands in the future is proof the cell was ALREADY day-first and needed no
      // correction — the assumption above simply did not hold for this row. Applying it
      // anyway is what filed two 11 May 2026 reports under 5 November 2026 (CR-2026-000196
      // and -000197) in the 19 Jun 2026 historical import: the swap invented a date four
      // months ahead and nothing downstream questioned it. Keep the stored date instead,
      // and leave it unflagged — no correction was made.
      if (swapped <= today) {
        return { corrected: true, date: swapped, display: iso };
      }
      return { corrected: false, date: iso, display: iso };
    }
    return { corrected: false, date: iso, display: iso };
  }
  const text = String(readable ?? "").trim();
  if (!text) return { corrected: false, date: null, display: "" };

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { corrected: false, date: `${iso[1]}-${iso[2]}-${iso[3]}`, display: text };

  // Day-first locale (Egypt): dd/mm/yyyy, d/m/yyyy, also "-" or "." separators.
  const dmy = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, "0");
    const month = dmy[2].padStart(2, "0");
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      return { corrected: false, date: `${dmy[3]}-${month}-${day}`, display: text };
    }
  }
  return { corrected: false, date: null, display: text };
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
      dateCorrected: parsedDate.corrected,
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
  today: string = cairoTodayIso(),
): CoachingImportClassifiedRow[] {
  return rows.map((row) => {
    const normalized = normalizeHrId(row.claimedHrId);
    const resolved = normalized ? directoryIndex.get(normalized) ?? null : null;
    const { quarter, year } = periodFromDate(row.coachingDate);

    const issues = [...row.scoreIssues];
    if (!row.coachingDate) {
      issues.push(`Coaching date missing or unparseable${row.coachingDateRaw ? ` ("${row.coachingDateRaw}")` : ""}`);
    } else if (row.coachingDate > today) {
      // Second line of defence, covering every parse path rather than just the day/month
      // swap: a coaching session dated after the import cannot have happened. Raising it
      // as an issue means the row is classified "skipped" instead of "matched", so the
      // preview shows it and the commit leaves it out.
      issues.push(`Coaching date ${row.coachingDate} is in the future — a coaching session cannot be dated after today (${today}).`);
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
      duplicateReason: null,
      issues,
      resolvedHrId: resolved?.hrId ?? null,
      resolvedName: resolved?.fullName ?? null,
      unmatchedReason,
    };
  });
}

export function flagCoachingImportDuplicateRows(
  rows: CoachingImportClassifiedRow[],
  existingReportKeys: Set<string>,
  existingArchivedKeys: Set<string>,
): CoachingImportClassifiedRow[] {
  const seenReportKeys = new Set<string>();
  const seenArchivedKeys = new Set<string>();

  return rows.map((row) => {
    if (row.classification === "matched" && row.resolvedHrId) {
      const key = reportDedupKey(row.resolvedHrId, row.coachingDate);
      let duplicateReason: string | null = null;
      if (existingReportKeys.has(key)) {
        duplicateReason = "A coaching report already exists for this rep and date.";
      } else if (seenReportKeys.has(key)) {
        duplicateReason = "This workbook contains another coaching report for this rep and date.";
      }
      seenReportKeys.add(key);
      return duplicateReason ? { ...row, classification: "duplicate", duplicateReason } : row;
    }

    if (row.classification === "archived") {
      const key = archivedEvaluationKey(row.sourceName, row.coachingDate);
      let duplicateReason: string | null = null;
      if (existingArchivedKeys.has(key)) {
        duplicateReason = "This resigned-rep evaluation is already archived.";
      } else if (seenArchivedKeys.has(key)) {
        duplicateReason = "This workbook contains another resigned-rep evaluation for this source and date.";
      }
      seenArchivedKeys.add(key);
      return duplicateReason ? { ...row, classification: "duplicate", duplicateReason } : row;
    }

    return row;
  });
}

function summarize(rows: CoachingImportClassifiedRow[]): CoachingImportPreview["totals"] {
  return {
    archived: rows.filter((row) => row.classification === "archived").length,
    duplicate: rows.filter((row) => row.classification === "duplicate").length,
    matched: rows.filter((row) => row.classification === "matched").length,
    skipped: rows.filter((row) => row.classification === "skipped").length,
    total: rows.length,
  };
}

export async function previewCoachingImport(buffer: ArrayBuffer): Promise<CoachingImportPreview> {
  const workbook = await loadExcelWorkbook(buffer);
  const { rows, sheetName } = parseCoachingWorkbookRows(workbook);
  const directory = await getEmployeeDirectoryRows();
  const classified = flagCoachingImportDuplicateRows(
    classifyCoachingImportRows(rows, buildDirectoryIndex(directory)),
    await loadExistingReportKeys(),
    await loadArchivedEvaluationKeys(),
  );
  return { rows: classified, sheetName, totals: summarize(classified) };
}

function reportDedupKey(hrId: string | null | undefined, date: string | null | undefined) {
  return `${normalizeHrId(hrId) ?? ""}|${(date ?? "").slice(0, 10)}`;
}

async function loadExistingReportKeys(): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdmin()
    .from("coaching_reports")
    .select("medical_rep_hr_id, coaching_date")
    .in("status", ["submitted", "reviewed_by_employee", "locked"]);
  if (error) throw error;
  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<{ coaching_date: string | null; medical_rep_hr_id: string }>) {
    keys.add(reportDedupKey(row.medical_rep_hr_id, row.coaching_date));
  }
  return keys;
}

async function cleanupImportedReportIds(reportIds: string[]) {
  if (reportIds.length === 0) return;
  // PostgREST folds every .in() value into the request URL; batch since a large historical
  // workbook import can fail partway through with hundreds of pending report ids to roll back.
  for (let i = 0; i < reportIds.length; i += 100) {
    const batch = reportIds.slice(i, i + 100);
    const { error } = await getSupabaseAdmin()
      .from("coaching_reports")
      .delete()
      .in("id", batch);
    if (error) {
      console.warn("Failed to clean up partial coaching import reports.", error.message);
    }
  }
}

async function createImportedReportsInBulk(
  pending: PendingReportImport[],
  coachAccess: AccessContext,
  importBatchId: string,
  sourceFile: string | null | undefined,
): Promise<Map<string, InsertedReportRow>> {
  if (pending.length === 0) return new Map();

  const supabase = getSupabaseAdmin();
  const coachActor = actorId(coachAccess);
  const now = new Date().toISOString();
  const reportIds = pending.map((item) => item.reportId);

  try {
    const reportRows = pending.map(({ employee, reportId, row, scoreResult }) => ({
      acknowledged_at: now,
      actual_score: scoreResult.actualScore,
      area_id: employee.areaId,
      area_of_development: row.areaOfDevelopment,
      coach_hr_id: coachingImportCoachHrId,
      coach_role: coachAccess.role,
      coaching_date: row.coachingDate as string,
      created_by: coachActor,
      employee_acknowledged: true,
      final_score_percent: scoreResult.finalScorePercent,
      general_remarks: row.generalRemarks,
      id: reportId,
      line_id: employee.lineId,
      locked_at: null,
      max_score: scoreResult.maxScore,
      medical_rep_hr_id: employee.hrId,
      performance_zone: scoreResult.performanceZone,
      status: "reviewed_by_employee",
      strength_points: row.strengthPoints,
      submitted_at: now,
      team_id: employee.teamId,
      updated_by: coachActor,
    }));

    const { data: insertedReports, error: reportError } = await supabase
      .from("coaching_reports")
      .insert(reportRows)
      .select("id, report_number");
    if (reportError) throw reportError;

    const insertedById = new Map(
      ((insertedReports ?? []) as InsertedReportRow[]).map((report) => [report.id, report]),
    );

    const scoreRows = pending.flatMap(({ reportId, row, scoreResult }) =>
      toCoachingScoreRows(reportId, scoreResult, row.scores).map((scoreRow) => ({
        ...scoreRow,
      })),
    );
    await insertRowsInChunks(supabase, "coaching_score_items", scoreRows);

    const acknowledgmentRows = pending.map(({ reportId, row }) => ({
      acknowledgment_text: "Acknowledged automatically on historical coaching report import.",
      employee_hr_id: row.resolvedHrId,
      ip_address: null,
      report_id: reportId,
      user_agent: null,
    }));
    await insertRowsInChunks(supabase, "coaching_report_acknowledgments", acknowledgmentRows);

    const auditRows = pending.flatMap(({ reportId, row, scoreResult }) => [
      {
        action: "created_draft",
        actor_hr_id: coachActor,
        metadata: {
          historicalImport: true,
          importBatchId,
          rowNumber: row.rowNumber,
          sourceFile: sourceFile ?? null,
        },
        new_values: {
          medicalRepHrId: row.resolvedHrId,
          score: scoreResult.finalScorePercent,
        },
        old_values: null,
        report_id: reportId,
      },
      {
        action: "submitted",
        actor_hr_id: coachActor,
        metadata: {
          historicalImport: true,
          importBatchId,
          rowNumber: row.rowNumber,
          sourceFile: sourceFile ?? null,
        },
        new_values: {
          actualScore: scoreResult.actualScore,
          finalScorePercent: scoreResult.finalScorePercent,
          performanceZone: scoreResult.performanceZone,
          status: "submitted",
        },
        old_values: { status: "draft" },
        report_id: reportId,
      },
      {
        action: "acknowledged",
        actor_hr_id: row.resolvedHrId,
        metadata: {
          acknowledgmentText: "Acknowledged automatically on historical coaching report import.",
          historicalImport: true,
          importBatchId,
          rowNumber: row.rowNumber,
          sourceFile: sourceFile ?? null,
        },
        new_values: { acknowledgedAt: now, status: "reviewed_by_employee" },
        old_values: { status: "submitted" },
        report_id: reportId,
      },
    ]);
    await insertRowsInChunks(supabase, "coaching_report_audit_logs", auditRows);

    return insertedById;
  } catch (error) {
    await cleanupImportedReportIds(reportIds);
    throw error;
  }
}

export async function commitCoachingImport(
  buffer: ArrayBuffer,
  access: AccessContext,
  options: { sourceFile?: string | null } = {},
): Promise<CoachingImportCommitResult> {
  // The old form takes no new reports, imported ones included (owner, 2026-10-31).
  refuseOldCoachingFormCreate();
  const workbook = await loadExcelWorkbook(buffer);
  const { rows } = parseCoachingWorkbookRows(workbook);
  const directory = await getEmployeeDirectoryRows();
  const directoryIndex = buildDirectoryIndex(directory);
  const existingReportKeys = await loadExistingReportKeys();
  const existingArchivedKeys = await loadArchivedEvaluationKeys();
  const classified = flagCoachingImportDuplicateRows(
    classifyCoachingImportRows(rows, directoryIndex),
    existingReportKeys,
    existingArchivedKeys,
  );

  // Every imported coaching report is attributed to the fixed field-coaching coach
  // (A-7), regardless of which admin runs the upload. This makes the coach of record
  // consistent and removes the dependency on the uploader being a linked employee.
  const coachKey = normalizeHrId(coachingImportCoachHrId);
  const hasMatched = classified.some((row) => row.classification === "matched");
  if (hasMatched && (!coachKey || !directoryIndex.has(coachKey))) {
    throw new Error(
      `The coaching import coach (${coachingImportCoachHrId}) was not found among active employees, so reports cannot be created. No reports were created.`,
    );
  }
  const coachAccess: AccessContext = {
    hrId: coachingImportCoachHrId,
    loginId: coachingImportCoachHrId,
    role: "Training Manager",
    scope: "system",
    source: access.source,
  };

  const importBatchId = globalThis.crypto.randomUUID();
  const result: CoachingImportCommitResult = {
    archived: 0,
    created: [],
    duplicates: [],
    errors: [],
    importBatchId,
    skipped: [],
  };

  const pendingReports: PendingReportImport[] = [];
  const archivedInputs: CoachingArchivedEvaluationInput[] = [];

  for (const row of classified) {
    if (row.classification === "duplicate") {
      result.duplicates.push({
        hrId: row.resolvedHrId ?? row.claimedHrId,
        reason: row.duplicateReason ?? "This row is a duplicate and was not imported.",
        rowNumber: row.rowNumber,
        sourceName: row.sourceName,
      });
      continue;
    }

    if (row.classification === "skipped") {
      result.skipped.push({
        reason: row.issues.join("; ") || "Incomplete row.",
        rowNumber: row.rowNumber,
        sourceName: row.sourceName,
      });
      continue;
    }

    if (row.classification === "matched" && row.resolvedHrId) {
      // Duplicates (DB-existing and in-workbook) were already classified as
      // "duplicate" by flagCoachingImportDuplicateRows above and handled at the
      // top of this loop, so a "matched" row here is always a genuine new report.
      const key = reportDedupKey(row.resolvedHrId, row.coachingDate);

      try {
        const employeeKey = normalizeHrId(row.resolvedHrId);
        const employee = employeeKey ? directoryIndex.get(employeeKey) ?? null : null;
        if (!employee) {
          throw new Error("Medical Rep was not found in employees.");
        }

        const scoreResult = calculateCoachingScore(row.scores);
        const reportId = globalThis.crypto.randomUUID();
        existingReportKeys.add(key);

        // Historical reports were already reviewed in person — auto-acknowledge on
        // behalf of the rep so they land in the "reviewed_by_employee" state rather
        // than waiting in the rep's pending queue.
        pendingReports.push({ employee, reportId, row, scoreResult });
      } catch (error) {
        result.errors.push({
          error: error instanceof Error ? error.message : "Failed to create coaching report.",
          rowNumber: row.rowNumber,
          sourceName: row.sourceName,
        });
      }
      continue;
    }

    // Archived (resigned / unmatched). Duplicate archived evaluations were
    // already flagged as "duplicate" above, so this is a genuine new one.
    archivedInputs.push({
      areaOfDevelopment: row.areaOfDevelopment,
      claimedHrId: row.claimedHrId,
      coachHrId: coachingImportCoachHrId,
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

  const insertedReports = await createImportedReportsInBulk(
    pendingReports,
    coachAccess,
    importBatchId,
    options.sourceFile,
  );
  for (const pending of pendingReports) {
    const inserted = insertedReports.get(pending.reportId);
    result.created.push({
      acknowledged: true,
      finalScorePercent: pending.scoreResult.finalScorePercent,
      hrId: pending.row.resolvedHrId as string,
      performanceZone: pending.scoreResult.performanceZone,
      repName: pending.row.resolvedName ?? pending.row.repName,
      reportId: pending.reportId,
      reportNumber: inserted?.report_number ?? pending.reportId,
      rowNumber: pending.row.rowNumber,
    });
  }

  if (archivedInputs.length > 0) {
    const inserted = await insertArchivedCoachingEvaluations(archivedInputs);
    result.archived = inserted.length;
  }

  return result;
}
