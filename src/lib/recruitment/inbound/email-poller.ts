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
// Polls the junk/spam folder as well as INBOX. Applicant CVs arrive from addresses the mailbox
// has never corresponded with, carrying attachments — exactly the profile consumer spam filters
// act on — so an INBOX-only poll silently loses real candidates with no trace anywhere. Each
// folder keeps its OWN cursor row: INBOX under the bare mailbox label (so the live cursor keeps
// working untouched) and junk under "<label>:junk".
//
// Processes mailboxes, folders, and messages within a folder sequentially — bounds concurrent
// IMAP connections and AI-extraction load, same reasoning as the bulk CV upload panel's
// sequential per-file processing.

import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";

import { recruitmentDb } from "@/lib/recruitment/db";
import { ingestInboundCv } from "@/lib/recruitment/inbound/cv-intake-service";
import {
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
import { parseEmailImportSenders, parseInboundEmailMessage } from "@/lib/recruitment/inbound/email-message-parser";

export { summarizePollFailures, type FolderPollSummary, type MailboxPollSummary } from "@/lib/recruitment/inbound/email-poll-planner";

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
  options: { importSenders: readonly string[]; mailboxLabel: string },
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

    let maxUidProcessed = plan.baselineUid;
    if (plan.uids.length > 0) {
      for await (const message of client.fetch(plan.uids, { source: true }, { uid: true })) {
        summary.messagesSeen += 1;
        if (message.source) {
          try {
            const mail = await simpleParser(message.source);
            const parsed = parseInboundEmailMessage(
              mail,
              { mailboxLabel: options.mailboxLabel, uid: message.uid },
              { importSenders: options.importSenders },
            );
            const result = await ingestInboundCv({ channel: "email", ...parsed });
            summary.results.push({ outcome: result.outcome, uid: message.uid });
          } catch {
            summary.results.push({ outcome: "error", uid: message.uid });
          }
        }
        maxUidProcessed = Math.max(maxUidProcessed, message.uid);
      }
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
  // Addresses whose messages are a bulk CV migration rather than direct applications. Unset in
  // normal operation; set only while an old mailbox is being forwarded in, then removed again.
  const importSenders = parseEmailImportSenders(process.env.RECRUITMENT_EMAIL_IMPORT_SENDERS);
  const client = new ImapFlow({
    auth: { pass: config.password, user: config.user },
    host: config.host,
    logger: false,
    port: config.port,
    secure: config.secure,
  });

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
      summary.folders.push(await pollFolder(client, target, { importSenders, mailboxLabel: config.label }));
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
