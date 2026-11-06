// Mailbox compliance monitor — domain service. The one place that reads/writes the
// mailbox_monitors table, seals/opens the app password, drives the read-only IMAP client, and
// writes the access log. Routes call this; they never touch the DB, the cipher, or imapflow directly.
//
// Password handling: the app password is sealed (src/lib/security/secret-box.ts) before it ever
// reaches the database and is opened only in memory, only to build a live IMAP connection, and is
// never returned to any caller or serialized into any MailboxMonitor. A DB row on its own is inert.

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { openSecret, sealSecret } from "@/lib/security/secret-box";
import {
  fetchMessage,
  listFolders,
  listMessages,
  testMailboxConnection,
} from "@/lib/mailbox-monitor/imap-client";
import { failureDetail, failureReason, normalizeAppPassword } from "@/lib/mailbox-monitor/imap-error";
import { logError } from "@/lib/observability/log";
import { loadConfiguredMailboxes } from "@/lib/recruitment/inbound/email-mailboxes-config";
import type {
  AddMailboxMonitorInput,
  ImportConfiguredResult,
  ImportableMailbox,
  MailboxAccessAction,
  MailboxConnection,
  MailboxFolder,
  MailboxMessageDetail,
  MailboxMessageSummary,
  MailboxMonitor,
  MailboxMonitorStatus,
} from "@/lib/mailbox-monitor/types";
import { isUuid } from "@/lib/http/uuid";

const DEFAULT_IMAP_HOST = "imap.mail.yahoo.com"; // Turbify/Yahoo business mail
const DEFAULT_IMAP_PORT = 993;
const MONITORS_TABLE = "mailbox_monitors";
const ACCESS_LOG_TABLE = "mailbox_monitor_access_log";

type MonitorRow = {
  id: string;
  email_address: string;
  employee_hr_id: string | null;
  display_label: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: boolean;
  sealed_password: string;
  status: MailboxMonitorStatus;
  last_ok_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export class MailboxMonitorError extends Error {
  readonly statusCode: number;
  /**
   * True when this failure has a cause worth investigating — an IMAP rejection, an unreachable
   * host, a database error — as opposed to a user input mistake (a typo'd address, a mailbox
   * already monitored). Only a diagnostic failure is forwarded to the error monitor; routing
   * every 400 there would bury the real ones under ordinary form validation.
   *
   * The distinction lives on the error rather than being re-derived from the status code at each
   * catch site, so the decision is made once, where the cause is actually known.
   */
  readonly diagnostic: boolean;
  constructor(message: string, statusCode = 400, options: { diagnostic?: boolean } = {}) {
    super(message);
    this.name = "MailboxMonitorError";
    this.statusCode = statusCode;
    this.diagnostic = options.diagnostic ?? false;
  }
}

function db() {
  return getSupabaseAdmin();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function rowToMonitor(row: MonitorRow, employeeName: string | null): MailboxMonitor {
  return {
    id: row.id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    displayLabel: row.display_label,
    emailAddress: row.email_address,
    employeeHrId: row.employee_hr_id,
    employeeName,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    lastOkAt: row.last_ok_at,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

async function resolveEmployeeNames(hrIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(hrIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const { data } = await db().from("employees").select("hr_id,full_name").in("hr_id", unique);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ hr_id: string; full_name: string | null }>) {
    if (row.hr_id && row.full_name) map.set(row.hr_id, row.full_name);
  }
  return map;
}

/** Append one access-log row. Best-effort: a logging failure must never break the read itself,
 *  but it must not be INVISIBLE either — see the note on the insert below. */
async function logAccess(entry: {
  monitorId: string | null;
  emailAddress: string | null;
  actorHrId: string | null;
  action: MailboxAccessAction;
  folder?: string | null;
  messageUid?: string | number | null;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    const { error } = await db()
      .from(ACCESS_LOG_TABLE)
      .insert({
        action: entry.action,
        actor_hr_id: entry.actorHrId,
        detail: entry.detail ?? null,
        email_address: entry.emailAddress,
        folder: entry.folder ?? null,
        message_uid: entry.messageUid == null ? null : String(entry.messageUid),
        monitor_id: entry.monitorId,
      });
    // supabase-js RESOLVES a rejected write with `{ error }` rather than throwing it, so the catch
    // below never sees a refused row — an RLS denial, a constraint, a `detail` payload postgres
    // will not accept as jsonb. Until this branch existed the row simply did not appear and nothing
    // said so, which is the same "it failed and we cannot say why" hole the `reason` field was
    // added to close, one layer further down. Report it; never rethrow.
    if (error) {
      logError("Failed to write a mailbox monitor access-log row", {
        error,
        labels: { action: entry.action, event: "mailbox_monitor_access_log_insert_failed" },
      });
    }
  } catch (loggingError) {
    // A THROWN failure — a dropped socket, or the client's own 15s abort. Still never block the
    // operation being audited on it.
    logError("Mailbox monitor access-log write threw", {
      error: loggingError,
      labels: { action: entry.action, event: "mailbox_monitor_access_log_write_threw" },
    });
  }
}

async function loadRow(id: string): Promise<MonitorRow> {
  // A malformed id is NOT FOUND, not a fault: this is a uuid column, and Postgres answers a
  // non-uuid with 22P02 from the WHERE clause instead of with no rows, which leaves as a 500.
  // Same error as the absent-row case below, so the two stay indistinguishable.
  if (!isUuid(id)) throw new MailboxMonitorError("Mailbox monitor not found.", 404);
  const { data, error } = await db().from(MONITORS_TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw new MailboxMonitorError(error.message, 500, { diagnostic: true });
  if (!data) throw new MailboxMonitorError("Mailbox monitor not found.", 404);
  return data as MonitorRow;
}

/** Build a live IMAP connection from a monitor row — decrypts the password in memory only. */
function connectionFromRow(row: MonitorRow): MailboxConnection {
  return {
    host: row.imap_host,
    password: openSecret(row.sealed_password),
    port: row.imap_port,
    secure: row.imap_secure,
    user: row.email_address,
  };
}

/**
 * Update a monitor's health columns.
 *
 * Best-effort, deliberately: this is metadata ABOUT an operation, never the operation the caller
 * asked for. The supabase client turns its own 15s abort into a thrown "Supabase request timed
 * out." (src/lib/supabase/server.ts), so an unguarded call here could replace a clean 502 carrying
 * the IMAP reason with an opaque timeout — and, worse, pre-empt the access-log row that is the only
 * durable record of why the read failed. A slow database is exactly when that record matters most.
 */
async function markHealth(
  id: string,
  patch: {
    status?: MailboxMonitorStatus;
    ok?: boolean;
    error?: string | null;
    // Only write if the row still holds THIS sealed password — see the note on the predicate below.
    onlyIfSealedPassword?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { last_checked_at: now, updated_at: now };
  if (patch.status) update.status = patch.status;
  if (patch.ok) {
    update.last_ok_at = now;
    update.last_error = null;
  }
  // Through the SAME gate as the audit reason. This column is the copy the admin dashboard
  // renders, on a single non-wrapping line, so leaving it uncapped meant the one protection the
  // cap was written for was missing from the one place a human reads.
  if (patch.error !== undefined) update.last_error = failureReason(patch.error);
  // A failure is evidence about the credential that FAILED, and only that one. A read and a
  // password replacement overlap easily — the owner clicks Open on a failing mailbox, then repairs
  // it in the panel while the read is still timing out — and keyed on the id alone the read's
  // `failing` lands on top of the fresh credential, showing a mailbox as broken seconds after it
  // was fixed. Keyed also on the sealed blob the caller actually used, a stale verdict matches no
  // row at all and quietly does nothing, which is exactly what a stale verdict is worth.
  const predicate: Record<string, string> = { id };
  if (patch.onlyIfSealedPassword) predicate.sealed_password = patch.onlyIfSealedPassword;
  try {
    const { error } = await db().from(MONITORS_TABLE).update(update).match(predicate);
    if (error) {
      logError("Failed to update mailbox monitor health", {
        error,
        labels: { event: "mailbox_monitor_health_update_failed", monitorId: id },
      });
    }
  } catch (healthError) {
    logError("Mailbox monitor health update threw", {
      error: healthError,
      labels: { event: "mailbox_monitor_health_update_threw", monitorId: id },
    });
  }
}

/**
 * Refuse an enrolment: record WHY in the access log, then throw.
 *
 * One helper rather than a log-then-throw pair repeated at each guard, because the pairs drifted —
 * only the connection-test refusal was ever audited, so an address typo, a too-short password and
 * a mailbox already monitored each left NO row at all. That is strictly worse than the bare
 * `failed: true` this module set out to improve on: it cannot even be counted. Every refusal now
 * leaves the same shape, and adding a guard cannot silently skip the audit.
 *
 * `reason` is what the audit stores and `message` is what the browser sees; they differ on the
 * connection test, where the client message wraps the IMAP reason in context the log already has.
 */
async function refuseAdd(input: {
  actorHrId: string | null;
  diagnostic?: boolean;
  email: string;
  message: string;
  reason?: unknown;
  statusCode: number;
}): Promise<never> {
  await logAccess({
    action: "add",
    actorHrId: input.actorHrId,
    detail: failureDetail(input.reason ?? input.message, { emailAddress: input.email }),
    emailAddress: input.email,
    monitorId: null,
  });
  throw new MailboxMonitorError(input.message, input.statusCode, { diagnostic: input.diagnostic ?? false });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listMonitors(): Promise<MailboxMonitor[]> {
  // Every monitor, paged to the last row: the invite-inbox lookup walks this list, and a monitor
  // past one response's worth would read as "not connected".
  let rows: MonitorRow[];
  try {
    rows = await fetchAllRows<MonitorRow>(
      () => db().from(MONITORS_TABLE).select("*").order("created_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message;
    throw new MailboxMonitorError(typeof message === "string" ? message : "The mailbox monitors could not be read.", 500, {
      diagnostic: true,
    });
  }
  const names = await resolveEmployeeNames(rows.map((r) => r.employee_hr_id ?? ""));
  return rows.map((row) => rowToMonitor(row, row.employee_hr_id ? names.get(row.employee_hr_id) ?? null : null));
}

/**
 * Add a monitored mailbox. Tests the credential FIRST (so a typo'd app password is rejected at the
 * point of entry, not discovered later), then seals the password and inserts. Returns the safe
 * MailboxMonitor (never the password).
 */
export async function addMonitor(input: AddMailboxMonitorInput, actorHrId: string | null): Promise<MailboxMonitor> {
  const email = normalizeEmail(input.emailAddress ?? "");
  // Strip ALL whitespace, not just the ends: Yahoo/Turbify shows an app password as four
  // space-separated blocks, but the IMAP LOGIN needs the 16 characters with no spaces.
  const appPassword = normalizeAppPassword(input.appPassword ?? "");
  if (!isEmail(email)) {
    await refuseAdd({ actorHrId, email, message: "Enter a valid mailbox email address.", statusCode: 400 });
  }
  if (appPassword.length < 6) {
    await refuseAdd({ actorHrId, email, message: "Paste the mailbox app password.", statusCode: 400 });
  }

  const host = (input.imapHost ?? "").trim() || DEFAULT_IMAP_HOST;
  const port = Number.isFinite(input.imapPort) && Number(input.imapPort) > 0 ? Number(input.imapPort) : DEFAULT_IMAP_PORT;
  const secure = input.imapSecure === undefined ? true : Boolean(input.imapSecure);

  const { data: existing } = await db().from(MONITORS_TABLE).select("id").eq("email_address", email).maybeSingle();
  if (existing) {
    await refuseAdd({ actorHrId, email, message: "That mailbox is already being monitored.", statusCode: 409 });
  }

  // Prove the credential works before we store it.
  const connection: MailboxConnection = { host, password: appPassword, port, secure, user: email };
  const test = await testMailboxConnection(connection);
  if (!test.ok) {
    // The reason has nowhere else to live: no monitor row was created, so there is no last_error to
    // fall back on. Marked diagnostic, so it also reaches the error monitor — the surface a human
    // actually watches — instead of dying with the 422's HTTP response.
    await refuseAdd({
      actorHrId,
      diagnostic: true,
      email,
      message: `Could not connect to that mailbox: ${test.error}`,
      reason: test.error,
      statusCode: 422,
    });
  }

  const now = new Date().toISOString();
  const { data, error } = await db()
    .from(MONITORS_TABLE)
    .insert({
      created_by: actorHrId,
      display_label: input.displayLabel?.trim() || null,
      email_address: email,
      employee_hr_id: input.employeeHrId?.trim() || null,
      imap_host: host,
      imap_port: port,
      imap_secure: secure,
      last_checked_at: now,
      last_ok_at: now,
      sealed_password: sealSecret(appPassword),
      status: "active",
    })
    .select("*")
    .single();
  if (error) throw new MailboxMonitorError(error.message, 500, { diagnostic: true });

  const row = data as MonitorRow;
  await logAccess({ action: "add", actorHrId, emailAddress: email, monitorId: row.id });
  const names = await resolveEmployeeNames([row.employee_hr_id ?? ""]);
  return rowToMonitor(row, row.employee_hr_id ? names.get(row.employee_hr_id) ?? null : null);
}

/**
 * The company mailboxes Phoenix already holds working credentials for — the recruitment intake
 * inboxes (careers@ / hr@) configured in RECRUITMENT_EMAIL_INBOXES_JSON — minus the ones already
 * monitored. Returns the address and label ONLY: the password stays in the environment and is
 * never returned, so this is safe to render in the browser.
 */
export async function listImportableMailboxes(): Promise<ImportableMailbox[]> {
  const configured = loadConfiguredMailboxes();
  if (configured.length === 0) return [];

  const emails = [...new Set(configured.map((box) => normalizeEmail(box.user)))];
  const { data } = await db().from(MONITORS_TABLE).select("email_address").in("email_address", emails);
  const alreadyMonitored = new Set(((data ?? []) as Array<{ email_address: string }>).map((row) => row.email_address));

  const seen = new Set<string>();
  const importable: ImportableMailbox[] = [];
  for (const box of configured) {
    const emailAddress = normalizeEmail(box.user);
    if (alreadyMonitored.has(emailAddress) || seen.has(emailAddress)) continue;
    seen.add(emailAddress);
    importable.push({ emailAddress, label: box.label });
  }
  return importable;
}

/**
 * Add every already-configured company mailbox that is not yet monitored, reusing the credential
 * Phoenix already has. Goes through addMonitor, so each one is still connection-tested before it is
 * stored and still writes its own access-log row — an import is not a back door around either.
 * One mailbox failing never aborts the rest; it comes back in `failures`.
 */
export async function importConfiguredMailboxes(actorHrId: string | null): Promise<ImportConfiguredResult> {
  const configured = loadConfiguredMailboxes();
  const imported: MailboxMonitor[] = [];
  const failures: Array<{ emailAddress: string; error: string }> = [];
  const handled = new Set<string>();
  let skipped = 0;

  for (const box of configured) {
    const emailAddress = normalizeEmail(box.user);
    if (handled.has(emailAddress)) continue;
    handled.add(emailAddress);

    const { data: existing } = await db().from(MONITORS_TABLE).select("id").eq("email_address", emailAddress).maybeSingle();
    if (existing) {
      skipped += 1;
      continue;
    }

    try {
      imported.push(
        await addMonitor(
          {
            appPassword: box.password,
            displayLabel: box.label,
            emailAddress,
            employeeHrId: null,
            imapHost: box.host,
            imapPort: box.port,
            imapSecure: box.secure,
          },
          actorHrId,
        ),
      );
    } catch (error) {
      failures.push({
        emailAddress,
        error: error instanceof Error ? error.message : "Import failed.",
      });
    }
  }

  return { failures, imported, skipped };
}

/** Remove a monitored mailbox (deletes the credential). The access log row survives (monitor_id
 *  becomes null via ON DELETE SET NULL) so the history of who read it is not erased. */
export async function deleteMonitor(id: string, actorHrId: string | null): Promise<void> {
  const row = await loadRow(id);
  await logAccess({ action: "delete", actorHrId, emailAddress: row.email_address, monitorId: id });
  const { error } = await db().from(MONITORS_TABLE).delete().eq("id", id);
  if (error) throw new MailboxMonitorError(error.message, 500, { diagnostic: true });
}

/** Re-test a monitor's credential and update its health. Returns the refreshed monitor. */
export async function recheckMonitor(id: string, actorHrId: string | null): Promise<MailboxMonitor> {
  const row = await loadRow(id);
  const test = await testMailboxConnection(connectionFromRow(row));
  // The audit row goes FIRST. It carries the reason; the health columns carry only a summary of it,
  // so if one of the two writes has to be the one that survives a bad moment, it is this one.
  await logAccess({
    action: "connect_test",
    actorHrId,
    detail: test.ok ? { ok: true } : failureDetail(test.error, { ok: false }),
    emailAddress: row.email_address,
    monitorId: id,
  });
  if (test.ok) {
    await markHealth(id, { ok: true, status: "active" });
  } else {
    await markHealth(id, { error: test.error, onlyIfSealedPassword: row.sealed_password, status: "failing" });
  }
  const refreshed = await loadRow(id);
  const names = await resolveEmployeeNames([refreshed.employee_hr_id ?? ""]);
  return rowToMonitor(refreshed, refreshed.employee_hr_id ? names.get(refreshed.employee_hr_id) ?? null : null);
}

/**
 * Replace the stored app password on a monitor that already exists, keeping the row, its id and
 * its access-log history. Returns the refreshed monitor (never the password).
 *
 * This is the path back from a revoked credential. An employee who regenerates or deletes the
 * `imap` app password on their own mailbox leaves the monitor holding a key that no longer opens
 * it, and until this existed the only way forward was to Remove the mailbox and add it again —
 * which detaches every access-log row from the monitor it describes (`ON DELETE SET NULL`), so the
 * record of who read that mailbox survives with nothing left pointing at it.
 *
 * Two properties are worth stating because both are easy to get backwards:
 *
 *  1. **The candidate is proven before it displaces anything.** A mailbox arriving here is usually
 *     already failing, so accepting the new password first and testing afterwards would trade a
 *     credential known to be dead for one not known to be alive, with the old one gone.
 *  2. **A failed candidate does NOT touch the health columns.** They describe the credential the
 *     row is HOLDING; a typo in a replacement says nothing about it. Marking the monitor `failing`
 *     here would report a working mailbox as broken on the strength of a mistyped form field —
 *     which is why this is the one connection test in the module that ends without markHealth.
 */
export async function replaceMonitorPassword(
  id: string,
  rawAppPassword: string,
  actorHrId: string | null,
): Promise<MailboxMonitor> {
  const row = await loadRow(id);
  // Same normalization as the add path: Yahoo/Turbify displays an app password as four
  // space-separated blocks, and the IMAP LOGIN wants the 16 characters with no spaces.
  const appPassword = normalizeAppPassword(rawAppPassword ?? "");

  // Every refusal is audited before it is thrown, for the reason refuseAdd exists on the add path:
  // a guard that throws without a row cannot be counted afterwards.
  if (appPassword.length < 6) {
    await logAccess({
      action: "replace_password",
      actorHrId,
      detail: failureDetail("The replacement app password was empty or too short.", { ok: false }),
      emailAddress: row.email_address,
      monitorId: id,
    });
    throw new MailboxMonitorError("Paste the new app password.", 400);
  }

  const test = await testMailboxConnection({
    host: row.imap_host,
    password: appPassword,
    port: row.imap_port,
    secure: row.imap_secure,
    user: row.email_address,
  });
  if (!test.ok) {
    // Audited before the throw — the rule refuseAdd enforces on the add path: a guard that throws
    // without a row cannot be counted afterwards.
    await logAccess({
      action: "replace_password",
      actorHrId,
      detail: failureDetail(test.error, { ok: false }),
      emailAddress: row.email_address,
      monitorId: id,
    });
    // Diagnostic: the reason has nowhere else to live. Nothing was written to the row, so there is
    // no last_error to read it back from afterwards — exactly the add path's 422.
    throw new MailboxMonitorError(`Could not connect with that app password: ${test.error}`, 422, {
      diagnostic: true,
    });
  }

  const now = new Date().toISOString();
  // `.select("*")` returns the written row, so the refreshed monitor comes back from the write
  // itself rather than from a second read — one fewer round trip, and no window in which another
  // admin's edit lands between the two and is returned as if it were this request's result.
  const { data, error } = await db()
    .from(MONITORS_TABLE)
    .update({
      last_checked_at: now,
      last_error: null,
      last_ok_at: now,
      sealed_password: sealSecret(appPassword),
      status: "active",
      updated_at: now,
    })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new MailboxMonitorError(error.message, 500, { diagnostic: true });
  // Nothing came back: the monitor was removed between the load and the write. A 404, not a fault.
  if (!data) throw new MailboxMonitorError("Mailbox monitor not found.", 404);

  // The SUCCESS row is written AFTER the credential is stored, never before it. Written first, it
  // claimed a replacement that a throwing sealSecret (a missing MAILBOX_MONITOR_SECRET) or a
  // refused UPDATE never actually made — and on a compliance log about a mailbox credential, a row
  // that overstates what happened is the wrong way round to be wrong. addMonitor orders it the
  // same way: write the row, then record it.
  await logAccess({
    action: "replace_password",
    actorHrId,
    detail: { ok: true },
    emailAddress: row.email_address,
    monitorId: id,
  });

  const updated = data as MonitorRow;
  const names = await resolveEmployeeNames([updated.employee_hr_id ?? ""]);
  return rowToMonitor(updated, updated.employee_hr_id ? names.get(updated.employee_hr_id) ?? null : null);
}

/** Wrap a live IMAP read: resolve the connection, run it, log it, and translate a connection
 *  failure into a health downgrade + a clean error (a revoked app password lands here). */
async function withMonitorRead<T>(
  id: string,
  actorHrId: string | null,
  action: MailboxAccessAction,
  meta: { folder?: string | null; messageUid?: string | number | null },
  run: (connection: MailboxConnection, row: MonitorRow) => Promise<T>,
): Promise<T> {
  const row = await loadRow(id);
  try {
    const result = await run(connectionFromRow(row), row);
    await markHealth(id, { ok: true, status: row.status === "failing" ? "active" : row.status });
    await logAccess({
      action,
      actorHrId,
      emailAddress: row.email_address,
      folder: meta.folder ?? null,
      messageUid: meta.messageUid ?? null,
      monitorId: id,
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mailbox read failed.";
    // The audit row goes FIRST, ahead of the health update. markHealth is best-effort now, but
    // ordering is the defence that does not depend on it staying that way — and this row is the
    // only place the reason survives once the 502 below has been read and the tab closed.
    await logAccess({
      action,
      actorHrId,
      detail: failureDetail(message),
      emailAddress: row.email_address,
      folder: meta.folder ?? null,
      messageUid: meta.messageUid ?? null,
      monitorId: id,
    });
    await markHealth(id, { error: message, onlyIfSealedPassword: row.sealed_password, status: "failing" });
    throw new MailboxMonitorError(
      `Could not read the mailbox — it may have been closed or the app password revoked. (${message})`,
      502,
      { diagnostic: true },
    );
  }
}

export async function listMonitorFolders(id: string, actorHrId: string | null): Promise<MailboxFolder[]> {
  return withMonitorRead(id, actorHrId, "list_folders", {}, (connection) => listFolders(connection));
}

export async function listMonitorMessages(
  id: string,
  folder: string,
  actorHrId: string | null,
  limit = 50,
): Promise<MailboxMessageSummary[]> {
  return withMonitorRead(id, actorHrId, "list_messages", { folder }, (connection) =>
    listMessages(connection, folder, { limit }),
  );
}

export async function openMonitorMessage(
  id: string,
  folder: string,
  uid: number,
  actorHrId: string | null,
): Promise<MailboxMessageDetail | null> {
  return withMonitorRead(id, actorHrId, "open_message", { folder, messageUid: uid }, (connection) =>
    fetchMessage(connection, folder, uid),
  );
}
