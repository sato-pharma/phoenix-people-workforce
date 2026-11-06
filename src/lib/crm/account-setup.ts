/**
 * New-hire CRM account setup — the queue behind the notice.
 *
 * One row per newly created employee, asking a single question: does this person have an
 * iReports360 (CRM) account yet? It ends `completed` (the CRM username and code were entered
 * against the employee) or `not_applicable` (this person holds no CRM account), and both are
 * decisions with a name and a timestamp on them.
 *
 * WHY THIS MATTERS AT ALL. `employees.crm_username` and `employees.crm_id` are how every CRM read
 * resolves a visit or a check-in back to a person (./identity.ts). Both are optional on the
 * employee form, so a new rep is routinely saved without them — and until they are filled his field
 * work lands under an unmapped agent id. Nothing errors, nothing renders empty; he simply reads as
 * somebody who did nothing.
 *
 * EVERY READ AND WRITE HERE DEGRADES IF THE TABLE IS ABSENT. A deploy reaches production before its
 * migration does, and in that window a hard failure would take the whole CRM workspace page down
 * and — worse — would fail an employee save that had already succeeded. So the queue reads empty
 * and opening a task returns a warning; nothing throws.
 */

import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import {
  getEmployeeDirectoryRows,
  setEmployeeCrmIdentity,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { getEmployeeCvFileNames } from "@/lib/employees/employee-cv";
import { isFieldWorkforceComplianceEligibleTitle } from "@/lib/field-workforce-compliance/eligibility";
import { logError } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { CrmAccountSetupSubject } from "@/lib/crm/account-setup-messages";

export const CRM_ACCOUNT_SETUP_TABLE = "crm_account_setup_tasks" as const;

export type CrmAccountSetupStatus = "pending" | "completed" | "not_applicable";
export type CrmAccountSetupSource = "manual_add" | "employee_import";

export type CrmAccountSetupTaskRow = {
  crmId: string | null;
  crmUsername: string | null;
  employeeFound: boolean;
  employmentStatus: string | null;
  id: string;
  openedAt: string;
  resolutionNote: string | null;
  resolvedAt: string | null;
  resolvedByHrId: string | null;
  source: CrmAccountSetupSource;
  status: CrmAccountSetupStatus;
  subject: CrmAccountSetupSubject;
};

export type CrmAccountSetupQueue = {
  pending: CrmAccountSetupTaskRow[];
  recentlyResolved: CrmAccountSetupTaskRow[];
  /** True when the table is not present yet — the UI says so instead of showing an empty queue. */
  schemaMissing: boolean;
};

type TaskDbRow = {
  employee_hr_id?: string | null;
  id?: string | null;
  opened_at?: string | null;
  resolution_note?: string | null;
  resolved_at?: string | null;
  resolved_by_hr_id?: string | null;
  source?: string | null;
  status?: string | null;
};

/**
 * "The table is not there" and nothing else.
 *
 * A missing TABLE answers PGRST205 through PostgREST and 42P01 through the driver — the obvious
 * `42P01`-only guard therefore fires never (AGENTS.md §2.1), so both codes are treated as one set
 * here. A missing COLUMN is deliberately NOT included: that is a code bug and must surface as a
 * real error rather than being read as "not provisioned yet" and silently degrading.
 */
export function isCrmAccountSetupSchemaMissing(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  if (/42703|column .* does not exist|Could not find the .* column/i.test(message)) return false;
  return /crm_account_setup_tasks|PGRST205|42P01|schema cache|does not exist/i.test(message);
}

function statusOf(value: string | null | undefined): CrmAccountSetupStatus {
  return value === "completed" || value === "not_applicable" ? value : "pending";
}

function sourceOf(value: string | null | undefined): CrmAccountSetupSource {
  return value === "employee_import" ? "employee_import" : "manual_add";
}

/**
 * Does this new hire need an iReports360 (CRM) account?
 *
 * Owner's decision, 2026-09-08, narrowing the original rule: FIELD ROLES ONLY. Head office — HR,
 * finance, admin, regulatory, R&D, the CEO — no longer opens a task, because a queue that asks a
 * question with the same answer every time stops being read.
 *
 * DELEGATES to isFieldWorkforceComplianceEligibleTitle rather than restating the titles, on the
 * same reasoning as retention-risk/eligibility.ts: "who is the field commercial workforce" is
 * already decided in one place, and a second copy here would drift from it within a year. That
 * helper is explicitly a non-security business rule, which is exactly what this is — it decides
 * who appears in a work queue, never what anybody may do. It also falls back to
 * `resolveJobFunctionRole`, so a title typed as something other than the canonical string still
 * resolves; a misspelt title hiding a District Manager is the failure this whole feature exists
 * to prevent.
 *
 * A BLANK title counts as IN, deliberately. It means "nobody has said yet", not "head office", and
 * the two cost wildly different things: a wrongly-included person is one click on "No CRM account
 * needed", while a missed rep is field work that lands under an unmapped agent id with no error
 * anywhere. Measured on production 2026-09-08 before choosing this: 2 of 122 active employees have
 * a blank job title, so the noise this admits is two rows, ever.
 *
 * NOT decided on `area_id`. Measured the same day: EVERY head-office employee carries one, because
 * "Head office" is itself an area — so an area test would re-admit all of them and quietly undo
 * the owner's narrowing while looking like a widening safeguard.
 */
export function needsCrmAccount(employee: Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">): boolean {
  const jobTitle = String(employee.jobTitle ?? "").trim();
  const positionTitle = String(employee.positionTitle ?? "").trim();
  if (!jobTitle && !positionTitle) return true;
  return isFieldWorkforceComplianceEligibleTitle(jobTitle, positionTitle);
}

/** The subject shape the notice and the board both render, built from the employee's own row. */
/**
 * `cvFileName` is passed IN rather than read off the directory row, because the employee directory
 * does not carry it — the CV lives on `employees` but the directory's select list is a curated set
 * of columns and widening it would touch every one of its four row builders. Both callers load the
 * names for their whole set in one query (getEmployeeCvFileNames) and hand each subject its own.
 *
 * Optional, so a caller that has no CV information produces a subject that reads "Not attached"
 * rather than one missing the row entirely — see crmAccountSetupDetails on why the row is always
 * present.
 */
export function subjectFromEmployee(
  employee: EmployeeDirectoryRow,
  cvFileName?: string | null,
): CrmAccountSetupSubject {
  return {
    areaName: employee.areaName,
    cvFileName: cvFileName ?? null,
    displayName: employee.displayName || employee.fullName,
    hireDate: employee.hireDate,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    managerName: employee.managerName,
    mobileNumber: employee.mobileNumber,
    regionName: employee.regionName,
    workEmail: employee.workEmail,
  };
}

/** A placeholder subject for a task whose employee row has since gone — the board still shows it. */
function subjectFromHrIdAlone(hrId: string, cvFileName?: string | null): CrmAccountSetupSubject {
  return {
    areaName: null,
    cvFileName: cvFileName ?? null,
    displayName: hrId,
    hireDate: null,
    hrId,
    jobTitle: null,
    lineName: null,
    managerName: null,
    mobileNumber: null,
    regionName: null,
    workEmail: null,
  };
}

/** Every employee, keyed by the folded HR id, so a mixed-case id can never miss its own row. */
async function employeesByKey(): Promise<Map<string, EmployeeDirectoryRow>> {
  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const byKey = new Map<string, EmployeeDirectoryRow>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (key) byKey.set(key, row);
  }
  return byKey;
}

/**
 * Open a pending task for each newly created employee.
 *
 * Idempotent by construction: the table's unique index sits on the FOLDED HR id and this upserts
 * with duplicates ignored, so re-saving the same employee — or an import that lists somebody twice
 * — can never open a second task or reopen a resolved one.
 *
 * Never throws. It is called from inside the employee-create paths, which have already written the
 * employee by the time it runs: a failure here must not turn a successful save into a 500.
 */
export async function openCrmAccountSetupTasks(input: {
  hrIds: Array<string | null | undefined>;
  source: CrmAccountSetupSource;
}): Promise<{ opened: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const stored = Array.from(
    new Map(
      input.hrIds
        .map((hrId) => hrIdForStorage(hrId))
        .filter((hrId): hrId is string => Boolean(hrId && hrId.trim()))
        .map((hrId) => [canonicalHrIdKey(hrId) as string, hrId]),
    ).values(),
  );
  if (stored.length === 0) return { opened: [], warnings };

  try {
    const { error } = await getSupabaseAdmin()
      .from(CRM_ACCOUNT_SETUP_TABLE)
      .upsert(
        stored.map((hrId) => ({ employee_hr_id: hrId, source: input.source, status: "pending" })),
        { ignoreDuplicates: true, onConflict: "employee_hr_id_key" },
      );
    if (error) throw error;
    return { opened: stored, warnings };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (isCrmAccountSetupSchemaMissing(error)) {
      warnings.push("The CRM account setup queue is not provisioned in this environment yet.");
    } else {
      warnings.push(`CRM account setup task could not be opened: ${detail}`.slice(0, 200));
      logError("CRM account setup task could not be opened", {
        labels: { event: "crm_account_setup_open_failed" },
        error: error instanceof Error ? error : new Error(detail),
      });
    }
    return { opened: [], warnings };
  }
}

/**
 * The board's data: everything still pending, plus the last 25 resolved for context.
 *
 * The resolved tail is there so the screen answers "did I already do this one?" without a search —
 * the commonest question a per-hire queue gets asked.
 */
export async function getCrmAccountSetupQueue(): Promise<CrmAccountSetupQueue> {
  let rows: TaskDbRow[] = [];
  try {
    // Paged to the last task, newest first with the id as the tie-break: "everything still pending" cannot sit
    // behind a fixed page, however many hires have been opened.
    rows = await fetchAllRows<TaskDbRow>(
      () =>
        getSupabaseAdmin()
          .from(CRM_ACCOUNT_SETUP_TABLE)
          .select("id,employee_hr_id,status,source,opened_at,resolved_at,resolved_by_hr_id,resolution_note")
          .order("opened_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    if (isCrmAccountSetupSchemaMissing(error)) {
      return { pending: [], recentlyResolved: [], schemaMissing: true };
    }
    throw error;
  }

  const byKey = await employeesByKey();
  // One query for every CV filename on the board, rather than one per card — a round trip per
  // card would be one for every row the queue holds.
  const cvNames = await getEmployeeCvFileNames(rows.map((row) => String(row.employee_hr_id ?? "").trim()));
  const mapped: CrmAccountSetupTaskRow[] = rows.map((row) => {
    const hrId = String(row.employee_hr_id ?? "").trim();
    const employee = byKey.get(canonicalHrIdKey(hrId) ?? "");
    const cvFileName = cvNames.get(canonicalHrIdKey(hrId) ?? "") ?? null;
    return {
      crmId: employee?.crmId ?? null,
      crmUsername: employee?.crmUsername ?? null,
      employeeFound: Boolean(employee),
      employmentStatus: employee?.employmentStatus ?? null,
      id: String(row.id ?? hrId),
      openedAt: String(row.opened_at ?? ""),
      resolutionNote: row.resolution_note ?? null,
      resolvedAt: row.resolved_at ?? null,
      resolvedByHrId: row.resolved_by_hr_id ?? null,
      source: sourceOf(row.source),
      status: statusOf(row.status),
      subject: employee ? subjectFromEmployee(employee, cvFileName) : subjectFromHrIdAlone(hrId, cvFileName),
    };
  });

  return {
    pending: mapped.filter((task) => task.status === "pending"),
    recentlyResolved: mapped.filter((task) => task.status !== "pending").slice(0, 25),
    schemaMissing: false,
  };
}

/** How many people are still waiting for a CRM account. Null means the table is not there yet. */
export async function countPendingCrmAccountSetupTasks(): Promise<number | null> {
  try {
    const { count, error } = await getSupabaseAdmin()
      .from(CRM_ACCOUNT_SETUP_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("status", "pending");
    if (error) throw error;
    return count ?? 0;
  } catch (error) {
    if (isCrmAccountSetupSchemaMissing(error)) return null;
    throw error;
  }
}

async function markTask(input: {
  actorHrId: string | null;
  hrId: string;
  note: string | null;
  status: Exclude<CrmAccountSetupStatus, "pending">;
}) {
  const key = canonicalHrIdKey(input.hrId);
  if (!key) throw new Error("An HR ID is required.");
  const actor = hrIdForStorage(input.actorHrId);
  if (!actor) {
    // The table's own CHECK refuses a resolved row that names nobody; refuse it here too, with a
    // sentence a person can act on rather than a constraint violation.
    throw new Error("The signed-in user has no HR ID, so this decision cannot be recorded against anyone.");
  }

  const { error } = await getSupabaseAdmin()
    .from(CRM_ACCOUNT_SETUP_TABLE)
    .update({
      resolution_note: input.note,
      resolved_at: new Date().toISOString(),
      resolved_by_hr_id: actor,
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .eq("employee_hr_id_key", key);
  if (error) throw error;
}

/**
 * Record the CRM account for this employee and close the task.
 *
 * ORDER MATTERS. The employee row is written FIRST and the task is closed only after it succeeds,
 * so a uniqueness refusal (a CRM id already assigned to somebody else) leaves the task open and the
 * person still on the queue. Closing first would clear the board on a save that never happened.
 *
 * The reverse failure — the employee written, the task not closed — is deliberately swallowed and
 * logged rather than returned as an error. The CRM identity is saved at that point, so reporting a
 * failure would invite the same person to type it in again; the only visible symptom is a task that
 * reappears on the board, which is the harmless direction.
 */
export async function completeCrmAccountSetup(input: {
  actorHrId: string | null;
  crmCode: string | null;
  crmUsername: string | null;
  hrId: string;
}): Promise<{ crmId: string | null; crmUsername: string | null; hrId: string }> {
  const crmUsername = String(input.crmUsername ?? "").trim();
  const crmCode = String(input.crmCode ?? "").trim();
  if (!crmUsername && !crmCode) {
    throw new Error("Enter the CRM username, the CRM code, or both.");
  }

  await setEmployeeCrmIdentity({
    crmId: crmCode || null,
    crmUsername: crmUsername || null,
    hrId: input.hrId,
  });

  try {
    await markTask({ actorHrId: input.actorHrId, hrId: input.hrId, note: null, status: "completed" });
  } catch (error) {
    if (!isCrmAccountSetupSchemaMissing(error)) {
      logError("CRM account setup task could not be closed after the CRM identity was saved", {
        labels: { event: "crm_account_setup_close_failed" },
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  return { crmId: crmCode || null, crmUsername: crmUsername || null, hrId: input.hrId };
}

/** This person holds no CRM account. A reason is required — it is the whole value of the row. */
export async function dismissCrmAccountSetup(input: {
  actorHrId: string | null;
  hrId: string;
  note: string | null;
}): Promise<void> {
  const note = String(input.note ?? "").trim();
  if (!note) {
    throw new Error("Say why this person needs no CRM account.");
  }
  await markTask({ actorHrId: input.actorHrId, hrId: input.hrId, note, status: "not_applicable" });
}
