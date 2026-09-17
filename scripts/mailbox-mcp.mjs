#!/usr/bin/env node
// Mailbox MCP — a read-only IMAP bridge that lets Claude Code itself read a company mailbox.
//
// This is NOT the Phoenix Mailbox Compliance Monitor (src/lib/mailbox-monitor/). That one is a
// screen inside the app, for the owner to read an EMPLOYEE's mailbox under audit. This is a local
// stdio MCP server: Claude Code launches it, it speaks IMAP to one mailbox, and the mail comes
// back as tool results in the conversation. Nothing here touches the Phoenix database, and nothing
// here is reachable from the deployed app.
//
// THE SILENCE GUARANTEE — the same property the compliance monitor is built on, and the reason
// this file is safe to point at a live mailbox. Every folder is opened with
// getMailboxLock(..., { readOnly: true }), which issues an IMAP EXAMINE rather than a SELECT.
// Under EXAMINE the server will not set \Seen on a fetched message, so reading mail through Claude
// leaves the mailbox exactly as its owner left it: unread stays unread, nothing is flagged, moved,
// drafted or deleted. There is deliberately no tool here that writes, sends or deletes anything —
// adding one would need SMTP and a separate decision, not a quiet extension of this file.
//
// CREDENTIALS come from the environment and are never read from, or written to, the repository:
//
//   MAILBOX_MCP_USER      the full address, e.g. someone@satopharma.com
//   MAILBOX_MCP_PASSWORD  the mailbox APP password (never the login password)
//   MAILBOX_MCP_HOST      optional, default imap.mail.yahoo.com (Turbify runs on Yahoo)
//   MAILBOX_MCP_PORT      optional, default 993
//   MAILBOX_MCP_SECURE    optional, default true
//
// STDOUT IS THE PROTOCOL. An MCP stdio server may write nothing to stdout but JSON-RPC frames, so
// every diagnostic in this file goes to stderr. A stray console.log here breaks the connection in
// a way that reads as "the server won't start".

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DEFAULT_HOST = "imap.mail.yahoo.com";
const DEFAULT_PORT = 993;

function readConnection() {
  const user = (process.env.MAILBOX_MCP_USER ?? "").trim();
  // Yahoo/Turbify shows an app password as four space-separated blocks; the IMAP LOGIN wants the
  // 16 characters with no spaces. Strip ALL whitespace, not just the ends — a pasted password
  // carrying its display spacing is the commonest way this fails, and it fails as "wrong password".
  const password = (process.env.MAILBOX_MCP_PASSWORD ?? "").replace(/\s+/gu, "");
  if (!user || !password) {
    throw new Error(
      "MAILBOX_MCP_USER and MAILBOX_MCP_PASSWORD must both be set. The password is the mailbox's "
        + "APP password, not its login password.",
    );
  }
  const port = Number.parseInt(process.env.MAILBOX_MCP_PORT ?? "", 10);
  return {
    host: (process.env.MAILBOX_MCP_HOST ?? "").trim() || DEFAULT_HOST,
    password,
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT,
    secure: process.env.MAILBOX_MCP_SECURE !== "false",
    user,
  };
}

/**
 * Open a connection, run one operation, close it. A fresh client per call rather than one held
 * open for the life of the server: this process idles for hours between questions, and a socket
 * that has been silently dropped in the meantime fails on the NEXT call with a confusing error
 * instead of a clean reconnect.
 */
async function withClient(run) {
  const connection = readConnection();
  const client = new ImapFlow({
    auth: { pass: connection.password, user: connection.user },
    host: connection.host,
    logger: false,
    port: connection.port,
    secure: connection.secure,
    // Fail fast rather than hang the tool call when the host is unreachable or the credential has
    // been revoked and the server stalls the login.
    socketTimeout: 20_000,
  });
  await client.connect();
  try {
    return await run(client, connection);
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

/** Every folder open in this file goes through here, so the read-only lock cannot be forgotten. */
async function withFolder(client, folderPath, run) {
  const lock = await client.getMailboxLock(folderPath, { readOnly: true });
  try {
    return await run(client.mailbox);
  } finally {
    lock.release();
  }
}

// Africa/Cairo, never raw UTC.
const cairo = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

function formatWhen(value) {
  if (!value) return "(no date)";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "(no date)";
  return `${cairo.format(parsed)} Cairo`;
}

function addressOf(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const first = list[0];
  const address = typeof first?.address === "string" ? first.address : null;
  const name = typeof first?.name === "string" && first.name.trim() ? first.name.trim() : null;
  if (name && address) return `${name} <${address}>`;
  return name ?? address;
}

function allAddressesOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => (typeof entry?.address === "string" ? entry.address : null)).filter(Boolean);
}

function hasAttachment(node) {
  if (!node || typeof node !== "object") return false;
  if (typeof node.disposition === "string" && node.disposition.toLowerCase() === "attachment") return true;
  return Array.isArray(node.childNodes) && node.childNodes.some((child) => hasAttachment(child));
}

/** Render one envelope as a single list line. */
function summaryLine(message) {
  const envelope = message.envelope ?? {};
  const flags = message.flags ?? new Set();
  const marks = [
    flags.has("\\Seen") ? "read" : "UNREAD",
    flags.has("\\Answered") ? "answered" : null,
    flags.has("\\Flagged") ? "flagged" : null,
    hasAttachment(message.bodyStructure) ? "attachment" : null,
  ].filter(Boolean);
  return [
    `uid ${message.uid}`,
    formatWhen(envelope.date),
    `from ${addressOf(envelope.from) ?? "(unknown)"}`,
    `subject ${envelope.subject ?? "(no subject)"}`,
    `[${marks.join(", ")}]`,
  ].join(" · ");
}

function textResult(text) {
  return { content: [{ text, type: "text" }] };
}

const server = new McpServer({ name: "mailbox", version: "1.0.0" });

server.registerTool(
  "list_folders",
  {
    description:
      "List the folders in the connected mailbox (INBOX, Sent, Drafts, Bulk Mail, and any the "
      + "owner made). Read-only. Use this first when you do not know a folder's exact path.",
    inputSchema: {},
    title: "List mailbox folders",
  },
  async () => {
    const folders = await withClient(async (client) => client.list());
    if (!folders.length) return textResult("The mailbox reports no folders.");
    const lines = folders
      .filter((folder) => typeof folder?.path === "string")
      .map((folder) => {
        const special = folder.specialUse ? ` (${folder.specialUse})` : "";
        return `${folder.path}${special}`;
      });
    return textResult(`${lines.length} folders:\n${lines.join("\n")}`);
  },
);

server.registerTool(
  "list_messages",
  {
    description:
      "List the most recent messages in a folder, newest first. Envelopes only — sender, subject, "
      + "date, flags and whether there is an attachment — so it is cheap. Reading this does NOT "
      + "mark anything as read. Use read_message with a uid from here to see a body.",
    inputSchema: {
      folder: z.string().default("INBOX").describe("Folder path, e.g. INBOX or Sent. Defaults to INBOX."),
      limit: z.number().int().min(1).max(100).default(25).describe("How many of the newest messages to list."),
    },
    title: "List recent messages",
  },
  async ({ folder, limit }) => {
    const summaries = await withClient(async (client) =>
      withFolder(client, folder, async (mailbox) => {
        const total = mailbox?.exists ?? 0;
        if (total === 0) return [];
        const start = Math.max(1, total - limit + 1);
        const rows = [];
        for await (const message of client.fetch(
          `${start}:${total}`,
          { bodyStructure: true, envelope: true, flags: true, uid: true },
          { uid: false },
        )) {
          rows.push(message);
        }
        return rows;
      }),
    );
    if (!summaries.length) return textResult(`${folder} is empty.`);
    summaries.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0));
    return textResult(
      `${summaries.length} most recent in ${folder} (newest first):\n${summaries.map(summaryLine).join("\n")}`,
    );
  },
);

server.registerTool(
  "search_messages",
  {
    description:
      "Search a folder by sender, subject, free text or date, and return matching envelopes "
      + "newest first. Every filter given is combined with AND. Read-only — searching marks "
      + "nothing as read.",
    inputSchema: {
      folder: z.string().default("INBOX").describe("Folder path to search. Defaults to INBOX."),
      from: z.string().optional().describe("Match the sender, e.g. a name or an address fragment."),
      limit: z.number().int().min(1).max(100).default(25).describe("Maximum matches to return."),
      since: z
        .string()
        .optional()
        .describe("Only messages on or after this date, as YYYY-MM-DD."),
      subject: z.string().optional().describe("Match text in the subject line."),
      text: z.string().optional().describe("Match text anywhere in the message, headers or body."),
      unseenOnly: z.boolean().default(false).describe("Only messages that are still unread."),
    },
    title: "Search messages",
  },
  async ({ folder, from, limit, since, subject, text, unseenOnly }) => {
    const query = {};
    if (from) query.from = from;
    if (subject) query.subject = subject;
    if (text) query.body = text;
    if (unseenOnly) query.seen = false;
    if (since) {
      const parsed = new Date(`${since}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) {
        return textResult(`"${since}" is not a date I can read. Use YYYY-MM-DD.`);
      }
      query.since = parsed;
    }
    if (Object.keys(query).length === 0) {
      return textResult("Give at least one filter — from, subject, text, since or unseenOnly.");
    }

    const matches = await withClient(async (client) =>
      withFolder(client, folder, async () => {
        const uids = await client.search(query, { uid: true });
        if (!uids || uids.length === 0) return [];
        // Newest first, then cap: the cap must fall on the OLDEST matches, not on whichever the
        // server happened to return first.
        const newest = [...uids].sort((a, b) => b - a).slice(0, limit);
        const rows = [];
        for await (const message of client.fetch(
          newest.join(","),
          { bodyStructure: true, envelope: true, flags: true, uid: true },
          { uid: true },
        )) {
          rows.push(message);
        }
        return rows;
      }),
    );
    if (!matches.length) return textResult(`No messages in ${folder} match that.`);
    matches.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0));
    return textResult(`${matches.length} matches in ${folder} (newest first):\n${matches.map(summaryLine).join("\n")}`);
  },
);

server.registerTool(
  "read_message",
  {
    description:
      "Fetch and read one message in full by its uid, including the body and a list of its "
      + "attachments (names and sizes, never the bytes). Reading it here does NOT mark it read in "
      + "the mailbox.",
    inputSchema: {
      folder: z.string().default("INBOX").describe("The folder the uid belongs to. A uid is only unique within its folder."),
      uid: z.number().int().positive().describe("The message uid, as shown by list_messages or search_messages."),
    },
    title: "Read one message",
  },
  async ({ folder, uid }) => {
    const parsed = await withClient(async (client) =>
      withFolder(client, folder, async () => {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message || typeof message === "boolean" || !message.source) return null;
        return simpleParser(message.source);
      }),
    );
    if (!parsed) return textResult(`No message with uid ${uid} in ${folder}. It may have been moved or deleted.`);

    const attachments = (parsed.attachments ?? []).map((attachment) => {
      const size = typeof attachment.size === "number" ? `${attachment.size} bytes` : "unknown size";
      return `  - ${attachment.filename ?? "(unnamed)"} · ${attachment.contentType ?? "unknown type"} · ${size}`;
    });

    const body = parsed.text?.trim()
      || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim() : "")
      || "(no readable body)";

    const header = [
      `Folder: ${folder}`,
      `Uid: ${uid}`,
      `Date: ${formatWhen(parsed.date)}`,
      `From: ${addressOf(parsed.from?.value) ?? "(unknown)"}`,
      `To: ${allAddressesOf(Array.isArray(parsed.to) ? [] : parsed.to?.value).join(", ") || "(none)"}`,
      `Cc: ${allAddressesOf(Array.isArray(parsed.cc) ? [] : parsed.cc?.value).join(", ") || "(none)"}`,
      `Subject: ${parsed.subject ?? "(no subject)"}`,
      attachments.length ? `Attachments:\n${attachments.join("\n")}` : "Attachments: none",
    ].join("\n");

    return textResult(`${header}\n\n---\n\n${body}`);
  },
);

// A connection check that names the mailbox it reached, so "is it actually connected?" has an
// answer that does not involve reading someone's mail to find out.
server.registerTool(
  "check_connection",
  {
    description:
      "Confirm the mailbox credential still works and report which address it opened and how many "
      + "messages INBOX holds. Use this to diagnose a connection, rather than listing mail.",
    inputSchema: {},
    title: "Check the mailbox connection",
  },
  async () => {
    const detail = await withClient(async (client, connection) =>
      withFolder(client, "INBOX", async (mailbox) => ({
        exists: mailbox?.exists ?? 0,
        host: connection.host,
        port: connection.port,
        unseen: mailbox?.unseen ?? null,
        user: connection.user,
      })),
    );
    return textResult(
      `Connected to ${detail.user} on ${detail.host}:${detail.port}.\n`
        + `INBOX holds ${detail.exists} messages`
        + `${detail.unseen === null ? "" : `, ${detail.unseen} unread`}.`,
    );
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write("mailbox MCP server ready (read-only IMAP)\n");
}

main().catch((error) => {
  process.stderr.write(`mailbox MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
