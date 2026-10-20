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
import { perDoubleVisitorRows } from "@/lib/double-visit-analytics/chain-visitors";
import { doubleVisitCountBucket } from "@/lib/double-visit-analytics/count-bucket";
import { getEmployeeDirectoryRows, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { cairoTodayIso } from "@/lib/crm/dates";
import {
  buildManagerSummariesDetailed,
  filterRowsForAccess,
  liveDoubleVisitRowsFromMirror,
  loadDoubleVisitScopeOptions,
  resolveDoubleVisitAccessScope,
  type DoubleVisitDbRow,
  type MirrorVisitRow,
} from "@/lib/double-visit-analytics/service";
import type { DoubleVisitRoleCode } from "@/lib/double-visit-analytics/types";
import {
  PHOENIX_VISIT_DETAIL_COLUMNS,
  phoenixDetailViewer,
  phoenixRowSight,
  phoenixVisitDetailColumns,
} from "@/lib/crm/phoenix-visit-detail";

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
  /** On a chain visit, the OTHER coach — the second one on the first coach's tab, the first on the
   * second's. Empty on a vendor row and on a plain double visit. Each coach's tab counts the visit once. */
  partner2: string;
  /** The Phoenix field set, already shaped to this reader's tier, one value per column. Null on a
   * vendor row — there is nothing behind it to print. */
  phoenixColumns: Record<string, string | number | null> | null;
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
  /** The Phoenix field set's column headers, in order, computed ONCE for the whole workbook.
   *
   * 🔴 NOT PER COACH AND NOT FROM THE FIRST ROW THAT HAS ONE. Sight is decided per row — a reader
   * looking at his own row as its rep is blinded — so a per-sheet header taken off whichever row
   * came first would give one coach's sheet fewer columns than another's, and shift every cell of a
   * row that carries more. The union, in first-appearance order, is the only stable header. */
  phoenixHeaders: string[];
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

/** Split [dateFrom, dateTo] into one window per calendar month it spans, each clamped to the range,
 * labelled "July 2026". For a range inside one month, a single section. Pure, exported for its test. */
export function splitRangeByMonth(dateFrom: string, dateTo: string): { label: string; from: string; to: string }[] {
  if (!dateFrom || !dateTo || dateFrom > dateTo) return [];
  const sections: { label: string; from: string; to: string }[] = [];
  let cursor = `${dateFrom.slice(0, 7)}-01`;
  let guard = 0;
  while (cursor <= dateTo && guard < 120) {
    const date = new Date(`${cursor}T00:00:00Z`);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const monthStart = `${cursor.slice(0, 7)}-01`;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const monthEnd = `${cursor.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
    const from = monthStart < dateFrom ? dateFrom : monthStart;
    const to = monthEnd > dateTo ? dateTo : monthEnd;
    sections.push({ label: `${MONTHS[month]} ${year}`, from, to });
    cursor = new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10);
    guard += 1;
  }
  return sections;
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
  /** Keep rows whose recording agent is a resigned CRM account — so a coaching audit SURFACES the
   * resigned/reused-slot reps (flagged by the Status column) instead of hiding them as the live
   * board does. Default false, so the board export is byte-for-byte what the screen shows. */
  includeResignedAgents?: boolean;
}): Promise<DoubleVisitAuditData> {
  const { access, dateFrom, dateTo, role, period, includeResignedAgents } = input;
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
    ...(includeResignedAgents ? { includeResignedAgents: true } : {}),
    columns:
      "id, crm_visit_id, visit_date, agent_crm_id, agent_hr_id, agent_name, contact_name, customer_name, " +
      "double_crm_id, double_hr_id, double_name, double2_crm_id, double2_hr_id, double2_name, ampm, " +
      "visit_type, visit_type_description, speciality, contact_crm_id, " +
      PHOENIX_VISIT_DETAIL_COLUMNS,
  });

  // The board's own scope options (a Product Manager's second line), so the workbook keeps matching
  // the screen (owner, 2026-10-20).
  const [resolutions, scopeOptions] = await Promise.all([getCrmIdentityResolutions(), loadDoubleVisitScopeOptions()]);
  const dbRows = liveDoubleVisitRowsFromMirror(mirrorRows, employees, resolutions);
  const scopedRows = filterRowsByPeriod(filterRowsForAccess(dbRows, access, employees, scopeOptions), period);

  // id → the mirror's crm ids (for the GPS check-in match) and the real customer/contact name,
  // which the resolved db row doesn't carry — so the dated detail names the doctor who was seen.
  //
  // 🔴 THE TIER IS DECIDED HERE, where the reader is known. A row this reader is himself the rep of
  // reads `none` (phoenixRowSight) — the owner's 2026-10-02 rule, which "everything on the admin
  // reports" does not reopen. `phoenixHeaders` below is the union of what survives that, in order.
  const detailViewer = phoenixDetailViewer(access.role, access.hrId);
  const phoenixHeaders: string[] = [];
  const mirrorById = new Map<
    string,
    {
      agentCrmId: number | null;
      contactCrmId: number | null;
      customer: string | null;
      partner2: string | null;
      phoenixColumns: Record<string, string | number | null> | null;
    }
  >();
  for (const row of mirrorRows) {
    const phoenixColumns = row.visit_kind
      ? phoenixVisitDetailColumns(row, phoenixRowSight(detailViewer, row.agent_hr_id))
      : null;
    for (const header of Object.keys(phoenixColumns ?? {})) {
      if (!phoenixHeaders.includes(header)) phoenixHeaders.push(header);
    }
    mirrorById.set(row.id, {
      agentCrmId: row.agent_crm_id,
      contactCrmId: row.contact_crm_id,
      customer: nullableText(row.contact_name) ?? nullableText(row.customer_name),
      partner2: nullableText(row.double2_name ?? null),
      phoenixColumns,
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

  // Group the scoped rows by coach (the double-visitor). One entry per (visit, coach): a chain visit is in
  // BOTH coaches' tabs, counted the same in each (owner, 2026-10-08 — chain-visitors.ts).
  const rowsByCoach = new Map<string, DoubleVisitDbRow[]>();
  for (const row of perDoubleVisitorRows(scopedRows)) {
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
    phoenixHeaders,
  };
}

function buildCoach(input: {
  summary: ReturnType<typeof buildManagerSummariesDetailed>["summaries"][number];
  rows: DoubleVisitDbRow[];
  weeks: DoubleVisitAuditWeek[];
  mirrorById: Map<
    string,
    {
      agentCrmId: number | null;
      contactCrmId: number | null;
      customer: string | null;
      /** A chain visit's second coach, and the field set already shaped to this reader's tier. */
      partner2: string | null;
      phoenixColumns: Record<string, string | number | null> | null;
    }
  >;
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
        // The OTHER coach on a chain visit, from this coach's own view of the row — never himself.
        // A coach the reader's scope took off the row is not named either (filterRowsForAccess).
        partner2: nullableText(row.double_visitor2_name ?? null) ?? "",
        phoenixColumns: mirrorById.get(row.id)?.phoenixColumns ?? null,
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
    buildCoachSheet(workbook, sanitizeSheetName(coach.name, usedNames), coach, data.weeks, data.phoenixHeaders ?? []);
  }

  return workbook;
}

export type DoubleVisitAuditSection = { label: string; data: DoubleVisitAuditData };

/**
 * Several months (or windows) in ONE workbook, ONE TAB PER COACH: a combined Summary tab with a
 * leaderboard per section, then for each coach a single tab that stacks every section they appear
 * in — a "July 2026 · …" band, that month's KPI/per-rep/per-day/dated blocks, then "August 2026 · …",
 * and so on. A coach keeps each month's own figures and the whole of their quarter reads top to
 * bottom on one sheet (owner: "jul - aug - sep of the same dsm in one tab"). Pure given the sections.
 */
export async function buildCombinedAuditWorkbook(sections: DoubleVisitAuditSection[]): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { width: 30 }, { width: 10 }, { width: 22 }, { width: 14 }, { width: 12 },
    { width: 12 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 14 },
  ];
  summary.addRow(["Double Visit Coaching Audit — combined"]).font = { bold: true, size: 16 };
  if (sections[0]) {
    summary.addRow([`Scope: ${sections[0].data.scopeLabel}`]);
    summary.addRow([`Generated: ${sections[0].data.generatedAt} (Cairo)`]);
  }
  summary.addRow([]);

  for (const section of sections) {
    styleBandRow(
      summary.addRow([
        `${section.label}  ·  ${section.data.dateFrom} to ${section.data.dateTo}  ·  ${section.data.coaches.length} coaches`,
      ]),
      SUBHEADER_FILL,
    );
    styleBandRow(
      summary.addRow(["Coach", "Role", "Area", "Line", "Status", "Total DVs", "Days", "MRs", "AM", "PM", "Pharmacies"]),
      HEADER_FILL,
    );
    for (const coach of section.data.coaches) {
      summary.addRow([
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
    summary.addRow([]);
  }
  summary.views = [{ state: "frozen", ySplit: 1 }];

  // Gather each coach across every section, keyed by their resolved identity (hr id, else name), in
  // first-appearance order within each month so a coach's quarter reads in calendar order.
  // 🔴 ONE header union for the WHOLE combined workbook, not one per section. A coach's tab stacks
  // several months one under another, so two sections with different unions would put the same column
  // under two different headings on one sheet — and a reader scrolling down would read a distance as a
  // dwell. Order is first appearance, section by section.
  const combinedPhoenixHeaders: string[] = [];
  for (const section of sections) {
    // `?? []` although the field is REQUIRED on the type: a payload serialized before this change
    // (a cached response, a stored job input) carries no such key, and an export that throws is worse
    // than one printing the columns it always had. The type still refuses a NEW caller that omits it.
    for (const header of section.data.phoenixHeaders ?? []) {
      if (!combinedPhoenixHeaders.includes(header)) combinedPhoenixHeaders.push(header);
    }
  }

  type CoachTimeline = { key: string; name: string; entries: { label: string; coach: DoubleVisitAuditCoach; weeks: DoubleVisitAuditWeek[] }[] };
  const timelines = new Map<string, CoachTimeline>();
  for (const section of sections) {
    for (const coach of section.data.coaches) {
      const key = canonicalHrIdKey(coach.hrId) ?? `name:${coach.name.toLowerCase()}`;
      const timeline = timelines.get(key) ?? { key, name: coach.name, entries: [] };
      timeline.entries.push({ label: section.label, coach, weeks: section.data.weeks });
      timelines.set(key, timeline);
    }
  }

  // Order coaches by their total activity across all sections (busiest first), matching the board.
  const ordered = Array.from(timelines.values()).sort(
    (a, b) =>
      b.entries.reduce((s, e) => s + e.coach.totalDvs, 0) - a.entries.reduce((s, e) => s + e.coach.totalDvs, 0) ||
      a.name.localeCompare(b.name),
  );

  const usedNames = new Set<string>(["summary"]);
  for (const timeline of ordered) {
    const sheet = workbook.addWorksheet(sanitizeSheetName(timeline.name, usedNames));
    sheet.columns = [{ width: 30 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }];

    const head = timeline.entries[timeline.entries.length - 1]?.coach ?? timeline.entries[0].coach;
    sheet.addRow([head.name]).font = { bold: true, size: 14 };
    sheet.addRow([`${head.roleLabel ?? head.roleCode ?? "Coach"}`]);
    sheet.addRow([`Area: ${head.area ?? "—"}    Line: ${head.line ?? "—"}`]);
    sheet.addRow([]);

    for (const entry of timeline.entries) {
      const { coach } = entry;
      styleBandRow(
        sheet.addRow([
          `${entry.label}  ·  ${coach.totalDvs} DVs · ${coach.activeDays} days${coach.status !== "" ? ` · ${STATUS_LABELS[coach.status]}` : ""}`,
        ]),
        SUBHEADER_FILL,
      );
      writeCoachBlocks(sheet, coach, entry.weeks, combinedPhoenixHeaders);
    }

    sheet.views = [{ state: "frozen", ySplit: 1 }];
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
  phoenixHeaders: readonly string[] = [],
): void {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = [{ width: 30 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }];

  sheet.addRow([coach.name]).font = { bold: true, size: 14 };
  sheet.addRow([
    `${coach.roleLabel ?? coach.roleCode ?? "Coach"}${coach.status !== "" ? ` · ${STATUS_LABELS[coach.status]}` : ""}`,
  ]);
  sheet.addRow([`Area: ${coach.area ?? "—"}    Line: ${coach.line ?? "—"}`]);
  sheet.addRow([]);

  writeCoachBlocks(sheet, coach, weeks, phoenixHeaders);

  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/** Write one coach's KPI strip, per-rep, per-day and dated-visit blocks into an existing sheet, at
 * the current row — so a single coach tab can stack several windows (months) one after another. */
function writeCoachBlocks(
  sheet: ExcelJS.Worksheet,
  coach: DoubleVisitAuditCoach,
  weeks: DoubleVisitAuditWeek[],
  phoenixHeaders: readonly string[] = [],
): void {
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
  // THE PHOENIX FIELD SET IS FLAT HERE, one column each, after the columns this block always had. A
  // sheet has no viewport, so the fits-the-screen rule has nothing to say about it and nothing is
  // merged away. The header order comes from the workbook, never from this coach's own rows.
  const detailHeader = sheet.addRow([
    "Date",
    "Day",
    "Week",
    "Rep",
    "Status",
    "Customer",
    "Speciality",
    "AM/PM",
    "Visit Type",
    "And With",
    ...phoenixHeaders,
  ]);
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
      visit.partner2,
      ...phoenixHeaders.map((header) => visit.phoenixColumns?.[header] ?? ""),
    ]);
  }
  sheet.addRow([]);
}
