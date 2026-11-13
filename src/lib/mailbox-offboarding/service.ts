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
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type {
  MailboxAppPasswordReportRow,
  MailboxAwaitingLeaver,
  MailboxBulkOutcome,
  MailboxBulkStep,
  MailboxDisposition,
  MailboxOffboardingDashboardData,
  MailboxOffboardingStats,
  MailboxOffboardingTask,
  MailboxStep,
  MailboxTaskSource,
  MailboxTaskStatus,
  RecordMailboxStepInput,
  RecordMailboxStepsBulkInput,
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
 * Whether a leaver's app passwords may still work — the app-password report's one rule.
 *
 * An app password survives every password change, so the ONLY things that end it are the
 * app passwords being cleared or the mailbox being deleted. Whether the password was reset is
 * irrelevant here: a pending row whose password nobody touched is just as reachable from the
 * leaver's phone as a half-revoked one. `not_applicable` means there never was a mailbox.
 *
 * Counted only once the person has left: a pending row before the last working day is a
 * colleague still at work, not a leaver. An unknown last working day counts — "have they left?"
 * cannot be answered, and a report that hid them would read as clean when it is not.
 */
export function leaverAppPasswordsMayBeLive(
  input: {
    status: MailboxTaskStatus;
    appPasswordsClearedAt: string | null;
    disposition: MailboxDisposition | null;
    lastWorkingDate: string | null;
  },
  todayIso: string,
): boolean {
  if (input.status === "not_applicable") return false;
  if (input.disposition === "deleted") return false;
  if (input.appPasswordsClearedAt !== null) return false;
  return input.lastWorkingDate === null || input.lastWorkingDate < todayIso;
}

/** The app-password report: every leaver whose app passwords may still work, tasked or not. */
export function buildAppPasswordReport(
  tasks: MailboxOffboardingTask[],
  awaiting: MailboxAwaitingLeaver[],
  todayIso: string,
): MailboxAppPasswordReportRow[] {
  const rows: MailboxAppPasswordReportRow[] = [];
  for (const task of tasks) {
    if (!task.appPasswordsMayBeLive) continue;
    rows.push({
      employeeHrId: task.employeeHrId,
      employeeName: task.employeeName,
      workEmail: task.workEmail,
      lastWorkingDate: task.lastWorkingDate,
      passwordReset: task.passwordResetAt !== null,
      hasRecord: true,
    });
  }
  // A leaver with a mailbox and no record has had nothing done at all — the same exposure.
  for (const leaver of awaiting) {
    if (leaver.lastWorkingDate !== null && leaver.lastWorkingDate >= todayIso) continue;
    rows.push({
      employeeHrId: leaver.employeeHrId,
      employeeName: leaver.employeeName,
      workEmail: leaver.workEmail,
      lastWorkingDate: leaver.lastWorkingDate,
      passwordReset: false,
      hasRecord: false,
    });
  }
  return rows.sort((left, right) => String(left.lastWorkingDate ?? "").localeCompare(String(right.lastWorkingDate ?? "")));
}

/**
 * The derived flags, as a pure function.
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
): {
  isOverdue: boolean;
  daysOverdue: number;
  isHalfRevoked: boolean;
  appPasswordsMayBeLive: boolean;
  isForwardingExpired: boolean;
  canRecordDisposition: boolean;
} {
  const open = input.status === "pending" || input.status === "in_progress";
  const daysOverdue = open ? daysSince(input.lastWorkingDate, todayIso) : 0;
  return {
    isOverdue: open && daysOverdue > 0,
    daysOverdue,
    appPasswordsMayBeLive: leaverAppPasswordsMayBeLive(input, todayIso),
    // The dangerous middle state: webmail is shut, IMAP is not. A reset with the app passwords
    // still live is the one state that looks finished in the Turbify control panel.
    isHalfRevoked: open && input.passwordResetAt !== null && input.appPasswordsClearedAt === null,
    isForwardingExpired:
      input.disposition === "forwarding" &&
      input.forwardingExpiresOn !== null &&
      input.forwardingExpiresOn < todayIso,
    // Whether step 3 is still offerable — and it MUST mirror the guard in
    // `phx_mailbox_offboarding_record`, because that guard is the real gate and a screen that
    // offers a button the database refuses is worse than one that hides it.
    //
    // A revoked row is frozen, with one exemption: a disposition on a row revoked by BOTH
    // timestamps cannot change the status, so it records a fact without weakening the assertion
    // the freeze protects. Without that exemption step 3 was unreachable in the order the
    // workspace numbers it, and 57 of 60 closed mailboxes ended up with no record of what became
    // of them. A row revoked BY its disposition is excluded on purpose: changing `deleted` to
    // `retained` would drop it back to `in_progress`, and that is a correction, so it goes
    // through `reopen` with a written reason.
    //
    // `not_applicable` is excluded outright. It means there was no mailbox, so there is nothing
    // for a disposition to describe.
    canRecordDisposition:
      input.status !== "not_applicable" &&
      (input.status !== "revoked" ||
        (input.passwordResetAt !== null && input.appPasswordsClearedAt !== null)),
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

function buildStats(tasks: MailboxOffboardingTask[]): Omit<MailboxOffboardingStats, "appPasswordsMayBeLive"> {
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
  // Paged to the last row. An ORDER BY does not lift the response cap: an unpaged select silently
  // stops at one response's worth of leavers with no marker, and the rest would never be offered.
  type LeaverRow = {
    hr_id: string;
    full_name: string;
    nickname: string | null;
    work_email: string | null;
    job_title: string | null;
    last_working_date: string | null;
    employment_status: string | null;
  };
  let leavers: LeaverRow[];
  try {
    leavers = await fetchAllRows<LeaverRow>(
      () =>
        supabase
          .from("employees")
          .select("hr_id,full_name,nickname,work_email,job_title,last_working_date,employment_status")
          .in("employment_status", [...LEAVER_STATUSES])
          .not("work_email", "is", null)
          .order("last_working_date", { ascending: false, nullsFirst: false }),
      "hr_id",
    );
  } catch (error) {
    throw new Error(mailboxOffboardingErrorMessage(error));
  }

  const awaiting: MailboxAwaitingLeaver[] = [];
  for (const row of leavers) {
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
  // Every task, paged to the last row: the "awaiting" list below is everyone with NO task, so one
  // task cut off by a response cap would put a closed mailbox back on the page as awaiting.
  let rows: TaskRow[];
  try {
    rows = await fetchAllRows<TaskRow>(
      () =>
        supabase
          .from("mailbox_offboarding_tasks")
          .select(TASK_COLUMNS)
          .order("last_working_date", { ascending: false, nullsFirst: false })
          .order("opened_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    throw new Error(mailboxOffboardingErrorMessage(error));
  }
  const todayIso = currentCairoDateOnlyIso();
  const names = await resolveActorNames(
    rows.flatMap((row) => [row.password_reset_by, row.app_passwords_cleared_by, row.disposition_by]),
  );
  const tasks = rows.map((row) => mapTask(row, names, todayIso));

  // Every task, not just the open ones: a person whose mailbox was already revoked must not
  // reappear in "awaiting" and invite a second task.
  const taskedHrIds = new Set(rows.map((row) => String(row.employee_hr_id).toLowerCase()));

  const awaiting = await loadAwaitingLeavers(taskedHrIds);
  const appPasswordReport = buildAppPasswordReport(tasks, awaiting, todayIso);
  return {
    tasks,
    awaiting,
    appPasswordReport,
    stats: { ...buildStats(tasks), appPasswordsMayBeLive: appPasswordReport.length },
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

/** How many bulk writes run at once. Four is a throttle, not a throughput target — see below. */
const BULK_CONCURRENCY = 4;

/** Refused above this. A selection larger than the register is a bug in the caller, not a request. */
export const MAILBOX_BULK_MAX = 200;

/**
 * Is this step already recorded on this row? A bulk pass must not re-stamp it.
 *
 * Re-recording is not harmless. Every record writes an audit row and moves the `*_by` and `*_at`
 * columns to the person who pressed the button, so a second pass would quietly reassign an earlier
 * admin's attestation to whoever ran the bulk action — overwriting the answer to "who said they
 * did this", which is the only thing this register actually knows.
 */
function bulkStepAlreadyRecorded(row: TaskRow, step: MailboxBulkStep): boolean {
  if (step === "password_reset") return row.password_reset_at !== null;
  if (step === "app_passwords_cleared") return row.app_passwords_cleared_at !== null;
  return row.disposition !== null;
}

/**
 * Records ONE step against MANY tasks, and reports what happened to each one.
 *
 * Four decisions are load-bearing here, each one the difference between a bulk action that is
 * safe and one that quietly loses work:
 *
 * 1. **It never throws for a single row.** A failure becomes a `failed` outcome carrying its
 *    message and the loop continues. The alternative — one bad id aborting the batch — leaves the
 *    caller unable to tell which of the other rows were written before it blew up.
 *
 * 2. **It re-reads the rows first and SKIPS any that already carry the step.** See
 *    `bulkStepAlreadyRecorded`: re-stamping would reassign an earlier admin's attestation to
 *    whoever ran the bulk. The skip is reported, never silent.
 *
 * 3. **Each row keeps its OWN audit row**, because it delegates to `recordMailboxOffboardingStep`
 *    rather than reimplementing the write. One opaque "bulk recorded 40" entry would destroy the
 *    per-person trail that is the entire point of the register.
 *
 * 4. **Concurrency is capped at four.** A Supabase client request that times out at 15s still
 *    commits, so a flood of parallel writes can leave a half-applied state that no single response
 *    describes. Four keeps a 200-row batch well inside the window while still finishing quickly.
 */
export async function recordMailboxOffboardingStepsBulk(
  input: RecordMailboxStepsBulkInput,
  actor: string,
): Promise<MailboxBulkOutcome[]> {
  const taskIds = Array.from(new Set(input.taskIds.filter((id) => typeof id === "string" && id.trim())));
  if (taskIds.length === 0) return [];
  if (taskIds.length > MAILBOX_BULK_MAX) {
    throw new Error(`A bulk recording is limited to ${MAILBOX_BULK_MAX} rows at a time.`);
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("mailbox_offboarding_tasks").select(TASK_COLUMNS).in("id", taskIds);
  if (error) throw new Error(mailboxOffboardingErrorMessage(error));

  const rows = (data ?? []) as TaskRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));

  // An id the caller named that the register does not hold. Reported, never silently dropped.
  const outcomes: MailboxBulkOutcome[] = taskIds
    .filter((id) => !byId.has(id))
    .map((id) => ({
      taskId: id,
      employeeName: "Unknown",
      workEmail: "",
      result: "failed" as const,
      status: null,
      error: "No such task in the register.",
    }));

  const pending: TaskRow[] = [];
  for (const row of rows) {
    if (bulkStepAlreadyRecorded(row, input.step)) {
      outcomes.push({
        taskId: row.id,
        employeeName: row.employee_name,
        workEmail: row.work_email,
        result: "skipped",
        status: row.status,
        error: null,
      });
      continue;
    }
    pending.push(row);
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const row = pending[index];
      if (!row) return;
      try {
        const status = await recordMailboxOffboardingStep(
          {
            taskId: row.id,
            step: input.step,
            disposition: input.disposition ?? null,
            forwardingTo: input.forwardingTo ?? null,
            forwardingExpiresOn: input.forwardingExpiresOn ?? null,
            reason: null,
            note: input.note ?? null,
          },
          actor,
        );
        outcomes.push({
          taskId: row.id,
          employeeName: row.employee_name,
          workEmail: row.work_email,
          result: "recorded",
          status,
          error: null,
        });
      } catch (rowError) {
        outcomes.push({
          taskId: row.id,
          employeeName: row.employee_name,
          workEmail: row.work_email,
          result: "failed",
          status: row.status,
          error: mailboxOffboardingErrorMessage(rowError),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, pending.length) }, () => worker()));
  return outcomes;
}

/** The steps a BULK caller may name. Narrower than `isMailboxStep` — corrections are excluded. */
export function isMailboxBulkStep(value: unknown): value is MailboxBulkStep {
  return value === "password_reset" || value === "app_passwords_cleared" || value === "disposition";
}

/** The one leaver the Edit-form capture may open, as the register knows them. */
export type RegisterLeaver = {
  taskId: string;
  employeeName: string;
  /** The register's own spelling of the address, lowered — what the capture searches for. */
  workEmail: string;
};

/**
 * Is this address a leaver on the register? An EXACT, lowered match — never a substring.
 *
 * 🔴 THE GATE IN FRONT OF A BROWSER SIGNED IN AS THE CONSOLE ADMINISTRATOR. The Edit-form capture
 * (`POST /api/mailbox-offboarding/edit-form-controls`) opens one mailbox row's Edit form, so the
 * address must be one this register already holds as a leaver: a colleague still at work is not
 * the capture's business, and `el.sayed@` must not match `adel.sayed@`. Pure, so the rule is pinned
 * without a database (`tests/mailbox-edit-form-capture.test.ts`).
 */
export function matchLeaverOnRegister(
  rows: ReadonlyArray<{ id: string; employee_name: string | null; work_email: string | null }>,
  address: string,
): RegisterLeaver | null {
  const wanted = String(address ?? "").trim().toLowerCase();
  if (!wanted.includes("@")) return null;
  const row = rows.find((candidate) => String(candidate.work_email ?? "").trim().toLowerCase() === wanted);
  if (!row) return null;
  return { employeeName: String(row.employee_name ?? ""), taskId: row.id, workEmail: wanted };
}

/** Read the register and answer `matchLeaverOnRegister` for one address. Paged to the last row. */
export async function findLeaverOnRegister(address: string): Promise<RegisterLeaver | null> {
  const supabase = getSupabaseAdmin();
  type Row = { id: string; employee_name: string | null; work_email: string | null };
  let rows: Row[];
  try {
    rows = await fetchAllRows<Row>(
      () => supabase.from("mailbox_offboarding_tasks").select("id,employee_name,work_email").order("opened_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    throw new Error(mailboxOffboardingErrorMessage(error));
  }
  return matchLeaverOnRegister(rows, address);
}
