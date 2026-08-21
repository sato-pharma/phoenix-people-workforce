import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  isRuleOnlyExtractionModel,
  OCR_EXTRACTION_MODEL,
  RULE_ONLY_EXTRACTION_MODEL,
} from "../src/lib/recruitment/cv-extraction.ts";
import type { StoredCvExtraction } from "../src/lib/recruitment/cv-extraction-fields.ts";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

// The model already answers "is this even a CV?" on the same structured-output call that extracts
// the fields, and inbound intake already acts on it. What it did NOT do until 2026-08-21 was write
// the answer down, so every path that meets an extraction later — the review board, a bulk re-read,
// and above all the ops scripts that build candidates from files that already exist — had to guess.
// scripts/recruitment-split-forwarded-candidates.ts guessed by re-asserting the extracted NAME, and
// a doctor's prescription has a name printed on it, so it became a candidate.
//
// Two invariants hold this shut, and they pull in opposite directions on purpose:
//   1. the judgement is PERSISTED, so it can be asked for later;
//   2. it is read as FAIL-OPEN — only an explicit false blocks anything.
// Drop (1) and the hole reopens silently. Drop (2) and every extraction written before the column
// existed reads as "not a CV", which would throw away real applicants — much worse than the bug.
export function runRecruitmentExtractionRecordsIsCvTests() {
  const engine = read("src/lib/recruitment/cv-extraction.ts");

  // --- 1. the judgement is written down -------------------------------------
  const persist = engine.slice(
    engine.indexOf("export async function persistCvExtraction"),
    engine.indexOf("export async function extractCandidateFieldsFromCv"),
  );
  assert.ok(persist.length > 0, "persistCvExtraction must exist — it is the only write site for an extraction row");
  assert.match(
    persist,
    /is_cv:\s*isRuleOnlyExtractionModel\(input\.extraction\.model\)\s*\?\s*null\s*:\s*input\.extraction\.isCv/,
    "persistCvExtraction must store the model's judgement — and ONLY the model's. A judgement that is not written down is one nothing downstream can ever ask for; one that was never made must not be written down as though it were",
  );

  // --- 2. and read back, with anything non-boolean meaning "unknown" ---------
  const readBack = engine.slice(
    engine.indexOf("export async function getLatestCvExtraction"),
    engine.indexOf("export async function persistCvExtraction"),
  );
  assert.ok(readBack.length > 0, "getLatestCvExtraction must exist");
  assert.match(
    readBack,
    /\.select\("[^"]*\bis_cv\b[^"]*"\)/,
    "getLatestCvExtraction must select is_cv — a column no reader asks for is the same as no column",
  );
  assert.match(
    readBack,
    /isCv:\s*typeof row\.is_cv === "boolean" \? row\.is_cv : null/,
    "a row written before the column existed, or hand-edited, must read as null (unknown) rather than being coerced into a verdict",
  );

  // The type has to carry the third state, or every consumer collapses it to a boolean on arrival.
  const stored: StoredCvExtraction = {
    createdAt: null,
    extractionId: "x",
    fields: {},
    isCv: null,
    model: null,
    positionKey: "medical_rep",
    reviewed: false,
  };
  assert.equal(stored.isCv, null, "StoredCvExtraction.isCv must admit null — 'nobody judged' is not 'not a CV'");

  // --- 3. the bypass path asks the question ---------------------------------
  //
  // This script creates candidates out of files that already exist, so it never passes through the
  // inbound intake gate at all. It is the path the prescription came in on.
  const split = read("scripts/recruitment-split-forwarded-candidates.ts");
  assert.match(
    split,
    /\.select\("[^"]*\bis_cv\b[^"]*"\)/,
    "the split script must fetch is_cv alongside the fields it promotes into a candidate",
  );
  assert.match(
    split,
    /extraction\.is_cv === false/,
    "the split script must refuse a file the read judged not to be a CV — checking the extracted name only re-asserts that a letterhead still says the same name",
  );

  // --- 4. fail open, everywhere ---------------------------------------------
  for (const [label, source] of [
    ["the split script", split],
    ["inbound intake", read("src/lib/recruitment/inbound/cv-intake-service.ts")],
  ] as const) {
    assert.doesNotMatch(
      source,
      /if \(!\w*[eE]xtraction\.is_?[cC]v\)/,
      `${label} must gate on an EXPLICIT false, never on a falsy is_cv — null means no judgement was recorded, and treating that as "not a CV" discards real applicants`,
    );
  }
  assert.match(
    read("src/lib/recruitment/inbound/cv-intake-service.ts"),
    /extraction\.isCv === false/,
    "the existing intake gate keeps its explicit-false shape — it has suppressed 43 attachments in production and must not tighten into a fail-closed check",
  );

  // --- 5. the column is nullable, and nothing was invented for old rows ------
  const migrations = path.join(process.cwd(), "supabase", "migrations");
  const migrationName = readdirSync(migrations).find((f) => f.includes("ats_extraction_records_is_cv"));
  assert.ok(migrationName, "the is_cv column needs a migration file — Railway applies none, so this is also the record of what to apply");
  const migration = read(path.join("supabase", "migrations", migrationName));
  // Match the STATEMENTS, not the whole file. Migrations here carry long `--` rationale headers, and
  // this one's necessarily contains the words "default" and "backfill" while explaining why it has
  // neither — matching raw text fails on the explanation while still passing a real `default false`
  // in a comment-free file, i.e. exactly backwards.
  const ddl = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.match(
    ddl,
    /add column if not exists is_cv boolean;/,
    "nullable boolean, no NOT NULL — the pre-existing rows genuinely have no answer",
  );
  assert.doesNotMatch(
    ddl,
    /\bdefault\b/i,
    "no default: a default would stamp a verdict onto every historic row that nobody ever made",
  );
  assert.doesNotMatch(
    ddl,
    /update\s+public\.ats_candidate_cv_extractions/i,
    "no backfill: the model's answer for those rows is gone, and inventing one is worse than admitting it is unknown",
  );

  // --- 6. a read no model saw stores NULL, never a fabricated "yes" ----------
  //
  // Both free routes reach persistCvExtraction claiming the document IS a CV without a model having
  // looked at it: ruleOnly() is returned only on the rule engine's own `isCv === true` branch, and
  // the OCR path hard-codes `isCv: true`. Storing that claim is what made the section-3 guard
  // unfirable — measured on production 2026-08-21, 104 of 173 rows from a single re-read were
  // rules-only and every one asserted is_cv=true, so `is_cv === false` could never fire on them.
  assert.equal(
    isRuleOnlyExtractionModel(RULE_ONLY_EXTRACTION_MODEL),
    true,
    "a rules-only read never reaches a model, so it has no judgement to store",
  );
  assert.equal(
    isRuleOnlyExtractionModel(OCR_EXTRACTION_MODEL),
    true,
    "the OCR path reads pixels with Tesseract and re-runs the rules — still no model, still no judgement",
  );
  assert.equal(
    isRuleOnlyExtractionModel("gpt-5.4"),
    false,
    "a plain model read is a real judgement and must be stored as the boolean it is",
  );
  // The one that a lazier predicate gets wrong. `<model>+rules` is written when BOTH engines
  // contributed — the model was asked, it just started from the rules' fields — so its answer is
  // genuine. A `model.includes("rules")` check would throw away every escalated read's verdict,
  // which is 69 of the 173 rows above and the only ones whose judgement was ever worth anything.
  assert.equal(
    isRuleOnlyExtractionModel("gpt-5.4+rules"),
    false,
    "the `<model>+rules` form means the model DID answer — do not match on the substring 'rules'",
  );
}
