// Recruitment / ATS — reading a CV with rules alone. No AI, no network, no cost.
//
// WHY THIS EXISTS (owner instruction, 2026-08-19). CV extraction had become the most expensive
// thing in the system: the top model, at high reasoning effort, handed the whole document, run
// automatically on every inbound CV for every job title. The instruction was to invert the order —
// make the deterministic engine the PRIMARY path and strong enough to stand alone, then use AI as
// an enhancement on top of it rather than as the thing that does all the work.
//
// This module is that primary path. It returns exactly the shape the AI path returns
// (ExtractedCandidateFields — {value, confidence} per schema key), so the review board, auto-apply,
// the pending-review count and the stored jsonb row need no change, and a rule result can be merged
// with, compared against, or substituted for an AI result. See cv-extraction-merge.ts for the seam.
//
// WHAT IT IS GOOD AT, measured over the 126 readable CVs in the careers inbox on 2026-08-19 — not
// estimated, counted. `pnpm run recruitment:cv-rule-report -- "<folder of CVs>"` recounts every
// figure below from the files themselves, with no database and no OpenAI key:
//   • Contact details are effectively solved: email 98%, Egyptian mobile 93% (and 7 of the 9 misses
//     are candidates living abroad who print a foreign number).
//   • Structure is reliable: a section split on 90%, an education section on 82%.
//
// WHAT IT IS NOT GOOD AT, stated plainly so nobody is surprised: telling a promotion from a job
// change, picking the right half of an oddly-punctuated "Title — Employer", and any judgement of
// FIT. Those stay with a human, or with the AI pass once it is layered on. Every such value is
// emitted at "low" confidence, and auto-apply only ever writes "high" ones.

import type { ExtractedCandidateFields } from "@/lib/recruitment/cv-extraction-fields";
import { normalizeCvText } from "@/lib/recruitment/rule-extraction/normalize";
import type { CvRuleContext } from "@/lib/recruitment/rule-extraction/identity";
import {
  findAppliedForJobTitle,
  findEmail,
  findFullName,
  findLinkedIn,
  findNationalIdField,
  findPhone,
} from "@/lib/recruitment/rule-extraction/identity";
import {
  findAddressAndGovernorate,
  findDateOfBirth,
  findGender,
  findMaritalStatus,
  findMilitaryStatus,
  findNationality,
} from "@/lib/recruitment/rule-extraction/personal";
import {
  extractEducationHistory,
  findCertifications,
  findDegree,
  findFaculty,
  findGrade,
  findGraduationYear,
  findLanguages,
  findProfessionalSummary,
  findSkills,
  findUniversity,
} from "@/lib/recruitment/rule-extraction/education";
import { high, low, FieldCollector } from "@/lib/recruitment/rule-extraction/result";
import { linesOfKinds, sliceCvSections } from "@/lib/recruitment/rule-extraction/sections";
import {
  currentEmployerField,
  currentJobTitleField,
  currentRoleResponsibilitiesField,
  extractMedicalRepExperience,
  extractWorkHistory,
  hasPriorWorkExperienceField,
  yearsExperienceField,
} from "@/lib/recruitment/rule-extraction/work";

export type { CvRuleContext } from "@/lib/recruitment/rule-extraction/identity";
export type { WorkEntry } from "@/lib/recruitment/rule-extraction/work";

export type RuleExtractionResult = {
  readonly fields: ExtractedCandidateFields;
  /**
   * Whether this document looks like a CV at all — the same gate the merged AI classify+extract
   * call answers with `is_cv`.
   */
  readonly isCv: boolean;
  /** How many fields were filled, and how many of those are exact rather than inferred. */
  readonly filled: number;
  readonly highConfidence: number;
  /** True when the text layer had to be repaired before it could be read. */
  readonly repairedText: boolean;
};

/**
 * How much evidence must be present before a document is called a CV.
 *
 * Set at two signals deliberately. The failure this gate must avoid is the expensive one recorded
 * in cv-text-layer.ts: a real District Manager applicant was silently dropped because a
 * classifier answered "not a CV" on a thin text layer. So the bar is low, and it FAILS OPEN —
 * anything with a couple of CV-ish signals is treated as a CV and reaches a human.
 */
const MIN_CV_SIGNALS = 2;

export function runRuleCvExtraction(rawText: string, context: CvRuleContext = {}): RuleExtractionResult {
  const normalized = normalizeCvText(rawText);
  const sections = sliceCvSections(normalized.lines);
  const collector = new FieldCollector();

  // --- identity -----------------------------------------------------------
  const email = findEmail(normalized, context);
  collector.set("email", email.field);

  const name = findFullName(normalized, sections, email.all, context);
  collector.set("fullName", name);

  const { phone, whatsapp } = findPhone(normalized);
  collector.set("phone", phone);
  collector.set("whatsapp", whatsapp);
  collector.set("linkedinUrl", findLinkedIn(normalized));

  const nationalId = findNationalIdField(normalized);
  if (nationalId) {
    collector.set("nationalId", high(nationalId.nationalId));
    collector.set("dateOfBirth", high(nationalId.dateOfBirth));
    if (nationalId.birthGovernorate && nationalId.birthGovernorate !== "Born abroad") {
      collector.set("placeOfBirth", high(nationalId.birthGovernorate));
    }
  }

  // --- personal -----------------------------------------------------------
  // Searched across the WHOLE document, deliberately, unlike the address below.
  //
  // These five are read by LABEL ("Marital Status: Single"), and a label is unambiguous wherever it
  // appears — so scoping them to the header block only loses values without buying any precision.
  // It measurably did: an earlier revision confined them to header/personal/contact and found
  // military status on 7% of CVs when 21% state it, because plenty of CVs put their personal block
  // at the very bottom under no heading this module recognises.
  const searchLines = normalized.lines;

  collector.setIfAbsent("dateOfBirth", findDateOfBirth(searchLines));
  collector.set("maritalStatus", findMaritalStatus(searchLines));
  const military = findMilitaryStatus(searchLines);
  collector.set("militaryStatus", military);
  collector.set("nationality", findNationality(searchLines));
  collector.setIfAbsent(
    "gender",
    findGender(searchLines, nationalId?.gender ?? null, (military?.value as string | undefined) ?? null),
  );

  const { address, governorate } = findAddressAndGovernorate(normalized, sections);
  collector.set("address", address);
  collector.set("governorate", governorate);

  // --- professional -------------------------------------------------------
  const work = extractWorkHistory(sections);
  const headerLines = linesOfKinds(sections, ["header"]);

  collector.set("currentJobTitle", currentJobTitleField(headerLines, work));
  collector.set("currentEmployer", currentEmployerField(work));
  collector.set("currentRoleResponsibilities", currentRoleResponsibilitiesField(work));
  collector.set("yearsExperience", yearsExperienceField(normalized.text, work));
  collector.set("hasPriorWorkExperience", hasPriorWorkExperienceField(work));
  collector.set("professionalSummary", findProfessionalSummary(sections));

  const applied = findAppliedForJobTitle(context);
  collector.set("appliedForJobTitle", applied.title);
  collector.set("appliedForEvidence", applied.evidence);

  if (work.length > 0) {
    collector.set(
      "workHistory",
      low(
        work.map((entry) => ({
          employer: entry.employer,
          from: entry.from,
          isCurrent: entry.isCurrent,
          jobTitle: entry.jobTitle,
          responsibilities: entry.responsibilities,
          to: entry.to,
        })),
      ),
    );
  }

  const medicalRep = extractMedicalRepExperience(work);
  collector.set("hasMedicalRepExperience", medicalRep.hasExperience);
  collector.set("medicalRepEmployer", medicalRep.employer);
  collector.set("medicalRepExperienceFrom", medicalRep.from);
  collector.set("medicalRepExperienceTo", medicalRep.to);

  // --- education and lists ------------------------------------------------
  collector.set("university", findUniversity(sections));
  collector.set("faculty", findFaculty(sections));
  collector.set("degree", findDegree(sections));
  collector.set("grade", findGrade(sections));
  collector.set("graduationYear", findGraduationYear(sections));

  const education = extractEducationHistory(sections);
  if (education.length > 0) {
    collector.set(
      "educationHistory",
      low(education.map((entry) => ({ degree: entry.degree, institution: entry.institution, year: entry.year }))),
    );
  }

  collector.set("skills", findSkills(sections));
  collector.set("languages", findLanguages(sections));
  collector.set("certifications", findCertifications(sections));

  const fields = collector.build();
  const values = Object.values(fields);

  const signals = [
    Boolean(fields.email),
    Boolean(fields.phone),
    Boolean(fields.fullName),
    work.length > 0,
    Boolean(fields.university ?? fields.degree ?? fields.graduationYear),
    Boolean(fields.skills ?? fields.languages),
  ].filter(Boolean).length;

  return {
    fields,
    filled: values.length,
    highConfidence: values.filter((field) => field.confidence === "high").length,
    isCv: signals >= MIN_CV_SIGNALS,
    repairedText: normalized.repaired,
  };
}
