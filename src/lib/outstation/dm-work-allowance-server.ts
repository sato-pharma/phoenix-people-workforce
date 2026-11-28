/**
 * The District Manager's confirmed double visits and the day's-work allowance — the reads and the guarded
 * writes behind `dm-expense-rules.ts` (owner, 28 Nov 2026).
 *
 *   - `confirmDmDoubleVisit`: he confirms a double visit a rep logged with him; the press records where he
 *     was. Once per visit, only on the visit's own CRM day (until 02:00 the next morning), only with a
 *     position. The confirmation is never shown to the rep (Golden Rule #1).
 *   - `getOwnDoubleVisitsToConfirm`: what his Submit Expense page offers to confirm today, while a trip
 *     claim of his covers today.
 *   - `priceDmWorkAllowance`: re-prices each trip day's allowance on the day's AM and PM work and its
 *     confirmations. Only a claim filed under the rules (`dm_work_allowance` set at submit), only while it
 *     waits and no payroll row carries it, only the version it read. It runs after he submits, after each
 *     confirmation, after the departure photo and every morning with the first-double-visit pricing.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";
import type { AccessContext } from "@/lib/auth/permissions";
import { getRepTripVisitWorkload } from "@/lib/crm/visit-workload";
import { hrIdLookupKeys, normalizeHrIdForAccess } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { allowanceRowDates } from "@/lib/outstation/allowance-day-guard";
import { cairoDateOnly } from "@/lib/outstation/departure-evidence";
import { isDistrictManagerRole, isTripExpense, readDistanceBasis, WAITING_STATUSES } from "@/lib/outstation/dm-double-visit-distance";
import {
  type DmDoubleVisit,
  type DmTripDayWork,
  type DmWorkAllowanceRecord,
  dmTicketDeadline,
  type DmTicketFile,
  dmTicketSourceRefusal,
  dmTicketTooLateMessage,
  firstAndLastDoubleVisit,
  planDmWorkAllowance,
  readDmWorkAllowance,
} from "@/lib/outstation/dm-expense-rules";
import { distanceKm } from "@/lib/outstation/train-fare";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { VISIT_MAX_ACCURACY_METERS } from "@/lib/phoenix-crm/entry-rules";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const out = Number(value);
  return Number.isFinite(out) ? out : null;
};
const round2 = (value: number) => Math.round(value * 100) / 100;

/** The instant a CRM visit day closes: 02:00 Cairo the next morning. */
export function crmDayClosesAt(day: string): number {
  return Date.parse(cairoMidnightUtcIso(day, 1, "Africa/Cairo")) + 2 * 60 * 60 * 1000;
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────

type DoubleVisitRead = {
  capturedAt: string | null;
  customerId: string | null;
  id: string;
  lat: number | null;
  lon: number | null;
  managerHrId: string | null;
  repHrId: string | null;
  visitDate: string | null;
};

/** Every double or chain visit a rep logged with him as the manager, between two CRM days. */
export async function readDmDoubleVisits(managerHrId: string, start: string, end: string): Promise<DoubleVisitRead[]> {
  const keys = hrIdLookupKeys(managerHrId);
  if (keys.length === 0) return [];
  const rows = await fetchAllRows<Row>(
    () =>
      getSupabaseAdmin()
        .from("phoenix_crm_visits")
        .select("id, manager_hr_id, rep_hr_id, captured_at, visit_date, lat, lon, customer_id")
        .eq("is_test", false)
        .is("imported_from_ireports360_at", null)
        .is("archived_at", null)
        .in("kind", ["double", "chain"])
        .in("manager_hr_id", keys)
        .gte("visit_date", start)
        .lte("visit_date", end),
    "id",
  );
  const me = normalizeHrIdForAccess(managerHrId);
  return rows
    .filter((row) => normalizeHrIdForAccess(String(row.manager_hr_id ?? "")) === me)
    .map((row) => ({
      capturedAt: row.captured_at ? String(row.captured_at) : null,
      customerId: row.customer_id ? String(row.customer_id) : null,
      id: String(row.id),
      lat: num(row.lat),
      lon: num(row.lon),
      managerHrId: row.manager_hr_id ? String(row.manager_hr_id) : null,
      repHrId: row.rep_hr_id ? String(row.rep_hr_id) : null,
      visitDate: row.visit_date ? String(row.visit_date) : null,
    }));
}

type ConfirmationRead = { confirmedAt: string; distanceKm: number | null };

async function readConfirmations(visitIds: string[]): Promise<Map<string, ConfirmationRead>> {
  const out = new Map<string, ConfirmationRead>();
  for (let i = 0; i < visitIds.length; i += 200) {
    const { data, error } = await getSupabaseAdmin()
      .from("outstation_dm_visit_confirmations")
      .select("visit_id, confirmed_at, distance_km")
      .in("visit_id", visitIds.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Row[]) {
      out.set(String(row.visit_id), { confirmedAt: String(row.confirmed_at), distanceKm: num(row.distance_km) });
    }
  }
  return out;
}

/** The time of his first double visit on one CRM day, for the 12-hour ticket window; null when there is none. */
export async function firstDmDoubleVisitAtOn(managerHrId: string, day: string): Promise<string | null> {
  const visits = await readDmDoubleVisits(managerHrId, day, day);
  const { first } = firstAndLastDoubleVisit(
    visits.filter((v) => v.capturedAt).map((v) => ({ capturedAt: String(v.capturedAt), confirmedAt: null, id: v.id, repName: null })),
  );
  return first?.capturedAt ?? null;
}

async function customerNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data } = await getSupabaseAdmin().from("phoenix_crm_customers").select("id, name").in("id", ids);
  for (const row of (data ?? []) as Row[]) if (row.name) out.set(String(row.id), String(row.name));
  return out;
}

/** His waiting District Manager trip claims whose dates cover the CRM day. */
async function ownTripClaimsCovering(managerHrId: string, day: string): Promise<Row[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select("id, employee_hr_id, employee_role, expense_type, trip_start_date, trip_end_date, status")
    .in("employee_hr_id", hrIdLookupKeys(managerHrId))
    .in("status", [...WAITING_STATUSES]);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Row[]).filter((row) => {
    if (!isDistrictManagerRole(String(row.employee_role ?? "")) || !isTripExpense(String(row.expense_type ?? ""))) return false;
    const start = cairoDateOnly(String(row.trip_start_date ?? "") || null);
    const end = cairoDateOnly(String(row.trip_end_date ?? "") || null) ?? start;
    return Boolean(start && end && start <= day && day <= end);
  });
}

/** True when he is a District Manager with a waiting trip claim covering the CRM day (the arrival is in). */
export async function dmHasTripClaimOn(managerHrId: string, day: string): Promise<boolean> {
  return (await ownTripClaimsCovering(managerHrId, day)).length > 0;
}

// ── What he confirms ─────────────────────────────────────────────────────────────────────────────

export type DmVisitToConfirm = {
  capturedAt: string;
  confirmedAt: string | null;
  customerName: string;
  /** The first or the last double visit of the day — the two that must be confirmed. */
  required: boolean;
  repName: string;
  visitId: string;
};

/** Today's double visits for him to confirm, while a trip claim of his covers today. Best effort. */
export async function getOwnDoubleVisitsToConfirm(access: AccessContext, now = new Date()): Promise<{ day: string; visits: DmVisitToConfirm[] }> {
  const day = cairoBusinessDay(now);
  const me = String(access.hrId ?? "").trim();
  if (!me) return { day, visits: [] };
  if ((await ownTripClaimsCovering(me, day)).length === 0) return { day, visits: [] };
  const visits = (await readDmDoubleVisits(me, day, day)).filter((v) => v.capturedAt);
  if (visits.length === 0) return { day, visits: [] };
  const [confirmations, names, customers] = await Promise.all([
    readConfirmations(visits.map((v) => v.id)),
    loadPeopleNames(visits.map((v) => v.repHrId).filter((id): id is string => Boolean(id))),
    customerNames(visits.map((v) => v.customerId).filter((id): id is string => Boolean(id))),
  ]);
  const shaped: DmDoubleVisit[] = visits.map((v) => ({
    capturedAt: String(v.capturedAt),
    confirmedAt: confirmations.get(v.id)?.confirmedAt ?? null,
    id: v.id,
    repName: null,
  }));
  const { first, last } = firstAndLastDoubleVisit(shaped);
  return {
    day,
    visits: visits
      .map((v) => ({
        capturedAt: String(v.capturedAt),
        confirmedAt: confirmations.get(v.id)?.confirmedAt ?? null,
        customerName: (v.customerId && customers.get(v.customerId)) || "A customer",
        required: v.id === first?.id || v.id === last?.id,
        repName: v.repHrId ? nameOf(names, v.repHrId, "A rep") : "A rep",
        visitId: v.id,
      }))
      .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt)),
  };
}

export class DmVisitConfirmationError extends Error {}

/** Confirm one double visit, with his position. Refuses without a usable position, late, or not his. */
export async function confirmDmDoubleVisit(
  access: AccessContext,
  input: { accuracyMeters?: number | null; latitude?: number | null; longitude?: number | null; visitId: string },
  now = new Date(),
): Promise<{ alreadyConfirmed: boolean; distanceKm: number | null }> {
  const me = normalizeHrIdForAccess(access.hrId);
  if (!me) throw new DmVisitConfirmationError("Sign in to confirm a double visit.");
  const lat = num(input.latitude);
  const lon = num(input.longitude);
  const accuracy = num(input.accuracyMeters);
  if (lat === null || lon === null || (lat === 0 && lon === 0)) {
    throw new DmVisitConfirmationError("Your location is required to confirm a double visit. Turn on location and try again.");
  }
  if (accuracy !== null && accuracy > VISIT_MAX_ACCURACY_METERS) {
    throw new DmVisitConfirmationError(
      `Your location is too rough (${Math.round(accuracy)} m). Step outside or wait a moment, then confirm again.`,
    );
  }
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visits")
    .select("id, kind, manager_hr_id, visit_date, lat, lon, is_test, archived_at, imported_from_ireports360_at")
    .eq("id", input.visitId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const visit = (data ?? null) as Row | null;
  if (
    !visit ||
    visit.archived_at ||
    visit.imported_from_ireports360_at ||
    !["double", "chain"].includes(String(visit.kind ?? "")) ||
    normalizeHrIdForAccess(String(visit.manager_hr_id ?? "")) !== me
  ) {
    throw new DmVisitConfirmationError("That double visit is not one logged with you.");
  }
  const day = String(visit.visit_date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || now.getTime() > crmDayClosesAt(day)) {
    throw new DmVisitConfirmationError("A double visit is confirmed on its own day. That day has ended, so it can no longer be confirmed.");
  }
  const visitLat = num(visit.lat);
  const visitLon = num(visit.lon);
  const km =
    visitLat === null || visitLon === null
      ? null
      : round2(distanceKm({ latitude: lat, longitude: lon }, { latitude: visitLat, longitude: visitLon }));

  const { data: inserted, error: insertError } = await getSupabaseAdmin()
    .from("outstation_dm_visit_confirmations")
    .upsert(
      {
        accuracy_meters: accuracy,
        confirmed_at: now.toISOString(),
        distance_km: km,
        latitude: lat,
        longitude: lon,
        manager_hr_id: String(access.hrId).trim(),
        visit_date: day,
        visit_id: input.visitId,
      },
      { ignoreDuplicates: true, onConflict: "visit_id" },
    )
    .select("visit_id");
  if (insertError) throw new Error(insertError.message);
  const alreadyConfirmed = (inserted ?? []).length === 0;

  // The day's allowance moves with the confirmation: re-price his claims that cover the day. Best effort.
  if (!alreadyConfirmed) {
    for (const claim of await ownTripClaimsCovering(String(access.hrId), day).catch(() => [] as Row[])) {
      await priceDmWorkAllowance(Number(claim.id), { now }).catch((priceError) =>
        logError("A District Manager claim could not be re-priced after a confirmation", {
          error: priceError,
          labels: { event: "outstation_dm_work_allowance_failed", requestId: String(claim.id) },
        }),
      );
    }
  }
  return { alreadyConfirmed, distanceKm: km };
}

/** The allowance breakdown: submit writes it as a JSON string inside the jsonb column; an object reads too. */
function readBreakdown(value: unknown): { rows?: Array<Record<string, unknown>> } | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" ? (parsed as { rows?: Array<Record<string, unknown>> }) : null;
}

// ── The day's-work allowance ─────────────────────────────────────────────────────────────────────

const CLAIM_COLUMNS = [
  "id", "status", "updated_at", "employee_hr_id", "employee_role", "expense_type", "trip_start_date", "trip_end_date",
  "distance_from_residence_km", "distance_basis", "allowance_amount", "allowance_breakdown_json",
  "expected_total_amount", "claimed_total_amount", "dm_work_allowance",
].join(", ");

export type DmWorkAllowanceOutcome =
  | { requestId: number; result: "not_applicable" | "not_waiting" | "on_payroll" | "unchanged" | "changed_meanwhile" }
  | { allowanceAfter: number; allowanceBefore: number; requestId: number; result: "written" };

async function onAPayrollRow(requestId: number): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expenses")
    .select("id")
    .eq("trip_id", `OUTSTATION-${requestId}`)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** Re-price one claim's allowance on each trip day's work and confirmations. Never throws for a claim it leaves alone. */
export async function priceDmWorkAllowance(requestId: number, options: { now?: Date } = {}): Promise<DmWorkAllowanceOutcome> {
  const now = options.now ?? new Date();
  const { data, error } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .select(CLAIM_COLUMNS)
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data ?? null) as Row | null;
  if (
    !row ||
    !readDmWorkAllowance(row.dm_work_allowance) ||
    !isDistrictManagerRole(String(row.employee_role ?? "")) ||
    !isTripExpense(String(row.expense_type ?? ""))
  ) {
    return { requestId, result: "not_applicable" };
  }
  if (!(WAITING_STATUSES as ReadonlyArray<string>).includes(String(row.status ?? ""))) return { requestId, result: "not_waiting" };
  if (await onAPayrollRow(requestId)) return { requestId, result: "on_payroll" };

  const hrId = String(row.employee_hr_id ?? "").trim();
  const start = cairoDateOnly(String(row.trip_start_date ?? "") || null);
  const end = cairoDateOnly(String(row.trip_end_date ?? "") || null) ?? start;
  const breakdown = readBreakdown(row.allowance_breakdown_json);
  const rows = Array.isArray(breakdown?.rows) ? breakdown.rows : [];
  if (!hrId || !start || !end || rows.length === 0) return { requestId, result: "not_applicable" };

  const [workload, visits] = await Promise.all([
    getRepTripVisitWorkload({ hrId, tripEndDate: end, tripStartDate: start }),
    readDmDoubleVisits(hrId, start, end),
  ]);
  const confirmations = await readConfirmations(visits.map((v) => v.id));
  const byDay = new Map<string, DmDoubleVisit[]>();
  for (const v of visits) {
    if (!v.visitDate || !v.capturedAt) continue;
    const list = byDay.get(v.visitDate) ?? [];
    list.push({ capturedAt: v.capturedAt, confirmedAt: confirmations.get(v.id)?.confirmedAt ?? null, id: v.id, repName: null });
    byDay.set(v.visitDate, list);
  }
  const counts = new Map(workload.dateBreakdown.map((d) => [d.date, d]));
  const work = (date: string): DmTripDayWork => ({
    am: counts.get(date)?.am ?? 0,
    doubleVisits: byDay.get(date) ?? [],
    final: now.getTime() >= crmDayClosesAt(date),
    pm: counts.get(date)?.pm ?? 0,
  });
  const km = readDistanceBasis(row.distance_basis)?.pricedKm ?? num(row.distance_from_residence_km);

  const typedRows = rows.map((r) => ({
    ...r,
    amount: num(r.amount) ?? 0,
    label: String(r.label ?? ""),
    type: (String(r.type ?? "overnight") as "overnight" | "return_day" | "same_day"),
  }));
  const plan = planDmWorkAllowance({
    km,
    now: now.toISOString(),
    rowDates: allowanceRowDates(String(row.trip_start_date ?? start).slice(0, 10), typedRows.length),
    rows: typedRows,
    work,
  });

  const allowanceNow = num(row.allowance_amount) ?? 0;
  const delta = round2(plan.record.allowanceAfter - allowanceNow);
  const previous = readDmWorkAllowance(row.dm_work_allowance);
  const sameDays = JSON.stringify(previous?.days ?? []) === JSON.stringify(plan.record.days);
  if (Math.abs(delta) < 0.005 && sameDays && previous?.final === plan.record.final) return { requestId, result: "unchanged" };

  const expected = num(row.expected_total_amount) ?? 0;
  const claimed = num(row.claimed_total_amount) ?? 0;
  const systemClaim = Math.abs(claimed - expected) <= 0.01;
  const expectedAfter = round2(expected + delta);
  const write = {
    allowance_amount: plan.record.allowanceAfter,
    // Stored the way submit stores it: a JSON string inside the jsonb column (service.ts, safeJsonParse on read).
    allowance_breakdown_json: JSON.stringify({ ...(breakdown ?? {}), rows: plan.rows }),
    claimed_total_amount: systemClaim ? expectedAfter : claimed,
    dm_work_allowance: plan.record,
    expected_total_amount: expectedAfter,
    updated_at: now.toISOString(),
  };
  const { data: written, error: writeError } = await getSupabaseAdmin()
    .from("outstation_expense_requests")
    .update(write)
    .eq("id", requestId)
    .in("status", [...WAITING_STATUSES])
    .eq("updated_at", String(row.updated_at))
    .select("id")
    .maybeSingle();
  if (writeError) throw new Error(writeError.message);
  if (!written) return { requestId, result: "changed_meanwhile" };

  if (Math.abs(delta) >= 0.005) {
    await writeRequiredAuditLog({
      actorLoginId: "system",
      entityId: String(requestId),
      entityType: "outstation_request",
      newValues: { allowance: plan.record.allowanceAfter, claimedTotal: write.claimed_total_amount, source: "dm_work_allowance" },
      oldValues: { allowance: allowanceNow, claimedTotal: claimed },
      summary: `District Manager claim ${requestId}: the allowance was priced on each trip day's work and confirmed double visits.`,
    });
  }
  return { allowanceAfter: plan.record.allowanceAfter, allowanceBefore: allowanceNow, requestId, result: "written" };
}

/** The morning run: every waiting District Manager claim filed under the rules; one failure never stops the rest. */
export async function priceWaitingDmWorkAllowances(options: { now?: Date } = {}): Promise<{ failed: number; read: number; written: number }> {
  const rows = await fetchAllRows<Row>(
    () =>
      getSupabaseAdmin()
        .from("outstation_expense_requests")
        .select("id")
        .in("status", [...WAITING_STATUSES])
        .not("dm_work_allowance", "is", null),
    "id",
  );
  const summary = { failed: 0, read: rows.length, written: 0 };
  for (const row of rows) {
    try {
      if ((await priceDmWorkAllowance(Number(row.id), options)).result === "written") summary.written += 1;
    } catch (error) {
      summary.failed += 1;
      logError("A District Manager claim's work allowance could not be priced", {
        error,
        labels: { event: "outstation_dm_work_allowance_failed", requestId: String(row.id) },
      });
    }
  }
  return summary;
}

// ── The notice when a rep logs a double visit with him ───────────────────────────────────────────

/** Farther than this from home, a double visit with no trip claim covering the day asks him to submit his arrival. */
export const DM_ARRIVAL_REMINDER_KM = 60;

/**
 * A rep saved a double visit with a District Manager (owner, 28 Nov 2026): tell the manager — in the app and
 * by push, never by email — to confirm it, and, when it is far from his home and no trip claim of his covers
 * the day, to submit his arrival now. The rep is told nothing. Never throws: the visit is saved already.
 */
export async function notifyDmDoubleVisitToConfirm(input: {
  customerName: string;
  isTest: boolean;
  lat: number | null;
  lon: number | null;
  managerHrId: string | null;
  repHrId: string | null;
  visitDate: string;
  visitId: string;
}): Promise<void> {
  try {
    const manager = String(input.managerHrId ?? "").trim();
    if (!manager || input.isTest) return;
    const { data } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, job_title")
      .in("hr_id", hrIdLookupKeys(manager))
      .limit(1);
    const jobTitle = ((data ?? []) as Row[])[0]?.job_title;
    const { resolveJobFunctionRole } = await import("@/lib/employees/job-function");
    if (!isDistrictManagerRole(resolveJobFunctionRole(jobTitle ? String(jobTitle) : null))) return;

    const onTrip = await dmHasTripClaimOn(manager, input.visitDate);
    let arrivalDue = false;
    if (!onTrip && input.lat !== null && input.lon !== null) {
      const { getResidenceLocationForEmployee } = await import("@/lib/outstation/service");
      const home = await getResidenceLocationForEmployee(manager).catch(() => null);
      if (home?.residenceLatitude != null && home.residenceLongitude != null) {
        const km = distanceKm(
          { latitude: home.residenceLatitude, longitude: home.residenceLongitude },
          { latitude: input.lat, longitude: input.lon },
        );
        arrivalDue = km > DM_ARRIVAL_REMINDER_KM;
      }
    }
    if (!onTrip && !arrivalDue) return;

    const names = await loadPeopleNames([input.repHrId]);
    const rep = input.repHrId ? nameOf(names, input.repHrId, "A rep") : "A rep";
    const { createSystemNotificationForRecipients } = await import("@/lib/notifications/system");
    await createSystemNotificationForRecipients(
      {
        actionUrl: "/employee-portals/submit-expense",
        channels: ["in_app", "push"],
        eventType: arrivalDue ? "outstation_dm_arrival_due" : "outstation_dm_double_visit_to_confirm",
        message: arrivalDue
          ? `${rep} logged a double visit with you at ${input.customerName}. You are away from home: submit your arrival now, then confirm the visit in Submit Expense. The first and the last double visit of each trip day must be confirmed, or that day's allowance is not paid.`
          : `${rep} logged a double visit with you at ${input.customerName}. Confirm it in Submit Expense. The first and the last double visit of each trip day must be confirmed, or that day's allowance is not paid.`,
        metadata: { idempotencyKey: `outstation:dm-visit:${input.visitId}:${arrivalDue ? "arrival" : "confirm"}` },
        module: "outstation",
        priority: "normal",
        subjectHrId: manager,
        title: arrivalDue ? "Submit your arrival now" : "Confirm your double visit",
      },
      [manager],
    );
  } catch (error) {
    logError("The District Manager could not be told to confirm a double visit", {
      error,
      labels: { event: "outstation_dm_double_visit_notice_failed", visitId: input.visitId },
    });
  }
}

// ── A ticket added after the claim ────────────────────────────────────────────────────────────────

/**
 * A District Manager adding a ticket to his claim (owner, 28 Nov 2026): a live photo or the operator's
 * PDF, and within 12 hours of his first double visit of the trip's last day — else of that day's end.
 * Null when it may be added.
 */
export async function dmTicketAddRefusal(
  claim: { employeeHrId: string | null; tripEndDate: string | null; tripStartDate: string | null },
  files: ReadonlyArray<DmTicketFile>,
  now = new Date(),
): Promise<string | null> {
  const source = dmTicketSourceRefusal(files);
  if (source) return source;
  const lastDay = cairoDateOnly(claim.tripEndDate || claim.tripStartDate || null);
  const hrId = String(claim.employeeHrId ?? "").trim();
  const firstVisitAt = lastDay && hrId ? await firstDmDoubleVisitAtOn(hrId, lastDay).catch(() => null) : null;
  return dmTicketTooLateMessage({ deadline: dmTicketDeadline({ firstDoubleVisitAt: firstVisitAt, tripEndDate: lastDay }), nowMs: now.getTime() });
}
