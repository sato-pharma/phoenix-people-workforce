// ── DSM coaching audit export ─────────────────────────────────────────────────────────
//
// The on-screen Double Visit Analytics board, poured into one filtered workbook: a Summary
// tab plus one tab per coach, each coach tab carrying the full coaching trail — per rep (with
// the rep's employment status), per day (with the field-hours span from GPS check-ins), the
// window split into real-date weeks, and every single dated visit. It reproduces, as a Phoenix
// feature, the hand-built audit workbook the owner approved (the Anti-Infective September
// review), now driven by his own board filters rather than a one-off script.
//
// Every number comes from the SAME loaders the board uses — getLiveDoubleVisitRows' mirror +
// identity resolution (so a reused/resigned CRM slot is credited to the right person, the
// Nosiba case) and buildManagerSummariesDetailed for the per-coach KPI strip and role code —
// so the export can never drift from the screen. The three board filters flow straight through:
//   • date range  → the read window (server-side, as the board already does),
//   • role        → which coaches become tabs (roleCode === role; ALL = every coach, so the
//                    non-DSM coaches appear as their own tabs exactly as the owner asked),
//   • period      → when set, only AM / PM / Pharmacy rows survive, narrowing every figure.
//
// Field hours are the GPS check-in span: each double-visit row is matched to the rep's own
// check-ins by (agent_crm_id, contact_crm_id, day), and a coach's field hours for a day is the
// first→last check-in across all his rows that day. The vendor clock is already Cairo
// wall-clock, so the span is read as-is and never timezone-shifted (see field-activity/model).
// GPS is a partial feed, so a day with no matched check-in shows blank hours, never 0.

import ExcelJS from "exceljs";

import type { AccessContext } from "@/lib/auth/permissions";
import { getDoubleVisitRows, queryCheckins } from "@/lib/crm/reads";
import { getCrmIdentityResolutions } from "@/lib/crm/identity";
import { doubleVisitCountBucket } from "@/lib/double-visit-analytics/count-bucket";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { cairoTodayIso } from "@/lib/crm/dates";
import {
  buildManagerSummariesDetailed,
  filterRowsForAccess,
  liveDoubleVisitRowsFromMirror,
  resolveDoubleVisitAccessScope,
  type DoubleVisitDbRow,
  type MirrorVisitRow,
} from "@/lib/double-visit-analytics/service";
import type { DoubleVisitRoleCode } from "@/lib/double-visit-analytics/types";

const DOUBLE_VISIT_TYPE_CODES = [0, -8] as const;

/** The board's own period toggle (ALL · AM · PM · Pharmacies). */
export type AuditPeriodFilter = "ALL" | "AM" | "PM" | "Pharmacies";
/** The board's own role toggle — ALL, or one DV role code. */
export type AuditRoleFilter = "ALL" | DoubleVisitRoleCode;

/** A rep's employment state as the audit labels it — "" means an active, mapped Medical Rep. */
type AuditStatus = "" | "resigned" | "unmapped" | "non-MR";

export type DoubleVisitAuditWeek = {
  /** 1-based position in the window. */
  index: number;
  /** "W1 (Sep 1–7)" — a real calendar range, never a bare "W1" (owner, 2026: "mention from 9"). */
  label: string;
  /** "Sep 1–7". */
  rangeLabel: string;
  start: string;
  end: string;
};

export type DoubleVisitAuditRepRow = {
  name: string;
  hrId: string | null;
  status: AuditStatus;
  totalDvs: number;
  days: number;
  /** Double visits in each window week, index-aligned to {@link DoubleVisitAuditData.weeks}. */
  weekly: number[];
};

export type DoubleVisitAuditDayRow = {
  date: string;
  weekday: string;
  weekLabel: string;
  reps: number;
  dvs: number;
  am: number;
  pm: number;
  pharmacies: number;
  /** "HH:MM" of the first/last matched GPS check-in, or null when GPS never recorded the day. */
  firstCheckIn: string | null;
  lastCheckIn: string | null;
  /** First→last check-in span in hours, or null when GPS did not record the day. */
  fieldHours: number | null;
};

export type DoubleVisitAuditVisitRow = {
  date: string;
  weekday: string;
  weekLabel: string;
  repName: string;
  repStatus: AuditStatus;
  customer: string;
  speciality: string;
  period: string;
  visitType: string;
};

export type DoubleVisitAuditCoach = {
  hrId: string;
  name: string;
  roleCode: DoubleVisitRoleCode | null;
  roleLabel: string | null;
  area: string | null;
  line: string | null;
  status: AuditStatus;
  totalDvs: number;
  activeDays: number;
  am: number;
  pm: number;
  pharmacies: number;
  distinctMrs: number;
  daysWithGps: number;
  reps: DoubleVisitAuditRepRow[];
  perDay: DoubleVisitAuditDayRow[];
  detail: DoubleVisitAuditVisitRow[];
};

export type DoubleVisitAuditData = {
  dateFrom: string;
  dateTo: string;
  period: AuditPeriodFilter;
  role: AuditRoleFilter;
  /** Human-readable scope of the viewer (what the access context lets them see). */
  scopeLabel: string;
  generatedAt: string;
  weeks: DoubleVisitAuditWeek[];
  coaches: DoubleVisitAuditCoach[];
};

/** The mirror row plus the one extra id the board's own loader doesn't request — contact_crm_id,
 * needed to match a visit to the rep's GPS check-in for field hours. */
type MirrorAuditRow = MirrorVisitRow & { contact_crm_id: number | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function nullableText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function addDaysIso(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Weekday from a date-only string — read in UTC so it never shifts with the server timezone. */
function weekdayOf(dateIso: string): string {
  const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return WEEKDAYS[day] ?? "";
}

function monthDayLabel(dateIso: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/** The time portion of a vendor check-in timestamp, as-is (already Cairo wall-clock, never shifted). */
function checkInTime(value: string | null | undefined): string | null {
  const raw = text(value);
  const match = raw.match(/[T ](\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map((part) => Number(part));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** Split [dateFrom, dateTo] into real-date weeks of 7 days from the start (clamped to the end). The
 * label carries the actual range, not just "W1" — the owner's rule after an earlier "W1/W2" sheet.
 * Pure, exported for its unit test. */
export function buildAuditWeeks(dateFrom: string, dateTo: string): DoubleVisitAuditWeek[] {
  if (!dateFrom || !dateTo || dateFrom > dateTo) return [];
  const weeks: DoubleVisitAuditWeek[] = [];
  let start = dateFrom;
  let index = 1;
  // Guard against a pathological range; a year of weeks is already far past any real board filter.
  while (start <= dateTo && index <= 60) {
    const end = addDaysIso(start, 6) > dateTo ? dateTo : addDaysIso(start, 6);
    const rangeLabel =
      start === end
        ? monthDayLabel(start)
        : `${monthDayLabel(start)}–${new Date(`${start}T00:00:00Z`).getUTCMonth() === new Date(`${end}T00:00:00Z`).getUTCMonth() ? new Date(`${end}T00:00:00Z`).getUTCDate() : monthDayLabel(end)}`;
    weeks.push({ index, label: `W${index} (${rangeLabel})`, rangeLabel, start, end });
    start = addDaysIso(end, 1);
    index += 1;
  }
  return weeks;
}

/** The window-week index (0-based) a date falls in, or -1 when it's outside every week. Pure. */
export function weekIndexOf(weeks: DoubleVisitAuditWeek[], dateIso: string): number {
  return weeks.findIndex((week) => dateIso >= week.start && dateIso <= week.end);
}

/** Keep only rows whose AM·PM·Pharmacies bucket matches the period filter. ALL keeps everything.
 * Pure, exported for its unit test. */
export function filterRowsByPeriod(rows: DoubleVisitDbRow[], period: AuditPeriodFilter): DoubleVisitDbRow[] {
  if (period === "ALL") return rows;
  return rows.filter((row) => doubleVisitCountBucket(row) === period);
}

function statusFromVisitedRow(row: DoubleVisitDbRow): AuditStatus {
  switch (row.visited_employee_status) {
    case "resigned":
      return "resigned";
    case "non_mr":
      return "non-MR";
    case "unmapped":
      return "unmapped";
    default:
      return "";
  }
}

/** The most notable status among a rep's rows — a flag wins over plain "active". */
function reduceStatus(statuses: AuditStatus[]): AuditStatus {
  for (const status of statuses) {
    if (status !== "") return status;
  }
  return "";
}

function coachStatus(hrId: string, employeeByHrKey: Map<string, EmployeeDirectoryRow>): AuditStatus {
  if (hrId.startsWith("CRM:")) return "unmapped";
  const employee = employeeByHrKey.get(canonicalHrIdKey(hrId) ?? "");
  if (!employee) return "unmapped";
  if (isTerminalEmploymentStatus(employee.employmentStatus)) return "resigned";
  return "";
}

/** A stable key for a rep: their resolved hr id, else their name (so an unmapped rep still groups). */
function repKey(row: DoubleVisitDbRow): string {
  const hrKey = canonicalHrIdKey(row.visited_employee_hr_id);
  if (hrKey) return `hr:${hrKey}`;
  return `name:${text(row.visited_employee_name).toLowerCase()}`;
}

function describeScope(access: AccessContext, employees: EmployeeDirectoryRow[]): string {
  const scope = resolveDoubleVisitAccessScope(access, employees);
  if ("all" in scope && scope.all) return "All lines and areas (company-wide)";
  return `${text(access.role) || "Scoped viewer"} — own reporting scope`;
}

/**
 * Load the audit dataset for the export: the board's own rows, scoped and filtered, grouped per
 * coach with the per-rep / per-day / dated-visit trails and field hours. The three board filters
 * (date, role, period) are honoured here so the workbook always matches the screen.
 */
export async function loadDoubleVisitAuditData(input: {
  access: AccessContext;
  dateFrom: string;
  dateTo: string;
  role: AuditRoleFilter;
  period: AuditPeriodFilter;
}): Promise<DoubleVisitAuditData> {
  const { access, dateFrom, dateTo, role, period } = input;
  const generatedAt = cairoTodayIso();
  const weeks = buildAuditWeeks(dateFrom, dateTo);

  const employees = await getEmployeeDirectoryRows({ includeInactive: true });
  const employeeByHrKey = new Map(
    employees
      .map((employee) => [canonicalHrIdKey(employee.hrId), employee] as const)
      .filter((entry): entry is [string, EmployeeDirectoryRow] => Boolean(entry[0])),
  );

  // Same read the board uses, plus contact_crm_id for the field-hours check-in match.
  const mirrorRows = await getDoubleVisitRows<MirrorAuditRow>({
    dateFrom,
    dateTo,
    visitTypes: [...DOUBLE_VISIT_TYPE_CODES],
    columns:
      "id, crm_visit_id, visit_date, agent_crm_id, agent_hr_id, agent_name, contact_name, customer_name, " +
      "double_crm_id, double_hr_id, double_name, ampm, visit_type, visit_type_description, speciality, contact_crm_id",
  });

  const resolutions = await getCrmIdentityResolutions();
  const dbRows = liveDoubleVisitRowsFromMirror(mirrorRows, employees, resolutions);
  const scopedRows = filterRowsByPeriod(filterRowsForAccess(dbRows, access, employees), period);

  // id → the mirror's crm ids (for the GPS check-in match) and the real customer/contact name,
  // which the resolved db row doesn't carry — so the dated detail names the doctor who was seen.
  const mirrorById = new Map<
    string,
    { agentCrmId: number | null; contactCrmId: number | null; customer: string | null }
  >();
  for (const row of mirrorRows) {
    mirrorById.set(row.id, {
      agentCrmId: row.agent_crm_id,
      contactCrmId: row.contact_crm_id,
      customer: nullableText(row.contact_name) ?? nullableText(row.customer_name),
    });
  }

  // GPS check-ins for every agent that recorded a scoped row, indexed by (agent, contact, day).
  const agentCrmIds = Array.from(
    new Set(
      scopedRows
        .map((row) => mirrorById.get(row.id)?.agentCrmId)
        .filter((id): id is number => typeof id === "number" && Number.isFinite(id)),
    ),
  );
  const checkInTimesByKey = new Map<string, string[]>();
  if (agentCrmIds.length > 0) {
    const checkIns = await queryCheckins<{ agent_crm_id: number | null; contact_crm_id: number | null; check_date: string }>({
      agentCrmIds,
      dateFrom,
      dateTo,
      columns: "agent_crm_id, contact_crm_id, check_date",
    });
    for (const checkIn of checkIns) {
      const time = checkInTime(checkIn.check_date);
      if (checkIn.agent_crm_id == null || checkIn.contact_crm_id == null || !time) continue;
      const day = text(checkIn.check_date).slice(0, 10);
      const key = `${checkIn.agent_crm_id}|${checkIn.contact_crm_id}|${day}`;
      checkInTimesByKey.set(key, [...(checkInTimesByKey.get(key) ?? []), time]);
    }
  }

  // Per-coach KPI strip + role code, from the SAME builder the board uses (so figures match).
  const { summaries } = buildManagerSummariesDetailed(scopedRows, employees, generatedAt);
  const summaryByKey = new Map(summaries.map((summary) => [summary.managerHrId, summary]));

  // Group the scoped rows by coach (the double-visitor).
  const rowsByCoach = new Map<string, DoubleVisitDbRow[]>();
  for (const row of scopedRows) {
    const key = canonicalHrIdKey(row.double_visitor_hr_id);
    if (!key) continue;
    rowsByCoach.set(key, [...(rowsByCoach.get(key) ?? []), row]);
  }

  const coaches: DoubleVisitAuditCoach[] = [];
  for (const summary of summaries) {
    // Role filter: a specific role keeps only that role's coaches (and drops the unmapped ones with
    // no role code), exactly as the board filters its manager list. ALL keeps every coach as a tab.
    if (role !== "ALL" && summary.roleCode !== role) continue;
    const coachRows = rowsByCoach.get(summary.managerHrId) ?? [];
    if (coachRows.length === 0) continue;

    coaches.push(
      buildCoach({
        summary,
        rows: coachRows,
        weeks,
        mirrorById,
        checkInTimesByKey,
        employeeByHrKey,
      }),
    );
  }

  return {
    dateFrom,
    dateTo,
    period,
    role,
    scopeLabel: describeScope(access, employees),
    generatedAt,
    weeks,
    coaches,
  };
}

function buildCoach(input: {
  summary: ReturnType<typeof buildManagerSummariesDetailed>["summaries"][number];
  rows: DoubleVisitDbRow[];
  weeks: DoubleVisitAuditWeek[];
  mirrorById: Map<string, { agentCrmId: number | null; contactCrmId: number | null; customer: string | null }>;
  checkInTimesByKey: Map<string, string[]>;
  employeeByHrKey: Map<string, EmployeeDirectoryRow>;
}): DoubleVisitAuditCoach {
  const { summary, rows, weeks, mirrorById, checkInTimesByKey, employeeByHrKey } = input;

  // ── Per rep ──
  const repGroups = new Map<string, { row: DoubleVisitDbRow; rows: DoubleVisitDbRow[] }>();
  for (const row of rows) {
    const key = repKey(row);
    const existing = repGroups.get(key);
    if (existing) existing.rows.push(row);
    else repGroups.set(key, { row, rows: [row] });
  }
  const reps: DoubleVisitAuditRepRow[] = Array.from(repGroups.values()).map((group) => {
    const weekly = weeks.map((week) =>
      group.rows.filter((row) => row.activity_date >= week.start && row.activity_date <= week.end).length,
    );
    return {
      name: text(group.row.visited_employee_name) || "(unmapped)",
      hrId: group.row.visited_employee_hr_id,
      status: reduceStatus(group.rows.map(statusFromVisitedRow)),
      totalDvs: group.rows.length,
      days: new Set(group.rows.map((row) => row.activity_date)).size,
      weekly,
    };
  });
  reps.sort((a, b) => b.totalDvs - a.totalDvs || a.name.localeCompare(b.name));

  // ── Per day (with field hours from GPS check-ins) ──
  const dayGroups = new Map<string, DoubleVisitDbRow[]>();
  for (const row of rows) {
    dayGroups.set(row.activity_date, [...(dayGroups.get(row.activity_date) ?? []), row]);
  }
  let daysWithGps = 0;
  const perDay: DoubleVisitAuditDayRow[] = Array.from(dayGroups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRows]) => {
      const times: string[] = [];
      for (const row of dayRows) {
        const crm = mirrorById.get(row.id);
        if (crm?.agentCrmId == null || crm.contactCrmId == null) continue;
        const matched = checkInTimesByKey.get(`${crm.agentCrmId}|${crm.contactCrmId}|${date}`);
        if (matched) times.push(...matched);
      }
      const uniqueTimes = Array.from(new Set(times)).sort();
      const first = uniqueTimes.at(0) ?? null;
      const last = uniqueTimes.at(-1) ?? null;
      const fieldHours =
        first && last ? Math.round(((minutesOf(last) - minutesOf(first)) / 60) * 100) / 100 : null;
      if (fieldHours != null) daysWithGps += 1;
      const week = weeks[weekIndexOf(weeks, date)];
      return {
        date,
        weekday: weekdayOf(date),
        weekLabel: week?.rangeLabel ?? "",
        reps: new Set(dayRows.map(repKey)).size,
        dvs: dayRows.length,
        am: dayRows.filter((row) => doubleVisitCountBucket(row) === "AM").length,
        pm: dayRows.filter((row) => doubleVisitCountBucket(row) === "PM").length,
        pharmacies: dayRows.filter((row) => doubleVisitCountBucket(row) === "Pharmacies").length,
        firstCheckIn: first,
        lastCheckIn: last,
        fieldHours,
      };
    });

  // ── Every dated visit ──
  const detail: DoubleVisitAuditVisitRow[] = rows
    .slice()
    .sort(
      (a, b) =>
        a.activity_date.localeCompare(b.activity_date) ||
        text(a.visited_employee_name).localeCompare(text(b.visited_employee_name)),
    )
    .map((row) => {
      const week = weeks[weekIndexOf(weeks, row.activity_date)];
      return {
        date: row.activity_date,
        weekday: weekdayOf(row.activity_date),
        weekLabel: week?.rangeLabel ?? "",
        repName: text(row.visited_employee_name) || "(unmapped)",
        repStatus: statusFromVisitedRow(row),
        customer:
          mirrorById.get(row.id)?.customer ??
          nullableText(row.chain_customer_names?.join("; ")) ??
          nullableText(row.chain_hinge_name) ??
          "—",
        speciality: text(row.speciality) || "—",
        period: row.period,
        visitType: text(row.visit_type_description) || String(row.visit_type ?? ""),
      };
    });

  return {
    hrId: summary.managerHrId,
    name: summary.managerName,
    roleCode: summary.roleCode,
    roleLabel: summary.role,
    area: summary.areaName,
    line: summary.lineName,
    status: coachStatus(summary.managerHrId, employeeByHrKey),
    totalDvs: summary.totalDvs,
    activeDays: summary.activeDvDays,
    am: summary.amVisits,
    pm: summary.pmVisits,
    pharmacies: summary.pharmacyVisits,
    distinctMrs: summary.distinctMrs,
    daysWithGps,
    reps,
    perDay,
    detail,
  };
}

const HEADER_FILL = "FF0F172A";
const SUBHEADER_FILL = "FF1E293B";
const PERIOD_LABELS: Record<AuditPeriodFilter, string> = {
  ALL: "All (AM · PM · Pharmacies)",
  AM: "AM only",
  PM: "PM only",
  Pharmacies: "Pharmacies only",
};
const STATUS_LABELS: Record<AuditStatus, string> = {
  "": "active",
  resigned: "resigned",
  unmapped: "unmapped",
  "non-MR": "non-MR",
};

function sanitizeSheetName(name: string, used: Set<string>): string {
  // Excel forbids : \ / ? * [ ] and caps a sheet name at 31 chars.
  const base = text(name).replace(/[:\\/?*[\]]/g, " ").slice(0, 28) || "Coach";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base.slice(0, 28 - String(suffix).length - 1)} ${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Build the audit workbook from the loaded dataset. Pure (no I/O) given the data. */
export async function buildDoubleVisitAuditWorkbook(data: DoubleVisitAuditData): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  buildSummarySheet(workbook, data);
  const usedNames = new Set<string>(["summary"]);
  for (const coach of data.coaches) {
    buildCoachSheet(workbook, sanitizeSheetName(coach.name, usedNames), coach, data.weeks);
  }

  return workbook;
}

function styleBandRow(row: ExcelJS.Row, fill: string): void {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { fgColor: { argb: fill }, pattern: "solid", type: "pattern" };
}

function buildSummarySheet(workbook: ExcelJS.Workbook, data: DoubleVisitAuditData): void {
  const sheet = workbook.addWorksheet("Summary");
  sheet.columns = [
    { width: 30 },
    { width: 10 },
    { width: 22 },
    { width: 14 },
    { width: 12 },
    { width: 12 },
    { width: 10 },
    { width: 10 },
    { width: 12 },
    { width: 12 },
    { width: 14 },
  ];

  sheet.addRow(["Double Visit Coaching Audit"]).font = { bold: true, size: 16 };
  sheet.addRow([`Scope: ${data.scopeLabel}`]);
  sheet.addRow([`Date range: ${data.dateFrom} to ${data.dateTo}`]);
  sheet.addRow([`Period filter: ${PERIOD_LABELS[data.period]}`]);
  sheet.addRow([`Role filter: ${data.role === "ALL" ? "All coaching roles" : data.role}`]);
  sheet.addRow([`Coaches in range: ${data.coaches.length}`]);
  sheet.addRow([`Data source: Live iReports360 Visits Report (auto-synced); field hours from GPS check-ins`]);
  sheet.addRow([`Generated: ${data.generatedAt} (Cairo)`]);
  sheet.addRow([]);

  const headerRow = sheet.addRow([
    "Coach",
    "Role",
    "Area",
    "Line",
    "Status",
    "Total DVs",
    "Days",
    "MRs",
    "AM",
    "PM",
    "Pharmacies",
  ]);
  styleBandRow(headerRow, HEADER_FILL);

  for (const coach of data.coaches) {
    sheet.addRow([
      coach.name,
      coach.roleCode ?? "—",
      coach.area ?? "—",
      coach.line ?? "—",
      STATUS_LABELS[coach.status],
      coach.totalDvs,
      coach.activeDays,
      coach.distinctMrs,
      coach.am,
      coach.pm,
      coach.pharmacies,
    ]);
  }

  sheet.addRow([]);
  const flaggedCoaches = data.coaches.filter((coach) => coach.status !== "");
  if (flaggedCoaches.length > 0) {
    styleBandRow(sheet.addRow(["Coaches needing identity review"]), SUBHEADER_FILL);
    for (const coach of flaggedCoaches) {
      sheet.addRow([coach.name, coach.roleCode ?? "—", "", "", STATUS_LABELS[coach.status]]);
    }
    sheet.addRow([]);
  }

  styleBandRow(sheet.addRow(["How to read this workbook"]), SUBHEADER_FILL);
  for (const line of [
    "One tab per coach, in the same order as this table (highest activity first).",
    "A double visit = a coach accompanying a rep on a Regular or Campaign field visit.",
    "AM · PM · Pharmacies are counted apart — a pharmacy visit is never one of the PM doctors.",
    "Status flags a rep or coach whose CRM identity needs review (resigned / unmapped / non-MR).",
    "Field hours = first-to-last GPS check-in that day; blank means GPS did not record the day (partial feed), never 0.",
    "Week columns show the real calendar range of each week in the selected date window.",
  ]) {
    sheet.addRow([line]);
  }

  sheet.views = [{ state: "frozen", ySplit: 10 }];
}

function buildCoachSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  coach: DoubleVisitAuditCoach,
  weeks: DoubleVisitAuditWeek[],
): void {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = [{ width: 30 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }];

  sheet.addRow([coach.name]).font = { bold: true, size: 14 };
  sheet.addRow([
    `${coach.roleLabel ?? coach.roleCode ?? "Coach"}${coach.status !== "" ? ` · ${STATUS_LABELS[coach.status]}` : ""}`,
  ]);
  sheet.addRow([`Area: ${coach.area ?? "—"}    Line: ${coach.line ?? "—"}`]);
  sheet.addRow([]);

  // KPI strip.
  const kpiHeader = sheet.addRow(["Total DVs", "Active Days", "MRs", "AM", "PM", "Pharmacies", "Days w/ GPS"]);
  styleBandRow(kpiHeader, HEADER_FILL);
  sheet.addRow([coach.totalDvs, coach.activeDays, coach.distinctMrs, coach.am, coach.pm, coach.pharmacies, coach.daysWithGps]);
  sheet.addRow([]);

  // Per rep — with status and weekly breakdown.
  styleBandRow(sheet.addRow(["Per rep"]), SUBHEADER_FILL);
  const repHeader = sheet.addRow(["Rep", "Status", "Total DVs", "Days", ...weeks.map((week) => week.label)]);
  styleBandRow(repHeader, HEADER_FILL);
  for (const rep of coach.reps) {
    sheet.addRow([rep.name, STATUS_LABELS[rep.status], rep.totalDvs, rep.days, ...rep.weekly]);
  }
  sheet.addRow([]);

  // Per day — with field hours.
  styleBandRow(sheet.addRow(["Per day"]), SUBHEADER_FILL);
  const dayHeader = sheet.addRow([
    "Date",
    "Day",
    "Week",
    "Reps",
    "DVs",
    "AM",
    "PM",
    "Pharmacies",
    "First CI",
    "Last CI",
    "Field Hours",
  ]);
  styleBandRow(dayHeader, HEADER_FILL);
  for (const day of coach.perDay) {
    sheet.addRow([
      day.date,
      day.weekday,
      day.weekLabel,
      day.reps,
      day.dvs,
      day.am,
      day.pm,
      day.pharmacies,
      day.firstCheckIn ?? "—",
      day.lastCheckIn ?? "—",
      day.fieldHours ?? "—",
    ]);
  }
  sheet.addRow([]);

  // Every dated visit.
  styleBandRow(sheet.addRow(["Every double visit"]), SUBHEADER_FILL);
  const detailHeader = sheet.addRow(["Date", "Day", "Week", "Rep", "Status", "Customer", "Speciality", "AM/PM", "Visit Type"]);
  styleBandRow(detailHeader, HEADER_FILL);
  for (const visit of coach.detail) {
    sheet.addRow([
      visit.date,
      visit.weekday,
      visit.weekLabel,
      visit.repName,
      STATUS_LABELS[visit.repStatus],
      visit.customer,
      visit.speciality,
      visit.period,
      visit.visitType,
    ]);
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];
}
