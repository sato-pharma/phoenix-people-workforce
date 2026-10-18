import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

import {
  aiFieldsWorthAsking,
  mergeRuleAndAiExtractions,
  shouldEscalateToAi,
} from "../src/lib/recruitment/cv-extraction-merge.ts";
import type { ExtractedCandidateFields } from "../src/lib/recruitment/cv-extraction-fields.ts";
import { runRuleCvExtraction, type RuleExtractionResult } from "../src/lib/recruitment/rule-extraction/index.ts";
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
import {
  extractEducationHistory,
  findDegree,
  findFaculty,
  findGraduationYear,
} from "../src/lib/recruitment/rule-extraction/education.ts";
import { resolveGovernorate, parseFullDate, readLabelledValue } from "../src/lib/recruitment/rule-extraction/personal.ts";
import { classifyHeading, linesOfKinds, sliceCvSections } from "../src/lib/recruitment/rule-extraction/sections.ts";
import {
  currentJobTitleField,
  extractWorkHistory,
  splitTitleAndEmployer,
  yearsExperienceField,
} from "../src/lib/recruitment/rule-extraction/work.ts";

const high = (value: unknown) => ({ confidence: "high" as const, value: value as never });
const low = (value: unknown) => ({ confidence: "low" as const, value: value as never });

// A realistic Egyptian HR CV, carrying the exact defects the real careers inbox produces:
// a Wingdings bullet (U+F0B7) in front of the personal block, a district rather than a
// governorate, and several labels packed onto one line.
//
// THE PERSON IS INVENTED. This fixture was a real applicant's CV until 2026-08-28 — his name,
// mobile, email, LinkedIn, employers and date of birth, committed and pushed while his application
// was still open. Keep every defect above; never restore a real one. A CV reaches this repository
// only as shapes, and the assertions below key on shapes alone.
//
// The address is @example.org, NOT @example.com, on purpose: example.com sits in
// NON_CANDIDATE_EMAIL_DOMAINS (patterns.ts), so findEmails would discard it and the end-to-end
// email assertion would pass for the wrong reason. Both are RFC 2606 reserved and can never
// belong to anyone.
const SAMPLE_CV = `TAREK NABIL
Human Resources Operations Specialist
Nasr City, Cairo | +20 12 3456 7890 | tareknabil88@example.org
https://www.linkedin.com/in/tarek-nabil-1234

PROFESSIONAL SUMMARY
HR Operations professional with 5 years of experience across recruitment, employee relations and
the full employee lifecycle in retail and manufacturing environments.

EXPERIENCE
Senior HR Operations Specialist — Marfaa Egypt   Jan 2023 - Present
• Manage the full recruitment cycle in coordination with hiring managers.
• Administer medical insurance enrollment and claims for employees.
HR Specialist — Nile Lighting Egypt   Mar 2020 - Dec 2022
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
\u{f0b7} Date of Birth: 17/3/1994 | Marital Status: Single | Military Status: Exempted
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
  const tabbedCv = "Senior HR Specialist — Marfaa Egypt\tJan 2023 - Present\nHR Specialist — Nile\tMar 2020 - Dec 2022";
  assert.equal(looksShredded(tabbedCv), false);
  assert.equal(repairShreddedText(tabbedCv), tabbedCv);

  // An email split across a line break is rejoined; unrelated lines are not.
  const wrapped = normalizeCvText("bishoysamirfouad@example.or\ng\nCairo");
  assert.match(wrapped.text, /bishoysamirfouad@example\.org/);

  // A markdown hyperlink keeps the URL, which is the half that is not truncated.
  const linked = normalizeCvText("[https://www.linkedin.com/in/bish](https://www.linkedin.com/in/bishoy-samir-fouad-362434244)");
  assert.match(linked.text, /bishoy-samir-fouad-362434244/);

  // Arabic-Indic digits become ASCII so a phone rule can read them.
  assert.match(normalizeCvText("\u{664}\u{665}").text, /45/);
}

function runPatternTests() {
  // The newline bug: the phone scanner must stop at the end of the line. When \s was in its
  // separator class it ran on into whatever followed, and the contact block of a CV is followed by
  // an education line far more often than by anything else.
  //
  // This input is chosen to be SHARP. The obvious case ("01234567890\n3 El Salam, Giza") does not
  // test anything: only one stray digit gets absorbed, and the rescue scan — which tolerates two
  // leftover digits so it can strip a country code — puts the number back, so the assertion passes
  // whether the scanner stops at the newline or not. A following year range leaves eight leftover
  // digits, which the rescue correctly refuses, and the number is lost outright.
  assert.deepEqual(findEgyptianMobiles("Mobile: 01234567890\n2015 - 2019  Faculty of Pharmacy"), ["01234567890"]);
  // The same CV read the naive way, kept as documentation of why the two mechanisms are separate:
  // one stray digit IS still rescued, so this case survives either way.
  assert.deepEqual(findEgyptianMobiles("01234567890\n3 El Salam, Giza"), ["01234567890"]);

  // Every country-code spelling in the corpus normalizes to one canonical form.
  for (const written of ["01012345678", "+201012345678", "00201012345678", "+20 10 1234 5678", "(+02)01012345678"]) {
    assert.equal(normalizeEgyptianMobile(written.replace(/[^\d+]/g, "")), "01012345678", `failed on ${written}`);
  }
  // Two numbers printed back to back are both recovered.
  assert.deepEqual(findEgyptianMobiles("Phone: 01234567890-01098765432."), ["01234567890", "01098765432"]);
  // A landline and a random long number are not mobiles.
  assert.deepEqual(findEgyptianMobiles("Tel: 0223456789 ref 123456789012345"), []);

  // Emails: job-board domains are not the candidate's address.
  assert.deepEqual(findEmails("mail me at Mona.Ali@Example-Co.com."), ["mona.ali@example-co.com"]);
  assert.deepEqual(findEmails("apply via noreply@wuzzuf.net"), []);

  // LinkedIn prefers the longest match — the truncated label sits beside the real URL.
  assert.equal(
    findLinkedInUrl("linkedin.com/in/bish https://www.linkedin.com/in/bishoy-samir-fouad-362434244"),
    "https://www.linkedin.com/in/bishoy-samir-fouad-362434244",
  );

  // National ID decodes birth date, sex and birth governorate; junk is rejected.
  // The ID and the CV's date of birth move TOGETHER — an Egyptian national ID encodes the birth
  // date in digits 2-7, so leaving one behind would put the real date back in the repository via
  // the other. Both are invented here, and the serial is a placeholder run.
  const decoded = decodeEgyptianNationalId("29403171301234");
  assert.ok(decoded, "a valid national ID should decode");
  assert.equal(decoded.dateOfBirth, "1994-03-17");
  assert.equal(decoded.birthGovernorate, "Sharqia");
  assert.equal(decoded.gender, "Male");
  assert.equal(decodeEgyptianNationalId("12345678901234"), null);
  // A real-looking ID whose date is impossible must not decode.
  assert.equal(decodeEgyptianNationalId("29413451301234"), null);

  // Date ranges, in the styles the corpus actually uses.
  const current = parseDateRange("Senior HR Specialist — Marfaa  Jan 2023 - Present");
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

// The production defect: candidate 459929dc-ffd1-43ce-b13f-7e1aeeeb47d3 ("Mostafa Mahrous
// El-Sheikh", found 2026-09-11 while screening the live Behira 1 folder). His CV's education line
// reads, verbatim: "Bachelor of Arts – Damanhur University – 2026 / Department: Archaeology" — a
// faculty AND a department, both plainly named. Before this fix, findFaculty's dictionary scan
// only recognised the section-HEADING grammar ("Faculty of Arts"), never the degree-TITLE grammar
// ("Bachelor of Arts") or a transcript LABEL ("Department: Archaeology"), so the CV was stored as
// degree="Bachelor", faculty=NULL — and resolveBackgroundStanding (background-review.ts) then read
// that as "unknown", which candidate-folder-suggestion.ts deliberately lets through to the Medical
// Representative shelf. He was filed to Behira 1 looking eligible for a role his Archaeology degree
// does not qualify him for.
function sectionsFor(text: string) {
  return sliceCvSections(normalizeCvText(text).lines);
}

function runFacultyExtractionTests() {
  // THE HEADLINE ASSERTION. The exact reported line, en-dashes and all (proving the DASHES fold in
  // normalizeCvText and this new logic work together, not just against a pre-cleaned fixture).
  const mostafaCv = "EDUCATION\nBachelor of Arts – Damanhur University – 2026 / Department: Archaeology";
  const faculty = findFaculty(sectionsFor(mostafaCv));
  assert.ok(faculty, "a degree line naming a faculty must not come back null");
  assert.equal(faculty.value, "Faculty of Arts");
  // HIGH, not low: this is what lets cv-auto-apply (selectAutoApplyFields, gate 1) actually WRITE the
  // value to the candidate.faculty column. The production row's AI-assisted extraction already held
  // faculty: {value: "Department: Archaeology", confidence: "low"} and it was silently discarded by
  // that exact gate — a low-confidence rule answer would reproduce the same failure by a new route.
  assert.equal(faculty.confidence, "high");

  // The degree LEVEL is unaffected and unaffected on purpose — "Bachelor" is a correct, complete
  // answer to "degree awarded" (see the schema's own aiDescription); it is FACULTY that was dropped,
  // not the degree.
  assert.equal(findDegree(sectionsFor(mostafaCv))?.value, "Bachelor");

  // A department label alone, with no "Bachelor of X" to pre-empt it, still resolves against the
  // same closed vocabulary — the second of the two new passes, exercised on its own.
  const departmentOnly = findFaculty(sectionsFor("EDUCATION\nBachelor's Degree - Cairo University - 2021\nDepartment: Archaeology"));
  assert.equal(departmentOnly?.value, "Faculty of Archaeology");
  assert.equal(departmentOnly?.confidence, "high");

  // A department the closed vocabulary does not recognise is still kept, verbatim, at LOW
  // confidence — the same treatment findUniversity gives an institution line it cannot validate. It
  // will not auto-apply, but a human reviewing this candidate sees what the CV actually said instead
  // of a blank field.
  const unrecognisedDepartment = findFaculty(
    sectionsFor("EDUCATION\nBachelor's Degree - Cairo University - 2021\nMajor: Public Relations"),
  );
  assert.equal(unrecognisedDepartment?.value, "Public Relations");
  assert.equal(unrecognisedDepartment?.confidence, "low");

  // Longest-match-first: "Bachelor of Computer Science" must read as Computer Science, not as the
  // generic "Science" sitting inside it — the same specific-before-generic rule FACULTY_KEYWORDS'
  // own scan already relies on, now proven for the new degree-title pass too.
  const computerScience = findFaculty(sectionsFor("EDUCATION\nBachelor of Computer Science - Helwan University - 2018"));
  assert.equal(computerScience?.value, "Faculty of Computer Science");

  // A CV that already states its faculty the ordinary way is completely unaffected — the new passes
  // are a FALLBACK, only reached once the existing dictionary scan finds nothing.
  const alreadyWorking = findFaculty(sectionsFor("EDUCATION\nBachelor of Commerce, Faculty of Commerce, Cairo University, 2019"));
  assert.equal(alreadyWorking?.value, "Faculty of Commerce");
  assert.equal(alreadyWorking?.confidence, "high");

  // No education section at all, or one naming neither a degree title nor a department: still null,
  // never a guess.
  assert.equal(findFaculty(sectionsFor("EXPERIENCE\nHR Specialist — Marfaa Egypt")), null);
  assert.equal(findFaculty(sectionsFor("EDUCATION\nCairo University, 2019")), null);

  // THE CURLY APOSTROPHE. Word autocorrects a typed ' to U+2019, so "Bachelor's degree in
  // Veterinary Medicine" and "Bachelor's degree in Veterinary Medicine" are the same sentence to a
  // reader and two different strings to a rule: DEGREE_QUALIFIER_LINE spells bachelor(?:'s)? with a
  // STRAIGHT quote only, so the curly spelling missed the degree-title pass entirely and fell
  // through to the weak bare-word scan at LOW confidence. LOW is never auto-applied, so an
  // identical CV kept its faculty column blank purely on which quote character Word had chosen.
  //
  // Found 2026-09-12 while dry-running the 42 medical-rep candidates who carry a degree and no
  // faculty — a gap in the fix that shipped as ca00dc7b3 the night before. Two of those 42 are
  // exactly this shape (Hatem Zahran, "Bachelor’s of Pharmacy"; Manar Tharwat, "Bachelor’s
  // degree in veterinary medicine"), and both now resolve at HIGH.
  //
  // Fixed in normalizeCvText beside the DASHES fold rather than in the two education.ts regexes:
  // education.ts's own comment already states dashes are folded before any rule sees the text, so
  // folding apostrophes there fixes the whole class instead of two call sites.
  for (const apostrophe of ["'", "’", "‘", "ʼ"]) {
    // codePointAt returns number | undefined, and a non-null assertion in a test is a habit worth not
    // forming — the label is only an error message, so a 0 it can never reach costs nothing.
    const codePoint = (apostrophe.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    const curly = findFaculty(sectionsFor(`EDUCATION\nBachelor${apostrophe}s degree in Veterinary Medicine - Sohag University - 2024`));
    assert.equal(
      curly?.value,
      "Faculty of Veterinary Medicine",
      `a degree written with U+${codePoint} must read the same as one written with a straight quote`,
    );
    assert.equal(
      curly?.confidence,
      "high",
      "the curly spelling must reach HIGH like the straight one — LOW is never auto-applied, so a demotion here leaves the faculty column blank with nothing on screen to say why",
    );
  }

  // END TO END — the value actually emitted by the pipeline production writes into
  // ats_candidate_cv_extractions.extracted_fields, not merely the isolated rule. Mirrors
  // production's exact source text (source: whatsapp, a PDF whose text layer reads this literally).
  const endToEnd = runRuleCvExtraction(
    [
      "Mostafa Mahrous El-Sheikh",
      "01012345678",
      "EDUCATION",
      "Bachelor of Arts – Damanhur University – 2026 / Department: Archaeology",
    ].join("\n"),
  );
  assert.equal(endToEnd.fields.faculty?.value, "Faculty of Arts");
  assert.equal(endToEnd.fields.faculty?.confidence, "high");
  assert.equal(endToEnd.fields.degree?.value, "Bachelor");
  // NOT asserted here: university. "Damanhur" (one "u") is not the "Damanhour" spelling
  // EGYPT_UNIVERSITIES carries, so the free rule pass alone reads it only via findUniversity's own
  // low-confidence raw-line fallback — a pre-existing, unrelated gap in that dictionary, not
  // something this fix touches. Production's clean "Damanhur University" on this candidate came from
  // the AI pass, not the rules; see the extraction row queried during reproduction.
}

function runPersonalTests() {
  // The bug this pins: several labels packed onto one line must not swallow each other.
  const packed = ["Date of Birth: March 17, 1994 | Marital Status: Single | Military Status: Exempted"];
  assert.equal(readLabelledValue(packed, ["marital status"]), "Single");
  assert.equal(readLabelledValue(packed, ["military status"]), "Exempted");
  assert.equal(readLabelledValue(packed, ["date of birth"]), "March 17, 1994");
  // A label alone on its line takes the following line as its value.
  assert.equal(readLabelledValue(["Marital Status", "Married"], ["marital status"]), "Married");
  // A bare word without a separator is not a labelled value.
  assert.equal(readLabelledValue(["He completed his military service in 2019"], ["military"]), null);

  // Day-first for Egypt; unambiguous when the day exceeds 12.
  assert.equal(parseFullDate("17/3/1994")?.iso, "1994-03-17");
  assert.equal(parseFullDate("17/3/1994")?.ambiguous, false);
  assert.equal(parseFullDate("5/6/1996")?.ambiguous, true);
  assert.equal(parseFullDate("March 17, 1994")?.iso, "1994-03-17");
  // A birth date nobody could have is rejected.
  assert.equal(parseFullDate("17/3/1890"), null);

  // District-first resolution — the three that are routinely got wrong.
  assert.equal(resolveGovernorate("Nasr City, Cairo")?.governorate, "Cairo");
  assert.equal(resolveGovernorate("6th of October")?.governorate, "Giza");
  assert.equal(resolveGovernorate("10th of Ramadan City")?.governorate, "Sharqia");
  assert.equal(resolveGovernorate("El Khanka")?.governorate, "Qalyubia");
  assert.equal(resolveGovernorate("nowhere in particular"), null);

  // The bug this pins: "Al-Rehab St., Damanhur" contains BOTH "Rehab" (a Cairo district) and
  // "Damanhur" (a Beheira town). The candidate lives in Damanhur — the town named LAST — not in the
  // Cairo compound whose street he happens to live on. Picking the first dictionary entry that
  // matched, regardless of where in the string it occurred, used to answer Cairo here.
  assert.equal(resolveGovernorate("Al-Rehab St., Damanhur")?.governorate, "Beheira");
  // Same shape, the other transliteration of the town's name.
  assert.equal(resolveGovernorate("Al-Rehab St., Damanhour")?.governorate, "Beheira");

  // Production carries these governorate spellings verbatim ("Al Buhayrah", "Sharqiya") in the
  // stored field itself, not just in CV text — found while measuring Pattern 4's real prevalence.
  // Missing from the dictionary, they used to fall through as an unrecognised governorate entirely.
  assert.equal(resolveGovernorate("Al Buhayrah")?.governorate, "Beheira");
  assert.equal(resolveGovernorate("Sharqiya")?.governorate, "Sharqia");
}

function runEducationTests() {
  // An unambiguous "Faculty of X" phrase is trusted outright.
  const clear = sliceCvSections(["EDUCATION", "Faculty of Pharmacy, Cairo University, 2019"]);
  assert.equal(findFaculty(clear)?.value, "Faculty of Pharmacy");
  assert.equal(findFaculty(clear)?.confidence, "high");

  // The bug this pins: a candidate's own CV named "Faculty of Agriculture" in full, but her
  // education section also carried a stray bare "Pharmacy" elsewhere (a rotation, an employer — the
  // exact word does not matter). Production candidate edb6ea02-…, 2026-09-09: faculty came back
  // "Pharmacy" while her degree and her own declared background both said Agriculture. The specific
  // phrase must win over the bare word regardless of which appears first or is longer.
  const conflicting = sliceCvSections([
    "EDUCATION",
    "Bachelor of Science in Agriculture - Clinical Nutrition",
    "Faculty of Agriculture, Mansoura University, 2019",
    "Completed a rotation at a community Pharmacy",
  ]);
  assert.equal(findFaculty(conflicting)?.value, "Faculty of Agriculture");
  assert.equal(findFaculty(conflicting)?.confidence, "high");

  // With NO qualifying "Faculty of X" phrase at all, a bare generic word ("Pharmacy", "Commerce",
  // "Law", "Engineering", "Veterinary") is still offered — but only at LOW confidence, so it can
  // reach a reviewer without being auto-filled onto the candidate record as if it were a fact. This
  // is the fix itself: before it, this case returned "high" and the wrong label became visible to
  // recruiters with no human ever having looked at it.
  const bareWordOnly = sliceCvSections(["EDUCATION", "Completed a rotation at a community Pharmacy"]);
  assert.equal(findFaculty(bareWordOnly)?.value, "Pharmacy");
  assert.equal(findFaculty(bareWordOnly)?.confidence, "low");

  // No education section at all, and no match — both still yield nothing.
  assert.equal(findFaculty([]), null);
  assert.equal(findFaculty(sliceCvSections(["EDUCATION", "Diploma in Project Management"])), null);
}

function runGraduationYearTests() {
  // The bug this pins: a CV showing an ONGOING degree ("2023 - Present") had its START year read as
  // a graduation year — a current student ("Faculty of Science, Benha University, 2023 - Present",
  // still enrolled) came back with a graduation year of 2023, misreading her as already a graduate.
  const ongoing = sliceCvSections(["EDUCATION", "Faculty of Science, Benha University, 2023 - Present"]);
  assert.equal(findGraduationYear(ongoing), null);
  assert.equal(extractEducationHistory(ongoing)[0]?.year, null);

  // A FINISHED degree is unaffected — its own end year is still the graduation year.
  const finished = sliceCvSections(["EDUCATION", "Faculty of Science, Benha University, 2018 - 2023"]);
  assert.equal(findGraduationYear(finished)?.value, 2023);
  assert.equal(findGraduationYear(finished)?.confidence, "high");
  assert.equal(extractEducationHistory(finished)[0]?.year, 2023);

  // A finished bachelor's alongside an ongoing master's in the SAME section: the ongoing line must
  // not contribute a year at all, so the finished degree's own end year — not the master's start
  // year — is what "graduation year" reports.
  const mixed = sliceCvSections([
    "EDUCATION",
    "Bachelor of Pharmacy, Cairo University, 2015 - 2019",
    "Master of Science, Ain Shams University, 2023 - Present",
  ]);
  assert.equal(findGraduationYear(mixed)?.value, 2019);
  const mixedEntries = extractEducationHistory(mixed);
  assert.equal(mixedEntries[0]?.year, 2019);
  assert.equal(mixedEntries[1]?.year, null);
}

function runWorkTests() {
  // Which half is the title is decided by vocabulary, not by position.
  assert.deepEqual(splitTitleAndEmployer("Senior HR Specialist — Marfaa Egypt"), {
    employer: "Marfaa Egypt",
    jobTitle: "Senior HR Specialist",
  });
  assert.deepEqual(splitTitleAndEmployer("Marfaa Egypt / HR Specialist"), {
    employer: "Marfaa Egypt",
    jobTitle: "HR Specialist",
  });
}

function runExperienceFieldsTests() {
  // Pattern 3: a CV's own HEADLINE under the name is not proof of a job actually held — "Emad Maher
  // Othman" headlined himself "Medical Sales Representative" and never held that job. With NO work
  // history to confirm it, the headline is still offered, but only at LOW confidence.
  const headlineOnly = sliceCvSections(["Medical Sales Representative", "Nasr City, Cairo | 01234567890"]);
  const headlineField = currentJobTitleField(
    linesOfKinds(headlineOnly, ["header"]),
    extractWorkHistory(headlineOnly),
  );
  assert.equal(headlineField?.value, "Medical Sales Representative");
  assert.equal(headlineField?.confidence, "low");

  // A REAL work-history entry outranks the headline outright, and is trusted at high confidence —
  // the headline above never held that job; this candidate's own history says otherwise.
  const withRealJob = sliceCvSections([
    "Medical Sales Representative",
    "Nasr City, Cairo | 01234567890",
    "EXPERIENCE",
    "Quality Control Analyst — Delta Labs   Jan 2022 - Present",
  ]);
  const realField = currentJobTitleField(linesOfKinds(withRealJob, ["header"]), extractWorkHistory(withRealJob));
  assert.equal(realField?.value, "Quality Control Analyst");
  assert.equal(realField?.confidence, "high");

  // Pattern 2: an INTERNSHIP or training placement never counts as years of professional
  // experience — a fresh graduate whose CV lists only a placement like this must not read as
  // someone with years on the job.
  const internEntries = extractWorkHistory(
    sliceCvSections(["EXPERIENCE", "Veterinary Intern — City Vet Clinic   Jun 2024 - Aug 2024"]),
  );
  assert.equal(internEntries[0]?.jobTitle, "Veterinary Intern");
  assert.equal(yearsExperienceField("", internEntries), null);

  // A REAL job alongside a training placement: only the real job's months are counted, so a
  // candidate with one working year and one summer training reads as one year, not more.
  const mixedEntries = extractWorkHistory(
    sliceCvSections([
      "EXPERIENCE",
      "Pharmacist — City Pharmacy   Jan 2022 - Dec 2022",
      "Summer Training — City Pharmacy   Jun 2020 - Aug 2020",
    ]),
  );
  const mixedYears = yearsExperienceField("", mixedEntries);
  assert.equal(mixedYears?.value, 1);
  assert.equal(mixedYears?.confidence, "low");
}

function runEndToEndTests() {
  const result = runRuleCvExtraction(SAMPLE_CV, {
    senderEmail: "tareknabil88@example.org",
    senderName: "Tarek Nabil",
    subject: "Application for Personnel & Recruitment Specialist",
  });

  assert.equal(result.isCv, true);

  // Contact details — the fields the rule engine owns outright.
  assert.equal(result.fields.email?.value, "tareknabil88@example.org");
  assert.equal(result.fields.email?.confidence, "high");
  assert.equal(result.fields.phone?.value, "01234567890");
  assert.equal(result.fields.phone?.confidence, "high");
  assert.equal(result.fields.linkedinUrl?.value, "https://www.linkedin.com/in/tarek-nabil-1234");
  assert.equal(result.fields.fullName?.value, "Tarek Nabil");
  // Corroborated by the sender name, so it is not a guess.
  assert.equal(result.fields.fullName?.confidence, "high");

  // Personal block behind a Wingdings bullet — the glyph that used to hide these three.
  assert.equal(result.fields.dateOfBirth?.value, "1994-03-17");
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
  assert.equal(work[0]?.employer, "Marfaa Egypt");
  assert.equal(work[0]?.jobTitle, "Senior HR Operations Specialist");
  assert.equal(work[0]?.isCurrent, true);
  assert.equal(work[0]?.from, "2023-01-01");
  assert.equal(work[1]?.employer, "Nile Lighting Egypt");
  assert.equal(result.fields.currentEmployer?.value, "Marfaa Egypt");
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
    workHistory: low([{ employer: "Marfaa" }]),
  };
  const ai: ExtractedCandidateFields = {
    currentJobTitle: high("Senior HR Operations Specialist"),
    email: high("halluc@wrong.com"),
    phone: high("01099999999"),
    professionalSummary: high("A paraphrased summary written by a model."),
    university: high("Cairo University"),
    workHistory: high([{ employer: "Marfaa Egypt" }, { employer: "Nile Lighting" }]),
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
  const timid = mergeRuleAndAiExtractions({ currentEmployer: high("Marfaa Egypt") }, { currentEmployer: low("Marfaa") });
  assert.equal(timid.fields.currentEmployer?.value, "Marfaa Egypt");
  assert.equal(timid.sources.currentEmployer, "rule");
}

function runEscalationTests() {
  // A CV the rules read well costs nothing.
  const good = runRuleCvExtraction(SAMPLE_CV, { senderName: "Tarek Nabil", subject: "HR Specialist" });
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

  // --- Value before volume -------------------------------------------------
  //
  // The count rule weighs every field the same, so a CV whose ONLY gap was the current job title
  // or employer sat under the "3 or more" line and was never escalated. Measured on production
  // 2026-08-27: 57 rules-only candidates were exactly one field short, and for 51 of them that one
  // field was the title (30) or the employer (21) — the two facts a medical-rep screen is actually
  // built on. Those two now carry the decision on their own; see HIGH_VALUE_ESCALATION_FIELDS.
  const wellRead: ExtractedCandidateFields = {
    fullName: high("Tarek Nabil"),
    email: high("tareknabil88@example.org"),
    phone: high("+201234567890"),
    professionalSummary: high("Six years in HR operations across retail and manufacturing."),
    degree: high("BSc Commerce"),
    university: high("Cairo University"),
    currentJobTitle: high("HR Operations Specialist"),
    currentEmployer: high("Marfaa"),
    workHistory: high([{ employer: "Marfaa" }]),
    yearsExperience: high(6),
    currentRoleResponsibilities: high("Payroll, attendance and onboarding for 400 staff."),
  };
  const ruleRead = (fields: ExtractedCandidateFields): RuleExtractionResult => ({
    fields,
    isCv: true,
    filled: Object.keys(fields).length,
    highConfidence: Object.keys(fields).length,
    repairedText: false,
  });
  // Every fixture below is a WELL-read CV minus specific fields, so nothing can escalate for one of
  // the earlier reasons (thin read, repaired text) and quietly make these assertions meaningless.
  const without = (...keys: readonly string[]): ExtractedCandidateFields =>
    Object.fromEntries(Object.entries(wellRead).filter(([key]) => !keys.includes(key))) as ExtractedCandidateFields;

  const titleOnly = shouldEscalateToAi(ruleRead(without("currentJobTitle")));
  assert.equal(titleOnly.escalate, true, "a lone missing currentJobTitle must be worth a model call by itself");
  assert.deepEqual(titleOnly.missingFields, ["currentJobTitle"]);
  assert.match(titleOnly.reason, /currentJobTitle/);

  const employerOnly = shouldEscalateToAi(ruleRead(without("currentEmployer")));
  assert.equal(employerOnly.escalate, true, "a lone missing currentEmployer must be worth a model call by itself");
  assert.match(employerOnly.reason, /currentEmployer/);

  const bothMissing = shouldEscalateToAi(ruleRead(without("currentJobTitle", "currentEmployer")));
  assert.equal(bothMissing.escalate, true);
  assert.match(bothMissing.reason, /currentJobTitle and currentEmployer/);

  // The gate was made TARGETED, not merely looser. Dropping the count threshold to 1 would have
  // bought these calls too; naming the fields does not. This is the assertion that tells the two
  // apart, so it is the one to read first if this ever goes red.
  assert.equal(
    shouldEscalateToAi(ruleRead(without("currentRoleResponsibilities"))).escalate,
    false,
    "a lone low-value gap must still not cost money",
  );
  assert.equal(
    shouldEscalateToAi(ruleRead(without("currentRoleResponsibilities", "yearsExperience"))).escalate,
    false,
    "two low-value gaps must still not cost money",
  );

  // The two rules either side of the new one are untouched: nothing missing still costs nothing,
  // and three low-value gaps still escalate on the count alone.
  assert.equal(shouldEscalateToAi(ruleRead(wellRead)).escalate, false);
  const threeLowValue = shouldEscalateToAi(
    ruleRead(without("currentRoleResponsibilities", "yearsExperience", "workHistory")),
  );
  assert.equal(threeLowValue.escalate, true);
  assert.match(threeLowValue.reason, /3 judgement fields unanswered/);
}

// ---------------------------------------------------------------------------
// The wiring into live intake
//
// Everything above proves the engine works. None of it proves anything CALLS it — cv-extraction.ts
// would compile and every assertion above would stay green while production still paid for a model
// on every CV. These read the source and pin the four decisions that make the wiring correct.
// ---------------------------------------------------------------------------

function runNarrowingTests() {
  // What an escalated CV is ASKED for, once the rules have already won part of the document.
  // The saving here is output tokens — the half of the bill that is generated, charged, and then
  // thrown away by the merge policy.
  const ruleFields: ExtractedCandidateFields = {
    currentJobTitle: low("HR Specialist"), // judgement field, rule unsure  -> ask
    degree: high("BSc Pharmacy"), // unlisted, rule confident       -> drop
    email: high("real@candidate.com"), // rule-authoritative              -> drop
    governorate: high("Cairo"), // rule-authoritative              -> drop
    languages: low(["Arabic"]), // unlisted, rule unsure           -> ask
    phone: high("01012345678"), // rule-authoritative              -> drop
    professionalSummary: high("The candidate's own words."), // verbatim   -> drop
    university: high("Cairo University"), // unlisted, rule confident      -> drop
    workHistory: low([{ employer: "Marfaa" }]), // judgement field         -> ask
  };
  // Three keys the rules did not answer at all, to prove they survive the narrowing.
  const schemaKeys = [...Object.keys(ruleFields), "currentEmployer", "yearsExperience", "nationalId"];
  const asked = aiFieldsWorthAsking(ruleFields, schemaKeys);
  const dropped = schemaKeys.filter((key) => !asked.includes(key));

  for (const key of ["currentEmployer", "yearsExperience", "nationalId"]) {
    assert.ok(asked.includes(key), `${key} is unanswered by the rules, so it must still be asked for`);
  }
  assert.deepEqual(
    [...dropped].sort(),
    ["degree", "email", "governorate", "phone", "professionalSummary", "university"],
    "only fields the rules have already won outright may be dropped from the request",
  );

  // THE PROOF, and the only reason narrowing is safe: for every dropped key, hand the merge a
  // DIFFERENT high-confidence model answer and the rule value still wins. So not asking costs
  // nothing. Read off mergeRuleAndAiExtractions itself rather than restated, so the two cannot
  // drift apart — change the merge policy without changing the narrowing and this goes red.
  for (const key of dropped) {
    const merged = mergeRuleAndAiExtractions(ruleFields, { [key]: high("A CONFIDENT MODEL ANSWER") });
    assert.equal(
      merged.fields[key]?.value,
      ruleFields[key]?.value,
      `dropping ${key} must be lossless — a confident model answer loses this merge anyway`,
    );
    assert.equal(merged.sources[key], "rule", `${key} is only safe to drop while the rule owns it outright`);
  }

  // ...and the converse, so the narrowing cannot quietly become "ask for nothing": every field
  // still asked for is one where a confident answer genuinely changes the stored record.
  for (const key of asked.filter((candidate) => ruleFields[candidate])) {
    const merged = mergeRuleAndAiExtractions(ruleFields, { [key]: high("A CONFIDENT MODEL ANSWER") });
    assert.equal(merged.sources[key], "ai", `${key} is asked for, so a confident answer must be able to win`);
  }
}

function runWiringTests() {
  const extraction = readFileSync(new URL("../src/lib/recruitment/cv-extraction.ts", import.meta.url), "utf8");
  const intake = readFileSync(new URL("../src/lib/recruitment/inbound/cv-intake-service.ts", import.meta.url), "utf8");

  // 1. The rule pass is actually run, and its result can short-circuit the model.
  assert.match(extraction, /runRuleCvExtraction\(cleanedText, ruleContext\)/, "extraction must run the rule pass");
  assert.match(extraction, /if \(!decision\.escalate\) return ruleOnly\(\);/, "a sufficient rule read must skip the AI");

  // 2. The rule pass runs BEFORE the API-key check, so a configured-but-broken OpenAI (credits
  //    exhausted, as on 2026-08-16) no longer costs every inbound applicant their profile.
  assert.ok(
    extraction.indexOf("runRuleCvExtraction(cleanedText, ruleContext)") < extraction.indexOf("if (!hasAiApiKey())"),
    "the free rule pass must run before the OpenAI key is required",
  );
  // An exhausted AI must fall back rather than throw: first to the rule result, then — for a scan,
  // which has no rule result because it had no text layer — to free OCR. Only when both are empty
  // does the caller see the error it used to see unconditionally.
  assert.match(
    extraction,
    /if \(rule && rule\.isCv\) return ruleOnly\(\);[\s\S]{0,300}?const scanned = await ruleFromOcr\(\);\s*\n\s*if \(scanned\) return scanned;\s*\n\s*throw error;/,
    "an AI failure must fall back to the rule result, then to OCR, before throwing",
  );

  // 2b. The narrowed request is actually WIRED — the schema, the prompt's reply parsing, and the
  //     escalation gate all have to move together, and each one is a separate way to get it wrong.
  assert.match(
    extraction,
    /text: buildExtractionTextFormat\(schema, askKeys \?\? undefined\)/,
    "the request must carry the narrowed field list, or the saving never reaches OpenAI",
  );
  assert.match(
    extraction,
    /for \(const field of askedFields\) \{/,
    "the reply must be parsed over the fields ASKED for — reading an unasked key invents an empty answer",
  );
  // Narrowing only ever applies to the text route. A vision route means the text layer was absent
  // or too thin to trust, so whatever the rules "won" from it was won from scraps.
  assert.match(
    extraction,
    /const askKeys = forRoute === "text" \? narrowedTextKeys : null;/,
    "a vision pass must always be asked for the whole schema",
  );
  // THE COST TRAP. Five of the nine core signals (email, phone, professionalSummary, degree,
  // university) are exactly the fields the narrowing drops. Score the model's reply on its own and
  // a well-read CV looks THIN, which buys a second full-price vision call on precisely the
  // documents the rules read best — a cost saving that costs more. It must score the whole record.
  assert.match(
    extraction,
    /const scored = narrowedPrimary && rule \? mergeRuleAndAiExtractions\(rule\.fields, primary\.fields\)\.fields : primary\.fields;/,
    "the escalation gate must score the MERGED record, or narrowing triggers the vision call it was meant to avoid",
  );

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

// ---------------------------------------------------------------------------
// Free OCR for scanned CVs
//
// The engine itself is not exercised here on purpose: running Tesseract costs 2-25 seconds per
// page and needs real scans, which CI has neither of. What IS pinned is every decision that makes
// OCR safe, because those are the things a later edit could quietly undo.
// ---------------------------------------------------------------------------

function runOcrTests() {
  // The defect OCR found in the email rule, and the reason it is worth having found. Tesseract read
  // "nermeenadel177@example.org" as "nermeenadel 1 77@example.org", and the address regex then
  // matched the tail — a perfectly valid-looking address for somebody else's mailbox, which nothing
  // downstream would ever have questioned.
  assert.deepEqual(findEmails("nermeenadel 1 77@example.org"), []);
  // A real address on the same line is still read, so the guard costs nothing.
  assert.deepEqual(findEmails("nermeenadel177@example.org"), ["nermeenadel177@example.org"]);
  assert.deepEqual(findEmails("ali@example-co.com"), ["ali@example-co.com"]);

  const ocr = readFileSync(new URL("../src/lib/recruitment/cv-ocr.ts", import.meta.url), "utf8");
  const extraction = readFileSync(new URL("../src/lib/recruitment/cv-extraction.ts", import.meta.url), "utf8");

  // The language file is VENDORED. Without it tesseract.js silently fetches from a CDN and writes
  // into the server's working directory; this assertion turns a missing vendored file into a red CI
  // run rather than a surprise network call from production.
  const tessdata = new URL("../assets/tessdata/eng.traineddata.gz", import.meta.url);
  assert.ok(statSync(tessdata).size > 1_000_000, "the vendored eng.traineddata.gz must be present");
  assert.match(ocr, /cacheMethod: "none"/, "OCR must never fetch or cache language data over the network");
  assert.match(ocr, /langPath: TESSDATA_DIR/, "OCR must read its language data from the vendored folder");

  // OCR REFUSES rather than guesses. The confidence gate is what makes the two Arabic scans fall
  // through to the model automatically instead of producing confident nonsense.
  assert.match(ocr, /OCR_MIN_CONFIDENCE = 60/, "the confidence gate must stay between the two measured populations");
  assert.match(ocr, /if \(confidence < OCR_MIN_CONFIDENCE\) return null;/, "a low-confidence read must be discarded");

  // The worker is always terminated — it is a forked process holding ~200 MB on a single production
  // replica that also serves payroll.
  assert.match(ocr, /finally \{[\s\S]*terminate\(\)/, "the OCR worker must be terminated in a finally block");

  // OCR is a FALLBACK, never a short-circuit. It may only run after the model has failed or is
  // unavailable, because it is not accurate enough to replace it — measured, not assumed.
  assert.ok(
    extraction.indexOf("const decision = shouldEscalateToAi(rule)") < extraction.indexOf("const ruleFromOcr"),
    "OCR must not be consulted before the rule/AI decision",
  );
  assert.ok(
    !/if \(!decision\.escalate\) return await ruleFromOcr/.test(extraction),
    "OCR must never short-circuit a working model",
  );

  // Nothing OCR produces may be auto-applied to a candidate record. cv-auto-apply writes only
  // high-confidence values, so the downgrade is the whole protection.
  assert.match(
    extraction,
    /fields\[key\] = \{ \.\.\.field, confidence: "low" \};/,
    "every OCR-derived field must be downgraded to low confidence",
  );
}

export function runRecruitmentRuleExtractionTests() {
  runNormalizationTests();
  runPatternTests();
  runSectionTests();
  runFacultyExtractionTests();
  runPersonalTests();
  runEducationTests();
  runGraduationYearTests();
  runWorkTests();
  runExperienceFieldsTests();
  runEndToEndTests();
  runMergeTests();
  runEscalationTests();
  runNarrowingTests();
  runWiringTests();
  runOcrTests();
}
