/**
 * Working on an approved vacation day — the server service (CRM phase 6, rule 9).
 *
 * From the CRM cutover date a rep cannot save a visit on a day HR approved as his vacation unless he
 * asked and BOTH his manager and HR approved (owner, 2026-09-13). Dormant while the cutover date is
 * null: the visit check returns before it reads a vacation, and the pages say the rule is not in force.
 *
 * WHO. The rep is the session's own person. The manager is the rep's nearest active manager when he
 * asked, stored on the request; only that person answers as manager, and only for a rep beneath him.
 * The HR approval is the administrator's alone (owner, 2026-09-13: "only administrator"). Nobody
 * answers their own request, one person is never both approvals, and nothing here answers for anyone.
 *
 * WHAT IT NEVER TOUCHES. The approved vacation stays approved: no vacation request, balance,
 * attendance row, deduction or pay is edited. The pure rules are vacation-day-rules.ts.
 */

import { assertPermission, canAccess, type AccessContext } from "@/lib/auth/permissions";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { getApprovedLeaveDayMap } from "@/lib/attendance/working-days";
import { getCrmCutoverSetting, isOnOrAfterCrmCutover } from "@/lib/crm/cutover";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { isAgentInScope } from "@/lib/crm/doctor-coverage-roles";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  employeeName,
  isMissingTable,
  isUniqueViolation,
  loadDirectory,
  managementChain,
  requireActiveSelf,
  type Directory,
} from "@/lib/crm/native-visits/server-shared";
import {
  CRM_NATIVE_VISIT_VACATION_DAY_REQUEST_EVENTS_TABLE,
  CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE,
} from "@/lib/crm/native-visits/tables";
import type {
  NativeVacationDayAvailability,
  NativeVacationDayRequestRow,
  NativeVacationDayView,
} from "@/lib/crm/native-visits/types";
import {
  VACATION_DAY_NOTE_MAX,
  isVacationDayHrDecider,
  parseVacationDayDecision,
  parseVacationDayDeciderRole,
  vacationDayDecisionRefusal,
  vacationDayRequestRefusal,
  vacationDayRequestStatus,
  type VacationDayDecision,
  type VacationDayDeciderRole,
  type VacationDayRequestState,
  type VacationDayRequestStatus,
} from "@/lib/crm/native-visits/vacation-day-rules";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** How far back the page lists requests. */
const HISTORY_DAYS = 30;
const COLUMNS =
  "id,hr_id,visit_date,reason,manager_hr_id,manager_decision,manager_decided_at,manager_note,hr_decision,hr_decided_by,hr_decided_at,hr_note,cancelled_at,created_at";

type RequestRecord = {
  id: string;
  hrId: string;
  visitDate: string;
  reason: string;
  managerHrId: string;
  managerDecision: VacationDayDecision;
  managerDecidedAt: string | null;
  managerNote: string | null;
  hrDecision: VacationDayDecision;
  hrDecidedBy: string | null;
  hrDecidedAt: string | null;
  hrNote: string | null;
  cancelledAt: string | null;
  createdAt: string;
};

type VacationDayViewer = { canRequest: boolean; canDecideAsManager: boolean; canDecideAsHr: boolean };

function text(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function decisionOf(value: unknown): VacationDayDecision {
  return value === "approved" || value === "rejected" ? value : "pending";
}

function toRecord(row: Record<string, unknown>): RequestRecord {
  return {
    id: String(row.id),
    hrId: String(row.hr_id ?? ""),
    visitDate: String(row.visit_date ?? "").slice(0, 10),
    reason: String(row.reason ?? ""),
    managerHrId: String(row.manager_hr_id ?? ""),
    managerDecision: decisionOf(row.manager_decision),
    managerDecidedAt: text(row.manager_decided_at),
    managerNote: text(row.manager_note),
    hrDecision: decisionOf(row.hr_decision),
    hrDecidedBy: text(row.hr_decided_by),
    hrDecidedAt: text(row.hr_decided_at),
    hrNote: text(row.hr_note),
    cancelledAt: text(row.cancelled_at),
    createdAt: String(row.created_at ?? ""),
  };
}

function stateOf(record: RequestRecord): VacationDayRequestState {
  return { managerDecision: record.managerDecision, hrDecision: record.hrDecision, cancelledAt: record.cancelledAt };
}

// ── Access ──────────────────────────────────────────────────────────────────────────────────────

async function viewerCapabilities(access: AccessContext): Promise<VacationDayViewer> {
  const [mayCreate, mayApprove, mayApproveLeave] = await Promise.all([
    canAccess(access, "crm_visit_entry", "create"),
    canAccess(access, "crm_visit_entry", "approve"),
    canAccess(access, "leave", "approve"),
  ]);
  return {
    canRequest: mayCreate,
    canDecideAsManager: mayApprove,
    canDecideAsHr: isVacationDayHrDecider(access.role) && mayApproveLeave,
  };
}

/** Refuses a viewer who can neither ask nor answer. */
export async function assertVacationDayAccess(access: AccessContext): Promise<VacationDayViewer> {
  const viewer = await viewerCapabilities(access);
  if (!viewer.canRequest && !viewer.canDecideAsManager && !viewer.canDecideAsHr) {
    throw forbiddenError("Forbidden: you cannot send or answer vacation-day requests.");
  }
  return viewer;
}

async function ruleInForce(): Promise<boolean> {
  return (await getCrmCutoverSetting()).cutoverDate != null;
}

// ── Loading ─────────────────────────────────────────────────────────────────────────────────────

async function isApprovedVacationDay(hrId: string, visitDate: string): Promise<boolean> {
  const leave = await getApprovedLeaveDayMap({ dateFromIso: visitDate, dateToIso: visitDate, employeeHrIds: [hrId] });
  const key = normalizeAttendanceHrId(hrId);
  return Boolean(key && leave.get(key)?.has(visitDate));
}

async function loadRequest(requestId: string): Promise<RequestRecord> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE)
    .select(COLUMNS)
    .eq("id", requestId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw notFoundError("That request was not found.");
    throw error;
  }
  if (!data) throw notFoundError("That request was not found.");
  return toRecord(data as Record<string, unknown>);
}


async function fetchRequests(filter: "mine" | "manager" | "hr", hrId: string, since: string): Promise<RequestRecord[]> {
  // A fresh query per page: a PostgREST builder is used up once it is awaited.
  const filtered = () => {
    const base = getSupabaseAdmin().from(CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE).select(COLUMNS).gte("visit_date", since);
    return filter === "mine"
      ? base.in("hr_id", hrIdLookupKeys(hrId))
      : filter === "manager"
        ? base.in("manager_hr_id", hrIdLookupKeys(hrId))
        : base;
  };
  // Paged to the last request (newest day first, the id as the tie-break), never a fixed page of 200.
  let data: Array<Record<string, unknown>>;
  try {
    data = await fetchAllRows<Record<string, unknown>>(() => filtered().order("visit_date", { ascending: false }), "id");
  } catch (error) {
    if (isMissingTable(error as { code?: string | null })) return [];
    throw error;
  }
  return data.map(toRecord);
}

async function recordEvent(requestId: string, event: string, actorHrId: string | null, detail: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISIT_VACATION_DAY_REQUEST_EVENTS_TABLE)
    .insert({ request_id: requestId, event, actor_hr_id: hrIdForStorage(actorHrId), detail });
  if (error) throw error;
}

function personName(directory: Directory, hrId: string | null): string {
  return employeeName(directory.byKey.get(canonicalHrIdKey(hrId) ?? ""));
}

function toRow(
  record: RequestRecord,
  directory: Directory,
  decideAs: VacationDayDeciderRole | null,
  canCancel: boolean,
): NativeVacationDayRequestRow {
  return {
    id: record.id,
    repName: personName(directory, record.hrId),
    visitDate: record.visitDate,
    reason: record.reason,
    status: vacationDayRequestStatus(stateOf(record)),
    managerName: personName(directory, record.managerHrId),
    managerDecision: record.managerDecision,
    managerNote: record.managerNote,
    managerDecidedAt: record.managerDecidedAt,
    hrDecision: record.hrDecision,
    hrDeciderName: record.hrDecidedBy ? personName(directory, record.hrDecidedBy) : null,
    hrNote: record.hrNote,
    hrDecidedAt: record.hrDecidedAt,
    createdAt: record.createdAt,
    decideAs,
    canCancel,
  };
}

// ── Availability (the links) ────────────────────────────────────────────────────────────────────

/** Whether to link the requests page, and how many wait for this viewer. Never throws; hidden before cutover. */
export async function getVacationDayRequestAvailability(access: AccessContext): Promise<NativeVacationDayAvailability> {
  const none: NativeVacationDayAvailability = { show: false, waitingForYou: 0 };
  try {
    const viewer = await viewerCapabilities(access);
    if (!viewer.canRequest && !viewer.canDecideAsManager && !viewer.canDecideAsHr) return none;
    if (!(await ruleInForce())) return none;

    const supabase = getSupabaseAdmin();
    let waitingForYou = 0;
    if (viewer.canDecideAsManager && access.hrId) {
      const { count, error } = await supabase
        .from(CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE)
        .select("id", { count: "exact", head: true })
        .in("manager_hr_id", hrIdLookupKeys(access.hrId))
        .eq("manager_decision", "pending")
        .neq("hr_decision", "rejected")
        .is("cancelled_at", null);
      if (!error) waitingForYou += count ?? 0;
    }
    if (viewer.canDecideAsHr) {
      const { count, error } = await supabase
        .from(CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("hr_decision", "pending")
        .neq("manager_decision", "rejected")
        .is("cancelled_at", null);
      if (!error) waitingForYou += count ?? 0;
    }
    return { show: true, waitingForYou };
  } catch {
    return none;
  }
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────

export async function listVacationDayRequests(access: AccessContext): Promise<NativeVacationDayView> {
  const viewer = await assertVacationDayAccess(access);
  const view: NativeVacationDayView = { ruleInForce: await ruleInForce(), ...viewer, mine: [], toDecide: [] };
  if (!view.ruleInForce || !access.hrId) return view;

  const since = addDaysIso(cairoTodayIso(), -HISTORY_DAYS);
  const viewerKey = canonicalHrIdKey(access.hrId);
  const [directory, scope, mine, managed, hrQueue] = await Promise.all([
    loadDirectory(),
    viewer.canDecideAsManager ? getDoctorCoverageScope(access) : Promise.resolve(null),
    viewer.canRequest ? fetchRequests("mine", access.hrId, since) : Promise.resolve([]),
    viewer.canDecideAsManager ? fetchRequests("manager", access.hrId, since) : Promise.resolve([]),
    viewer.canDecideAsHr ? fetchRequests("hr", access.hrId, since) : Promise.resolve([]),
  ]);

  const decideAsFor = (record: RequestRecord): VacationDayDeciderRole | null => {
    const base = {
      viewerHrKey: viewerKey,
      repHrKey: canonicalHrIdKey(record.hrId) ?? "",
      managerHrKey: canonicalHrIdKey(record.managerHrId) ?? "",
      state: stateOf(record),
      isHrAuthority: viewer.canDecideAsHr,
      repInViewerScope: scope ? isAgentInScope(scope, record.hrId) : false,
      decision: "approved" as const,
      note: null,
    };
    if (viewer.canDecideAsManager && !vacationDayDecisionRefusal({ ...base, as: "manager" })) return "manager";
    if (viewer.canDecideAsHr && !vacationDayDecisionRefusal({ ...base, as: "hr" })) return "hr";
    return null;
  };

  const toDecide = new Map<string, RequestRecord>();
  for (const record of [...managed.filter((row) => scope && isAgentInScope(scope, row.hrId)), ...hrQueue]) {
    if (canonicalHrIdKey(record.hrId) !== viewerKey) toDecide.set(record.id, record);
  }

  const cancellable: VacationDayRequestStatus[] = ["waiting", "approved"];
  view.mine = mine.map((record) =>
    toRow(record, directory, null, cancellable.includes(vacationDayRequestStatus(stateOf(record)))),
  );
  view.toDecide = Array.from(toDecide.values()).map((record) => toRow(record, directory, decideAsFor(record), false));
  return view;
}

// ── Ask ─────────────────────────────────────────────────────────────────────────────────────────

export async function requestVacationDayWork(
  access: AccessContext,
  input: { visitDate: unknown; reason: unknown },
): Promise<{ requestId: string }> {
  await assertPermission(access, "crm_visit_entry", "create");
  const visitDate = String(input.visitDate ?? "").trim();
  const reason = String(input.reason ?? "").trim();
  const refusal = vacationDayRequestRefusal({ visitDate, reason, cairoToday: cairoTodayIso() });
  if (refusal) throw validationError(refusal);
  if (!isOnOrAfterCrmCutover(await getCrmCutoverSetting(), visitDate)) {
    throw validationError("That day needs no request: Phoenix is not the visit record for it yet.");
  }

  const directory = await loadDirectory();
  const rep = requireActiveSelf(access, directory);
  if (!(await isApprovedVacationDay(rep.hrId, visitDate))) {
    throw validationError("That day is not an approved vacation day for you, so you can enter visits on it without asking.");
  }
  const manager = managementChain(rep, directory)[0];
  if (!manager) {
    throw validationError("You have no active manager on record to send this to. Ask HR to correct your manager.");
  }
  const managerHrId = directory.byKey.get(canonicalHrIdKey(manager.hrId) ?? "")?.hrId ?? manager.hrId;

  // Both decisions start pending by the table's own default. Only the deciders' clicks move them.
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE)
    .insert({ hr_id: rep.hrId, visit_date: visitDate, reason, line_name: rep.lineName, manager_hr_id: managerHrId })
    .select("id")
    .single();
  if (error) {
    if (isUniqueViolation(error)) throw conflictError("You already have a request for that day that is waiting or approved.");
    throw error;
  }
  const requestId = String((data as Record<string, unknown>).id);
  await recordEvent(requestId, "requested", access.hrId, { visitDate, managerHrId });
  return { requestId };
}

// ── Answer ──────────────────────────────────────────────────────────────────────────────────────

export async function decideVacationDayRequest(
  access: AccessContext,
  input: { requestId: unknown; as: unknown; decision: unknown; note: unknown },
): Promise<{ requestId: string; status: VacationDayRequestStatus }> {
  const as = parseVacationDayDeciderRole(input.as);
  if (!as) throw validationError("Answer as the manager or as HR.");
  if (as === "manager") {
    await assertPermission(access, "crm_visit_entry", "approve");
  } else {
    await assertPermission(access, "leave", "approve");
  }
  const decision = parseVacationDayDecision(input.decision);
  if (!decision) throw validationError("Answer approve or refuse.");
  const requestId = String(input.requestId ?? "").trim();
  if (!isUuid(requestId)) throw validationError("Choose the request to answer.");
  const note = String(input.note ?? "").trim() || null;
  if (note && note.length > VACATION_DAY_NOTE_MAX) throw validationError(`Keep the note under ${VACATION_DAY_NOTE_MAX} characters.`);

  const record = await loadRequest(requestId);
  const scope = as === "manager" ? await getDoctorCoverageScope(access) : null;
  const refusal = vacationDayDecisionRefusal({
    as,
    viewerHrKey: canonicalHrIdKey(access.hrId),
    repHrKey: canonicalHrIdKey(record.hrId) ?? "",
    managerHrKey: canonicalHrIdKey(record.managerHrId) ?? "",
    state: stateOf(record),
    isHrAuthority: isVacationDayHrDecider(access.role),
    repInViewerScope: scope ? isAgentInScope(scope, record.hrId) : false,
    decision,
    note,
  });
  if (refusal) throw forbiddenError(`Forbidden: ${refusal}`);

  const now = new Date().toISOString();
  let changes: Record<string, unknown>;
  if (as === "manager") {
    // The stored manager id itself — the database refuses a manager decision by anyone else.
    changes = { manager_decision: decision, manager_decided_by: record.managerHrId, manager_decided_at: now, manager_note: note };
  } else {
    const directory = await loadDirectory();
    const deciderHrId = directory.byKey.get(canonicalHrIdKey(access.hrId) ?? "")?.hrId ?? hrIdForStorage(access.hrId);
    changes = { hr_decision: decision, hr_decided_by: deciderHrId, hr_decided_at: now, hr_note: note };
  }
  const pendingColumn = as === "manager" ? "manager_decision" : "hr_decision";
  const { data: updated, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE)
    .update({ ...changes, updated_at: now })
    .eq("id", requestId)
    .eq(pendingColumn, "pending")
    .is("cancelled_at", null)
    .select("id");
  if (error) throw error;
  if (!updated || (updated as unknown[]).length !== 1) {
    throw conflictError("This request has already been answered or withdrawn.");
  }

  await recordEvent(requestId, `${as}_${decision}`, access.hrId, { note });
  return { requestId, status: vacationDayRequestStatus(stateOf(await loadRequest(requestId))) };
}

// ── Withdraw ────────────────────────────────────────────────────────────────────────────────────

export async function cancelVacationDayRequest(
  access: AccessContext,
  input: { requestId: unknown },
): Promise<{ requestId: string }> {
  await assertPermission(access, "crm_visit_entry", "create");
  const requestId = String(input.requestId ?? "").trim();
  if (!isUuid(requestId)) throw validationError("Choose the request to withdraw.");

  const directory = await loadDirectory();
  const rep = requireActiveSelf(access, directory);
  const record = await loadRequest(requestId);
  // Someone else's request is simply not found, so its existence is not disclosed.
  if (canonicalHrIdKey(record.hrId) !== canonicalHrIdKey(rep.hrId)) throw notFoundError("That request was not found.");
  const status = vacationDayRequestStatus(stateOf(record));
  if (status === "cancelled") throw conflictError("You already withdrew this request.");
  if (status === "rejected") throw conflictError("This request was refused, so there is nothing to withdraw.");

  const now = new Date().toISOString();
  const { data: updated, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISIT_VACATION_DAY_REQUESTS_TABLE)
    .update({ cancelled_at: now, updated_at: now })
    .eq("id", requestId)
    .is("cancelled_at", null)
    .select("id");
  if (error) throw error;
  if (!updated || (updated as unknown[]).length !== 1) throw conflictError("You already withdrew this request.");

  await recordEvent(requestId, "cancelled", access.hrId, {});
  return { requestId };
}
