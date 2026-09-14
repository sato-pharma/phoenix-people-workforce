/**
 * Native visits — the server service (CRM phase 3, the pilot).
 *
 * THE ONLY CODE THAT TOUCHES THE NATIVE TABLES, with plans-service.ts beside it. Until the cutover
 * nothing else may read them: every report, KPI, deduction, probation count and payroll input keeps
 * reading the iReports360 mirror, and the pilot line keeps entering there too, so a native row read
 * anywhere else double-counts. tests/crm-native-visits.test.ts fails if another file references the
 * table constants.
 *
 * WHO. The rep is the session's own person, looked up in the employee directory — never a field of the
 * request. The one exception is the Super Admin's entry FOR a rep (crm_visit_entry `update`, the owner,
 * 2026-09-14): he names an active medical rep in his scope, the visit is saved with no location, its
 * created event records him as the actor, and the rep is told in-app. A partner decides only a row
 * naming HIM, and only for a rep beneath him (scope runs downward only). Nothing here confirms a visit
 * on anyone's behalf.
 *
 * WHEN. Only today or yesterday (Cairo), and only on an open day: before the CRM cutover a pilot day of
 * the rep's own line; from the cutover date on, every day, for every rep of every line at once. The
 * Super Admin's entry takes any open day up to today.
 */

import { assertPermission, canAccess, type AccessContext } from "@/lib/auth/permissions";
import { getCrmCutoverSetting, isOnOrAfterCrmCutover } from "@/lib/crm/cutover";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { isAgentInScope } from "@/lib/crm/doctor-coverage-roles";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  NATIVE_VISIT_DELETE_REASON_MAX,
  NATIVE_VISIT_TYPES,
  isNativeEntryDay,
  isNativeEntryOffered,
  isNativeVisitRepTitle,
  isOnOrAfterNativeCutover,
  nativeDayLabel,
  nativePartnerDecisionRefusal,
  nativeVisitDeleteRefusal,
  nativeVisitEntryDays,
  nativeVisitManagerSinglePartnerRefusal,
  nativeVisitOnBehalfDays,
  nativeVisitPartnerRefusal,
  nativeVisitPilotForLine,
  nativeVisitPlannedContactIds,
  nativeVisitPlanRefusal,
  nativeVisitShiftRefusal,
  nativeVisitType,
  nativeVisitTypeLabel,
  parseNativePartnerDecision,
  parseNativeVisitDraft,
  type NativePartnerStatus,
  type NativeVisitGpsStatus,
  type NativeVisitShift,
  type NativeVisitTypeKey,
} from "@/lib/crm/native-visits/rules";
import {
  chunk,
  employeeName,
  isMissingTable,
  isUniqueViolation,
  loadDirectory,
  loadEntryGate,
  loadPilots,
  loadRepContacts,
  loadTeamContacts,
  managementChain,
  requireActiveSelf,
  type Directory,
} from "@/lib/crm/native-visits/server-shared";
import {
  CRM_NATIVE_PLAN_ITEMS_TABLE,
  CRM_NATIVE_PLANS_TABLE,
  CRM_NATIVE_VISIT_EVENTS_TABLE,
  CRM_NATIVE_VISIT_PARTNERS_TABLE,
  CRM_NATIVE_VISITS_TABLE,
} from "@/lib/crm/native-visits/tables";
import type {
  NativeVisitAdminRow,
  NativeVisitAdminView,
  NativeVisitConfirmationRow,
  NativeVisitContactOption,
  NativeVisitEntryAvailability,
  NativeVisitFormOptions,
  NativeVisitPartnerView,
  NativeVisitRepOption,
  NativeVisitRow,
  NativeVisitSaveResult,
} from "@/lib/crm/native-visits/types";
import { vacationDayWorkRefusalForRep } from "@/lib/crm/native-visits/vacation-days";
import { isActiveDirectoryEmployee, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** How far back "my visits" and "my confirmations" look. The pilot is one week. */
const HISTORY_DAYS = 14;
/** The widest span of days the Super Admin's all-reps list reads at once, and the most rows it shows. */
const ADMIN_RANGE_DAYS = 62;
const ADMIN_LIST_LIMIT = 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ── Loading ─────────────────────────────────────────────────────────────────────────────────────

async function loadAppRole(hrId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("role")
    .in("hr_id", hrIdLookupKeys(hrId))
    .eq("is_active", true)
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  return row?.role ? String(row.role) : null;
}

async function loadSeatId(hrId: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("au_v_org_tree")
    .select("seat_id")
    .in("occupant_hr_id", hrIdLookupKeys(hrId))
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  return row?.seat_id ? String(row.seat_id) : null;
}

/**
 * The rep's own live plan item for this doctor on this day, if the rep planned one (phase 4), with the
 * status of the week plan holding it. Before the plan tables exist there is simply no item.
 */
async function findPlanItem(
  hrId: string,
  contactCrmId: number,
  visitDate: string,
): Promise<{ id: string; planStatus: string } | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_NATIVE_PLAN_ITEMS_TABLE)
    .select("id,plan_id")
    .in("hr_id", hrIdLookupKeys(hrId))
    .eq("contact_crm_id", contactCrmId)
    .eq("plan_date", visitDate)
    .is("removed_at", null)
    .limit(1);
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  if (!row?.id) return null;
  const { data: plan, error: planError } = await supabase
    .from(CRM_NATIVE_PLANS_TABLE)
    .select("status")
    .eq("id", String(row.plan_id))
    .maybeSingle();
  if (planError) throw planError;
  return { id: String(row.id), planStatus: String((plan as Record<string, unknown> | null)?.status ?? "") };
}

/**
 * A district manager's entry is his rare single visit without the rep (the owner, 2026-09-14): he holds
 * create beside approve, and approve is what marks him. A rep never holds approve.
 */
async function isManagerSingleEntry(access: AccessContext): Promise<boolean> {
  return canAccess(access, "crm_visit_entry", "approve");
}

/** The doctors this entry may name: a rep's own lists, or the union of a district manager's reps' lists. */
function loadEntryContacts(managerSingle: boolean, rep: EmployeeDirectoryRow, directory: Directory) {
  return managerSingle ? loadTeamContacts(rep, directory) : loadRepContacts(rep);
}

/**
 * For each open day the plan rule reaches (on or after the cutover date), the doctors planned that day
 * in a verified week plan. Null when the rule reaches none of the days, so the form filters nothing.
 */
async function loadPlannedContactIdsByDay(
  hrId: string,
  openDays: readonly string[],
  cutoverDate: string | null,
): Promise<Record<string, number[]> | null> {
  const ruleDays = cutoverDate ? openDays.filter((day) => day >= cutoverDate) : [];
  if (ruleDays.length === 0) return null;
  const out: Record<string, number[]> = Object.fromEntries(ruleDays.map((day) => [day, [] as number[]]));

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_NATIVE_PLAN_ITEMS_TABLE)
    .select("contact_crm_id,plan_date,plan_id")
    .in("hr_id", hrIdLookupKeys(hrId))
    .in("plan_date", ruleDays)
    .is("removed_at", null);
  if (error) {
    if (isMissingTable(error)) return out;
    throw error;
  }
  const items = (data ?? []) as Array<Record<string, unknown>>;
  const planIds = Array.from(new Set(items.map((row) => String(row.plan_id))));
  const statusByPlan = new Map<string, string>();
  for (const ids of chunk(planIds)) {
    const { data: plans, error: planError } = await supabase.from(CRM_NATIVE_PLANS_TABLE).select("id,status").in("id", ids);
    if (planError) throw planError;
    for (const plan of (plans ?? []) as Array<Record<string, unknown>>) statusByPlan.set(String(plan.id), String(plan.status ?? ""));
  }
  const planned = items.map((row) => ({
    contactCrmId: Number(row.contact_crm_id),
    planDate: String(row.plan_date),
    planStatus: statusByPlan.get(String(row.plan_id)) ?? "",
  }));
  for (const day of ruleDays) out[day] = nativeVisitPlannedContactIds(planned, day);
  return out;
}

async function recordEvent(visitId: string, event: string, actorHrId: string | null, detail: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISIT_EVENTS_TABLE)
    .insert({ visit_id: visitId, event, actor_hr_id: hrIdForStorage(actorHrId), detail });
  if (error) throw error;
}

function repOption(row: EmployeeDirectoryRow): NativeVisitRepOption {
  return {
    hrId: row.hrId,
    name: employeeName(row),
    detail: [row.jobTitle, row.lineName, row.areaName].filter(Boolean).join(" · "),
  };
}

/**
 * The rep the Super Admin names for his entry: an active medical rep inside his scope. The only place
 * a rep comes from the request, and only behind crm_visit_entry `update`.
 */
async function requireRepForOnBehalfEntry(
  access: AccessContext,
  directory: Directory,
  repHrId: unknown,
): Promise<EmployeeDirectoryRow> {
  const key = canonicalHrIdKey(String(repHrId ?? "").trim());
  const row = key ? directory.byKey.get(key) : undefined;
  if (!row || !isActiveDirectoryEmployee(row) || !isNativeVisitRepTitle(row.jobTitle)) {
    throw validationError("Choose an active medical rep.");
  }
  if (key === canonicalHrIdKey(access.hrId)) throw forbiddenError("Forbidden: a visit is entered here for a rep, never for yourself.");
  const scope = await getDoctorCoverageScope(access);
  if (!isAgentInScope(scope, row.hrId)) throw forbiddenError("Forbidden: that rep is outside your scope.");
  return row;
}

/**
 * For each visit, the person who entered it FOR the rep, when someone did: the created event's actor
 * differs from the rep, or the event says so. Absent for a visit the rep entered himself.
 */
async function loadOnBehalfActors(rows: ReadonlyArray<Record<string, unknown>>): Promise<Map<string, string>> {
  const repByVisit = new Map(rows.map((row) => [String(row.id), canonicalHrIdKey(String(row.hr_id))]));
  const out = new Map<string, string>();
  for (const ids of chunk(Array.from(repByVisit.keys()))) {
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_NATIVE_VISIT_EVENTS_TABLE)
      .select("visit_id,actor_hr_id,detail")
      .eq("event", "created")
      .in("visit_id", ids);
    if (error) {
      if (isMissingTable(error)) return out;
      throw error;
    }
    for (const event of (data ?? []) as Array<Record<string, unknown>>) {
      const visitId = String(event.visit_id);
      const actor = event.actor_hr_id ? String(event.actor_hr_id) : "";
      const detail = (event.detail ?? {}) as Record<string, unknown>;
      const actorIsSomeoneElse = actor !== "" && canonicalHrIdKey(actor) !== repByVisit.get(visitId);
      if (detail.enteredOnBehalf === true || actorIsSomeoneElse) out.set(visitId, actor);
    }
  }
  return out;
}

/** Tells the rep in-app that the Super Admin entered a visit for him. Never email. Never throws. */
async function notifyRepOfOnBehalfVisit(input: {
  visitId: string;
  rep: EmployeeDirectoryRow;
  enteredBy: string;
  enteredByHrId: string | null;
  visitDate: string;
  shift: NativeVisitShift;
  typeLabel: string;
  doctor: string | null;
}): Promise<void> {
  const what = [nativeDayLabel(input.visitDate), input.shift, input.typeLabel, input.doctor].filter(Boolean).join(" · ");
  try {
    await createSystemNotification({
      actionUrl: "/employee-portals/visits/log",
      ...(input.enteredByHrId ? { actorId: input.enteredByHrId } : {}),
      category: "general",
      channels: ["in_app"],
      eventType: "native_visit_entered_for_rep",
      metadata: {
        idempotencyKey: `crm_native_visit_entered_for_rep:${input.visitId}`,
        visitId: input.visitId,
      },
      message: `${input.enteredBy} (Super Admin) entered a visit for you: ${what}. It is saved with no location and marked as entered by the Super Admin.`,
      module: "crm",
      priority: "normal",
      recipientHrId: input.rep.hrId,
      ...(input.enteredByHrId ? { subjectHrId: input.enteredByHrId } : {}),
      title: "A visit was entered for you",
    });
  } catch {
    // The visit is saved; a notice that could not be sent must not undo it.
  }
}

// ── Form options ────────────────────────────────────────────────────────────────────────────────

export async function getNativeVisitFormOptions(
  access: AccessContext,
  onBehalf?: { repHrId: unknown },
): Promise<NativeVisitFormOptions> {
  await assertPermission(access, "crm_visit_entry", onBehalf ? "update" : "create");
  const [directory, pilots, managerSingle] = await Promise.all([
    loadDirectory(),
    loadPilots(),
    onBehalf ? Promise.resolve(false) : isManagerSingleEntry(access),
  ]);
  const rep = onBehalf
    ? await requireRepForOnBehalfEntry(access, directory, onBehalf.repHrId)
    : requireActiveSelf(access, directory);
  const gate = await loadEntryGate(rep.lineName, pilots);
  const { pilot } = gate;
  const cairoToday = cairoTodayIso();
  const entryDays = nativeVisitEntryDays(cairoToday);
  const openDays = onBehalf
    ? nativeVisitOnBehalfDays(gate, cairoToday)
    : [entryDays.today, entryDays.yesterday].filter((day) => isNativeEntryDay(gate, day));
  const offered = onBehalf ? openDays.length > 0 : isNativeEntryOffered(gate, cairoToday);

  let contacts: NativeVisitContactOption[] = [];
  let plannedContactIdsByDay: Record<string, number[]> | null = null;
  if (offered) {
    [contacts, plannedContactIdsByDay] = await Promise.all([
      loadEntryContacts(managerSingle, rep, directory),
      // The Super Admin's entry takes any doctor on the rep's list, planned or not.
      managerSingle || onBehalf ? Promise.resolve(null) : loadPlannedContactIdsByDay(rep.hrId, openDays, gate.cutoverDate),
    ]);
  }

  return {
    pilot: pilot ? { lineName: pilot.lineName, startsOn: pilot.startsOn, endsOn: pilot.endsOn } : null,
    cutoverDate: gate.cutoverDate,
    phoenixIsRecord: isOnOrAfterNativeCutover(gate, cairoToday),
    entryDays,
    openDays,
    types: NATIVE_VISIT_TYPES.map((type) => ({ key: type.key, label: type.label, contact: type.contact })),
    contacts,
    // A manager's single visit names nobody accompanying him.
    partners: offered && !managerSingle ? managementChain(rep, directory) : [],
    vacationDayRuleInForce: gate.cutoverDate != null,
    entryAs: onBehalf ? "on_behalf" : managerSingle ? "manager" : "rep",
    rep: onBehalf ? repOption(rep) : null,
    plannedContactIdsByDay,
  };
}

/** What the My Visits page offers this viewer. Never throws — the page must render without it. */
export async function getNativeVisitEntryAvailability(access: AccessContext): Promise<NativeVisitEntryAvailability> {
  const none: NativeVisitEntryAvailability = { canLog: false, canConfirm: false, pendingConfirmations: 0, pilotOnly: true };
  try {
    const [mayCreate, mayApprove] = await Promise.all([
      canAccess(access, "crm_visit_entry", "create"),
      canAccess(access, "crm_visit_entry", "approve"),
    ]);
    if (!mayCreate && !mayApprove) return none;

    let canLog = false;
    let pilotOnly = true;
    if (mayCreate) {
      const [directory, pilots] = await Promise.all([loadDirectory(), loadPilots()]);
      const key = canonicalHrIdKey(access.hrId);
      const rep = key ? directory.byKey.get(key) : undefined;
      if (rep && isActiveDirectoryEmployee(rep)) {
        const gate = await loadEntryGate(rep.lineName, pilots);
        const cairoToday = cairoTodayIso();
        // Offered once a pilot row or a cutover date exists; the form says when it opens.
        canLog = isNativeEntryOffered(gate, cairoToday);
        // Once a cutover date is set, entry here is for everyone, not a pilot.
        pilotOnly = gate.cutoverDate == null;
      }
    }

    let pendingConfirmations = 0;
    if (mayApprove && access.hrId) {
      const { count, error } = await getSupabaseAdmin()
        .from(CRM_NATIVE_VISIT_PARTNERS_TABLE)
        .select("id", { count: "exact", head: true })
        .in("partner_hr_id", hrIdLookupKeys(access.hrId))
        .eq("status", "pending");
      if (!error) pendingConfirmations = count ?? 0;
    }

    return { canLog, canConfirm: mayApprove && pendingConfirmations > 0, pendingConfirmations, pilotOnly };
  } catch {
    return none;
  }
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `onBehalf`: the Super Admin enters the visit for the named rep (crm_visit_entry `update`, the owner,
 * 2026-09-14). Any open day up to today, any doctor on the rep's list with no plan rule, no location,
 * the created event names him, and the rep is told in-app.
 */
export async function createNativeVisit(
  access: AccessContext,
  raw: unknown,
  onBehalf?: { repHrId: unknown },
): Promise<NativeVisitSaveResult> {
  await assertPermission(access, "crm_visit_entry", onBehalf ? "update" : "create");
  const enteredOnBehalf = onBehalf != null;
  const supabase = getSupabaseAdmin();
  const [directory, pilots, managerSingle] = await Promise.all([
    loadDirectory(),
    loadPilots(),
    enteredOnBehalf ? Promise.resolve(false) : isManagerSingleEntry(access),
  ]);
  const rep = onBehalf
    ? await requireRepForOnBehalfEntry(access, directory, onBehalf.repHrId)
    : requireActiveSelf(access, directory);
  // The refusals speak to the rep on his own form, and about the rep on the Super Admin's.
  const you = enteredOnBehalf ? "The rep" : "You";
  const your = enteredOnBehalf ? "the rep's" : "your";

  const parsed = parseNativeVisitDraft(raw, { cairoToday: cairoTodayIso(), now: new Date(), enteredOnBehalf });
  if (!parsed.ok) throw validationError(parsed.error);
  const draft = parsed.value;

  const gate = await loadEntryGate(rep.lineName, pilots);
  const { pilot } = gate;
  if (!isNativeEntryDay(gate, draft.visitDate)) {
    throw forbiddenError(
      gate.cutoverDate
        ? `Forbidden: visits are entered in Phoenix from ${nativeDayLabel(gate.cutoverDate)}. Enter an earlier day in iReports360.`
        : "Forbidden: visit entry in Phoenix is open only to the pilot line, on the pilot days.",
    );
  }

  // A resend from the offline queue answers with the visit it already saved.
  const { data: existing, error: existingError } = await supabase
    .from(CRM_NATIVE_VISITS_TABLE)
    .select("id,hr_id,gps_status")
    .eq("client_submission_id", draft.clientSubmissionId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    const row = existing as Record<string, unknown>;
    if (canonicalHrIdKey(String(row.hr_id)) !== canonicalHrIdKey(rep.hrId)) {
      throw conflictError("This submission id belongs to another visit. Reload the form and enter it again.");
    }
    return { visitId: String(row.id), duplicate: true, gpsStatus: row.gps_status as NativeVisitGpsStatus };
  }

  const selfPartner =
    nativeVisitPartnerRefusal(rep.hrId, draft.partnerHrIds) ??
    nativeVisitManagerSinglePartnerRefusal(managerSingle, draft.partnerHrIds);
  if (selfPartner) throw validationError(selfPartner);

  // The contact must be on this rep's own open AM or PM list (a district manager's single visit: on one
  // of his reps' lists), and its list decides the half-day.
  let contact: NativeVisitContactOption | null = null;
  if (draft.contactCrmId != null) {
    const contacts = await loadEntryContacts(managerSingle, rep, directory);
    contact = contacts.find((option) => option.contactCrmId === draft.contactCrmId) ?? null;
    const shiftRefusal = nativeVisitShiftRefusal(draft, contact?.lists ?? [], your);
    if (shiftRefusal) throw validationError(shiftRefusal);
  }

  // Annual vacation and work in the same half-day contradict each other.
  const { data: sameShift, error: sameShiftError } = await supabase
    .from(CRM_NATIVE_VISITS_TABLE)
    .select("visit_type")
    .in("hr_id", hrIdLookupKeys(rep.hrId))
    .eq("visit_date", draft.visitDate)
    .eq("shift", draft.shift)
    .is("deleted_at", null);
  if (sameShiftError) throw sameShiftError;
  const sameShiftTypes = ((sameShift ?? []) as Array<Record<string, unknown>>).map((row) => String(row.visit_type));
  if (sameShiftTypes.includes("annual_vacation")) {
    throw conflictError(`${you} recorded annual vacation for ${draft.shift} on this day. Delete it first to enter work.`);
  }
  if (draft.visitType === "annual_vacation" && sameShiftTypes.length > 0) {
    throw conflictError(`${you} already entered work for ${draft.shift} on this day. Delete it first to record annual vacation.`);
  }

  // Partners: only people in the rep's own management chain, so the person confirming always has
  // this rep beneath him.
  const chain = managementChain(rep, directory);
  const partners = draft.partnerHrIds.map((partnerHrId) => {
    const option = chain.find((candidate) => canonicalHrIdKey(candidate.hrId) === canonicalHrIdKey(partnerHrId));
    if (!option) {
      throw validationError(`A person recorded as accompanying ${enteredOnBehalf ? "the rep" : "you"} must be one of ${your} managers.`);
    }
    return option;
  });

  const type = nativeVisitType(draft.visitType);
  if (!type) throw validationError("Choose what kind of visit or day this is.");

  // Rule 9 (phase 6): from the CRM cutover, a visit on an approved vacation day saves only after the
  // manager and HR both approved the rep's request. Dormant while the cutover date is null.
  const vacationRefusal = await vacationDayWorkRefusalForRep({
    hrId: rep.hrId,
    visitDate: draft.visitDate,
    contactRule: type.contact,
  });
  if (vacationRefusal) throw forbiddenError(`Forbidden: ${vacationRefusal}`);

  // The plan link: a doctor visit keeps the rep's own planned item for that doctor and day, if any.
  // Only a doctor visit keeps a plan, as in the vendor plan-vs-actual (code 0 only).
  const [seatId, partnerRoles, planItem, cutover, repAppRole] = await Promise.all([
    loadSeatId(rep.hrId),
    Promise.all(partners.map((partner) => loadAppRole(partner.hrId))),
    type.key === "regular" && draft.contactCrmId != null && !managerSingle
      ? findPlanItem(rep.hrId, draft.contactCrmId, draft.visitDate)
      : Promise.resolve(null),
    type.key === "regular" ? getCrmCutoverSetting() : Promise.resolve(null),
    // The row carries the REP's role, never the Super Admin's who typed it in.
    enteredOnBehalf ? loadAppRole(rep.hrId) : Promise.resolve(access.role),
  ]);

  // The owner, 2026-09-13: from the CRM cutover a doctor visit is a doctor on the rep's list AND
  // planned on that very day, in a week plan his manager verified. Dormant while the date is null.
  // A district manager's single visit files no plan, so the rule does not reach it (2026-09-14).
  const planRefusal = nativeVisitPlanRefusal({
    ruleActive: cutover != null && isOnOrAfterCrmCutover(cutover, draft.visitDate),
    visitTypeKey: type.key,
    planItem,
    managerSingleVisit: managerSingle,
    // The Super Admin's entry takes any doctor on the rep's list (the owner, 2026-09-14).
    enteredOnBehalf,
  });
  if (planRefusal) throw forbiddenError(`Forbidden: ${planRefusal}`);
  const planItemId = planItem?.id ?? null;

  const { data: inserted, error: insertError } = await supabase
    .from(CRM_NATIVE_VISITS_TABLE)
    .insert({
      client_submission_id: draft.clientSubmissionId,
      hr_id: rep.hrId,
      job_title: rep.jobTitle,
      // A rep with no app account yet is still a medical rep: that title is what made him eligible.
      app_role: repAppRole ?? "Medical Rep",
      line_name: rep.lineName ?? pilot?.lineName ?? "",
      area_name: rep.areaName,
      region_name: rep.regionName,
      seat_id: seatId,
      manager_hr_id: rep.managerHrId,
      visit_date: draft.visitDate,
      shift: draft.shift,
      visit_type: type.key,
      legacy_visit_type: type.legacyCode,
      contact_crm_id: draft.contactCrmId,
      contact_name: contact?.name ?? null,
      contact_speciality: contact?.speciality ?? null,
      contact_grade: contact?.grade ?? null,
      contact_list_type: contact ? draft.shift : null,
      prospect_name: draft.prospectName,
      prospect_speciality: draft.prospectSpeciality,
      latitude: draft.latitude,
      longitude: draft.longitude,
      gps_accuracy_m: draft.accuracyMeters,
      gps_address: draft.gpsAddress,
      gps_status: draft.gpsStatus,
      comment: draft.comment,
      plan_item_id: planItemId,
      device_recorded_at: draft.deviceRecordedAt,
    })
    .select("id")
    .single();
  if (insertError) {
    if (isUniqueViolation(insertError)) {
      throw conflictError(`${you} already recorded a visit to this doctor on that day.`);
    }
    throw insertError;
  }
  const visitId = String((inserted as Record<string, unknown>).id);

  try {
    if (partners.length > 0) {
      const { error: partnerError } = await supabase.from(CRM_NATIVE_VISIT_PARTNERS_TABLE).insert(
        partners.map((partner, index) => ({
          visit_id: visitId,
          partner_hr_id: directory.byKey.get(canonicalHrIdKey(partner.hrId) ?? "")?.hrId ?? partner.hrId,
          partner_name: partner.name,
          partner_job_title: partner.jobTitle,
          partner_app_role: partnerRoles[index] ?? null,
          is_direct_manager: partner.isDirectManager,
          // Every partner row starts pending. Only the partner's own click moves it.
          status: "pending",
        })),
      );
      if (partnerError) throw partnerError;
    }
    await recordEvent(visitId, "created", access.hrId, {
      gpsStatus: draft.gpsStatus,
      partners: partners.length,
      planItemId,
      visitType: type.key,
      ...(enteredOnBehalf ? { enteredOnBehalf: true } : {}),
    });
  } catch (error) {
    // Nothing references the visit yet, so undo it rather than leave a visit missing its partners.
    await supabase.from(CRM_NATIVE_VISIT_PARTNERS_TABLE).delete().eq("visit_id", visitId);
    await supabase.from(CRM_NATIVE_VISITS_TABLE).delete().eq("id", visitId);
    throw error;
  }

  if (enteredOnBehalf) {
    await notifyRepOfOnBehalfVisit({
      visitId,
      rep,
      enteredBy: employeeName(directory.byKey.get(canonicalHrIdKey(access.hrId) ?? "")),
      enteredByHrId: access.hrId,
      visitDate: draft.visitDate,
      shift: draft.shift,
      typeLabel: type.label,
      doctor: contact?.name ?? draft.prospectName,
    });
  }

  return { visitId, duplicate: false, gpsStatus: draft.gpsStatus };
}

// ── My visits ───────────────────────────────────────────────────────────────────────────────────

async function loadPartnersByVisit(visitIds: string[]): Promise<Map<string, Array<Record<string, unknown>>>> {
  const byVisit = new Map<string, Array<Record<string, unknown>>>();
  for (const ids of chunk(visitIds)) {
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_NATIVE_VISIT_PARTNERS_TABLE)
      .select("visit_id,partner_name,partner_job_title,is_direct_manager,status")
      .in("visit_id", ids);
    if (error) throw error;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = String(row.visit_id);
      byVisit.set(key, [...(byVisit.get(key) ?? []), row]);
    }
  }
  return byVisit;
}

export async function listMyNativeVisits(access: AccessContext): Promise<NativeVisitRow[]> {
  await assertPermission(access, "crm_visit_entry", "read");
  if (!access.hrId) return [];
  const cairoToday = cairoTodayIso();
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISITS_TABLE)
    .select(
      "id,hr_id,visit_date,shift,visit_type,contact_name,prospect_name,gps_status,gps_address,comment,server_received_at,deleted_at,delete_reason",
    )
    .in("hr_id", hrIdLookupKeys(access.hrId))
    .gte("visit_date", addDaysIso(cairoToday, -HISTORY_DAYS))
    .order("visit_date", { ascending: false })
    .order("server_received_at", { ascending: false })
    .limit(300);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const [partners, onBehalfActors] = await Promise.all([
    loadPartnersByVisit(rows.map((row) => String(row.id))),
    loadOnBehalfActors(rows),
  ]);

  return rows.map((row) => {
    const visitDate = String(row.visit_date);
    const deletedAt = row.deleted_at ? String(row.deleted_at) : null;
    return {
      id: String(row.id),
      visitDate,
      shift: row.shift as NativeVisitShift,
      visitType: row.visit_type as NativeVisitTypeKey,
      typeLabel: nativeVisitTypeLabel(String(row.visit_type)),
      contactName: row.contact_name ? String(row.contact_name) : null,
      prospectName: row.prospect_name ? String(row.prospect_name) : null,
      gpsStatus: row.gps_status as NativeVisitGpsStatus,
      gpsAddress: row.gps_address ? String(row.gps_address) : null,
      comment: row.comment ? String(row.comment) : null,
      serverReceivedAt: String(row.server_received_at),
      deletedAt,
      deleteReason: row.delete_reason ? String(row.delete_reason) : null,
      canDelete:
        nativeVisitDeleteRefusal({
          ownerHrId: String(row.hr_id),
          viewerHrId: access.hrId,
          deletedAt,
          visitDate,
          cairoToday,
          reason: "check",
        }) === null,
      partners: (partners.get(String(row.id)) ?? []).map(
        (partner): NativeVisitPartnerView => ({
          name: String(partner.partner_name ?? "Unknown employee"),
          jobTitle: partner.partner_job_title ? String(partner.partner_job_title) : null,
          isDirectManager: partner.is_direct_manager === true,
          status: partner.status as NativePartnerStatus,
        }),
      ),
      enteredOnBehalf: onBehalfActors.has(String(row.id)),
    };
  });
}

function isoDayOr(value: unknown, fallback: string): string {
  const day = String(value ?? "").trim();
  return ISO_DAY.test(day) ? day : fallback;
}

/**
 * The Super Admin's page (the owner, 2026-09-14): every rep's saved visits over a span of days, and the
 * reps he may enter a visit for. Reads the native tables only — nothing here reaches a report.
 */
export async function listAllNativeVisits(
  access: AccessContext,
  input: { from?: unknown; to?: unknown; repHrId?: unknown },
): Promise<NativeVisitAdminView> {
  await assertPermission(access, "crm_visit_entry", "update");
  const to = isoDayOr(input.to, cairoTodayIso());
  const from = isoDayOr(input.from, addDaysIso(to, -HISTORY_DAYS));
  if (from > to) throw validationError("The first day must be on or before the last day.");
  if (from < addDaysIso(to, -ADMIN_RANGE_DAYS)) throw validationError(`Choose at most ${ADMIN_RANGE_DAYS} days at a time.`);

  const [directory, pilots, cutover, scope] = await Promise.all([
    loadDirectory(),
    loadPilots(),
    getCrmCutoverSetting(),
    getDoctorCoverageScope(access),
  ]);
  const reps = directory.rows
    .filter(
      (row) =>
        isActiveDirectoryEmployee(row) &&
        isNativeVisitRepTitle(row.jobTitle) &&
        isAgentInScope(scope, row.hrId) &&
        (cutover.cutoverDate != null || nativeVisitPilotForLine(row.lineName, pilots) != null),
    )
    .map(repOption)
    .sort((left, right) => left.name.localeCompare(right.name));

  const repHrId = String(input.repHrId ?? "").trim();
  let query = getSupabaseAdmin()
    .from(CRM_NATIVE_VISITS_TABLE)
    .select(
      "id,hr_id,job_title,line_name,area_name,visit_date,shift,visit_type,contact_name,prospect_name,gps_status,comment,server_received_at,deleted_at,delete_reason",
    )
    .gte("visit_date", from)
    .lte("visit_date", to);
  if (canonicalHrIdKey(repHrId)) query = query.in("hr_id", hrIdLookupKeys(repHrId));
  const { data, error } = await query
    .order("visit_date", { ascending: false })
    .order("server_received_at", { ascending: false })
    .limit(ADMIN_LIST_LIMIT + 1);
  if (error) {
    if (isMissingTable(error)) return { from, to, reps, rows: [], truncated: false };
    throw error;
  }
  // Scope runs downward only, here as everywhere.
  const matched = ((data ?? []) as Array<Record<string, unknown>>).filter((row) => isAgentInScope(scope, String(row.hr_id)));
  const rows = matched.slice(0, ADMIN_LIST_LIMIT);
  const [partners, onBehalfActors] = await Promise.all([
    loadPartnersByVisit(rows.map((row) => String(row.id))),
    loadOnBehalfActors(rows),
  ]);

  return {
    from,
    to,
    reps,
    truncated: matched.length > ADMIN_LIST_LIMIT,
    rows: rows.map((row): NativeVisitAdminRow => {
      const actor = onBehalfActors.get(String(row.id));
      return {
        id: String(row.id),
        repName: employeeName(directory.byKey.get(canonicalHrIdKey(String(row.hr_id)) ?? "")),
        // As the rep stood on the day of the visit, not as he stands today.
        repDetail: [row.job_title, row.line_name, row.area_name].filter(Boolean).map(String).join(" · "),
        visitDate: String(row.visit_date),
        shift: row.shift as NativeVisitShift,
        typeLabel: nativeVisitTypeLabel(String(row.visit_type)),
        contactName: row.contact_name ? String(row.contact_name) : null,
        prospectName: row.prospect_name ? String(row.prospect_name) : null,
        gpsStatus: row.gps_status as NativeVisitGpsStatus,
        comment: row.comment ? String(row.comment) : null,
        serverReceivedAt: String(row.server_received_at),
        deletedAt: row.deleted_at ? String(row.deleted_at) : null,
        deleteReason: row.delete_reason ? String(row.delete_reason) : null,
        partners: (partners.get(String(row.id)) ?? []).map(
          (partner): NativeVisitPartnerView => ({
            name: String(partner.partner_name ?? "Unknown employee"),
            jobTitle: partner.partner_job_title ? String(partner.partner_job_title) : null,
            isDirectManager: partner.is_direct_manager === true,
            status: partner.status as NativePartnerStatus,
          }),
        ),
        enteredBy:
          actor === undefined ? null : employeeName(actor ? directory.byKey.get(canonicalHrIdKey(actor) ?? "") : undefined),
      };
    }),
  };
}

export async function deleteMyNativeVisit(
  access: AccessContext,
  input: { visitId: unknown; reason: unknown },
): Promise<{ visitId: string }> {
  await assertPermission(access, "crm_visit_entry", "delete");
  const visitId = String(input.visitId ?? "").trim();
  const reason = String(input.reason ?? "").trim().slice(0, NATIVE_VISIT_DELETE_REASON_MAX) || null;
  if (!visitId) throw validationError("Choose the visit to delete.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_NATIVE_VISITS_TABLE)
    .select("id,hr_id,visit_date,deleted_at")
    .eq("id", visitId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That visit was not found.");
  const row = data as Record<string, unknown>;

  const refusal = nativeVisitDeleteRefusal({
    ownerHrId: String(row.hr_id),
    viewerHrId: access.hrId,
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    visitDate: String(row.visit_date),
    cairoToday: cairoTodayIso(),
    reason,
  });
  if (refusal) throw validationError(refusal);

  const { data: updated, error: updateError } = await supabase
    .from(CRM_NATIVE_VISITS_TABLE)
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: hrIdForStorage(access.hrId),
      delete_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", visitId)
    .is("deleted_at", null)
    .select("id");
  if (updateError) throw updateError;
  if (!updated || (updated as unknown[]).length !== 1) throw conflictError("This visit was already deleted.");

  await recordEvent(visitId, "deleted", access.hrId, { reason });
  return { visitId };
}

// ── Confirmations ───────────────────────────────────────────────────────────────────────────────

export async function listMyNativeVisitConfirmations(access: AccessContext): Promise<NativeVisitConfirmationRow[]> {
  await assertPermission(access, "crm_visit_entry", "approve");
  if (!access.hrId) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_NATIVE_VISIT_PARTNERS_TABLE)
    .select("id,visit_id,partner_hr_id,is_direct_manager,status,decided_at,decision_note,created_at")
    .in("partner_hr_id", hrIdLookupKeys(access.hrId))
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  const partnerRows = (data ?? []) as Array<Record<string, unknown>>;
  if (partnerRows.length === 0) return [];

  const visits = new Map<string, Record<string, unknown>>();
  for (const ids of chunk(Array.from(new Set(partnerRows.map((row) => String(row.visit_id)))))) {
    const { data: visitRows, error: visitError } = await supabase
      .from(CRM_NATIVE_VISITS_TABLE)
      .select("id,hr_id,visit_date,shift,visit_type,contact_name,prospect_name,gps_status,comment,deleted_at")
      .in("id", ids);
    if (visitError) throw visitError;
    for (const row of (visitRows ?? []) as Array<Record<string, unknown>>) visits.set(String(row.id), row);
  }

  const [scope, directory] = await Promise.all([getDoctorCoverageScope(access), loadDirectory()]);
  const out: NativeVisitConfirmationRow[] = [];
  for (const partner of partnerRows) {
    const visit = visits.get(String(partner.visit_id));
    if (!visit || visit.deleted_at) continue;
    // Scope runs downward only: a row for a rep outside this viewer's reach is not shown at all.
    if (!isAgentInScope(scope, String(visit.hr_id))) continue;
    const status = partner.status as NativePartnerStatus;
    out.push({
      partnerId: Number(partner.id),
      status,
      repName: employeeName(directory.byKey.get(canonicalHrIdKey(String(visit.hr_id)) ?? "")),
      visitDate: String(visit.visit_date),
      shift: visit.shift as NativeVisitShift,
      typeLabel: nativeVisitTypeLabel(String(visit.visit_type)),
      contactName: visit.contact_name ? String(visit.contact_name) : null,
      prospectName: visit.prospect_name ? String(visit.prospect_name) : null,
      gpsStatus: visit.gps_status as NativeVisitGpsStatus,
      comment: visit.comment ? String(visit.comment) : null,
      isDirectManager: partner.is_direct_manager === true,
      decidedAt: partner.decided_at ? String(partner.decided_at) : null,
      decisionNote: partner.decision_note ? String(partner.decision_note) : null,
      canDecide: status === "pending",
    });
  }
  return out;
}

export async function decideNativeVisitPartner(
  access: AccessContext,
  input: { partnerId: unknown; decision: unknown; note: unknown },
): Promise<{ partnerId: number; status: NativePartnerStatus }> {
  await assertPermission(access, "crm_visit_entry", "approve");
  const partnerId = Number(input.partnerId);
  const decision = parseNativePartnerDecision(input.decision);
  const note = String(input.note ?? "").trim().slice(0, 500) || null;
  if (!Number.isInteger(partnerId) || partnerId <= 0) throw validationError("Choose the visit to answer.");
  if (!decision) throw validationError("Answer confirmed or rejected.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_NATIVE_VISIT_PARTNERS_TABLE)
    .select("id,visit_id,partner_hr_id,status")
    .eq("id", partnerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError("That visit was not found.");
  const partner = data as Record<string, unknown>;

  const { data: visit, error: visitError } = await supabase
    .from(CRM_NATIVE_VISITS_TABLE)
    .select("id,hr_id,deleted_at")
    .eq("id", String(partner.visit_id))
    .maybeSingle();
  if (visitError) throw visitError;
  if (!visit) throw notFoundError("That visit was not found.");
  const visitRow = visit as Record<string, unknown>;

  const scope = await getDoctorCoverageScope(access);
  const refusal = nativePartnerDecisionRefusal({
    partnerHrId: String(partner.partner_hr_id),
    viewerHrId: access.hrId,
    status: partner.status as NativePartnerStatus,
    visitDeleted: Boolean(visitRow.deleted_at),
    repInViewerScope: isAgentInScope(scope, String(visitRow.hr_id)),
  });
  if (refusal) throw forbiddenError(`Forbidden: ${refusal}`);

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from(CRM_NATIVE_VISIT_PARTNERS_TABLE)
    .update({
      status: decision,
      decided_at: now,
      // The stored partner id itself — the database refuses a decision by anyone else.
      decided_by: String(partner.partner_hr_id),
      decision_note: note,
      updated_at: now,
    })
    .eq("id", partnerId)
    .eq("status", "pending")
    .select("id");
  if (updateError) throw updateError;
  if (!updated || (updated as unknown[]).length !== 1) throw conflictError("This visit has already been answered.");

  await recordEvent(String(partner.visit_id), decision === "confirmed" ? "partner_confirmed" : "partner_rejected", access.hrId, {
    partnerId,
    note,
  });
  return { partnerId, status: decision };
}
