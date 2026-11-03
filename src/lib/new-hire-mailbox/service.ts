/**
 * New hire mailboxes — the queue behind the notice, and the one action that clears it.
 *
 * Owner instruction 2026-09-18: when an employee is added, their company email is taken care of
 * without the new hire doing anything. One row per new hire asks whether their Turbify mailbox has
 * been created and handed to Phoenix. It ends `connected` (Turbify accepted an app password for the
 * address, it is sealed under the hire's own login, and the address is on their employee record) or
 * `not_needed` (a named person ruled this hire gets no mailbox, with a reason).
 *
 * WHY A PERSON STILL DOES THE MIDDLE. Turbify publishes no API that creates a mailbox or an app
 * password; both exist only as buttons in its own screens (checked against its help pages the same
 * day). So whoever holds the Turbify admin login spends two minutes there, and everything either
 * side of that — choosing the address, telling them, checking the password with Turbify, storing it,
 * filling in the employee record — is Phoenix's.
 *
 * THIS TABLE HOLDS NO CREDENTIAL. The app password goes straight to the personal-mailbox service,
 * which seals it; nothing here keeps, logs or returns it.
 *
 * EVERY READ AND WRITE DEGRADES IF THE TABLE IS ABSENT, as in crm/account-setup.ts: a deploy can
 * reach production before its migration does, and an employee save that already succeeded must
 * never fail because a queue is missing.
 */

import { employeeLeftFlag, type EmployeeLeftFlag } from "@/lib/employees/left-flag";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import {
  getEmployeeDirectoryRows,
  setEmployeeWorkEmail,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { logError } from "@/lib/observability/log";
import { connectNewHireMailbox } from "@/lib/personal-mailbox/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { COMPANY_MAIL_DOMAIN, isCompanyAddress } from "@/lib/new-hire-mailbox/address";
import type { NewHireMailboxSubject } from "@/lib/new-hire-mailbox/messages";

export const NEW_HIRE_MAILBOX_TABLE = "new_hire_mailbox_tasks" as const;

export type NewHireMailboxStatus = "pending" | "connected" | "not_needed";
export type NewHireMailboxSource = "manual_add" | "employee_import";

/** A refusal a person can act on. The route returns its message as-is. */
export class NewHireMailboxError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "NewHireMailboxError";
    this.statusCode = statusCode;
  }
}

export type NewHireMailboxTask = {
  /** Set when they have left or declined, which closes nothing: HR still dismisses the task. */
  employeeLeft: EmployeeLeftFlag | null;
  employeeFound: boolean;
  /** False when the hire has no active Phoenix login yet: connecting would be refused. */
  hasLogin: boolean;
  id: string;
  openedAt: string;
  resolutionNote: string | null;
  resolvedAt: string | null;
  /** The NAME of whoever closed it, never their code. */
  resolvedByName: string | null;
  source: NewHireMailboxSource;
  status: NewHireMailboxStatus;
  subject: NewHireMailboxSubject;
};

export type NewHireMailboxQueue = {
  pending: NewHireMailboxTask[];
  recentlyResolved: NewHireMailboxTask[];
  /** True when the table is not there yet: the page says so instead of showing an empty queue. */
  schemaMissing: boolean;
};

type TaskDbRow = {
  email_address?: string | null;
  employee_hr_id?: string | null;
  id?: string | null;
  opened_at?: string | null;
  resolution_note?: string | null;
  resolved_at?: string | null;
  resolved_by_hr_id?: string | null;
  source?: string | null;
  status?: string | null;
};

const TASK_COLUMNS =
  "id,employee_hr_id,email_address,status,source,opened_at,resolved_at,resolved_by_hr_id,resolution_note";

/**
 * "The table is not there" and nothing else: PGRST205 through PostgREST, 42P01 through the driver.
 * A missing COLUMN is a code bug and must surface, so it is excluded.
 */
export function isNewHireMailboxSchemaMissing(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  if (/42703|column .* does not exist|Could not find the .* column/i.test(message)) return false;
  return /new_hire_mailbox_tasks|PGRST205|42P01|schema cache|does not exist/i.test(message);
}

function statusOf(value: string | null | undefined): NewHireMailboxStatus {
  return value === "connected" || value === "not_needed" ? value : "pending";
}

function sourceOf(value: string | null | undefined): NewHireMailboxSource {
  return value === "employee_import" ? "employee_import" : "manual_add";
}

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

export function subjectFromEmployee(employee: EmployeeDirectoryRow, emailAddress: string | null): NewHireMailboxSubject {
  return {
    displayName: employee.displayName || employee.fullName,
    emailAddress,
    hireDate: employee.hireDate,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
  };
}

function byKey(rows: EmployeeDirectoryRow[]): Map<string, EmployeeDirectoryRow> {
  const map = new Map<string, EmployeeDirectoryRow>();
  for (const row of rows) {
    const key = canonicalHrIdKey(row.hrId);
    if (key) map.set(key, row);
  }
  return map;
}

async function readTasks(): Promise<TaskDbRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(NEW_HIRE_MAILBOX_TABLE)
    .select(TASK_COLUMNS)
    .order("opened_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as TaskDbRow[];
}

/**
 * Open a pending task for each new hire, with the address Phoenix proposes for them.
 *
 * Idempotent: the unique index sits on the folded HR id and duplicates are ignored, so saving the
 * same employee again can never open a second task or reopen a closed one. An address another hire
 * was already given is never proposed twice; if one slips through a race, the task opens with no
 * address and the person creating the mailbox types it.
 *
 * Never throws: it runs after the employee has been written.
 */
export async function openNewHireMailboxTasks(input: {
  everyone: EmployeeDirectoryRow[];
  hires: EmployeeDirectoryRow[];
  source: NewHireMailboxSource;
}): Promise<{ opened: NewHireMailboxSubject[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (input.hires.length === 0) return { opened: [], warnings };

  const taken = new Set<string>();
  for (const row of input.everyone) {
    const address = lower(row.workEmail);
    if (address) taken.add(address);
  }
  try {
    for (const task of await readTasks()) {
      if (task.status !== "not_needed" && task.email_address) taken.add(lower(task.email_address));
    }
  } catch (error) {
    if (isNewHireMailboxSchemaMissing(error)) {
      warnings.push("The new hire mailbox queue is not provisioned in this environment yet.");
      return { opened: [], warnings };
    }
    // Carry on: the table's own unique index still refuses a duplicate address below.
  }

  const opened: NewHireMailboxSubject[] = [];
  const seen = new Set<string>();
  for (const hire of input.hires) {
    const key = canonicalHrIdKey(hire.hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    // 🔴 THE TYPED ADDRESS, OR NONE AT ALL (owner, 2026-10-03): "I will enter the email of the hired
    // in the employee master in his record, you take what I enter and make his email with it."
    //
    // A derived address is not a convenience here — it is the thing that creates a real mailbox at
    // the wrong address. "El Sayed Rady" became `el.sayed@satopharma.com` because the generator took
    // the first two words as first.last, but "Elsayed" is one word and his whole first name. The
    // mailbox was created on the live domain before anyone could read the register.
    //
    // So a hire saved without a company work email opens with NO address, and waits. The Employee
    // Master's own field now types the local part against a fixed @satopharma.com, so there is one
    // place that address comes from and nothing invents one.
    const typed = String(hire.workEmail ?? "").trim().toLowerCase();
    const proposed = isCompanyAddress(typed) && !taken.has(typed) ? typed : null;
    const row = {
      email_address: proposed,
      employee_hr_id: hrIdForStorage(hire.hrId),
      source: input.source,
      status: "pending",
    };
    try {
      let { error } = await getSupabaseAdmin()
        .from(NEW_HIRE_MAILBOX_TABLE)
        .upsert(row, { ignoreDuplicates: true, onConflict: "employee_hr_id_key" });
      if (error && isUniqueViolation(error) && proposed) {
        ({ error } = await getSupabaseAdmin()
          .from(NEW_HIRE_MAILBOX_TABLE)
          .upsert({ ...row, email_address: null }, { ignoreDuplicates: true, onConflict: "employee_hr_id_key" }));
        if (!error) {
          opened.push(subjectFromEmployee(hire, null));
          continue;
        }
      }
      if (error) throw error;
      if (proposed) taken.add(proposed);
      opened.push(subjectFromEmployee(hire, proposed));
    } catch (error) {
      const detail = error instanceof Error ? error.message : JSON.stringify(error);
      if (isNewHireMailboxSchemaMissing(error)) {
        warnings.push("The new hire mailbox queue is not provisioned in this environment yet.");
        return { opened, warnings };
      }
      warnings.push(`The mailbox task for ${hire.displayName || hire.fullName} could not be opened: ${detail}`.slice(0, 200));
      logError("New hire mailbox task could not be opened", {
        error: error instanceof Error ? error : new Error(detail),
        labels: { event: "new_hire_mailbox_open_failed" },
      });
    }
  }
  return { opened, warnings };
}

/** Which of these people hold an active Phoenix login — the one a mailbox is bound to. */
async function hrKeysWithActiveLogin(hrIds: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  const lookup = Array.from(new Set(hrIds.flatMap((hrId) => hrIdLookupKeys(hrId))));
  if (lookup.length === 0) return keys;
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("hr_id")
    .in("hr_id", lookup)
    .eq("is_active", true);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ hr_id: string | null }>) {
    const key = canonicalHrIdKey(row.hr_id);
    if (key) keys.add(key);
  }
  return keys;
}

/** The page's data: everything still pending, plus the last 25 closed, newest first. */
export async function getNewHireMailboxQueue(): Promise<NewHireMailboxQueue> {
  let rows: TaskDbRow[];
  try {
    rows = await readTasks();
  } catch (error) {
    if (isNewHireMailboxSchemaMissing(error)) return { pending: [], recentlyResolved: [], schemaMissing: true };
    throw error;
  }

  const employees = byKey(await getEmployeeDirectoryRows({ includeInactive: true }));
  const pendingIds = rows.filter((row) => statusOf(row.status) === "pending").map((row) => String(row.employee_hr_id ?? ""));
  const withLogin = await hrKeysWithActiveLogin(pendingIds);

  const tasks: NewHireMailboxTask[] = rows.map((row) => {
    const hrId = String(row.employee_hr_id ?? "").trim();
    const key = canonicalHrIdKey(hrId) ?? "";
    const employee = employees.get(key);
    const resolver = employees.get(canonicalHrIdKey(row.resolved_by_hr_id) ?? "");
    const emailAddress = row.email_address ?? null;
    return {
      employeeLeft: employee
        ? employeeLeftFlag({ employmentStatus: employee.employmentStatus, lastWorkingDate: employee.lastWorkingDate })
        : null,
      employeeFound: Boolean(employee),
      hasLogin: withLogin.has(key),
      id: String(row.id ?? hrId),
      openedAt: String(row.opened_at ?? ""),
      resolutionNote: row.resolution_note ?? null,
      resolvedAt: row.resolved_at ?? null,
      resolvedByName: resolver ? resolver.displayName || resolver.fullName : row.resolved_by_hr_id ?? null,
      source: sourceOf(row.source),
      status: statusOf(row.status),
      subject: employee
        ? subjectFromEmployee(employee, emailAddress)
        : { displayName: hrId, emailAddress, hireDate: null, hrId, jobTitle: null, lineName: null },
    };
  });

  return {
    pending: tasks.filter((task) => task.status === "pending"),
    recentlyResolved: tasks.filter((task) => task.status !== "pending").slice(0, 25),
    schemaMissing: false,
  };
}

async function loadTask(hrId: string): Promise<TaskDbRow> {
  const key = canonicalHrIdKey(hrId);
  if (!key) throw new NewHireMailboxError("Choose the new hire this is about.");
  const { data, error } = await getSupabaseAdmin()
    .from(NEW_HIRE_MAILBOX_TABLE)
    .select(TASK_COLUMNS)
    .eq("employee_hr_id_key", key)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NewHireMailboxError("This new hire has no mailbox task. Reload the page.", 404);
  return data as TaskDbRow;
}

function actorForStorage(actorHrId: string | null): string {
  const actor = hrIdForStorage(actorHrId);
  if (!actor) {
    // The table's CHECK refuses a closed row that names nobody; say it in words first.
    throw new NewHireMailboxError("Your login has no HR ID, so this cannot be recorded against anyone.", 403);
  }
  return actor;
}

export type NewHireMailboxConnectOutcome = {
  alreadyConnected: boolean;
  displayName: string;
  emailAddress: string;
  /** True when the employee record's work email was filled in or corrected to this address. */
  workEmailUpdated: boolean;
};

/**
 * Hand a new hire's app password to Phoenix and close their task.
 *
 * ORDER MATTERS, and every step before the Turbify check is a refusal that costs no login:
 *   1. the address must be a company one that no other person or open task holds;
 *   2. Turbify must accept the password for reading AND sending (two logins, never more);
 *   3. only then is it sealed under the hire's own login, the employee record's work email set to
 *      the address when it differs, and the task closed.
 * A retry after a failure at step 3 finds the connection already there and finishes the rest, so a
 * half-done save is never stuck.
 */
export async function connectNewHireMailboxTask(input: {
  actorHrId: string | null;
  appPassword: string;
  emailAddress: string | null;
  hrId: string;
}): Promise<NewHireMailboxConnectOutcome> {
  const actor = actorForStorage(input.actorHrId);
  const task = await loadTask(input.hrId);
  const key = canonicalHrIdKey(task.employee_hr_id) ?? "";
  if (statusOf(task.status) === "connected") {
    throw new NewHireMailboxError("This new hire's email is already connected.", 409);
  }

  const everyone = await getEmployeeDirectoryRows({ includeInactive: true });
  const employee = byKey(everyone).get(key);
  if (!employee) throw new NewHireMailboxError("This employee is no longer on the employee master.", 404);
  const displayName = employee.displayName || employee.fullName;

  const address = lower(input.emailAddress) || lower(task.email_address);
  if (!address) throw new NewHireMailboxError("Type the email address you created in Turbify.");
  if (!isCompanyAddress(address)) {
    throw new NewHireMailboxError(`Only a @${COMPANY_MAIL_DOMAIN} address can be connected here.`);
  }

  const holder = everyone.find(
    (row) => lower(row.workEmail) === address && canonicalHrIdKey(row.hrId) !== key,
  );
  if (holder) {
    throw new NewHireMailboxError(`${address} is already the work email of ${holder.displayName || holder.fullName}.`, 409);
  }
  const { data: others, error: othersError } = await getSupabaseAdmin()
    .from(NEW_HIRE_MAILBOX_TABLE)
    .select("employee_hr_id")
    .eq("email_address", address)
    .neq("status", "not_needed")
    .neq("employee_hr_id_key", key)
    .limit(1);
  if (othersError) throw othersError;
  const otherTask = ((others ?? []) as Array<{ employee_hr_id: string | null }>)[0];
  if (otherTask) {
    const other = byKey(everyone).get(canonicalHrIdKey(otherTask.employee_hr_id) ?? "");
    throw new NewHireMailboxError(
      `${address} is the address for ${other ? other.displayName || other.fullName : "another new hire"}. Use a different one.`,
      409,
    );
  }

  const connected = await connectNewHireMailbox({
    displayName,
    emailAddress: address,
    hrId: employee.hrId,
    rawPassword: input.appPassword,
  });

  let workEmailUpdated = false;
  if (lower(employee.workEmail) !== address) {
    try {
      await setEmployeeWorkEmail({ hrId: employee.hrId, workEmail: address });
      workEmailUpdated = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new NewHireMailboxError(
        `The mailbox is connected, but ${displayName}'s employee record still shows a different work email: ${detail} Press Connect again once that is fixed.`,
        409,
      );
    }
  }

  const now = new Date().toISOString();
  const { error: closeError } = await getSupabaseAdmin()
    .from(NEW_HIRE_MAILBOX_TABLE)
    .update({
      email_address: address,
      resolution_note: null,
      resolved_at: now,
      resolved_by_hr_id: actor,
      status: "connected",
      updated_at: now,
    })
    .eq("employee_hr_id_key", key);
  if (closeError) {
    // The mailbox IS connected and the record updated; reporting a failure would invite a second
    // paste. The harmless symptom is a card that stays on the page, and pressing Connect again
    // closes it (step 3 above).
    logError("New hire mailbox task could not be closed after the mailbox was connected", {
      error: closeError instanceof Error ? closeError : new Error(JSON.stringify(closeError)),
      labels: { event: "new_hire_mailbox_close_failed" },
    });
  }

  return { alreadyConnected: connected.alreadyConnected, displayName, emailAddress: address, workEmailUpdated };
}

/** This hire gets no company mailbox. A reason is required: it is the whole value of the row. */
export async function dismissNewHireMailboxTask(input: {
  actorHrId: string | null;
  hrId: string;
  note: string | null;
}): Promise<void> {
  const note = String(input.note ?? "").trim();
  if (!note) throw new NewHireMailboxError("Say why this person needs no company email.");
  const actor = actorForStorage(input.actorHrId);
  const task = await loadTask(input.hrId);
  if (statusOf(task.status) === "connected") {
    throw new NewHireMailboxError("This new hire's email is already connected.", 409);
  }
  const now = new Date().toISOString();
  const { error } = await getSupabaseAdmin()
    .from(NEW_HIRE_MAILBOX_TABLE)
    .update({ resolution_note: note.slice(0, 500), resolved_at: now, resolved_by_hr_id: actor, status: "not_needed", updated_at: now })
    .eq("employee_hr_id_key", canonicalHrIdKey(task.employee_hr_id) ?? "");
  if (error) throw error;
}
