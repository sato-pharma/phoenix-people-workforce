// Personal mailbox — IMAP operations on the OWNER's own mailbox.
//
// Unlike the compliance monitor (src/lib/mailbox-monitor/imap-client.ts), which must stay silent and
// opens every folder read-only, this is the owner reading their own mail: opening a message marks it
// read, exactly as Turbify's webmail would. Listing still uses a read-only lock — showing a folder
// should not change anything in it.

import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";

import { isTestDryRunRequest } from "@/lib/auth/test-dry-run";
import { logError } from "@/lib/observability/log";
import {
  embedInlineImages,
  PERSONAL_MAILBOX_ALERT_LIMIT,
  PERSONAL_MAILBOX_PAGE_SIZE,
  TURBIFY_IMAP,
} from "@/lib/personal-mailbox/rules";
import type {
  PersonalMailboxAlertItem,
  PersonalMailboxAttachment,
  PersonalMailboxCredential,
  PersonalMailboxFolder,
  PersonalMailboxMessage,
  PersonalMailboxPage,
  PersonalMailboxSummary,
} from "@/lib/personal-mailbox/types";

async function withClient<T>(credential: PersonalMailboxCredential, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    auth: { pass: credential.password, user: credential.user },
    host: TURBIFY_IMAP.host,
    logger: false,
    port: TURBIFY_IMAP.port,
    secure: TURBIFY_IMAP.secure,
    socketTimeout: 20_000,
  });
  // Attached before connect(): an 'error' with no listener is an uncaught exception in node. Same
  // reasoning as the monitor's client. Never logs the mailbox's content — only that a socket failed.
  client.on("error", (error) => {
    logError("Personal mailbox IMAP connection error", {
      error,
      labels: { event: "personal_mailbox_imap_socket_error" },
    });
  });
  try {
    await client.connect();
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

async function folderPath(client: ImapFlow, folder: PersonalMailboxFolder): Promise<string> {
  if (folder === "inbox") return "INBOX";
  const folders = (await client.list()) as ListResponse[];
  const bySpecialUse = folders.find((entry) => (entry as { specialUse?: string }).specialUse === "\\Sent");
  if (bySpecialUse) return bySpecialUse.path;
  const byName = folders.find((entry) => /^sent/i.test(entry.name ?? entry.path));
  return byName?.path ?? "Sent";
}

function envelopeAddresses(source: unknown): Array<{ address: string | null; name: string | null }> {
  if (!Array.isArray(source)) return [];
  return source.map((entry) => {
    const e = entry as { address?: unknown; name?: unknown };
    return {
      address: typeof e.address === "string" && e.address ? e.address : null,
      name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : null,
    };
  });
}

function hasAttachment(structure: unknown): boolean {
  if (!structure || typeof structure !== "object") return false;
  const node = structure as { childNodes?: unknown; disposition?: unknown };
  if (typeof node.disposition === "string" && node.disposition.toLowerCase() === "attachment") return true;
  return Array.isArray(node.childNodes) && node.childNodes.some((child) => hasAttachment(child));
}

/** Every address on a mailparser address field, which is an array when the header repeated. */
function addressesOf(field: AddressObject | AddressObject[] | undefined): string[] {
  const objects = Array.isArray(field) ? field : field ? [field] : [];
  const out: string[] = [];
  const walk = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const e = entry as { address?: unknown; group?: unknown };
      if (typeof e.address === "string" && e.address) out.push(e.address);
      else if (Array.isArray(e.group)) walk(e.group);
    }
  };
  for (const object of objects) walk(object.value);
  return out;
}

/** Log in and open the inbox read-only. Throws the server's refusal as-is for the caller to read. */
export async function verifyImapLogin(credential: PersonalMailboxCredential): Promise<void> {
  await withClient(credential, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    lock.release();
  });
}

/** One page of a folder, newest first. `before` is the UID the previous page stopped at. */
export async function listFolderPage(
  credential: PersonalMailboxCredential,
  folder: PersonalMailboxFolder,
  before: number | null,
): Promise<PersonalMailboxPage> {
  return withClient(credential, async (client) => {
    const path = await folderPath(client, folder);
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const found = await client.search({ all: true }, { uid: true });
      const uids = (Array.isArray(found) ? found : [])
        .filter((uid) => before === null || uid < before)
        .sort((a, b) => a - b);
      if (uids.length === 0) return { folder, messages: [], nextBefore: null };

      const page = uids.slice(-PERSONAL_MAILBOX_PAGE_SIZE);
      const messages: PersonalMailboxSummary[] = [];
      for await (const message of client.fetch(
        page.join(","),
        { bodyStructure: true, envelope: true, flags: true, uid: true },
        { uid: true },
      )) {
        const envelope = message.envelope ?? ({} as NonNullable<typeof message.envelope>);
        const from = envelopeAddresses(envelope.from)[0] ?? { address: null, name: null };
        const flags = message.flags ?? new Set<string>();
        messages.push({
          answered: flags.has("\\Answered"),
          date: envelope.date ? new Date(envelope.date).toISOString() : null,
          fromAddress: from.address,
          fromName: from.name,
          hasAttachments: hasAttachment(message.bodyStructure),
          seen: flags.has("\\Seen"),
          subject: envelope.subject ?? null,
          toAddresses: envelopeAddresses(envelope.to)
            .map((entry) => entry.address)
            .filter((address): address is string => Boolean(address)),
          uid: message.uid,
        });
      }
      messages.sort((a, b) => b.uid - a.uid);
      return { folder, messages, nextBefore: uids.length > page.length ? page[0] : null };
    } finally {
      lock.release();
    }
  });
}

/**
 * The inbox at a glance for the envelope: how many emails are unread, the newest few of them (sender
 * and subject only), and the UID the next arrival will get. Read-only, so a check never marks
 * anything read — only opening an email does that.
 */
export async function readInboxStatus(credential: PersonalMailboxCredential): Promise<{
  unread: number;
  uidValidity: string;
  watermark: number;
  newestUnread: PersonalMailboxAlertItem[];
}> {
  return withClient(credential, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mailbox = client.mailbox || null;
      const found = await client.search({ seen: false }, { uid: true });
      const unseen = (Array.isArray(found) ? found : []).sort((a, b) => a - b);
      const newest = unseen.slice(-PERSONAL_MAILBOX_ALERT_LIMIT);

      const newestUnread: PersonalMailboxAlertItem[] = [];
      if (newest.length > 0) {
        for await (const message of client.fetch(newest.join(","), { envelope: true, uid: true }, { uid: true })) {
          const envelope = message.envelope ?? ({} as NonNullable<typeof message.envelope>);
          const from = envelopeAddresses(envelope.from)[0] ?? { address: null, name: null };
          newestUnread.push({
            date: envelope.date ? new Date(envelope.date).toISOString() : null,
            fromAddress: from.address,
            fromName: from.name,
            subject: envelope.subject ?? null,
            uid: message.uid,
          });
        }
      }
      newestUnread.sort((a, b) => b.uid - a.uid);

      // UIDNEXT is what makes "new since the last look" exact. A server that withholds it still gets a
      // working watermark from the newest unread UID: whatever arrives unread after it sorts above it.
      const highestUnread = unseen.length > 0 ? unseen[unseen.length - 1] : 0;
      const watermark =
        mailbox && Number.isInteger(mailbox.uidNext) && mailbox.uidNext > 0 ? mailbox.uidNext : highestUnread + 1;
      return {
        newestUnread,
        uidValidity: mailbox ? String(mailbox.uidValidity) : "unknown",
        unread: unseen.length,
        watermark,
      };
    } finally {
      lock.release();
    }
  });
}

/**
 * Open one message for the reader and mark it read, as any mail client does. Returns null when the
 * UID is gone (moved or deleted in Turbify since the list was drawn).
 */
export async function openFolderMessage(
  credential: PersonalMailboxCredential,
  folder: PersonalMailboxFolder,
  uid: number,
): Promise<PersonalMailboxMessage | null> {
  return withClient(credential, async (client) => {
    const path = await folderPath(client, folder);
    const lock = await client.getMailboxLock(path);
    try {
      const fetched = await client.fetchOne(String(uid), { flags: true, source: true }, { uid: true });
      if (!fetched || typeof fetched === "boolean" || !fetched.source) return null;
      if (!(fetched.flags ?? new Set<string>()).has("\\Seen")) {
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      }
      const mail = await simpleParser(fetched.source);

      const all = mail.attachments ?? [];
      const inline = all
        .filter((attachment) => attachment.related && attachment.contentId)
        .map((attachment) => ({
          base64: attachment.content.toString("base64"),
          contentId: attachment.contentId ?? null,
          contentType: attachment.contentType ?? null,
        }));
      const attachments: PersonalMailboxAttachment[] = [];
      all.forEach((attachment, index) => {
        if (attachment.related && attachment.contentId) return; // shown inline in the body instead
        attachments.push({
          contentType: attachment.contentType ?? null,
          filename: attachment.filename ?? null,
          index,
          sizeBytes: typeof attachment.size === "number" ? attachment.size : null,
        });
      });

      const references = Array.isArray(mail.references)
        ? mail.references
        : typeof mail.references === "string"
          ? mail.references.split(/\s+/).filter(Boolean)
          : [];
      const from = mail.from?.value?.[0];
      const html = typeof mail.html === "string" ? embedInlineImages(mail.html, inline) : null;

      return {
        attachments,
        ccAddresses: addressesOf(mail.cc),
        date: mail.date ? new Date(mail.date).toISOString() : null,
        folder,
        fromAddress: from?.address ?? null,
        fromName: from?.name || null,
        html,
        messageId: mail.messageId ?? null,
        references,
        replyToAddresses: addressesOf(mail.replyTo),
        subject: mail.subject ?? null,
        text: mail.text ?? null,
        toAddresses: addressesOf(mail.to),
        uid,
      };
    } finally {
      lock.release();
    }
  });
}

/** The bytes of one attachment, by its position in the parsed message. Read-only. */
export async function readFolderAttachment(
  credential: PersonalMailboxCredential,
  folder: PersonalMailboxFolder,
  uid: number,
  index: number,
): Promise<{ filename: string | null; content: Buffer } | null> {
  return withClient(credential, async (client) => {
    const path = await folderPath(client, folder);
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!fetched || typeof fetched === "boolean" || !fetched.source) return null;
      const mail = await simpleParser(fetched.source);
      const attachment = (mail.attachments ?? [])[index];
      if (!attachment) return null;
      return { content: attachment.content, filename: attachment.filename ?? null };
    } finally {
      lock.release();
    }
  });
}

async function sentHasMessage(client: ImapFlow, path: string, messageId: string): Promise<boolean> {
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
    return Array.isArray(found) && found.length > 0;
  } finally {
    lock.release();
  }
}

/**
 * Make sure a just-sent email shows in the owner's Sent folder. Yahoo normally files mail sent
 * through its own server there by itself; this looks first, waits once, and only appends when the
 * copy is still missing — so a server that files it never ends up with two.
 */
export async function ensureCopyInSent(
  credential: PersonalMailboxCredential,
  raw: Buffer,
  messageId: string,
): Promise<"already_filed" | "appended"> {
  // IMAP is not fetch either: a test account's dry run files nothing (src/lib/auth/test-dry-run.ts).
  if (await isTestDryRunRequest()) return "already_filed";
  return withClient(credential, async (client) => {
    const path = await folderPath(client, "sent");
    if (await sentHasMessage(client, path, messageId)) return "already_filed";
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    if (await sentHasMessage(client, path, messageId)) return "already_filed";
    await client.append(path, raw, ["\\Seen"]);
    return "appended";
  });
}
