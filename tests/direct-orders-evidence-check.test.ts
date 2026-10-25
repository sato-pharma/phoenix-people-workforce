import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { signMatchesClaimedName } from "../src/lib/direct-orders/evidence-check.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Reading the storefront evidence (spec E2).
//
// A Super Admin deciding a validation sees a claimed name, a GPS distance and a photo, and has to
// judge the photo unaided. This reads it once at filing so the answer is already on the desk.
//
// THE RULE IT MUST NOT BREAK: it ADVISES, it never decides. `AREA_PROXIMITY_FLAG_KM` in
// pharmacy-validation.ts already says why — "a hard gate would reject real pharmacies … producing
// exactly the 'the new system blocked everything' complaint the whole design exists to avoid." A
// real Egyptian pharmacy may have a handwritten sign, an Arabic-only sign, no sign, or one behind a
// parked truck.
//
// So the two failures this file exists to prevent are:
//   1. an unknown answer being shown, stored or treated as a PASS, and
//   2. this ever becoming a gate on the decision.
// ─────────────────────────────────────────────────────────────────────────────

const READER = "../src/lib/direct-orders/evidence-check.ts";
const VALIDATION = "../src/lib/direct-orders/pharmacy-validation.ts";
const DESK = "../src/components/direct-orders/validation-desk.tsx";
// The rendering that actually shows the reading — the EvidenceReading component — moved out of
// the desk on 2026-08-08 so the admin AND portal approval screens could reuse it unchanged (a
// second, third copy is exactly how the D4 wording would drift). It is the one file that now
// carries the visible prose this test exists to police, so it must be swept in its own right, not
// assumed to still live inside DESK.
const EVIDENCE_READING = "../src/components/direct-orders/evidence-reading.tsx";
const MIGRATION = "../supabase/migrations/20260806090000_direct_order_evidence_check.sql";

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runDirectOrderEvidenceCheckTests() {
  const reader = read(READER);
  const validation = read(VALIDATION);
  const desk = read(DESK);
  const evidenceReading = read(EVIDENCE_READING);

  // ── The name comparison, EXECUTED ────────────────────────────────────────────────────────
  //
  // Production has zero pending validations, so nothing here can be checked against live data.
  // This is the only part of E2 that is pure, so it is the part that gets run for real.

  // An unreadable sign or a missing claim is an ABSENCE, not a mismatch. Rendering "does not
  // match" for a sign nobody could read would accuse a rep on the strength of a blurry photo.
  assert.deepEqual(
    signMatchesClaimedName(null, "صيدلية النور"),
    { matches: null, similarity: null },
    "AN UNREADABLE SIGN IS NOT A MISMATCH: null in must give null out, or a photo taken into the sun becomes evidence against the person who took it",
  );
  assert.deepEqual(
    signMatchesClaimedName("صيدلية النور", null),
    { matches: null, similarity: null },
    "a missing claimed name must also resolve to unknown, never to a mismatch",
  );
  assert.deepEqual(
    signMatchesClaimedName("", ""),
    { matches: null, similarity: null },
    "two empty strings are not a match — they are two absences",
  );

  // The same name in Arabic with different orthography must MATCH: this is exactly what
  // normalizeArabicPharmacyName exists for, and a naive compare disagrees with itself over a hamza.
  const sameName = signMatchesClaimedName("صيدلية النور", "صيدليه النور");
  assert.equal(
    sameName.matches,
    true,
    "ARABIC ORTHOGRAPHY MUST NOT CREATE A MISMATCH: ta-marbuta vs ha is the same pharmacy, and treating it as a mismatch is how a real pharmacy gets doubted",
  );

  const different = signMatchesClaimedName("سوبر ماركت الحسن", "صيدلية النور");
  assert.equal(different.matches, false, "two genuinely different names must read as a mismatch");

  // ── Unknown must survive all the way to the screen ───────────────────────────────────────
  assert.match(
    reader,
    /isPharmacy: boolean \| null;/,
    "isPharmacy MUST be nullable: a reader forced to answer yes-or-no about a sign behind a truck will answer, and it will be wrong in the direction that costs a real pharmacy",
  );
  assert.match(
    reader,
    /return null;/,
    "the reader must be able to return no answer at all when it cannot reach one",
  );
  assert.match(
    evidenceReading,
    /The photo has not been read\. Judge it yourself\./,
    "A MISSING READING MUST SAY SO: rendering nothing is read as 'nothing wrong', which is the one thing an absent answer must never mean — the GPS chip already prints 'distance unknown' for the same reason",
  );
  assert.match(
    evidenceReading,
    /Could not tell whether this is \$\{subject\}\./,
    "a null isPharmacy must render as could-not-tell, never fall through to the positive branch",
  );
  assert.match(
    evidenceReading,
    /venueRequiresDistributorCode\(venueType\)/,
    "the subject of that sentence must follow the VENUE TYPE: a nursery is not judged on whether " +
      "it looks like a pharmacy, and reading it as one is what made a nursery unapprovable",
  );
  assert.match(
    evidenceReading,
    /Could not read the sign\./,
    "an unreadable sign must say so rather than silently omitting the line",
  );

  // ── The reply must have room to finish ───────────────────────────────────────────────────
  // 25 Oct 2026: OpenAI refused its key, the read failed over to Claude, and Claude stopped at the
  // 500-token cap before closing its JSON ("ran out of room … (max_tokens)"), so a rep's photo went
  // unread. The cap bounds the reply; it does not set what a reply costs.
  const cap = /maxOutputTokens:\s*(\d+)/.exec(stripComments(reader));
  assert.ok(cap, "the storefront read must set maxOutputTokens");
  assert.ok(
    Number(cap[1]) >= 1500,
    `THE STOREFRONT READ'S OUTPUT CAP IS ${cap[1]}: below 1,500 Claude runs out of room before it closes the JSON on a long Arabic sign, and the photo goes unread`,
  );

  // ── It must never block the filing ───────────────────────────────────────────────────────
  assert.match(
    validation,
    /try \{\s*\n\s*const evidenceCheck = await checkDirectOrderStorefrontEvidence\(/,
    "THE CHECK MUST BE WRAPPED: a rep standing in front of a pharmacy must never be told their evidence failed because a model was busy — same reasoning as pingDirectOrderSheet being void-and-unawaitable",
  );
  assert.match(
    validation,
    /direct_order_evidence_check_failed/,
    "a failed read must be logged, not swallowed silently — an assist that fails invisibly is one nobody knows to fix",
  );
  // The check runs AFTER the row and the photo are durable. Running it earlier would let a slow
  // read delay, or a thrown read abort, the thing it is only meant to annotate.
  assert.ok(
    validation.indexOf("storage_path: path") < validation.indexOf("checkDirectOrderStorefrontEvidence("),
    "the check must run after the evidence is stored, so it can only ever annotate a filing that already succeeded",
  );

  // ── THE NEGATIVE THAT MATTERS: it is not a gate ──────────────────────────────────────────
  const decideStart = validation.indexOf("export async function decideDirectOrderPharmacyValidation");
  assert.ok(decideStart > 0, "decideDirectOrderPharmacyValidation must exist");
  const decideBlock = validation.slice(decideStart);
  assert.doesNotMatch(
    decideBlock,
    /evidence_check|evidenceCheck/,
    "E2 HAS BECOME A GATE: nothing in the decide path may read the reading. The Super Admin decides; a photograph of a handwritten sign is a reason for a human to look, never grounds for the software to refuse",
  );
  assert.doesNotMatch(
    desk,
    /disabled=\{[^}]*evidenceCheck/,
    "the reading must never disable a decision button — advisory means the admin can still do whatever they judge right",
  );

  // ── D4: it is never announced ────────────────────────────────────────────────────────────
  // Same executable sweep as the invoice reader: strip comments and imports, then check every
  // string and JSX text node the user can actually see.
  const proseOnly = (source: string) =>
    stripComments(source).replace(/^\s*import[\s\S]*?from\s*"[^"]*";?\s*$/gm, "");
  const stringLiterals = (source: string): string[] => {
    const out: string[] = [];
    let i = 0;
    while (i < source.length) {
      const q = source[i];
      if (q !== '"' && q !== "'" && q !== "`") {
        i += 1;
        continue;
      }
      let j = i + 1;
      let value = "";
      while (j < source.length && source[j] !== q) {
        if (source[j] === "\\") {
          value += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      out.push(value);
      i = j + 1;
    }
    return out;
  };
  const banned = /\b(AI|GPT|OpenAI|LLM|model|confidence|artificial intelligence)\b/i;
  // Swept per source, not concatenated — the validation desk is one surface and EvidenceReading
  // (shared by the desk and both approval-detail screens) is another; a failure must point at
  // which one actually leaked the word.
  for (const [label, source] of [["the validation desk", desk], ["EvidenceReading", evidenceReading]] as const) {
    const visible = proseOnly(source);
    for (const text of [...stringLiterals(visible), ...[...visible.matchAll(/>\s*([A-Za-z][^<>{}]{8,})\s*</g)].map((m) => m[1])]) {
      if (/^[a-z0-9:\-\[\]#/. ]+$/.test(text)) continue;
      if (/^[@.]{1,2}\//.test(text)) continue;
      assert.doesNotMatch(
        text,
        banned,
        `D4 VIOLATION — ${label} shows "${text}". The reading presents as Phoenix reading a photo: no model named, and no confidence percentage, because a number invites people to treat a reading as a score`,
      );
    }
  }
  // The similarity IS stored — for later analysis — and must NOT be rendered.
  assert.match(reader, /similarity: number \| null;/, "similarity must be stored for analysis");
  assert.doesNotMatch(evidenceReading, /\{check\.similarity/, "similarity must never be rendered (spec D4)");

  // ── The column exists and says what null means ───────────────────────────────────────────
  const migration = read(MIGRATION);
  assert.match(migration, /add column if not exists evidence_check jsonb;/, "the column must be added idempotently");
  assert.match(
    migration,
    /NULL is a first-class value and means "no answer", never "passed"/,
    "the migration must record what null means, because a future reader deciding it means 'fine' is the whole risk",
  );
}
