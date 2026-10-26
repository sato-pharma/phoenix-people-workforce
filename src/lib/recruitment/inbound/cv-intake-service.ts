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
import { scoreCvExtraction } from "@/lib/recruitment/cv-extraction-quality";
import { defaultCvPositionKey, getCvPositionSchema } from "@/lib/recruitment/cv-field-schemas";
import { detectCvFileKind } from "@/lib/recruitment/cv-file-kind";
import { recruitmentDb } from "@/lib/recruitment/db";
import {
  cvContentFingerprint,
  findContentFingerprintOwner,
  uploadCandidateFile,
} from "@/lib/recruitment/files";
import { inboxCvGate } from "@/lib/recruitment/inbound/email-mailboxes-config";
import { heldBackReason, strictGateHoldsBack } from "@/lib/recruitment/inbound/inbox-cv-gate";
import { notifyTalentAcquisitionOfInboundCv } from "@/lib/recruitment/inbound/recruitment-notify";
import { extractChannelCode } from "@/lib/recruitment/outreach/channel-code";
import { resolveForwarderChannelCode } from "@/lib/recruitment/outreach/job-post-channels";
import type { Candidate } from "@/lib/recruitment/types";

export type InboundCvChannel = "email" | "whatsapp" | "website";

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
  // The sender's own words, already formatted by formatCoveringMessage — the email subject and
  // body, or the WhatsApp caption plus the messages that arrived just before the CV. Handed to the
  // extraction call so it can answer "which job is this person applying FOR", which a CV almost
  // never states. Optional; absent for a recruiter-uploaded CV.
  coverMessage?: string | null;
  candidate: { fullName: string; email?: string | null; phone?: string | null; notes?: string | null };
  // Defaults to "sender" — existing callers and every live applicant are unaffected.
  identitySource?: InboundCvIdentitySource;
  // null => nothing usable arrived with this message (a plain-text reply, an image, etc.) —
  // logged and ignored, no candidate, no notification.
  attachment: InboundCvAttachment | null;
  // Set by the worker when the message DID carry a CV share link and it could not be downloaded.
  // Distinguishes "this message never had a CV" from "a CV was there and we failed to fetch it",
  // which the old code could not tell apart — both landed as ignored_no_attachment.
  linkFetchFailure?: string | null;
  rawMetadata?: Record<string, unknown>;
  // Set by the durable intake worker when RE-processing a queued item after a prior failure. The
  // queue (ats_inbound_intake_queue) is the single-flight authority in that path — SKIP LOCKED
  // guarantees one worker per message — so the event's own claim must NOT treat a leftover
  // 'processing'/'error' row from the failed attempt as "already handled". Without this, a retry
  // would dedupe to ignored_duplicate and the failed upload/extract would never actually re-run.
  // A row that already SUCCEEDED (candidate_created/matched) is still never re-claimed.
  reclaim?: boolean;
  // True when this CV came from a forwarding handset (an import sender) or a coexistence history
  // replay rather than from the applicant. It changes NOTHING about capture — the candidate, the
  // file and the daily digest are identical either way — only whether the arrival interrupts a
  // human immediately. Set by the worker, the only layer that knows the sender's role.
  bulkArrival?: boolean;
  // A spend gate on the paid model read, asked only when the read would actually call the model. Set
  // by the public careers form (public-apply-ai-budget.ts); absent everywhere else, which is today's
  // behaviour exactly. A refusal reads the CV the free way (rules, then OCR) and never loses it.
  aiBudget?: () => Promise<boolean>;
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
  matchReason?: CandidateMatchReason;
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
const MATCH_REASONS = new Set<CandidateMatchReason>(["national_id", "email", "phone", "cv_content"]);

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

  // Which advert brought this person in.
  //
  // The code rides inside the applicant's own first message — coverMessage already holds exactly
  // that (an email's subject and body, or a WhatsApp caption plus the messages sent just before the
  // CV) — and the email subject. The CV's own FILENAME is read too, and it is the half that survives
  // a WhatsApp FORWARD: a forward carries the file, its caption and its filename, but NOT the
  // applicant's separate greeting — which is where the tapped-link code sits by default. The
  // filename is deliberately kept OUT of coverMessage (it would feed "Cv.pdf" to the job-matching
  // model), so it is read here explicitly and LAST, so a real greeting or subject still wins over it.
  //
  // Only if NONE of those carried a code do we fall back to WHO forwarded it: ~95% of CVs arrive as
  // a forward from a dedicated relay handset, and each relay is tied to one advert channel. The
  // on-CV code always wins, so a code-bearing CV keeps its real per-group source; a code-less
  // forward inherits its relay's channel. A direct applicant (no relay, no code) still resolves to
  // null — "we do not know", never "no channel".
  const onCvCode = extractChannelCode([input.coverMessage, input.subject, input.attachment?.fileName]);
  const sourceChannelCode = onCvCode ?? (await resolveForwarderChannelCode(input.senderIdentifier));

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
      source_channel_code: sourceChannelCode,
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

export type IntakeEventPatch = {
  outcome: InboundCvIntakeOutcome;
  candidateId?: string | null;
  fileId?: string | null;
  matchReason?: string | null;
  errorMessage?: string | null;
};

/**
 * The columns a finalize should actually write.
 *
 * It is called `patch` and it must behave like one. Every field except `outcome` is optional, and
 * writing them all unconditionally means a LATER, thinner call erases what an earlier, fuller one
 * recorded: ingestInboundCv's outer catch finalizes with only an outcome and a message, so a throw
 * after the success path had already stored candidate_id/file_id would null both — losing the
 * event's only pointers to a candidate and a CV that really do exist. claimIntakeEvent relies on
 * the same durability when it threads a dead attempt's candidate_id back into a retry.
 *
 * An absent key is therefore left out of the statement entirely. A key present as null still
 * clears, which is what every "nothing to record here" call site intends.
 */
export function intakeEventUpdateColumns(patch: IntakeEventPatch): {
  candidate_id?: string | null;
  error_message?: string | null;
  file_id?: string | null;
  match_reason?: string | null;
  outcome: InboundCvIntakeOutcome;
} {
  return {
    ...(patch.candidateId !== undefined ? { candidate_id: patch.candidateId } : {}),
    ...(patch.errorMessage !== undefined ? { error_message: patch.errorMessage } : {}),
    ...(patch.fileId !== undefined ? { file_id: patch.fileId } : {}),
    ...(patch.matchReason !== undefined ? { match_reason: patch.matchReason } : {}),
    outcome: patch.outcome,
  };
}

async function finalizeIntakeEvent(eventId: string, patch: IntakeEventPatch): Promise<void> {
  const supabase = recruitmentDb();
  const { error } = await supabase
    .from("ats_cv_intake_events")
    .update({ ...intakeEventUpdateColumns(patch), updated_at: new Date().toISOString() })
    .eq("id", eventId);
  if (error) throw error;
}

// An unknown position_key falls back to the default schema rather than reporting zero, so a
// misconfigured position can never silently swallow the "someone needs to look at this" signal.
function unappliedFieldCount(extraction: CvFieldExtraction, candidate: Candidate): number {
  // Total by construction. This is evaluated while building the argument object of the
  // notifyTalentAcquisitionOfInboundCv call, which sits AFTER the success finalize — and an
  // argument expression runs before the promise exists, so the trailing `.catch()` cannot see it.
  // A throw here would unwind into ingestInboundCv's outer catch and re-finalize a successful
  // intake as an error. A notification count is never worth that.
  try {
    const schema = getCvPositionSchema(extraction.positionKey) ?? getCvPositionSchema(defaultCvPositionKey);
    return schema ? countUnappliedCvFields(extraction.fields, candidate, schema) : 0;
  } catch (countError) {
    logError("CV field count for the intake notification failed", {
      error: countError,
      labels: { event: "cv_unapplied_field_count_failed", positionKey: extraction.positionKey },
    });
    return 0;
  }
}

// The extraction schema's own label for a field key, so the held-back reason on Inbound Intake
// Health reads "missing name, work history" and not "missing fullName, workHistory". The schema is
// the single source of those words; falling back to the key itself only happens for a key the
// schema no longer defines, which is better than showing nothing.
function cvFieldLabel(positionKey: string, fieldKey: string): string {
  const schema = getCvPositionSchema(positionKey) ?? getCvPositionSchema(defaultCvPositionKey);
  return schema?.fields.find((field) => field.key === fieldKey)?.label ?? fieldKey;
}

export async function ingestInboundCv(input: InboundCvIntakeInput): Promise<InboundCvIntakeResult> {
  const claim = await claimIntakeEvent(input);
  if (!claim) return { outcome: "ignored_duplicate" };
  const { claimedCandidateId, claimedMatchReason, eventId } = claim;

  // Set once the event has been finalized as a success. Anything that throws after that point is
  // reporting a problem with the AFTERMATH — a notification, a log line — not with the intake, and
  // must not be allowed to rewrite a recorded candidate_created as an error.
  let settled: InboundCvIntakeResult | null = null;

  try {
    if (!input.attachment) {
      // A CV that arrived as a share link and could not be downloaded is NOT "no attachment" — a
      // CV was there, and we are the reason it is not here. Recording it as a held-back attachment
      // puts it on Inbound Intake Health with its reason (listHeldBackIntakeAttachments reads
      // exactly that outcome + error_message pair) and counts it against the delivery success rate.
      // Filed as ignored_no_attachment it was invisible: that bucket is excluded from the rate on
      // the grounds that it never carried a CV, which is precisely what made this loss silent.
      if (input.linkFetchFailure) {
        await finalizeIntakeEvent(eventId, {
          errorMessage: input.linkFetchFailure,
          outcome: "ignored_unsupported_attachment",
        });
        return { outcome: "ignored_unsupported_attachment" };
      }
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

    // On a re-claim, a prior attempt may already have created or matched a candidate for this exact
    // event (e.g. it got past createCandidate but died at the upload below). Reuse that candidate
    // rather than running createCandidate's fuzzy dedup a second time — re-deriving it is what would
    // otherwise spawn a duplicate candidate on retry. A prior match_reason means that attempt
    // MATCHED an existing candidate (created = false); its absence means it CREATED one
    // (created = true). If the prior candidate has since been deleted, fall back to normal resolution.
    const priorCandidate = claimedCandidateId ? await getCandidate(claimedCandidateId) : null;

    // A CV that is byte-for-byte one we already hold belongs to whoever already holds it.
    //
    // This runs BEFORE the CV read below, and that is the whole saving: identical bytes already filed
    // as a CV were already accepted as one, so the paid read is skipped for them (with it the is_cv
    // and per-inbox gates, which that file already passed). Bytes filed as anything else — an ID
    // scan, a certificate — were never judged as a CV, so they are still read. A re-claim keeps the
    // read: its prior attempt may have died before the extraction was saved.
    //
    // It also runs BEFORE createCandidate because createCandidate cannot be taken back: it resolves on
    // national ID, then email, and candidate-matching.ts keeps phone OUT of that decision on purpose
    // (phone matching once merged three different applicants into one record). A WhatsApp CV usually
    // carries no national ID and no email, and the phone on it belongs to whoever FORWARDED it — so
    // without this check the identical document CREATES a second person, every time. Measured on
    // production 2026-09-05: 986 CV files held 739 distinct documents, and 21 candidate records
    // existed only because of this. One had already been sent to a hiring manager under one record
    // while the identical CV sat untouched under the other.
    //
    // The bytes are proof in a way the phone and the name are not, which is the distinction
    // 20260905051500's duplicate shelf exists to record: a resemblance gets filed for a human to
    // judge, an identity is simply the same person. Oldest owner wins, so a late arrival attaches to
    // the record already in the pipeline rather than dragging it to a new one.
    //
    // A failed lookup must never cost us the CV — fall through to identity matching, which is
    // exactly today's behaviour.
    const contentFingerprint = cvContentFingerprint(input.attachment.bytes);
    let sameCvCandidate: Awaited<ReturnType<typeof getCandidate>> = null;
    let sameCvAlreadyFiledAsCv = false;
    if (!priorCandidate) {
      try {
        const owner = await findContentFingerprintOwner(contentFingerprint);
        sameCvCandidate = owner ? await getCandidate(owner.candidateId) : null;
        sameCvAlreadyFiledAsCv = sameCvCandidate !== null && owner?.kind === "cv";
      } catch (fingerprintError) {
        logError("CV fingerprint lookup failed; falling back to identity matching", {
          error: fingerprintError,
          labels: { channel: input.channel, event: "cv_fingerprint_lookup_failed" },
        });
      }
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
    let extractionError: string | null = null;
    // Skipped only for bytes already filed as a CV (see the fingerprint lookup above).
    if (!sameCvAlreadyFiledAsCv) {
      try {
        extraction = await extractCvFieldsFromBytes({
          bytes: input.attachment.bytes,
          // What they WROTE when they sent it. The same call that reads the CV also reads the
          // covering note, so answering "which job did they apply for" costs no second AI call.
          coverMessage: input.coverMessage ?? null,
          aiBudget: input.aiBudget,
          fileName: input.attachment.fileName,
          mimeType: input.attachment.mimeType,
          // For the free RULE pass.
          //
          // The subject is always safe to pass: it describes the JOB, not the person, and in this
          // inbox it is the vacancy name the great majority of the time because that is what our own
          // job ads tell applicants to write. It answers appliedForJobTitle with no model involved.
          //
          // The sender's name and address are WITHHELD on a bulk forward-import, and that is not a
          // detail. The rule engine falls back to the sender's address when the CV body contains no
          // email, and on identitySource "cv" the candidate's whole identity is built from the
          // extracted fields (see below) — so passing the forwarder's address here would stamp it onto
          // every candidate in the import and collapse them into one. That is not hypothetical: it is
          // the WhatsApp forwarder incident, and it is why identitySource exists at all.
          senderEmail: input.identitySource === "cv" ? null : input.senderIdentifier,
          senderName: input.identitySource === "cv" ? null : (input.senderDisplayName ?? null),
          subject: input.subject ?? null,
        });
      } catch (error) {
        // Still fails OPEN — the candidate and their CV file are created either way, because a real
        // applicant must never be lost to an AI hiccup. What changed on 2026-08-15 is that the
        // failure is now RECORDED. This catch used to be an empty block: the CV was silently never
        // read, the candidate landed with a name and nothing else, and there was no error row, no
        // log line and no flag anywhere. Production carried 226 candidates against 177 extractions
        // and 0 intake errors — 49 unread CVs that looked, from every surface, like successes.
        extractionError = error instanceof Error ? error.message : "CV extraction failed.";
        logError("Inbound CV extraction failed; the candidate was created without extracted fields", {
          error,
          labels: {
            channel: input.channel,
            event: "inbound_cv_extraction_failed",
            file_name: input.attachment.fileName,
            provider_message_id: input.providerMessageId,
          },
        });
      }
    }
    if (extraction && extraction.isCv === false) {
      await finalizeIntakeEvent(eventId, {
        errorMessage: "Attachment does not appear to be a CV/resume (automated content check).",
        outcome: "ignored_unsupported_attachment",
      });
      return { outcome: "ignored_unsupported_attachment" };
    }

    // The per-inbox gate, on top of the shared is_cv check above — see inbox-cv-gate.ts for the
    // measured reason it is per-inbox and not global. A general mailbox (hr@) additionally holds
    // back a file the model read and which does not read like a CV; the address printed on our job
    // ads (careers@) and WhatsApp do not, because there a thin read means the CV failed to read.
    //
    // Guarded on `extraction` deliberately: a read that never RAN fails open in every inbox. The
    // one thing this must never become is a second way for an AI outage to lose an applicant.
    //
    // Nothing is deleted and nothing is silent — the reason lands on the intake event, which is
    // exactly the row Inbound Intake Health renders, and the message stays in the mailbox.
    // Bound to a const so the narrowing survives into the label callback below — `extraction` is a
    // `let`, and TypeScript will not carry a narrowed `let` into a function expression.
    const read = extraction;
    if (read) {
      const score = scoreCvExtraction(read.fields);
      if (strictGateHoldsBack(inboxCvGate(input.mailboxLabel), score)) {
        await finalizeIntakeEvent(eventId, {
          errorMessage: heldBackReason(input.mailboxLabel, score, (key) => cvFieldLabel(read.positionKey, key)),
          outcome: "ignored_unsupported_attachment",
        });
        return { outcome: "ignored_unsupported_attachment" };
      }
    }

    // A bulk forward-import reads identity from the CV itself (the sender is the forwarder, not the
    // applicant); a direct applicant's own email/phone is their real contact detail. A failed read
    // yields null match keys, so the worst case is a correctly-separate profile, never a merge.
    //
    // The NAME is the exception, and it splits away from email/phone deliberately (2026-08-15).
    // Measured in production: of 172 candidates whose CV had been read, 105 carried a name that
    // differed from the one on the document, and at least two were a DIFFERENT PERSON entirely —
    // because an email header's display name is whoever holds the mailbox, not whoever the CV is
    // about. "Ahmed Mohamed" forwarding his cousin's CV became a candidate called Ahmed Mohamed.
    // The address and the number are still the sender's own and stay that way; only the name comes
    // from the document, and only when the extraction actually produced one — a failed or blank
    // read falls straight back to the sender, exactly as before.
    //
    // The attachment's filename is handed over as the name fallback: it is the applicant's, where
    // the sender may be a forwarder. resolveCandidateFullNameFromCv only reaches for it when the
    // extracted name cannot be trusted — unsure, or an institution rather than a person.
    const cvIdentity = candidateIdentityFromCvFields(
      extraction,
      input.candidate.fullName,
      input.attachment.fileName,
    );
    const identity =
      input.identitySource === "cv"
        ? cvIdentity
        : { email: input.candidate.email ?? null, fullName: cvIdentity.fullName, phone: input.candidate.phone ?? null };

    const { candidate, created, matchReason } = priorCandidate
      ? { candidate: priorCandidate, created: !claimedMatchReason, matchReason: claimedMatchReason }
      : sameCvCandidate
        ? { candidate: sameCvCandidate, created: false, matchReason: "cv_content" as const }
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
        // Passed but not decisive: a candidate with no CV behind it needs a human whoever sent it,
        // so the no-file reason is answered before bulkArrival is ever consulted.
        bulkArrival: input.bulkArrival === true,
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
    // extraction. This is now the ONLY path by which an extracted field reaches a candidate
    // unattended — the review queue that used to catch the rest was removed 2026-08-15, having been
    // opened for 5 of 194 CVs. Gap-fill only — never an overwrite — so a human edit or an earlier
    // extraction always wins, and anything low-confidence stays in extracted_fields, readable from
    // the candidate profile, rather than blocking the candidate from moving.
    //
    // applied_fields is deliberately NOT written here: it means "a human reviewed and saved this
    // one", and an unattended write must not claim that.
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
          candidateWasCreatedByThisIntake: created,
          extractedFields: extraction.fields,
          positionKey: extraction.positionKey,
        });
        if (Object.keys(autoApply).length > 0) {
          // An identity column the AI read off this CV can already belong to somebody in the pool —
          // the same applicant under a second phone number, or a misread — and that rejects the
          // WHOLE update, taking governorate, university and every other enriched column down with
          // it. Retry once without the identity columns so the rest still lands, and leave the
          // rejected value in extracted_fields for a human to resolve.
          //
          // EMAIL is the one that can actually collide today: recruitment_candidates_email_norm_uidx
          // is UNIQUE and live, and email joined auto-apply on 2026-09-05 (see cv-auto-apply.ts).
          // Phone is kept in the strip because it is the same class of value, but its own unique
          // index was dropped on 2026-08-15 and must not be restored — so a phone collision no
          // longer reaches here, and a comment claiming phone_norm is unique would be wrong.
          try {
            enrichedCandidate = await updateCandidate(candidate.id, autoApply);
          } catch (writeError) {
            const { email: _rejectedEmail, phone: _rejectedPhone, ...withoutIdentity } = autoApply;
            // Nothing identity-shaped to blame — the failure is something else and must surface.
            if (Object.keys(withoutIdentity).length === Object.keys(autoApply).length) throw writeError;
            logError("CV auto-apply could not write an extracted identity column; applying the rest", {
              error: writeError,
              labels: { candidateId: candidate.id, event: "cv_auto_apply_identity_rejected" },
            });
            enrichedCandidate =
              Object.keys(withoutIdentity).length > 0
                ? await updateCandidate(candidate.id, withoutIdentity)
                : enrichedCandidate;
          }
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
      // A successful intake that could not READ the CV records why, on the very row Inbound Intake
      // Health already renders. The outcome stays candidate_created/matched — the applicant IS on
      // record — but "we never read this one" is now visible on screen instead of being knowable
      // only by counting candidates against extractions in SQL.
      errorMessage: extractionError,
      fileId,
      matchReason: matchReason ?? null,
      outcome,
    });

    // The row now says candidate_created/matched with its candidate and file attached. From here
    // on the work is done and the outcome is the truth, whatever the notification does.
    settled = { candidateId: candidate.id, fileId, matchReason, outcome };

    await notifyTalentAcquisitionOfInboundCv({
      // The one field that decides whether this interrupts a human now or waits for the 18:00
      // digest. False for a member of the public answering the advert — that is the alert whose
      // absence the owner reported on 2026-08-29, when the applicant's TEXT pinged his Telegram in
      // one second and the CV twenty-five seconds later produced no notification row at all.
      bulkArrival: input.bulkArrival === true,
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
    if (settled) {
      logError("Inbound CV intake threw after the event was finalized; the recorded outcome stands", {
        error,
        labels: { candidateId: settled.candidateId ?? "unknown", event: "cv_intake_post_finalize_throw" },
      });
      return settled;
    }
    await finalizeIntakeEvent(eventId, {
      errorMessage: error instanceof Error ? error.message : "Inbound CV intake failed.",
      outcome: "error",
    }).catch(() => {});
    return { outcome: "error" };
  }
}
