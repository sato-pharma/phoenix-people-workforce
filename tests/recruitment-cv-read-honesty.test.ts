// Recruitment / ATS — a read that produced NOTHING must never be reported as a read.
//
// The incident this pins, 2026-08-21: scripts/recruitment-reread-never-read-cvs.ts was run over 23
// WhatsApp photo CVs. Every one came back from the model with every scalar null and five empty
// arrays — skills, languages, workHistory, educationHistory, certifications. The per-candidate
// counter tested emptiness with `value === ""`, which an empty ARRAY does not satisfy, so each of
// the 23 printed "-> READ 5 fields (5 high)" and the run summarised as "Read: 23, Failed: 0".
//
// A total failure was reported as a total success. The only honest lines on screen were
// "Names found 0/23", "Phones found 0/23" and "Applied-for 0/23" — and two of those three were
// themselves reading snake_case keys off a camelCase record, so they could only ever print 0 and
// were dismissed as a known reporting bug. On the strength of "Failed: 0" the 23 rows were then
// deleted from production.
//
// Two invariants, and the second is what makes the first survivable:
//   1. an empty array (and a blank/whitespace string) is NOT a field with a value; and
//   2. "the call returned but produced nothing" is its own reported outcome, so a summary line
//      reading "Failed: 0" can never again be read as "everything was extracted".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ExtractedCandidateFields } from "../src/lib/recruitment/cv-extraction-fields.ts";
import { isEmptyExtractedField } from "../src/lib/recruitment/cv-extraction-fields.ts";
import { describeCvRead, scoreCvExtraction } from "../src/lib/recruitment/cv-extraction-quality.ts";

const high = (value: unknown) => ({ confidence: "high" as const, value: value as never });
const low = (value: unknown) => ({ confidence: "low" as const, value: value as never });

// The exact shape the 23 photo CVs came back in. Note every array is confidence "high": the model
// was confident there were no skills listed, which is an honest thing to STORE and not remotely a
// field with a value.
function nothingWasRead(): ExtractedCandidateFields {
  return {
    certifications: high([]),
    currentEmployer: high(null),
    currentJobTitle: high(null),
    educationHistory: high([]),
    email: high(null),
    fullName: high(null),
    languages: high([]),
    phone: high(null),
    skills: high([]),
    workHistory: high([]),
  };
}

export function runRecruitmentCvReadHonestyTests() {
  // --- 1. Five empty arrays are five non-answers, not five fields ------------------------------
  const outcome = describeCvRead(nothingWasRead());
  assert.equal(
    outcome.fieldsWithAValue,
    0,
    "an extraction whose only populated keys are EMPTY ARRAYS holds nothing — this counter reported 'READ 5 fields (5 high)' for 23 CVs that were empty",
  );
  assert.equal(outcome.fieldsHighConfidence, 0, "a confidently-empty array is still an empty array");

  // --- 2. ...and it is not REPORTED as a read either -------------------------------------------
  assert.notEqual(
    outcome.status,
    "read",
    "a read that produced no usable value must never be counted or reported as READ — that is what made a complete failure print as a complete success",
  );
  assert.equal(
    outcome.status,
    "empty",
    "it gets its own outcome so the summary can print it on its own line; 'Failed: 0' must not be able to mean 'nothing was extracted'",
  );

  // Blank and whitespace-only strings go the same way — a model that answers "" or "   " for every
  // field has not read the document.
  assert.equal(describeCvRead({ fullName: high(""), phone: high("   ") }).status, "empty");
  assert.equal(describeCvRead({}).status, "empty", "no fields at all is empty, not read");
  assert.equal(describeCvRead(null).status, "empty", "a null field map never throws and is never a read");
  assert.equal(describeCvRead(undefined).fieldsWithAValue, 0);

  // --- 3. The correction must not swing the other way ------------------------------------------
  // One real value is enough to make it a read, and the count is of REAL values only.
  const oneReal = describeCvRead({ ...nothingWasRead(), workHistory: high([{ employer: "Eva Pharma" }]) });
  assert.equal(oneReal.status, "read", "one populated repeating block is a read");
  assert.equal(oneReal.fieldsWithAValue, 1, "the nine blanks around it still count for nothing");

  // A boolean false and a numeric 0 ARE answers ("no medical rep experience", "0 years of it") and
  // must keep counting — the fix is about emptiness, not about falsiness.
  const falsy = describeCvRead({ hasMedicalRepExperience: high(false), yearsExperience: low(0) });
  assert.equal(falsy.fieldsWithAValue, 2, "false and 0 are findings, not blanks");
  assert.equal(falsy.status, "read");
  assert.equal(falsy.fieldsHighConfidence, 1, "confidence is counted separately from presence");

  // --- 4. One shared predicate, agreeing with the score ----------------------------------------
  assert.equal(isEmptyExtractedField(high([])), true, "the empty repeating block — the case that cost the 23 CVs");
  assert.equal(isEmptyExtractedField(high("   ")), true);
  assert.equal(isEmptyExtractedField(high("")), true);
  assert.equal(isEmptyExtractedField(high(null)), true);
  assert.equal(isEmptyExtractedField(undefined), true);
  assert.equal(isEmptyExtractedField(high([{ employer: "Amoun" }])), false);
  assert.equal(isEmptyExtractedField(high("Mona Abdelrahman")), false);
  assert.equal(isEmptyExtractedField(high(false)), false, "a boolean answer is an answer");
  assert.equal(isEmptyExtractedField(low(0)), false, "zero is an answer");

  assert.equal(
    scoreCvExtraction(nothingWasRead()).filled,
    0,
    "describeCvRead and scoreCvExtraction must agree — they share one emptiness rule by construction",
  );

  // --- 5. The script actually reports it -------------------------------------------------------
  // The counter lives in src/lib now, but the reporting is the half the owner reads at 4am, and a
  // correct predicate wired to a summary that still prints only Read/Failed fixes nothing.
  const scriptSource = readFileSync(path.join(process.cwd(), "scripts/recruitment-reread-never-read-cvs.ts"), "utf8");
  assert.match(
    scriptSource,
    /status: "read" \| "empty" \| "failed"/,
    "empty must be a third outcome, not a flavour of read",
  );
  assert.match(
    scriptSource,
    /const outcome = describeCvRead\(fields\)/,
    "the script must take the shared count, not re-derive one — a second opinion about 'has a value' is the whole defect",
  );
  assert.match(scriptSource, /->  EMPTY/, "an empty read must be visible per candidate, not only in the totals");
  assert.match(
    scriptSource,
    /console\.log\(`Empty  : \$\{empty\.length\}/,
    "the empty count must have its own summary line, beside Read and above Failed",
  );
  assert.doesNotMatch(
    scriptSource,
    /value === null \|\| value === undefined \|\| value === ""/,
    "the hand-rolled emptiness check that could not see an empty array must not come back",
  );
  assert.doesNotMatch(
    scriptSource,
    /keyFields\?\.full_name|keyFields\?\.applied_for_job_title/,
    "the summary counters read a camelCase record — snake_case keys there can only ever print 0",
  );

  // --- 6. Still exactly one definition of "did not answer" -------------------------------------
  const mergeSource = readFileSync(path.join(process.cwd(), "src/lib/recruitment/cv-extraction-merge.ts"), "utf8");
  assert.doesNotMatch(
    mergeSource,
    /function isEmpty\(/,
    "the merge policy must import the shared predicate, not keep a private copy that can drift",
  );
  const qualitySource = readFileSync(path.join(process.cwd(), "src/lib/recruitment/cv-extraction-quality.ts"), "utf8");
  assert.match(
    qualitySource,
    /return !isEmptyExtractedField\(field\);/,
    "hasValue must delegate to the same rule; two hand-written copies is how a counter and a merge come to disagree",
  );
}
