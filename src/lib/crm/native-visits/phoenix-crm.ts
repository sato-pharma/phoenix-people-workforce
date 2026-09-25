/**
 * Phoenix CRM — the service behind its own space (the owner, 2026-09-14).
 *
 * Phoenix CRM is Visits, Planning and KPIs for the medical reps the Super Admin picks, from any line, on
 * the pilot roster. Their managers (DM, RSM, NSM) see their own pilot reps only — scope runs downward.
 * Nobody else sees it. Once the pilot is confirmed it merges into Phoenix for the whole company.
 *
 * The KPIs read only what the pilot reps entered in Phoenix. iReports360 data is kept and never read
 * here: "start clean from scratch, then later merge the data".
 *
 * Every exported function checks crm_visit_entry itself; getPhoenixCrmAccess uses canAccess because the
 * pages must render (or redirect) without it throwing.
 */

import { assertPermission, canAccess, type AccessContext } from "@/lib/auth/permissions";
import { countCallRateWorkingDays } from "@/lib/crm/call-rate";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { getCrmCutoverSetting } from "@/lib/crm/cutover";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { isAgentInScope, type DoctorCoverageScope } from "@/lib/crm/doctor-coverage-roles";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  computePhoenixCrmKpis,
  phoenixCrmCallRateText,
  phoenixCrmCallRateWindow,
  phoenixCrmMonthBounds,
  phoenixCrmMonthOf,
  phoenixCrmRepWindow,
  type PhoenixCrmPlannedFact,
  type PhoenixCrmVisitFact,
} from "@/lib/crm/native-visits/phoenix-crm-kpi-rules";
import type {
  PhoenixCrmAccessView,
  PhoenixCrmKpiRow,
  PhoenixCrmKpiView,
  PhoenixCrmPlanOverview,
  PhoenixCrmPlanOverviewRow,
  PhoenixCrmRosterRow,
  PhoenixCrmRosterView,
} from "@/lib/crm/native-visits/phoenix-crm-types";
import { nativePlanStatusLabel, nativePlanWeekStart, type NativePlanStatus } from "@/lib/crm/native-visits/plan-rules";
import { getNativePlanAvailability } from "@/lib/crm/native-visits/plans-service";
import {
  isNativeEntryOffered,
  isNativeVisitRepTitle,
  nativeVisitPilotForRep,
  type NativePilotRosterEntry,
  type NativeVisitShift,
} from "@/lib/crm/native-visits/rules";
import { getNativeVisitEntryAvailability } from "@/lib/crm/native-visits/service";
import {
  chunk,
  employeeName,
  isMissingTable,
  loadDirectory,
  loadEntryGate,
  loadListAssignmentsByRep,
  loadPilotRoster,
  PAGE_SIZE,
  type Directory,
} from "@/lib/crm/native-visits/server-shared";
import {
  CRM_NATIVE_PILOT_REP_EVENTS_TABLE,
  CRM_NATIVE_PILOT_REPS_TABLE,
  CRM_NATIVE_PLAN_ITEMS_TABLE,
  CRM_NATIVE_PLANS_TABLE,
  CRM_NATIVE_VISITS_TABLE,
} from "@/lib/crm/native-visits/tables";
import { isActiveDirectoryEmployee, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// The pilot's own page is retired (the owner, 2026-09-25); its notifications open the live field app.
const PHOENIX_CRM_URL = "/employee-portals/field-crm";

type PilotRep = { row: EmployeeDirectoryRow; startsOn: string };

function repDetail(row: EmployeeDirectoryRow): string {
  return [row.jobTitle, row.lineName, row.areaName].filter(Boolean).join(" · ");
}

/**
 * The pilot reps this viewer may see: active medical reps inside the viewer's scope, on the roster (or, once a
 * cutover date is set, every rep from that date), never the viewer themselves.
 */
function pilotRepsInScope(input: {
  directory: Directory;
  roster: readonly NativePilotRosterEntry[];
  cutoverDate: string | null;
  scope: DoctorCoverageScope;
  viewerHrId: string | null | undefined;
}): PilotRep[] {
  const viewerKey = canonicalHrIdKey(input.viewerHrId);
  const out: PilotRep[] = [];
  for (const row of input.directory.rows) {
    if (!isActiveDirectoryEmployee(row) || !isNativeVisitRepTitle(row.jobTitle)) continue;
    if (!isAgentInScope(input.scope, row.hrId) || canonicalHrIdKey(row.hrId) === viewerKey) continue;
    const pilot = nativeVisitPilotForRep(row, input.roster);
    const startsOn = pilot?.startsOn ?? input.cutoverDate;
    if (startsOn) out.push({ row, startsOn });
  }
  return out.sort((left, right) => employeeName(left.row).localeCompare(employeeName(right.row)));
}

// ── Who sees Phoenix CRM ────────────────────────────────────────────────────────────────────────

/** Never throws — a page decides from it whether to render or redirect. */
export async function getPhoenixCrmAccess(access: AccessContext): Promise<PhoenixCrmAccessView> {
  const none: PhoenixCrmAccessView = { seat: null, waiting: 0 };
  try {
    const [mayUpdate, mayApprove, mayCreate] = await Promise.all([
      canAccess(access, "crm_visit_entry", "update"),
      canAccess(access, "crm_visit_entry", "approve"),
      canAccess(access, "crm_visit_entry", "create"),
    ]);
    if (mayUpdate) return { seat: "admin", waiting: 0 };
    if (!mayApprove && !mayCreate) return none;

    const [directory, roster, cutover] = await Promise.all([loadDirectory(), loadPilotRoster(), getCrmCutoverSetting()]);

    if (mayApprove) {
      const scope = await getDoctorCoverageScope(access);
      const reps = pilotRepsInScope({ directory, roster, cutoverDate: cutover.cutoverDate, scope, viewerHrId: access.hrId });
      if (reps.length === 0) return none;
      const [visits, plans] = await Promise.all([getNativeVisitEntryAvailability(access), getNativePlanAvailability(access)]);
      return { seat: "manager", waiting: visits.pendingConfirmations + plans.pendingReviews };
    }

    const key = canonicalHrIdKey(access.hrId);
    const self = key ? directory.byKey.get(key) : undefined;
    if (!self || !isActiveDirectoryEmployee(self)) return none;
    const gate = await loadEntryGate(self, roster);
    return isNativeEntryOffered(gate, cairoTodayIso()) ? { seat: "rep", waiting: 0 } : none;
  } catch {
    return none;
  }
}

// ── The pilot roster ────────────────────────────────────────────────────────────────────────────

type RosterRecord = {
  hrId: string;
  startsOn: string;
  addedAt: string | null;
  addedBy: string | null;
  removedAt: string | null;
  removedBy: string | null;
};

async function loadRosterRecords(): Promise<Map<string, RosterRecord>> {
  const out = new Map<string, RosterRecord>();
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_PILOT_REPS_TABLE)
    .select("hr_id,starts_on,added_at,added_by,removed_at,removed_by");
  if (error) {
    if (isMissingTable(error)) return out;
    throw error;
  }
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const key = canonicalHrIdKey(String(row.hr_id ?? ""));
    if (!key) continue;
    out.set(key, {
      hrId: String(row.hr_id),
      startsOn: String(row.starts_on ?? ""),
      addedAt: row.added_at ? String(row.added_at) : null,
      addedBy: row.added_by ? String(row.added_by) : null,
      removedAt: row.removed_at ? String(row.removed_at) : null,
      removedBy: row.removed_by ? String(row.removed_by) : null,
    });
  }
  return out;
}

/** The Super Admin's roster page: every active medical rep in scope, and whether each is in the pilot. */
export async function listPhoenixCrmPilotRoster(access: AccessContext): Promise<PhoenixCrmRosterView> {
  await assertPermission(access, "crm_visit_entry", "update");
  const [directory, records, scope] = await Promise.all([loadDirectory(), loadRosterRecords(), getDoctorCoverageScope(access)]);
  const nameOf = (hrId: string | null) => (hrId ? employeeName(directory.byKey.get(canonicalHrIdKey(hrId) ?? "")) : null);

  const rows = directory.rows
    .filter((row) => isActiveDirectoryEmployee(row) && isNativeVisitRepTitle(row.jobTitle) && isAgentInScope(scope, row.hrId))
    .map((row): PhoenixCrmRosterRow => {
      const record = records.get(canonicalHrIdKey(row.hrId) ?? "");
      const onRoster = Boolean(record && !record.removedAt);
      return {
        hrId: row.hrId,
        name: employeeName(row),
        jobTitle: row.jobTitle,
        lineName: row.lineName,
        areaName: row.areaName,
        managerName: row.managerHrId ? nameOf(row.managerHrId) : null,
        onRoster,
        startsOn: onRoster ? (record?.startsOn ?? null) : null,
        changedBy: record ? nameOf(onRoster ? record.addedBy : record.removedBy) : null,
        changedAt: record ? (onRoster ? record.addedAt : record.removedAt) : null,
      };
    })
    // The reps in the pilot first, then by name.
    .sort((left, right) => Number(right.onRoster) - Number(left.onRoster) || left.name.localeCompare(right.name));

  return { cairoToday: cairoTodayIso(), onRosterCount: rows.filter((row) => row.onRoster).length, rows };
}

/** Tells the rep in-app that they joined or left the pilot. Never email. Never throws. */
async function notifyRepOfRosterChange(input: {
  rep: EmployeeDirectoryRow;
  action: "add" | "remove";
  actorHrId: string | null;
  at: string;
}): Promise<void> {
  try {
    await createSystemNotification({
      actionUrl: PHOENIX_CRM_URL,
      ...(input.actorHrId ? { actorId: input.actorHrId } : {}),
      category: "general",
      channels: ["in_app"],
      eventType: input.action === "add" ? "phoenix_crm_pilot_rep_added" : "phoenix_crm_pilot_rep_removed",
      metadata: { idempotencyKey: `phoenix_crm_pilot_rep_${input.action}:${canonicalHrIdKey(input.rep.hrId)}:${input.at}` },
      message:
        input.action === "add"
          ? "You are in the Phoenix CRM pilot from today. Open Phoenix CRM to enter your visits and your weekly plan."
          : "You are no longer in the Phoenix CRM pilot. What you saved there stays.",
      module: "crm",
      priority: "normal",
      recipientHrId: input.rep.hrId,
      ...(input.actorHrId ? { subjectHrId: input.actorHrId } : {}),
      title: input.action === "add" ? "You joined Phoenix CRM" : "You left Phoenix CRM",
    });
  } catch {
    // The roster changed; a notice that could not be sent must not undo it.
  }
}

/**
 * Adds a rep to the pilot from today, or takes one off. Only an active medical rep inside the Super
 * Admin's scope. A row is never deleted: removal stamps it, adding back clears the stamp.
 */
export async function setPhoenixCrmPilotRep(
  access: AccessContext,
  input: { repHrId: unknown; action: unknown },
): Promise<PhoenixCrmRosterView> {
  await assertPermission(access, "crm_visit_entry", "update");
  const action = input.action === "add" ? "add" : input.action === "remove" ? "remove" : null;
  if (!action) throw validationError("Choose to add or remove the rep.");
  if (!access.hrId) throw forbiddenError("Forbidden: changing the pilot needs an employee record.");

  const [directory, scope, records] = await Promise.all([loadDirectory(), getDoctorCoverageScope(access), loadRosterRecords()]);
  const key = canonicalHrIdKey(String(input.repHrId ?? "").trim());
  const rep = key ? directory.byKey.get(key) : undefined;
  if (!rep || !isActiveDirectoryEmployee(rep) || !isNativeVisitRepTitle(rep.jobTitle)) {
    throw validationError("Choose an active medical rep.");
  }
  if (!isAgentInScope(scope, rep.hrId)) throw forbiddenError("Forbidden: that rep is outside your scope.");

  const record = records.get(key ?? "");
  const onRoster = Boolean(record && !record.removedAt);
  // Already where the Super Admin wants them: nothing to write, nobody to tell.
  if ((action === "add") === onRoster) return listPhoenixCrmPilotRoster(access);

  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const actor = hrIdForStorage(access.hrId);
  if (action === "add") {
    const fields = {
      starts_on: cairoTodayIso(),
      added_at: now,
      added_by: actor,
      removed_at: null,
      removed_by: null,
      updated_at: now,
    };
    const { error } = record
      ? await supabase.from(CRM_NATIVE_PILOT_REPS_TABLE).update(fields).eq("hr_id", record.hrId)
      : await supabase.from(CRM_NATIVE_PILOT_REPS_TABLE).insert({ hr_id: rep.hrId, ...fields });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from(CRM_NATIVE_PILOT_REPS_TABLE)
      .update({ removed_at: now, removed_by: actor, updated_at: now })
      .in("hr_id", hrIdLookupKeys(rep.hrId))
      .is("removed_at", null);
    if (error) throw error;
  }

  const { error: eventError } = await supabase
    .from(CRM_NATIVE_PILOT_REP_EVENTS_TABLE)
    .insert({ hr_id: record?.hrId ?? rep.hrId, event: action === "add" ? "added" : "removed", actor_hr_id: actor });
  if (eventError) throw eventError;

  await notifyRepOfRosterChange({ rep, action, actorHrId: access.hrId, at: now });
  return listPhoenixCrmPilotRoster(access);
}

// ── KPIs ────────────────────────────────────────────────────────────────────────────────────────

async function loadVisitFacts(reps: readonly PilotRep[], from: string, to: string): Promise<Map<string, PhoenixCrmVisitFact[]>> {
  const byRep = new Map<string, PhoenixCrmVisitFact[]>();
  const keys = Array.from(new Set(reps.flatMap((rep) => hrIdLookupKeys(rep.row.hrId))));
  const supabase = getSupabaseAdmin();
  for (const ids of chunk(keys)) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from(CRM_NATIVE_VISITS_TABLE)
        .select("id,hr_id,visit_date,shift,visit_type,contact_crm_id")
        .in("hr_id", ids)
        .gte("visit_date", from)
        .lte("visit_date", to)
        .is("deleted_at", null)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) {
        if (isMissingTable(error)) return byRep;
        throw error;
      }
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const repKey = canonicalHrIdKey(String(row.hr_id ?? ""));
        if (!repKey) continue;
        const facts = byRep.get(repKey) ?? [];
        facts.push({
          contactCrmId: row.contact_crm_id == null ? null : Number(row.contact_crm_id),
          shift: row.shift as NativeVisitShift,
          visitDate: String(row.visit_date),
          visitType: String(row.visit_type ?? ""),
        });
        byRep.set(repKey, facts);
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return byRep;
}

type PlanHeader = { id: string; hrId: string; weekStart: string; status: NativePlanStatus; verifierHrId: string | null; decidedAt: string | null };

async function loadPlanHeaders(
  reps: readonly PilotRep[],
  filter: { weekStarts?: string[]; from?: string; to?: string; status?: NativePlanStatus },
): Promise<PlanHeader[]> {
  const out: PlanHeader[] = [];
  const keys = Array.from(new Set(reps.flatMap((rep) => hrIdLookupKeys(rep.row.hrId))));
  for (const ids of chunk(keys)) {
    let query = getSupabaseAdmin()
      .from(CRM_NATIVE_PLANS_TABLE)
      .select("id,hr_id,week_start,status,verifier_hr_id,decided_at")
      .in("hr_id", ids);
    if (filter.weekStarts) query = query.in("week_start", filter.weekStarts);
    if (filter.from) query = query.gte("week_end", filter.from);
    if (filter.to) query = query.lte("week_start", filter.to);
    if (filter.status) query = query.eq("status", filter.status);
    const { data, error } = await query;
    if (error) {
      if (isMissingTable(error)) return out;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      out.push({
        id: String(row.id),
        hrId: String(row.hr_id),
        weekStart: String(row.week_start),
        status: row.status as NativePlanStatus,
        verifierHrId: row.verifier_hr_id ? String(row.verifier_hr_id) : null,
        decidedAt: row.decided_at ? String(row.decided_at) : null,
      });
    }
  }
  return out;
}

/** The live items of these plans, by plan id. */
async function loadLivePlanItems(planIds: readonly string[]): Promise<Map<string, PhoenixCrmPlannedFact[]>> {
  const byPlan = new Map<string, PhoenixCrmPlannedFact[]>();
  const supabase = getSupabaseAdmin();
  for (const ids of chunk(planIds)) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await supabase
        .from(CRM_NATIVE_PLAN_ITEMS_TABLE)
        .select("id,plan_id,plan_date,contact_crm_id")
        .in("plan_id", ids)
        .is("removed_at", null)
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) {
        if (isMissingTable(error)) return byPlan;
        throw error;
      }
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const planId = String(row.plan_id);
        const items = byPlan.get(planId) ?? [];
        items.push({ contactCrmId: Number(row.contact_crm_id), planDate: String(row.plan_date) });
        byPlan.set(planId, items);
      }
      if (rows.length < PAGE_SIZE) break;
    }
  }
  return byPlan;
}

function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [year, month] = first.split("-").map(Number);
  const [lastYear, lastMonth] = last.split("-").map(Number);
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out.reverse();
}

/**
 * The KPI board: a pilot rep sees their own row, a manager their own pilot reps, the Super Admin every pilot
 * rep in their scope. Call rate AM · PM (apart, never averaged), coverage, frequency and plan achieved.
 */
export async function getPhoenixCrmKpis(access: AccessContext, input: { month?: unknown }): Promise<PhoenixCrmKpiView> {
  await assertPermission(access, "crm_visit_entry", "read");
  const [mayUpdate, mayApprove] = await Promise.all([
    canAccess(access, "crm_visit_entry", "update"),
    canAccess(access, "crm_visit_entry", "approve"),
  ]);
  const audience: PhoenixCrmKpiView["audience"] = mayUpdate ? "all" : mayApprove ? "team" : "self";
  const cairoToday = cairoTodayIso();

  const [directory, roster, cutover] = await Promise.all([loadDirectory(), loadPilotRoster(), getCrmCutoverSetting()]);
  let reps: PilotRep[];
  if (audience === "self") {
    const key = canonicalHrIdKey(access.hrId);
    const self = key ? directory.byKey.get(key) : undefined;
    const startsOn = self ? (nativeVisitPilotForRep(self, roster)?.startsOn ?? cutover.cutoverDate) : null;
    reps = self && isActiveDirectoryEmployee(self) && startsOn ? [{ row: self, startsOn }] : [];
  } else {
    const scope = await getDoctorCoverageScope(access);
    reps = pilotRepsInScope({ directory, roster, cutoverDate: cutover.cutoverDate, scope, viewerHrId: access.hrId });
  }

  const currentMonth = phoenixCrmMonthOf(cairoToday);
  const earliest = reps.reduce<string | null>((min, rep) => (min == null || rep.startsOn < min ? rep.startsOn : min), null);
  const months = monthsBetween(earliest && earliest < cairoToday ? phoenixCrmMonthOf(earliest) : currentMonth, currentMonth);
  const requested = String(input.month ?? "").trim();
  const month = months.includes(requested) ? requested : currentMonth;
  const bounds = phoenixCrmMonthBounds(month);
  const empty: PhoenixCrmKpiView = { month, months, audience, cairoToday, holidaysComplete: true, rows: [] };
  if (!bounds || reps.length === 0 || bounds.from > cairoToday) return empty;

  const readTo = bounds.to < cairoToday ? bounds.to : cairoToday;
  const [holidays, panels, visitsByRep, verifiedPlans] = await Promise.all([
    loadCallRateHolidays(bounds.from, readTo),
    loadListAssignmentsByRep(reps.map((rep) => rep.row)),
    loadVisitFacts(reps, bounds.from, readTo),
    loadPlanHeaders(reps, { from: bounds.from, to: readTo, status: "verified" }),
  ]);
  const itemsByPlan = await loadLivePlanItems(verifiedPlans.map((plan) => plan.id));
  const plannedByRep = new Map<string, PhoenixCrmPlannedFact[]>();
  for (const plan of verifiedPlans) {
    const repKey = canonicalHrIdKey(plan.hrId);
    if (!repKey) continue;
    plannedByRep.set(repKey, [...(plannedByRep.get(repKey) ?? []), ...(itemsByPlan.get(plan.id) ?? [])]);
  }

  const rows = reps.map((rep): PhoenixCrmKpiRow => {
    const repKey = canonicalHrIdKey(rep.row.hrId) ?? "";
    const window = phoenixCrmRepWindow(bounds, rep.startsOn, cairoToday);
    const inWindow = (day: string) => Boolean(window && day >= window.from && day <= window.to);
    // Ruling C1: the call rate stops at yesterday, its calls and its working days together.
    const callRateWindow = phoenixCrmCallRateWindow(window, cairoToday);
    const result = computePhoenixCrmKpis({
      workingDays: callRateWindow ? countCallRateWorkingDays(callRateWindow.from, callRateWindow.to, holidays.dates) : 0,
      panel: panels.get(repKey) ?? [],
      visits: (visitsByRep.get(repKey) ?? []).filter((visit) => inWindow(visit.visitDate)),
      callRateWindow,
      planned: (plannedByRep.get(repKey) ?? []).filter((item) => inWindow(item.planDate)),
      cairoToday,
    });
    return {
      ...result,
      hrId: rep.row.hrId,
      name: employeeName(rep.row),
      detail: repDetail(rep.row),
      startsOn: rep.startsOn,
      window,
      callRateWindow,
      callRateText: phoenixCrmCallRateText(result.callRate),
    };
  });

  return { ...empty, holidaysComplete: holidays.complete, rows };
}

// ── Planning at a glance ────────────────────────────────────────────────────────────────────────

/**
 * This week's and next week's plan for each pilot rep the viewer may see — the Super Admin every one in
 * their scope, a manager their own. Read only: verifying stays with the manager the plan was sent to.
 */
export async function getPhoenixCrmPlanOverview(access: AccessContext): Promise<PhoenixCrmPlanOverview> {
  await assertPermission(access, "crm_visit_entry", "read");
  const [mayUpdate, mayApprove] = await Promise.all([
    canAccess(access, "crm_visit_entry", "update"),
    canAccess(access, "crm_visit_entry", "approve"),
  ]);
  if (!mayUpdate && !mayApprove) throw forbiddenError("Forbidden: the plan overview is for the Super Admin and managers.");

  const thisWeek = nativePlanWeekStart(cairoTodayIso());
  const weeks = [thisWeek, addDaysIso(thisWeek, 7)];
  const [directory, roster, cutover, scope] = await Promise.all([
    loadDirectory(),
    loadPilotRoster(),
    getCrmCutoverSetting(),
    getDoctorCoverageScope(access),
  ]);
  const reps = pilotRepsInScope({ directory, roster, cutoverDate: cutover.cutoverDate, scope, viewerHrId: access.hrId });
  if (reps.length === 0) return { weeks, rows: [] };

  const plans = await loadPlanHeaders(reps, { weekStarts: weeks });
  const itemsByPlan = await loadLivePlanItems(plans.map((plan) => plan.id));
  const planByRepWeek = new Map(plans.map((plan) => [`${canonicalHrIdKey(plan.hrId)}|${plan.weekStart}`, plan]));

  const rows: PhoenixCrmPlanOverviewRow[] = [];
  for (const week of weeks) {
    for (const rep of reps) {
      const repKey = canonicalHrIdKey(rep.row.hrId);
      const plan = planByRepWeek.get(`${repKey}|${week}`);
      rows.push({
        key: `${repKey}|${week}`,
        repName: employeeName(rep.row),
        repDetail: repDetail(rep.row),
        weekStart: week,
        status: plan?.status ?? null,
        statusLabel: nativePlanStatusLabel(plan?.status ?? null),
        plannedCalls: plan ? (itemsByPlan.get(plan.id) ?? []).length : 0,
        managerName: plan?.verifierHrId ? employeeName(directory.byKey.get(canonicalHrIdKey(plan.verifierHrId) ?? "")) : null,
        decidedAt: plan?.decidedAt ?? null,
      });
    }
  }
  return { weeks, rows };
}
