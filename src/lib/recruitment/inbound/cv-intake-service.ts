// Recruitment / ATS — shared inbound CV intake pipeline (email + WhatsApp).
//
// Both channels normalize their source-specific payload into InboundCvIntakeInput and hand off
// to ingestInboundCv, which does exactly what a human using the manual "Add Candidate" flow
// would: dedupe (createCandidate's existing National ID -> email -> phone matching,
// candidate-matching.ts, untouched), upload the CV (uploadCandidateFile, untouched), run AI
// extraction targeted at the just-uploaded file (extractCandidateFieldsFromCv's fileId option),
// and notify Talent Acquisition. Every attempt — including ones that never produce a candidate —
// is logged to ats_cv_intake_events so two brand-new external integrations stay
// debuggable instead of opaque.
//
// The (channel, provider_message_id) unique index on that table is also the idempotency claim:
// this function inserts a 'processing' row via on-conflict-do-nothing before doing any work, so
// a retried webhook delivery or a re-run cron poll can never create a second candidate for the
// same inbound message.
//
// Runs as systemAccessContext — there is no logged-in user behind an inbound email or
// WhatsApp message.

import { systemAccessContext } from "@/lib/auth/permissions";
import { createCandidate } from "@/lib/recruitment/candidates";
import { extractCandidateFieldsFromCv, looksLikeCv } from "@/lib/recruitment/cv-extraction";
import { defaultCvPositionKey } from "@/lib/recruitment/cv-field-schemas";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { recruitmentDb } from "@/lib/recruitment/db";
import { uploadCandidateFile } from "@/lib/recruitment/files";
import { notifyTalentAcquisitionOfInboundCv } from "@/lib/recruitment/inbound/recruitment-notify";

export type InboundCvChannel = "email" | "whatsapp";

export type InboundCvAttachment = {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
};

export type InboundCvIntakeInput = {
  channel: InboundCvChannel;
  // The idempotency key — an email's Message-ID header, or WhatsApp's wamid. Required.
  providerMessageId: string;
  mailboxLabel?: string | null;
  providerUid?: string | null;
  senderIdentifier: string;
  senderDisplayName?: string | null;
  subject?: string | null;
  candidate: { fullName: string; email?: string | null; phone?: string | null; notes?: string | null };
  // null => nothing usable arrived with this message (a plain-text reply, an image, etc.) —
  // logged and ignored, no candidate, no notification.
  attachment: InboundCvAttachment | null;
  rawMetadata?: Record<string, unknown>;
};

export type InboundCvIntakeOutcome =
  | "candidate_created"
  | "candidate_matched"
  | "ignored_no_attachment"
  | "ignored_unsupported_attachment"
  | "ignored_duplicate"
  | "error";

export type InboundCvIntakeResult = {
  outcome: InboundCvIntakeOutcome;
  candidateId?: string;
  fileId?: string;
  matchReason?: "national_id" | "email" | "phone";
};

const DEFAULT_MAX_INBOUND_CV_BYTES = 15 * 1024 * 1024;

function maxInboundCvBytes(): number {
  const raw = Number(process.env.RECRUITMENT_INBOUND_CV_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_INBOUND_CV_BYTES;
}

// Returns the claimed event's id, or null if (channel, provider_message_id) already exists —
// i.e. this exact message is already being/been processed by another run.
async function claimIntakeEvent(input: InboundCvIntakeInput): Promise<string | null> {
  const supabase = recruitmentDb();
  const { data, error } = await supabase
    .from("ats_cv_intake_events")
    .insert({
      channel: input.channel,
      mailbox_label: input.mailboxLabel ?? null,
      outcome: "processing",
      provider_message_id: input.providerMessageId,
      provider_uid: input.providerUid ?? null,
      raw_metadata: input.rawMetadata ?? {},
      sender_display_name: input.senderDisplayName ?? null,
      sender_identifier: input.senderIdentifier,
      subject: input.subject ?? null,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
  return data ? String((data as { id: unknown }).id) : null;
}

async function finalizeIntakeEvent(
  eventId: string,
  patch: {
    outcome: InboundCvIntakeOutcome;
    candidateId?: string | null;
    fileId?: string | null;
    matchReason?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase
    .from("ats_cv_intake_events")
    .update({
      candidate_id: patch.candidateId ?? null,
      error_message: patch.errorMessage ?? null,
      file_id: patch.fileId ?? null,
      match_reason: patch.matchReason ?? null,
      outcome: patch.outcome,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId);
  if (error) throw error;
}

export async function ingestInboundCv(input: InboundCvIntakeInput): Promise<InboundCvIntakeResult> {
  const eventId = await claimIntakeEvent(input);
  if (!eventId) return { outcome: "ignored_duplicate" };

  try {
    if (!input.attachment) {
      await finalizeIntakeEvent(eventId, { outcome: "ignored_no_attachment" });
      return { outcome: "ignored_no_attachment" };
    }

    const kind = detectCvFileKind(input.attachment.mimeType, input.attachment.fileName);
    if (kind === "unsupported") {
      await finalizeIntakeEvent(eventId, {
        errorMessage: `Unsupported attachment type: ${input.attachment.mimeType || "unknown"}.`,
        outcome: "ignored_unsupported_attachment",
      });
      return { outcome: "ignored_unsupported_attachment" };
    }

    if (input.attachment.bytes.length > maxInboundCvBytes()) {
      await finalizeIntakeEvent(eventId, {
        errorMessage: `Attachment exceeds the maximum accepted size (${maxInboundCvBytes()} bytes).`,
        outcome: "ignored_unsupported_attachment",
      });
      return { outcome: "ignored_unsupported_attachment" };
    }

    // Best-effort content check — file TYPE alone (checked above) can't tell a real CV apart
    // from a vendor pitch or supplier letter that happens to arrive as a PDF. A classifier
    // failure must never block a real candidate, so any error here is swallowed and treated
    // as "yes, keep going" — only a clear "no" suppresses candidate creation.
    let attachmentIsCv = true;
    try {
      attachmentIsCv = await looksLikeCv(input.attachment.bytes, input.attachment.mimeType, input.attachment.fileName);
    } catch {
      /* best-effort */
    }
    if (!attachmentIsCv) {
      await finalizeIntakeEvent(eventId, {
        errorMessage: "Attachment does not appear to be a CV/resume (AI content check).",
        outcome: "ignored_unsupported_attachment",
      });
      return { outcome: "ignored_unsupported_attachment" };
    }

    const { candidate, created, matchReason } = await createCandidate(
      {
        email: input.candidate.email ?? null,
        fullName: input.candidate.fullName,
        notes: input.candidate.notes ?? null,
        phone: input.candidate.phone ?? null,
        source: input.channel,
      },
      systemAccessContext,
    );

    let fileId: string;
    try {
      const file = await uploadCandidateFile(systemAccessContext, {
        bytes: input.attachment.bytes,
        candidateId: candidate.id,
        fileName: input.attachment.fileName,
        kind: "cv",
        mimeType: input.attachment.mimeType,
        sizeBytes: input.attachment.bytes.length,
      });
      fileId = file.id;
    } catch (uploadError) {
      await finalizeIntakeEvent(eventId, {
        candidateId: candidate.id,
        errorMessage: uploadError instanceof Error ? uploadError.message : "CV file upload failed.",
        matchReason: matchReason ?? null,
        outcome: "error",
      });
      await notifyTalentAcquisitionOfInboundCv({
        candidateId: candidate.id,
        channel: input.channel,
        created,
        fileAttached: false,
        fullName: candidate.fullName,
        matchReason,
      }).catch(() => {});
      return { candidateId: candidate.id, matchReason, outcome: "error" };
    }

    // Best-effort — an AI/extraction failure must never undo the candidate/file that already
    // exist; Talent Acquisition can always run extraction manually from the review board.
    try {
      await extractCandidateFieldsFromCv(candidate.id, systemAccessContext, defaultCvPositionKey, { fileId });
    } catch {
      /* best-effort */
    }

    const outcome: InboundCvIntakeOutcome = created ? "candidate_created" : "candidate_matched";
    await finalizeIntakeEvent(eventId, {
      candidateId: candidate.id,
      fileId,
      matchReason: matchReason ?? null,
      outcome,
    });

    await notifyTalentAcquisitionOfInboundCv({
      candidateId: candidate.id,
      channel: input.channel,
      created,
      fileAttached: true,
      fullName: candidate.fullName,
      matchReason,
    }).catch(() => {});

    return { candidateId: candidate.id, fileId, matchReason, outcome };
  } catch (error) {
    await finalizeIntakeEvent(eventId, {
      errorMessage: error instanceof Error ? error.message : "Inbound CV intake failed.",
      outcome: "error",
    }).catch(() => {});
    return { outcome: "error" };
  }
}
