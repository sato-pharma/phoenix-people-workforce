import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canSeeHrScopedRecord, type AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { summarizeHiringDocumentReadiness } from "@/lib/recruitment/onboarding-metrics";
import type {
  CreateHiringDocumentDefinitionInput,
  HiringDocumentDefinition,
  HiringDocumentEmployeeRow,
  HiringDocumentEntry,
  HiringDocumentsDashboardData,
  HiringDocumentStatus,
  UpdateHiringDocumentNotesInput,
  UpdateHiringDocumentStatusInput,
} from "@/lib/hiring-documents/types";

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

const visibleEmployeeStatuses = new Set(["active", "on_leave", "resigned", "terminated", "inactive"]);
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

function normalizeStatus(value: string | null | undefined) {
  return cleanText(value)?.toLowerCase() ?? "active";
}

function isVisibleEmployee(row: EmployeeDbRow) {
  return Boolean(row.hr_id && cleanText(row.full_name) && visibleEmployeeStatuses.has(normalizeStatus(row.employment_status)));
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

async function loadManagerNames(managerHrIds: string[]) {
  const uniqueHrIds = Array.from(new Set(managerHrIds.map(normalizeHrId).filter(Boolean))) as string[];
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
    .select("id,name,description,display_order,created_at")
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
    notes: null,
    status: "pending",
    updatedAt: null,
  };
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
    loadManagerNames(employeeRows.map((row) => row.manager_hr_id).filter(Boolean) as string[]),
  ]);

  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — employeeHrIds is company-wide here, so batch both lookups.
  const statusRows: HiringDocumentStatusDbRow[] = [];
  const noteRows: HiringDocumentEmployeeNoteDbRow[] = [];
  for (let i = 0; i < employeeHrIds.length; i += 100) {
    const batch = employeeHrIds.slice(i, i + 100);
    const [statusData, noteData] = await Promise.all([
      supabase
        .from("hiring_document_statuses")
        .select("employee_hr_id,document_id,status,due_date,notes,updated_at")
        .in("employee_hr_id", batch),
      supabase
        .from("hiring_document_employee_notes")
        .select("employee_hr_id,notes")
        .in("employee_hr_id", batch),
    ]);
    if (statusData.error) throw new Error(statusData.error.message);
    if (noteData.error) throw new Error(noteData.error.message);
    statusRows.push(...((statusData.data ?? []) as HiringDocumentStatusDbRow[]));
    noteRows.push(...((noteData.data ?? []) as HiringDocumentEmployeeNoteDbRow[]));
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
      documentsById[document.id] = statusByEmployee.get(hrId)?.[document.id] ?? defaultEntry(document.id);
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

export async function createHiringDocumentDefinition(input: CreateHiringDocumentDefinitionInput) {
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
  const { error } = await supabase
    .from("hiring_document_definitions")
    .insert({
      description: cleanText(input.description),
      display_order: nextOrder,
      name,
    });

  if (error) throw new Error(error.message);
  invalidateHiringDocumentsDashboardCache();
}

export async function deleteHiringDocumentDefinition(documentId: string) {
  const id = cleanText(documentId);
  if (!id) throw new Error("Document id is required.");

  const { error } = await getSupabaseAdmin()
    .from("hiring_document_definitions")
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw new Error(error.message);
  invalidateHiringDocumentsDashboardCache();
}

export async function updateHiringDocumentStatus(input: UpdateHiringDocumentStatusInput) {
  const employeeHrId = normalizeHrId(input.employeeHrId);
  const documentId = cleanText(input.documentId);
  if (!employeeHrId || !documentId) throw new Error("Employee and document are required.");
  if (!validDocumentStatuses.has(input.status)) throw new Error(`Invalid document status: ${input.status}.`);

  const dueDate = input.status === "missing" ? cleanText(input.dueDate) : null;
  const { error } = await getSupabaseAdmin()
    .from("hiring_document_statuses")
    .upsert(
      {
        document_id: documentId,
        due_date: dueDate,
        employee_hr_id: employeeHrId,
        notes: cleanText(input.notes),
        status: input.status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "employee_hr_id,document_id" },
    );

  if (error) throw new Error(error.message);
  invalidateHiringDocumentsDashboardCache();
}

export async function updateHiringDocumentEmployeeNotes(input: UpdateHiringDocumentNotesInput) {
  const employeeHrId = normalizeHrId(input.employeeHrId);
  if (!employeeHrId) throw new Error("Employee is required.");

  const { error } = await getSupabaseAdmin()
    .from("hiring_document_employee_notes")
    .upsert(
      {
        employee_hr_id: employeeHrId,
        notes: cleanText(input.notes),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "employee_hr_id" },
    );

  if (error) throw new Error(error.message);
  invalidateHiringDocumentsDashboardCache();
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
  if (access.scope === "system" || access.role === "Super Admin" || access.role === "Talent Acquisition") {
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
