// Recruitment / ATS — IMAP polling for inbound CV email intake.
//
// Deliberately a persisted UID cursor (ats_email_intake_cursors table), never the IMAP
// \Seen flag: careers@/hr@ are shared, human-monitored mailboxes — flipping \Seen on
// bot-processed messages would pollute what HR staff see as unread, and an UNSEEN-filtered poll
// would race with a human opening a message first. This poller only ever reads (getMailboxLock
// with readOnly: true) and never mutates mailbox state. A UIDVALIDITY change (rare — happens if
// the mailbox is rebuilt server-side) resets the cursor to 0 for that mailbox; the
// (channel, provider_message_id) claim in ats_cv_intake_events is the safety net against
// reprocessing in that edge case.
//
// Processes mailboxes, and messages within a mailbox, sequentially — bounds concurrent IMAP
// connections and AI-extraction load, same reasoning as the bulk CV upload panel's sequential
// per-file processing.

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import { recruitmentDb } from "@/lib/recruitment/db";
import { ingestInboundCv, type InboundCvIntakeOutcome } from "@/lib/recruitment/inbound/cv-intake-service";
import {
  loadConfiguredMailboxes,
  type RecruitmentMailboxConfig,
} from "@/lib/recruitment/inbound/email-mailboxes-config";
import { parseInboundEmailMessage } from "@/lib/recruitment/inbound/email-message-parser";

type CursorRow = { imap_uidvalidity: string | number | null; last_processed_uid: string | number | null };

async function loadCursor(mailboxLabel: string): Promise<{ uidValidity: bigint | null; lastProcessedUid: number }> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_email_intake_cursors")
    .select("imap_uidvalidity,last_processed_uid")
    .eq("mailbox_label", mailboxLabel)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { lastProcessedUid: 0, uidValidity: null };
  const row = data as CursorRow;
  return {
    lastProcessedUid: Number(row.last_processed_uid ?? 0),
    uidValidity: row.imap_uidvalidity === null || row.imap_uidvalidity === undefined ? null : BigInt(row.imap_uidvalidity),
  };
}

async function saveCursor(mailboxLabel: string, uidValidity: bigint, lastProcessedUid: number): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase.from("ats_email_intake_cursors").upsert(
    {
      imap_uidvalidity: uidValidity.toString(),
      last_processed_uid: lastProcessedUid,
      mailbox_label: mailboxLabel,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "mailbox_label" },
  );
  if (error) throw error;
}

export type MailboxPollSummary = {
  mailboxLabel: string;
  messagesSeen: number;
  results: Array<{ uid: number; outcome: InboundCvIntakeOutcome | "error" }>;
  connectionError?: string;
};

async function pollMailbox(config: RecruitmentMailboxConfig): Promise<MailboxPollSummary> {
  const summary: MailboxPollSummary = { mailboxLabel: config.label, messagesSeen: 0, results: [] };
  const client = new ImapFlow({
    auth: { pass: config.password, user: config.user },
    host: config.host,
    logger: false,
    port: config.port,
    secure: config.secure,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox || typeof mailbox === "boolean") {
        throw new Error("Could not open INBOX (mailbox unavailable).");
      }

      const cursor = await loadCursor(config.label);
      const uidValidityChanged = cursor.uidValidity !== null && cursor.uidValidity !== mailbox.uidValidity;
      const startUid = uidValidityChanged ? 1 : cursor.lastProcessedUid + 1;

      const searchResult = await client.search({ uid: `${startUid}:*` }, { uid: true });
      const uids = Array.isArray(searchResult) ? searchResult.filter((uid) => uid >= startUid) : [];

      let maxUidProcessed = uidValidityChanged ? 0 : cursor.lastProcessedUid;
      if (uids.length > 0) {
        for await (const message of client.fetch(uids, { source: true }, { uid: true })) {
          summary.messagesSeen += 1;
          if (message.source) {
            try {
              const mail = await simpleParser(message.source);
              const parsed = parseInboundEmailMessage(mail, { mailboxLabel: config.label, uid: message.uid });
              const result = await ingestInboundCv({ channel: "email", ...parsed });
              summary.results.push({ outcome: result.outcome, uid: message.uid });
            } catch {
              summary.results.push({ outcome: "error", uid: message.uid });
            }
          }
          maxUidProcessed = Math.max(maxUidProcessed, message.uid);
        }
      }

      await saveCursor(config.label, mailbox.uidValidity, maxUidProcessed);
    } finally {
      lock.release();
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
