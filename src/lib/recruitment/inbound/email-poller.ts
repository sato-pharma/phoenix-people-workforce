// Recruitment / ATS — IMAP polling for inbound CV email intake.
//
// Deliberately a persisted UID cursor (ats_email_intake_cursors table), never the IMAP
// \Seen flag: careers@/hr@ are shared, human-monitored mailboxes — flipping \Seen on
// bot-processed messages would pollute what HR staff see as unread, and an UNSEEN-filtered poll
// would race with a human opening a message first. This poller only ever reads (getMailboxLock
// with readOnly: true) and never mutates mailbox state. A UIDVALIDITY change (rare — happens if
// the mailbox is rebuilt server-side) restarts that folder from a bounded window; the
// (channel, provider_message_id) claim in ats_cv_intake_events is the safety net against
// reprocessing in that edge case.
//
// The poll only DISCOVERS + ENQUEUES now: it searches for new UIDs and drops a lightweight row
// into ats_inbound_intake_queue for each. The durable worker (intake-worker.ts) re-fetches the
// message by UID and does the parse + AI + candidate creation, with retries. That keeps this cron
// fast and cheap (no per-message fetch, no AI in the 120s route) and gives every email the same
// retry/dead-letter safety net as WhatsApp.
//
// Polls the junk/spam folder as well as INBOX. Applicant CVs arrive from addresses the mailbox
// has never corresponded with, carrying attachments — exactly the profile consumer spam filters
// act on — so an INBOX-only poll silently loses real candidates with no trace anywhere. Each
// folder keeps its OWN cursor row: INBOX under the bare mailbox label (so the live cursor keeps
// working untouched) and junk under "<label>:junk".

import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";

import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import type { InboundCvIntakeInput } from "@/lib/recruitment/inbound/cv-intake-service";
import { enqueueInbound } from "@/lib/recruitment/inbound/intake-queue";
import {
  emailQueueKey,
  junkCursorLabel,
  pickJunkFolder,
  planFolderPoll,
  type FolderPollSummary,
  type MailboxPollSummary,
} from "@/lib/recruitment/inbound/email-poll-planner";
import {
  loadConfiguredMailboxes,
  type RecruitmentMailboxConfig,
} from "@/lib/recruitment/inbound/email-mailboxes-config";
import { parseEmailImportSenders, parseInboundEmailMessages } from "@/lib/recruitment/inbound/email-message-parser";

export { summarizePollFailures, type FolderPollSummary, type MailboxPollSummary } from "@/lib/recruitment/inbound/email-poll-planner";

// DEADLINES ON EVERY IMAP CONNECTION (23 Oct 2026 audit, P5-01). Both clients here were built with
// imapflow's defaults — five minutes of socket silence and 90 seconds to connect — and with no
// 'error' listener, so a mail host that accepted the connection and then went silent held the careers
// poll (and the intake worker) past the route's own two-minute maxDuration, and a socket error raised
// an uncaught exception. Same shape as the mailbox monitor's client (src/lib/mailbox-monitor/imap-client.ts).
export const RECRUITMENT_IMAP_CONNECTION_TIMEOUT_MS = 15_000;
export const RECRUITMENT_IMAP_GREETING_TIMEOUT_MS = 10_000;
export const RECRUITMENT_IMAP_SOCKET_TIMEOUT_MS = 30_000;

/** An ImapFlow client with the deadlines above and an 'error' listener attached before connect(). */
export function createRecruitmentImapClient(config: RecruitmentMailboxConfig): ImapFlow {
  const client = new ImapFlow({
    auth: { pass: config.password, user: config.user },
    connectionTimeout: RECRUITMENT_IMAP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: RECRUITMENT_IMAP_GREETING_TIMEOUT_MS,
    host: config.host,
    logger: false,
    port: config.port,
    secure: config.secure,
    socketTimeout: RECRUITMENT_IMAP_SOCKET_TIMEOUT_MS,
  });
  client.on("error", (error) => {
    logError("Careers mailbox IMAP connection error", {
      error,
      labels: { event: "recruitment_imap_socket_error", mailbox: config.label },
    });
  });
  return client;
}

type CursorRow = { imap_uidvalidity: string | number | null; last_processed_uid: string | number | null };

// How far back a folder reaches the FIRST time it is polled. Without this, adding a mailbox (or
// the junk folder of an existing one) would walk its entire history — potentially tens of
// thousands of messages and one AI extraction per CV-shaped attachment. Seven days captures the
// live applicant flow; a deliberate full backfill is an explicit env change, not an accident.
const DEFAULT_FIRST_RUN_BACKFILL_DAYS = 7;

// Ceiling on messages processed per folder per run. A backlog then drains across successive runs
// (every 10 minutes) instead of running the route past its maxDuration and losing the whole batch.
const DEFAULT_MAX_MESSAGES_PER_POLL = 40;

function firstRunBackfillDays(): number {
  const raw = Number(process.env.RECRUITMENT_EMAIL_BACKFILL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FIRST_RUN_BACKFILL_DAYS;
}

function maxMessagesPerPoll(): number {
  const raw = Number(process.env.RECRUITMENT_EMAIL_MAX_MESSAGES_PER_POLL);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_MESSAGES_PER_POLL;
}

async function loadCursor(cursorLabel: string): Promise<{ uidValidity: bigint | null; lastProcessedUid: number }> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_email_intake_cursors")
    .select("imap_uidvalidity,last_processed_uid")
    .eq("mailbox_label", cursorLabel)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { lastProcessedUid: 0, uidValidity: null };
  const row = data as CursorRow;
  return {
    lastProcessedUid: Number(row.last_processed_uid ?? 0),
    uidValidity: row.imap_uidvalidity === null || row.imap_uidvalidity === undefined ? null : BigInt(row.imap_uidvalidity),
  };
}

async function saveCursor(cursorLabel: string, uidValidity: bigint, lastProcessedUid: number): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_email_intake_cursors").upsert(
    {
      imap_uidvalidity: uidValidity.toString(),
      last_processed_uid: lastProcessedUid,
      mailbox_label: cursorLabel,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "mailbox_label" },
  );
  if (error) throw error;
}

async function pollFolder(
  client: ImapFlow,
  target: { cursorLabel: string; folderPath: string },
  options: { mailboxLabel: string },
): Promise<FolderPollSummary> {
  const summary: FolderPollSummary = {
    backlogRemaining: false,
    cursorLabel: target.cursorLabel,
    folderPath: target.folderPath,
    messagesSeen: 0,
    results: [],
  };

  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
  try {
    lock = await client.getMailboxLock(target.folderPath, { readOnly: true });
    const mailbox = client.mailbox;
    if (!mailbox || typeof mailbox === "boolean") {
      throw new Error(`Could not open ${target.folderPath} (mailbox unavailable).`);
    }

    const cursor = await loadCursor(target.cursorLabel);
    // A rebuilt mailbox invalidates every stored UID, so treat it exactly like a first poll:
    // a bounded window, deduped by the (channel, provider_message_id) claim.
    const uidValidityChanged = cursor.uidValidity !== null && cursor.uidValidity !== mailbox.uidValidity;
    const isFirstRun = cursor.uidValidity === null || uidValidityChanged;

    let candidateUids: number[];
    if (isFirstRun) {
      const since = new Date(Date.now() - firstRunBackfillDays() * 24 * 60 * 60 * 1000);
      const searchResult = await client.search({ since }, { uid: true });
      candidateUids = Array.isArray(searchResult) ? searchResult : [];
    } else {
      const startUid = cursor.lastProcessedUid + 1;
      const searchResult = await client.search({ uid: `${startUid}:*` }, { uid: true });
      candidateUids = Array.isArray(searchResult) ? searchResult : [];
    }

    const plan = planFolderPoll({
      candidateUids,
      isFirstRun,
      lastProcessedUid: cursor.lastProcessedUid,
      maxMessages: maxMessagesPerPoll(),
      uidNext: Number(mailbox.uidNext ?? 0),
    });
    summary.backlogRemaining = plan.backlogRemaining;

    // Enqueue one durable row per new UID — no source fetch, no parse, no AI here. The worker
    // re-fetches by UID and does the heavy lifting. The queue key carries UIDVALIDITY so a rebuilt
    // mailbox (UIDs reset) can't collide a fresh message onto an old row's dedupe key.
    let maxUidProcessed = plan.baselineUid;
    for (const uid of plan.uids) {
      summary.messagesSeen += 1;
      const { enqueued } = await enqueueInbound({
        channel: "email",
        payload: { kind: "email", folderPath: target.folderPath, mailboxLabel: options.mailboxLabel, messageId: null, uid },
        providerMessageId: emailQueueKey(target.cursorLabel, mailbox.uidValidity, uid),
        source: "email_poll",
      });
      summary.results.push({ outcome: enqueued ? "enqueued" : "duplicate", uid });
      maxUidProcessed = Math.max(maxUidProcessed, uid);
    }

    await saveCursor(target.cursorLabel, mailbox.uidValidity, maxUidProcessed);
  } catch (error) {
    summary.error = error instanceof Error ? error.message : `Poll of ${target.folderPath} failed.`;
  } finally {
    lock?.release();
  }

  return summary;
}

async function pollMailbox(config: RecruitmentMailboxConfig): Promise<MailboxPollSummary> {
  const summary: MailboxPollSummary = { folders: [], mailboxLabel: config.label };
  const client = createRecruitmentImapClient(config);

  try {
    await client.connect();

    const targets = [{ cursorLabel: config.label, folderPath: "INBOX" }];
    // Folder discovery is best-effort: a server that refuses LIST must still not cost us INBOX.
    try {
      const folders = (await client.list()) as ListResponse[];
      const junkPath = pickJunkFolder(folders);
      if (junkPath) targets.push({ cursorLabel: junkCursorLabel(config.label), folderPath: junkPath });
    } catch {
      /* INBOX-only for this run */
    }

    for (const target of targets) {
      summary.folders.push(await pollFolder(client, target, { mailboxLabel: config.label }));
    }

    await client.logout();
  } catch (error) {
    summary.connectionError = error instanceof Error ? error.message : "IMAP poll failed.";
    try {
      client.close();
    } catch {
      /* already closed */
    }
  }

  return summary;
}

export async function pollAllRecruitmentMailboxes(): Promise<MailboxPollSummary[]> {
  const mailboxes = loadConfiguredMailboxes();
  const summaries: MailboxPollSummary[] = [];
  for (const mailbox of mailboxes) {
    summaries.push(await pollMailbox(mailbox));
  }
  return summaries;
}

export class EmailMailboxNotConfiguredError extends Error {
  constructor(mailboxLabel: string) {
    super(`Mailbox "${mailboxLabel}" is no longer configured.`);
    this.name = "EmailMailboxNotConfiguredError";
  }
}

/**
 * Re-fetch and parse a single email by UID, for the durable worker. Returns one intake input PER
 * usable CV attachment (an agency mail with several CVs → several candidates), or an EMPTY array
 * when the message no longer exists (deleted, or UIDVALIDITY changed) — a terminal not-found the
 * worker treats as done, not a retryable failure. Throws on a genuine connection error (retryable)
 * or when the mailbox has been un-configured.
 *
 * `importSenders` is read here (worker time), not at enqueue time, so toggling the bulk-import env
 * takes effect on the next drain without re-queuing.
 */
export async function fetchAndParseEmailMessagesByUid(
  mailboxLabel: string,
  folderPath: string,
  uid: number,
): Promise<Array<Omit<InboundCvIntakeInput, "channel">>> {
  const config = loadConfiguredMailboxes().find((mailbox) => mailbox.label === mailboxLabel);
  if (!config) throw new EmailMailboxNotConfiguredError(mailboxLabel);

  const importSenders = parseEmailImportSenders(process.env.RECRUITMENT_EMAIL_IMPORT_SENDERS);
  const client = createRecruitmentImapClient(config);

  try {
    await client.connect();
    const lock = await client.getMailboxLock(folderPath, { readOnly: true });
    try {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!message || typeof message === "boolean" || !message.source) return [];
      const mail = await simpleParser(message.source);
      return parseInboundEmailMessages(mail, { mailboxLabel, uid }, { importSenders });
    } finally {
      lock.release();
    }
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
