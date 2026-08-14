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
// One deliberate exception to that claim — see claimIntakeEvent: a row still sitting in
// 'processing' long after its run should have finished belongs to an attempt that died mid-way
// (a Cloud Run timeout during a burst, a crash). Those are re-claimable, because otherwise the
// idempotency guard would turn a crashed attempt into a permanently swallowed CV.
//
// Identity normally comes from the sender (see InboundCvIdentitySource). A bulk forward-import
// flips that to the CV itself, because every forwarded message reports the forwarding account
// as its sender and would otherwise collapse onto one candidate.
//
// Runs as systemAccessContext — there is no logged-in user behind an inbound email or
// WhatsApp message.

import { systemAccessContext } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import type { CandidateMatchReason } from "@/lib/recruitment/candidate-matching";
import { createCandidate, getCandidate, updateCandidate, type CandidateUpsertResult } from "@/lib/recruitment/candidates";
import { selectAutoApplyFields } from "@/lib/recruitment/cv-auto-apply";
import {
  candidateIdentityFromCvFields,
  extractCvFieldsFromBytes,
  persistCvExtraction,
  type CvFieldExtraction,
} from "@/lib/recruitment/cv-extraction";
import { countUnappliedCvFields } from "@/lib/recruitment/cv-extraction-fields";
import { defaultCvPositionKey, getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { recruitmentDb } from "@/lib/recruitment/db";
import { uploadCandidateFile } from "@/lib/recruitment/files";
import { notifyTalentAcquisitionOfInboundCv } from "@/lib/recruitment/inbound/recruitment-notify";
import type { Candidate } from "@/lib/recruitment/types";

export type InboundCvChannel = "email" | "whatsapp";

export type InboundCvAttachment = {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
};

// Where the candidate's identity comes from.
//
// "sender" (the default, and what every live applicant uses) trusts the transmitting address:
// a real applicant's own email address or WhatsApp number IS their contact detail.
//
// "cv" is for bulk forward-imports — an old WhatsApp/mailbox being migrated in. Every forwarded
// message carries the FORWARDER's address, so trusting the sender would match all of them onto
// a single candidate. Instead the CV is read first and the candidate built from what the
// document says about itself.
export type InboundCvIdentitySource = "sender" | "cv";

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
  // Defaults to "sender" — existing callers and every live applicant are unaffected.
  identitySource?: InboundCvIdentitySource;
  // null => nothing usable arrived with this message (a plain-text reply, an image, etc.) —
  // logged and ignored, no candidate, no notification.
  attachment: InboundCvAttachment | null;
  rawMetadata?: Record<string, unknown>;
  // Set by the durable intake worker when RE-processing a queued item after a prior failure. The
  // queue (ats_inbound_intake_queue) is the single-flight authority in that path — SKIP LOCKED
  // guarantees one worker per message — so the event's own claim must NOT treat a leftover
  // 'processing'/'error' row from the failed attempt as "already handled". Without this, a retry
  // would dedupe to ignored_duplicate and the failed upload/extract would never actually re-run.
  // A row that already SUCCEEDED (candidate_created/matched) is still never re-claimed.
  reclaim?: boolean;
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

export function maxInboundCvBytes(): number {
  const raw = Number(process.env.RECRUITMENT_INBOUND_CV_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_INBOUND_CV_BYTES;
}

// How long an event may sit in 'processing' before a later delivery may take it over. Comfortably
// longer than the webhook/poller ceiling (maxDuration = 300s), so this can only ever fire for a
// run that truly died — never for one still legitimately working.
const STALE_PROCESSING_CLAIM_MS = 15 * 60 * 1000;

export function isStaleProcessingClaim(
  row: { outcome?: string | null; updatedAt?: string | null; createdAt?: string | null },
  nowMs: number,
): boolean {
  if (row.outcome !== "processing") return false;
  const stamp = Date.parse(String(row.updatedAt ?? row.createdAt ?? ""));
  return Number.isFinite(stamp) && nowMs - stamp > STALE_PROCESSING_CLAIM_MS;
}

// What a successful claim hands back: the event row to finalize, plus whatever a PRIOR attempt on
// this same event already recorded. On a fresh claim claimedCandidateId is null and
// claimedMatchReason is undefined; on a re-claim they carry the candidate an earlier attempt
// created or matched, so ingestInboundCv can reuse it instead of re-deriving it through the fuzzy
// dedup in createCandidate — which is exactly what would otherwise spawn a second candidate on a
// retry of an event that already got past createCandidate before failing.
export type IntakeEventClaim = {
  eventId: string;
  claimedCandidateId: string | null;
  claimedMatchReason: CandidateUpsertResult["matchReason"];
};

// The accepted match_reason values, kept type-linked to CandidateMatchReason so this set can never
// drift out of step with the domain union.
const MATCH_REASONS = new Set<CandidateMatchReason>(["national_id", "email", "phone"]);

// match_reason is a free-text column; narrow it back to the union before it re-enters the domain.
function asMatchReason(value: unknown): CandidateUpsertResult["matchReason"] {
  return typeof value === "string" && MATCH_REASONS.has(value as CandidateMatchReason)
    ? (value as CandidateMatchReason)
    : undefined;
}

// Returns the claimed event, or null if (channel, provider_message_id) is already claimed —
// i.e. this exact message is already being/been processed by another run.
//
// The one case that DOES re-claim: a row abandoned in 'processing'. The unique index alone would
// treat a crashed or timed-out attempt as "already handled" forever, so Meta's redelivery would
// return ignored_duplicate and the CV would vanish without ever becoming a candidate. That is a
// real risk during a bulk import, where a burst of AI extractions can outrun the request budget.
async function claimIntakeEvent(input: InboundCvIntakeInput): Promise<IntakeEventClaim | null> {
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
  // A fresh insert: brand-new 'processing' row, so no prior attempt and nothing to thread through.
  if (!error) {
    return data
      ? { claimedCandidateId: null, claimedMatchReason: undefined, eventId: String((data as { id: unknown }).id) }
      : null;
  }
  if ((error as { code?: string }).code !== "23505") throw error;

  const { data: existing, error: existingError } = await supabase
    .from("ats_cv_intake_events")
    .select("id,outcome,created_at,updated_at")
    .eq("channel", input.channel)
    .eq("provider_message_id", input.providerMessageId)
    .maybeSingle();
  if (existingError || !existing) return null;

  const row = existing as { id: unknown; outcome?: string | null; created_at?: string | null; updated_at?: string | null };
  // A row that already produced a candidate is terminal — never re-run it, even on an explicit
  // reclaim, so a duplicate delivery can't spawn a second candidate.
  if (row.outcome === "candidate_created" || row.outcome === "candidate_matched") return null;

  // Two ways a leftover row is legitimately re-claimable: the worker asked (input.reclaim — the
  // queue is the single-flight authority), or it's a stale 'processing' row from a crashed run.
  const eligible = input.reclaim === true || isStaleProcessingClaim({ createdAt: row.created_at, outcome: row.outcome, updatedAt: row.updated_at }, Date.now());
  if (!eligible) return null;

  // Reset it to 'processing' and clear any prior error, re-stamping updated_at as part of the
  // takeover. The not-in guard means a candidate produced by a concurrent run can never be clobbered.
  const { data: reclaimed, error: reclaimError } = await supabase
    .from("ats_cv_intake_events")
    .update({ error_message: null, outcome: "processing", updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .not("outcome", "in", "(candidate_created,candidate_matched)")
    .select("id,candidate_id,match_reason")
    .maybeSingle();
  if (reclaimError || !reclaimed) return null;
  // The takeover leaves candidate_id/match_reason untouched, so they still hold whatever the prior
  // attempt recorded before it died — thread them back so ingestInboundCv can reuse that candidate.
  const claimedRow = reclaimed as { id: unknown; candidate_id?: string | null; match_reason?: string | null };
  return {
    claimedCandidateId: claimedRow.candidate_id ?? null,
    claimedMatchReason: asMatchReason(claimedRow.match_reason),
    eventId: String(claimedRow.id),
  };
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

// An unknown position_key falls back to the default schema rather than reporting zero, so a
// misconfigured position can never silently swallow the "someone needs to look at this" signal.
function unappliedFieldCount(extraction: CvFieldExtraction, candidate: Candidate): number {
  const schema = getCvPositionSchema(extraction.positionKey) ?? getCvPositionSchema(defaultCvPositionKey);
  return schema ? countUnappliedCvFields(extraction.fields, candidate, schema) : 0;
}

export async function ingestInboundCv(input: InboundCvIntakeInput): Promise<InboundCvIntakeResult> {
  const claim = await claimIntakeEvent(input);
  if (!claim) return { outcome: "ignored_duplicate" };
  const { claimedCandidateId, claimedMatchReason, eventId } = claim;

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

    // ONE AI call both SCREENS (is_cv) and EXTRACTS the fields — see extractCvFieldsFromBytes.
    // Runs on the bytes before the candidate exists so a bulk forward-import can build the profile
    // from the CV's own name/email/phone rather than the forwarding account's. Best-effort: a
    // read failure fails OPEN (no gate, no fields — a real applicant is never blocked by an AI
    // hiccup), and only a confident is_cv:false suppresses a candidate (a vendor pitch / invoice /
    // letter that merely arrived as a PDF). This replaces the previous separate looksLikeCv call —
    // exactly one AI round-trip per CV now instead of a classify then an extract.
    //
    // No positionKey is passed, and that is deliberate — do NOT add one. This defaulted to the
    // Medical Rep template until 2026-08-14, which meant every inbound CV was read as though the
    // applicant were a medical rep: a pharmacist, an accountant or a sales manager had their CV
    // mined for "medical rep employer" and little else, and the job they had actually applied for
    // was recorded nowhere. defaultCvPositionKey is now "universal" and the job title is an
    // EXTRACTED FIELD (currentJobTitle), not a precondition of extraction — so intake reads
    // whatever the CV contains, and supporting a new role costs no code change at all.
    let extraction: CvFieldExtraction | null = null;
    try {
      extraction = await extractCvFieldsFromBytes({
        bytes: input.attachment.bytes,
        fileName: input.attachment.fileName,
        mimeType: input.attachment.mimeType,
      });
    } catch {
      /* best-effort — fail open (proceed without the gate or the fields) */
    }
    if (extraction && extraction.isCv === false) {
      await finalizeIntakeEvent(eventId, {
        errorMessage: "Attachment does not appear to be a CV/resume (automated content check).",
        outcome: "ignored_unsupported_attachment",
      });
      return { outcome: "ignored_unsupported_attachment" };
    }

    // A bulk forward-import reads identity from the CV itself (the sender is the forwarder, not the
    // applicant); a direct applicant's own email/phone is their real contact detail. A failed read
    // yields null match keys, so the worst case is a correctly-separate profile, never a merge.
    const identity =
      input.identitySource === "cv"
        ? candidateIdentityFromCvFields(extraction, input.candidate.fullName)
        : { email: input.candidate.email ?? null, fullName: input.candidate.fullName, phone: input.candidate.phone ?? null };

    // On a re-claim, a prior attempt may already have created or matched a candidate for this exact
    // event (e.g. it got past createCandidate but died at the upload below). Reuse that candidate
    // rather than running createCandidate's fuzzy dedup a second time — re-deriving it is what would
    // otherwise spawn a duplicate candidate on retry. A prior match_reason means that attempt
    // MATCHED an existing candidate (created = false); its absence means it CREATED one
    // (created = true). If the prior candidate has since been deleted, fall back to normal resolution.
    const priorCandidate = claimedCandidateId ? await getCandidate(claimedCandidateId) : null;
    const { candidate, created, matchReason } = priorCandidate
      ? { candidate: priorCandidate, created: !claimedMatchReason, matchReason: claimedMatchReason }
      : await createCandidate(
          {
            email: identity.email,
            fullName: identity.fullName,
            notes: input.candidate.notes ?? null,
            phone: identity.phone,
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

    // Persist the ONE extraction we already ran (both channels, both identity sources) against the
    // uploaded file — best-effort; an AI/DB hiccup must never undo the candidate + file that
    // already exist. No second AI call: classify + extract were merged above.
    try {
      if (extraction) {
        await persistCvExtraction({ access: systemAccessContext, candidateId: candidate.id, extraction, fileId });
      }
    } catch {
      /* best-effort */
    }

    // Fill the candidate's still-empty columns from the high-confidence half of that same
    // extraction. Without this the enrichment is invisible: the review UI is only reachable from
    // the two manual upload paths, so an auto-intake candidate's proposal was never surfaced to
    // anyone (see cv-auto-apply.ts). Gap-fill only — never an overwrite — so a human edit or an
    // earlier extraction always wins, and anything low-confidence still waits for review.
    //
    // applied_fields is deliberately NOT written here. cv-extraction-analytics.ts reads
    // "applied_fields is not null" as "Talent Acquisition reviewed and saved this one" and measures
    // the AI's correction rate from the diff; recording an unattended write there would fake a
    // perfect score and destroy the only signal we have on extraction quality.
    //
    // Best-effort, like the persist above: the candidate and file already exist and are the point
    // of this function, so a failure to enrich must never fail the intake.
    // Tracked so the notification below can report what is still OUTSTANDING rather than what the
    // AI found: auto-apply has usually just filled several of those fields itself.
    let enrichedCandidate = candidate;
    try {
      if (extraction) {
        const autoApply = selectAutoApplyFields({
          candidate,
          extractedFields: extraction.fields,
          positionKey: extraction.positionKey,
        });
        if (Object.keys(autoApply).length > 0) {
          enrichedCandidate = await updateCandidate(candidate.id, autoApply);
        }
      }
    } catch (autoApplyError) {
      logError("CV auto-apply of high-confidence fields failed", {
        error: autoApplyError,
        labels: { candidateId: candidate.id, event: "cv_auto_apply_failed" },
      });
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
      // Count only what is STILL waiting: the high-confidence half was already written onto the
      // candidate by the auto-apply above, so counting the whole extraction would send Talent
      // Acquisition to "review and save" fields that are already saved — and, when everything
      // auto-applied, to review nothing at all. A notification that is wrong that often stops
      // being read, which would defeat the reason this count was added.
      //
      // Measured against the candidate record rather than by subtracting the auto-applied tally:
      // countProposedCvFields includes the identity triple, which auto-apply deliberately never
      // touches but createCandidate has already saved, so arithmetic would still overstate by up
      // to three. Comparing to the row is exact — and it is the same function the profile banner
      // uses, so the notification and the screen it links to can never disagree.
      fieldsAwaitingReview: extraction ? unappliedFieldCount(extraction, enrichedCandidate) : 0,
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
