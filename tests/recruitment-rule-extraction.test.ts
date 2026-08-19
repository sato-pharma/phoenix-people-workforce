import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { mergeRuleAndAiExtractions, shouldEscalateToAi } from "../src/lib/recruitment/cv-extraction-merge.ts";
import type { ExtractedCandidateFields } from "../src/lib/recruitment/cv-extraction-fields.ts";
import { runRuleCvExtraction } from "../src/lib/recruitment/rule-extraction/index.ts";
import {
  looksLigatureCorrupted,
  looksShredded,
  normalizeCvText,
  repairLigatures,
  repairShreddedText,
} from "../src/lib/recruitment/rule-extraction/normalize.ts";
import {
  decodeEgyptianNationalId,
  findEgyptianMobiles,
  findEmails,
  findLinkedInUrl,
  normalizeEgyptianMobile,
  parseDateRange,
} from "../src/lib/recruitment/rule-extraction/patterns.ts";
import { resolveGovernorate, parseFullDate, readLabelledValue } from "../src/lib/recruitment/rule-extraction/personal.ts";
import { classifyHeading, sliceCvSections } from "../src/lib/recruitment/rule-extraction/sections.ts";
import { splitTitleAndEmployer } from "../src/lib/recruitment/rule-extraction/work.ts";

const high = (value: unknown) => ({ confidence: "high" as const, value: value as never });
const low = (value: unknown) => ({ confidence: "low" as const, value: value as never });

// A realistic Egyptian HR CV, carrying the exact defects the real careers inbox produces:
// a Wingdings bullet (U+F0B7) in front of the personal block, a district rather than a
// governorate, and several labels packed onto one line.
const SAMPLE_CV = `ABDALLAH GAMAL
Human Resources Operations Specialist
Nasr City, Cairo | +20 10 1082 3473 | aeltoukhy832@gmail.com
https://www.linkedin.com/in/abdallah-gamal-1234

PROFESSIONAL SUMMARY
HR Operations professional with 5 years of experience across recruitment, employee relations and
the full employee lifecycle in retail and manufacturing environments.

EXPERIENCE
Senior HR Operations Specialist — Kazyon Egypt   Jan 2023 - Present
• Manage the full recruitment cycle in coordination with hiring managers.
• Administer medical insurance enrollment and claims for employees.
HR Specialist — Delta Lighting Egypt   Mar 2020 - Dec 2022
• Prepared employment contracts and maintained personnel records.

EDUCATION
Bachelor of Commerce, Faculty of Commerce, Cairo University, 2019
Grade: Very Good

SKILLS
Recruitment • Payroll Processing • Employee Relations • MS Office

LANGUAGES
Arabic: Native
English: Very Good

PERSONAL INFORMATION
\u{f0b7} Date of Birth: 23/8/1997 | Marital Status: Single | Military Status: Exempted
\u{f0b7} Nationality: Egyptian
`;

function runNormalizationTests() {
  // Ligature corruption is repaired only when the document proves it is corrupted.
  const broken = "HR OperaBons professional managing aUendance and ]eld sta` daily.";
  assert.equal(looksLigatureCorrupted(broken), true);
  const fixed = repairLigatures(broken);
  assert.match(fixed, /Operations/);
  assert.match(fixed, /attendance/);
  assert.match(fixed, /field/);
  assert.match(fixed, /staff/);

  // A clean document must come back byte-for-byte identical — the guard against a repair that
  // corrupts 126 good CVs in order to fix 2 bad ones.
  const clean = "HR Operations professional. Bachelor of Commerce. Attendance and payroll.";
  assert.equal(looksLigatureCorrupted(clean), false);
  assert.equal(repairLigatures(clean), clean);

  // A shredded text layer (one syllable per tab) is rejoined; a normally tabbed CV is not.
  const shredded = Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? "ab" : "cd")).join("\t");
  assert.equal(looksShredded(shredded), true);
  assert.equal(repairShreddedText(shredded).includes("\t"), false);
  const tabbedCv = "Senior HR Specialist — Kazyon Egypt\tJan 2023 - Present\nHR Specialist — Delta\tMar 2020 - Dec 2022";
  assert.equal(looksShredded(tabbedCv), false);
  assert.equal(repairShreddedText(tabbedCv), tabbedCv);

  // An email split across a line break is rejoined; unrelated lines are not.
  const wrapped = normalizeCvText("abanoubemadeskander@gmail.co\nm\nCairo");
  assert.match(wrapped.text, /abanoubemadeskander@gmail\.com/);

  // A markdown hyperlink keeps the URL, which is the half that is not truncated.
  const linked = normalizeCvText("[https://www.linkedin.com/in/aban](https://www.linkedin.com/in/abanoub-emad-eskander-362434244)");
  assert.match(linked.text, /abanoub-emad-eskander-362434244/);

  // Arabic-Indic digits become ASCII so a phone rule can read them.
  assert.match(normalizeCvText("\u{664}\u{665}").text, /45/);
}

function runPatternTests() {
  // The newline bug: the phone scanner must stop at the end of the line. When \s was in its
  // separator class it ran on into whatever followed, and the contact block of a CV is followed by
  // an education line far more often than by anything else.
  //
  // This input is chosen to be SHARP. The obvious case ("01044971766\n3 El Salam, Giza") does not
  // test anything: only one stray digit gets absorbed, and the rescue scan — which tolerates two
  // leftover digits so it can strip a country code — puts the number back, so the assertion passes
  // whether the scanner stops at the newline or not. A following year range leaves eight leftover
  // digits, which the rescue correctly refuses, and the number is lost outright.
  assert.deepEqual(findEgyptianMobiles("Mobile: 01044971766\n2015 - 2019  Faculty of Pharmacy"), ["01044971766"]);
  // The same CV read the naive way, kept as documentation of why the two mechanisms are separate:
  // one stray digit IS still rescued, so this case survives either way.
  assert.deepEqual(findEgyptianMobiles("01044971766\n3 El Salam, Giza"), ["01044971766"]);

  // Every country-code spelling in the corpus normalizes to one canonical form.
  for (const written of ["01012345678", "+201012345678", "00201012345678", "+20 10 1234 5678", "(+02)01012345678"]) {
    assert.equal(normalizeEgyptianMobile(written.replace(/[^\d+]/g, "")), "01012345678", `failed on ${written}`);
  }
  // Two numbers printed back to back are both recovered.
  assert.deepEqual(findEgyptianMobiles("Phone: 01276131496-01014407346."), ["01276131496", "01014407346"]);
  // A landline and a random long number are not mobiles.
  assert.deepEqual(findEgyptianMobiles("Tel: 0223456789 ref 123456789012345"), []);

  // Emails: job-board domains are not the candidate's address.
  assert.deepEqual(findEmails("mail me at Mona.Ali@Example-Co.com."), ["mona.ali@example-co.com"]);
  assert.deepEqual(findEmails("apply via noreply@wuzzuf.net"), []);

  // LinkedIn prefers the longest match — the truncated label sits beside the real URL.
  assert.equal(
    findLinkedInUrl("linkedin.com/in/aban https://www.linkedin.com/in/abanoub-emad-eskander-362434244"),
    "https://www.linkedin.com/in/abanoub-emad-eskander-362434244",
  );

  // National ID decodes birth date, sex and birth governorate; junk is rejected.
  const decoded = decodeEgyptianNationalId("29708231301234");
  assert.ok(decoded, "a valid national ID should decode");
  assert.equal(decoded.dateOfBirth, "1997-08-23");
  assert.equal(decoded.birthGovernorate, "Sharqia");
  assert.equal(decoded.gender, "Male");
  assert.equal(decodeEgyptianNationalId("12345678901234"), null);
  // A real-looking ID whose date is impossible must not decode.
  assert.equal(decodeEgyptianNationalId("29713451301234"), null);

  // Date ranges, in the styles the corpus actually uses.
  const current = parseDateRange("Senior HR Specialist — Kazyon  Jan 2023 - Present");
  assert.ok(current);
  assert.equal(current.isCurrent, true);
  assert.equal(current.from.year, 2023);
  assert.equal(current.from.month, 1);
  const closed = parseDateRange("2019 - 2022");
  assert.ok(closed);
  assert.equal(closed.isCurrent, false);
  assert.equal(closed.to?.year, 2022);
  // A backwards range is a misread, not a job.
  assert.equal(parseDateRange("2022 - 2019"), null);
}

function runSectionTests() {
  assert.equal(classifyHeading("EDUCATION"), "education");
  assert.equal(classifyHeading("Work Experience:"), "experience");
  assert.equal(classifyHeading("PROFESSIONAL SUMMARY"), "summary");
  assert.equal(classifyHeading("اللغات"), "languages");
  // A sentence containing a heading word is not a heading.
  assert.equal(classifyHeading("I have experience in payroll and recruitment across many teams"), null);
  assert.equal(classifyHeading(""), null);

  const sections = sliceCvSections(["Mona Ali", "Cairo", "EDUCATION", "Cairo University", "SKILLS", "Excel"]);
  // Everything above the first heading is the synthetic header block.
  assert.equal(sections[0]?.kind, "header");
  assert.deepEqual([...(sections[0]?.lines ?? [])], ["Mona Ali", "Cairo"]);
  assert.equal(sections[1]?.kind, "education");
  assert.deepEqual([...(sections[1]?.lines ?? [])], ["Cairo University"]);
}

function runPersonalTests() {
  // The bug this pins: several labels packed onto one line must not swallow each other.
  const packed = ["Date of Birth: August 23, 1997 | Marital Status: Single | Military Status: Exempted"];
  assert.equal(readLabelledValue(packed, ["marital status"]), "Single");
  assert.equal(readLabelledValue(packed, ["military status"]), "Exempted");
  assert.equal(readLabelledValue(packed, ["date of birth"]), "August 23, 1997");
  // A label alone on its line takes the following line as its value.
  assert.equal(readLabelledValue(["Marital Status", "Married"], ["marital status"]), "Married");
  // A bare word without a separator is not a labelled value.
  assert.equal(readLabelledValue(["He completed his military service in 2019"], ["military"]), null);

  // Day-first for Egypt; unambiguous when the day exceeds 12.
  assert.equal(parseFullDate("23/8/1997")?.iso, "1997-08-23");
  assert.equal(parseFullDate("23/8/1997")?.ambiguous, false);
  assert.equal(parseFullDate("5/6/1996")?.ambiguous, true);
  assert.equal(parseFullDate("August 23, 1997")?.iso, "1997-08-23");
  // A birth date nobody could have is rejected.
  assert.equal(parseFullDate("23/8/1890"), null);

  // District-first resolution — the three that are routinely got wrong.
  assert.equal(resolveGovernorate("Nasr City, Cairo")?.governorate, "Cairo");
  assert.equal(resolveGovernorate("6th of October")?.governorate, "Giza");
  assert.equal(resolveGovernorate("10th of Ramadan City")?.governorate, "Sharqia");
  assert.equal(resolveGovernorate("El Khanka")?.governorate, "Qalyubia");
  assert.equal(resolveGovernorate("nowhere in particular"), null);
}

function runWorkTests() {
  // Which half is the title is decided by vocabulary, not by position.
  assert.deepEqual(splitTitleAndEmployer("Senior HR Specialist — Kazyon Egypt"), {
    employer: "Kazyon Egypt",
    jobTitle: "Senior HR Specialist",
  });
  assert.deepEqual(splitTitleAndEmployer("Kazyon Egypt / HR Specialist"), {
    employer: "Kazyon Egypt",
    jobTitle: "HR Specialist",
  });
}

function runEndToEndTests() {
  const result = runRuleCvExtraction(SAMPLE_CV, {
    senderEmail: "aeltoukhy832@gmail.com",
    senderName: "Abdallah Gamal",
    subject: "Application for Personnel & Recruitment Specialist",
  });

  assert.equal(result.isCv, true);

  // Contact details — the fields the rule engine owns outright.
  assert.equal(result.fields.email?.value, "aeltoukhy832@gmail.com");
  assert.equal(result.fields.email?.confidence, "high");
  assert.equal(result.fields.phone?.value, "01010823473");
  assert.equal(result.fields.phone?.confidence, "high");
  assert.equal(result.fields.linkedinUrl?.value, "https://www.linkedin.com/in/abdallah-gamal-1234");
  assert.equal(result.fields.fullName?.value, "Abdallah Gamal");
  // Corroborated by the sender name, so it is not a guess.
  assert.equal(result.fields.fullName?.confidence, "high");

  // Personal block behind a Wingdings bullet — the glyph that used to hide these three.
  assert.equal(result.fields.dateOfBirth?.value, "1997-08-23");
  assert.equal(result.fields.maritalStatus?.value, "Single");
  assert.equal(result.fields.militaryStatus?.value, "Exempted");
  assert.equal(result.fields.nationality?.value, "Egyptian");
  // Inferred from military status, and marked as an inference.
  assert.equal(result.fields.gender?.value, "Male");
  assert.equal(result.fields.gender?.confidence, "low");

  // Geography resolved from the DISTRICT, not from a governorate name.
  assert.equal(result.fields.governorate?.value, "Cairo");

  // Education.
  assert.equal(result.fields.university?.value, "Cairo University");
  assert.equal(result.fields.degree?.value, "Bachelor");
  assert.equal(result.fields.graduationYear?.value, 2019);
  assert.equal(result.fields.grade?.value, "Very Good");

  // Work history: both jobs, most recent first, with the current one flagged.
  const work = result.fields.workHistory?.value as Array<Record<string, unknown>> | undefined;
  assert.ok(Array.isArray(work), "work history should be an array");
  assert.equal(work.length, 2);
  assert.equal(work[0]?.employer, "Kazyon Egypt");
  assert.equal(work[0]?.jobTitle, "Senior HR Operations Specialist");
  assert.equal(work[0]?.isCurrent, true);
  assert.equal(work[0]?.from, "2023-01-01");
  assert.equal(work[1]?.employer, "Delta Lighting Egypt");
  assert.equal(result.fields.currentEmployer?.value, "Kazyon Egypt");
  assert.equal(result.fields.hasPriorWorkExperience?.value, true);

  // The CV states "5 years of experience", so the candidate's own figure wins over date arithmetic
  // (which would say 6.5 here) and is marked high.
  assert.equal(result.fields.yearsExperience?.value, 5);
  assert.equal(result.fields.yearsExperience?.confidence, "high");

  // With no stated figure, the span is computed from the history instead, and marked as an
  // estimate. Overlapping jobs are merged, not added: these two both run 2020-2022 and must total
  // about three years, not six.
  const computed = runRuleCvExtraction(
    [
      "Mona Ali",
      "EXPERIENCE",
      "HR Specialist — Alpha Co   Jan 2020 - Dec 2022",
      "Payroll Officer — Beta Co   Jan 2020 - Dec 2022",
      "EDUCATION",
      "Bachelor of Commerce, Cairo University, 2019",
    ].join("\n"),
  );
  assert.equal(computed.fields.yearsExperience?.confidence, "low");
  assert.equal(computed.fields.yearsExperience?.value, 3);

  // Languages carry their proficiency from the same line.
  const languages = result.fields.languages?.value as Array<Record<string, unknown>> | undefined;
  assert.ok(Array.isArray(languages));
  assert.deepEqual(languages, [
    { language: "Arabic", proficiency: "Native" },
    { language: "English", proficiency: "Very Good" },
  ]);

  // The applied-for role comes from the email subject, with the filler stripped.
  assert.equal(result.fields.appliedForJobTitle?.value, "Personnel & Recruitment Specialist");

  // A document that is plainly not a CV is not forced into one.
  const notCv = runRuleCvExtraction("Invoice 4471\nTotal due 1,200 EGP\nThank you for your business.");
  assert.equal(notCv.isCv, false);
}

function runMergeTests() {
  const rule: ExtractedCandidateFields = {
    currentJobTitle: low("HR Specialist"),
    email: high("real@candidate.com"),
    phone: high("01012345678"),
    professionalSummary: high("The candidate's own words, verbatim."),
    workHistory: low([{ employer: "Kazyon" }]),
  };
  const ai: ExtractedCandidateFields = {
    currentJobTitle: high("Senior HR Operations Specialist"),
    email: high("halluc@wrong.com"),
    phone: high("01099999999"),
    professionalSummary: high("A paraphrased summary written by a model."),
    university: high("Cairo University"),
    workHistory: high([{ employer: "Kazyon Egypt" }, { employer: "Delta Lighting" }]),
  };

  const merged = mergeRuleAndAiExtractions(rule, ai);

  // Deterministic fields: the rule wins even against a confident model.
  assert.equal(merged.fields.email?.value, "real@candidate.com");
  assert.equal(merged.fields.phone?.value, "01012345678");
  assert.equal(merged.sources.email, "rule");
  // Verbatim field: the candidate's own words survive.
  assert.equal(merged.fields.professionalSummary?.value, "The candidate's own words, verbatim.");
  assert.equal(merged.sources.professionalSummary, "rule");
  // Judgement fields: the confident model wins.
  assert.equal(merged.fields.currentJobTitle?.value, "Senior HR Operations Specialist");
  assert.equal(merged.sources.currentJobTitle, "ai");
  assert.equal((merged.fields.workHistory?.value as unknown[]).length, 2);
  // A field only the model found is kept.
  assert.equal(merged.fields.university?.value, "Cairo University");
  assert.equal(merged.sources.university, "ai");

  // Merging with no AI result at all returns the rule result unchanged — the no-AI path.
  const ruleOnly = mergeRuleAndAiExtractions(rule, {});
  assert.equal(ruleOnly.fromAi, 0);
  assert.deepEqual(Object.keys(ruleOnly.fields).sort(), Object.keys(rule).sort());

  // A low-confidence model answer must not displace a value a rule read off the page.
  const timid = mergeRuleAndAiExtractions({ currentEmployer: high("Kazyon Egypt") }, { currentEmployer: low("Kazyon") });
  assert.equal(timid.fields.currentEmployer?.value, "Kazyon Egypt");
  assert.equal(timid.sources.currentEmployer, "rule");
}

function runEscalationTests() {
  // A CV the rules read well costs nothing.
  const good = runRuleCvExtraction(SAMPLE_CV, { senderName: "Abdallah Gamal", subject: "HR Specialist" });
  const goodDecision = shouldEscalateToAi(good);
  assert.equal(goodDecision.escalate, false);
  assert.match(goodDecision.reason, /answered every field|not worth a model call/);

  // A CV the rules could only half-read IS escalated: contact details came out, but every
  // judgement field (title, employer, history, tenure) is still empty. This is the case worth
  // paying for.
  const thin = runRuleCvExtraction("Mahmoud Samy\nmahmoud.samy@example.com\n01012345678\nCairo");
  const thinDecision = shouldEscalateToAi(thin);
  assert.equal(thinDecision.escalate, true);
  assert.ok(thinDecision.missingFields.includes("workHistory"));

  // Something that is not a CV is never escalated — there is nothing to buy.
  const notCv = runRuleCvExtraction("Invoice 4471\nTotal due 1,200 EGP\nThank you for your business.");
  assert.equal(shouldEscalateToAi(notCv).escalate, false);
}

// ---------------------------------------------------------------------------
// The wiring into live intake
//
// Everything above proves the engine works. None of it proves anything CALLS it — cv-extraction.ts
// would compile and every assertion above would stay green while production still paid for a model
// on every CV. These read the source and pin the four decisions that make the wiring correct.
// ---------------------------------------------------------------------------

function runWiringTests() {
  const extraction = readFileSync(new URL("../src/lib/recruitment/cv-extraction.ts", import.meta.url), "utf8");
  const intake = readFileSync(new URL("../src/lib/recruitment/inbound/cv-intake-service.ts", import.meta.url), "utf8");

  // 1. The rule pass is actually run, and its result can short-circuit the model.
  assert.match(extraction, /runRuleCvExtraction\(cleanedText, ruleContext\)/, "extraction must run the rule pass");
  assert.match(extraction, /if \(!decision\.escalate\) return ruleOnly\(\);/, "a sufficient rule read must skip the AI");

  // 2. The rule pass runs BEFORE the API-key check, so a configured-but-broken OpenAI (credits
  //    exhausted, as on 2026-08-16) no longer costs every inbound applicant their profile.
  assert.ok(
    extraction.indexOf("runRuleCvExtraction(cleanedText, ruleContext)") < extraction.indexOf("if (!hasOpenAiApiKey())"),
    "the free rule pass must run before the OpenAI key is required",
  );
  assert.match(extraction, /if \(rule && rule\.isCv\) return ruleOnly\(\);\s*\n\s*throw error;/, "an AI failure must fall back to the rule result");

  // 3. is_cv still follows the MODEL when the model was consulted. The rules' own is_cv is a
  //    six-signal heuristic an invoice would satisfy, and letting it overrule the model would
  //    reopen the "vendor pitch becomes a candidate" hole.
  assert.match(extraction, /isCv: ai\.isCv,/, "a merged result must take is_cv from the model, not the rules");

  // 4. The forwarder guard. On a bulk forward-import every message carries the FORWARDER's address,
  //    and the rule engine falls back to the sender address when the CV states none — so passing it
  //    would stamp one address onto every candidate in the import and collapse them into one.
  assert.match(
    intake,
    /senderEmail: input\.identitySource === "cv" \? null : input\.senderIdentifier/,
    "intake must withhold the sender address from the rule pass on a forward-import",
  );
  assert.match(
    intake,
    /senderName: input\.identitySource === "cv" \? null : \(input\.senderDisplayName \?\? null\)/,
    "intake must withhold the sender name from the rule pass on a forward-import",
  );
  // The subject is safe in both cases — it describes the job, not the person.
  assert.match(intake, /subject: input\.subject \?\? null,/, "intake must pass the subject to the rule pass");
}

export function runRecruitmentRuleExtractionTests() {
  runNormalizationTests();
  runPatternTests();
  runSectionTests();
  runPersonalTests();
  runWorkTests();
  runEndToEndTests();
  runMergeTests();
  runEscalationTests();
  runWiringTests();
}
