import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { candidateIdentityFromCvFields, selectCvFile } from "../src/lib/recruitment/cv-extraction.ts";
import { isStaleProcessingClaim } from "../src/lib/recruitment/inbound/cv-intake-service.ts";
import type { RecruitmentFile } from "../src/lib/recruitment/types.ts";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function file(overrides: Partial<RecruitmentFile>): RecruitmentFile {
  return {
    applicationId: null,
    candidateId: "candidate-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    driveFileId: null,
    externalUrl: null,
    fileName: "cv.pdf",
    id: "file-1",
    kind: "cv",
    mimeType: "application/pdf",
    sizeBytes: 1000,
    updatedAt: "2026-01-01T00:00:00.000Z",
    uploadedByHrId: null,
    ...overrides,
  };
}

export function runRecruitmentInboundCvIntakeTests() {
  // --- selectCvFile (pure logic behind extractCandidateFieldsFromCv's fileId targeting,
  //     added for inbound CV intake — a matched candidate may already have an older CV on
  //     record, so extraction must be able to target the just-uploaded file specifically) ---
  const older = file({ id: "file-old", kind: "cv" });
  const newer = file({ id: "file-new", kind: "cv" });
  const nonCv = file({ id: "file-photo", kind: "photo" });

  assert.equal(
    selectCvFile([older, newer]),
    older,
    "with no fileId, the first cv-kind file wins (existing single-CV-per-candidate assumption)",
  );
  assert.equal(
    selectCvFile([older, newer], "file-new"),
    newer,
    "a given fileId targets that exact file even when an earlier cv-kind file exists",
  );
  assert.equal(selectCvFile([older, newer], "not-a-real-id"), null, "an unmatched fileId yields null, no silent fallback");
  assert.equal(
    selectCvFile([nonCv], "file-photo"),
    null,
    "a fileId matching a non-cv-kind file is rejected — only kind:'cv' counts",
  );
  assert.equal(selectCvFile([]), null, "no files at all yields null");

  // --- candidateIdentityFromCvFields (bulk forward-import identity) ---------------------------
  const field = (value: string | boolean | null) => ({ confidence: "high" as const, value });

  assert.deepEqual(
    candidateIdentityFromCvFields(
      { fields: { email: field("Ahmed@Example.COM "), fullName: field(" Ahmed Mahmoud "), phone: field("01001234567") } },
      "fallback",
    ),
    { email: "Ahmed@Example.COM", fullName: "Ahmed Mahmoud", phone: "01001234567" },
    "the CV's own details win over the fallback, trimmed",
  );

  assert.deepEqual(
    candidateIdentityFromCvFields(null, "WhatsApp Import (d.ABC123)"),
    { email: null, fullName: "WhatsApp Import (d.ABC123)", phone: null },
    "a failed extraction yields NO match keys — the CV gets its own profile instead of merging onto the forwarder",
  );

  assert.deepEqual(
    candidateIdentityFromCvFields({ fields: { email: field(null), fullName: field("   "), phone: field(null) } }, "fallback"),
    { email: null, fullName: "fallback", phone: null },
    "blank/whitespace values are treated as absent, never as an empty-string match key",
  );

  assert.equal(
    candidateIdentityFromCvFields({ fields: { fullName: field(true) } }, "fallback").fullName,
    "fallback",
    "a non-string value never becomes a name",
  );

  // --- The candidate is named by the DOCUMENT, never by the mailbox that sent it ---------------
  // Measured in production 2026-08-15: of 172 candidates whose CV had been read, 105 carried a name
  // that differed from the one on the document, and at least two were a different person entirely.
  // An email header's display name is whoever holds the mailbox, not whoever the CV is about — so
  // "Ahmed Mohamed" forwarding his cousin's CV created a candidate called Ahmed Mohamed.
  //
  // The name splits away from email and phone on purpose: a direct applicant's own address and
  // number ARE their real contact details and must stay the sender's, so only the name is taken
  // from the CV. The three assertions above already prove the fallback half behaviourally — a
  // failed, blank, or non-string extraction hands back the sender's name unchanged.
  const intake = read("src/lib/recruitment/inbound/cv-intake-service.ts");
  assert.match(
    intake,
    /const identity =\s*\n\s*input\.identitySource === "cv"\s*\n\s*\? cvIdentity\s*\n\s*: \{ email: input\.candidate\.email \?\? null, fullName: cvIdentity\.fullName, phone: input\.candidate\.phone \?\? null \}/,
    "a directly-sent CV must still take its NAME from the document while keeping the sender's own email and phone",
  );
  assert.doesNotMatch(
    intake,
    /fullName: input\.candidate\.fullName\b/,
    "the sender's display name must never be written as the candidate's name — that is the defect, and it named 105 of 172 candidates",
  );

  // --- isStaleProcessingClaim -----------------------------------------------------------------
  // The idempotency claim writes 'processing' BEFORE any work. Without this recovery a run that
  // died mid-message (a timeout during a bulk-import burst) would make every later redelivery
  // return ignored_duplicate, silently losing that CV forever.
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  assert.equal(
    isStaleProcessingClaim({ outcome: "processing", updatedAt: at(30) }, now),
    true,
    "a run abandoned in 'processing' well past the request ceiling is re-claimable",
  );
  assert.equal(
    isStaleProcessingClaim({ outcome: "processing", updatedAt: at(2) }, now),
    false,
    "a run still legitimately working is never stolen",
  );
  assert.equal(
    isStaleProcessingClaim({ createdAt: at(30), outcome: "processing", updatedAt: null }, now),
    true,
    "created_at is used when updated_at is absent",
  );
  for (const outcome of ["candidate_created", "candidate_matched", "ignored_duplicate", "error"]) {
    assert.equal(
      isStaleProcessingClaim({ outcome, updatedAt: at(999) }, now),
      false,
      `a finished '${outcome}' event stays claimed forever — re-processing it would duplicate work`,
    );
  }
  assert.equal(
    isStaleProcessingClaim({ outcome: "processing", updatedAt: "not-a-date" }, now),
    false,
    "an unparseable timestamp is not treated as stale",
  );

  // --- Migration: ats_cv_intake_events + ats_email_intake_cursors (folded into the
  //     Phase 1 re-platform migration, since neither table had reached production yet) ------
  const migration = read("supabase/migrations/20260724130000_ats_replatform_phase1.sql");

  assert.match(migration, /create table if not exists public\.ats_cv_intake_events/);
  assert.match(migration, /check \(channel in \('email', 'whatsapp'\)\)/);
  assert.match(
    migration,
    /check \(outcome in \(\s*'processing', 'candidate_created', 'candidate_matched',\s*'ignored_no_attachment', 'ignored_unsupported_attachment',\s*'ignored_duplicate', 'error'\s*\)\)/,
  );
  for (const column of [
    "channel",
    "mailbox_label",
    "provider_message_id",
    "provider_uid",
    "sender_identifier",
    "sender_display_name",
    "subject",
    "outcome",
    "candidate_id",
    "file_id",
    "match_reason",
    "error_message",
    "raw_metadata",
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`), `missing column ${column} on ats_cv_intake_events`);
  }
  assert.match(
    migration,
    /create unique index if not exists ats_cv_intake_events_channel_msg_uniq\s+on public\.ats_cv_intake_events using btree \(channel, provider_message_id\)\s+where provider_message_id is not null/,
    "the (channel, provider_message_id) unique index is the idempotency claim key — must be a partial index (where provider_message_id is not null), not a plain unique constraint",
  );
  assert.match(
    migration,
    /candidate_id[\s\S]*references public\.ats_candidates\(id\) on update cascade on delete set null/,
  );
  assert.match(migration, /file_id[\s\S]*references public\.ats_files\(id\) on update cascade on delete set null/);

  assert.match(migration, /create table if not exists public\.ats_email_intake_cursors/);
  assert.match(migration, /mailbox_label text not null/);
  assert.match(migration, /last_processed_uid bigint not null default 0/);
  assert.match(migration, /constraint ats_email_intake_cursors_pkey primary key \(mailbox_label\)/);

  assert.match(migration, /alter table public\.ats_cv_intake_events enable row level security/);
  assert.match(migration, /alter table public\.ats_email_intake_cursors enable row level security/);
  assert.match(migration, /phx_ats_cv_intake_events_service_role/);
  assert.match(migration, /phx_ats_email_intake_cursors_service_role/);
  assert.match(migration, /grant all on table public\.ats_cv_intake_events to service_role/);
  assert.match(migration, /grant all on table public\.ats_email_intake_cursors to service_role/);
  assert.match(migration, /notify pgrst, 'reload schema'/);
}
