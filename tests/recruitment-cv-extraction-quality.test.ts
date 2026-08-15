import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CORE_CV_SIGNAL_KEYS,
  isThinCvRead,
  mergeCvExtractions,
  MIN_CORE_CV_SIGNALS,
  scoreCvExtraction,
} from "../src/lib/recruitment/cv-extraction-quality.ts";
import type { ExtractedCandidateFields } from "../src/lib/recruitment/cv-extraction-fields.ts";

const high = (value: unknown) => ({ confidence: "high" as const, value: value as never });
const low = (value: unknown) => ({ confidence: "low" as const, value: value as never });

// A read that plainly worked: the shape 177 of the production extractions have.
function goodRead(): ExtractedCandidateFields {
  return {
    currentJobTitle: high("Medical Representative"),
    degree: high("Bachelor of Pharmacy"),
    educationHistory: high([{ institution: "Cairo University" }]),
    email: high("mona@example.com"),
    fullName: high("Mona Abdelrahman"),
    phone: high("01001234567"),
    professionalSummary: high("Six years selling to hospital accounts across Greater Cairo."),
    university: high("Cairo University"),
    workHistory: high([{ employer: "Eva Pharma" }, { employer: "Amoun" }]),
  };
}

export function runRecruitmentCvExtractionQualityTests() {
  // --- scoreCvExtraction --------------------------------------------------------------------
  const good = scoreCvExtraction(goodRead());
  assert.equal(good.coreFilled, CORE_CV_SIGNAL_KEYS.length, "every core signal present");
  assert.equal(good.missingCore.length, 0);
  assert.equal(good.hasName, true);
  assert.equal(good.highConfidence, 9, "all nine came back high");

  // Empty string, whitespace, empty array and null are all "did not answer" — a model that
  // returns "" for every field must not score as a complete read.
  const blanks = scoreCvExtraction({
    degree: high(""),
    fullName: high("   "),
    university: high(null),
    workHistory: high([]),
  });
  assert.equal(blanks.filled, 0, "blank/empty/null values are not answers");
  assert.equal(blanks.coreFilled, 0);
  assert.equal(blanks.hasName, false);

  assert.equal(scoreCvExtraction(null).coreFilled, 0, "a null field map never throws");
  assert.equal(scoreCvExtraction(undefined).filled, 0, "an undefined field map never throws");
  assert.deepEqual(
    scoreCvExtraction({}).missingCore,
    [...CORE_CV_SIGNAL_KEYS],
    "missingCore names every core key, so a failure is readable without re-deriving it",
  );

  // A field the schema knows but the score does not treat as core still counts toward `filled`.
  const extras = scoreCvExtraction({ fullName: high("Ali Hassan"), militaryStatus: low("Exempted") });
  assert.equal(extras.filled, 2);
  assert.equal(extras.highConfidence, 1, "confidence is counted separately from presence");
  assert.equal(extras.coreFilled, 1, "militaryStatus is not a core signal");

  // --- isThinCvRead: the escalation rule ------------------------------------------------------
  assert.equal(isThinCvRead(good), false, "a complete read must NOT trigger a second AI call");

  // The exact shape of the failure this exists for: a name and nothing else. That is what the 49
  // unread production CVs look like once the sender's name is stamped on the candidate.
  assert.equal(
    isThinCvRead(scoreCvExtraction({ fullName: high("Osama Mohamed") })),
    true,
    "a name and nothing else is a failed read, not a candidate",
  );

  // No name at all fails on its own, however many other fields came back — every CV in existence
  // carries the applicant's name, so producing none means the document was not read.
  const namelessButFull = scoreCvExtraction({
    degree: high("BSc Pharmacy"),
    email: high("x@example.com"),
    phone: high("01000000000"),
    professionalSummary: high("Summary"),
    university: high("Ain Shams"),
  });
  assert.ok(namelessButFull.coreFilled >= MIN_CORE_CV_SIGNALS, "this fixture clears the count rule");
  assert.equal(isThinCvRead(namelessButFull), true, "no name is thin regardless of the other fields");

  // Exactly at the threshold is accepted — a one-page CV with no education section must not cost
  // a second call.
  const atThreshold = scoreCvExtraction({
    fullName: high("Nour Ibrahim"),
    phone: high("01100000000"),
    workHistory: high([{ employer: "Sanofi" }]),
  });
  assert.equal(atThreshold.coreFilled, MIN_CORE_CV_SIGNALS);
  assert.equal(isThinCvRead(atThreshold), false, "MIN_CORE_CV_SIGNALS is inclusive");

  // One below is not.
  assert.equal(
    isThinCvRead(scoreCvExtraction({ fullName: high("Nour Ibrahim"), phone: high("01100000000") })),
    true,
    "one under the threshold escalates",
  );

  // --- mergeCvExtractions ---------------------------------------------------------------------
  // The retry fills what the first pass missed...
  const merged = mergeCvExtractions(
    { email: low(null), fullName: high("Mona Abdelrahman"), linkedinUrl: low(null) },
    { email: high("mona@example.com"), fullName: high("MONA ABDELRAHMAN"), linkedinUrl: high("https://linkedin.com/in/mona") },
  );
  assert.equal(merged.email?.value, "mona@example.com", "a gap in the first pass is filled by the retry");
  assert.equal(merged.linkedinUrl?.value, "https://linkedin.com/in/mona");
  // ...but never overwrites an equally-confident answer the first pass already gave. The text
  // layer holds the candidate's own capitalisation; a re-render can flatten it.
  assert.equal(merged.fullName?.value, "Mona Abdelrahman", "a tie goes to the first pass");

  // Confidence beats order in both directions.
  assert.equal(
    mergeCvExtractions({ degree: low("Pharmacy") }, { degree: high("Bachelor of Pharmacy") }).degree?.value,
    "Bachelor of Pharmacy",
    "a high-confidence retry beats a low-confidence first pass",
  );
  assert.equal(
    mergeCvExtractions({ degree: high("Bachelor of Pharmacy") }, { degree: low("Pharmacy") }).degree?.value,
    "Bachelor of Pharmacy",
    "a low-confidence retry never displaces a high-confidence first pass",
  );

  // A longer repeating block wins outright: finding four jobs where the first pass found one means
  // the retry read the layout better, whatever it claims about its own confidence.
  const blocks = mergeCvExtractions(
    { workHistory: high([{ employer: "Eva Pharma" }]) },
    { workHistory: low([{ employer: "Eva Pharma" }, { employer: "Amoun" }, { employer: "Hikma" }]) },
  );
  assert.equal((blocks.workHistory?.value as unknown[]).length, 3, "the fuller block wins");
  assert.equal(
    (mergeCvExtractions({ skills: high([{ name: "Selling" }]) }, { skills: high([]) }).skills?.value as unknown[]).length,
    1,
    "an empty retry block never erases a populated one",
  );

  // The retry must never DELETE a value. This is the whole safety property of the escalation.
  const retryWentBlank = mergeCvExtractions(goodRead(), { email: low(null), fullName: low(null), phone: low(null) });
  assert.equal(retryWentBlank.email?.value, "mona@example.com");
  assert.equal(retryWentBlank.fullName?.value, "Mona Abdelrahman");
  assert.equal(retryWentBlank.phone?.value, "01001234567");
  assert.equal(
    isThinCvRead(scoreCvExtraction(retryWentBlank)),
    false,
    "a failed retry leaves the good first read intact, never degrades it",
  );

  // Keys present in only one side survive from either direction.
  const oneSided = mergeCvExtractions({ a: high("from primary") }, { b: high("from retry") });
  assert.equal(oneSided.a?.value, "from primary");
  assert.equal(oneSided.b?.value, "from retry");

  // --- The three source-level strengthenings ---------------------------------------------------
  const extractionSource = readFileSync(path.join(process.cwd(), "src/lib/recruitment/cv-extraction.ts"), "utf8");

  // 1. Hyperlinks. pdf-parse defaults parseHyperlinks to FALSE and getText() was called with no
  // arguments at all, so every /Annots link dictionary in every PDF CV was discarded — which is
  // why linkedinUrl came back 0 of 28 across the universal-schema extractions in production.
  assert.match(
    extractionSource,
    /parser\.getText\(\{[^}]*parseHyperlinks:\s*true/,
    "getText must ask for hyperlinks; without it the LinkedIn URL is structurally invisible",
  );

  // 2. Reasoning effort. The most accuracy-sensitive call in the module ran at the middle setting.
  assert.match(extractionSource, /reasoning:\s*\{\s*effort:\s*"high"\s*\}/, "CV extraction must reason at high effort");
  assert.doesNotMatch(extractionSource, /effort:\s*"medium"/, "no medium-effort extraction pass may remain");

  // 3. The escalation ladder: a thin text-layer read on a PDF gets a second, different attempt.
  assert.match(extractionSource, /const escalation: CvExtractionRoute \| null =/);
  assert.match(
    extractionSource,
    /route === "text" && fileKind === "pdf" && input\.bytes\.length <= MAX_PDF_VISION_BYTES \? "vision_pdf" : null/,
    "only a PDF read from its text layer has a genuinely different route to escalate to",
  );
  assert.match(
    extractionSource,
    /if \(!isThinCvRead\(score\) && primary\.isCv\) return primary/,
    "a credible read must return without paying for a second call",
  );
  assert.match(
    extractionSource,
    /catch \{\s*\n\s*return primary;/,
    "a failed escalation must fall back to the first read, never propagate",
  );
  assert.match(
    extractionSource,
    /if \(!escalation\) throw error;\s*\n\s*return await runPass\(escalation\);/,
    "a PDF whose first pass DIED gets the other route before we accept losing the applicant",
  );
  assert.match(extractionSource, /fields: mergeCvExtractions\(primary\.fields, retry\.fields\)/);

  // --- The recorded intake failure --------------------------------------------------------------
  // Production had 226 candidates, 177 extractions and 0 intake errors: 49 CVs were never read and
  // every surface reported success. The catch stays fail-open — but it must no longer be silent.
  const intakeSource = readFileSync(
    path.join(process.cwd(), "src/lib/recruitment/inbound/cv-intake-service.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    intakeSource,
    /\}\s*catch\s*\{\s*\n\s*\/\* best-effort — fail open \(proceed without the gate or the fields\) \*\/\s*\n\s*\}/,
    "the empty catch that lost 49 CVs must not come back",
  );
  assert.match(intakeSource, /event:\s*"inbound_cv_extraction_failed"/, "a failed read must reach the error monitor");
  assert.match(
    intakeSource,
    /errorMessage: extractionError,/,
    "the reason must land on the intake event row Inbound Intake Health already renders",
  );

  // --- The prompt rules the measurements bought -------------------------------------------------
  const schemaSource = readFileSync(path.join(process.cwd(), "src/lib/recruitment/cv-field-schemas.ts"), "utf8");
  assert.match(schemaSource, /11\. HOW THE DOCUMENT REACHES YOU[\s\S]*two columns interleaved/);
  assert.match(schemaSource, /Never pair an employer with a date range merely because the two lines are next to each other/);
  assert.match(schemaSource, /12\. LINKS ARRIVE AS MARKDOWN[\s\S]*\[visible text\]\(destination-url\)/);
  assert.match(schemaSource, /13\. DERIVED VALUES ARE STILL VALUES[\s\S]*yearsExperience/);
  assert.match(
    schemaSource,
    /a "low" is treated downstream as though you had not answered/,
    "the prompt must say WHY hedging costs the value — 26 of 28 yearsExperience came back low",
  );
  assert.match(schemaSource, /14\. ARABIC AND BILINGUAL CVs[\s\S]*never a reason to return an empty extraction/);
  assert.match(schemaSource, /15\. WHEN THE CV LISTS SEVERAL CONTACT NUMBERS[\s\S]*not a referee's number/);
}
