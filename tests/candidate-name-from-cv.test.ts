import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isInstitutionName,
  isTrustworthyExtractedName,
  personNameFromFileName,
  resolveCandidateFullNameFromCv,
} from "../src/lib/recruitment/candidate-name-from-cv.ts";

/**
 * Pins the one write in CV intake that had no confidence gate.
 *
 * Live on production 2026-08-24, candidate 097778c9-eb46-4942-a95a-a3ba3e4c1090:
 *
 *   full_name          = "Suez Canal University Engineering Department"
 *   extracted fullName = { value: <same>, confidence: "low" }
 *   applied_fields     = null           <- every LATER write honoured the confidence gate
 *   cv file            = "Karim _Nabil _CV (2).pdf"
 *
 * The name was written at candidate CREATION, which took the extracted value unconditionally. The
 * fix reads the same `confidence` every other write reads, and falls back to the CV's own filename
 * rather than to the sender — for a bulk forward the sender is the forwarder.
 */
export function runCandidateNameFromCvTests() {
  // ---------------------------------------------------------------------------
  // The headline: the exact row that was in production.
  // ---------------------------------------------------------------------------
  assert.equal(
    resolveCandidateFullNameFromCv({
      extractedConfidence: "low",
      extractedName: "Suez Canal University Engineering Department",
      fileName: "Karim _Nabil _CV (2).pdf",
      senderFullName: "Ahmed Forwarder",
    }),
    "Karim Nabil",
    "a low-confidence institution name must never become a candidate's name",
  );

  // ---------------------------------------------------------------------------
  // Both gates, independently.
  // ---------------------------------------------------------------------------
  assert.equal(
    isTrustworthyExtractedName("Mona Salah", "low"),
    false,
    "low confidence alone disqualifies a name, however person-shaped it looks",
  );
  assert.equal(
    isTrustworthyExtractedName("Cairo University Faculty of Pharmacy", "high"),
    false,
    "an institution is not a person at ANY confidence",
  );
  assert.equal(isTrustworthyExtractedName("Mona Salah", "high"), true, "a sure, person-shaped name is written as-is");
  assert.equal(isTrustworthyExtractedName("", "high"), false, "an empty name is not a name");
  assert.equal(isTrustworthyExtractedName(null, null), false, "a missing name is not a name");

  // The institution check must be WHOLE-WORD and case-insensitive. The first cut of this built the
  // pattern with `new RegExp(...)` inside a TEMPLATE LITERAL, where a lone backslash-b is the
  // BACKSPACE character rather than a word boundary — it compiled, ran, and matched nothing at all.
  assert.equal(isInstitutionName("Suez Canal University Engineering Department"), true);
  assert.equal(isInstitutionName("cairo university"), true, "matching is case-insensitive");
  assert.equal(isInstitutionName("Ain Shams FACULTY of Medicine"), true, "matching is case-insensitive");
  assert.equal(isInstitutionName("Mona Salah"), false, "an ordinary name is not an institution");
  assert.equal(isInstitutionName("Universally Loved"), false, "matching is whole-word, not substring");
  assert.equal(isInstitutionName(""), false);
  assert.equal(isInstitutionName(null), false);

  // ---------------------------------------------------------------------------
  // The filename fallback: conservative, and allowed to refuse.
  // ---------------------------------------------------------------------------
  assert.equal(personNameFromFileName("Karim _Nabil _CV (2).pdf"), "Karim Nabil", "underscores, CV token, (2) marker");
  assert.equal(personNameFromFileName("Ahmed_Hassan_CV.pdf"), "Ahmed Hassan");
  assert.equal(personNameFromFileName("mona-salah-resume.docx"), "mona salah");
  assert.equal(personNameFromFileName("Default Resume.pdf"), null, "one word left is not a name");
  assert.equal(personNameFromFileName("Cv.pdf"), null, "nothing left at all");
  assert.equal(personNameFromFileName("01012345678 CV.pdf"), null, "a phone number means this is not a name");
  assert.equal(personNameFromFileName(""), null);
  assert.equal(personNameFromFileName(null), null);

  // ---------------------------------------------------------------------------
  // The order of preference, end to end.
  // ---------------------------------------------------------------------------
  assert.equal(
    resolveCandidateFullNameFromCv({
      extractedConfidence: "high",
      extractedName: "Mona Salah",
      fileName: "Ahmed_Hassan_CV.pdf",
      senderFullName: "Someone Else",
    }),
    "Mona Salah",
    "a trustworthy extracted name outranks the filename",
  );
  assert.equal(
    resolveCandidateFullNameFromCv({
      extractedConfidence: "high",
      extractedName: "Cairo University Faculty",
      fileName: "Cv.pdf",
      senderFullName: "Direct Applicant",
    }),
    "Direct Applicant",
    "with no usable filename an institution falls back to the sender, not to itself",
  );

  // The behaviour that must NOT change: an extraction that produced no name at all still falls
  // straight through to the sender, exactly as it did before this module existed.
  assert.equal(
    resolveCandidateFullNameFromCv({
      extractedConfidence: null,
      extractedName: null,
      fileName: "whatever.pdf",
      senderFullName: "Direct Applicant",
    }),
    "Direct Applicant",
    "a blank extraction still falls back to the sender",
  );

  // full_name is NOT NULL, so something must always come out. A bad name a recruiter can see and
  // correct beats a failed intake that drops the CV on the floor.
  assert.equal(
    resolveCandidateFullNameFromCv({
      extractedConfidence: "low",
      extractedName: "Some University Department",
      fileName: "Cv.pdf",
      senderFullName: "",
    }),
    "Some University Department",
    "with no filename and no sender, the last resort is still a non-empty string",
  );
  assert.notEqual(
    resolveCandidateFullNameFromCv({
      extractedConfidence: "low",
      extractedName: "Some University Department",
      fileName: "Cv.pdf",
      senderFullName: "",
    }),
    "",
    "the resolver must never return an empty name for a NOT NULL column",
  );

  // ---------------------------------------------------------------------------
  // The call site: intake must actually hand the filename over, or none of the above runs.
  // ---------------------------------------------------------------------------
  const intake = readFileSync("src/lib/recruitment/inbound/cv-intake-service.ts", "utf8");
  assert.ok(
    /candidateIdentityFromCvFields\([\s\S]{0,200}?input\.attachment\.fileName/.test(intake),
    "cv-intake-service must pass the attachment filename into candidateIdentityFromCvFields",
  );

  const extraction = readFileSync("src/lib/recruitment/cv-extraction.ts", "utf8");
  assert.ok(
    /resolveCandidateFullNameFromCv/.test(extraction),
    "candidateIdentityFromCvFields must resolve the name through the confidence gate",
  );
  assert.ok(
    !/fullName:\s*read\("fullName"\)\s*\?\?\s*fallbackFullName/.test(extraction),
    "the old unconditional `read(\"fullName\") ?? fallbackFullName` must not come back",
  );
}
