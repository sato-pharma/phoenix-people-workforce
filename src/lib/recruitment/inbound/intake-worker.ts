// Recruitment / ATS — durable inbound-CV intake worker.
//
// Drains ats_inbound_intake_queue: claim a ready row (one at a time, so only the in-flight row is
// ever 'processing'), re-materialize the bytes the enqueue step deliberately did NOT carry
// (WhatsApp: download media by id; email: re-fetch by UID), then run the existing ingestInboundCv.
// Success -> done. A thrown/transient failure -> retry with backoff, or dead-letter after
// max_attempts (with an alert), instead of the pre-queue behavior where any failure vanished.
//
// `reclaim: true` is passed to ingestInboundCv: the queue's SKIP-LOCKED claim is the single-flight
// authority here, so the event's own idempotency claim must let a retry re-run a prior failed
// attempt rather than dedupe it away.

import { logError, logWarning } from "@/lib/observability/log";
import { formatCoveringMessage } from "@/lib/recruitment/candidate-source-context";
import { clearWhatsAppMessages, sweepOldWhatsAppMessages } from "@/lib/recruitment/inbound/whatsapp-message-buffer";
import { downloadWhatsAppMedia, WhatsAppMediaTooLargeError } from "@/lib/recruitment/inbound/whatsapp-media";
import { isWhatsAppAutoReplyEnabled, sendWhatsAppCvAcknowledgement } from "@/lib/recruitment/inbound/whatsapp-reply";
import { fetchAndParseEmailMessagesByUid } from "@/lib/recruitment/inbound/email-poller";
import { fetchCvFromUrl } from "@/lib/recruitment/inbound/cv-link";
import { ingestInboundCv, maxInboundCvBytes, type InboundCvIntakeResult } from "@/lib/recruitment/inbound/cv-intake-service";
import { notifyInboundIntakeDeadLetter } from "@/lib/recruitment/inbound/recruitment-notify";
import {
  buildWhatsAppIntakeInput,
  isWhatsAppImportSender,
  parseWhatsAppImportSenders,
  type ParsedWhatsAppMessage,
} from "@/lib/recruitment/inbound/whatsapp-payload-parser";
import {
  claimNextInbound,
  markInboundDone,
  markInboundFailure,
  type EmailQueuePayload,
  type InboundQueueRow,
  type WhatsAppQueuePayload,
} from "@/lib/recruitment/inbound/intake-queue";

const DEFAULT_MAX_ITEMS_PER_RUN = 10;

function maxItemsPerRun(): number {
  const raw = Number(process.env.RECRUITMENT_INBOUND_QUEUE_MAX_PER_RUN);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ITEMS_PER_RUN;
}

// Signals ingestInboundCv came back with a non-throwing 'error' outcome (e.g. a storage upload that
// its own try/catch swallowed). Turned into a throw here so the queue treats it as retryable.
class IntakeErrorOutcome extends Error {
  constructor(channel: string) {
    super(`${channel} CV intake returned an error outcome.`);
    this.name = "IntakeErrorOutcome";
  }
}

async function processWhatsAppRow(payload: WhatsAppQueuePayload): Promise<InboundCvIntakeResult> {
  // A document/image with a failed media download now THROWS -> retried, never silently recorded
  // as ignored_no_attachment (the pre-queue bug that lost CVs on a transient Meta 5xx). An
  // oversized file is different: it will never be a valid CV, so it's terminal (ignored), not a
  // retry — the size guard rejects it before the bytes are even pulled into memory.
  let downloaded: { bytes: Buffer; mimeType: string };
  try {
    downloaded = await downloadWhatsAppMedia(payload.mediaId, { maxBytes: maxInboundCvBytes() });
  } catch (error) {
    if (error instanceof WhatsAppMediaTooLargeError) return { outcome: "ignored_unsupported_attachment" };
    throw error;
  }

  const message: ParsedWhatsAppMessage = {
    contactName: payload.contactName,
    deliveredToDisplayNumber: payload.deliveredToDisplayNumber,
    deliveredToPhoneNumberId: payload.deliveredToPhoneNumberId,
    document: { caption: payload.caption, filename: payload.filename, mediaId: payload.mediaId, mimeType: downloaded.mimeType },
    forwarded: payload.forwarded,
    from: payload.from,
    historical: payload.historical === true,
    messageType: payload.messageType,
    text: null,
    wamid: payload.wamid,
  };

  const importSenders = parseWhatsAppImportSenders(process.env.RECRUITMENT_WHATSAPP_IMPORT_SENDERS);
  const input = buildWhatsAppIntakeInput(
    message,
    { bytes: downloaded.bytes, fileName: payload.filename ?? "cv", mimeType: downloaded.mimeType },
    { importSenders },
  );
  if (payload.sourceContext) {
    input.rawMetadata = { ...(input.rawMetadata ?? {}), sourceContext: payload.sourceContext };
    // The same words, formatted for the extraction model rather than for the screen — this is how
    // WhatsApp answers "which job are they applying for". The caption is already filename-filtered
    // by assembleWhatsAppSourceContext, so a silent send contributes nothing instead of asking the
    // model to read a career out of "Cv.pdf".
    input.coverMessage = formatCoveringMessage({
      body: payload.sourceContext.caption,
      messages: payload.sourceContext.firstMessages,
    });
  }

  const result = await ingestInboundCv({ channel: "whatsapp", ...input, reclaim: true });
  if (result.outcome === "error") throw new IntakeErrorOutcome("WhatsApp");

  const isImport = isWhatsAppImportSender(payload.from, importSenders);
  // Consume the sender's buffered messages once a direct applicant's CV produced/matched a
  // candidate, so a later CV from the same number doesn't re-inherit stale context.
  if (!isImport && (result.outcome === "candidate_created" || result.outcome === "candidate_matched")) {
    await clearWhatsAppMessages(payload.from).catch(() => {});
  }

  // Acknowledge a genuinely NEW direct applicant (flag-gated; strict no-op when off). Never on an
  // import (that's a forwarder, not the applicant), never on a match (they already applied), and
  // never on a coexistence history replay — thanking someone for a CV they sent two months ago,
  // the instant the handset is linked, would message every past applicant at once.
  // Best-effort — an acknowledgement must never affect the CV that was already captured.
  if (!isImport && !payload.historical && result.outcome === "candidate_created" && isWhatsAppAutoReplyEnabled()) {
    await sendWhatsAppCvAcknowledgement({ phoneNumberId: payload.deliveredToPhoneNumberId, toWaId: payload.from }).catch(() => {});
  }
  return result;
}

async function processEmailRow(payload: EmailQueuePayload): Promise<InboundCvIntakeResult> {
  // One email can carry several CVs (agency/referral) — each usable attachment becomes its own
  // candidate. Empty => the message no longer exists (deleted / UIDVALIDITY changed): terminal.
  const inputs = await fetchAndParseEmailMessagesByUid(payload.mailboxLabel, payload.folderPath, payload.uid);
  if (inputs.length === 0) return { outcome: "ignored_no_attachment" };

  // Each attachment has its own provider_message_id, so ingestInboundCv dedupes them independently;
  // a mid-batch failure re-queues the whole row and the already-done attachments no-op on retry.
  let last: InboundCvIntakeResult = { outcome: "ignored_no_attachment" };
  for (const input of inputs) {
    // CV-as-link (E3): no attachment, but an allowlisted share link was found in the body — fetch
    // it (size/type/redirect-guarded) and treat it as the CV. A failed/unsafe fetch just falls back
    // to no-attachment.
    let finalInput = input;
    const cvLinkUrl = (input.rawMetadata as { cvLinkUrl?: string } | undefined)?.cvLinkUrl;
    if (!input.attachment && typeof cvLinkUrl === "string") {
      const fetched = await fetchCvFromUrl(cvLinkUrl, maxInboundCvBytes());
      if (fetched) {
        finalInput = { ...input, attachment: { bytes: fetched.bytes, fileName: fetched.fileName, mimeType: fetched.mimeType } };
      }
    }
    const result = await ingestInboundCv({ channel: "email", ...finalInput, reclaim: true });
    if (result.outcome === "error") throw new IntakeErrorOutcome("Email");
    last = result;
  }
  return last;
}

export type InboundDrainOutcome = {
  id: string;
  channel: string;
  status: "done" | "retry" | "dead";
  outcome?: string;
  error?: string;
};

export type InboundDrainResult = { processed: number; results: InboundDrainOutcome[] };

/**
 * Drain up to `maxItems` ready queue rows, one claim at a time. Bounded per run so the route stays
 * well under its Cloud Run timeout; a backlog drains across successive cron ticks.
 */
export async function drainInboundIntake(maxItems: number = maxItemsPerRun()): Promise<InboundDrainResult> {
  const results: InboundDrainOutcome[] = [];

  // Retention sweep of the WhatsApp text buffer runs here (once per tick) rather than on the
  // webhook hot path — best-effort, never blocks the drain.
  await sweepOldWhatsAppMessages().catch(() => {});

  for (let i = 0; i < maxItems; i += 1) {
    const [row] = await claimNextInbound(1);
    if (!row) break;

    try {
      const result = await processRow(row);
      await markInboundDone(row.id);
      results.push({ channel: row.channel, id: row.id, outcome: result.outcome, status: "done" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const disposition = await markInboundFailure(row, message).catch(() => "retry" as const);
      if (disposition === "dead") {
        logError("Inbound CV intake dead-lettered after retries", {
          error,
          labels: { channel: row.channel, event: "inbound_intake_dead_letter", provider_message_id: row.provider_message_id },
        });
        await notifyInboundIntakeDeadLetter({
          channel: row.channel,
          error: message,
          providerMessageId: row.provider_message_id,
        }).catch(() => {});
      } else {
        logWarning("Inbound CV intake attempt failed; will retry", {
          error,
          labels: { attempts: row.attempts, channel: row.channel, event: "inbound_intake_retry", provider_message_id: row.provider_message_id },
        });
      }
      results.push({ channel: row.channel, error: message, id: row.id, status: disposition });
    }
  }

  return { processed: results.length, results };
}

function processRow(row: InboundQueueRow): Promise<InboundCvIntakeResult> {
  return row.payload.kind === "whatsapp" ? processWhatsAppRow(row.payload) : processEmailRow(row.payload);
}
