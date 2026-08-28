// Mailbox compliance monitor — read-only IMAP operations.
//
// THE SILENCE GUARANTEE. Every mailbox is opened with getMailboxLock(..., { readOnly: true }),
// which issues an IMAP EXAMINE (not SELECT). Under EXAMINE the server will NOT set the \Seen flag
// on fetched messages, so reading a monitored mailbox is invisible to its owner: unread mail stays
// unread, nothing is marked, nothing is moved, nothing is deleted. This mirrors the recruitment
// poller (src/lib/recruitment/inbound/email-poller.ts), which relies on exactly this behaviour for
// the shared careers@/hr@ mailboxes, and it is the single most important property of this module.
// Do not add a writable lock, a flag set, or a message move here.

import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";

import type {
  MailboxAttachmentMeta,
  MailboxConnection,
  MailboxConnectionTest,
  MailboxFolder,
  MailboxMessageDetail,
  MailboxMessageSummary,
} from "@/lib/mailbox-monitor/types";

function makeClient(conn: MailboxConnection): ImapFlow {
  return new ImapFlow({
    auth: { pass: conn.password, user: conn.user },
    host: conn.host,
    logger: false,
    port: conn.port,
    secure: conn.secure,
    // Fail fast rather than hang a request when a mailbox host is unreachable or a credential
    // has been revoked and the server stalls the login.
    socketTimeout: 20_000,
  });
}

async function withClient<T>(conn: MailboxConnection, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = makeClient(conn);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* already closed */
      }
    }
  }
}

function firstAddress(source: unknown): { name: string | null; address: string | null } {
  // imapflow envelope address arrays: [{ name, address }]
  if (Array.isArray(source) && source.length > 0) {
    const entry = source[0] as { name?: unknown; address?: unknown };
    return {
      address: typeof entry.address === "string" ? entry.address : null,
      name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null,
    };
  }
  return { address: null, name: null };
}

function allAddresses(source: unknown): string[] {
  if (!Array.isArray(source)) return [];
  return source
    .map((entry) => {
      const e = entry as { address?: unknown };
      return typeof e.address === "string" ? e.address : null;
    })
    .filter((value): value is string => Boolean(value));
}

function bodyStructureHasAttachment(structure: unknown): boolean {
  if (!structure || typeof structure !== "object") return false;
  const node = structure as { disposition?: unknown; childNodes?: unknown; type?: unknown };
  const disposition = typeof node.disposition === "string" ? node.disposition.toLowerCase() : "";
  if (disposition === "attachment") return true;
  if (Array.isArray(node.childNodes)) {
    return node.childNodes.some((child) => bodyStructureHasAttachment(child));
  }
  return false;
}

/**
 * Connect, confirm INBOX is reachable, and disconnect. Used both when the owner adds a mailbox
 * (before the credential is stored) and when re-checking a monitor's health. Never throws — a bad
 * credential or unreachable host comes back as { ok: false, error }.
 */
export async function testMailboxConnection(conn: MailboxConnection): Promise<MailboxConnectionTest> {
  try {
    const inboxExists = await withClient(conn, async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const mailbox = client.mailbox;
        return Boolean(mailbox && typeof mailbox !== "boolean");
      } finally {
        lock.release();
      }
    });
    return { inboxExists, ok: true };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "IMAP connection failed.", ok: false };
  }
}

/** List the mailbox's folders (INBOX, Sent, Drafts, junk, etc.). Read-only. */
export async function listFolders(conn: MailboxConnection): Promise<MailboxFolder[]> {
  return withClient(conn, async (client) => {
    const folders = (await client.list()) as ListResponse[];
    return folders
      .filter((folder) => folder && typeof folder.path === "string")
      .map((folder) => ({
        name: folder.name ?? folder.path,
        path: folder.path,
        specialUse: (folder as { specialUse?: string }).specialUse ?? null,
      }));
  });
}

/**
 * List the most recent `limit` messages in a folder, newest first. Envelopes only — no body is
 * fetched here, so the listing is cheap. Read-only: the \Seen flag of every message is left
 * exactly as the owner left it.
 */
export async function listMessages(
  conn: MailboxConnection,
  folderPath: string,
  options: { limit?: number } = {},
): Promise<MailboxMessageSummary[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  return withClient(conn, async (client) => {
    const lock = await client.getMailboxLock(folderPath, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox || typeof mailbox === "boolean") return [];
      const total = mailbox.exists ?? 0;
      if (total === 0) return [];

      // Sequence window for the newest `limit` messages.
      const start = Math.max(1, total - limit + 1);
      const range = `${start}:${total}`;

      const summaries: MailboxMessageSummary[] = [];
      for await (const message of client.fetch(
        range,
        { bodyStructure: true, envelope: true, flags: true, size: true, uid: true },
        { uid: false },
      )) {
        const envelope = message.envelope ?? ({} as NonNullable<typeof message.envelope>);
        const from = firstAddress(envelope.from);
        const flags = message.flags ?? new Set<string>();
        summaries.push({
          answered: flags.has("\\Answered"),
          date: envelope.date ? new Date(envelope.date).toISOString() : null,
          flagged: flags.has("\\Flagged"),
          fromAddress: from.address,
          fromName: from.name,
          hasAttachments: bodyStructureHasAttachment(message.bodyStructure),
          seen: flags.has("\\Seen"),
          seq: message.seq ?? null,
          sizeBytes: typeof message.size === "number" ? message.size : null,
          subject: envelope.subject ?? null,
          toAddresses: allAddresses(envelope.to),
          uid: message.uid,
        });
      }
      // Newest first.
      summaries.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0));
      return summaries;
    } finally {
      lock.release();
    }
  });
}

/**
 * Fetch and parse one message by UID for the reader pane. Read-only / peek — fetching the source
 * under an EXAMINE lock does not set \Seen, so opening a message here does not mark it read in the
 * owner's mailbox. Returns null if the UID no longer exists.
 */
export async function fetchMessage(
  conn: MailboxConnection,
  folderPath: string,
  uid: number,
): Promise<MailboxMessageDetail | null> {
  return withClient(conn, async (client) => {
    const lock = await client.getMailboxLock(folderPath, { readOnly: true });
    try {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message || typeof message === "boolean" || !message.source) return null;
      const mail = await simpleParser(message.source);

      const attachments: MailboxAttachmentMeta[] = (mail.attachments ?? []).map((attachment) => ({
        contentType: attachment.contentType ?? null,
        filename: attachment.filename ?? null,
        sizeBytes: typeof attachment.size === "number" ? attachment.size : null,
      }));

      const fromValue = mail.from?.value?.[0];
      const toValues = Array.isArray(mail.to) ? [] : mail.to?.value ?? [];
      const ccValues = Array.isArray(mail.cc) ? [] : mail.cc?.value ?? [];

      return {
        attachments,
        ccAddresses: ccValues.map((v) => v.address ?? "").filter(Boolean),
        date: mail.date ? new Date(mail.date).toISOString() : null,
        fromAddress: fromValue?.address ?? null,
        fromName: fromValue?.name || null,
        html: typeof mail.html === "string" ? mail.html : null,
        subject: mail.subject ?? null,
        text: mail.text ?? null,
        toAddresses: toValues.map((v) => v.address ?? "").filter(Boolean),
        uid,
      };
    } finally {
      lock.release();
    }
  });
}
