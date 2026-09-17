// Mailbox compliance monitor — shared types (no I/O).

export type MailboxMonitorStatus = "active" | "failing" | "disabled" | "revoked";

/** A monitored mailbox as the owner sees it — NEVER carries the password (sealed or plain). */
export type MailboxMonitor = {
  id: string;
  emailAddress: string;
  employeeHrId: string | null;
  employeeName: string | null;
  displayLabel: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  status: MailboxMonitorStatus;
  lastOkAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The live IMAP connection descriptor, assembled server-side from a decrypted monitor row. */
export type MailboxConnection = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
};

/** Input to add a new monitored mailbox (the owner pastes the app password). */
export type AddMailboxMonitorInput = {
  emailAddress: string;
  appPassword: string;
  employeeHrId?: string | null;
  displayLabel?: string | null;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
};

/**
 * A company mailbox Phoenix ALREADY holds working credentials for (the recruitment intake inboxes
 * in RECRUITMENT_EMAIL_INBOXES_JSON) that is not yet monitored. Carries the address and label only
 * — never the password — so it is safe to send to the browser as an "available to import" row.
 */
export type ImportableMailbox = {
  emailAddress: string;
  label: string;
};

/** The outcome of importing the already-configured mailboxes. */
export type ImportConfiguredResult = {
  imported: MailboxMonitor[];
  skipped: number;
  failures: Array<{ emailAddress: string; error: string }>;
};

/** One IMAP folder/mailbox path. */
export type MailboxFolder = {
  path: string;
  name: string;
  specialUse: string | null;
};

/** One message envelope in a folder listing — enough for a list row, no body. */
export type MailboxMessageSummary = {
  uid: number;
  seq: number | null;
  fromName: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  subject: string | null;
  date: string | null;
  seen: boolean;
  answered: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  sizeBytes: number | null;
};

/** One attachment's metadata (never the bytes) in a fetched message. */
export type MailboxAttachmentMeta = {
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
};

/** A fully fetched message for the reader pane. */
export type MailboxMessageDetail = {
  uid: number;
  fromName: string | null;
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  date: string | null;
  text: string | null;
  html: string | null;
  attachments: MailboxAttachmentMeta[];
};

/**
 * Every action the access log records — the whole vocabulary, in one place.
 *
 * `mailbox_monitor_access_log.action` is a plain text column with no check constraint, and the
 * list of legal values was written as a COMMENT in the migration that created the table
 * (20260828123000_mailbox_compliance_monitor.sql). `replace_password` was then added to the
 * service without it — the comment still says "add | delete | connect_test | list_folders |
 * list_messages | open_message | update", so the only written record of the vocabulary is now
 * wrong, and nothing anywhere would have caught that.
 *
 * An applied migration is a historical record and is never edited, so the vocabulary lives here
 * instead, where the compiler holds it: a new action has to be added to this union before it can
 * be logged. `update` is kept because rows carrying it exist in the table from before the
 * replace-password path was split out of it.
 */
export type MailboxAccessAction =
  | "add"
  | "connect_test"
  | "delete"
  | "list_folders"
  | "list_messages"
  | "open_message"
  | "replace_password"
  | "update";

/** Result of a connection test — used both when adding and when re-checking health. */
export type MailboxConnectionTest =
  | { ok: true; inboxExists: boolean }
  | { ok: false; error: string };
