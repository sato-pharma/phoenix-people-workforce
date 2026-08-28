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

/** Result of a connection test — used both when adding and when re-checking health. */
export type MailboxConnectionTest =
  | { ok: true; inboxExists: boolean }
  | { ok: false; error: string };
