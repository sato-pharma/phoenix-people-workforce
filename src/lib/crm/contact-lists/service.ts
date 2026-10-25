/**
 * Doctor lists maintained in Phoenix — the server service (CRM phase 7).
 *
 * The owner's rule, 2026-09-14: "Rep asks, DM approves, SFE and system admin can edit, add or delete."
 *
 * WHO. A rep (crm_contact_lists create) asks for a change to his OWN list; the rep is the session. The
 * request goes to his nearest active manager when he asked, stored, and only that person approves or
 * refuses it (crm_contact_lists approve), for a rep beneath him. The SFE Manager and the administrator
 * (crm_contact_lists update) apply a change to any rep in their scope directly. Nothing here answers
 * for anyone, and the system never approves a request.
 *
 * WHEN. PER REP, from his own team's Phoenix CRM start — or from a global CRM cutover date if one is ever
 * set. Before that the vendor refresh owns that rep's list and would undo a change the next hour, so the
 * page shows the list and says whose team has not started. The database function
 * crm_contact_list_change_apply() applies the same two-path rule, and since 2026-10-04
 * crm_contact_master_refresh() freezes a started rep's rows so the edit sticks.
 *
 * WHAT IT WRITES. crm_contact_list_changes and its events here; crm_contact_assignments and, for a new
 * doctor, crm_contacts only through that function, in one transaction. The pure rules are rules.ts.
 */

import { revalidateTag } from "next/cache";

import { assertPermission, canAccess, type AccessContext } from "@/lib/auth/permissions";
import { CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG } from "@/lib/crm/contact-lists";
import { isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { refreshSharedContactRoster } from "@/lib/crm/shared-windows";
import {
  CONTACT_LIST_NOTE_MAX,
  anyDoctorListLive,
  contactListChangeRefusal,
  contactListChangesInForce,
  contactListDecisionRefusal,
  contactListSpecialityOptions,
  contactListStateRefusal,
  doctorListOwnedByPhoenix,
  doctorListRefusal,
  parseContactListAction,
  parseContactListDecision,
  parseContactListGrade,
  parseContactListShift,
  type ContactListAction,
  type ContactListChangeInput,
  type ContactListChangeStatus,
  type ContactListShift,
  type DoctorListOwnership,
} from "@/lib/crm/contact-lists/rules";
import {
  CRM_CONTACT_LIST_CHANGE_APPLY_FUNCTION,
  CRM_CONTACT_LIST_CHANGE_EVENTS_TABLE,
  CRM_CONTACT_LIST_CHANGES_TABLE,
} from "@/lib/crm/contact-lists/tables";
import type {
  ContactListAvailability,
  ContactListChangeRow,
  ContactListEntry,
  ContactListRepOption,
  ContactListSearchResult,
  ContactListView,
} from "@/lib/crm/contact-lists/types";
import { getCrmCutoverSetting } from "@/lib/crm/cutover";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { isAgentInScope, type DoctorCoverageScope } from "@/lib/crm/doctor-coverage-roles";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { loadDoctorListRepWindows } from "@/lib/crm/phoenix-started-reps";
import {
  chunk,
  employeeName,
  isMissingTable,
  isUniqueViolation,
  loadDirectory,
  managementChain,
  requireActiveSelf,
  type Directory,
} from "@/lib/crm/native-visits/server-shared";
import { CRM_CONTACT_ASSIGNMENTS_TABLE, CRM_CONTACT_MASTER_TABLE } from "@/lib/crm/tables";
import { isActiveDirectoryEmployee, type EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { ilikeAnyFilter } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** How far back the page lists changes. */
const HISTORY_DAYS = 60;
const LIST_LIMIT = 200;
const SEARCH_LIMIT = 25;
const CATCH_ALL_CONTACT = 100000;
const COLUMNS =
  "id,rep_hr_id,action,list_type,contact_crm_id,new_contact_name,new_contact_speciality,grade,reason,requested_by,manager_hr_id,direct,status,decided_by,decided_at,decision_note,applied_contact_crm_id,created_at";
/** A rep's list can be opened by the editor when the person is in the field force. */
const LIST_HOLDER_TITLE = /medical rep|representative|district/i;

type ChangeRecord = {
  id: string;
  repHrId: string;
  action: ContactListAction;
  listType: ContactListShift;
  contactCrmId: number | null;
  newContactName: string | null;
  newContactSpeciality: string | null;
  grade: string | null;
  reason: string;
  requestedBy: string;
  managerHrId: string | null;
  direct: boolean;
  status: ContactListChangeStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedContactCrmId: number | null;
  createdAt: string;
};

type ContactDetail = { name: string; speciality: string | null; address: string | null };
type Viewer = { canRequest: boolean; canDecide: boolean; canEditDirectly: boolean };
type SupabaseError = { code?: string | null; message?: string | null } | null;

function text(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function idOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function toRecord(row: Record<string, unknown>): ChangeRecord {
  return {
    id: String(row.id),
    repHrId: String(row.rep_hr_id ?? ""),
    action: parseContactListAction(row.action) ?? "add",
    listType: parseContactListShift(row.list_type) ?? "AM",
    contactCrmId: idOrNull(row.contact_crm_id),
    newContactName: text(row.new_contact_name),
    newContactSpeciality: text(row.new_contact_speciality),
    grade: text(row.grade),
    reason: String(row.reason ?? ""),
    requestedBy: String(row.requested_by ?? ""),
    managerHrId: text(row.manager_hr_id),
    direct: row.direct === true,
    status:
      row.status === "approved" || row.status === "rejected" || row.status === "cancelled" ? row.status : "pending",
    decidedBy: text(row.decided_by),
    decidedAt: text(row.decided_at),
    decisionNote: text(row.decision_note),
    appliedContactCrmId: idOrNull(row.applied_contact_crm_id),
    createdAt: String(row.created_at ?? ""),
  };
}

/** A refusal the apply function raised on purpose carries a sentence meant for the person. */
function isApplyRefusal(error: SupabaseError): boolean {
  return String(error?.code ?? "") === "P0001" && Boolean(error?.message);
}

// ── Access ──────────────────────────────────────────────────────────────────────────────────────

async function viewerCapabilities(access: AccessContext): Promise<Viewer> {
  const [mayCreate, mayApprove, mayUpdate] = await Promise.all([
    canAccess(access, "crm_contact_lists", "create"),
    canAccess(access, "crm_contact_lists", "approve"),
    canAccess(access, "crm_contact_lists", "update"),
  ]);
  return { canRequest: mayCreate && !mayUpdate, canDecide: mayApprove, canEditDirectly: mayUpdate };
}

/** Refuses a viewer who can neither ask, answer nor edit. */
export async function assertContactListAccess(access: AccessContext): Promise<Viewer> {
  const viewer = await viewerCapabilities(access);
  if (!viewer.canRequest && !viewer.canDecide && !viewer.canEditDirectly) {
    throw forbiddenError("Forbidden: you cannot view or change doctor lists.");
  }
  return viewer;
}

/**
 * Who owns a doctor list today: the DOCTOR-LIST door's windows, plus the global cutover setting. Read
 * together, once, because every caller needs both halves of the rule.
 *
 * `loadDoctorListRepWindows` is every started team's people PLUS every rep who holds a Phoenix CRM list
 * and has no iReports360 account at all — nothing would otherwise write that rep a list, on any screen
 * (the owner's ruling of 2026-10-15, migration 20261015215500). It is the same door the hourly refresh's
 * fifth pass and `crm_contact_list_change_apply` ask in SQL, so this page, the request, the approval and
 * the row that lands can never disagree. Everything that counts WORK still asks
 * `loadStartedRepWindows` — a team's counting source moves only on the owner's own Start click.
 */
async function listOwnership(): Promise<Omit<DoctorListOwnership, "rep">> {
  const [windows, cutover] = await Promise.all([loadDoctorListRepWindows(), getCrmCutoverSetting()]);
  return { cairoToday: cairoTodayIso(), cutover, windows };
}

/** A directory row as the ownership rule wants it: his HR id, and his CRM account as a number. */
function ownershipRep(row: { crmId: string | null; hrId: string }): DoctorListOwnership["rep"] {
  const crmId = row.crmId == null || row.crmId.trim() === "" ? null : Number(row.crmId);
  return { crmId: crmId != null && Number.isFinite(crmId) ? crmId : null, hrId: row.hrId };
}

/** Refuses a change to a list iReports360 still owns — the TypeScript half of the database's own rule. */
async function assertPhoenixOwnsList(rep: { crmId: string | null; hrId: string }): Promise<void> {
  const refusal = doctorListRefusal({ ...(await listOwnership()), rep: ownershipRep(rep) });
  if (refusal) throw validationError(refusal);
}

// ── Loading ─────────────────────────────────────────────────────────────────────────────────────

async function loadContactDetails(ids: readonly number[]): Promise<Map<number, ContactDetail>> {
  const details = new Map<number, ContactDetail>();
  const unique = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  for (const slice of chunk(unique)) {
    const { data, error } = await getSupabaseAdmin()
      .from(CRM_CONTACT_MASTER_TABLE)
      .select("contact_crm_id,name,speciality,address")
      .in("contact_crm_id", slice);
    if (error) throw error;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      details.set(Number(row.contact_crm_id), {
        name: String(row.name ?? "").trim() || "Unnamed doctor",
        speciality: text(row.speciality),
        address: text(row.address),
      });
    }
  }
  return details;
}

/** The rep's open AM and PM periods. A pharmacy is not a contact, so its list is never read. */
async function loadRepList(repHrId: string): Promise<Omit<ContactListEntry, "pendingChange">[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
    .select("contact_crm_id,list_type,grade,effective_from")
    .is("effective_to", null)
    .in("agent_hr_id", hrIdLookupKeys(repHrId))
    .in("list_type", ["AM", "PM"]);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((row) => {
    const id = Number(row.contact_crm_id);
    return Number.isInteger(id) && id > 0 && id !== CATCH_ALL_CONTACT;
  });
  const details = await loadContactDetails(rows.map((row) => Number(row.contact_crm_id)));
  const seen = new Set<string>();
  const entries: Omit<ContactListEntry, "pendingChange">[] = [];
  for (const row of rows) {
    const contactCrmId = Number(row.contact_crm_id);
    const listType = parseContactListShift(row.list_type);
    if (!listType || seen.has(`${contactCrmId}|${listType}`)) continue;
    seen.add(`${contactCrmId}|${listType}`);
    const detail = details.get(contactCrmId);
    entries.push({
      contactCrmId,
      name: detail?.name ?? "Unnamed doctor",
      speciality: detail?.speciality ?? null,
      address: detail?.address ?? null,
      listType,
      grade: text(row.grade),
      since: String(row.effective_from ?? "").slice(0, 10),
    });
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name) || left.listType.localeCompare(right.listType));
}

/** Whether the doctor is on the rep's list today, and at which grade. */
async function currentListState(repHrId: string, contactCrmId: number, listType: ContactListShift) {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
    .select("grade")
    .is("effective_to", null)
    .in("agent_hr_id", hrIdLookupKeys(repHrId))
    .eq("contact_crm_id", contactCrmId)
    .eq("list_type", listType)
    .limit(1);
  if (error) throw error;
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  return { onList: Boolean(row), grade: row ? text(row.grade) : null };
}

async function loadChange(changeId: string): Promise<ChangeRecord> {
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_CONTACT_LIST_CHANGES_TABLE)
    .select(COLUMNS)
    .eq("id", changeId)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) throw notFoundError("That change was not found.");
    throw error;
  }
  if (!data) throw notFoundError("That change was not found.");
  return toRecord(data as Record<string, unknown>);
}

async function fetchChanges(filter: "rep" | "manager" | "waiting", hrId: string, since: string): Promise<ChangeRecord[]> {
  const base = getSupabaseAdmin().from(CRM_CONTACT_LIST_CHANGES_TABLE).select(COLUMNS);
  const filtered =
    filter === "rep"
      ? base.in("rep_hr_id", hrIdLookupKeys(hrId)).gte("created_at", `${since}T00:00:00+02:00`)
      : filter === "manager"
        ? base.in("manager_hr_id", hrIdLookupKeys(hrId)).gte("created_at", `${since}T00:00:00+02:00`)
        : base.eq("status", "pending");
  const { data, error } = await filtered.order("created_at", { ascending: false }).limit(LIST_LIMIT);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map(toRecord);
}

async function recordEvent(changeId: string, event: string, actorHrId: string | null, detail: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from(CRM_CONTACT_LIST_CHANGE_EVENTS_TABLE)
    .insert({ change_id: changeId, event, actor_hr_id: hrIdForStorage(actorHrId), detail });
  if (error) throw error;
}

function personName(directory: Directory, hrId: string | null): string {
  return employeeName(directory.byKey.get(canonicalHrIdKey(hrId) ?? ""));
}

/**
 * Every rep the editor may open, the ones whose list he can actually CHANGE first. The rest stay on the
 * picker and stay readable — their list is still iReports360's, and the option says so rather than
 * letting him pick one and meet a refusal.
 */
function repOptionsFor(
  directory: Directory,
  scope: DoctorCoverageScope,
  ownership: Omit<DoctorListOwnership, "rep">,
): ContactListRepOption[] {
  return directory.rows
    .filter((row) => isActiveDirectoryEmployee(row) && LIST_HOLDER_TITLE.test(row.jobTitle ?? "") && isAgentInScope(scope, row.hrId))
    .map((row) => ({
      hrId: row.hrId,
      name: employeeName(row),
      detail: [row.jobTitle, row.lineName, row.areaName].filter(Boolean).join(" · "),
      listOpen: doctorListOwnedByPhoenix({ ...ownership, rep: ownershipRep(row) }),
    }))
    .sort((left, right) =>
      left.listOpen === right.listOpen ? left.name.localeCompare(right.name) : left.listOpen ? -1 : 1,
    );
}

// ── Checking one change ─────────────────────────────────────────────────────────────────────────

function readChangeInput(input: Record<string, unknown>): ContactListChangeInput {
  const newContact = input.newContact as Record<string, unknown> | null | undefined;
  const rawContact = input.contactCrmId;
  return {
    action: parseContactListAction(input.action),
    listType: parseContactListShift(input.listType),
    contactCrmId: rawContact == null || rawContact === "" ? null : Number(rawContact),
    newContact:
      newContact && typeof newContact === "object"
        ? {
            name: String(newContact.name ?? ""),
            speciality: String(newContact.speciality ?? ""),
            address: String(newContact.address ?? ""),
          }
        : null,
    grade: parseContactListGrade(input.grade),
    reason: String(input.reason ?? ""),
  };
}

/** The columns a checked change is stored with. Throws the sentence that explains a refusal. */
async function prepareChange(input: ContactListChangeInput, repHrId: string): Promise<Record<string, unknown>> {
  const refusal = contactListChangeRefusal(input);
  if (refusal || !input.action || !input.listType) throw validationError(refusal ?? "Check the change.");

  if (input.contactCrmId == null) {
    const newContact = input.newContact!;
    const speciality =
      contactListSpecialityOptions().find((option) => option.toLowerCase() === newContact.speciality.trim().toLowerCase()) ??
      newContact.speciality.trim();
    return {
      action: input.action,
      list_type: input.listType,
      contact_crm_id: null,
      new_contact_name: newContact.name.trim(),
      new_contact_speciality: speciality,
      new_contact_address: newContact.address.trim() || null,
      grade: input.grade,
      reason: input.reason.trim(),
    };
  }

  const detail = (await loadContactDetails([input.contactCrmId])).get(input.contactCrmId);
  if (!detail) throw validationError("That doctor was not found. Search again.");
  const state = await currentListState(repHrId, input.contactCrmId, input.listType);
  const stateRefusal = contactListStateRefusal({
    action: input.action,
    onList: state.onList,
    currentGrade: state.grade,
    newGrade: input.grade,
    contactSpeciality: detail.speciality,
  });
  if (stateRefusal) throw conflictError(stateRefusal);
  return {
    action: input.action,
    list_type: input.listType,
    contact_crm_id: input.contactCrmId,
    grade: input.action === "remove" ? null : input.grade,
    reason: input.reason.trim(),
  };
}

// ── Availability (the link) ─────────────────────────────────────────────────────────────────────

/**
 * Whether to link the page, and how many requests wait for this viewer. Never throws.
 *
 * Hidden until SOME team is counted from Phoenix CRM (or a global cutover date is set) — and, for a rep,
 * until his OWN team has started, because his link would otherwise open a page that refuses every change
 * he could make there.
 */
export async function getContactListAvailability(access: AccessContext): Promise<ContactListAvailability> {
  const none: ContactListAvailability = { show: false, canRequest: false, waitingForYou: 0 };
  try {
    const viewer = await viewerCapabilities(access);
    if (!viewer.canRequest && !viewer.canDecide) return none;
    const ownership = await listOwnership();
    const liveSomewhere =
      anyDoctorListLive(ownership.windows, ownership.cairoToday) ||
      contactListChangesInForce(ownership.cutover, ownership.cairoToday);
    if (!liveSomewhere) return none;
    if (viewer.canRequest && !doctorListOwnedByPhoenix({ ...ownership, rep: { crmId: null, hrId: access.hrId } })) {
      return none;
    }
    let waitingForYou = 0;
    if (viewer.canDecide && access.hrId) {
      const { count, error } = await getSupabaseAdmin()
        .from(CRM_CONTACT_LIST_CHANGES_TABLE)
        .select("id", { count: "exact", head: true })
        .in("manager_hr_id", hrIdLookupKeys(access.hrId))
        .eq("status", "pending");
      if (!error) waitingForYou = count ?? 0;
    }
    return { show: true, canRequest: viewer.canRequest, waitingForYou };
  } catch {
    return none;
  }
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────

export async function getContactListView(access: AccessContext, input: { repHrId?: unknown }): Promise<ContactListView> {
  const viewer = await assertContactListAccess(access);
  const ownership = await listOwnership();
  const view: ContactListView = {
    // No rep shown yet: whether the feature is open for ANYBODY. Narrowed to the shown rep below.
    inForce:
      anyDoctorListLive(ownership.windows, ownership.cairoToday) ||
      contactListChangesInForce(ownership.cutover, ownership.cairoToday),
    cutoverDate: ownership.cutover.cutoverDate,
    ...viewer,
    rep: null,
    entries: [],
    changes: [],
    toDecide: [],
    waitingCompany: [],
    repOptions: [],
    specialityOptions: contactListSpecialityOptions(),
  };
  if (!access.hrId) return view;

  const since = addDaysIso(cairoTodayIso(), -HISTORY_DAYS);
  const viewerKey = canonicalHrIdKey(access.hrId);
  const [directory, scope] = await Promise.all([
    loadDirectory(),
    viewer.canDecide || viewer.canEditDirectly ? getDoctorCoverageScope(access) : Promise.resolve(null),
  ]);

  let shownRep: EmployeeDirectoryRow | null = null;
  if (viewer.canEditDirectly && scope) {
    view.repOptions = repOptionsFor(directory, scope, ownership);
    const wanted = canonicalHrIdKey(String(input.repHrId ?? ""));
    const row = wanted ? directory.byKey.get(wanted) : undefined;
    if (row && isActiveDirectoryEmployee(row) && isAgentInScope(scope, row.hrId)) shownRep = row;
  } else if (viewer.canRequest) {
    shownRep = requireActiveSelf(access, directory);
  }

  // The rule is per rep, so once his row is known it is HIS team's start that decides, never a date.
  if (shownRep) view.inForce = doctorListOwnedByPhoenix({ ...ownership, rep: ownershipRep(shownRep) });

  const [entries, repChanges, managed, waiting] = await Promise.all([
    shownRep ? loadRepList(shownRep.hrId) : Promise.resolve([]),
    shownRep ? fetchChanges("rep", shownRep.hrId, since) : Promise.resolve([]),
    viewer.canDecide ? fetchChanges("manager", access.hrId, since) : Promise.resolve([]),
    viewer.canEditDirectly ? fetchChanges("waiting", access.hrId, since) : Promise.resolve([]),
  ]);

  const contactIds = [...repChanges, ...managed, ...waiting]
    .map((record) => record.contactCrmId ?? record.appliedContactCrmId)
    .filter((id): id is number => id != null);
  const details = await loadContactDetails(contactIds);

  const toRow = (record: ChangeRecord): ContactListChangeRow => {
    const contactId = record.contactCrmId ?? record.appliedContactCrmId;
    const detail = contactId != null ? details.get(contactId) : undefined;
    const canDecide =
      viewer.canDecide &&
      !contactListDecisionRefusal({
        viewerHrKey: viewerKey,
        repHrKey: canonicalHrIdKey(record.repHrId) ?? "",
        managerHrKey: canonicalHrIdKey(record.managerHrId),
        direct: record.direct,
        status: record.status,
        repInViewerScope: scope ? isAgentInScope(scope, record.repHrId) : false,
        decision: "approved",
        note: null,
      });
    return {
      id: record.id,
      repName: personName(directory, record.repHrId),
      action: record.action,
      listType: record.listType,
      doctorName: detail?.name ?? record.newContactName ?? "Unnamed doctor",
      doctorSpeciality: detail?.speciality ?? record.newContactSpeciality,
      grade: record.grade,
      reason: record.reason,
      status: record.status,
      direct: record.direct,
      requestedByName: personName(directory, record.requestedBy),
      managerName: record.managerHrId ? personName(directory, record.managerHrId) : null,
      decidedByName: record.decidedBy ? personName(directory, record.decidedBy) : null,
      decisionNote: record.decisionNote,
      decidedAt: record.decidedAt,
      createdAt: record.createdAt,
      canDecide,
      canCancel:
        viewer.canRequest && record.status === "pending" && canonicalHrIdKey(record.repHrId) === viewerKey,
    };
  };

  if (shownRep) {
    const pending = new Set(
      repChanges
        .filter((record) => record.status === "pending" && record.contactCrmId != null)
        .map((record) => `${record.contactCrmId}|${record.listType}`),
    );
    view.rep = {
      hrId: shownRep.hrId,
      name: employeeName(shownRep),
      managerName: managementChain(shownRep, directory)[0]?.name ?? null,
    };
    view.entries = entries.map((entry) => ({ ...entry, pendingChange: pending.has(`${entry.contactCrmId}|${entry.listType}`) }));
    view.changes = repChanges.map(toRow);
  }
  view.toDecide = managed
    .filter((record) => scope && isAgentInScope(scope, record.repHrId) && canonicalHrIdKey(record.repHrId) !== viewerKey)
    .map(toRow);
  view.waitingCompany = waiting.filter((record) => scope && isAgentInScope(scope, record.repHrId)).map(toRow);
  return view;
}

/** Doctors known to Phoenix by name, for an add. Pharmacies are never offered. */
export async function searchContactListDoctors(
  access: AccessContext,
  input: { query: unknown },
): Promise<ContactListSearchResult[]> {
  const viewer = await assertContactListAccess(access);
  if (!viewer.canRequest && !viewer.canEditDirectly) {
    throw forbiddenError("Forbidden: you cannot add doctors to a list.");
  }
  const term = String(input.query ?? "").trim().slice(0, 80);
  if (term.length < 2) return [];
  const filter = ilikeAnyFilter(["name", "name_ar"], term);
  if (!filter) return [];
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_CONTACT_MASTER_TABLE)
    .select("contact_crm_id,name,speciality,address")
    .or(filter)
    .neq("contact_crm_id", CATCH_ALL_CONTACT)
    .order("name")
    .limit(SEARCH_LIMIT * 2);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as Array<Record<string, unknown>>)
    .filter((row) => !isPharmacySpeciality(text(row.speciality)))
    .slice(0, SEARCH_LIMIT)
    .map((row) => ({
      contactCrmId: Number(row.contact_crm_id),
      name: String(row.name ?? "").trim() || "Unnamed doctor",
      speciality: text(row.speciality),
      address: text(row.address),
    }));
}

// ── A rep asks ──────────────────────────────────────────────────────────────────────────────────

export async function requestContactListChange(
  access: AccessContext,
  input: Record<string, unknown>,
): Promise<{ changeId: string }> {
  await assertPermission(access, "crm_contact_lists", "create");
  const directory = await loadDirectory();
  const rep = requireActiveSelf(access, directory);
  // After his row, never before it: the rule is about HIS team's start, not a company-wide date.
  await assertPhoenixOwnsList(rep);
  const prepared = await prepareChange(readChangeInput(input), rep.hrId);

  const manager = managementChain(rep, directory)[0];
  if (!manager) {
    throw validationError("You have no active manager on record to send this to. Ask HR to correct your manager.");
  }
  const managerHrId = directory.byKey.get(canonicalHrIdKey(manager.hrId) ?? "")?.hrId ?? manager.hrId;

  // The status starts pending by the table's own default. Only the manager's click moves it.
  const { data, error } = await getSupabaseAdmin()
    .from(CRM_CONTACT_LIST_CHANGES_TABLE)
    .insert({ ...prepared, rep_hr_id: rep.hrId, requested_by: rep.hrId, manager_hr_id: managerHrId, direct: false })
    .select("id")
    .single();
  if (error) {
    if (isUniqueViolation(error)) throw conflictError("You already have a request waiting for that doctor on this list.");
    throw error;
  }
  const changeId = String((data as Record<string, unknown>).id);
  await recordEvent(changeId, "requested", access.hrId, { managerHrId });
  return { changeId };
}

/**
 * An applied change moves a list, so the cached list sizes the Reps List, the KPI boards and Plan
 * Verification read (getRepListSummaries, 300s) are wrong until busted. A failure here must never
 * turn an applied change into an error: the list is written, and the TTL is the fallback.
 */
function bustListSummaries(): void {
  try {
    revalidateTag(CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG, "max");
  } catch (error) {
    console.warn("Doctor list summaries cache revalidation failed.", { error });
  }
  // In-process and synchronous; after the catch, so a cache-tag failure never skips it.
  refreshSharedContactRoster("doctor list change applied");
}

// ── The SFE Manager or the administrator edits directly ────────────────────────────────────────

export async function applyContactListChangeDirectly(
  access: AccessContext,
  input: Record<string, unknown>,
): Promise<{ changeId: string }> {
  await assertPermission(access, "crm_contact_lists", "update");
  const directory = await loadDirectory();
  const editor = requireActiveSelf(access, directory);
  const repKey = canonicalHrIdKey(String(input.repHrId ?? ""));
  const rep = repKey ? directory.byKey.get(repKey) : undefined;
  if (!rep || !isActiveDirectoryEmployee(rep)) throw validationError("Choose an active rep.");
  const scope = await getDoctorCoverageScope(access);
  if (!isAgentInScope(scope, rep.hrId)) throw forbiddenError("Forbidden: that rep is outside your scope.");
  await assertPhoenixOwnsList(rep);
  const prepared = await prepareChange(readChangeInput(input), rep.hrId);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_CONTACT_LIST_CHANGES_TABLE)
    .insert({ ...prepared, rep_hr_id: rep.hrId, requested_by: editor.hrId, manager_hr_id: null, direct: true })
    .select("id")
    .single();
  if (error) {
    if (isUniqueViolation(error)) throw conflictError("A change for that doctor on this list is already waiting for a manager.");
    throw error;
  }
  const changeId = String((data as Record<string, unknown>).id);
  await recordEvent(changeId, "requested", access.hrId, { direct: true });

  // A direct change is decided by the person who made it — the database refuses anyone else.
  const applied = await supabase.rpc(CRM_CONTACT_LIST_CHANGE_APPLY_FUNCTION, {
    p_change_id: changeId,
    p_decided_by: editor.hrId,
    p_note: null,
  });
  if (applied.error) {
    const now = new Date().toISOString();
    await supabase
      .from(CRM_CONTACT_LIST_CHANGES_TABLE)
      .update({ status: "cancelled", cancelled_at: now, updated_at: now })
      .eq("id", changeId)
      .eq("status", "pending");
    await recordEvent(changeId, "cancelled", access.hrId, { notApplied: applied.error.message ?? null });
    if (isApplyRefusal(applied.error)) throw conflictError(String(applied.error.message));
    throw applied.error;
  }
  bustListSummaries();
  return { changeId };
}

// ── The manager answers ─────────────────────────────────────────────────────────────────────────

export async function decideContactListChange(
  access: AccessContext,
  input: { changeId: unknown; decision: unknown; note: unknown },
): Promise<{ changeId: string; status: ContactListChangeStatus }> {
  await assertPermission(access, "crm_contact_lists", "approve");
  const decision = parseContactListDecision(input.decision);
  if (!decision) throw validationError("Answer approve or refuse.");
  const changeId = String(input.changeId ?? "").trim();
  if (!isUuid(changeId)) throw validationError("Choose the request to answer.");
  const note = String(input.note ?? "").trim() || null;
  if (note && note.length > CONTACT_LIST_NOTE_MAX) throw validationError(`Keep the note under ${CONTACT_LIST_NOTE_MAX} characters.`);

  const record = await loadChange(changeId);
  const scope = await getDoctorCoverageScope(access);
  const refusal = contactListDecisionRefusal({
    viewerHrKey: canonicalHrIdKey(access.hrId),
    repHrKey: canonicalHrIdKey(record.repHrId) ?? "",
    managerHrKey: canonicalHrIdKey(record.managerHrId),
    direct: record.direct,
    status: record.status,
    repInViewerScope: isAgentInScope(scope, record.repHrId),
    decision,
    note,
  });
  if (refusal || !record.managerHrId) throw forbiddenError(`Forbidden: ${refusal ?? "this change needs no answer."}`);

  const supabase = getSupabaseAdmin();
  if (decision === "approved") {
    const repRow = (await loadDirectory()).byKey.get(canonicalHrIdKey(record.repHrId) ?? "");
    await assertPhoenixOwnsList({ crmId: repRow?.crmId ?? null, hrId: record.repHrId });
    // The stored manager id itself — the database refuses an approval by anyone else, and applies the
    // change to the list in the same transaction.
    const applied = await supabase.rpc(CRM_CONTACT_LIST_CHANGE_APPLY_FUNCTION, {
      p_change_id: changeId,
      p_decided_by: record.managerHrId,
      p_note: note,
    });
    if (applied.error) {
      if (isApplyRefusal(applied.error)) throw conflictError(String(applied.error.message));
      throw applied.error;
    }
    bustListSummaries();
    return { changeId, status: decision };
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from(CRM_CONTACT_LIST_CHANGES_TABLE)
    .update({ status: decision, decided_by: record.managerHrId, decided_at: now, decision_note: note, updated_at: now })
    .eq("id", changeId)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  if (!updated || (updated as unknown[]).length !== 1) {
    throw conflictError("This request has already been answered or withdrawn.");
  }
  await recordEvent(changeId, decision, access.hrId, { note });
  return { changeId, status: decision };
}

// ── The rep withdraws ───────────────────────────────────────────────────────────────────────────

export async function cancelContactListChange(
  access: AccessContext,
  input: { changeId: unknown },
): Promise<{ changeId: string }> {
  await assertPermission(access, "crm_contact_lists", "create");
  const changeId = String(input.changeId ?? "").trim();
  if (!isUuid(changeId)) throw validationError("Choose the request to withdraw.");

  const directory = await loadDirectory();
  const rep = requireActiveSelf(access, directory);
  const record = await loadChange(changeId);
  // Someone else's request is simply not found, so its existence is not disclosed.
  if (canonicalHrIdKey(record.repHrId) !== canonicalHrIdKey(rep.hrId) || record.direct) {
    throw notFoundError("That request was not found.");
  }
  if (record.status !== "pending") throw conflictError("This request is no longer waiting, so there is nothing to withdraw.");

  const now = new Date().toISOString();
  const { data: updated, error } = await getSupabaseAdmin()
    .from(CRM_CONTACT_LIST_CHANGES_TABLE)
    .update({ status: "cancelled", cancelled_at: now, updated_at: now })
    .eq("id", changeId)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  if (!updated || (updated as unknown[]).length !== 1) throw conflictError("This request is no longer waiting.");

  await recordEvent(changeId, "cancelled", access.hrId, {});
  return { changeId };
}
