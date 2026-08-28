// Mailbox compliance monitor — domain service. The one place that reads/writes the
// mailbox_monitors table, seals/opens the app password, drives the read-only IMAP client, and
// writes the access log. Routes call this; they never touch the DB, the cipher, or imapflow directly.
//
// Password handling: the app password is sealed (src/lib/security/secret-box.ts) before it ever
// reaches the database and is opened only in memory, only to build a live IMAP connection, and is
// never returned to any caller or serialized into any MailboxMonitor. A DB row on its own is inert.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { openSecret, sealSecret } from "@/lib/security/secret-box";
import {
  fetchMessage,
  listFolders,
  listMessages,
  testMailboxConnection,
} from "@/lib/mailbox-monitor/imap-client";
import type {
  AddMailboxMonitorInput,
  MailboxConnection,
  MailboxFolder,
  MailboxMessageDetail,
  MailboxMessageSummary,
  MailboxMonitor,
  MailboxMonitorStatus,
} from "@/lib/mailbox-monitor/types";

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
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "MailboxMonitorError";
    this.statusCode = statusCode;
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
 *  but we still surface nothing to the caller — the audit trail is a side effect. */
async function logAccess(entry: {
  monitorId: string | null;
  emailAddress: string | null;
  actorHrId: string | null;
  action: string;
  folder?: string | null;
  messageUid?: string | number | null;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db()
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
  } catch {
    /* audit is best-effort; never block a read on it */
  }
}

async function loadRow(id: string): Promise<MonitorRow> {
  const { data, error } = await db().from(MONITORS_TABLE).select("*").eq("id", id).maybeSingle();
  if (error) throw new MailboxMonitorError(error.message, 500);
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

async function markHealth(
  id: string,
  patch: { status?: MailboxMonitorStatus; ok?: boolean; error?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { last_checked_at: now, updated_at: now };
  if (patch.status) update.status = patch.status;
  if (patch.ok) {
    update.last_ok_at = now;
    update.last_error = null;
  }
  if (patch.error !== undefined) update.last_error = patch.error;
  await db().from(MONITORS_TABLE).update(update).eq("id", id);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listMonitors(): Promise<MailboxMonitor[]> {
  const { data, error } = await db()
    .from(MONITORS_TABLE)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new MailboxMonitorError(error.message, 500);
  const rows = (data ?? []) as MonitorRow[];
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
  const appPassword = (input.appPassword ?? "").trim();
  if (!isEmail(email)) throw new MailboxMonitorError("Enter a valid mailbox email address.");
  if (appPassword.length < 6) throw new MailboxMonitorError("Paste the mailbox app password.");

  const host = (input.imapHost ?? "").trim() || DEFAULT_IMAP_HOST;
  const port = Number.isFinite(input.imapPort) && Number(input.imapPort) > 0 ? Number(input.imapPort) : DEFAULT_IMAP_PORT;
  const secure = input.imapSecure === undefined ? true : Boolean(input.imapSecure);

  const { data: existing } = await db().from(MONITORS_TABLE).select("id").eq("email_address", email).maybeSingle();
  if (existing) throw new MailboxMonitorError("That mailbox is already being monitored.", 409);

  // Prove the credential works before we store it.
  const connection: MailboxConnection = { host, password: appPassword, port, secure, user: email };
  const test = await testMailboxConnection(connection);
  if (!test.ok) {
    await logAccess({ action: "add", actorHrId, detail: { emailAddress: email, failed: true }, emailAddress: email, monitorId: null });
    throw new MailboxMonitorError(`Could not connect to that mailbox: ${test.error}`, 422);
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
  if (error) throw new MailboxMonitorError(error.message, 500);

  const row = data as MonitorRow;
  await logAccess({ action: "add", actorHrId, emailAddress: email, monitorId: row.id });
  const names = await resolveEmployeeNames([row.employee_hr_id ?? ""]);
  return rowToMonitor(row, row.employee_hr_id ? names.get(row.employee_hr_id) ?? null : null);
}

/** Remove a monitored mailbox (deletes the credential). The access log row survives (monitor_id
 *  becomes null via ON DELETE SET NULL) so the history of who read it is not erased. */
export async function deleteMonitor(id: string, actorHrId: string | null): Promise<void> {
  const row = await loadRow(id);
  await logAccess({ action: "delete", actorHrId, emailAddress: row.email_address, monitorId: id });
  const { error } = await db().from(MONITORS_TABLE).delete().eq("id", id);
  if (error) throw new MailboxMonitorError(error.message, 500);
}

/** Re-test a monitor's credential and update its health. Returns the refreshed monitor. */
export async function recheckMonitor(id: string, actorHrId: string | null): Promise<MailboxMonitor> {
  const row = await loadRow(id);
  const test = await testMailboxConnection(connectionFromRow(row));
  if (test.ok) {
    await markHealth(id, { ok: true, status: "active" });
  } else {
    await markHealth(id, { error: test.error, status: "failing" });
  }
  await logAccess({
    action: "connect_test",
    actorHrId,
    detail: { ok: test.ok },
    emailAddress: row.email_address,
    monitorId: id,
  });
  const refreshed = await loadRow(id);
  const names = await resolveEmployeeNames([refreshed.employee_hr_id ?? ""]);
  return rowToMonitor(refreshed, refreshed.employee_hr_id ? names.get(refreshed.employee_hr_id) ?? null : null);
}

/** Wrap a live IMAP read: resolve the connection, run it, log it, and translate a connection
 *  failure into a health downgrade + a clean error (a revoked app password lands here). */
async function withMonitorRead<T>(
  id: string,
  actorHrId: string | null,
  action: string,
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
    await markHealth(id, { error: message, status: "failing" });
    await logAccess({
      action,
      actorHrId,
      detail: { failed: true },
      emailAddress: row.email_address,
      folder: meta.folder ?? null,
      messageUid: meta.messageUid ?? null,
      monitorId: id,
    });
    throw new MailboxMonitorError(
      `Could not read the mailbox — it may have been closed or the app password revoked. (${message})`,
      502,
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
