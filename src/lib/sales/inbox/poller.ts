// Sales mailbox intake — IMAP polling for distributor monthly workbooks.
//
// WHAT THIS REPLACES. Measured on production 2026-08-29: 17 distributor files were imported for
// period 2026-07, 18 for June, 17 for May, 19 for April, and the July set took ten days to
// assemble (2026-08-02 → 2026-08-12). Every one of them arrived as an email attachment and was
// then carried across by hand — noticed, downloaded, matched to a distributor in a dropdown, and
// uploaded. This poller does the noticing, the downloading and the matching. It does not do the
// importing, and deliberately never will (see arrivals.ts).
//
// SHAPE. Unlike the recruitment poller — which enqueues a reference and lets a durable worker do
// the heavy lifting, because a WhatsApp webhook must ack in under a second — this one fetches the
// message during the poll. There is no webhook here, only a cron; the volume is roughly twenty
// files a MONTH; and the work per message (park the bytes, read the header row) is small and
// bounded. A queue would be machinery with nothing to carry.
//
// A persisted UID cursor, never the IMAP \Seen flag: the sales mailbox is read by people too, and
// flipping \Seen on messages a bot has read would rewrite what they see as unread. This poller
// opens every folder readOnly and never mutates mailbox state.
//
// Junk is polled as well as INBOX, for the same reason recruitment polls it: a distributor's file
// comes from an address the mailbox may never have corresponded with, carrying an attachment —
// exactly the profile a consumer spam filter acts on. An INBOX-only poll would lose real files
// with no trace anywhere.

import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser } from "mailparser";

import { junkCursorLabel, pickJunkFolder, planFolderPoll } from "@/lib/email-intake/poll-planner";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { countOversizeWorkbooks, pickWorkbookAttachments } from "./attachments";
import { recordArrival } from "./arrivals";
import { createCursorTracker } from "./cursor-advance";
import { loadSalesMailboxes, type SalesMailboxConfig } from "./mailboxes-config";

/** How far back a folder reaches the FIRST time it is polled. Without this, configuring the
 *  mailbox would walk its entire history. Thirty days covers one full closing cycle, which is the
 *  unit of work here — a distributor file is monthly, not daily. */
const DEFAULT_FIRST_RUN_BACKFILL_DAYS = 30;

/** Ceiling on messages read per folder per run, so a backlog drains across successive runs rather
 *  than running one call past its limit and losing the whole batch. */
const DEFAULT_MAX_MESSAGES_PER_POLL = 25;

function firstRunBackfillDays(): number {
  const raw = Number(process.env.SALES_EMAIL_BACKFILL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FIRST_RUN_BACKFILL_DAYS;
}

function maxMessagesPerPoll(): number {
  const raw = Number(process.env.SALES_EMAIL_MAX_MESSAGES_PER_POLL);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_MESSAGES_PER_POLL;
}

export type SalesFolderPollSummary = {
  folderPath: string;
  cursorLabel: string;
  messagesSeen: number;
  workbooksFound: number;
  arrivalsRecorded: number;
  duplicates: number;
  oversizeSkipped: number;
  failures: number;
  /** True when the per-run cap left messages behind — the next run picks them up. */
  backlogRemaining: boolean;
  /** The UID the cursor is held on, when a message failed. Present means this folder will re-read
   *  from here every run until that one message succeeds — the thing to look at first. */
  stalledAtUid?: number;
  error?: string;
};

export type SalesMailboxPollSummary = {
  mailboxLabel: string;
  folders: SalesFolderPollSummary[];
  connectionError?: string;
};

type CursorRow = { imap_uidvalidity: string | number | null; last_processed_uid: string | number | null };

async function loadCursor(cursorLabel: string): Promise<{ uidValidity: bigint | null; lastProcessedUid: number }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("sales_email_intake_cursors")
    .select("imap_uidvalidity,last_processed_uid")
    .eq("mailbox_label", cursorLabel)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { lastProcessedUid: 0, uidValidity: null };
  const row = data as CursorRow;
  return {
    lastProcessedUid: Number(row.last_processed_uid ?? 0),
    uidValidity:
      row.imap_uidvalidity === null || row.imap_uidvalidity === undefined ? null : BigInt(row.imap_uidvalidity),
  };
}

async function saveCursor(cursorLabel: string, uidValidity: bigint, lastProcessedUid: number): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("sales_email_intake_cursors").upsert(
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

function senderAddress(mail: Awaited<ReturnType<typeof simpleParser>>): { address: string | null; name: string | null } {
  const from = mail.from;
  const first = from && "value" in from ? from.value?.[0] : undefined;
  return {
    address: first?.address ? String(first.address).trim().toLowerCase() : null,
    name: first?.name ? String(first.name).trim() : null,
  };
}

async function pollFolder(
  client: ImapFlow,
  target: { cursorLabel: string; folderPath: string },
  options: { mailboxLabel: string },
): Promise<SalesFolderPollSummary> {
  const summary: SalesFolderPollSummary = {
    arrivalsRecorded: 0,
    backlogRemaining: false,
    cursorLabel: target.cursorLabel,
    duplicates: 0,
    failures: 0,
    folderPath: target.folderPath,
    messagesSeen: 0,
    oversizeSkipped: 0,
    workbooksFound: 0,
  };

  let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
  try {
    lock = await client.getMailboxLock(target.folderPath, { readOnly: true });
    const mailbox = client.mailbox;
    if (!mailbox || typeof mailbox === "boolean") {
      throw new Error(`Could not open ${target.folderPath} (mailbox unavailable).`);
    }

    const cursor = await loadCursor(target.cursorLabel);
    // A rebuilt mailbox invalidates every stored UID, so treat it exactly like a first poll: a
    // bounded window, deduped by the arrivals table's own (mailbox, uidvalidity, uid, index) key.
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

    // THE CURSOR RULE, and it is the part of this job most worth understanding: the LOOP always
    // continues, the CURSOR stops at the first failure. It lives in its own module so a test can
    // drive it directly rather than read it — `cursor-advance.ts` carries the full reasoning and
    // the two incidents behind it.
    const tracker = createCursorTracker(plan.baselineUid);

    for (const uid of plan.uids) {
      summary.messagesSeen += 1;
      try {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        // A message that no longer exists (deleted since the search) is terminal, not a failure —
        // holding the cursor on it would stall the folder on something that can never succeed.
        if (message && typeof message !== "boolean" && message.source) {
          const mail = await simpleParser(message.source);
          const sender = senderAddress(mail);
          const workbooks = pickWorkbookAttachments(mail.attachments);
          summary.oversizeSkipped += countOversizeWorkbooks(mail.attachments);
          summary.workbooksFound += workbooks.length;

          for (const workbook of workbooks) {
            const result = await recordArrival({
              attachmentIndex: workbook.index,
              bytes: workbook.bytes,
              fileName: workbook.fileName,
              folderPath: target.folderPath,
              fromAddress: sender.address,
              fromName: sender.name,
              mailboxLabel: options.mailboxLabel,
              messageId: mail.messageId ? String(mail.messageId) : null,
              receivedAt: mail.date instanceof Date ? mail.date : null,
              subject: mail.subject ? String(mail.subject) : null,
              uid,
              uidValidity: mailbox.uidValidity,
            });
            if (result.outcome === "recorded") summary.arrivalsRecorded += 1;
            else if (result.outcome === "duplicate") summary.duplicates += 1;
            else {
              // The bytes were never parked. Hold the cursor so this message is tried again.
              summary.failures += 1;
              tracker.failed(uid);
            }
          }
        }
        tracker.succeeded(uid);
      } catch {
        summary.failures += 1;
        tracker.failed(uid);
      }
    }
    const stalledAtUid = tracker.stalledAtUid();
    if (stalledAtUid !== null) summary.stalledAtUid = stalledAtUid;

    await saveCursor(target.cursorLabel, mailbox.uidValidity, tracker.lastProcessedUid());
  } catch (error) {
    summary.error = error instanceof Error ? error.message : `Poll of ${target.folderPath} failed.`;
  } finally {
    lock?.release();
  }

  return summary;
}

async function pollMailbox(config: SalesMailboxConfig): Promise<SalesMailboxPollSummary> {
  const summary: SalesMailboxPollSummary = { folders: [], mailboxLabel: config.label };
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

export async function pollAllSalesMailboxes(): Promise<SalesMailboxPollSummary[]> {
  const mailboxes = loadSalesMailboxes();
  const summaries: SalesMailboxPollSummary[] = [];
  for (const mailbox of mailboxes) {
    summaries.push(await pollMailbox(mailbox));
  }
  return summaries;
}

/**
 * Human-readable failures across a poll run — empty means everything worked.
 *
 * A swallowed failure is worse than no poller at all. A mailbox whose app password has expired
 * produces a summary with `connectionError` set; without this the route would still return 200 and
 * the cron monitor would stay green while distributor files piled up unread for a whole close.
 *
 * "No mailboxes configured" is deliberately NOT a failure — that is the documented inert state
 * before SALES_EMAIL_INBOXES_JSON is set.
 */
export function summarizeSalesPollFailures(summaries: readonly SalesMailboxPollSummary[]): string[] {
  const failures: string[] = [];
  for (const mailbox of summaries) {
    if (mailbox.connectionError) {
      failures.push(`${mailbox.mailboxLabel}: ${mailbox.connectionError}`);
      continue;
    }
    for (const folder of mailbox.folders) {
      if (folder.error) failures.push(`${mailbox.mailboxLabel}/${folder.folderPath}: ${folder.error}`);
    }
  }
  return failures;
}
