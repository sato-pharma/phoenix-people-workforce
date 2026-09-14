/**
 * Native rep plans — the server service (CRM phase 4, the pilot).
 *
 * THE ONLY CODE THAT TOUCHES THE PLAN TABLES. iReports360 stays the plan of record for everyone, the
 * pilot line included: the vendor plan mirror, its sync and the plan-verification write-back are not
 * touched from here, and no report, KPI or board reads a native plan before the cutover.
 *
 * WHO. The rep is always the session's own person, looked up in the employee directory — never a
 * field of the request. A submitted plan goes to the rep's nearest active manager, recorded on the
 * plan; only that manager verifies or returns it, only for a rep inside the manager's downward scope.
 * The system never verifies and no one verifies on the manager's behalf.
 *
 * WHEN. Only open days from today on, in this field week or the next: before the CRM cutover a pilot
 * day of the rep's own line; from the cutover date on, every day, for every rep of every line at once.
 *
 * STABLE IDS. One item row per rep, doctor and day for good. A save sends the whole week; the service
 * diffs it against what is stored, so a kept doctor keeps its row and a dropped doctor is marked
 * removed — never deleted — and comes back as the same row if planned again.
 */

import { assertPermission, canAccess, type AccessContext } from "@/lib/auth/permissions";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { isAgentInScope } from "@/lib/crm/doctor-coverage-roles";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  NATIVE_PLAN_NOTE_MAX,
  diffNativePlanItems,
  isNativePlanDiffEmpty,
  isNativePlanWeekStart,
  nativePlanDayLoadRefusal,
  nativePlanDayShifts,
  nativePlanDecisionRefusal,
  nativePlanEditableDays,
  nativePlanItemKey,
  nativePlanItemOutcome,
  nativePlanItemRefusal,
  nativePlanLockedDayRefusal,
  nativePlanOpenWeeks,
  nativePlanRepActionRefusal,
  nativePlanVisitedRemovalRefusal,
  nativePlanWeekDays,
  parseNativePlanAction,
  parseNativePlanDecision,
  parseNativePlanItems,
  type NativePlanItemDiff,
  type NativePlanStatus,
  type NativePlanStoredItem,
} from "@/lib/crm/native-visits/plan-rules";
import type {
  NativePlanAvailability,
  NativePlanDayView,
  NativePlanDoubleVisit,
  NativePlanItemView,
  NativePlannerView,
  NativePlanReviewRow,
  NativePlanSaveResult,
  NativePlanWeekView,
} from "@/lib/crm/native-visits/plan-types";
import { NATIVE_PLAN_MANAGER_MESSAGE, type NativeVisitShift } from "@/lib/crm/native-visits/rules";
import {
  chunk,
  employeeName,
  isMissingTable,
  isUniqueViolation,
  loadDirectory,
  loadEntryGate,
  loadPilotRoster,
  loadRepContacts,
  managementChain,
  requireActiveSelf,
  type Directory,
} from "@/lib/crm/native-visits/server-shared";
import {
  CRM_NATIVE_PLAN_EVENTS_TABLE,
  CRM_NATIVE_PLAN_ITEMS_TABLE,
  CRM_NATIVE_PLANS_TABLE,
  CRM_NATIVE_VISITS_TABLE,
} from "@/lib/crm/native-visits/tables";
import type { NativeVisitContactOption } from "@/lib/crm/native-visits/types";
import { isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { sharedPlanningCalendarStatuses } from "@/lib/weekly-planning/calendar";

/** How far back a manager's review list looks, by the plan week's last day. */
const HISTORY_DAYS = 14;
const STALE_PLAN_MESSAGE = "This plan changed since you opened it. Reload the planner and make your change again.";

const PLAN_COLUMNS =
  "id,hr_id,week_start,week_end,area_name,status,revision,verifier_hr_id,submitted_at,decided_at,decision_note";
const ITEM_COLUMNS = "id,plan_id,plan_date,shift,contact_crm_id,contact_name,contact_speciality,contact_grade,removed_at";

type PlanRow = {
  id: string;
  hrId: string;
  weekStart: string;
  weekEnd: string;
  areaName: string | null;
  status: NativePlanStatus;
  revision: number;
  verifierHrId: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

type StoredItem = NativePlanStoredItem & {
  planId: string;
  contactName: string;
  speciality: string | null;
  grade: string | null;
};

function textOrNull(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function toPlanRow(row: Record<string, unknown>): PlanRow {
  return {
    id: String(row.id),
    hrId: String(row.hr_id),
    weekStart: String(row.week_start),
    weekEnd: String(row.week_end),
    areaName: textOrNull(row.area_name),
    status: row.status as NativePlanStatus,
    revision: Number(row.revision),
    verifierHrId: textOrNull(row.verifier_hr_id),
    submittedAt: textOrNull(row.submitted_at),
    decidedAt: textOrNull(row.decided_at),
    decisionNote: textOrNull(row.decision_note),
  };
}

// ── Loading ─────────────────────────────────────────────────────────────────────────────────────

async function loadRepPlans(hrId: string, weekStarts: string[]): Promise<Map<string, PlanRow>> {
  const out = new Map<string, PlanRow>();
  if (weekStarts.length === 0) return out;
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_PLANS_TABLE)
    .select(PLAN_COLUMNS)
    .in("hr_id", hrIdLookupKeys(hrId))
    .in("week_start", weekStarts);
  if (error) {
    if (isMissingTable(error)) return out;
    throw error;
  }
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const plan = toPlanRow(row);
    out.set(plan.weekStart, plan);
  }
  return out;
}

async function loadItems(planIds: string[]): Promise<Map<string, StoredItem[]>> {
  const byPlan = new Map<string, StoredItem[]>();
  for (const ids of chunk(planIds)) {
    const { data, error } = await getSupabaseAdmin().from(CRM_NATIVE_PLAN_ITEMS_TABLE).select(ITEM_COLUMNS).in("plan_id", ids);
    if (error) {
      if (isMissingTable(error)) return byPlan;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const item: StoredItem = {
        id: String(row.id),
        planId: String(row.plan_id),
        planDate: String(row.plan_date),
        shift: row.shift as NativeVisitShift,
        contactCrmId: Number(row.contact_crm_id),
        contactName: String(row.contact_name ?? "") || "Unnamed doctor",
        speciality: textOrNull(row.contact_speciality),
        grade: textOrNull(row.contact_grade),
        removed: Boolean(row.removed_at),
      };
      byPlan.set(item.planId, [...(byPlan.get(item.planId) ?? []), item]);
    }
  }
  return byPlan;
}

/** Live native DOCTOR visits per rep (canonical hr id key) as plan item keys — what keeps a planned call. */
async function loadVisitedKeys(hrIds: string[], from: string, to: string): Promise<Map<string, Set<string>>> {
  const byRep = new Map<string, Set<string>>();
  const keys = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  for (const ids of chunk(keys)) {
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_NATIVE_VISITS_TABLE)
      .select("hr_id,contact_crm_id,visit_date")
      .in("hr_id", ids)
      .gte("visit_date", from)
      .lte("visit_date", to)
      .eq("visit_type", "regular")
      .is("deleted_at", null);
    if (error) {
      if (isMissingTable(error)) return byRep;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const repKey = canonicalHrIdKey(String(row.hr_id));
      if (!repKey || row.contact_crm_id == null) continue;
      const set = byRep.get(repKey) ?? new Set<string>();
      set.add(nativePlanItemKey(String(row.visit_date), Number(row.contact_crm_id)));
      byRep.set(repKey, set);
    }
  }
  return byRep;
}

/**
 * Double Visits that managers' own weekly plans put on these reps' days, keyed `repKey|date`. Read-only
 * and additive: a failure here shows no double visits rather than breaking the plan.
 */
async function loadDoubleVisits(hrIds: string[], from: string, to: string): Promise<Map<string, NativePlanDoubleVisit[]>> {
  const out = new Map<string, NativePlanDoubleVisit[]>();
  try {
    const supabase = getSupabaseAdmin();
    const keys = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
    const items: Array<Record<string, unknown>> = [];
    for (const ids of chunk(keys)) {
      const { data, error } = await supabase
        .from("employee_plan_items")
        .select("plan_id,activity_date,activity_title,double_visit_medical_rep_hr_id")
        .eq("activity_type", "Double Visit")
        .in("double_visit_medical_rep_hr_id", ids)
        .gte("activity_date", from)
        .lte("activity_date", to);
      if (error) return out;
      items.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    if (items.length === 0) return out;

    const headers = new Map<string, Record<string, unknown>>();
    for (const ids of chunk(Array.from(new Set(items.map((item) => String(item.plan_id)))))) {
      const { data, error } = await supabase
        .from("employee_plan_headers")
        .select("id,employee_hr_id,employee_name,employee_job_title")
        .in("id", ids)
        // Only a plan the manager has sent on: never a draft, a cancelled or a refused one.
        .in("status", [...sharedPlanningCalendarStatuses]);
      if (error) return out;
      for (const row of (data ?? []) as Array<Record<string, unknown>>) headers.set(String(row.id), row);
    }

    const seen = new Set<string>();
    for (const item of items) {
      const header = headers.get(String(item.plan_id));
      const repKey = canonicalHrIdKey(String(item.double_visit_medical_rep_hr_id ?? ""));
      if (!header || !repKey) continue;
      const date = String(item.activity_date);
      const managerKey = canonicalHrIdKey(String(header.employee_hr_id ?? "")) ?? "";
      const dedupe = `${repKey}|${date}|${managerKey}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const key = `${repKey}|${date}`;
      out.set(key, [
        ...(out.get(key) ?? []),
        {
          date,
          managerName: String(header.employee_name ?? "") || "Unknown employee",
          managerJobTitle: textOrNull(header.employee_job_title),
          title: String(item.activity_title ?? "") || "Double Visit",
        },
      ]);
    }
    return out;
  } catch {
    return out;
  }
}

async function recordPlanEvent(
  planId: string,
  event: string,
  actorHrId: string | null,
  revision: number,
  detail: Record<string, unknown>,
) {
  const { error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_PLAN_EVENTS_TABLE)
    .insert({ plan_id: planId, event, actor_hr_id: hrIdForStorage(actorHrId), revision, detail });
  if (error) throw error;
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────────

function buildDays(
  weekStart: string,
  editableDays: readonly string[],
  doubleVisits: Map<string, NativePlanDoubleVisit[]>,
  repKey: string,
): NativePlanDayView[] {
  const editable = new Set(editableDays);
  return nativePlanWeekDays(weekStart).map((date) => ({
    date,
    shifts: nativePlanDayShifts(date),
    editable: editable.has(date),
    doubleVisits: doubleVisits.get(`${repKey}|${date}`) ?? [],
  }));
}

function itemViews(items: readonly StoredItem[], visited: ReadonlySet<string> | undefined, cairoToday: string): NativePlanItemView[] {
  return items
    .filter((item) => !item.removed)
    .map((item) => ({
      id: item.id,
      planDate: item.planDate,
      shift: item.shift,
      contactCrmId: item.contactCrmId,
      contactName: item.contactName,
      speciality: item.speciality,
      grade: item.grade,
      outcome: nativePlanItemOutcome({
        planDate: item.planDate,
        cairoToday,
        visited: visited?.has(nativePlanItemKey(item.planDate, item.contactCrmId)) ?? false,
      }),
    }))
    .sort(
      (left, right) =>
        left.planDate.localeCompare(right.planDate) ||
        left.shift.localeCompare(right.shift) ||
        left.contactName.localeCompare(right.contactName),
    );
}

function nameFor(directory: Directory, hrId: string | null): string | null {
  if (!hrId) return null;
  return employeeName(directory.byKey.get(canonicalHrIdKey(hrId) ?? ""));
}

// ── The rep's planner ───────────────────────────────────────────────────────────────────────────

/** A district manager holds create only for his rare single visits: he files no weekly plan. */
async function refuseManagerPlanner(access: AccessContext): Promise<void> {
  if (await canAccess(access, "crm_visit_entry", "approve")) throw forbiddenError(NATIVE_PLAN_MANAGER_MESSAGE);
}

export async function getMyNativePlanner(access: AccessContext): Promise<NativePlannerView> {
  await assertPermission(access, "crm_visit_entry", "create");
  await refuseManagerPlanner(access);
  const [directory, roster] = await Promise.all([loadDirectory(), loadPilotRoster()]);
  const rep = requireActiveSelf(access, directory);
  const gate = await loadEntryGate(rep, roster);
  const { pilot } = gate;
  const cairoToday = cairoTodayIso();
  const manager = managementChain(rep, directory)[0] ?? null;
  const weekStarts = nativePlanOpenWeeks(gate, cairoToday);
  const base = {
    pilot: pilot ? { lineName: pilot.lineName, startsOn: pilot.startsOn, endsOn: pilot.endsOn } : null,
    cutoverDate: gate.cutoverDate,
    cairoToday,
    managerName: manager?.name ?? null,
  };
  if (weekStarts.length === 0) return { ...base, contacts: [], weeks: [] };

  const plans = await loadRepPlans(rep.hrId, weekStarts);
  const from = weekStarts[0];
  const to = addDaysIso(weekStarts[weekStarts.length - 1], 5);
  const [items, contacts, visited, doubleVisits] = await Promise.all([
    loadItems(Array.from(plans.values()).map((plan) => plan.id)),
    loadRepContacts(rep),
    loadVisitedKeys([rep.hrId], from, to),
    loadDoubleVisits([rep.hrId], from, to),
  ]);
  const repKey = canonicalHrIdKey(rep.hrId) ?? "";

  const weeks = weekStarts.map((weekStart): NativePlanWeekView => {
    const plan = plans.get(weekStart) ?? null;
    const editableDays = nativePlanEditableDays(gate, weekStart, cairoToday);
    const status = plan?.status ?? null;
    return {
      weekStart,
      weekEnd: addDaysIso(weekStart, 5),
      planId: plan?.id ?? null,
      status,
      revision: plan?.revision ?? 0,
      submittedAt: plan?.submittedAt ?? null,
      decidedAt: plan?.decidedAt ?? null,
      decisionNote: plan?.decisionNote ?? null,
      verifierName: nameFor(directory, plan?.verifierHrId ?? null),
      days: buildDays(weekStart, editableDays, doubleVisits, repKey),
      items: itemViews(plan ? items.get(plan.id) ?? [] : [], visited.get(repKey), cairoToday),
      canEdit: editableDays.length > 0 && nativePlanRepActionRefusal("save", status, 1) === null,
      canReopen: editableDays.length > 0 && nativePlanRepActionRefusal("reopen", status, 0) === null,
    };
  });

  return { ...base, contacts, weeks };
}

/** Move a plan on, only from the version and states the caller saw. Every change raises the revision. */
async function claimPlan(plan: PlanRow, patch: Record<string, unknown>, fromStatuses: NativePlanStatus[]): Promise<PlanRow> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_PLANS_TABLE)
    .update({ ...patch, revision: plan.revision + 1, updated_at: new Date().toISOString() })
    .eq("id", plan.id)
    .eq("revision", plan.revision)
    .in("status", fromStatuses)
    .select(PLAN_COLUMNS);
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length !== 1) throw conflictError(STALE_PLAN_MESSAGE);
  return toPlanRow(rows[0]);
}

async function applyItemDiff(
  plan: PlanRow,
  diff: NativePlanItemDiff<StoredItem>,
  contactById: Map<number, NativeVisitContactOption>,
) {
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();

  if (diff.insert.length > 0) {
    const { error } = await supabase.from(CRM_NATIVE_PLAN_ITEMS_TABLE).insert(
      diff.insert.map((item) => {
        const contact = contactById.get(item.contactCrmId);
        return {
          plan_id: plan.id,
          hr_id: plan.hrId,
          week_start: plan.weekStart,
          plan_date: item.planDate,
          shift: item.shift,
          contact_crm_id: item.contactCrmId,
          contact_name: contact?.name ?? null,
          contact_speciality: contact?.speciality ?? null,
          contact_grade: contact?.grade ?? null,
        };
      }),
    );
    if (error) {
      if (isUniqueViolation(error)) throw conflictError(STALE_PLAN_MESSAGE);
      throw error;
    }
  }

  // A dropped doctor keeps its row: removed, never deleted, so its id is never reissued.
  if (diff.remove.length > 0) {
    const { error } = await supabase
      .from(CRM_NATIVE_PLAN_ITEMS_TABLE)
      .update({ removed_at: now, updated_at: now })
      .in("id", diff.remove.map((row) => row.id))
      .is("removed_at", null);
    if (error) throw error;
  }

  for (const shift of ["AM", "PM"] as const) {
    const restoreIds = diff.restore.filter((change) => change.shift === shift).map((change) => change.row.id);
    if (restoreIds.length > 0) {
      const { error } = await supabase
        .from(CRM_NATIVE_PLAN_ITEMS_TABLE)
        .update({ removed_at: null, shift, updated_at: now })
        .in("id", restoreIds);
      if (error) throw error;
    }
    const reshiftIds = diff.reshift.filter((change) => change.shift === shift).map((change) => change.row.id);
    if (reshiftIds.length > 0) {
      const { error } = await supabase
        .from(CRM_NATIVE_PLAN_ITEMS_TABLE)
        .update({ shift, updated_at: now })
        .in("id", reshiftIds);
      if (error) throw error;
    }
  }
}

export async function saveMyNativePlan(
  access: AccessContext,
  input: { weekStart: unknown; action: unknown; items: unknown; revision: unknown },
): Promise<NativePlanSaveResult> {
  await assertPermission(access, "crm_visit_entry", "create");
  await refuseManagerPlanner(access);
  const action = parseNativePlanAction(input.action);
  if (!action) throw validationError("Choose save, submit or reopen.");
  const weekStart = String(input.weekStart ?? "").trim();
  const revision = Number(input.revision ?? 0);

  const [directory, roster] = await Promise.all([loadDirectory(), loadPilotRoster()]);
  const rep = requireActiveSelf(access, directory);
  const gate = await loadEntryGate(rep, roster);
  const { pilot } = gate;
  const cairoToday = cairoTodayIso();
  if (!isNativePlanWeekStart(weekStart) || !nativePlanOpenWeeks(gate, cairoToday).includes(weekStart)) {
    throw forbiddenError(
      gate.cutoverDate
        ? "Forbidden: that week has no day left that can be planned in Phoenix."
        : "Forbidden: planning in Phoenix is open only to the pilot reps, for weeks with pilot days still ahead.",
    );
  }
  const editableDays = nativePlanEditableDays(gate, weekStart, cairoToday);

  const existing = (await loadRepPlans(rep.hrId, [weekStart])).get(weekStart) ?? null;
  if ((existing?.revision ?? 0) !== revision) throw conflictError(STALE_PLAN_MESSAGE);

  if (action === "reopen") {
    const refusal = nativePlanRepActionRefusal("reopen", existing?.status ?? null, 0);
    if (refusal || !existing) throw validationError(refusal ?? "Only a submitted or verified plan can be reopened for changes.");
    const reopened = await claimPlan(
      existing,
      { status: "draft", verifier_hr_id: null, submitted_at: null, decided_at: null, decided_by: null, decision_note: null },
      ["submitted", "verified"],
    );
    await recordPlanEvent(existing.id, "reopened", access.hrId, reopened.revision, { from: existing.status });
    return { planId: reopened.id, status: reopened.status, revision: reopened.revision };
  }

  const parsed = parseNativePlanItems(input.items);
  if (!parsed.ok) throw validationError(parsed.error);
  const wanted = parsed.value;
  const statusRefusal = nativePlanRepActionRefusal(action, existing?.status ?? null, wanted.length);
  if (statusRefusal) throw validationError(statusRefusal);
  const loadRefusal = nativePlanDayLoadRefusal(wanted);
  if (loadRefusal) throw validationError(loadRefusal);

  // Every doctor must be on the rep's own open AM or PM list, planned on a half-day that list allows.
  const contacts = await loadRepContacts(rep);
  const contactById = new Map(contacts.map((contact) => [contact.contactCrmId, contact]));
  for (const item of wanted) {
    const refusal = nativePlanItemRefusal(item, { weekStart, listTypes: contactById.get(item.contactCrmId)?.lists ?? [] });
    if (refusal) throw validationError(refusal);
  }

  // A submitted plan goes to the rep's nearest active manager, named on the plan now.
  const verifier = action === "submit" ? managementChain(rep, directory)[0] ?? null : null;
  if (action === "submit") {
    const verifierRow = verifier ? directory.byKey.get(canonicalHrIdKey(verifier.hrId) ?? "") : undefined;
    if (!verifier || !verifierRow || !isActiveDirectoryEmployee(verifierRow)) {
      throw validationError("Phoenix has no active manager on record to send your plan to. Ask HR to check your manager.");
    }
  }

  const stored = existing ? (await loadItems([existing.id])).get(existing.id) ?? [] : [];
  const diff = diffNativePlanItems(stored, wanted);
  const lockedRefusal = nativePlanLockedDayRefusal(diff, editableDays);
  if (lockedRefusal) throw validationError(lockedRefusal);
  if (diff.remove.length > 0) {
    const visited = await loadVisitedKeys([rep.hrId], weekStart, addDaysIso(weekStart, 5));
    const visitedRefusal = nativePlanVisitedRemovalRefusal(diff, visited.get(canonicalHrIdKey(rep.hrId) ?? "") ?? new Set());
    if (visitedRefusal) throw validationError(visitedRefusal);
  }

  let plan: PlanRow;
  if (!existing) {
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_NATIVE_PLANS_TABLE)
      .insert({
        hr_id: rep.hrId,
        week_start: weekStart,
        week_end: addDaysIso(weekStart, 5),
        line_name: rep.lineName ?? pilot?.lineName ?? "",
        area_name: rep.areaName,
        region_name: rep.regionName,
        manager_hr_id: rep.managerHrId,
        status: "draft",
        revision: 1,
      })
      .select(PLAN_COLUMNS)
      .single();
    if (error) {
      if (isUniqueViolation(error)) throw conflictError(STALE_PLAN_MESSAGE);
      throw error;
    }
    plan = toPlanRow(data as Record<string, unknown>);
    await recordPlanEvent(plan.id, "created", access.hrId, plan.revision, {});
  } else if (action === "save" && isNativePlanDiffEmpty(diff)) {
    return { planId: existing.id, status: existing.status, revision: existing.revision };
  } else {
    plan = await claimPlan(existing, {}, ["draft", "returned"]);
  }

  await applyItemDiff(plan, diff, contactById);
  await recordPlanEvent(plan.id, "saved", access.hrId, plan.revision, {
    added: diff.insert.length + diff.restore.length,
    moved: diff.reshift.length,
    removed: diff.remove.length,
  });

  if (action === "submit" && verifier) {
    const submitted = await claimPlan(
      plan,
      {
        status: "submitted",
        verifier_hr_id: directory.byKey.get(canonicalHrIdKey(verifier.hrId) ?? "")?.hrId ?? verifier.hrId,
        submitted_at: new Date().toISOString(),
        decided_at: null,
        decided_by: null,
        decision_note: null,
      },
      ["draft", "returned"],
    );
    await recordPlanEvent(plan.id, "submitted", access.hrId, submitted.revision, {
      doctors: wanted.length,
      verifierHrId: verifier.hrId,
    });
    return { planId: submitted.id, status: submitted.status, revision: submitted.revision };
  }

  return { planId: plan.id, status: plan.status, revision: plan.revision };
}

// ── The manager's reviews ───────────────────────────────────────────────────────────────────────

export async function listMyNativePlanReviews(access: AccessContext): Promise<NativePlanReviewRow[]> {
  await assertPermission(access, "crm_visit_entry", "approve");
  if (!access.hrId) return [];
  const cairoToday = cairoTodayIso();
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_PLANS_TABLE)
    .select(PLAN_COLUMNS)
    .in("verifier_hr_id", hrIdLookupKeys(access.hrId))
    .gte("week_end", addDaysIso(cairoToday, -HISTORY_DAYS))
    .order("week_start", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  const [scope, directory] = await Promise.all([getDoctorCoverageScope(access), loadDirectory()]);
  // Scope runs downward only: a plan for a rep outside this viewer's reach is not shown at all.
  const plans = ((data ?? []) as Array<Record<string, unknown>>)
    .map(toPlanRow)
    .filter((plan) => isAgentInScope(scope, plan.hrId));
  if (plans.length === 0) return [];

  const hrIds = Array.from(new Set(plans.map((plan) => plan.hrId)));
  const from = plans.reduce((min, plan) => (plan.weekStart < min ? plan.weekStart : min), plans[0].weekStart);
  const to = plans.reduce((max, plan) => (plan.weekEnd > max ? plan.weekEnd : max), plans[0].weekEnd);
  const [items, visited, doubleVisits] = await Promise.all([
    loadItems(plans.map((plan) => plan.id)),
    loadVisitedKeys(hrIds, from, to),
    loadDoubleVisits(hrIds, from, to),
  ]);

  return plans
    .map((plan): NativePlanReviewRow => {
      const repKey = canonicalHrIdKey(plan.hrId) ?? "";
      const rep = directory.byKey.get(repKey);
      return {
        planId: plan.id,
        repName: employeeName(rep),
        repJobTitle: rep?.jobTitle ?? null,
        areaName: plan.areaName ?? rep?.areaName ?? null,
        weekStart: plan.weekStart,
        weekEnd: plan.weekEnd,
        status: plan.status,
        revision: plan.revision,
        submittedAt: plan.submittedAt,
        decidedAt: plan.decidedAt,
        decisionNote: plan.decisionNote,
        canDecide: plan.status === "submitted",
        days: buildDays(plan.weekStart, [], doubleVisits, repKey),
        items: itemViews(items.get(plan.id) ?? [], visited.get(repKey), cairoToday),
      };
    })
    .sort((left, right) => Number(right.canDecide) - Number(left.canDecide) || right.weekStart.localeCompare(left.weekStart));
}

export async function decideNativePlan(
  access: AccessContext,
  input: { planId: unknown; decision: unknown; note: unknown; revision: unknown },
): Promise<NativePlanSaveResult> {
  await assertPermission(access, "crm_visit_entry", "approve");
  const planId = String(input.planId ?? "").trim();
  const decision = parseNativePlanDecision(input.decision);
  const note = String(input.note ?? "").trim().slice(0, NATIVE_PLAN_NOTE_MAX) || null;
  const revision = Number(input.revision);
  if (!planId) throw validationError("Choose the plan to answer.");
  if (!decision) throw validationError("Verify the plan, or return it with a note.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(CRM_NATIVE_PLANS_TABLE).select(PLAN_COLUMNS).eq("id", planId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That plan was not found.");
  const plan = toPlanRow(data as Record<string, unknown>);

  const scope = await getDoctorCoverageScope(access);
  const refusal = nativePlanDecisionRefusal({
    verifierHrId: plan.verifierHrId,
    viewerHrId: access.hrId,
    status: plan.status,
    repInViewerScope: isAgentInScope(scope, plan.hrId),
    decision,
    note,
  });
  if (refusal) throw forbiddenError(`Forbidden: ${refusal}`);
  if (plan.revision !== revision) {
    throw conflictError("The rep changed this plan since you opened it. Reload to see the latest version.");
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from(CRM_NATIVE_PLANS_TABLE)
    .update({
      status: decision,
      decided_at: now,
      // The stored verifier id itself — the database refuses a decision recorded as anyone else.
      decided_by: plan.verifierHrId,
      decision_note: note,
      revision: plan.revision + 1,
      updated_at: now,
    })
    .eq("id", plan.id)
    .eq("status", "submitted")
    .eq("revision", plan.revision)
    .select(PLAN_COLUMNS);
  if (updateError) throw updateError;
  const rows = (updated ?? []) as Array<Record<string, unknown>>;
  if (rows.length !== 1) throw conflictError("This plan has already been answered or changed. Reload to see the latest version.");

  const decided = toPlanRow(rows[0]);
  await recordPlanEvent(plan.id, decision, access.hrId, decided.revision, { note });
  return { planId: decided.id, status: decided.status, revision: decided.revision };
}

// ── What My Visits offers ───────────────────────────────────────────────────────────────────────

/** Never throws — the My Visits page must render without it. */
export async function getNativePlanAvailability(access: AccessContext): Promise<NativePlanAvailability> {
  const none: NativePlanAvailability = { canPlan: false, canReview: false, pendingReviews: 0, pilotOnly: true };
  try {
    const [mayCreate, mayApprove] = await Promise.all([
      canAccess(access, "crm_visit_entry", "create"),
      canAccess(access, "crm_visit_entry", "approve"),
    ]);
    if (!mayCreate && !mayApprove) return none;
    const cairoToday = cairoTodayIso();

    let canPlan = false;
    let pilotOnly = true;
    // A district manager holds create only for his rare single visits: he files no weekly plan.
    if (mayCreate && !mayApprove) {
      const [directory, roster] = await Promise.all([loadDirectory(), loadPilotRoster()]);
      const key = canonicalHrIdKey(access.hrId);
      const rep = key ? directory.byKey.get(key) : undefined;
      if (rep && isActiveDirectoryEmployee(rep)) {
        const gate = await loadEntryGate(rep, roster);
        canPlan = nativePlanOpenWeeks(gate, cairoToday).length > 0;
        // Once a cutover date is set, planning here is for everyone, not a pilot.
        pilotOnly = gate.cutoverDate == null;
      }
    }

    let canReview = false;
    let pendingReviews = 0;
    if (mayApprove && access.hrId) {
      const supabase = getSupabaseAdmin();
      const keys = hrIdLookupKeys(access.hrId);
      const [pending, recent] = await Promise.all([
        supabase.from(CRM_NATIVE_PLANS_TABLE).select("id", { count: "exact", head: true }).in("verifier_hr_id", keys).eq("status", "submitted"),
        supabase
          .from(CRM_NATIVE_PLANS_TABLE)
          .select("id", { count: "exact", head: true })
          .in("verifier_hr_id", keys)
          .gte("week_end", addDaysIso(cairoToday, -HISTORY_DAYS)),
      ]);
      if (!pending.error) pendingReviews = pending.count ?? 0;
      if (!recent.error) canReview = (recent.count ?? 0) > 0;
    }

    return { canPlan, canReview, pendingReviews, pilotOnly };
  } catch {
    return none;
  }
}
