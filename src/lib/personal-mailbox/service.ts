// Personal mailbox — domain service. The one place that reads/writes personal_mailbox_connections,
// seals/opens a person's app password, and drives their IMAP and SMTP sessions. Routes call this;
// they never touch the table, the cipher or a mail client directly.
//
// WHO CAN REACH A MAILBOX. Exactly one person: its owner. There is no id in any request — every
// function here takes the resolved session and derives the owner from it (mailboxOwnerKey), so no
// input exists by which one employee could name another's mailbox, and no role (Super Admin
// included) has a screen or route that lists or opens these rows. The compliance monitor
// (src/lib/mailbox-monitor/) is a separate table and a separate crypto context: its code cannot
// decrypt one of these passwords even holding the row (tests/personal-mailbox.test.ts pins both).
// A row is also bound to the LOGIN that connected it, not only to the HR id: app_auth_users.hr_id
// is not unique and user admin can put any HR id on any login, so a second login carrying someone's
// HR id reads as "not connected" here and can neither open nor remove their mailbox.
//
// THE LOCKOUT RULE. Yahoo locks a mailbox after enough failed logins, and that lockout would land on
// the person's real company email. So the first time Turbify refuses the saved password, the row
// flips to needs_reconnect and nothing here logs in with it again — the person pastes a new app
// password to recover. Sending is never retried either: a failed send is reported, not repeated.

import type { AccessContext } from "@/lib/auth/permissions";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { describeImapError, normalizeAppPassword } from "@/lib/mailbox-monitor/imap-error";
import { logError } from "@/lib/observability/log";
import {
  ensureCopyInSent,
  listFolderPage,
  openFolderMessage,
  readFolderAttachment,
  verifyImapLogin,
} from "@/lib/personal-mailbox/imap";
import {
  describeSmtpError,
  isAuthenticationFailure,
  mailboxOwnerKey,
  normalizeAddress,
  PERSONAL_MAILBOX_SECRET_CONTEXT,
  PersonalMailboxError,
  validateSendInput,
} from "@/lib/personal-mailbox/rules";
import { composeMessage, sendComposedMessage, verifySmtpLogin } from "@/lib/personal-mailbox/smtp";
import type {
  PersonalMailboxCredential,
  PersonalMailboxFolder,
  PersonalMailboxMessage,
  PersonalMailboxPage,
  PersonalMailboxSendInput,
  PersonalMailboxState,
  PersonalMailboxStatus,
} from "@/lib/personal-mailbox/types";
import { openSecret, sealSecret } from "@/lib/security/secret-box";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const CONNECTIONS_TABLE = "personal_mailbox_connections";
const SECRET_OPTIONS = { context: PERSONAL_MAILBOX_SECRET_CONTEXT } as const;
/** last_ok_at is a "still working" marker, not an audit trail — refresh it at most this often. */
const LAST_OK_REFRESH_MS = 10 * 60_000;
const MAX_ERROR_LENGTH = 400;

function readFailure(error: unknown): string {
  return `Your mailbox did not answer: ${describeImapError(error)}.`;
}

/** A send that failed mid-way may still have been delivered — say so, so nobody sends it twice. */
function sendFailure(error: unknown): string {
  return `The email was not confirmed as sent: ${describeSmtpError(error)}. Look in Sent before sending it again.`;
}

type ConnectionRow = {
  id: string;
  owner_key: string;
  owner_hr_id: string | null;
  owner_login_id: string | null;
  email_address: string;
  sealed_password: string;
  status: PersonalMailboxStatus;
  last_ok_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

/** The signed-in person, as far as their mailbox is concerned. Built from the session only. */
export type PersonalMailboxOwner = {
  key: string;
  hrId: string | null;
  /** The signed-in login. A connection answers to this login only (see the header). */
  loginId: string;
  /** Their company address on record — the only address they can connect. */
  emailAddress: string | null;
  displayName: string | null;
};

function db() {
  return getSupabaseAdmin();
}

function clip(value: string): string {
  return value.length > MAX_ERROR_LENGTH ? value.slice(0, MAX_ERROR_LENGTH) : value;
}

/**
 * Resolve whose mailbox a request is about. A guest (an unauthenticated caller resolves to the
 * Employee role, so the role proves nothing — the source does) and the system identity have none.
 */
export async function resolveMailboxOwner(access: AccessContext): Promise<PersonalMailboxOwner> {
  if (access.source === "guest" || access.source === "system") {
    throw new PersonalMailboxError("Sign in to use your email.", 401);
  }
  const key = mailboxOwnerKey(access);
  const hrId = access.hrId?.trim() || null;
  // Every real session carries its login; only the localhost dev-header identity has none.
  const loginId = access.loginId?.trim() || null;
  if (!key || !loginId) throw new PersonalMailboxError("Sign in to use your email.", 401);

  let workEmail: string | null = null;
  let employeeName: string | null = null;
  if (hrId) {
    const { data, error } = await db()
      .from("employees")
      .select("work_email,full_name")
      .eq("hr_id", hrId)
      .maybeSingle();
    if (error) throw error;
    const row = data as { work_email?: string | null; full_name?: string | null } | null;
    workEmail = row?.work_email ?? null;
    employeeName = row?.full_name?.trim() || null;
  }

  const { data: loginRow, error: loginError } = await db()
    .from("app_auth_users")
    .select("email,name")
    .eq("login_id", loginId)
    .limit(1)
    .maybeSingle();
  if (loginError) throw loginError;
  const login = loginRow as { email?: string | null; name?: string | null } | null;
  const loginEmail = login?.email ?? null;
  const loginName = login?.name?.trim() || null;

  // The employee record first: it is the company mailbox, and on production the login's own
  // address never disagrees with it. pickDeliverableEmail drops the synthetic @auth.phoenix.local
  // identity, which is not a mailbox.
  const address = pickDeliverableEmail(workEmail, loginEmail);
  return {
    displayName: employeeName ?? loginName,
    emailAddress: address ? normalizeAddress(address) : null,
    hrId,
    key,
    loginId,
  };
}

async function loadConnection(owner: PersonalMailboxOwner): Promise<ConnectionRow | null> {
  const { data, error } = await db()
    .from(CONNECTIONS_TABLE)
    .select("*")
    .eq("owner_key", owner.key)
    .eq("owner_login_id", owner.loginId)
    .maybeSingle();
  if (error) throw error;
  return (data as ConnectionRow | null) ?? null;
}

async function markNeedsReconnect(row: ConnectionRow, reason: string): Promise<void> {
  const { error } = await db()
    .from(CONNECTIONS_TABLE)
    .update({ last_error: clip(reason), status: "needs_reconnect", updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (error) {
    // The refusal itself still reaches the person; only the flag failed to stick. Recorded so a
    // mailbox that keeps being retried against a dead password is visible to whoever looks.
    logError("Personal mailbox could not be marked for reconnect", {
      error,
      labels: { event: "personal_mailbox_mark_reconnect_failed" },
    });
  }
}

async function touchLastOk(row: ConnectionRow): Promise<void> {
  const last = row.last_ok_at ? Date.parse(row.last_ok_at) : 0;
  if (Number.isFinite(last) && Date.now() - last < LAST_OK_REFRESH_MS) return;
  const now = new Date().toISOString();
  await db().from(CONNECTIONS_TABLE).update({ last_ok_at: now, updated_at: now }).eq("id", row.id);
}

function addressChangedMessage(owner: PersonalMailboxOwner): string {
  return owner.emailAddress
    ? `Your company email on record is now ${owner.emailAddress}. Connect it again.`
    : "HR has no company email on file for you any more. Ask HR to add it, then connect again.";
}

export async function getPersonalMailboxState(owner: PersonalMailboxOwner): Promise<PersonalMailboxState> {
  const row = await loadConnection(owner);
  if (!row) return { connected: false, emailAddress: owner.emailAddress };
  const addressChanged = normalizeAddress(row.email_address) !== normalizeAddress(owner.emailAddress);
  return {
    connected: true,
    connectedAt: row.created_at,
    // After HR changes the address, the reconnect card must show the NEW one — it is what connects.
    emailAddress: addressChanged ? owner.emailAddress ?? row.email_address : row.email_address,
    lastError: addressChanged ? addressChangedMessage(owner) : row.last_error,
    status: addressChanged ? "needs_reconnect" : row.status,
  };
}

/**
 * Prove a pasted app password against BOTH servers, then store it sealed. One login each: a wrong
 * password costs the person two failed attempts on their own mailbox, never more — the route caps
 * how often this can run.
 */
export async function connectPersonalMailbox(
  owner: PersonalMailboxOwner,
  rawPassword: string,
): Promise<PersonalMailboxState> {
  if (!owner.emailAddress) {
    throw new PersonalMailboxError(
      "HR has no company email on file for you, so there is nothing to connect. Ask HR to add it.",
      409,
    );
  }
  const password = normalizeAppPassword(rawPassword);
  if (password.length < 8 || password.length > 64) {
    throw new PersonalMailboxError("Paste the app password exactly as Turbify showed it.");
  }
  const credential: PersonalMailboxCredential = { password, user: owner.emailAddress };

  try {
    await verifyImapLogin(credential);
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      throw new PersonalMailboxError(
        "Turbify refused that app password. Create a new one and paste it here — the letters only.",
      );
    }
    throw new PersonalMailboxError(`Could not reach your mailbox: ${describeImapError(error)}.`, 502, {
      diagnostic: true,
    });
  }
  try {
    await verifySmtpLogin(credential);
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      throw new PersonalMailboxError(
        "Turbify accepted that app password for reading but refused it for sending. Create a new one and paste it here.",
      );
    }
    throw new PersonalMailboxError(`Could not reach the sending server: ${describeSmtpError(error)}.`, 502, {
      diagnostic: true,
    });
  }

  const now = new Date().toISOString();
  const { error } = await db()
    .from(CONNECTIONS_TABLE)
    .upsert(
      {
        email_address: owner.emailAddress,
        last_error: null,
        last_ok_at: now,
        owner_hr_id: owner.hrId,
        owner_key: owner.key,
        owner_login_id: owner.loginId,
        sealed_password: sealSecret(password, SECRET_OPTIONS),
        status: "active",
        updated_at: now,
      },
      { onConflict: "owner_key" },
    );
  if (error) throw error;
  return getPersonalMailboxState(owner);
}

/** Forget the connection. The app password itself stays valid in Turbify until the person deletes it there. */
export async function disconnectPersonalMailbox(owner: PersonalMailboxOwner): Promise<PersonalMailboxState> {
  const { error } = await db()
    .from(CONNECTIONS_TABLE)
    .delete()
    .eq("owner_key", owner.key)
    .eq("owner_login_id", owner.loginId);
  if (error) throw error;
  return { connected: false, emailAddress: owner.emailAddress };
}

/**
 * Run one mail operation with the owner's live credential. Refuses before any login when there is
 * no connection, when Turbify already refused the saved password, or when HR's address on record
 * has moved away from the connected one.
 */
async function withCredential<T>(
  owner: PersonalMailboxOwner,
  failureMessage: (error: unknown) => string,
  fn: (
    credential: PersonalMailboxCredential,
    /** For a refusal `fn` absorbs itself: it must still stop every later login (the lockout rule). */
    markRefused: () => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  const row = await loadConnection(owner);
  if (!row) throw new PersonalMailboxError("Connect your email first.", 404);
  if (normalizeAddress(row.email_address) !== normalizeAddress(owner.emailAddress)) {
    throw new PersonalMailboxError(addressChangedMessage(owner), 409);
  }
  if (row.status === "needs_reconnect") {
    throw new PersonalMailboxError(
      "Turbify refused your saved app password. Paste a new one to reconnect.",
      409,
    );
  }

  let password: string;
  try {
    password = openSecret(row.sealed_password, SECRET_OPTIONS);
  } catch (error) {
    await markNeedsReconnect(row, "the saved app password could not be read");
    logError("Personal mailbox password could not be opened", {
      error,
      labels: { event: "personal_mailbox_open_secret_failed" },
    });
    throw new PersonalMailboxError("Your saved app password could not be read. Paste it again to reconnect.", 409);
  }

  let refused = false;
  const markRefused = async () => {
    refused = true;
    await markNeedsReconnect(row, "Turbify refused the saved app password");
  };
  try {
    const result = await fn({ password, user: row.email_address }, markRefused);
    if (!refused) await touchLastOk(row).catch(() => undefined);
    return result;
  } catch (error) {
    if (error instanceof PersonalMailboxError) throw error;
    if (isAuthenticationFailure(error)) {
      await markNeedsReconnect(row, "Turbify refused the saved app password");
      throw new PersonalMailboxError(
        "Turbify refused your saved app password — it was probably deleted or changed. Paste a new one to reconnect.",
        409,
      );
    }
    throw new PersonalMailboxError(failureMessage(error), 502, { diagnostic: true });
  }
}

export async function listPersonalMailboxFolder(
  owner: PersonalMailboxOwner,
  folder: PersonalMailboxFolder,
  before: number | null,
): Promise<PersonalMailboxPage> {
  return withCredential(owner, readFailure, (credential) => listFolderPage(credential, folder, before));
}

export async function openPersonalMailboxMessage(
  owner: PersonalMailboxOwner,
  folder: PersonalMailboxFolder,
  uid: number,
): Promise<PersonalMailboxMessage> {
  const message = await withCredential(owner, readFailure, (credential) =>
    openFolderMessage(credential, folder, uid),
  );
  if (!message) throw new PersonalMailboxError("That email is no longer in this folder.", 404);
  return message;
}

export async function readPersonalMailboxAttachment(
  owner: PersonalMailboxOwner,
  folder: PersonalMailboxFolder,
  uid: number,
  index: number,
): Promise<{ filename: string | null; content: Buffer }> {
  const attachment = await withCredential(owner, readFailure, (credential) =>
    readFolderAttachment(credential, folder, uid, index),
  );
  if (!attachment) throw new PersonalMailboxError("That attachment is no longer available.", 404);
  return attachment;
}

/**
 * Send one email as the owner, from their own address, through Turbify. Sent once — never retried,
 * because a send that failed after the server took it would otherwise reach the recipient twice.
 * Filing a copy in Sent is best-effort: the email has already gone when it runs.
 */
export async function sendPersonalMailboxEmail(
  owner: PersonalMailboxOwner,
  input: PersonalMailboxSendInput,
): Promise<{ rejected: string[]; filedInSent: boolean }> {
  validateSendInput(input);
  return withCredential(owner, sendFailure, async (credential, markRefused) => {
    const { messageId, raw } = await composeMessage(input, {
      address: credential.user,
      name: owner.displayName ?? "",
    });
    const { rejected } = await sendComposedMessage(
      credential,
      { from: credential.user, to: [...input.to, ...input.cc] },
      raw,
    );
    let filedInSent = true;
    try {
      await ensureCopyInSent(credential, raw, messageId);
    } catch (error) {
      filedInSent = false;
      // The email is already out, so this is not a failed send — but a refusal here (the reading
      // server rejecting a password the sending server took) must still stop every later login.
      if (isAuthenticationFailure(error)) await markRefused();
      logError("Personal mailbox sent email could not be filed in Sent", {
        error,
        labels: { event: "personal_mailbox_file_sent_failed" },
      });
    }
    return { filedInSent, rejected };
  });
}

/**
 * Remove the connection of everyone whose Phoenix login is no longer active, so a leaver's sealed
 * password does not outlive their access. Run by the daily offboarding sweep. Never throws.
 */
export async function purgeDepartedPersonalMailboxes(): Promise<{ removed: number; error: string | null }> {
  try {
    const { data, error } = await db().rpc("phx_purge_departed_personal_mailboxes");
    if (error) throw error;
    return { error: null, removed: typeof data === "number" ? data : Number(data ?? 0) || 0 };
  } catch (error) {
    logError("Personal mailbox purge of departed owners failed", {
      error,
      labels: { event: "personal_mailbox_purge_failed" },
    });
    return { error: error instanceof Error ? error.message : "purge failed", removed: 0 };
  }
}
