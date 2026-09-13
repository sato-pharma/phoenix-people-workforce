/**
 * Native visits — the server service (CRM phase 3, the pilot).
 *
 * THE ONLY CODE THAT TOUCHES THE NATIVE TABLES, with plans-service.ts beside it. Until the cutover
 * nothing else may read them: every report, KPI, deduction, probation count and payroll input keeps
 * reading the iReports360 mirror, and the pilot line keeps entering there too, so a native row read
 * anywhere else double-counts. tests/crm-native-visits.test.ts fails if another file references the
 * table constants.
 *
 * WHO. The rep is always the session's own person, looked up in the employee directory — never a
 * field of the request. A partner decides only a row naming HIM, and only for a rep beneath him
 * (scope runs downward only). Nothing here decides anything on anyone's behalf.
 *
 * WHEN. Only the pilot line, only on pilot days, only today or yesterday (Cairo).
 */

import { assertPermission, canAccess, type AccessContext } from "@/lib/auth/permissions";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { isAgentInScope } from "@/lib/crm/doctor-coverage-roles";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  NATIVE_VISIT_DELETE_REASON_MAX,
  NATIVE_VISIT_TYPES,
  isNativeVisitPilotDay,
  nativePartnerDecisionRefusal,
  nativeVisitDeleteRefusal,
  nativeVisitEntryDays,
  nativeVisitPartnerRefusal,
  nativeVisitPilotForLine,
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
  loadPilots,
  loadRepContacts,
  managementChain,
  requireActiveSelf,
} from "@/lib/crm/native-visits/server-shared";
import {
  CRM_NATIVE_PLAN_ITEMS_TABLE,
  CRM_NATIVE_VISIT_EVENTS_TABLE,
  CRM_NATIVE_VISIT_PARTNERS_TABLE,
  CRM_NATIVE_VISITS_TABLE,
} from "@/lib/crm/native-visits/tables";
import type {
  NativeVisitConfirmationRow,
  NativeVisitContactOption,
  NativeVisitEntryAvailability,
  NativeVisitFormOptions,
  NativeVisitPartnerView,
  NativeVisitRow,
  NativeVisitSaveResult,
} from "@/lib/crm/native-visits/types";
import { isActiveDirectoryEmployee } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** How far back "my visits" and "my confirmations" look. The pilot is one week. */
const HISTORY_DAYS = 14;

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
 * The rep's own live plan item for this doctor on this day, if the rep planned one (phase 4). Before
 * the plan tables exist there is simply no item.
 */
async function findPlanItemId(hrId: string, contactCrmId: number, visitDate: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_PLAN_ITEMS_TABLE)
    .select("id")
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
  return row?.id ? String(row.id) : null;
}

async function recordEvent(visitId: string, event: string, actorHrId: string | null, detail: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from(CRM_NATIVE_VISIT_EVENTS_TABLE)
    .insert({ visit_id: visitId, event, actor_hr_id: hrIdForStorage(actorHrId), detail });
  if (error) throw error;
}

// ── Form options ────────────────────────────────────────────────────────────────────────────────

export async function getNativeVisitFormOptions(access: AccessContext): Promise<NativeVisitFormOptions> {
  await assertPermission(access, "crm_visit_entry", "create");
  const [directory, pilots] = await Promise.all([loadDirectory(), loadPilots()]);
  const rep = requireActiveSelf(access, directory);
  const pilot = nativeVisitPilotForLine(rep.lineName, pilots);
  const entryDays = nativeVisitEntryDays(cairoTodayIso());
  const openDays = [entryDays.today, entryDays.yesterday].filter((day) => isNativeVisitPilotDay(pilot, day));

  return {
    pilot: pilot ? { lineName: pilot.lineName, startsOn: pilot.startsOn, endsOn: pilot.endsOn } : null,
    entryDays,
    openDays,
    types: NATIVE_VISIT_TYPES.map((type) => ({ key: type.key, label: type.label, contact: type.contact })),
    contacts: pilot ? await loadRepContacts(rep) : [],
    partners: pilot ? managementChain(rep, directory) : [],
  };
}

/** What the My Visits page offers this viewer. Never throws — the page must render without it. */
export async function getNativeVisitEntryAvailability(access: AccessContext): Promise<NativeVisitEntryAvailability> {
  const none: NativeVisitEntryAvailability = { canLog: false, canConfirm: false, pendingConfirmations: 0 };
  try {
    const [mayCreate, mayApprove] = await Promise.all([
      canAccess(access, "crm_visit_entry", "create"),
      canAccess(access, "crm_visit_entry", "approve"),
    ]);
    if (!mayCreate && !mayApprove) return none;

    let canLog = false;
    if (mayCreate) {
      const [directory, pilots] = await Promise.all([loadDirectory(), loadPilots()]);
      const key = canonicalHrIdKey(access.hrId);
      const rep = key ? directory.byKey.get(key) : undefined;
      const pilot = rep && isActiveDirectoryEmployee(rep) ? nativeVisitPilotForLine(rep.lineName, pilots) : null;
      // Offered from the day the pilot row exists until its last day; the form says when it opens.
      canLog = Boolean(pilot && cairoTodayIso() <= pilot.endsOn);
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

    return { canLog, canConfirm: mayApprove && pendingConfirmations > 0, pendingConfirmations };
  } catch {
    return none;
  }
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────

export async function createNativeVisit(access: AccessContext, raw: unknown): Promise<NativeVisitSaveResult> {
  await assertPermission(access, "crm_visit_entry", "create");
  const supabase = getSupabaseAdmin();
  const [directory, pilots] = await Promise.all([loadDirectory(), loadPilots()]);
  const rep = requireActiveSelf(access, directory);

  const parsed = parseNativeVisitDraft(raw, { cairoToday: cairoTodayIso(), now: new Date() });
  if (!parsed.ok) throw validationError(parsed.error);
  const draft = parsed.value;

  const pilot = nativeVisitPilotForLine(rep.lineName, pilots);
  if (!isNativeVisitPilotDay(pilot, draft.visitDate)) {
    throw forbiddenError("Forbidden: visit entry in Phoenix is open only to the pilot line, on the pilot days.");
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

  const selfPartner = nativeVisitPartnerRefusal(rep.hrId, draft.partnerHrIds);
  if (selfPartner) throw validationError(selfPartner);

  // The contact must be on this rep's own open AM or PM list, and its list decides the half-day.
  let contact: NativeVisitContactOption | null = null;
  if (draft.contactCrmId != null) {
    const contacts = await loadRepContacts(rep);
    contact = contacts.find((option) => option.contactCrmId === draft.contactCrmId) ?? null;
    const shiftRefusal = nativeVisitShiftRefusal(draft, contact?.lists ?? []);
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
    throw conflictError(`You recorded annual vacation for ${draft.shift} on this day. Delete it first to enter work.`);
  }
  if (draft.visitType === "annual_vacation" && sameShiftTypes.length > 0) {
    throw conflictError(`You already entered work for ${draft.shift} on this day. Delete it first to record annual vacation.`);
  }

  // Partners: only people in the rep's own management chain, so the person confirming always has
  // this rep beneath him.
  const chain = managementChain(rep, directory);
  const partners = draft.partnerHrIds.map((partnerHrId) => {
    const option = chain.find((candidate) => canonicalHrIdKey(candidate.hrId) === canonicalHrIdKey(partnerHrId));
    if (!option) throw validationError("A person recorded as accompanying you must be one of your managers.");
    return option;
  });

  const type = nativeVisitType(draft.visitType);
  if (!type) throw validationError("Choose what kind of visit or day this is.");

  // The plan link: a doctor visit keeps the rep's own planned item for that doctor and day, if any.
  // Only a doctor visit keeps a plan, as in the vendor plan-vs-actual (code 0 only).
  const [seatId, partnerRoles, planItemId] = await Promise.all([
    loadSeatId(rep.hrId),
    Promise.all(partners.map((partner) => loadAppRole(partner.hrId))),
    type.key === "regular" && draft.contactCrmId != null
      ? findPlanItemId(rep.hrId, draft.contactCrmId, draft.visitDate)
      : Promise.resolve(null),
  ]);

  const { data: inserted, error: insertError } = await supabase
    .from(CRM_NATIVE_VISITS_TABLE)
    .insert({
      client_submission_id: draft.clientSubmissionId,
      hr_id: rep.hrId,
      job_title: rep.jobTitle,
      app_role: access.role,
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
      throw conflictError("You have already recorded a visit to this doctor on that day.");
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
    });
  } catch (error) {
    // Nothing references the visit yet, so undo it rather than leave a visit missing its partners.
    await supabase.from(CRM_NATIVE_VISIT_PARTNERS_TABLE).delete().eq("visit_id", visitId);
    await supabase.from(CRM_NATIVE_VISITS_TABLE).delete().eq("id", visitId);
    throw error;
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
  const partners = await loadPartnersByVisit(rows.map((row) => String(row.id)));

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
    };
  });
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
