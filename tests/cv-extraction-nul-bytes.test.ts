import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { withoutNulBytes } from "@/lib/recruitment/cv-extraction-fields";

// A CV whose text carries a NUL byte (U+0000) could never be read, and the failure was disguised.
//
// Postgres refuses U+0000 in `text` and `jsonb`, so persistCvExtraction's INSERT raised 22P05
// ("unsupported Unicode escape sequence"). That throw happens BEFORE the candidate write, so the
// read was lost whole: the candidate kept zero extraction rows, therefore stayed in the "never read
// by a model" target set permanently, and every re-run failed in the same place. A Postgres error
// object has no `name` and no `stack`, so the bulk re-read script printed
// `FAILED unexpected: [object Object]` and the cause could not be read from the log at all.
//
// Found on production 2026-09-04: one candidate out of 82, a 181 KB PDF that downloaded perfectly.
// There was no NUL sanitizer anywhere in the extraction path.
const extractionSource = readFileSync(
  new URL("../src/lib/recruitment/cv-extraction.ts", import.meta.url),
  "utf8",
);

// The real character, built from its code point so no editor or heredoc can eat it, and the escaped
// six-character form JSON.stringify actually emits for it.
const NUL = String.fromCharCode(0);
// Built from the character itself so no heredoc, editor or copy-paste can eat a backslash: this
// yields the six characters JSON.stringify actually emits. Writing the literal here is what failed.
const ESCAPED_NUL = JSON.stringify(NUL).slice(1, -1);

export function runCvExtractionNulByteTests() {
  const dirty = {
    currentEmployer: { value: "Alfa Medical" + NUL + " Group", confidence: "high" as const },
    professionalSummary: { value: NUL + "Fourteen years in pharma" + NUL, confidence: "high" as const },
    // A repeating block. The universal schema stores workHistory and friends as arrays of objects,
    // and a NUL inside an entry fails the insert exactly as a top-level one does.
    workHistory: {
      value: [{ company: "Averroes" + NUL + " Pharma", title: "District" + NUL + " Manager" }],
      confidence: "high" as const,
    },
    ["weird" + NUL + "Key"]: { value: "kept", confidence: "low" as const },
  };

  const cleaned = withoutNulBytes(dirty);

  // THE HEADLINE. Assert on the SERIALIZED form and on the ESCAPED sequence, because that is what
  // travels to Postgres and what it rejects. JSON.stringify never emits a literal U+0000 — it emits
  // the six characters \u0000 — so a check for the raw character alone can NEVER fire. This test was
  // written that way first, and only deliberately breaking the scrub revealed that the assertion was
  // unfirable. Keep both halves.
  const serialized = JSON.stringify(cleaned);
  assert.ok(
    !serialized.includes(ESCAPED_NUL) && !serialized.includes(NUL),
    "a NUL byte in an extracted value must not survive into the stored row — Postgres raises 22P05",
  );

  // The values themselves survive, minus the byte.
  assert.equal(cleaned.currentEmployer?.value, "Alfa Medical Group", "the employer keeps its text");
  assert.equal(
    cleaned.professionalSummary?.value,
    "Fourteen years in pharma",
    "a NUL at either end is stripped without trimming real text",
  );
  assert.deepEqual(
    cleaned.workHistory?.value,
    [{ company: "Averroes Pharma", title: "District Manager" }],
    "a repeating block is scrubbed entry by entry, keys and values alike",
  );
  assert.ok(cleaned.weirdKey, "a NUL inside a jsonb KEY is stripped too — a key is text as well");
  assert.equal(cleaned.currentEmployer?.confidence, "high", "confidence is carried through untouched");

  // Non-strings must pass through EXACTLY. `false` and 0 are real answers, and an empty array is an
  // honest "this CV lists none" — flattening any of them would be a silent data loss.
  const scalars = {
    hasMedicalRepExperience: { value: false, confidence: "high" as const },
    totalExperienceYears: { value: 0, confidence: "high" as const },
    graduationYear: { value: 2011, confidence: "high" as const },
    nationalId: { value: null, confidence: "low" as const },
    certifications: { value: [], confidence: "high" as const },
  };
  const passedThrough = withoutNulBytes(scalars);
  assert.equal(passedThrough.hasMedicalRepExperience?.value, false, "boolean false is an answer, not a blank");
  assert.equal(passedThrough.totalExperienceYears?.value, 0, "the number 0 is an answer, not a blank");
  assert.equal(passedThrough.graduationYear?.value, 2011, "a number survives the scrub");
  assert.equal(passedThrough.nationalId?.value, null, "null stays null");
  assert.deepEqual(passedThrough.certifications?.value, [], "an empty repeating block survives");

  // A clean object must come back equal — the scrub is never allowed to reshape ordinary input.
  const clean = { university: { value: "Cairo University", confidence: "high" as const } };
  assert.deepEqual(withoutNulBytes(clean), clean, "input with no NUL byte is returned unchanged");

  // Wiring: the guard has to sit on the statement that actually raises 22P05. cv-intake-service.ts
  // calls persistCvExtraction directly, so scrubbing only at the re-read call site would leave
  // inbound intake exposed to the identical failure.
  assert.ok(
    /extracted_fields:\s*withoutNulBytes\(/.test(extractionSource),
    "the extracted_fields INSERT must scrub NUL bytes — this is the statement that raises 22P05",
  );
  // And the candidate gap-fill writes the same values into text columns a moment later, so it needs
  // clean input too, not just the row.
  assert.ok(
    extractionSource.includes("fields: withoutNulBytes(rawExtraction.fields)"),
    "the re-read must scrub before the auto-apply write, not only before the row insert",
  );
}
