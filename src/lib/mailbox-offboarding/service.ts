/**
 * Mailbox offboarding domain service — the Turbify leaver register.
 *
 * Three rules shape everything here.
 *
 * 1. **The revocation rule lives in the database, not in this file.**
 *    `phx_mailbox_offboarding_refresh_status` decides what counts as revoked, and it refuses to
 *    say `revoked` on a password reset alone — because Yahoo app passwords survive a password
 *    change, so a reset leaves every phone and Outlook client the leaver configured still
 *    connected. This service calls the function and reports what it returns; it never
 *    re-implements the decision. A rule in a page is bypassed by the next page.
 *
 * 2. **Nothing here talks to Turbify, because nothing can.** Turbify publishes no email API — its
 *    only public API is the Merchant Solutions order API, which is ecommerce. Every row therefore
 *    records what a named admin SAID they did, at a recorded time. That is an attestation, not an
 *    observation, and the actor columns exist so the difference stays visible.
 *
 * 3. **Reads are scoped by permission, not by RLS.** Like the rest of this app, every query here
 *    runs on the service-role client behind an `assertPermission` call in the route handler. The
 *    table has RLS on with no `authenticated` grant, so no browser session reaches it directly.
 */

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  MailboxAwaitingLeaver,
  MailboxDisposition,
  MailboxOffboardingDashboardData,
  MailboxOffboardingStats,
  MailboxOffboardingTask,
  MailboxStep,
  MailboxTaskSource,
  MailboxTaskStatus,
  RecordMailboxStepInput,
} from "./types";

/**
 * The Turbify Email Control Panel. Every mailbox action in this module happens here, by hand.
 *
 * Not in `src/config/system-settings.ts` deliberately — that file holds PHOENIX's own brand, URLs
 * and email defaults, and this is a third party's admin console that only this one domain knows
 * or cares about. Putting it there would imply the rest of the app has a reason to read it.
 */
export const TURBIFY_CONTROL_PANEL_URL = "https://ecp.turbify.com/";

/** The employment statuses that make someone a leaver for this register's purposes. */
const LEAVER_STATUSES = ["resigned", "terminated"] as const;

type TaskRow = {
  id: string;
  employee_hr_id: string;
  employee_name: string;
  work_email: string;
  job_title: string | null;
  last_working_date: string | null;
  status: MailboxTaskStatus;
  password_reset_at: string | null;
  password_reset_by: string | null;
  app_passwords_cleared_at: string | null;
  app_passwords_cleared_by: string | null;
  disposition: MailboxDisposition | null;
  disposition_at: string | null;
  disposition_by: string | null;
  forwarding_to: string | null;
  forwarding_expires_on: string | null;
  reason: string | null;
  note: string | null;
  source: MailboxTaskSource;
  opened_at: string;
  opened_by: string | null;
  revoked_at: string | null;
};

const TASK_COLUMNS =
  "id,employee_hr_id,employee_name,work_email,job_title,last_working_date,status,password_reset_at,password_reset_by,app_passwords_cleared_at,app_passwords_cleared_by,disposition,disposition_at,disposition_by,forwarding_to,forwarding_expires_on,reason,note,source,opened_at,opened_by,revoked_at";

/**
 * True when the register has not reached this environment. Distinguished from a real failure so a
 * preview branch renders an honest "not ready yet" instead of a misleading zero — the rule
 * AGENTS.md §7 states for an unavailable data source.
 */
export function isMailboxOffboardingSchemaMissing(error: unknown): boolean {
  const message = mailboxOffboardingErrorMessage(error).toLowerCase();
  return (
    (message.includes("mailbox_offboarding_tasks") || message.includes("phx_mailbox_offboarding")) &&
    (message.includes("does not exist") ||
      message.includes("could not find") ||
      message.includes("schema cache") ||
      message.includes("relation") ||
      message.includes("function"))
  );
}

export function mailboxOffboardingErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "Mailbox offboarding request failed.");
  }
  return "Mailbox offboarding request failed.";
}

/** Whole days between an ISO date and today in Cairo. Negative and unknown both collapse to 0. */
function daysSince(dateIso: string | null, todayIso: string): number {
  if (!dateIso) return 0;
  const then = Date.parse(`${dateIso}T00:00:00Z`);
  const now = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - then) / 86400000));
}

/**
 * The three derived flags, as a pure function.
 *
 * Extracted from `mapTask` so a test can reach them without a database — `isHalfRevoked` is the
 * single most consequential line in this module and a rule nothing else in the system can see. It
 * is computed rather than stored precisely so it can never drift from the two timestamps beneath
 * it; that only helps if the computation itself is pinned.
 */
export function computeMailboxFlags(
  input: {
    status: MailboxTaskStatus;
    passwordResetAt: string | null;
    appPasswordsClearedAt: string | null;
    disposition: MailboxDisposition | null;
    forwardingExpiresOn: string | null;
    lastWorkingDate: string | null;
  },
  todayIso: string,
): { isOverdue: boolean; daysOverdue: number; isHalfRevoked: boolean; isForwardingExpired: boolean } {
  const open = input.status === "pending" || input.status === "in_progress";
  const daysOverdue = open ? daysSince(input.lastWorkingDate, todayIso) : 0;
  return {
    isOverdue: open && daysOverdue > 0,
    daysOverdue,
    // The dangerous middle state: webmail is shut, IMAP is not. A reset with the app passwords
    // still live is the one state that looks finished in the Turbify control panel.
    isHalfRevoked: open && input.passwordResetAt !== null && input.appPasswordsClearedAt === null,
    isForwardingExpired:
      input.disposition === "forwarding" &&
      input.forwardingExpiresOn !== null &&
      input.forwardingExpiresOn < todayIso,
  };
}

function mapTask(row: TaskRow, names: Map<string, string>, todayIso: string): MailboxOffboardingTask {
  const flags = computeMailboxFlags(
    {
      status: row.status,
      passwordResetAt: row.password_reset_at,
      appPasswordsClearedAt: row.app_passwords_cleared_at,
      disposition: row.disposition,
      forwardingExpiresOn: row.forwarding_expires_on,
      lastWorkingDate: row.last_working_date,
    },
    todayIso,
  );
  return {
    id: row.id,
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    workEmail: row.work_email,
    jobTitle: row.job_title,
    lastWorkingDate: row.last_working_date,
    status: row.status,

    passwordResetAt: row.password_reset_at,
    passwordResetBy: row.password_reset_by,
    passwordResetByName: names.get(String(row.password_reset_by ?? "").toLowerCase()) ?? null,

    appPasswordsClearedAt: row.app_passwords_cleared_at,
    appPasswordsClearedBy: row.app_passwords_cleared_by,
    appPasswordsClearedByName: names.get(String(row.app_passwords_cleared_by ?? "").toLowerCase()) ?? null,

    disposition: row.disposition,
    dispositionAt: row.disposition_at,
    dispositionBy: row.disposition_by,
    dispositionByName: names.get(String(row.disposition_by ?? "").toLowerCase()) ?? null,

    forwardingTo: row.forwarding_to,
    forwardingExpiresOn: row.forwarding_expires_on,

    reason: row.reason,
    note: row.note,
    source: row.source,
    openedAt: row.opened_at,
    openedBy: row.opened_by,
    revokedAt: row.revoked_at,

    ...flags,
  };
}

function buildStats(tasks: MailboxOffboardingTask[]): MailboxOffboardingStats {
  return {
    total: tasks.length,
    pending: tasks.filter((task) => task.status === "pending").length,
    inProgress: tasks.filter((task) => task.status === "in_progress").length,
    revoked: tasks.filter((task) => task.status === "revoked").length,
    notApplicable: tasks.filter((task) => task.status === "not_applicable").length,
    overdue: tasks.filter((task) => task.isOverdue).length,
    halfRevoked: tasks.filter((task) => task.isHalfRevoked).length,
    forwardingExpired: tasks.filter((task) => task.isForwardingExpired).length,
  };
}

/**
 * Resolves actor ids to human names. Owner rule: show human-readable names, never raw codes.
 *
 * Keyed on the LOWERED id on both sides. `hr_id` is mixed case in this database and a plain `.eq`
 * silently under-returns — the failure that hid 28% of reps' own orders and every occupancy join.
 */
async function resolveActorNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = Array.from(
    new Set(ids.map((id) => String(id ?? "").trim()).filter((id) => id.length > 0)),
  );
  const names = new Map<string, string>();
  if (wanted.length === 0) return names;

  const supabase = getSupabaseAdmin();
  // Chunked at 50: a PostgREST `.in()` carrying several hundred ids returns zero rows and no error.
  for (let index = 0; index < wanted.length; index += 50) {
    const chunk = wanted.slice(index, index + 50);
    const { data } = await supabase
      .from("employees")
      .select("hr_id,full_name,nickname")
      .in("hr_id", chunk);
    for (const row of (data ?? []) as Array<{ hr_id: string; full_name: string; nickname: string | null }>) {
      names.set(
        String(row.hr_id).toLowerCase(),
        resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      );
    }
  }
  return names;
}

/**
 * Leavers who hold a mailbox and have no open task.
 *
 * Surfaced on the page rather than silently swept, because "the sweep will pick it up" is exactly
 * the assumption that let 52 mailboxes accumulate unseen. If this list is ever non-empty the page
 * says so and offers the button.
 */
async function loadAwaitingLeavers(taskedHrIds: Set<string>): Promise<MailboxAwaitingLeaver[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,nickname,work_email,job_title,last_working_date,employment_status")
    .in("employment_status", [...LEAVER_STATUSES])
    .not("work_email", "is", null)
    // Explicit order, because an unbounded select silently stops at 1000 rows with no marker.
    .order("last_working_date", { ascending: false, nullsFirst: false });
  if (error) throw new Error(mailboxOffboardingErrorMessage(error));

  const awaiting: MailboxAwaitingLeaver[] = [];
  for (const row of (data ?? []) as Array<{
    hr_id: string;
    full_name: string;
    nickname: string | null;
    work_email: string | null;
    job_title: string | null;
    last_working_date: string | null;
    employment_status: string | null;
  }>) {
    const email = String(row.work_email ?? "").trim();
    if (!email) continue;
    if (taskedHrIds.has(String(row.hr_id).toLowerCase())) continue;
    awaiting.push({
      employeeHrId: row.hr_id,
      employeeName: resolveEmployeeDisplayName(row.full_name, row.nickname, row.hr_id),
      workEmail: email,
      jobTitle: row.job_title,
      lastWorkingDate: row.last_working_date,
      employmentStatus: row.employment_status,
    });
  }
  return awaiting;
}

export async function getMailboxOffboardingDashboardData(): Promise<MailboxOffboardingDashboardData> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("mailbox_offboarding_tasks")
    .select(TASK_COLUMNS)
    .order("last_working_date", { ascending: false, nullsFirst: false })
    .order("opened_at", { ascending: false });
  if (error) throw new Error(mailboxOffboardingErrorMessage(error));

  const rows = (data ?? []) as TaskRow[];
  const todayIso = currentCairoDateOnlyIso();
  const names = await resolveActorNames(
    rows.flatMap((row) => [row.password_reset_by, row.app_passwords_cleared_by, row.disposition_by]),
  );
  const tasks = rows.map((row) => mapTask(row, names, todayIso));

  // Every task, not just the open ones: a person whose mailbox was already revoked must not
  // reappear in "awaiting" and invite a second task.
  const taskedHrIds = new Set(rows.map((row) => String(row.employee_hr_id).toLowerCase()));

  return {
    tasks,
    awaiting: await loadAwaitingLeavers(taskedHrIds),
    stats: buildStats(tasks),
    controlPanelUrl: TURBIFY_CONTROL_PANEL_URL,
  };
}

/**
 * Opens a task for one leaver. Idempotent in the database, so the exit workflow, the daily sweep
 * and a manual click can all call it without splitting one person's evidence across two rows.
 *
 * Returns null when the employee has no mailbox — a normal case, not an error.
 */
export async function openMailboxOffboardingTask(
  employeeHrId: string,
  actor: string,
  source: MailboxTaskSource = "resignation",
): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("phx_mailbox_offboarding_open", {
    p_employee_hr_id: employeeHrId,
    p_actor: actor,
    p_source: source,
  });
  if (error) throw new Error(mailboxOffboardingErrorMessage(error));

  const taskId = typeof data === "string" ? data : data ? String(data) : "";
  if (!taskId) return null;

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "mailbox_offboarding",
    entityId: taskId,
    summary: `Opened a mailbox revocation task for ${employeeHrId}`,
    newValues: { employeeHrId, source, taskId },
  });
  return taskId;
}

/**
 * Records one step against a task and returns the status the DATABASE computed afterwards.
 *
 * The audit row is written BEFORE the state changes, carrying the old values, so a later
 * correction through `reopen` cannot erase what was originally claimed or by whom. The register
 * row is current state; the audit log is the record.
 */
export async function recordMailboxOffboardingStep(
  input: RecordMailboxStepInput,
  actor: string,
): Promise<MailboxTaskStatus> {
  const supabase = getSupabaseAdmin();

  const { data: before } = await supabase
    .from("mailbox_offboarding_tasks")
    .select(TASK_COLUMNS)
    .eq("id", input.taskId)
    .maybeSingle();

  await writeRequiredAuditLog({
    actorLoginId: actor,
    entityType: "mailbox_offboarding",
    entityId: input.taskId,
    summary: `Recorded mailbox step "${input.step}"${
      input.disposition ? ` (${input.disposition})` : ""
    } for ${(before as TaskRow | null)?.work_email ?? input.taskId}`,
    oldValues: (before as Record<string, unknown> | null) ?? null,
    newValues: {
      step: input.step,
      disposition: input.disposition ?? null,
      forwardingTo: input.forwardingTo?.trim() || null,
      forwardingExpiresOn: input.forwardingExpiresOn || null,
      reason: input.reason?.trim() || null,
      note: input.note?.trim() || null,
    },
  });

  const { data, error } = await supabase.rpc("phx_mailbox_offboarding_record", {
    p_task_id: input.taskId,
    p_step: input.step,
    p_actor: actor,
    p_disposition: input.disposition ?? null,
    p_forwarding_to: input.forwardingTo?.trim() || null,
    p_forwarding_expires_on: input.forwardingExpiresOn || null,
    p_reason: input.reason?.trim() || null,
    p_note: input.note?.trim() || null,
  });
  if (error) throw new Error(mailboxOffboardingErrorMessage(error));

  return (typeof data === "string" ? data : String(data ?? "pending")) as MailboxTaskStatus;
}

/** The steps a caller may name. Guards the API boundary against an arbitrary string. */
export function isMailboxStep(value: unknown): value is MailboxStep {
  return (
    value === "password_reset" ||
    value === "app_passwords_cleared" ||
    value === "disposition" ||
    value === "not_applicable" ||
    value === "reopen"
  );
}
