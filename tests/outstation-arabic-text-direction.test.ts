import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Arabic free text on the outstation screens, and the ONE place block-level `dir="auto"` is wrong.
//
// Measured in production (ozucdzovmcqvepbozvqf) on 2026-08-30, counting rows whose FIRST strong
// character is Arabic — i.e. rows whose rendered direction actually changes:
//
//   outstation_expense_requests.residence_address / _area / _city   70 / 70 / 70 of 70, all pure Arabic
//   employees.residence_address / _area / _city                    132 / 130 / 130, all pure Arabic
//   outstation_expense_requests.to_label                            19 of 31 Arabic rows
//   outstation_expense_requests.notes                                1 of 17 Arabic rows
//
// The residence fields are single-language free text, so block-level `dir="auto"` is correct and
// sufficient for them — that is this repo's convention and 57 files already use it.
//
// `notes` is the exception, and the reason is STRUCTURAL rather than a quirk of today's data.
// `appendCarEvidenceNote` and `appendAllowanceGuardNote` in `src/lib/outstation/service.ts` both
// return `[notes, line].filter(Boolean).join("\n")`, so a stored note is the rep's own free text —
// Arabic on a real production row — followed by machine-written ENGLISH audit lines
// ("Arrival photo evidence: source=… gps=… request_id=…"). `dir="auto"` resolves from the FIRST
// strong character of the whole element, so one Arabic opening line turns the entire block RTL and
// drags every English evidence line after it. Confirmed by eye in a 375px harness against the real
// production row: with a block attribute the English line renders right-aligned and ragged-left;
// per line, the Arabic line sits right and the English lines read normally.
//
// That is the mirror image of the bug already pinned for the WhatsApp panel — see
// `tests/whatsapp-replies-panel.test.ts` section 3b. This file exists so a future session reading
// "the house convention is dir=auto" cannot quietly "fix" the notes back and reintroduce it.

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, ROOT)), "utf8");

const ADMIN_SOURCE = read("src/components/outstation/outstation-requests-admin.tsx");
const PRIMITIVES_SOURCE = read("src/components/outstation/approval-detail-primitives.tsx");
const SERVICE_SOURCE = read("src/lib/outstation/service.ts");

// Comments in these files name the WRONG fix in order to warn against it, so anything that counts
// occurrences has to count the code and not the prose.
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export function runOutstationArabicTextDirectionTests() {
  // ── 1. HEADLINE: notes carry direction PER LINE, never on the block ─────────
  assert.match(
    ADMIN_SOURCE,
    /value\.split\("\\n"\)/,
    "the notes body must be split into lines so each carries its own direction — a stored note is " +
      "the rep's free text followed by machine-written English audit lines, and one block cannot " +
      "be both RTL and LTR",
  );
  assert.match(
    ADMIN_SOURCE,
    /className="block whitespace-pre-wrap break-words"\s*\n?\s*dir="auto"/,
    'the dir="auto" must sit on the same per-line span that carries whitespace-pre-wrap and ' +
      "break-words, or the line keeps its direction but loses its line breaks or its wrapping",
  );
  assert.ok(
    !/dir="auto"[^>]*>\s*\{request\.notes/.test(ADMIN_SOURCE),
    'request.notes must never be rendered straight into an element carrying a block-level dir="auto": ' +
      "the first Arabic line would turn the whole note RTL and render every English evidence line " +
      "after it backwards",
  );
  assert.match(
    ADMIN_SOURCE,
    /<NotesBody value=\{request\.notes\} \/>/,
    "and the per-line component must actually be the thing the detail modal renders, or it is dead " +
      "code sitting next to the defect it was written to remove",
  );
  assert.match(
    ADMIN_SOURCE,
    /line === "" \? " " : line/,
    "an empty line must still occupy a line box, or a blank the rep left between two paragraphs " +
      "collapses and the lines run together",
  );

  // ── 2. THE PREMISE the per-line treatment rests on ─────────────────────────
  // If these ever stop appending English to a free-text note, the reasoning above is worth
  // revisiting — so pin the premise, not just the conclusion.
  assert.match(
    SERVICE_SOURCE,
    /\[notes, evidenceLine\]\.filter\(Boolean\)\.join\("\\n"\)/,
    "appendCarEvidenceNote appends an English evidence line to whatever the rep typed, which is " +
      "what makes a stored note bilingual across its own lines",
  );
  assert.match(
    SERVICE_SOURCE,
    /\[notes, line\]\.filter\(Boolean\)\.join\("\\n"\)/,
    "appendAllowanceGuardNote does the same, so the shape is the rule for notes and not one row's " +
      "accident",
  );

  // ── 3. The single-language fields DO take the block attribute ──────────────
  // Residence and route values are pure Arabic in production, so block-level auto-detection is
  // both correct and the house convention. Three of them: the Fact value, and RouteFact's two ends.
  assert.equal(
    (stripComments(PRIMITIVES_SOURCE).match(/dir="auto"/g) ?? []).length,
    3,
    "the shared approval-detail primitives must carry exactly three dir=\"auto\" attributes — the " +
      "Fact value and both ends of RouteFact — because residence addresses and destinations are " +
      "single-language Arabic and render against the reader without it",
  );
  assert.match(
    PRIMITIVES_SOURCE,
    /dir="auto">\{from \|\| "—"\}/,
    "RouteFact's origin is the joined residence address, Arabic in 70 of 70 production rows",
  );
  assert.match(
    PRIMITIVES_SOURCE,
    /dir="auto">\{to \|\| "—"\}/,
    "and its destination is to_label, Arabic-first in 19 of them",
  );
}
