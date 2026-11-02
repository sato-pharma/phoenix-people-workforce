import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { canSeeHrScopedRecord, resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { scanPagesToPdf } from "@/lib/hiring-documents/document-scan";
import {
  assertHiringDocumentFileAllowed,
  buildHiringDocumentFilePath,
  downloadHiringDocumentFile,
  HIRING_DOCUMENTS_BUCKET,
  removeHiringDocumentFiles,
  uploadHiringDocumentFile,
} from "@/lib/hiring-documents/file-storage";
import { resolveHiringDocumentNotes } from "@/lib/hiring-documents/status-notes";
import { summarizeHiringDocumentReadiness } from "@/lib/recruitment/onboarding-metrics";
import { readHiringDocumentFileSource } from "@/lib/hiring-documents/types";
import type {
  AttachHiringDocumentFilesInput,
  CreateHiringDocumentDefinitionInput,
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentEntry,
  HiringDocumentFile,
  HiringDocumentFileSource,
  HiringDocumentsDashboardData,
  HiringDocumentStatus,
  UpdateHiringDocumentNotesInput,
  UpdateHiringDocumentStatusInput,
} from "@/lib/hiring-documents/types";
import { isUuid } from "@/lib/http/uuid";

type EmployeeDbRow = {
  employment_status: string | null;
  full_name: string | null;
  hire_date: string | null;
  hr_id: string;
  job_title: string | null;
  line_id: number | null;
  manager_hr_id: string | null;
  nickname: string | null;
};

type LineDbRow = {
  id: number;
  name: string | null;
};

type HiringDocumentDefinitionDbRow = {
  created_at: string;
  description: string | null;
  display_order: number;
  id: string;
  is_exit_document: boolean | null;
  document_group: string | null;
  sheet_header: string | null;
  name: string;
};

type HiringDocumentStatusDbRow = {
  document_id: string;
  due_date: string | null;
  employee_hr_id: string;
  notes: string | null;
  status: HiringDocumentStatus | null;
  updated_at: string | null;
};

type HiringDocumentEmployeeNoteDbRow = {
  employee_hr_id: string;
  notes: string | null;
};

const validDocumentStatuses = new Set<HiringDocumentStatus>(["pending", "submitted", "missing"]);
const HIRING_DOCUMENTS_CACHE_TTL_MS = 30_000;
let hiringDocumentsDashboardCache: { data: HiringDocumentsDashboardData; timestamp: number } | null = null;

function invalidateHiringDocumentsDashboardCache() {
  hiringDocumentsDashboardCache = null;
}

function cleanText(value: string | null | undefined) {
  const text = value?.trim();
  return text ? text : null;
}

function normalizeHrId(value: string | null | undefined) {
  return canonicalHrIdForDisplay(value);
}

/**
 * Whose documents this checklist tracks: the people Phoenix currently employs.
 *
 * This used to carry its own status list — {active, on_leave, resigned, terminated, inactive} —
 * which put 44 resigned and 2 terminated people into the checklist alongside the 112 current staff,
 * 158 rows in total. /hiring-pack meanwhile excluded only "resigned", so the two screens disagreed
 * by 46 people about who works here. Owner decision 2026-08-24: both show current staff.
 *
 * Deliberately the shared predicate rather than a third hand-written list. An unset status counts
 * as current, which is what isTerminalEmploymentStatus already says — a legacy row with no status
 * must not silently vanish from a compliance checklist.
 */
function isVisibleEmployee(row: EmployeeDbRow) {
  return Boolean(
    row.hr_id && cleanText(row.full_name) && !isTerminalEmploymentStatus(row.employment_status),
  );
}

function isSchemaMissingMessage(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("could not find the table") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist")) ||
    (normalized.includes("column") && normalized.includes("does not exist"))
  );
}

export function hiringDocumentsErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isHiringDocumentsSchemaMissing(error: unknown) {
  return isSchemaMissingMessage(hiringDocumentsErrorMessage(error));
}

function toDefinition(row: HiringDocumentDefinitionDbRow): HiringDocumentDefinition {
  return {
    createdAt: row.created_at,
    description: row.description,
    displayOrder: row.display_order,
    id: row.id,
    // Defaults to false for a row written before the column existed: an unflagged document is an
    // onboarding document, which is what every one of them was until 2026-09-29.
    isExitDocument: row.is_exit_document === true,
    // "required" for a row written before the column existed, and for anything unrecognised: the
    // first band is where the list already starts, so an unknown value shows up rather than
    // disappearing off the sheet.
    documentGroup:
      row.document_group === "onboarding" || row.document_group === "offboarding"
        ? row.document_group
        : "required",
    sheetHeader: row.sheet_header ?? null,
    name: row.name,
  };
}

async function loadLines(lineIds: number[]) {
  const uniqueIds = Array.from(new Set(lineIds));
  if (uniqueIds.length === 0) return new Map<number, string>();

  const { data, error } = await getSupabaseAdmin()
    .from("lines")
    .select("id,name")
    .in("id", uniqueIds);

  if (error) throw new Error(error.message);

  return new Map((data as LineDbRow[]).map((row) => [row.id, row.name ?? ""]));
}

/** Resolve HR_IDs to the display name shown in the UI. Used for managers and for file uploaders. */
/** Who to record as the actor. Same resolution order the vacation and payroll services use. */
function hiringAuditActor(access: AccessContext) {
  return access.loginId ?? resolveEmployeeIdentityId(access) ?? "system";
}

/**
 * The names behind the two ids an audit row would otherwise carry alone.
 *
 * A line reading "b7f1c8e2-… for B-106" answers nothing a year later, and the owner's standing rule
 * is that a human-facing surface shows names rather than codes — the Audit Log page is one. Both
 * lookups are by primary key and run concurrently, so this costs one round trip rather than two.
 *
 * It never throws. It runs AFTER the mutation has already landed, so a failure here must not turn a
 * completed write into an error; the ids are a poor label but an honest one.
 */
async function describeHiringDocumentTarget(employeeHrId: string | null, documentId: string | null) {
  try {
    const [names, definition] = await Promise.all([
      employeeHrId ? loadEmployeeDisplayNames([employeeHrId]) : Promise.resolve(new Map<string, string>()),
      documentId
        ? getSupabaseAdmin().from("hiring_document_definitions").select("name").eq("id", documentId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    return {
      documentName: (definition?.data as { name?: string } | null)?.name ?? documentId,
      employeeName: employeeHrId ? names.get(employeeHrId) ?? employeeHrId : null,
    };
  } catch {
    return { documentName: documentId, employeeName: employeeHrId };
  }
}

async function loadEmployeeDisplayNames(hrIds: string[]) {
  const uniqueHrIds = Array.from(new Set(hrIds.map(normalizeHrId).filter(Boolean))) as string[];
  const result = new Map<string, string>();
  if (uniqueHrIds.length === 0) return result;

  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — this dashboard is company-wide, so batch.
  for (let i = 0; i < uniqueHrIds.length; i += 100) {
    const batch = uniqueHrIds.slice(i, i + 100);
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id,full_name,nickname")
      .in("hr_id", batch);

    if (error) throw new Error(error.message);

    for (const row of data as Array<{ full_name: string | null; hr_id: string; nickname: string | null }>) {
      const key = normalizeHrId(row.hr_id) ?? "";
      result.set(key, resolveEmployeeDisplayName(row.full_name ?? "", row.nickname));
    }
  }
  return result;
}

async function loadDocumentDefinitions() {
  const { data, error } = await getSupabaseAdmin()
    .from("hiring_document_definitions")
    .select("id,name,description,display_order,created_at,is_exit_document,document_group,sheet_header")
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) throw new Error(error.message);

  return (data as HiringDocumentDefinitionDbRow[]).map(toDefinition);
}

function defaultEntry(documentId: string): HiringDocumentEntry {
  return {
    documentId,
    dueDate: null,
    fileCount: 0,
    notes: null,
    status: "pending",
    updatedAt: null,
  };
}

function pairKey(employeeHrId: string, documentId: string) {
  return `${employeeHrId}::${documentId}`;
}

function summarize(employees: HiringDocumentEmployeeRow[], documents: HiringDocumentDefinition[]) {
  return summarizeHiringDocumentReadiness(employees, documents);
}

export async function getHiringDocumentsDashboard(): Promise<HiringDocumentsDashboardData> {
  const now = Date.now();
  if (
    hiringDocumentsDashboardCache &&
    now - hiringDocumentsDashboardCache.timestamp < HIRING_DOCUMENTS_CACHE_TTL_MS
  ) {
    return hiringDocumentsDashboardCache.data;
  }

  const supabase = getSupabaseAdmin();
  const [employeeResult, documents] = await Promise.all([
    supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title,hire_date,employment_status,line_id,manager_hr_id")
      .order("full_name", { ascending: true }),
    loadDocumentDefinitions(),
  ]);
  const { data: employeeData, error: employeeError } = employeeResult;

  if (employeeError) throw new Error(employeeError.message);

  const employeeRows = (employeeData as EmployeeDbRow[]).filter(isVisibleEmployee);
  const employeeHrIds = employeeRows.map((row) => normalizeHrId(row.hr_id) ?? "").filter(Boolean);
  const [lineNames, managerNames] = await Promise.all([
    loadLines(employeeRows.map((row) => row.line_id).filter((value): value is number => typeof value === "number")),
    loadEmployeeDisplayNames(employeeRows.map((row) => row.manager_hr_id).filter(Boolean) as string[]),
  ]);

  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — employeeHrIds is company-wide here, so batch both lookups.
  const statusRows: HiringDocumentStatusDbRow[] = [];
  const noteRows: HiringDocumentEmployeeNoteDbRow[] = [];
  const fileCounts = new Map<string, number>();
  // The file table ships in a migration that is applied AFTER the code deploys. Until then every
  // read of it errors, and the whole checklist — which worked perfectly well before files existed —
  // would go down with it. So the first schema-missing answer turns the lookup off for the rest of
  // the pass instead of throwing, and instead of paying for one failing Atlantic round trip per
  // batch. A real error (permissions, a network fault) still throws: only "this table does not
  // exist yet" is treated as an expected state.
  let fileTableReady = true;
  for (let i = 0; i < employeeHrIds.length; i += 100) {
    const batch = employeeHrIds.slice(i, i + 100);
    const [statusData, noteData, fileData] = await Promise.all([
      supabase
        .from("hiring_document_statuses")
        .select("employee_hr_id,document_id,status,due_date,notes,updated_at")
        .in("employee_hr_id", batch),
      supabase
        .from("hiring_document_employee_notes")
        .select("employee_hr_id,notes")
        .in("employee_hr_id", batch),
      fileTableReady
        ? supabase.from("hiring_document_files").select("employee_hr_id,document_id").in("employee_hr_id", batch)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (statusData.error) throw new Error(statusData.error.message);
    if (noteData.error) throw new Error(noteData.error.message);
    statusRows.push(...((statusData.data ?? []) as HiringDocumentStatusDbRow[]));
    noteRows.push(...((noteData.data ?? []) as HiringDocumentEmployeeNoteDbRow[]));

    if (fileData.error) {
      if (!isSchemaMissingMessage(fileData.error.message)) throw new Error(fileData.error.message);
      fileTableReady = false;
    } else {
      for (const row of (fileData.data ?? []) as Array<{ document_id: string; employee_hr_id: string }>) {
        const key = pairKey(normalizeHrId(row.employee_hr_id) ?? "", row.document_id);
        fileCounts.set(key, (fileCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const documentIds = new Set(documents.map((document) => document.id));
  const statusByEmployee = new Map<string, Record<string, HiringDocumentEntry>>();
  for (const row of statusRows) {
    const hrId = normalizeHrId(row.employee_hr_id) ?? "";
    if (!documentIds.has(row.document_id)) continue;
    const status = row.status && validDocumentStatuses.has(row.status) ? row.status : "pending";
    const entries = statusByEmployee.get(hrId) ?? {};
    entries[row.document_id] = {
      documentId: row.document_id,
      dueDate: row.due_date,
      fileCount: fileCounts.get(pairKey(hrId, row.document_id)) ?? 0,
      notes: row.notes,
      status,
      updatedAt: row.updated_at,
    };
    statusByEmployee.set(hrId, entries);
  }

  const notesByEmployee = new Map(
    noteRows.map((row) => [normalizeHrId(row.employee_hr_id) ?? "", row.notes]),
  );

  const employees = employeeRows.map((row) => {
    const hrId = normalizeHrId(row.hr_id) ?? "";
    const documentsById: Record<string, HiringDocumentEntry> = {};
    for (const document of documents) {
      const entry = statusByEmployee.get(hrId)?.[document.id];
      // The fallback carries the file count too. A pair with files but no status row should not
      // exist — attaching a file always writes one — but if it ever does, the cell that shows
      // "nothing filed" would be the single most misleading thing on the page.
      documentsById[document.id] = entry ?? {
        ...defaultEntry(document.id),
        fileCount: fileCounts.get(pairKey(hrId, document.id)) ?? 0,
      };
    }

    return {
      documents: documentsById,
      employmentStatus: row.employment_status,
      fullName: resolveEmployeeDisplayName(row.full_name ?? "", row.nickname),
      hireDate: row.hire_date,
      hrId,
      jobTitle: row.job_title,
      lineName: row.line_id ? lineNames.get(row.line_id) ?? null : null,
      managerHrId: row.manager_hr_id,
      managerName: row.manager_hr_id ? managerNames.get(normalizeHrId(row.manager_hr_id) ?? "") ?? null : null,
      notes: notesByEmployee.get(hrId) ?? null,
    };
  });

  const result = {
    documents,
    employees,
    summary: summarize(employees, documents),
  };
  hiringDocumentsDashboardCache = { data: result, timestamp: now };
  return result;
}

/**
 * Who may change the checklist ITSELF (add or remove a tracked document, company-wide). The HR
 * Operations Specialist receives the papers (owner, 2026-11-02, "Receive the hiring papers"); what
 * the checklist asks of everybody stays with the seats that held it before.
 */
export function mayEditHiringChecklist(access: Pick<AccessContext, "role">): boolean {
  return access.role !== "HR Administration";
}

function assertMayEditHiringChecklist(access: AccessContext) {
  if (!mayEditHiringChecklist(access)) {
    throw new Error(`Forbidden: ${access.role} does not change the hiring documents checklist.`);
  }
}

export async function createHiringDocumentDefinition(
  access: AccessContext,
  input: CreateHiringDocumentDefinitionInput,
) {
  assertMayEditHiringChecklist(access);
  const name = cleanText(input.name);
  if (!name) throw new Error("Document name is required.");

  const supabase = getSupabaseAdmin();
  const { data: maxRows, error: maxError } = await supabase
    .from("hiring_document_definitions")
    .select("display_order")
    .eq("is_active", true)
    .order("display_order", { ascending: false })
    .limit(1);

  if (maxError) throw new Error(maxError.message);

  const nextOrder = ((maxRows?.[0] as { display_order?: number } | undefined)?.display_order ?? 0) + 10;
  const { data: created, error } = await supabase
    .from("hiring_document_definitions")
    .insert({
      description: cleanText(input.description),
      display_order: nextOrder,
      name,
    })
    .select("id")
    .maybeSingle();

  if (error) throw new Error(error.message);
  invalidateHiringDocumentsDashboardCache();

  await writeRequiredAuditLog({
    actorLoginId: hiringAuditActor(access),
    entityId: (created as { id?: string } | null)?.id ?? null,
    entityType: "hiring_document_definition",
    newValues: { description: cleanText(input.description), displayOrder: nextOrder, name },
    oldValues: {},
    summary: `Hiring document "${name}" added to the checklist.`,
  });
}

export async function deleteHiringDocumentDefinition(access: AccessContext, documentId: string) {
  assertMayEditHiringChecklist(access);
  const id = cleanText(documentId);
  if (!id) throw new Error("Document id is required.");

  const supabase = getSupabaseAdmin();
  // Read the name BEFORE the soft delete. This is an UPDATE, not a DELETE, so the row survives —
  // but nothing in the payload says which document left the checklist, and a retired definition is
  // filtered out of every later read, so afterwards the name is only recoverable by id lookup.
  const { data: existing, error: readError } = await supabase
    .from("hiring_document_definitions")
    .select("is_active,name")
    .eq("id", id)
    .maybeSingle();

  if (readError) throw new Error(readError.message);
  const before = existing as { is_active: boolean; name: string | null } | null;

  const { error } = await supabase
    .from("hiring_document_definitions")
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  invalidateHiringDocumentsDashboardCache();

  await writeRequiredAuditLog({
    actorLoginId: hiringAuditActor(access),
    entityId: id,
    entityType: "hiring_document_definition",
    newValues: { isActive: false },
    oldValues: { isActive: before?.is_active ?? null, name: before?.name ?? null },
    summary: `Hiring document "${before?.name ?? id}" removed from the checklist.`,
  });
}

export async function updateHiringDocumentStatus(
  access: AccessContext,
  input: UpdateHiringDocumentStatusInput,
) {
  const employeeHrId = normalizeHrId(input.employeeHrId);
  const documentId = cleanText(input.documentId);
  if (!employeeHrId || !documentId) throw new Error("Employee and document are required.");
  if (!validDocumentStatuses.has(input.status)) throw new Error(`Invalid document status: ${input.status}.`);

  const dueDate = input.status === "missing" ? cleanText(input.dueDate) : null;
  // Before-image. This is an upsert, so after it runs the previous status and deadline are gone —
  // an audit row that cannot say what a value WAS answers only half of what it is asked.
  const { data: existingStatus, error: statusReadError } = await getSupabaseAdmin()
    .from("hiring_document_statuses")
    .select("due_date,notes,status")
    .eq("employee_hr_id", employeeHrId)
    .eq("document_id", documentId)
    .maybeSingle();

  if (statusReadError) throw new Error(statusReadError.message);
  const before = existingStatus as { due_date: string | null; notes: string | null; status: string } | null;

  // An absent `notes` key means "leave the cell alone", not "clear it" — see status-notes.ts. The
  // UI's status payload carries no notes at all, so the previous unconditional write blanked the
  // cell on every Mark submitted, Mark missing and deadline save.
  const nextNotes = resolveHiringDocumentNotes(before?.notes, input.notes);

  const { error } = await getSupabaseAdmin()
    .from("hiring_document_statuses")
    .upsert(
      {
        document_id: documentId,
        due_date: dueDate,
        employee_hr_id: employeeHrId,
        notes: nextNotes,
        status: input.status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "employee_hr_id,document_id" },
    );

  if (error) throw new Error(error.message);
  invalidateHiringDocumentsDashboardCache();

  const target = await describeHiringDocumentTarget(employeeHrId, documentId);
  await writeRequiredAuditLog({
    actorLoginId: hiringAuditActor(access),
    entityId: `${employeeHrId}:${documentId}`,
    entityType: "hiring_document_status",
    newValues: { dueDate, notes: nextNotes, status: input.status },
    oldValues: before ? { dueDate: before.due_date, notes: before.notes, status: before.status } : {},
    summary: `${target.documentName} for ${target.employeeName} set to ${input.status}`
      + `${dueDate ? ` (deadline ${dueDate})` : ""}`
      + `${before ? ` — was ${before.status}${before.due_date ? ` (deadline ${before.due_date})` : ""}` : ""}.`,
  });
}

export async function updateHiringDocumentEmployeeNotes(
  access: AccessContext,
  input: UpdateHiringDocumentNotesInput,
) {
  const employeeHrId = normalizeHrId(input.employeeHrId);
  if (!employeeHrId) throw new Error("Employee is required.");

  // Before-image. This is the write that went unattributed on B-106 (2026-08-23): the note ended up
  // empty, the row's updated_at moved, and nothing anywhere could say what the note had said or who
  // cleared it. Reading the old text first is the whole difference.
  const { data: existingNote, error: noteReadError } = await getSupabaseAdmin()
    .from("hiring_document_employee_notes")
    .select("notes")
    .eq("employee_hr_id", employeeHrId)
    .maybeSingle();

  if (noteReadError) throw new Error(noteReadError.message);
  const previousNotes = (existingNote as { notes: string | null } | null)?.notes ?? null;
  const nextNotes = cleanText(input.notes);

  const { error } = await getSupabaseAdmin()
    .from("hiring_document_employee_notes")
    .upsert(
      {
        employee_hr_id: employeeHrId,
        notes: nextNotes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "employee_hr_id" },
    );

  if (error) throw new Error(error.message);
  invalidateHiringDocumentsDashboardCache();

  const target = await describeHiringDocumentTarget(employeeHrId, null);
  await writeRequiredAuditLog({
    actorLoginId: hiringAuditActor(access),
    entityId: employeeHrId,
    entityType: "hiring_document_note",
    newValues: { notes: nextNotes },
    oldValues: { notes: previousNotes },
    summary: `Hiring notes for ${target.employeeName} ${nextNotes ? "updated" : "cleared"}.`,
  });
}

export function filterHiringDocumentsForAccess(
  dashboard: HiringDocumentsDashboardData,
  access: AccessContext,
): HiringDocumentsDashboardData {
  // Talent Acquisition is the primary user of this dashboard (her recruiting/onboarding
  // tool) and already gets the equivalent company-wide bypass in every sibling HR domain
  // (isCompanyResignationReader, isCompanyContractReader, canSeeAllRecruitment) — without
  // it here she'd fall through to canSeeHrScopedRecord's self-only default and see only
  // her own employee row instead of the company-wide new-hire document checklist.
  //
  // HR Operations gets the same bypass — owner instruction 2026-08-31: every employee must
  // appear to her on this screen, with full read/write. She was falling through to the same
  // self-only default and seeing only her own row (HR-009), which silently contradicted the
  // company scope she already holds for attendance, leave and payroll (see
  // hr-operations-company-scope.test.ts).
  //
  // The HR Operations Specialist too (owner, 2026-11-02): she receives the hiring papers of every
  // joiner, so a self-only board would be an empty desk.
  if (
    access.scope === "system" ||
    access.role === "Super Admin" ||
    access.role === "HR Operations" ||
    access.role === "HR Administration"
  ) {
    return dashboard;
  }

  const employees = dashboard.employees.filter((employee) =>
    canSeeHrScopedRecord(access, {
      employeeHrId: employee.hrId,
      managerHrId: employee.managerHrId,
    }),
  );

  return {
    ...dashboard,
    employees,
    summary: summarize(employees, dashboard.documents),
  };
}

export type HiringDocumentEmployeeSelection = {
  documents: HiringDocumentDefinition[];
  employee: HiringDocumentEmployeeRow | null;
};

/**
 * One person's row off the board, for the employee details panel.
 *
 * IT FILTERS FIRST, ALWAYS — AND THAT IS WHY IT TAKES THE ACCESS CONTEXT RATHER THAN AN ALREADY-
 * FILTERED BOARD. A caller handed a filtered dashboard could just as easily be handed the raw one:
 * by a refactor, by a second call site, by anybody reading `dashboard` and passing what they had.
 * The bug would be invisible — a real person's real documents, returned to somebody who may not see
 * them, with nothing in the response looking wrong. Scoping inside the function means there is no
 * way to call it that skips the boundary.
 *
 * `employee: null` covers all three of "no such HR_ID", "not in your scope" and "not on the
 * checklist", deliberately. Telling them apart would answer, for an id the caller may not see,
 * whether that person exists.
 */
export function selectHiringDocumentEmployee(
  dashboard: HiringDocumentsDashboardData,
  access: AccessContext,
  hrId: string | null | undefined,
): HiringDocumentEmployeeSelection {
  const scoped = filterHiringDocumentsForAccess(dashboard, access);
  const key = normalizeHrId(hrId);
  const employee = key
    ? scoped.employees.find((candidate) => normalizeHrId(candidate.hrId) === key) ?? null
    : null;

  return { documents: scoped.documents, employee };
}

// ─────────────────────────────────────────────────────────────────────────────
// The files behind the ticks
// ─────────────────────────────────────────────────────────────────────────────

type HiringDocumentFileDbRow = {
  content_type: string;
  document_id: string;
  employee_hr_id: string;
  file_name: string;
  id: string;
  page_count: number | null;
  size_bytes: number;
  source: HiringDocumentFileSource | null;
  storage_bucket: string | null;
  storage_path: string;
  uploaded_at: string;
  uploaded_by_hr_id: string | null;
};

const HIRING_DOCUMENT_FILE_COLUMNS =
  "id,employee_hr_id,document_id,storage_bucket,storage_path,file_name,content_type,size_bytes,page_count,source,uploaded_by_hr_id,uploaded_at";

/**
 * The same visibility rule the dashboard applies, for a single employee.
 *
 * `filterHiringDocumentsForAccess` protects the grid by dropping rows the viewer may not see. That
 * is no help at all to a route that is handed one HR_ID or one file id, so this is the gate for
 * every file operation. It lives in the service rather than in each route deliberately: a route
 * that forgets to call a guard is the single most common way a document leaks, and there are four
 * entry points here.
 */
async function assertCanReachEmployeeDocuments(access: AccessContext, employeeHrId: string) {
  if (
    access.scope === "system" ||
    access.role === "Super Admin" ||
    access.role === "HR Operations" ||
    access.role === "HR Administration"
  ) {
    return;
  }

  const { data, error } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,manager_hr_id")
    .eq("hr_id", employeeHrId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const row = data as { hr_id: string; manager_hr_id: string | null } | null;
  // An unknown HR_ID is refused, not treated as "nothing to protect". Answering "no such employee"
  // to anyone who asks turns this route into a way to enumerate who exists.
  const allowed =
    Boolean(row) &&
    canSeeHrScopedRecord(access, { employeeHrId: row!.hr_id, managerHrId: row!.manager_hr_id });

  if (!allowed) {
    throw new Error("Forbidden: you do not have access to this employee's hiring documents.");
  }
}

function toHiringDocumentFile(row: HiringDocumentFileDbRow, uploaderNames: Map<string, string>): HiringDocumentFile {
  const uploadedByHrId = normalizeHrId(row.uploaded_by_hr_id);
  return {
    contentType: row.content_type,
    documentId: row.document_id,
    employeeHrId: normalizeHrId(row.employee_hr_id) ?? row.employee_hr_id,
    fileName: row.file_name,
    id: row.id,
    pageCount: row.page_count,
    sizeBytes: row.size_bytes,
    // THREE VALUES, NOT TWO. A binary `=== "scan" ? … : "upload"` would read every issued paper
    // back as "Uploaded as-is" — the row would be correct in the database and wrong on every
    // screen, which is the narrowing this codebase has been bitten by before.
    source: readHiringDocumentFileSource(row.source),
    uploadedAt: row.uploaded_at,
    uploadedByHrId,
    uploadedByName: uploadedByHrId ? uploaderNames.get(uploadedByHrId) ?? null : null,
  };
}

/** Every file on record for one employee × document pair, newest first. */
export async function listHiringDocumentFiles(
  access: AccessContext,
  input: { documentId: string; employeeHrId: string },
): Promise<HiringDocumentFile[]> {
  const employeeHrId = normalizeHrId(input.employeeHrId);
  const documentId = cleanText(input.documentId);
  if (!employeeHrId || !documentId) throw new Error("Employee and document are required.");

  await assertCanReachEmployeeDocuments(access, employeeHrId);

  const { data, error } = await getSupabaseAdmin()
    .from("hiring_document_files")
    .select(HIRING_DOCUMENT_FILE_COLUMNS)
    .eq("employee_hr_id", employeeHrId)
    .eq("document_id", documentId)
    .order("uploaded_at", { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as HiringDocumentFileDbRow[];
  const uploaderNames = await loadEmployeeDisplayNames(
    rows.map((row) => row.uploaded_by_hr_id).filter(Boolean) as string[],
  );

  return rows.map((row) => toHiringDocumentFile(row, uploaderNames));
}

/**
 * Store one or more pages against a hiring document, and tick the checklist.
 *
 * `mode: "scan"` is the CamScanner path — every page is polished and the whole set becomes ONE PDF,
 * because a birth certificate photographed as three pages is one document, and filing it as three
 * files makes "is this complete?" unanswerable. `mode: "upload"` stores each file exactly as it
 * arrived, because a scanner's own PDF and a photo of a page are already what they are.
 *
 * Storage is written before the database row, so a failure between the two leaves an orphan object
 * rather than a row pointing at nothing. The rollback below removes those objects — a row that
 * promises a certificate and cannot produce it is far worse than a few stray bytes in a bucket.
 */
export async function attachHiringDocumentFiles(
  access: AccessContext,
  input: AttachHiringDocumentFilesInput,
): Promise<HiringDocumentFile[]> {
  const employeeHrId = normalizeHrId(input.employeeHrId);
  const documentId = cleanText(input.documentId);
  if (!employeeHrId || !documentId) throw new Error("Employee and document are required.");
  if (input.pages.length === 0) throw new Error("Choose at least one file or photograph to attach.");

  await assertCanReachEmployeeDocuments(access, employeeHrId);

  const supabase = getSupabaseAdmin();
  // The foreign key would catch an unknown id, but not a RETIRED one. A document HR deleted from
  // the checklist still exists as a soft-deleted row, and accepting a scan against it would file a
  // certificate somewhere nothing will ever show it again.
  const { data: definition, error: definitionError } = await supabase
    .from("hiring_document_definitions")
    .select("id,is_active")
    .eq("id", documentId)
    .maybeSingle();

  if (definitionError) throw new Error(definitionError.message);
  if (!definition || (definition as { is_active: boolean }).is_active !== true) {
    throw new Error("That hiring document is no longer on the checklist.");
  }

  const pending: Array<{
    contentType: string;
    fileName: string;
    bytes: Buffer;
    pageCount: number | null;
  }> = [];

  if (input.mode === "scan") {
    // Validate every page BEFORE spending CPU on polishing any of them: a rejected fourth page
    // should not cost three polish passes, and it certainly should not leave a half-assembled PDF.
    for (const page of input.pages) {
      assertHiringDocumentFileAllowed({ contentType: page.contentType, size: page.bytes.length });
    }

    const scan = await scanPagesToPdf({
      mode: input.scanMode,
      pages: input.pages.map((page) => ({ bytes: page.bytes, mimeType: page.contentType })),
    });

    assertHiringDocumentFileAllowed({ contentType: "application/pdf", size: scan.bytes.length });
    pending.push({
      bytes: scan.bytes,
      contentType: "application/pdf",
      fileName: buildScanFileName(input.pages[0]?.fileName ?? null),
      pageCount: scan.pageCount,
    });
  } else {
    for (const page of input.pages) {
      assertHiringDocumentFileAllowed({ contentType: page.contentType, size: page.bytes.length });
      pending.push({
        bytes: page.bytes,
        contentType: page.contentType.trim().toLowerCase(),
        fileName: page.fileName,
        pageCount: page.pageCount ?? null,
      });
    }
  }

  const uploadedPaths: string[] = [];
  try {
    const rows: Array<Record<string, string | number | null>> = [];
    for (const file of pending) {
      const path = buildHiringDocumentFilePath({ documentId, employeeHrId, fileName: file.fileName });
      await uploadHiringDocumentFile({ bytes: file.bytes, contentType: file.contentType, path });
      uploadedPaths.push(path);
      rows.push({
        content_type: file.contentType,
        document_id: documentId,
        employee_hr_id: employeeHrId,
        file_name: file.fileName,
        page_count: file.pageCount,
        size_bytes: file.bytes.length,
        source: input.mode,
        storage_bucket: HIRING_DOCUMENTS_BUCKET,
        storage_path: path,
        uploaded_by_hr_id: normalizeHrId(input.uploadedByHrId),
      });
    }

    const { data, error } = await supabase
      .from("hiring_document_files")
      .insert(rows)
      .select(HIRING_DOCUMENT_FILE_COLUMNS);

    if (error) throw new Error(error.message);

    // The evidence arriving IS the document being submitted. Leaving the cell on "pending" after a
    // certificate has been filed would mean HR has to remember to tick it separately, and the whole
    // point of this feature is that the checklist stops depending on anyone's memory. A caller filing
    // only PART of the document says so (`markSubmitted: false`), and the cell keeps its state.
    const markedSubmitted = input.markSubmitted !== false;
    if (markedSubmitted) await markHiringDocumentSubmitted(employeeHrId, documentId);

    const inserted = (data ?? []) as HiringDocumentFileDbRow[];
    const uploaderNames = await loadEmployeeDisplayNames(
      inserted.map((row) => row.uploaded_by_hr_id).filter(Boolean) as string[],
    );
    invalidateHiringDocumentsDashboardCache();

    // One row for the whole attachment, not one per page: a four-page scan is a single act. The
    // implicit tick from markHiringDocumentSubmitted is recorded here rather than as its own row,
    // because it is a consequence of this action and not a separate decision by anyone.
    const target = await describeHiringDocumentTarget(employeeHrId, documentId);
    await writeRequiredAuditLog({
      actorLoginId: hiringAuditActor(access),
      entityId: `${employeeHrId}:${documentId}`,
      entityType: "hiring_document_file",
      newValues: {
        fileNames: inserted.map((row) => row.file_name),
        markedSubmitted,
        mode: input.mode,
        totalBytes: inserted.reduce((sum, row) => sum + (row.size_bytes ?? 0), 0),
      },
      oldValues: {},
      summary: `${inserted.length} file(s) filed against ${target.documentName} for ${target.employeeName}`
        + ` by ${input.mode}${markedSubmitted ? ", and the checklist ticked." : ", with the checklist left as it was."}`,
    });

    return inserted.map((row) => toHiringDocumentFile(row, uploaderNames));
  } catch (error) {
    await removeHiringDocumentFiles(uploadedPaths);
    throw error;
  }
}

/**
 * Delete one stored file, and un-tick the checklist if it was the last one.
 *
 * The revert is the part worth being deliberate about. A cell that still reads "submitted" with no
 * file behind it is a lie the system tells itself, and it is exactly the state this feature exists
 * to eliminate. It reverts to `pending` rather than `missing`: `missing` carries a deadline and
 * means "we asked and it has not come", which is a claim nobody made by deleting a bad scan.
 *
 * A cell ticked by hand before files existed keeps its tick — there is nothing to un-tick, because
 * this only fires when a file that DID exist has just been removed.
 */
export async function removeHiringDocumentFile(access: AccessContext, fileId: string) {
  const id = cleanText(fileId);
  if (!id) throw new Error("File id is required.");

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("hiring_document_files")
    .select("id,employee_hr_id,document_id,storage_path,file_name,size_bytes")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  const row = data as
    | {
      document_id: string;
      employee_hr_id: string;
      file_name: string | null;
      id: string;
      size_bytes: number | null;
      storage_path: string;
    }
    | null;
  if (!row) throw new Error("That file is no longer on record.");

  const employeeHrId = normalizeHrId(row.employee_hr_id) ?? row.employee_hr_id;
  await assertCanReachEmployeeDocuments(access, employeeHrId);

  const { error: deleteError } = await supabase.from("hiring_document_files").delete().eq("id", id);
  if (deleteError) throw new Error(deleteError.message);

  // The row goes first and the object second. If the object delete fails, what is left is an
  // unreferenced blob in a private bucket — invisible, and removable later. The other order would
  // leave a row promising a file that no longer exists, which is what a user actually notices.
  await removeHiringDocumentFiles([row.storage_path]);

  const { count, error: countError } = await supabase
    .from("hiring_document_files")
    .select("id", { count: "exact", head: true })
    .eq("employee_hr_id", employeeHrId)
    .eq("document_id", row.document_id);

  if (countError) throw new Error(countError.message);

  const revertedTick = (count ?? 0) === 0;
  if (revertedTick) {
    const { error: statusError } = await supabase
      .from("hiring_document_statuses")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("employee_hr_id", employeeHrId)
      .eq("document_id", row.document_id)
      .eq("status", "submitted");

    if (statusError) throw new Error(statusError.message);
  }

  invalidateHiringDocumentsDashboardCache();

  // Destroying evidence is the single most important thing in this module to be able to attribute:
  // the bytes are gone from the bucket and the row is gone from the table, so this audit line is
  // the only surviving trace that the file ever existed.
  const target = await describeHiringDocumentTarget(employeeHrId, row.document_id);
  await writeRequiredAuditLog({
    actorLoginId: hiringAuditActor(access),
    entityId: `${employeeHrId}:${row.document_id}`,
    entityType: "hiring_document_file",
    newValues: { remainingFiles: count ?? 0, revertedToPending: revertedTick },
    oldValues: {
      fileId: row.id,
      fileName: row.file_name,
      sizeBytes: row.size_bytes,
      storagePath: row.storage_path,
    },
    summary: `${row.file_name ?? "A file"} deleted from ${target.documentName} for ${target.employeeName}`
      + `${revertedTick ? " — last one, so the checklist tick was reverted to pending" : ""}.`,
  });

  return { documentId: row.document_id, employeeHrId, remainingFiles: count ?? 0 };
}

/** Read one stored file's bytes, behind the same visibility gate as everything else here. */
export async function getHiringDocumentFileForDownload(access: AccessContext, fileId: string) {
  const id = cleanText(fileId);
  if (!id) throw new Error("File id is required.");
  // A malformed id is NOT FOUND, not a fault: this is a uuid column, and Postgres answers a
  // non-uuid with 22P02 from the WHERE clause instead of with no rows, which leaves as a 500.
  // Null is the same answer this gives for a file id that matches no row.
  if (!isUuid(id)) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("hiring_document_files")
    .select("id,employee_hr_id,document_id,storage_path,file_name,content_type")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  const row = data as
    | {
        content_type: string;
        document_id: string;
        employee_hr_id: string;
        file_name: string;
        id: string;
        storage_path: string;
      }
    | null;
  if (!row) return null;

  await assertCanReachEmployeeDocuments(access, normalizeHrId(row.employee_hr_id) ?? row.employee_hr_id);

  // The storage path comes from the row, never from the request. That is the whole containment:
  // the caller names a file id, and only the server knows which object that is.
  const bytes = await downloadHiringDocumentFile(row.storage_path);
  return { bytes, contentType: row.content_type, fileName: row.file_name };
}

/**
 * Upsert the pair to `submitted`, keeping whatever note is on it and clearing the deadline.
 *
 * This existed because `updateHiringDocumentStatus` wrote `notes` straight from its input, so
 * reusing it would blank whatever HR had typed just because a scan arrived. That is fixed — an
 * absent key now leaves the cell alone, see status-notes.ts — so the note is no longer the reason
 * to keep this separate. What is: the tick is a consequence of the scan rather than a decision of
 * its own, so it belongs inside the caller's single `hiring_document_file` audit row and must not
 * raise a second `hiring_document_status` one.
 */
async function markHiringDocumentSubmitted(employeeHrId: string, documentId: string) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("hiring_document_statuses")
    .select("employee_hr_id")
    .eq("employee_hr_id", employeeHrId)
    .eq("document_id", documentId)
    .maybeSingle();

  if (error) throw new Error(error.message);

  const { error: writeError } = data
    ? await supabase
        .from("hiring_document_statuses")
        // due_date is cleared: it only means anything while a document is outstanding, and the
        // document has just arrived.
        .update({ due_date: null, status: "submitted", updated_at: new Date().toISOString() })
        .eq("employee_hr_id", employeeHrId)
        .eq("document_id", documentId)
    : await supabase.from("hiring_document_statuses").insert({
        document_id: documentId,
        employee_hr_id: employeeHrId,
        status: "submitted",
        updated_at: new Date().toISOString(),
      });

  if (writeError) throw new Error(writeError.message);
}

/**
 * Name the assembled PDF after what HR photographed, falling back to a plain name.
 *
 * The original file name from a phone is `IMG_0042.jpg`, which tells nobody anything, so a scan
 * taken with a camera is named for what it is instead. A name HR actually chose — including an
 * Arabic one — is kept; the download route encodes it per RFC 5987 rather than dropping it.
 */
function buildScanFileName(firstPageName: string | null) {
  const base = cleanText(firstPageName)?.replace(/\.[a-z0-9]+$/i, "") ?? "";
  const looksLikeACameraName = /^(img|image|photo|pxl|dsc|screenshot)[-_ ]?\d*$/i.test(base);
  if (!base || looksLikeACameraName) return "scanned-document.pdf";
  return `${base}.pdf`;
}
