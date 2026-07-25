import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { selectCvFile } from "../src/lib/recruitment/cv-extraction.ts";
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
