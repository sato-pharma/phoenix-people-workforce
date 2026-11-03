// Personal mailbox — domain service. The one place that reads/writes personal_mailbox_connections,
// seals/opens a person's app password, and drives their IMAP and SMTP sessions. Routes call this;
// they never touch the table, the cipher or a mail client directly.
//
// WHO CAN REACH A MAILBOX. Exactly one person: its owner. There is no id in any request — every
// function here takes the resolved session and derives the owner from it (mailboxOwnerKey), so no
// input exists by which one employee could name another's mailbox, and no role (Super Admin
// included) has a screen or route that lists or opens these rows.
//
// ONE PATH WRITES A ROW FOR SOMEBODY ELSE, AND ONLY WRITES: connectNewHireMailbox, behind the New
// Hire Mailboxes page (owner instruction 2026-09-18). Whoever creates a new hire's mailbox in
// Turbify generates its app password there, and handing it straight to Phoenix is what makes the
// hire's My email work on day one with nothing for them to do. It binds the password to the hire's
// OWN active login, never opens or returns a stored one, and refuses anybody who already has a
// connection — so it can never replace, read or redirect a mailbox a person connected themselves.
// The compliance monitor
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
import { invalidatePersonalMailboxConnectionCache, PERSONAL_MAILBOX_CONNECTION_CACHE_TAG } from "@/lib/dashboard/invalidation";
import { pickDeliverableEmail } from "@/lib/email/email-safety";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { describeImapError, normalizeAppPassword } from "@/lib/mailbox-monitor/imap-error";
import { logError } from "@/lib/observability/log";
import {
  ensureCopyInSent,
  listFolderPage,
  openFolderMessage,
  readFolderAttachment,
  readInboxStatus,
  verifyImapLogin,
} from "@/lib/personal-mailbox/imap";
import {
  describeSmtpError,
  isAuthenticationFailure,
  mailboxOwnerKey,
  isPlausibleAddress,
  normalizeAddress,
  PERSONAL_MAILBOX_SECRET_CONTEXT,
  PersonalMailboxError,
  validateSendInput,
} from "@/lib/personal-mailbox/rules";
import { composeMessage, sendComposedMessage, verifySmtpLogin } from "@/lib/personal-mailbox/smtp";
import type {
  PersonalMailboxCredential,
  PersonalMailboxFolder,
  PersonalMailboxInboxStatus,
  PersonalMailboxMessage,
  PersonalMailboxPage,
  PersonalMailboxSendInput,
  PersonalMailboxState,
  PersonalMailboxStatus,
} from "@/lib/personal-mailbox/types";
import { openSecret, sealSecret } from "@/lib/security/secret-box";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { unstable_cache } from "next/cache.js";

const CONNECTIONS_TABLE = "personal_mailbox_connections";
const SECRET_OPTIONS = { context: PERSONAL_MAILBOX_SECRET_CONTEXT } as const;
/** last_ok_at is a "still working" marker, not an audit trail — refresh it at most this often. */
const LAST_OK_REFRESH_MS = 10 * 60_000;
const MAX_ERROR_LENGTH = 400;
/**
 * Every open Phoenix tab asks for the unread count every couple of minutes. One answer serves all of
 * a person's tabs for this long, so three open tabs cost one login, not three. It holds counts,
 * senders and subjects, in this server's memory only, and never the password.
 */
const INBOX_STATUS_CACHE_MS = 90_000;
const inboxStatusCache = new Map<string, { at: number; value: Promise<PersonalMailboxInboxStatus> }>();

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

/** How long a shell may trust its memory of "connected / not connected" before reading the row again. */
const CONNECTION_CACHE_SECONDS = 300;

const readConnectionActive = unstable_cache(
  async (ownerKey: string, loginId: string): Promise<boolean> => {
    const { data, error } = await db()
      .from(CONNECTIONS_TABLE)
      .select("status")
      .eq("owner_key", ownerKey)
      .eq("owner_login_id", loginId)
      .maybeSingle();
    if (error) throw error;
    return (data as { status?: string } | null)?.status === "active";
  },
  ["personal-mailbox-connection-active"],
  { revalidate: CONNECTION_CACHE_SECONDS, tags: [PERSONAL_MAILBOX_CONNECTION_CACHE_TAG] },
);

/**
 * Whether this person has "My email" connected and working — ONE small read, remembered for five
 * minutes and busted by every write that changes it — for the shell to print into its HTML so the
 * envelope asks the mailbox only when there is one (1 Nov 2026).
 *
 * WHY. The envelope's unread check ran on every page view, for every role, through
 * /api/messages/mailbox/unread: a session read, the owner's employee row, the connection row, then
 * "not connected" — five sequential reads to learn that most people have nothing connected, and
 * again every two minutes and on every return to the tab. Reads the status alone: whether the
 * password still opens the mailbox is the check's own business, once it runs.
 *
 * Never throws: an unreadable row answers false, and the envelope's open panel still tells the
 * truth from its own read.
 */
export async function personalMailboxConnected(access: AccessContext): Promise<boolean> {
  if (access.source === "guest" || access.source === "system") return false;
  const key = mailboxOwnerKey(access);
  const loginId = access.loginId?.trim() || null;
  if (!key || !loginId) return false;
  try {
    return await readConnectionActive(key, loginId);
  } catch {
    return false;
  }
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
    // The session carries the LOWER-CASE comparison key (canonicalHrIdKey) while employees store
    // the display form ("B-10"), so a plain .eq on it matched nobody and every person silently fell
    // back to their login's address. That fallback happened to agree for everyone connected so far;
    // it does not for a new hire whose company address was filled in after their login was made.
    const { data, error } = await db()
      .from("employees")
      .select("work_email,full_name,nickname")
      .in("hr_id", hrIdLookupKeys(hrId))
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const row = data as { work_email?: string | null; full_name?: string | null; nickname?: string | null } | null;
    workEmail = row?.work_email ?? null;
    const fullName = row?.full_name?.trim();
    employeeName = fullName ? resolveEmployeeDisplayName(fullName, row?.nickname, hrId) : null;
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
  invalidatePersonalMailboxConnectionCache("personal mailbox marked for reconnect");
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
 * Prove an app password against BOTH servers and hand back the cleaned password for sealing. One
 * login each: a wrong password costs the mailbox two failed attempts, never more — both routes that
 * reach this cap how often it can run.
 */
async function verifyAppPassword(address: string, rawPassword: string): Promise<string> {
  const password = normalizeAppPassword(rawPassword);
  if (password.length < 8 || password.length > 64) {
    throw new PersonalMailboxError("Paste the app password exactly as Turbify showed it.");
  }
  const credential: PersonalMailboxCredential = { password, user: address };

  try {
    await verifyImapLogin(credential);
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      throw new PersonalMailboxError(
        `Turbify refused that app password for ${address}. Create a new one and paste it here — the letters only.`,
      );
    }
    throw new PersonalMailboxError(`Could not reach the mailbox: ${describeImapError(error)}.`, 502, {
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
  return password;
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
  const password = await verifyAppPassword(owner.emailAddress, rawPassword);

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
  forgetInboxStatus(owner);
  invalidatePersonalMailboxConnectionCache("personal mailbox connected");
  return getPersonalMailboxState(owner);
}

export type NewHireMailboxConnectResult = {
  /** True when this exact address was already connected for the hire: nothing was written. */
  alreadyConnected: boolean;
  emailAddress: string;
};

/**
 * Connect a NEW HIRE's company mailbox to their My email, with the app password created while the
 * mailbox was set up in Turbify. The one function here that writes a row for somebody other than
 * the signed-in person (see the header). Reached only from src/lib/new-hire-mailbox/service.ts,
 * behind `mailbox_offboarding:update`, and it writes — it never reads a stored password back.
 *
 * The row is bound to the hire's OWN login: exactly one active Phoenix login carrying their HR id,
 * with the owner key derived from it exactly as resolveMailboxOwner derives it from that login's
 * session. So the hire's first sign-in finds it, and no other login ever does.
 */
export async function connectNewHireMailbox(input: {
  displayName: string;
  emailAddress: string;
  hrId: string;
  rawPassword: string;
}): Promise<NewHireMailboxConnectResult> {
  const address = normalizeAddress(input.emailAddress);
  if (!isPlausibleAddress(address)) {
    throw new PersonalMailboxError(`"${input.emailAddress.trim()}" is not an email address.`);
  }
  const hrKey = canonicalHrIdKey(input.hrId);
  if (!hrKey) throw new PersonalMailboxError("Choose the employee this mailbox belongs to.");

  const { data: loginRows, error: loginError } = await db()
    .from("app_auth_users")
    .select("login_id,hr_id")
    .in("hr_id", hrIdLookupKeys(input.hrId))
    .eq("is_active", true);
  if (loginError) throw loginError;
  const logins = ((loginRows ?? []) as Array<{ hr_id: string | null; login_id: string | null }>).filter(
    (row) => Boolean(row.login_id?.trim()) && canonicalHrIdKey(row.hr_id) === hrKey,
  );
  if (logins.length === 0) {
    throw new PersonalMailboxError(
      `${input.displayName} has no active Phoenix login, so there is nobody to connect this mailbox to. Give them a login in Users, then try again.`,
      409,
    );
  }
  if (logins.length > 1) {
    throw new PersonalMailboxError(
      `${input.displayName} has ${logins.length} active Phoenix logins, so Phoenix cannot tell which one the mailbox belongs to. Switch off the extra login in Users, then try again.`,
      409,
    );
  }
  const loginId = String(logins[0].login_id).trim();
  const key = mailboxOwnerKey({ hrId: hrKey, loginId });
  if (!key) throw new PersonalMailboxError("Choose the employee this mailbox belongs to.");

  const { data: ownRow, error: ownError } = await db()
    .from(CONNECTIONS_TABLE)
    .select("email_address,owner_login_id")
    .eq("owner_key", key)
    .maybeSingle();
  if (ownError) throw ownError;
  const own = ownRow as { email_address: string; owner_login_id: string | null } | null;
  if (own) {
    if (normalizeAddress(own.email_address) === address && own.owner_login_id === loginId) {
      return { alreadyConnected: true, emailAddress: address };
    }
    throw new PersonalMailboxError(
      `${input.displayName}'s My email is already connected. Phoenix never replaces a connection somebody already has.`,
      409,
    );
  }

  const { data: takenRows, error: takenError } = await db()
    .from(CONNECTIONS_TABLE)
    .select("owner_key")
    .eq("email_address", address)
    .neq("owner_key", key)
    .limit(1);
  if (takenError) throw takenError;
  if ((takenRows ?? []).length > 0) {
    throw new PersonalMailboxError(
      `${address} is already connected to another person's My email. Check the address.`,
      409,
    );
  }

  const password = await verifyAppPassword(address, input.rawPassword);

  const now = new Date().toISOString();
  // INSERT, never upsert: a connection that appeared between the check above and here (the hire
  // connecting it themselves) must win, not be overwritten.
  const { error } = await db()
    .from(CONNECTIONS_TABLE)
    .insert({
      email_address: address,
      last_error: null,
      last_ok_at: now,
      // The same value the hire's own session would write (see connectPersonalMailbox).
      owner_hr_id: hrKey,
      owner_key: key,
      owner_login_id: loginId,
      sealed_password: sealSecret(password, SECRET_OPTIONS),
      status: "active",
      updated_at: now,
    });
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new PersonalMailboxError(
        `${input.displayName}'s My email was connected a moment ago from somewhere else. Nothing was changed.`,
        409,
      );
    }
    throw error;
  }
  invalidatePersonalMailboxConnectionCache("new hire mailbox connected");
  return { alreadyConnected: false, emailAddress: address };
}

/** Forget the connection. The app password itself stays valid in Turbify until the person deletes it there. */
export async function disconnectPersonalMailbox(owner: PersonalMailboxOwner): Promise<PersonalMailboxState> {
  const { error } = await db()
    .from(CONNECTIONS_TABLE)
    .delete()
    .eq("owner_key", owner.key)
    .eq("owner_login_id", owner.loginId);
  if (error) throw error;
  forgetInboxStatus(owner);
  invalidatePersonalMailboxConnectionCache("personal mailbox disconnected");
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
  // Opening marks it read, so the cached unread count is now one too high.
  forgetInboxStatus(owner);
  if (!message) throw new PersonalMailboxError("That email is no longer in this folder.", 404);
  return message;
}

function inboxCacheKey(owner: PersonalMailboxOwner): string {
  return `${owner.key}|${owner.loginId}`;
}

function forgetInboxStatus(owner: PersonalMailboxOwner): void {
  inboxStatusCache.delete(inboxCacheKey(owner));
}

async function checkInbox(owner: PersonalMailboxOwner): Promise<PersonalMailboxInboxStatus> {
  try {
    const status = await withCredential(owner, readFailure, (credential) => readInboxStatus(credential));
    return { kind: "ok", ...status };
  } catch (error) {
    if (error instanceof PersonalMailboxError) {
      if (error.statusCode === 404) return { kind: "not_connected" };
      // withCredential refuses a refused or out-of-date connection BEFORE any login (the lockout rule).
      if (error.statusCode === 409) return { kind: "needs_reconnect" };
      // The mail server did not answer. A background check stays quiet about it: the person hears
      // about it when they open the mailbox, and that path records it in the error monitor.
      if (error.diagnostic) return { kind: "unavailable" };
    }
    throw error;
  }
}

/**
 * The envelope's unread count and new-mail alerts: how many inbox emails are unread and the newest
 * few of them. Read-only, and answered from the short cache above when another tab asked a moment
 * ago, so however many tabs are open a person's mailbox sees at most one login per cache window.
 */
export async function readPersonalMailboxInboxStatus(owner: PersonalMailboxOwner): Promise<PersonalMailboxInboxStatus> {
  const key = inboxCacheKey(owner);
  const now = Date.now();
  const cached = inboxStatusCache.get(key);
  if (cached && now - cached.at < INBOX_STATUS_CACHE_MS) return cached.value;
  for (const [entryKey, entry] of inboxStatusCache) {
    if (now - entry.at >= INBOX_STATUS_CACHE_MS) inboxStatusCache.delete(entryKey);
  }
  const value = checkInbox(owner);
  const entry = { at: now, value };
  inboxStatusCache.set(key, entry);
  // A failure is never served to the next tab as though it were an answer.
  value.catch(() => {
    if (inboxStatusCache.get(key) === entry) inboxStatusCache.delete(key);
  });
  return value;
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
    invalidatePersonalMailboxConnectionCache("departed personal mailboxes purged");
    return { error: null, removed: typeof data === "number" ? data : Number(data ?? 0) || 0 };
  } catch (error) {
    logError("Personal mailbox purge of departed owners failed", {
      error,
      labels: { event: "personal_mailbox_purge_failed" },
    });
    return { error: error instanceof Error ? error.message : "purge failed", removed: 0 };
  }
}
