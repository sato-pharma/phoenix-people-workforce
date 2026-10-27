/**
 * Field Activity — the loader. Fetches the rows, hands them to the pure model, returns the report.
 *
 * EVERY CRM read here goes through `src/lib/crm/reads.ts` — the mirror has one door, and this file
 * is a consumer, not machinery. The two non-CRM tables (outstation trips, leave requests) are its
 * own.
 *
 * It holds NO business rules. Every judgement — which check-in belongs to which call, what counts
 * as AM, what an empty day means — lives in model.ts, where a test can reach it. This file is the
 * part that cannot be unit-tested, so it is deliberately the part with nothing to get wrong.
 *
 * 🔴 THE CHECK-IN QUERY IS THE ONE THING WORTH READING TWICE. A manager logs no visits and no
 * check-ins of his own: on a double visit the REP enters the call and the fix comes off the rep's
 * phone. So the fixes are fetched for the AGENTS WHO RECORDED THE DAY'S VISITS, not for the subject,
 * and the model then attaches one only where the same agent checked in at the same customer on the
 * same day. Fetching by the subject's own crm id returns nothing and draws an empty map on a day he
 * worked; fetching the agent's whole day and attaching it wholesale would put the rep's SOLO stops
 * on the manager's route, which is the defect the compliance screen still has.
 */

import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
import { queryCheckins, queryVisits } from "@/lib/crm/reads";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { managerVisitWhereLines } from "@/lib/phoenix-crm/manager-visit-detail";
import { loadManagerOwnVisitRows } from "@/lib/phoenix-crm/server/manager-plan-readers";
import {
  PHOENIX_VISIT_DETAIL_COLUMNS,
  pickPhoenixVisitDetailRow,
  type PhoenixDetailViewer,
} from "@/lib/crm/phoenix-visit-detail";
import {
  buildFieldActivityReport,
  cairoWallClockIso,
  type FieldActivityCheckinRow,
  type FieldActivityLeaveRow,
  type FieldActivityOwnVisitRow,
  type FieldActivityReport,
  type FieldActivityPunchRow,
  type FieldActivitySubject,
  type FieldActivityTripRow,
  type FieldActivityVisitRow,
} from "@/lib/field-activity/model";
import type { FieldActivityPanels } from "@/lib/field-activity/access";

/** PostgREST folds `.in()` into the URL; a few hundred ids overflow the header limit. */
const IN_CHUNK = 80;

// `source` marks a started team's Phoenix CRM visit, which logs no pharmacy (visit-count-buckets.ts).
const VISIT_COLUMNS =
  "visit_date, agent_hr_id, agent_name, agent_crm_id, double_hr_id, double_name, double2_hr_id, " +
  "double2_name, companion_hr_ids, contact_crm_id, contact_name, speciality, crm_contact_grade, ampm, visit_type, " +
  "visit_type_description, comment, crm_save_date, source, " +
  // THE PHOENIX FIELD SET. Selected unconditionally and shown only at the tier the reader earns: a
  // select is a string, so a list that varied by role would read `undefined` and print a blank the
  // moment a tier was added — indistinguishable from a visit that recorded nothing.
  PHOENIX_VISIT_DETAIL_COLUMNS;

/**
 * What the CRM door hands back. The door has already resolved the union that `rowsOf` below exists
 * to guard against, so a door read needs no narrowing step of its own.
 */
type MirrorRow = Record<string, unknown>;

/**
 * The rows of a PostgREST result, narrowed rather than cast. Only the two NON-mirror tables below
 * (outstation trips and leave requests) still query directly; the CRM mirror is read exclusively
 * through `src/lib/crm/reads.ts`.
 *
 * 🔴 WHY A CAST WAS THE WRONG FIX. The typed client's `data` is a UNION: the rows it parsed, or
 * `GenericStringError` for a select string it could not parse. `row as Record<string, unknown>`
 * silences the compiler on that union and keeps the defect — the error branch would flow on into
 * the model and render as a field day, which is the worst shape a wrong answer can take here: a day
 * that looks worked. Narrowing throws instead, so a malformed select fails loudly at the seam.
 */
function rowsOf(data: unknown, where: string): Record<string, unknown>[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => {
    if (!row || typeof row !== "object") {
      throw new Error(`field activity: ${where} — the query returned something that is not a row`);
    }
    // GenericStringError is `{ error: true }`; none of the tables read here carries an `error`
    // column, so the marker is unambiguous.
    if ((row as { error?: unknown }).error === true) {
      throw new Error(`field activity: ${where} — the query could not be parsed into rows`);
    }
    return row as Record<string, unknown>;
  });
}

function toVisitRow(row: Record<string, unknown>): FieldActivityVisitRow {
  return {
    visitDate: String(row.visit_date ?? ""),
    agentHrId: (row.agent_hr_id as string | null) ?? null,
    agentName: (row.agent_name as string | null) ?? null,
    agentCrmId: (row.agent_crm_id as number | null) ?? null,
    doubleHrId: (row.double_hr_id as string | null) ?? null,
    doubleName: (row.double_name as string | null) ?? null,
    double2HrId: (row.double2_hr_id as string | null) ?? null,
    double2Name: (row.double2_name as string | null) ?? null,
    ...(Array.isArray(row.companion_hr_ids) && row.companion_hr_ids.length > 0
      ? { companions: (row.companion_hr_ids as unknown[]).map((hrId) => ({ hrId: String(hrId), name: null })) }
      : {}),
    contactCrmId: (row.contact_crm_id as number | null) ?? null,
    contactName: (row.contact_name as string | null) ?? null,
    speciality: (row.speciality as string | null) ?? null,
    contactGrade: (row.crm_contact_grade as string | null) ?? null,
    ampm: (row.ampm as string | null) ?? null,
    visitType: (row.visit_type as number | null) ?? null,
    visitTypeDescription: (row.visit_type_description as string | null) ?? null,
    comment: (row.comment as string | null) ?? null,
    savedAt: (row.crm_save_date as string | null) ?? null,
    source: (row.source as string | null) ?? null,
    // The field set flows through AS THE DOOR SERVED IT — the shaper reads the raw measurements and
    // decides the tier, so re-typing each column here would be a second place for one to go missing.
    ...pickPhoenixVisitDetailRow(row),
  };
}

function money(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function loadFieldActivityReport(input: {
  subjectHrId: string;
  fromIso: string;
  toIso: string;
  panels: FieldActivityPanels;
  /**
   * Who is reading, so each Phoenix row's field set is shaped to his sight tier and blinded on a row
   * whose rep is himself. Omitted → no Phoenix half, which is the behaviour before 2026-10-07.
   */
  viewer?: PhoenixDetailViewer;
}): Promise<FieldActivityReport | null> {
  const supabase = getSupabaseAdmin();
  const { fromIso, toIso, subjectHrId } = input;

  const directory = await getEmployeeDirectoryRows();
  const key = canonicalHrIdKey(subjectHrId);
  const employee = directory.find((row) => canonicalHrIdKey(row.hrId) === key);
  if (!employee) return null;

  const subject: FieldActivitySubject = {
    hrId: employee.hrId,
    name: employee.fullName,
    jobTitle: employee.jobTitle ?? null,
    lineName: employee.lineName ?? null,
    areaName: employee.areaName ?? null,
    regionName: employee.regionName ?? null,
  };

  // Every visit he is on, either as the agent or as the tagged double-visit partner — which is
  // exactly what `participantHrIds` means at the door, and it sprays the hr-id casing variants that
  // a hand-written `agent_hr_id.eq.` would miss.
  const visits = (
    await queryVisits<MirrorRow>({
      // The canonical read-time collapse of iReports360's burst-duplicate saves — one rep, one
      // contact, one day, one type. Field Workforce Compliance, DV Analytics and the rep-day
      // drill-down all count through it, so without it this page would report a re-saved stop twice
      // and disagree with the screen the owner compares it against. Measured on production for
      // B-155's September: no real stop is affected — every duplicate group there is a
      // `contact_crm_id = 0` marker row, which the collapse leaves alone.
      collapseDoubleVisits: true,
      columns: VISIT_COLUMNS,
      dateFrom: fromIso,
      dateTo: toIso,
      // Deliberate, and the same opt-in the outstation workload reads make: the agent here is
      // WHOSE PHONE RECORDED THE DAY, displayed from the row's own `agent_name`, never trusted as a
      // current employee. Left off, a manager's day out with a rep who has since resigned would
      // render as a day he did nothing — the worst shape a wrong answer takes on this page.
      includeResignedAgents: true,
      participantHrIds: [subjectHrId],
    })
  ).map(toVisitRow);
  // Everyone on a visit past its two slots, named from the directory (the door carries their ids only).
  const nameByKey = new Map(directory.map((row) => [canonicalHrIdKey(row.hrId), row.fullName]));
  for (const visit of visits) {
    if (visit.companions) visit.companions = visit.companions.map((companion) => ({ ...companion, name: nameByKey.get(canonicalHrIdKey(companion.hrId)) ?? null }));
  }

  // The phones that recorded those days, and the days they recorded (rule 2 in model.ts).
  const agentCrmIds = [...new Set(visits.map((v) => v.agentCrmId).filter((id): id is number => id != null))];
  const visitDays = [...new Set(visits.map((v) => v.visitDate.slice(0, 10)).filter(Boolean))].sort();
  const visitDaySet = new Set(visitDays);

  const checkins: FieldActivityCheckinRow[] = [];
  const partnerVisits: FieldActivityVisitRow[] = [];
  if (agentCrmIds.length > 0 && visitDays.length > 0) {
    for (let index = 0; index < agentCrmIds.length; index += IN_CHUNK) {
      const batch = agentCrmIds.slice(index, index + IN_CHUNK);
      const checkinRows = await queryCheckins<MirrorRow>({
        agentCrmIds: batch,
        columns: "agent_crm_id, agent_hr_id, contact_crm_id, contact_name, address, lat, lon, check_date",
        dateFrom: fromIso,
        dateTo: toIso,
        includeResignedAgents: true,
        // Field Activity needs double_visit_analytics, which no Medical Rep holds — no rep reaches it, so a
        // started Phoenix CRM team's visits count as its check-ins here (owner, 2026-10-02;
        // src/lib/crm/phoenix-team-starts.ts lists every reader that asks).
        includePhoenixVisits: true,
      });
      for (const record of checkinRows) {
        checkins.push({
          agentCrmId: (record.agent_crm_id as number | null) ?? null,
          agentHrId: (record.agent_hr_id as string | null) ?? null,
          contactCrmId: (record.contact_crm_id as number | null) ?? null,
          contactName: (record.contact_name as string | null) ?? null,
          address: (record.address as string | null) ?? null,
          lat: nullableNumber(record.lat),
          lon: nullableNumber(record.lon),
          checkedAt: (record.check_date as string | null) ?? null,
        });
      }

      // The partners' own calls on the same days — counted nowhere, reported as context so a
      // manager's page never implies the rep stopped working when the manager went home.
      // The door filters a date RANGE, not a list of days, so it is narrowed to the days he was
      // actually out and the rest are dropped here — the same rows, fetched over a window that is
      // never wider than the first and last day he worked.
      const soloRows = await queryVisits<MirrorRow>({
        agentCrmIds: batch,
        collapseDoubleVisits: true,
        columns: VISIT_COLUMNS,
        dateFrom: visitDays[0],
        dateTo: visitDays[visitDays.length - 1],
        includeResignedAgents: true,
      });
      for (const record of soloRows) {
        if (!visitDaySet.has(String(record.visit_date ?? "").slice(0, 10))) continue;
        partnerVisits.push(toVisitRow(record));
      }
    }
  }

  let trips: FieldActivityTripRow[] = [];
  if (input.panels.expenses) {
    const { data, error } = await supabase
      .from("outstation_expense_requests")
      .select(
        "id, trip_start_date, to_label, to_city, to_area, transportation_type, distance_km, duration_minutes, " +
          "minimum_required_distance_km, fuel_amount, allowance_amount, ticket_amount, meeting_amount, other_amount, " +
          "claimed_total_amount, status, eligibility_status, approval_recommendation, evidence_gate_status, " +
          "workload_gate_status, am_workload, pm_workload, pharmacy_workload, captured_at, captured_latitude, " +
          "captured_longitude, captured_accuracy_meters, submitted_at",
      )
      .eq("employee_hr_id", employee.hrId)
      .gte("trip_start_date", fromIso)
      .lte("trip_start_date", `${toIso}T23:59:59`)
      .limit(500);
    if (error) throw new Error(`field activity: trips — ${error.message}`);
    trips = rowsOf(data, "trips").map((record) => {
      return {
        reference: `OUTSTATION-${String(record.id ?? "")}`,
        tripDate: String(record.trip_start_date ?? ""),
        destination:
          (record.to_area as string | null) ||
          (record.to_city as string | null) ||
          (record.to_label as string | null) ||
          null,
        transport: (record.transportation_type as string | null) ?? null,
        distanceKm: nullableNumber(record.distance_km),
        durationMinutes: nullableNumber(record.duration_minutes),
        minimumKm: nullableNumber(record.minimum_required_distance_km),
        fuel: money(record.fuel_amount),
        allowance: money(record.allowance_amount),
        tickets: money(record.ticket_amount),
        meeting: money(record.meeting_amount),
        other: money(record.other_amount),
        claimedTotal: money(record.claimed_total_amount),
        approvedTotal: nullableNumber(record.approved_total ?? null),
        status: (record.status as string | null) ?? null,
        eligibility: (record.eligibility_status as string | null) ?? null,
        recommendation: (record.approval_recommendation as string | null) ?? null,
        evidenceGate: (record.evidence_gate_status as string | null) ?? null,
        workloadGate: (record.workload_gate_status as string | null) ?? null,
        workload: {
          am: nullableNumber(record.am_workload),
          pm: nullableNumber(record.pm_workload),
          pharmacies: nullableNumber(record.pharmacy_workload),
        },
        // A REAL instant, unlike every CRM clock on this report — converted once, here, so the
        // document never slices a UTC string as though it were Cairo (model.ts rule 3).
        capturedAt: cairoWallClockIso(record.captured_at as string | null),
        capturedLat: nullableNumber(record.captured_latitude),
        capturedLon: nullableNumber(record.captured_longitude),
        capturedAccuracyMeters: nullableNumber(record.captured_accuracy_meters),
        submittedAt: (record.submitted_at as string | null) ?? null,
      };
    });
  }

  let punches: FieldActivityPunchRow[] = [];
  if (input.panels.attendance) {
    // These ARE true instants, stamped by the device, so the helper's Cairo bucketing is correct —
    // the opposite of the vendor CRM clocks, which must never be shifted.
    const byEmployee = await loadEmployeeDayPunchMinutes({
      dateFromIso: fromIso,
      dateToIso: toIso,
      employeeHrIds: [employee.hrId],
    });
    const forSubject = byEmployee.get(canonicalHrIdKey(employee.hrId) ?? employee.hrId)
      ?? [...byEmployee.values()][0]
      ?? new Map();
    punches = [...forSubject.entries()].map(([dateIso, day]) => ({
      dateIso,
      firstTime: day.firstPunchMinutes == null ? null : clockFromMinutes(day.firstPunchMinutes),
      lastTime: day.lastPunchMinutes == null ? null : clockFromMinutes(day.lastPunchMinutes),
      count: day.visiblePunchCount,
    }));
  }

  let leave: FieldActivityLeaveRow[] = [];
  if (input.panels.leave) {
    const { data, error } = await supabase
      .from("v2_vacation_requests")
      .select(
        "request_code, vacation_type, day_part, start_date, end_date, status, payment_status, manager_name, " +
          "manager_decision_at, hr_decision_at, created_at, balance_before_days, balance_after_days",
      )
      .eq("employee_hr_id", employee.hrId)
      .lte("start_date", toIso)
      .gte("end_date", fromIso)
      .limit(200);
    if (error) throw new Error(`field activity: leave — ${error.message}`);
    leave = rowsOf(data, "leave")
      .map((record) => {
        return {
          reference: (record.request_code as string | null) ?? null,
          type: (record.vacation_type as string | null) ?? null,
          dayPart: (record.day_part as string | null) ?? null,
          startDate: String(record.start_date ?? "").slice(0, 10),
          endDate: String(record.end_date ?? "").slice(0, 10),
          status: (record.status as string | null) ?? null,
          paymentStatus: (record.payment_status as string | null) ?? null,
          managerName: (record.manager_name as string | null) ?? null,
          managerDecisionAt: (record.manager_decision_at as string | null) ?? null,
          hrDecisionAt: (record.hr_decision_at as string | null) ?? null,
          submittedAt: (record.created_at as string | null) ?? null,
          balanceBefore: nullableNumber(record.balance_before_days),
          balanceAfter: nullableNumber(record.balance_after_days),
        };
      })
      // A refused or withdrawn request never kept anybody off the road.
      .filter((row) => (row.status ?? "").toLowerCase() === "approved");
  }

  // 🔴 HIS OWN SINGLE VISITS, ON HIS OWN DAY (owner, 2026-10-20, multiple choice: "Show, keep out of reps — his own
  // visits appear under his name in the Visit Report and the Field Activity day, never in a rep's totals. Still no
  // GPS or photo required"). Read through `manager-plan-readers.ts`, the ONE door out of their table, for the subject
  // alone — the person this report's own access already admitted — and handed to the model as display rows: listed
  // on the day, added to no count. Nobody but a manager has any, so a rep's report reads nothing here.
  const ownVisits: FieldActivityOwnVisitRow[] = (
    await loadManagerOwnVisitRows({ end: toIso.slice(0, 10), managerHrIds: [employee.hrId], start: fromIso.slice(0, 10) })
  ).map((own) => ({
    comment: own.comment,
    customerName: own.customerName,
    date: own.date,
    grade: own.grade,
    half: own.bucket === "PM" ? "PM" : "AM",
    inVacantTerritory: own.inVacantTerritory,
    // A REAL instant, converted once here to the Cairo wall clock every other clock on this report speaks in.
    loggedAt: cairoWallClockIso(own.loggedAt),
    planned: own.planned,
    products: own.products,
    speciality: own.speciality,
    where: managerVisitWhereLines(own).join(", ") || null,
  }));

  return buildFieldActivityReport({
    subject,
    fromIso,
    toIso,
    visits,
    ownVisits,
    checkins,
    partnerVisits,
    trips,
    punches,
    leave,
    viewer: input.viewer,
  });
}

function clockFromMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}
