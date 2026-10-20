import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";
import { daysInMonth } from "@/lib/field-workforce-compliance/parser";
import { isFieldWorkforceWeeklyOff } from "@/lib/field-workforce-compliance/weekend-policy";
import { classifyEmployeeNode } from "@/lib/workforce-classification";
import type {
  FieldWorkforceCellStatus,
  FieldWorkforceDayCell,
  FieldWorkforceEmployeeReference,
  FieldWorkforceEmployeeSummary,
  FieldWorkforceHoliday,
  FieldWorkforceParsedEmployeeRow,
  FieldWorkforceParsedWorkbook,
  FieldWorkforcePreviewResult,
  FieldWorkforceReviewCandidate,
  FieldWorkforceReviewCandidateType,
  FieldWorkforceSeverity,
  FieldWorkforceSourceCellValue,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";

const severityOrder: Record<FieldWorkforceSeverity, number> = {
  High: 4,
  Review: 3,
  Medium: 2,
  Low: 1,
};

const statusMeaning: Record<FieldWorkforceCellStatus, string> = {
  AV: "Vacation signal",
  BLANK: "Blank",
  CP: "Campaign activity",
  F: "Friday/weekend",
  N: "No activity candidate",
  UNKNOWN: "Unknown value",
  VISITS: "Numeric visits",
};

function dateAddDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateRange(startDate: string, endDate: string) {
  const dates: string[] = [];
  for (let date = startDate; date <= endDate; date = dateAddDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function monthDates(year: number, month: number) {
  const count = daysInMonth(year, month);
  return Array.from({ length: count }, (_, index) => {
    const day = index + 1;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  });
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

function isFriday(dateIso: string) {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 5;
}

function normalizeRawValue(value: FieldWorkforceSourceCellValue) {
  if (value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function classifyRawValue(value: FieldWorkforceSourceCellValue): {
  status: FieldWorkforceCellStatus;
  visitCount?: number;
} {
  if (value === null) return { status: "BLANK" };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { status: "VISITS", visitCount: value } : { status: "UNKNOWN" };
  }
  const raw = normalizeRawValue(value);
  if (!raw) return { status: "BLANK" };
  const normalized = raw.toUpperCase();
  if (normalized === "N") return { status: "N" };
  if (normalized === "AV") return { status: "AV" };
  if (normalized === "CP") return { status: "CP" };
  if (normalized === "F") return { status: "F" };
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { status: "VISITS", visitCount: Number(raw) };
  return { status: "UNKNOWN" };
}

function emptySeverityCounts(): Record<FieldWorkforceSeverity, number> {
  return {
    High: 0,
    Low: 0,
    Medium: 0,
    Review: 0,
  };
}

function incrementSeverity(
  counts: Record<FieldWorkforceSeverity, number>,
  severity: FieldWorkforceSeverity | undefined,
) {
  if (severity) counts[severity] += 1;
}

function highestSeverity(values: Array<FieldWorkforceSeverity | undefined>) {
  return values.reduce<FieldWorkforceSeverity | undefined>((current, next) => {
    if (!next) return current;
    if (!current || severityOrder[next] > severityOrder[current]) return next;
    return current;
  }, undefined);
}

function holidayMap(holidays: FieldWorkforceHoliday[]) {
  const map = new Map<string, string>();
  for (const holiday of holidays) {
    const endDate = holiday.endDate ?? holiday.startDate;
    for (const date of dateRange(holiday.startDate, endDate)) {
      map.set(date, holiday.name);
    }
  }
  return map;
}

function referenceLookup(employees: FieldWorkforceEmployeeReference[]) {
  const map = new Map<string, FieldWorkforceEmployeeReference>();
  for (const employee of employees) {
    const key = canonicalHrIdKey(employee.hrId);
    if (key) map.set(key, employee);
  }
  return map;
}

function explainCell(input: {
  holidayName?: string;
  ignoreReason?: string;
  isFriday: boolean;
  isPreHire: boolean;
  isPublicHoliday: boolean;
  status: FieldWorkforceCellStatus;
  visitCount?: number;
}) {
  if (input.ignoreReason === "before_hiring_date") return "Ignored because before hiring date.";
  if (input.ignoreReason === "after_exit_date") return "Ignored because the employee resigned/exited before this day.";
  if (input.ignoreReason === "national_holiday") return `Excluded — national holiday${input.holidayName ? `: ${input.holidayName}` : ""}.`;
  if (input.ignoreReason === "weekly_off") return "Excluded because weekly day off.";
  if (input.status === "UNKNOWN") return "Review needed: unknown value in monthly file.";
  if (input.status === "N" && input.isPublicHoliday) return "No activity entered on a public holiday; review as holiday context, not normal deduction.";
  if (input.status === "AV" && input.isPublicHoliday) return "Vacation signal overlaps a public holiday; reconcile before any leave action.";
  if (input.status === "CP" && input.isPublicHoliday) return "Campaign activity recorded on a public holiday; review context.";
  if (input.status === "VISITS" && input.isPublicHoliday) return "Numeric visits recorded on a public holiday; review context.";
  if (input.isPublicHoliday) return `Highlighted because public holiday${input.holidayName ? `: ${input.holidayName}` : ""}.`;
  if (input.status === "VISITS") return `Worked day because ${input.visitCount ?? 0} numeric visits detected.`;
  if (input.status === "CP") return "Campaign activity detected; counted as worked day, not numeric visits.";
  if (input.status === "AV") return "Vacation signal detected; reconciliation review only.";
  if (input.status === "N") return "No activity entered; review candidate only.";
  if (input.status === "F") return "Friday/weekend marker.";
  return "Blank cell in monthly timeline.";
}

function cellContext(cell: {
  holidayName?: string;
  ignored: boolean;
  ignoreReason?: string;
  isFriday: boolean;
  isPreHire: boolean;
  isPublicHoliday: boolean;
  status: FieldWorkforceCellStatus;
}) {
  const context: string[] = [];
  if (cell.isPreHire) context.push("Pre-hire");
  if (cell.isFriday) context.push("Friday");
  else if (cell.ignoreReason === "weekly_off") context.push("Weekly off");
  if (cell.isPublicHoliday) context.push(cell.holidayName ? `National vacation: ${cell.holidayName}` : "National vacation");
  if (cell.status === "UNKNOWN") context.push("Unknown value");
  if (cell.ignored) context.push("Ignored");
  return context;
}

function candidateTypeForCell(cell: FieldWorkforceDayCell): FieldWorkforceReviewCandidateType | null {
  if (cell.status === "UNKNOWN") return "unknown_value";
  if (cell.isPreHire) {
    if (cell.status === "VISITS" || cell.status === "CP" || cell.status === "AV") {
      return "pre_hire_activity";
    }
    return null;
  }
  // Weekly-off days and national holidays are not working days — they raise no candidates.
  if (cell.ignored) return null;
  if (cell.status === "N") return "no_activity";
  if (cell.status === "AV") return "vacation_signal";
  return null;
}

function candidateFromCell(cell: FieldWorkforceDayCell, employeeIndex: number): FieldWorkforceReviewCandidate | null {
  const type = candidateTypeForCell(cell);
  if (!type || !cell.severity) return null;
  return {
    context: cell.context,
    dateIso: cell.dateIso,
    dayNumber: cell.dayNumber,
    employeeName: cell.employeeName,
    explanation: cell.explanation,
    holidayName: cell.holidayName,
    hrId: cell.hrId,
    id: `${employeeIndex}:${cell.dateIso}:${type}`,
    normalizedMeaning: statusMeaning[cell.status],
    rawValue: cell.rawValue,
    severity: cell.severity,
    type,
  };
}

function updateNoActivitySeverity(cells: FieldWorkforceDayCell[]) {
  const normalNoActivityCells = cells.filter((cell) =>
    cell.status === "N" &&
    !cell.isPreHire &&
    !cell.isFriday &&
    !cell.isPublicHoliday,
  );
  if (normalNoActivityCells.length === 0) return;

  const runs = new Map<string, number>();
  let currentRun: FieldWorkforceDayCell[] = [];
  for (const cell of normalNoActivityCells) {
    const previous = currentRun[currentRun.length - 1];
    if (!previous || cell.dayNumber === previous.dayNumber + 1) {
      currentRun.push(cell);
    } else {
      currentRun.forEach((runCell) => runs.set(runCell.dateIso, currentRun.length));
      currentRun = [cell];
    }
  }
  currentRun.forEach((runCell) => runs.set(runCell.dateIso, currentRun.length));

  for (const cell of normalNoActivityCells) {
    const runLength = runs.get(cell.dateIso) ?? 1;
    cell.severity = runLength > 1 || normalNoActivityCells.length > 1 ? "Medium" : "Low";
  }
}

export function buildFieldWorkforceNoActivityPattern(cells: FieldWorkforceDayCell[]) {
  const noActivityCells = cells.filter((cell) =>
    cell.countedAsNoActivityCandidate &&
    !cell.isPreHire &&
    !cell.ignored,
  );
  const timelineByDate = new Map(cells.map((cell) => [cell.dateIso, cell]));
  const adjacentToFridayDates = new Set<string>();
  const adjacentToPublicHolidayDates = new Set<string>();
  let longestStreak = 0;
  let consecutiveSignalCount = 0;
  let currentStreak = 0;

  for (const cell of noActivityCells) {
    const previous = timelineByDate.get(dateAddDays(cell.dateIso, -1));
    const next = timelineByDate.get(dateAddDays(cell.dateIso, 1));
    if (previous?.isFriday || next?.isFriday) adjacentToFridayDates.add(cell.dateIso);
    if (previous?.isPublicHoliday || next?.isPublicHoliday) adjacentToPublicHolidayDates.add(cell.dateIso);

    const previousNoActivity = noActivityCells.some((candidate) => candidate.dateIso === dateAddDays(cell.dateIso, -1));
    if (previousNoActivity) {
      currentStreak += 1;
    } else {
      currentStreak = 1;
    }
    if (currentStreak > longestStreak) longestStreak = currentStreak;
  }

  if (longestStreak >= 2) consecutiveSignalCount += 1;
  if (longestStreak >= 3) consecutiveSignalCount += 1;
  if (adjacentToFridayDates.size > 0) consecutiveSignalCount += 1;
  if (adjacentToPublicHolidayDates.size > 0) consecutiveSignalCount += 1;
  if (noActivityCells.length >= 5) consecutiveSignalCount += 1;

  const signals: string[] = [];
  if (longestStreak >= 2) signals.push(`${longestStreak}-day N streak`);
  if (adjacentToFridayDates.size > 0) signals.push("N adjacent to Friday/weekend");
  if (adjacentToPublicHolidayDates.size > 0) signals.push("N adjacent to public holiday");
  if (noActivityCells.length >= 5) signals.push("High monthly N count");

  return {
    adjacentToFridayDates: [...adjacentToFridayDates],
    adjacentToPublicHolidayDates: [...adjacentToPublicHolidayDates],
    consecutiveSignalCount,
    hasThreeDayStreak: longestStreak >= 3,
    hasTwoDayStreak: longestStreak >= 2,
    highMonthlyCount: noActivityCells.length >= 5,
    longestStreak,
    summary: signals.length > 0 ? signals.join("; ") : "No consecutive N pattern detected.",
  };
}

function buildEmployeeMatchCandidate(input: {
  employee: FieldWorkforceParsedEmployeeRow;
  employeeIndex: number;
  type: "hiring_date" | "employee_match";
  explanation: string;
  severity: FieldWorkforceSeverity;
}) {
  return {
    context: input.type === "employee_match" ? ["Unknown HR ID"] : ["Hiring date"],
    dateIso: null,
    dayNumber: null,
    employeeName: input.employee.employeeName || input.employee.hrId || "Unknown employee",
    explanation: input.explanation,
    hrId: canonicalHrIdForDisplay(input.employee.hrId) ?? input.employee.hrId,
    id: `${input.employeeIndex}:row:${input.type}`,
    normalizedMeaning: input.type === "employee_match" ? "Employee match issue" : "Hiring date issue",
    rawValue: input.type === "employee_match" ? input.employee.hrId : input.employee.rawHiringDate,
    severity: input.severity,
    type: input.type,
  } satisfies FieldWorkforceReviewCandidate;
}

function warningFromCandidate(candidate: FieldWorkforceReviewCandidate): FieldWorkforceValidationIssue {
  return {
    code: candidate.type,
    field: candidate.hrId,
    message: candidate.explanation,
    severity: candidate.severity === "High" ? "warning" : "warning",
  };
}

function buildTimeline(input: {
  employee: FieldWorkforceParsedEmployeeRow;
  employeeName: string;
  /** Last working date of an exited employee; days after it are ignored. */
  exitDateIso: string | null;
  holidayByDate: Map<string, string>;
  hrId: string;
  month: number;
  title: string | null;
  year: number;
}) {
  return monthDates(input.year, input.month).map((dateIso) => {
    const rawValue = input.employee.rawDailyValues[dateIso] ?? null;
    const { status, visitCount } = classifyRawValue(rawValue);
    const friday = isFriday(dateIso);
    const isWeeklyOff = isFieldWorkforceWeeklyOff({ dateIso, title: input.title });
    const isPreHire = Boolean(input.employee.hiringDateIso && dateIso < input.employee.hiringDateIso);
    const isPostExit = Boolean(input.exitDateIso && dateIso > input.exitDateIso);
    const holidayName = input.holidayByDate.get(dateIso);
    const isPublicHoliday = Boolean(holidayName);
    // National holidays and weekly-off days (Friday always; Saturday too unless the title is
    // Medical Rep / District Manager) are NOT working days — they never count as activity or
    // as absence, and they raise no review candidates. Days outside the employment span
    // (before hire / after a resigned employee's last working date) are likewise ignored.
    const ignored = isPreHire || isPostExit || isWeeklyOff || isPublicHoliday;
    const ignoreReason = isPreHire
      ? "before_hiring_date"
      : isPostExit
        ? "after_exit_date"
        : isPublicHoliday
          ? "national_holiday"
          : isWeeklyOff
            ? "weekly_off"
            : undefined;
    const eligible = !ignored;
    const countedAsWorkedDay = eligible && (status === "VISITS" || status === "CP");
    const countedAsVisitTotal = eligible && status === "VISITS";
    const countedAsNoActivityCandidate = eligible && status === "N";
    let severity: FieldWorkforceSeverity | undefined;

    if (status === "UNKNOWN") severity = "High";
    else if (isPreHire && (status === "VISITS" || status === "CP")) severity = "High";
    else if (isPreHire && status === "AV") severity = "Review";
    else if (eligible && status === "AV") severity = "Review";

    const cell = {
      context: [],
      countedAsNoActivityCandidate,
      countedAsVisitTotal,
      countedAsWorkedDay,
      dateIso,
      dayNumber: Number(dateIso.slice(8, 10)),
      employeeName: input.employeeName,
      explanation: explainCell({
        holidayName,
        ignoreReason,
        isFriday: friday,
        isPreHire,
        isPublicHoliday,
        status,
        visitCount,
      }),
      holidayName,
      hrId: input.hrId,
      ignored,
      ignoreReason,
      isFriday: friday,
      isPreHire,
      isPublicHoliday,
      rawValue,
      severity,
      status,
      visitCount,
    } satisfies FieldWorkforceDayCell;

    return {
      ...cell,
      context: cellContext(cell),
    };
  });
}

function buildEmployeeSummary(input: {
  employee: FieldWorkforceParsedEmployeeRow;
  employeeIndex: number;
  employeeReference: FieldWorkforceEmployeeReference | undefined;
  holidayByDate: Map<string, string>;
  month: number;
  reviewCandidates: FieldWorkforceReviewCandidate[];
  warnings: FieldWorkforceValidationIssue[];
  year: number;
}) {
  const displayHrId = canonicalHrIdForDisplay(input.employee.hrId) ?? input.employee.hrId;
  const officialHireDate = input.employeeReference?.hireDate?.slice(0, 10) ?? null;
  const hiringDateIso = input.employee.hiringDateIso ?? officialHireDate;
  const hiringDateSource = input.employee.hiringDateIso
    ? "workbook"
    : officialHireDate
      ? "employee_directory"
      : "missing";
  const employeeName = input.employeeReference?.fullName ?? input.employee.employeeName ?? displayHrId;
  const rowWithResolvedHireDate = {
    ...input.employee,
    hiringDateIso,
  };

  if (!input.employeeReference) {
    const candidate = buildEmployeeMatchCandidate({
      employee: input.employee,
      employeeIndex: input.employeeIndex,
      explanation: `Review needed: HR ID ${displayHrId || "(blank)"} was not found in the Phoenix employee directory.`,
      severity: "High",
      type: "employee_match",
    });
    input.reviewCandidates.push(candidate);
    input.warnings.push(warningFromCandidate(candidate));
  }

  if (!hiringDateIso) {
    const candidate = buildEmployeeMatchCandidate({
      employee: input.employee,
      employeeIndex: input.employeeIndex,
      explanation: `Review needed: hiring date is missing or invalid for ${employeeName}.`,
      severity: "High",
      type: "hiring_date",
    });
    input.reviewCandidates.push(candidate);
    input.warnings.push(warningFromCandidate(candidate));
  } else if (officialHireDate && input.employee.hiringDateIso && officialHireDate !== input.employee.hiringDateIso) {
    input.warnings.push({
      code: "hiring_date_mismatch",
      field: displayHrId,
      message: `Workbook hiring date ${input.employee.hiringDateIso} differs from Phoenix hire date ${officialHireDate} for ${employeeName}. Workbook date was used for Phase 1 preview.`,
      rowNumber: input.employee.sourceRowNumber,
      severity: "warning",
    });
  }

  const employmentStatus = String(input.employeeReference?.employmentStatus ?? "").trim().toLowerCase();
  const isExited = employmentStatus.length > 0 && !["active", "on_leave"].includes(employmentStatus);
  // Exited employees: days after the recorded last working date are ignored. When the
  // exit date was never recorded, the whole month is treated as post-exit — a resigned
  // employee must not generate no-activity warnings just because the CRM still lists them.
  const exitDateIso = isExited
    ? input.employeeReference?.lastWorkingDate?.slice(0, 10) ?? "1900-01-01"
    : null;

  const timeline = buildTimeline({
    employee: rowWithResolvedHireDate,
    employeeName,
    exitDateIso,
    holidayByDate: input.holidayByDate,
    hrId: displayHrId,
    month: input.month,
    title: input.employeeReference?.jobTitle ?? input.employeeReference?.roleName ?? null,
    year: input.year,
  });
  updateNoActivitySeverity(timeline);
  const noActivityPattern = buildFieldWorkforceNoActivityPattern(timeline);

  const severityCounts = emptySeverityCounts();
  const candidates = timeline
    .map((cell) => candidateFromCell(cell, input.employeeIndex))
    .filter((candidate): candidate is FieldWorkforceReviewCandidate => Boolean(candidate));
  input.reviewCandidates.push(...candidates);

  for (const cell of timeline) {
    incrementSeverity(severityCounts, cell.severity);
  }

  return {
    areaName: input.employeeReference?.areaName ?? null,
    // Pure-campaign days only here; a mixed day (regular + campaign) classifies as VISITS and its
    // campaignOverlay isn't attached yet at this stage — the live path recomputes campaignDays on
    // the enriched timeline (see ireports360-source.ts) so mixed days still count as campaign days.
    campaignDays: timeline.filter((cell) => !cell.ignored && cell.status === "CP").length,
    compliancePercent: timeline.filter((cell) => !cell.ignored).length > 0
      ? roundPercent((timeline.filter((cell) => cell.countedAsWorkedDay).length / timeline.filter((cell) => !cell.ignored).length) * 100)
      : 0,
    employeeName,
    employmentStatus: input.employeeReference?.employmentStatus ?? null,
    eligibleWorkingDays: timeline.filter((cell) => !cell.ignored).length,
    fridays: timeline.filter((cell) => !cell.isPreHire && cell.isFriday).length,
    hiringDateIso,
    hiringDateSource,
    holidayWarnings: timeline.filter((cell) => cell.isPublicHoliday && ["N", "AV", "CP", "VISITS"].includes(cell.status)).length,
    hrId: displayHrId,
    lineName: input.employeeReference?.lineName ?? null,
    managerHrId: input.employeeReference?.managerHrId ?? null,
    managerName: input.employeeReference?.managerName ?? null,
    managersAbove: input.employeeReference?.managersAbove ?? null,
    matchedEmployeeName: input.employeeReference?.fullName ?? null,
    matchedHrId: input.employeeReference?.hrId ?? null,
    matchStatus: input.employeeReference ? "matched" : "unmatched",
    noActivityCandidates: timeline.filter((cell) => cell.countedAsNoActivityCandidate).length,
    noActivityPattern,
    preHireIgnoredValues: timeline.filter((cell) => cell.isPreHire && cell.rawValue !== null).length,
    regionName: input.employeeReference?.regionName ?? null,
    roleName: input.employeeReference?.roleName ?? input.employeeReference?.jobTitle ?? null,
    severityCounts,
    sourceRowNumber: input.employee.sourceRowNumber,
    teamName: input.employeeReference?.teamName ?? null,
    timeline,
    totalVisits: timeline.reduce((sum, cell) => sum + (cell.countedAsVisitTotal ? cell.visitCount ?? 0 : 0), 0),
    unknownValues: timeline.filter((cell) => cell.status === "UNKNOWN").length,
    vacationSignalDays: timeline.filter((cell) => !cell.ignored && cell.status === "AV").length,
    workedDays: timeline.filter((cell) => cell.countedAsWorkedDay).length,
  } satisfies FieldWorkforceEmployeeSummary;
}

function sortReviewCandidates(left: FieldWorkforceReviewCandidate, right: FieldWorkforceReviewCandidate) {
  const severity = severityOrder[right.severity] - severityOrder[left.severity];
  if (severity !== 0) return severity;
  const leftDate = left.dateIso ?? "0000-00-00";
  const rightDate = right.dateIso ?? "0000-00-00";
  const date = leftDate.localeCompare(rightDate);
  if (date !== 0) return date;
  return left.employeeName.localeCompare(right.employeeName);
}

/**
 * Order employee rows hierarchically so the team calendar is grouped by manager (DSM):
 * each manager appears first, immediately followed by their direct reports (recursively),
 * instead of the raw workbook order. Roots (employees whose manager is not in this set,
 * e.g. DSMs when the RSM is absent) are listed alphabetically; reports under each manager
 * are alphabetical too. Grouping uses manager_hr_id; visited is tracked by object identity
 * so duplicate HR IDs are never dropped and cycles cannot loop.
 */
function orderEmployeesByHierarchy(
  employees: FieldWorkforceEmployeeSummary[],
): FieldWorkforceEmployeeSummary[] {
  const normalize = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();
  const present = new Set(employees.map((employee) => normalize(employee.hrId)));
  const childrenByManager = new Map<string, FieldWorkforceEmployeeSummary[]>();
  const roots: FieldWorkforceEmployeeSummary[] = [];

  for (const employee of employees) {
    const managerKey = normalize(employee.managerHrId);
    if (managerKey && present.has(managerKey) && managerKey !== normalize(employee.hrId)) {
      const list = childrenByManager.get(managerKey) ?? [];
      list.push(employee);
      childrenByManager.set(managerKey, list);
    } else {
      roots.push(employee);
    }
  }

  const byName = (left: FieldWorkforceEmployeeSummary, right: FieldWorkforceEmployeeSummary) =>
    left.employeeName.localeCompare(right.employeeName);
  roots.sort(byName);
  for (const list of childrenByManager.values()) list.sort(byName);

  const ordered: FieldWorkforceEmployeeSummary[] = [];
  const visited = new Set<FieldWorkforceEmployeeSummary>();
  const visit = (employee: FieldWorkforceEmployeeSummary) => {
    if (visited.has(employee)) return;
    visited.add(employee);
    ordered.push(employee);
    for (const child of childrenByManager.get(normalize(employee.hrId)) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  // Safety net: surface any employee not reached (duplicate HR IDs / cycles) rather than drop it.
  for (const employee of employees) {
    if (!visited.has(employee)) ordered.push(employee);
  }
  return ordered;
}

export function buildFieldWorkforceCompliancePreview(input: {
  employeeReferences?: FieldWorkforceEmployeeReference[];
  /** See FieldWorkforcePreviewMetadata.holidayCalendarReachable. Optional so the Excel-upload
   * path and existing callers/fixtures are unaffected; undefined means "not asserted". */
  holidayCalendarReachable?: boolean;
  holidayConnected: boolean;
  holidayMessage?: string | null;
  holidaySourceLabel: string;
  holidays?: FieldWorkforceHoliday[];
  parsed: FieldWorkforceParsedWorkbook;
}): FieldWorkforcePreviewResult {
  const parsed = input.parsed;
  const month = parsed.month ?? 1;
  const year = parsed.year ?? new Date().getFullYear();
  const holidayByDate = holidayMap(input.holidays ?? []);
  const references = referenceLookup(input.employeeReferences ?? []);
  const warnings = [...parsed.warnings];
  const reviewCandidates: FieldWorkforceReviewCandidate[] = [];

  // Resolve each workbook/matrix row's employee reference once, then drop rows for
  // employees who have left the company (same canonical classifier used everywhere else in
  // the app) before building summaries — this is the shared pipeline for BOTH the live
  // iReports360 source and manual Excel uploads, so a departed employee's row is excluded
  // permanently regardless of which one produced it. Unmatched rows (no directory reference)
  // pass through unchanged: there is no status to classify, and the existing "not found in
  // directory" review candidate already flags them for HR.
  const rowsWithReferences = parsed.rows.map((employee) => {
    const reference = canonicalHrIdKey(employee.hrId);
    return { employee, employeeReference: reference ? references.get(reference) : undefined };
  });
  const employees = rowsWithReferences
    .filter(
      ({ employeeReference }) =>
        !employeeReference || classifyEmployeeNode(employeeReference).eligible_for_headcount,
    )
    .map(({ employee, employeeReference }, employeeIndex) =>
      buildEmployeeSummary({
        employee,
        employeeIndex,
        employeeReference,
        holidayByDate,
        month,
        reviewCandidates,
        warnings,
        year,
      }),
    );

  const severityCounts = emptySeverityCounts();
  for (const candidate of reviewCandidates) {
    incrementSeverity(severityCounts, candidate.severity);
  }

  const firstDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDate = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
  const matchedEmployees = employees.filter((employee) => employee.matchStatus === "matched").length;
  const highestIssue = highestSeverity(reviewCandidates.map((candidate) => candidate.severity));
  if (highestIssue) {
    warnings.push({
      code: "review_candidates_generated",
      message: `${reviewCandidates.length} review candidates were generated. Highest severity: ${highestIssue}.`,
      severity: "warning",
    });
  }

  return {
    errors: parsed.errors,
    employees: orderEmployeesByHierarchy(employees),
    metadata: {
      dateRange: {
        end: lastDate,
        start: firstDate,
      },
      employeeCount: employees.length,
      fileName: parsed.fileName,
      holidayCalendarReachable: input.holidayCalendarReachable ?? null,
      holidayConnected: input.holidayConnected,
      holidayMessage: input.holidayMessage ?? null,
      holidaySourceLabel: input.holidaySourceLabel,
      holidaysDetected: input.holidays?.length ?? 0,
      matchedEmployees,
      month,
      monthLabel: parsed.monthLabel ?? `Month ${month}`,
      sheetName: parsed.sheetName,
      unmatchedEmployees: employees.length - matchedEmployees,
      year,
    },
    reviewCandidates: reviewCandidates.sort(sortReviewCandidates),
    severityCounts,
    warnings,
  };
}
