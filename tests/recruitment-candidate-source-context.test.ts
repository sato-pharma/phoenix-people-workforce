import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assembleWhatsAppSourceContext,
  describeCandidateSource,
  MAX_WHATSAPP_SOURCE_MESSAGES,
} from "../src/lib/recruitment/candidate-source-context.ts";

export function runRecruitmentCandidateSourceContextTests() {
  // --- Migration: buffer table + per-candidate source-context view -----------------------------
  const migration = readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260726154207_ats_whatsapp_message_buffer_and_source_context.sql"),
    "utf8",
  );
  assert.match(migration, /create table if not exists public\.ats_whatsapp_inbound_messages/);
  assert.match(migration, /alter table public\.ats_whatsapp_inbound_messages enable row level security/);
  assert.match(migration, /create or replace view public\.ats_candidate_source_context/);
  assert.match(migration, /select distinct on \(event\.candidate_id\)/, "the view must be one row per candidate (latest event)");
  assert.match(migration, /order by event\.candidate_id, event\.created_at desc/);

  // --- assembleWhatsAppSourceContext -----------------------------------------------------------
  // Buffer hands messages back NEWEST first; the assembled order must be the order they were SENT.
  assert.deepEqual(
    assembleWhatsAppSourceContext("Please find my CV", ["third", "second", "first"]),
    { caption: "Please find my CV", firstMessages: ["first", "second", "third"] },
    "caption kept; messages reversed to sent order",
  );

  assert.deepEqual(
    assembleWhatsAppSourceContext(null, ["b", "a"]),
    { caption: null, firstMessages: ["a", "b"] },
    "no caption is fine when there are messages",
  );

  assert.deepEqual(
    assembleWhatsAppSourceContext("  Hi   there  ", []),
    { caption: "Hi there", firstMessages: [] },
    "caption alone is enough; whitespace collapsed",
  );

  assert.equal(
    assembleWhatsAppSourceContext(null, []),
    null,
    "nothing to show -> null, so the caller can skip writing an empty object",
  );
  assert.equal(
    assembleWhatsAppSourceContext("   ", ["  ", null, ""]),
    null,
    "blank caption and blank/empty messages -> null",
  );

  const many = ["m5", "m4", "m3", "m2", "m1"];
  const capped = assembleWhatsAppSourceContext(null, many);
  assert.equal(capped?.firstMessages.length, MAX_WHATSAPP_SOURCE_MESSAGES, "capped to the max message count");
  assert.deepEqual(capped?.firstMessages, ["m3", "m4", "m5"], "keeps the 3 most recent, shown in sent order");

  // --- describeCandidateSource: email ----------------------------------------------------------
  assert.deepEqual(
    describeCandidateSource({ channel: "email", subject: "Application for Medical Rep" }),
    { channel: "email", shortLabel: "Application for Medical Rep", detailLines: ["Application for Medical Rep"] },
    "email uses the subject",
  );
  assert.deepEqual(
    describeCandidateSource({ channel: "email", subject: "   " }),
    { channel: "email", shortLabel: null, detailLines: [] },
    "blank email subject -> nothing to show",
  );

  // --- describeCandidateSource: whatsapp -------------------------------------------------------
  const whatsappRow = {
    channel: "whatsapp",
    subject: null,
    raw_metadata: {
      sourceContext: { caption: "My CV for the role", firstMessages: ["Hello", "I'd like to apply"] },
    },
  };
  assert.deepEqual(
    describeCandidateSource(whatsappRow),
    {
      channel: "whatsapp",
      shortLabel: "My CV for the role",
      detailLines: ["My CV for the role", "Hello", "I'd like to apply"],
    },
    "whatsapp: caption first, then messages; short label is the first detail line",
  );

  assert.deepEqual(
    describeCandidateSource({
      channel: "whatsapp",
      raw_metadata: { sourceContext: { caption: null, firstMessages: ["Only a message"] } },
    }),
    { channel: "whatsapp", shortLabel: "Only a message", detailLines: ["Only a message"] },
    "whatsapp with no caption falls back to the first message as the label",
  );

  assert.deepEqual(
    describeCandidateSource({ channel: "whatsapp", raw_metadata: {} }),
    { channel: "whatsapp", shortLabel: null, detailLines: [] },
    "whatsapp with no stored sourceContext -> nothing (e.g. a forward with no caption or messages)",
  );

  // --- describeCandidateSource: defensive ------------------------------------------------------
  assert.deepEqual(
    describeCandidateSource(null),
    { channel: null, shortLabel: null, detailLines: [] },
    "no intake event (manually-added candidate) -> empty context, never throws",
  );
  assert.deepEqual(
    describeCandidateSource({ channel: "unknown-channel", subject: "x" }),
    { channel: null, shortLabel: null, detailLines: [] },
    "an unexpected channel is treated as no source",
  );
  assert.deepEqual(
    describeCandidateSource({ channel: "whatsapp", raw_metadata: "not-an-object" }),
    { channel: "whatsapp", shortLabel: null, detailLines: [] },
    "malformed raw_metadata never throws",
  );
}
