import "server-only";

import type { AccessContext } from "@/lib/auth/permissions";
import { cairoTodayIso } from "@/lib/crm/dates";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { personKey, territoryName, TERRITORY_TIER, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { chunk, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";
import { readEveryPage } from "@/lib/phoenix-crm/server/paged-read";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { loadPlanHolidays } from "@/lib/phoenix-crm/server/plan-holidays";
import {
  activityLabel,
  checkExportRange,
  daysBetween,
  leaveLabel,
  type ExportBrickSales,
  type ExportDoctor,
  type ExportDoctorStatus,
  type ExportListType,
  type ExportVisit,
  type GradeTargets,
  type RepVisitsExportData,
} from "@/lib/rep-visits-export/rules";
import { loadAreaBrickMaster, loadClosingBrickSales, upperCode } from "@/lib/sales/closing-brick-sales";
import { withoutMaskedSourceRows } from "@/lib/sales/closing-source-mask";
import { lineName } from "@/lib/sales/monthly-targets";
import { isSalesPeriodReleased, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import { SALES_HISTORY_FLOOR, loadUploadedPeriodsInRange } from "@/lib/sales/vs-target";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The rep visits export's reads (owner, 24 Nov 2026). One rep, one range: the visits as saved, the day's
 * record (day start, meetings and training, holidays, leave as asked and decided, days charged for no
 * activity), the territory's doctor list with each doctor's brick, the grade numbers, and the published
 * closing's brick sales.
 *
 * 🔴 THE SUPER ADMIN'S ALONE. The workbook carries leave decisions and deductions beside the visits — HR
 * evidence — so `canExportRepVisits` is asked on the page, on the route and again here, before any read.
 *
 * 🔴 SALES OF AN UNPUBLISHED MONTH APPEAR NOWHERE (owner, 2026-11-04), as on the brick coverage report:
 * a month is read only when the rep's line has published it, and the El Qema mask runs before any sum.
 */

const VISIT_COLUMNS =
  "id, seat_id, line_code, customer_id, pharmacy_name, list_type, visit_date, captured_at, kind, is_unplanned, distance_meters, location_flag, place_id, imported_from_ireports360_at";
const CUSTOMER_COLUMNS = "id, seat_id, status, list_type, grade, name, speciality, pharmacy_pin_brick_id, pharmacy_pin_brick_name, pharmacy_pin_area_code, pharmacy_pin_area_name";
const PLACE_COLUMNS = "id, customer_id, brick_id, brick_name, area_code, area_name, shared_place_id, created_at";
const SHARED_PLACE_COLUMNS = "id, brick_id, brick_name, area_code, area_name";
const DOCTOR_STATUSES: readonly ExportDoctorStatus[] = ["active", "pending", "outside"];
const MAX_VISITS = 20_000;

export function canExportRepVisits(access: Pick<AccessContext, "role">): boolean {
  return access.role === "Super Admin";
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => {
  const out = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return out ? out : null;
};

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cairoClock(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return formatStableEnGb(at, { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hour12: false });
}

function listOf(value: unknown): ExportListType {
  const raw = String(value ?? "").toUpperCase();
  if (raw.startsWith("AM")) return "AM";
  if (raw.startsWith("PM")) return "PM";
  return "Pharmacy";
}

export type RepVisitsExportOption = { hrId: string; name: string; territory: string };

/** Everyone holding a rep's territory now, for the page's rep filter, by name. */
export async function loadRepVisitsExportOptions(access: Pick<AccessContext, "role">): Promise<RepVisitsExportOption[]> {
  if (!canExportRepVisits(access)) throw forbiddenError("The rep visits export is for the Super Admin.");
  const org = await loadPhoenixCrmOrg();
  const holders = org.territoryHolders.filter((seat) => seat.tier === TERRITORY_TIER && seat.occupantHrId);
  const names = await loadPeopleNames(holders.map((seat) => seat.occupantHrId));
  const out = new Map<string, RepVisitsExportOption>();
  for (const seat of holders) {
    const hrId = seat.occupantHrId as string;
    if (!out.has(hrId)) out.set(hrId, { hrId, name: nameOf(names, hrId, hrId), territory: territoryName(seat) });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readAll<T extends Row>(what: string, build: () => unknown, maxRows = MAX_VISITS): Promise<T[]> {
  const read = await readEveryPage<T>(build as () => never, { maxRows, whenFull: "refuse", what, uniqueBy: (row) => String(row.id ?? JSON.stringify(row)) });
  if (read.error) throw read.error instanceof Error ? read.error : new Error(`${what} could not be read.`);
  return read.rows;
}

export async function loadRepVisitsExport(
  access: Pick<AccessContext, "role" | "scope">,
  raw: { hrId?: unknown; from?: unknown; to?: unknown },
): Promise<RepVisitsExportData> {
  if (!canExportRepVisits(access)) throw forbiddenError("The rep visits export is for the Super Admin.");
  const hrId = personKey(text(raw.hrId));
  if (!hrId) throw validationError("Choose a rep.");
  const today = cairoTodayIso();
  const range = checkExportRange(raw.from, raw.to, today);
  if (!range.ok) throw validationError(range.error);
  const { from, to } = range;
  const supabase = getSupabaseAdmin();
  const keys = hrIdLookupKeys(hrId);

  // ── The person, and the territory whose list the workbook reads ──
  const [{ data: employee, error: employeeError }, org] = await Promise.all([
    supabase.from("employees").select("hr_id, full_name, job_title, hire_date, birth_date, base_salary, basic_salary, gross_salary, net_salary").in("hr_id", keys).limit(1).maybeSingle(),
    loadPhoenixCrmOrg(),
  ]);
  throwIfError(employeeError);
  if (!employee) throw validationError("No employee has this HR id.");

  const visitRows = await readAll<Row>("the rep's visits", () =>
    supabase
      .from("phoenix_crm_visits")
      .select(VISIT_COLUMNS)
      .in("rep_hr_id", keys)
      .eq("is_test", false)
      .is("archived_at", null)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .order("visit_date", { ascending: true })
      .order("captured_at", { ascending: true })
      .order("id", { ascending: true }),
  );

  const heldSeats = (org.seatsByOccupant.get(hrId) ?? []).filter((seat) => seat.tier === TERRITORY_TIER);
  const lastVisitSeat = text(visitRows[visitRows.length - 1]?.seat_id);
  const seat: OrgSeat | null = heldSeats[0] ?? (lastVisitSeat ? (org.seats.get(lastVisitSeat) ?? null) : null);
  const seatIds = [...new Set([...heldSeats.map((s) => s.seatId), ...(seat ? [seat.seatId] : [])])];

  // ── Customers: the territory's list, plus anyone visited from another list ──
  const listRows = seatIds.length
    ? await readAll<Row>("the territory's customers", () =>
        supabase.from("phoenix_crm_customers").select(CUSTOMER_COLUMNS).in("seat_id", seatIds).eq("is_test", false).in("status", [...DOCTOR_STATUSES]).order("id"),
      )
    : [];
  const customers = new Map<string, Row>(listRows.map((row) => [String(row.id), row]));
  const missing = [...new Set(visitRows.map((row) => text(row.customer_id)).filter((id): id is string => Boolean(id) && !customers.has(id as string)))];
  for (const ids of chunk(missing, 150)) {
    const { data, error } = await supabase.from("phoenix_crm_customers").select(CUSTOMER_COLUMNS).in("id", ids);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) customers.set(String(row.id), row);
  }

  // ── Places, for each customer's brick and each visit's brick ──
  const places = new Map<string, Row>();
  const firstPlaceOf = new Map<string, Row>();
  const customerIds = [...customers.keys()];
  for (const ids of chunk(customerIds, 150)) {
    const { data, error } = await supabase
      .from("phoenix_crm_places")
      .select(PLACE_COLUMNS)
      .in("customer_id", ids)
      .eq("is_test", false)
      .is("retired_at", null)
      .order("created_at", { ascending: true });
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) {
      places.set(String(row.id), row);
      const customer = String(row.customer_id);
      if (!firstPlaceOf.has(customer)) firstPlaceOf.set(customer, row);
    }
  }
  const visitPlaceIds = [...new Set(visitRows.map((row) => text(row.place_id)).filter((id): id is string => Boolean(id) && !places.has(id as string)))];
  for (const ids of chunk(visitPlaceIds, 150)) {
    const { data, error } = await supabase.from("phoenix_crm_places").select(PLACE_COLUMNS).in("id", ids);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) places.set(String(row.id), row);
  }
  const sharedIds = [...new Set([...places.values()].map((row) => text(row.shared_place_id)).filter((id): id is string => Boolean(id)))];
  const shared = new Map<string, Row>();
  for (const ids of chunk(sharedIds, 150)) {
    const { data, error } = await supabase.from("phoenix_crm_shared_places").select(SHARED_PLACE_COLUMNS).in("id", ids);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) shared.set(String(row.id), row);
  }
  const placeFacts = (place: Row | undefined) => {
    if (!place) return null;
    const sp = shared.get(String(place.shared_place_id ?? ""));
    return {
      brickId: text(place.brick_id) ?? text(sp?.brick_id),
      brickName: text(place.brick_name) ?? text(sp?.brick_name),
      areaCode: upperCode(text(place.area_code) ?? text(sp?.area_code)) || null,
      areaName: text(place.area_name) ?? text(sp?.area_name),
    };
  };
  const customerPlace = (id: string) => {
    const facts = placeFacts(firstPlaceOf.get(id));
    if (facts) return facts;
    const c = customers.get(id);
    return c
      ? { brickId: text(c.pharmacy_pin_brick_id), brickName: text(c.pharmacy_pin_brick_name), areaCode: upperCode(text(c.pharmacy_pin_area_code)) || null, areaName: text(c.pharmacy_pin_area_name) }
      : null;
  };

  const visits: ExportVisit[] = visitRows.map((row) => {
    const customerId = text(row.customer_id);
    const customer = customerId ? customers.get(customerId) : undefined;
    const copied = Boolean(row.imported_from_ireports360_at);
    const place = placeFacts(places.get(String(row.place_id ?? ""))) ?? (customerId ? customerPlace(customerId) : null);
    return {
      day: String(row.visit_date).slice(0, 10),
      list: listOf(row.list_type),
      kind: String(row.kind ?? "single"),
      unplanned: Boolean(row.is_unplanned),
      customerKey: customerId ?? `pharmacy:${text(row.pharmacy_name) ?? row.id}`,
      customerName: text(customer?.name) ?? text(row.pharmacy_name) ?? "Unnamed customer",
      speciality: text(customer?.speciality),
      time: copied ? null : cairoClock(text(row.captured_at)),
      distanceMeters: row.distance_meters == null ? null : Math.round(Number(row.distance_meters)),
      grade: text(customer?.grade),
      locationFlag: text(row.location_flag) ?? "ok",
      copiedFromOldCrm: copied,
      brickName: place?.brickName ?? null,
    };
  });

  const doctors: ExportDoctor[] = listRows.map((row) => {
    const place = customerPlace(String(row.id));
    return {
      customerKey: String(row.id),
      status: String(row.status) as ExportDoctorStatus,
      list: listOf(row.list_type),
      grade: text(row.grade),
      name: text(row.name) ?? "Unnamed customer",
      speciality: text(row.speciality),
      brickId: place?.brickId ?? null,
      brickName: place?.brickName ?? null,
      areaCode: place?.areaCode ?? null,
      areaName: place?.areaName ?? null,
    };
  });

  // ── The day's record ──
  const vacationKeys = keys;
  const [settings, starts, activities, vacations, holidays, deductionLines] = await Promise.all([
    supabase.from("phoenix_crm_settings").select("grade_targets").limit(1).maybeSingle(),
    readAll<Row>("the rep's day starts", () =>
      supabase.from("phoenix_crm_day_starts").select("id, started_on, started_at").in("rep_hr_id", keys).eq("is_test", false).gte("started_on", from).lte("started_on", to).order("started_on"),
    ),
    readAll<Row>("the rep's day activities", () =>
      supabase
        .from("phoenix_crm_day_activities")
        .select("id, activity_date, activity_type, note, entered_by_hr_id")
        .in("rep_hr_id", keys)
        .eq("is_test", false)
        .gte("activity_date", from)
        .lte("activity_date", to)
        .order("activity_date"),
    ),
    readAll<Row>("the rep's leave requests", () =>
      supabase
        .from("v2_vacation_requests")
        .select("id, start_date, end_date, vacation_type, status, manager_decision")
        .in("employee_hr_id", vacationKeys)
        .lte("start_date", to)
        .gte("end_date", from)
        .order("start_date"),
    ),
    loadPlanHolidays(from, to),
    readAll<Row>("the rep's deductions", () =>
      supabase.from("daily_deductions_lines").select("id, publication_id, dates").in("employee_hr_id", keys).order("id"),
    ),
  ]);
  throwIfError(settings.error);

  const startMap = new Map<string, string>();
  for (const row of starts) {
    const day = String(row.started_on).slice(0, 10);
    const clock = cairoClock(text(row.started_at));
    if (clock && !startMap.has(day)) startMap.set(day, clock);
  }
  const activityMap = new Map<string, string[]>();
  for (const row of activities) {
    const day = String(row.activity_date).slice(0, 10);
    const byOther = personKey(text(row.entered_by_hr_id)) !== hrId;
    activityMap.set(day, [...(activityMap.get(day) ?? []), activityLabel(String(row.activity_type), text(row.note), byOther)]);
  }
  const leaveMap = new Map<string, string>();
  for (const row of vacations) {
    const label = leaveLabel({ type: String(row.vacation_type ?? "leave"), status: String(row.status ?? ""), managerDecision: text(row.manager_decision) });
    if (!label) continue;
    const start = String(row.start_date).slice(0, 10) < from ? from : String(row.start_date).slice(0, 10);
    const end = String(row.end_date).slice(0, 10) > to ? to : String(row.end_date).slice(0, 10);
    if (start > end) continue;
    for (const day of daysBetween(start, end)) if (!leaveMap.has(day)) leaveMap.set(day, label);
  }
  const holidayMap = new Map<string, string>();
  for (const [day, name] of holidays) if (day >= from && day <= to && !holidayMap.has(day)) holidayMap.set(day, name);

  const publicationIds = [...new Set(deductionLines.map((row) => text(row.publication_id)).filter((id): id is string => Boolean(id)))];
  const published = new Set<string>();
  for (const ids of chunk(publicationIds, 150)) {
    const { data, error } = await supabase.from("daily_deductions_publications").select("id, status, superseded_at").in("id", ids);
    throwIfError(error);
    for (const row of (data ?? []) as Row[]) if (row.status === "published" && !row.superseded_at) published.add(String(row.id));
  }
  const charged = new Set<string>();
  for (const row of deductionLines) {
    if (!published.has(String(row.publication_id))) continue;
    for (const day of Array.isArray(row.dates) ? row.dates : []) {
      const iso = String(day).slice(0, 10);
      if (iso >= from && iso <= to) charged.add(iso);
    }
  }

  // ── Brick sales from the published closing: the month before the range through its last month ──
  const brickSales = await loadBrickSales(access, {
    lineCode: seat?.lineCode ?? text(visitRows[0]?.line_code),
    areaCodes: [...new Set([upperCode(seat?.areaCode ?? null), ...doctors.map((d) => d.areaCode ?? "")].filter(Boolean))],
    brickIds: doctors.map((d) => d.brickId).filter((id): id is string => Boolean(id)),
    fromMonth: previousMonth(from.slice(0, 7)),
    toMonth: to.slice(0, 7),
  });

  return {
    rep: {
      hrId,
      name: text(employee.full_name) ?? hrId,
      role: text(employee.job_title) ?? "Medical Representative",
      line: seat?.lineName ?? lineName(seat?.lineCode ?? null) ?? "",
      areaName: seat?.areaName ?? "",
      areaCode: upperCode(seat?.areaCode ?? null) || null,
      hireDate: text(employee.hire_date)?.slice(0, 10) ?? null,
      birthDate: text(employee.birth_date)?.slice(0, 10) ?? null,
      salary: {
        base: money(employee.base_salary),
        basic: money(employee.basic_salary),
        gross: money(employee.gross_salary),
        net: money(employee.net_salary),
      },
    },
    from,
    to,
    today,
    visits,
    doctors,
    gradeTargets: ((settings.data as Row | null)?.grade_targets ?? {}) as GradeTargets,
    days: { starts: startMap, activities: activityMap, holidays: holidayMap, leave: leaveMap, charged },
    brickSales,
  };
}

function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

async function loadBrickSales(
  access: Pick<AccessContext, "role" | "scope">,
  input: { lineCode: string | null; areaCodes: string[]; brickIds: string[]; fromMonth: string; toMonth: string },
): Promise<ExportBrickSales> {
  if (!input.lineCode || input.areaCodes.length === 0) return { months: [], bricks: [] };
  const fromMonth = input.fromMonth < SALES_HISTORY_FLOOR ? SALES_HISTORY_FLOOR : input.fromMonth;
  if (fromMonth > input.toMonth) return { months: [], bricks: [] };
  const [uploaded, publishedKeys] = await Promise.all([loadUploadedPeriodsInRange(fromMonth, input.toMonth), loadSalesReleaseKeys()]);
  const months = [...uploaded]
    .filter((month) => month >= fromMonth && month <= input.toMonth && isSalesPeriodReleased(month, input.lineCode as string, publishedKeys))
    .sort();
  const areaSet = new Set(input.areaCodes);
  const byBrick = new Map<string, Record<string, number>>();
  for (const month of months) {
    const rows = withoutMaskedSourceRows(await loadClosingBrickSales(lineName(input.lineCode), month), access);
    for (const row of rows) {
      if (!areaSet.has(upperCode(row.areaCode)) || !row.brickId) continue;
      const sums = byBrick.get(row.brickId) ?? {};
      sums[month] = (sums[month] ?? 0) + row.value;
      byBrick.set(row.brickId, sums);
    }
  }
  const master = await loadAreaBrickMaster(input.areaCodes, [...new Set([...input.brickIds, ...byBrick.keys()])]);
  const bricks = master
    .filter((brick) => areaSet.has(brick.areaCode) || byBrick.has(brick.brickId) || input.brickIds.includes(brick.brickId))
    .map((brick) => ({ brickId: brick.brickId, brickName: brick.brickName || brick.brickId, areaCode: brick.areaCode, current: brick.current, byMonth: byBrick.get(brick.brickId) ?? {} }));
  return { months, bricks };
}
