import { writeAuditLog } from "@/lib/admin/audit";
import { buildFieldWorkforceNoActivityPattern } from "@/lib/field-workforce-compliance/classifier";
import { daysInMonth } from "@/lib/field-workforce-compliance/parser";
import type {
  FieldWorkforceArchiveDetail,
  FieldWorkforceArchiveDuplicate,
  FieldWorkforceArchiveImportStatus,
  FieldWorkforceArchiveListItem,
  FieldWorkforceCellStatus,
  FieldWorkforceComparisonReport,
  FieldWorkforceDayCell,
  FieldWorkforceEmployeeSummary,
  FieldWorkforceNoActivityPattern,
  FieldWorkforcePreviewResult,
  FieldWorkforceReviewCandidate,
  FieldWorkforceSeverity,
  FieldWorkforceSourceCellValue,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const importsTable = "field_workforce_compliance_imports";
const daysTable = "field_workforce_compliance_days";
const monthlySummaryTable = "field_workforce_compliance_monthly_summary";
const archiveBatchSize = 500;

type JsonRecord = Record<string, unknown>;

export type FieldWorkforceArchiveImportInsert = {
  diagnostics: JsonRecord;
  employee_count: number;
  high_severity_count: number;
  month: number;
  month_key: string;
  review_candidate_count: number;
  sheet_name: string;
  source_filename: string;
  status: FieldWorkforceArchiveImportStatus;
  uploaded_by: string;
  validation_summary: JsonRecord;
  year: number;
};

export type FieldWorkforceArchiveDayInsert = {
  activity_date: string;
  counted_as_no_activity_candidate: boolean;
  counted_as_visit_total: boolean;
  counted_as_worked_day: boolean;
  day_number: number;
  employee_code: string;
  employee_name: string;
  explanation: string;
  hiring_date: string | null;
  ignored: boolean;
  ignore_reason: string | null;
  import_id?: string;
  is_friday: boolean;
  is_pre_hire: boolean;
  is_public_holiday: boolean;
  normalized_status: FieldWorkforceCellStatus;
  public_holiday_name: string | null;
  raw_value: FieldWorkforceSourceCellValue;
  severity: FieldWorkforceSeverity | null;
  visit_count: number | null;
};

export type FieldWorkforceArchiveSummaryInsert = {
  area_name: string | null;
  campaign_days: number;
  compliance_percent: number;
  employee_code: string;
  employee_eligible_working_days: number;
  employee_name: string;
  employment_status: string | null;
  fridays: number;
  high_severity_count: number;
  hiring_date: string | null;
  import_id?: string;
  line_name: string | null;
  manager_name: string | null;
  month_key: string;
  no_activity_pattern: FieldWorkforceNoActivityPattern;
  month_working_days: number;
  no_activity_dates: string[];
  no_activity_days: number;
  public_holiday_warning_count: number;
  review_candidate_count: number;
  role_name: string | null;
  team_name: string | null;
  total_visits: number;
  vacation_days: number;
  worked_days: number;
};

export type FieldWorkforceArchiveRows = {
  dayRows: FieldWorkforceArchiveDayInsert[];
  importRow: FieldWorkforceArchiveImportInsert;
  summaryRows: FieldWorkforceArchiveSummaryInsert[];
};

type FieldWorkforceImportRow = FieldWorkforceArchiveImportInsert & {
  id: string;
  uploaded_at: string;
};

type FieldWorkforceDayRow = FieldWorkforceArchiveDayInsert & {
  id?: string;
};

type FieldWorkforceSummaryRow = FieldWorkforceArchiveSummaryInsert & {
  id?: string;
};

export class FieldWorkforceArchiveDuplicateError extends Error {
  duplicate: FieldWorkforceArchiveDuplicate;

  constructor(duplicate: FieldWorkforceArchiveDuplicate) {
    super(`Field Workforce Compliance month ${duplicate.monthKey} is already archived.`);
    this.name = "FieldWorkforceArchiveDuplicateError";
    this.duplicate = duplicate;
  }
}

function isFriday(dateIso: string) {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 5;
}

function monthWorkingDays(year: number, month: number) {
  return Array.from({ length: daysInMonth(year, month) }, (_, index) => {
    const day = index + 1;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }).filter((dateIso) => !isFriday(dateIso)).length;
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asReviewCandidates(value: unknown): FieldWorkforceReviewCandidate[] {
  return Array.isArray(value) ? value as FieldWorkforceReviewCandidate[] : [];
}

function asValidationIssues(value: unknown): FieldWorkforceValidationIssue[] {
  return Array.isArray(value) ? value as FieldWorkforceValidationIssue[] : [];
}

function asNoActivityPattern(value: unknown, timeline: FieldWorkforceDayCell[]): FieldWorkforceNoActivityPattern {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const pattern = value as Partial<FieldWorkforceNoActivityPattern>;
    return {
      adjacentToFridayDates: Array.isArray(pattern.adjacentToFridayDates) ? pattern.adjacentToFridayDates.map(String) : [],
      adjacentToPublicHolidayDates: Array.isArray(pattern.adjacentToPublicHolidayDates) ? pattern.adjacentToPublicHolidayDates.map(String) : [],
      consecutiveSignalCount: asNumber(pattern.consecutiveSignalCount),
      hasThreeDayStreak: Boolean(pattern.hasThreeDayStreak),
      hasTwoDayStreak: Boolean(pattern.hasTwoDayStreak),
      highMonthlyCount: Boolean(pattern.highMonthlyCount),
      longestStreak: asNumber(pattern.longestStreak),
      summary: typeof pattern.summary === "string" ? pattern.summary : "No consecutive N pattern detected.",
    };
  }
  return buildFieldWorkforceNoActivityPattern(timeline);
}

function archiveCellContext(cell: {
  ignored: boolean;
  is_friday: boolean;
  is_pre_hire: boolean;
  is_public_holiday: boolean;
  normalized_status: FieldWorkforceCellStatus;
  public_holiday_name: string | null;
}) {
  const context: string[] = [];
  if (cell.is_pre_hire) context.push("Pre-hire");
  if (cell.is_friday) context.push("Friday");
  if (cell.is_public_holiday) {
    context.push(cell.public_holiday_name ? `Public holiday: ${cell.public_holiday_name}` : "Public holiday");
  }
  if (cell.normalized_status === "UNKNOWN") context.push("Unknown value");
  if (cell.ignored) context.push("Ignored");
  return context;
}

function mapImportRow(row: FieldWorkforceImportRow): FieldWorkforceArchiveListItem {
  return {
    employeeCount: asNumber(row.employee_count),
    highSeverityCount: asNumber(row.high_severity_count),
    id: row.id,
    month: asNumber(row.month),
    monthKey: String(row.month_key),
    reviewCandidateCount: asNumber(row.review_candidate_count),
    sheetName: String(row.sheet_name),
    sourceFilename: String(row.source_filename),
    status: row.status,
    uploadedAt: String(row.uploaded_at),
    uploadedBy: String(row.uploaded_by ?? "system"),
    year: asNumber(row.year),
  };
}

export function fieldWorkforceMonthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function findFieldWorkforceArchiveDuplicate(
  archives: FieldWorkforceArchiveListItem[],
  monthKey: string,
) {
  return archives.find((archive) => archive.status === "archived" && archive.monthKey === monthKey) ?? null;
}

export function fieldWorkforceArchiveRowsFromPreview(
  preview: FieldWorkforcePreviewResult,
  uploadedBy: string,
): FieldWorkforceArchiveRows {
  const monthKey = fieldWorkforceMonthKey(preview.metadata.year, preview.metadata.month);
  const workingDays = monthWorkingDays(preview.metadata.year, preview.metadata.month);
  const reviewCountsByEmployee = new Map<string, number>();
  for (const candidate of preview.reviewCandidates) {
    reviewCountsByEmployee.set(candidate.hrId, (reviewCountsByEmployee.get(candidate.hrId) ?? 0) + 1);
  }

  const importRow: FieldWorkforceArchiveImportInsert = {
    diagnostics: {
      errors: preview.errors,
      metadata: preview.metadata,
      reviewCandidates: preview.reviewCandidates,
      severityCounts: preview.severityCounts,
      warnings: preview.warnings,
    },
    employee_count: preview.metadata.employeeCount,
    high_severity_count: preview.severityCounts.High,
    month: preview.metadata.month,
    month_key: monthKey,
    review_candidate_count: preview.reviewCandidates.length,
    sheet_name: preview.metadata.sheetName,
    source_filename: preview.metadata.fileName,
    status: "archived",
    uploaded_by: uploadedBy || "system",
    validation_summary: {
      dateRange: preview.metadata.dateRange,
      highSeverityCount: preview.severityCounts.High,
      holidayConnected: preview.metadata.holidayConnected,
      holidayMessage: preview.metadata.holidayMessage,
      holidaySourceLabel: preview.metadata.holidaySourceLabel,
      holidaysDetected: preview.metadata.holidaysDetected,
      matchedEmployees: preview.metadata.matchedEmployees,
      monthKey,
      reviewCandidateCount: preview.reviewCandidates.length,
      severityCounts: preview.severityCounts,
      unmatchedEmployees: preview.metadata.unmatchedEmployees,
    },
    year: preview.metadata.year,
  };

  const dayRows = preview.employees.flatMap((employee) =>
    employee.timeline.map((cell) => ({
      activity_date: cell.dateIso,
      counted_as_no_activity_candidate: cell.countedAsNoActivityCandidate,
      counted_as_visit_total: cell.countedAsVisitTotal,
      counted_as_worked_day: cell.countedAsWorkedDay,
      day_number: cell.dayNumber,
      employee_code: employee.hrId,
      employee_name: employee.employeeName,
      explanation: cell.explanation,
      hiring_date: employee.hiringDateIso,
      ignored: cell.ignored,
      ignore_reason: cell.ignoreReason ?? null,
      is_friday: cell.isFriday,
      is_pre_hire: cell.isPreHire,
      is_public_holiday: cell.isPublicHoliday,
      normalized_status: cell.status,
      public_holiday_name: cell.holidayName ?? null,
      raw_value: cell.rawValue,
      severity: cell.severity ?? null,
      visit_count: cell.visitCount ?? null,
    } satisfies FieldWorkforceArchiveDayInsert)),
  );

  const summaryRows = preview.employees.map((employee) => {
    const eligibleDays = employee.eligibleWorkingDays;
    const compliancePercent = eligibleDays > 0 ? roundPercent((employee.workedDays / eligibleDays) * 100) : 0;
    return {
      area_name: employee.areaName,
      campaign_days: employee.campaignDays,
      compliance_percent: compliancePercent,
      employee_code: employee.hrId,
      employee_eligible_working_days: eligibleDays,
      employee_name: employee.employeeName,
      employment_status: employee.employmentStatus,
      fridays: employee.fridays,
      high_severity_count: employee.severityCounts.High,
      hiring_date: employee.hiringDateIso,
      line_name: employee.lineName,
      manager_name: employee.managerName,
      month_key: monthKey,
      month_working_days: workingDays,
      no_activity_pattern: employee.noActivityPattern,
      no_activity_dates: employee.timeline
        .filter((cell) => cell.countedAsNoActivityCandidate)
        .map((cell) => cell.dateIso),
      no_activity_days: employee.noActivityCandidates,
      public_holiday_warning_count: employee.holidayWarnings,
      review_candidate_count: reviewCountsByEmployee.get(employee.hrId) ?? 0,
      role_name: employee.roleName,
      team_name: employee.teamName,
      total_visits: employee.totalVisits,
      vacation_days: employee.vacationSignalDays,
      worked_days: employee.workedDays,
    } satisfies FieldWorkforceArchiveSummaryInsert;
  });

  return { dayRows, importRow, summaryRows };
}

export function fieldWorkforcePreviewFromArchiveRows(input: {
  dayRows: FieldWorkforceDayRow[];
  importRow: FieldWorkforceImportRow;
  summaryRows: FieldWorkforceSummaryRow[];
}): FieldWorkforceArchiveDetail {
  const diagnostics = input.importRow.diagnostics ?? {};
  const validationSummary = input.importRow.validation_summary ?? {};
  const reviewCandidates = asReviewCandidates(diagnostics.reviewCandidates);
  const errors = asValidationIssues(diagnostics.errors);
  const warnings = asValidationIssues(diagnostics.warnings);
  const severityCounts = (diagnostics.severityCounts ?? validationSummary.severityCounts ?? {
    High: 0,
    Low: 0,
    Medium: 0,
    Review: 0,
  }) as Record<FieldWorkforceSeverity, number>;
  const dateRange = (validationSummary.dateRange ?? {
    end: null,
    start: null,
  }) as FieldWorkforcePreviewResult["metadata"]["dateRange"];

  const dayRowsByEmployee = new Map<string, FieldWorkforceDayRow[]>();
  for (const dayRow of input.dayRows) {
    const key = String(dayRow.employee_code);
    dayRowsByEmployee.set(key, [...(dayRowsByEmployee.get(key) ?? []), dayRow]);
  }

  const employees = input.summaryRows.map((summaryRow, index) => {
    const employeeCode = String(summaryRow.employee_code);
    const rows = [...(dayRowsByEmployee.get(employeeCode) ?? [])].sort((left, right) =>
      String(left.activity_date).localeCompare(String(right.activity_date)),
    );
    const timeline = rows.map((row) => ({
      context: archiveCellContext(row),
      countedAsNoActivityCandidate: row.counted_as_no_activity_candidate,
      countedAsVisitTotal: row.counted_as_visit_total,
      countedAsWorkedDay: row.counted_as_worked_day,
      dateIso: String(row.activity_date),
      dayNumber: asNumber(row.day_number),
      employeeName: String(row.employee_name),
      explanation: String(row.explanation),
      holidayName: row.public_holiday_name ?? undefined,
      hrId: employeeCode,
      ignored: row.ignored,
      ignoreReason: row.ignore_reason ?? undefined,
      isFriday: row.is_friday,
      isPreHire: row.is_pre_hire,
      isPublicHoliday: row.is_public_holiday,
      rawValue: row.raw_value,
      severity: row.severity ?? undefined,
      status: row.normalized_status,
      visitCount: row.visit_count === null ? undefined : asNumber(row.visit_count),
    } satisfies FieldWorkforceDayCell));
    const highSeverityCount = asNumber(summaryRow.high_severity_count);
    const noActivityPattern = asNoActivityPattern(summaryRow.no_activity_pattern, timeline);

    return {
      areaName: summaryRow.area_name ?? null,
      campaignDays: asNumber(summaryRow.campaign_days),
      compliancePercent: asNumber(summaryRow.compliance_percent),
      employeeName: String(summaryRow.employee_name),
      employmentStatus: summaryRow.employment_status ?? null,
      eligibleWorkingDays: asNumber(summaryRow.employee_eligible_working_days),
      fridays: asNumber(summaryRow.fridays),
      hiringDateIso: summaryRow.hiring_date ?? null,
      hiringDateSource: summaryRow.hiring_date ? "workbook" : "missing",
      holidayWarnings: asNumber(summaryRow.public_holiday_warning_count),
      hrId: employeeCode,
      lineName: summaryRow.line_name ?? null,
      // Archived months predate manager_hr_id capture; ordering falls back to name order.
      managerHrId: null,
      managerName: summaryRow.manager_name ?? null,
      matchedEmployeeName: String(summaryRow.employee_name),
      matchedHrId: employeeCode,
      matchStatus: "matched",
      noActivityCandidates: asNumber(summaryRow.no_activity_days),
      noActivityPattern,
      preHireIgnoredValues: timeline.filter((cell) => cell.isPreHire && cell.rawValue !== null).length,
      roleName: summaryRow.role_name ?? null,
      severityCounts: {
        High: highSeverityCount,
        Low: timeline.filter((cell) => cell.severity === "Low").length,
        Medium: timeline.filter((cell) => cell.severity === "Medium").length,
        Review: timeline.filter((cell) => cell.severity === "Review").length,
      },
      sourceRowNumber: index + 1,
      teamName: summaryRow.team_name ?? null,
      timeline,
      totalVisits: asNumber(summaryRow.total_visits),
      unknownValues: timeline.filter((cell) => cell.status === "UNKNOWN").length,
      vacationSignalDays: asNumber(summaryRow.vacation_days),
      workedDays: asNumber(summaryRow.worked_days),
    } satisfies FieldWorkforceEmployeeSummary;
  });

  const archive = mapImportRow(input.importRow);
  return {
    archive,
    preview: {
      employees,
      errors,
      metadata: {
        dateRange,
        employeeCount: archive.employeeCount,
        fileName: archive.sourceFilename,
        holidayConnected: Boolean(validationSummary.holidayConnected),
        holidayMessage: typeof validationSummary.holidayMessage === "string" ? validationSummary.holidayMessage : null,
        holidaySourceLabel: typeof validationSummary.holidaySourceLabel === "string"
          ? validationSummary.holidaySourceLabel
          : "Archived public holiday overlay",
        holidaysDetected: asNumber(validationSummary.holidaysDetected),
        matchedEmployees: asNumber(validationSummary.matchedEmployees),
        month: archive.month,
        monthLabel: typeof diagnostics.metadata === "object" && diagnostics.metadata !== null && "monthLabel" in diagnostics.metadata
          ? String((diagnostics.metadata as { monthLabel?: unknown }).monthLabel ?? `Month ${archive.month}`)
          : `Month ${archive.month}`,
        sheetName: archive.sheetName,
        unmatchedEmployees: asNumber(validationSummary.unmatchedEmployees),
        year: archive.year,
      },
      reviewCandidates,
      severityCounts,
      warnings,
    },
  };
}

async function insertRowsInChunks<T extends JsonRecord>(table: string, rows: T[]) {
  const supabase = getSupabaseAdmin();
  for (let index = 0; index < rows.length; index += archiveBatchSize) {
    const batch = rows.slice(index, index + archiveBatchSize);
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw error;
  }
}

async function loadExistingArchiveByMonthKey(monthKey: string) {
  const { data, error } = await getSupabaseAdmin()
    .from(importsTable)
    .select("*")
    .eq("month_key", monthKey)
    .eq("status", "archived")
    .maybeSingle();

  if (error) throw error;
  return data ? mapImportRow(data as FieldWorkforceImportRow) : null;
}

export async function listFieldWorkforceComplianceArchives(): Promise<FieldWorkforceArchiveListItem[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(importsTable)
    .select("*")
    .eq("status", "archived")
    .order("year", { ascending: false })
    .order("month", { ascending: false })
    .order("uploaded_at", { ascending: false });

  if (error) throw error;
  return (data ?? []).map((row) => mapImportRow(row as FieldWorkforceImportRow));
}

export async function archiveFieldWorkforceCompliancePreview(input: {
  actorLoginId: string;
  preview: FieldWorkforcePreviewResult;
  uploadedBy: string;
}): Promise<FieldWorkforceArchiveDetail> {
  const rows = fieldWorkforceArchiveRowsFromPreview(input.preview, input.uploadedBy);
  const existing = await loadExistingArchiveByMonthKey(rows.importRow.month_key);
  if (existing) {
    throw new FieldWorkforceArchiveDuplicateError({
      existing,
      monthKey: rows.importRow.month_key,
    });
  }

  const { data: savedImport, error: importError } = await getSupabaseAdmin()
    .from(importsTable)
    .insert(rows.importRow)
    .select("*")
    .single();

  if (importError) {
    if (importError.code === "23505") {
      const duplicate = await loadExistingArchiveByMonthKey(rows.importRow.month_key);
      if (duplicate) {
        throw new FieldWorkforceArchiveDuplicateError({
          existing: duplicate,
          monthKey: rows.importRow.month_key,
        });
      }
    }
    throw importError;
  }

  const importId = String((savedImport as { id: string }).id);
  const dayRows = rows.dayRows.map((row) => ({ ...row, import_id: importId }));
  const summaryRows = rows.summaryRows.map((row) => ({ ...row, import_id: importId }));

  try {
    await insertRowsInChunks(daysTable, dayRows as unknown as JsonRecord[]);
    await insertRowsInChunks(monthlySummaryTable, summaryRows as unknown as JsonRecord[]);
  } catch (error) {
    await getSupabaseAdmin().from(importsTable).delete().eq("id", importId);
    throw error;
  }

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: importId,
    entityType: "field_workforce_compliance_import",
    newValues: {
      employeeCount: rows.importRow.employee_count,
      highSeverityCount: rows.importRow.high_severity_count,
      monthKey: rows.importRow.month_key,
      reviewCandidateCount: rows.importRow.review_candidate_count,
      sourceFilename: rows.importRow.source_filename,
      status: rows.importRow.status,
    },
    summary: "Field Workforce Compliance month archived.",
  });

  return {
    archive: mapImportRow(savedImport as FieldWorkforceImportRow),
    preview: input.preview,
  };
}

export async function loadFieldWorkforceComplianceArchive(input: {
  actorLoginId: string;
  auditView?: boolean;
  id: string;
}): Promise<FieldWorkforceArchiveDetail | null> {
  const supabase = getSupabaseAdmin();
  const { data: importRow, error: importError } = await supabase
    .from(importsTable)
    .select("*")
    .eq("id", input.id)
    .maybeSingle();

  if (importError) throw importError;
  if (!importRow) return null;

  const [daysResult, summaryResult] = await Promise.all([
    supabase.from(daysTable).select("*").eq("import_id", input.id).order("employee_name").order("activity_date"),
    supabase.from(monthlySummaryTable).select("*").eq("import_id", input.id).order("employee_name"),
  ]);

  if (daysResult.error) throw daysResult.error;
  if (summaryResult.error) throw summaryResult.error;

  const detail = fieldWorkforcePreviewFromArchiveRows({
    dayRows: (daysResult.data ?? []) as FieldWorkforceDayRow[],
    importRow: importRow as FieldWorkforceImportRow,
    summaryRows: (summaryResult.data ?? []) as FieldWorkforceSummaryRow[],
  });

  if (input.auditView ?? true) {
    await writeAuditLog({
      actorLoginId: input.actorLoginId,
      entityId: input.id,
      entityType: "field_workforce_compliance_import",
      newValues: {
        monthKey: detail.archive.monthKey,
        sourceFilename: detail.archive.sourceFilename,
        status: detail.archive.status,
      },
      summary: "Field Workforce Compliance archived month viewed.",
    });
  }

  return detail;
}

export async function getFieldWorkforceComplianceComparison(input: {
  actorLoginId: string;
}): Promise<FieldWorkforceComparisonReport> {
  const archives = await listFieldWorkforceComplianceArchives();
  if (archives.length < 2) {
    if (archives.length > 0) {
      await writeAuditLog({
        actorLoginId: input.actorLoginId,
        entityId: "field-workforce-comparison",
        entityType: "field_workforce_compliance_import",
        newValues: {
          archiveCount: archives.length,
        },
        summary: "Field Workforce Compliance comparison view opened.",
      });
    }
    return {
      archiveCount: archives.length,
      hierarchyAvailable: false,
      rows: [],
    };
  }

  const archiveById = new Map(archives.map((archive) => [archive.id, archive]));
  const { data, error } = await getSupabaseAdmin()
    .from(monthlySummaryTable)
    .select("*")
    .in("import_id", archives.map((archive) => archive.id))
    .order("month_key", { ascending: false })
    .order("employee_name", { ascending: true });

  if (error) throw error;

  const rows = ((data ?? []) as FieldWorkforceSummaryRow[]).map((row) => {
    const archive = archiveById.get(String(row.import_id));
    return {
      areaName: row.area_name ?? null,
      campaignDays: asNumber(row.campaign_days),
      compliancePercent: asNumber(row.compliance_percent),
      employeeCode: String(row.employee_code),
      employeeName: String(row.employee_name),
      employmentStatus: row.employment_status ?? null,
      importId: String(row.import_id),
      lineName: row.line_name ?? null,
      managerName: row.manager_name ?? null,
      monthKey: archive?.monthKey ?? String(row.month_key),
      noActivityDays: asNumber(row.no_activity_days),
      roleName: row.role_name ?? null,
      teamName: row.team_name ?? null,
      totalVisits: asNumber(row.total_visits),
      vacationDays: asNumber(row.vacation_days),
      workedDays: asNumber(row.worked_days),
    };
  });

  await writeAuditLog({
    actorLoginId: input.actorLoginId,
    entityId: "field-workforce-comparison",
    entityType: "field_workforce_compliance_import",
    newValues: {
      archiveCount: archives.length,
      rowCount: rows.length,
    },
    summary: "Field Workforce Compliance comparison view opened.",
  });

  return {
    archiveCount: archives.length,
    hierarchyAvailable: rows.some((row) =>
      Boolean(row.managerName || row.lineName || row.areaName || row.teamName || row.roleName || row.employmentStatus),
    ),
    rows,
  };
}
