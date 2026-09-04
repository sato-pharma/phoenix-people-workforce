// Recruitment / ATS — the three sentences a recruiter needs before picking up the phone.
//
// Strengths, gaps, and one question worth asking. Every line is BUILT FROM A FACT ALREADY ON THE
// RECORD and names the fact it came from — there is no model call here, nothing is generated, and
// nothing is asserted that the CV did not say. A briefing that reads well and is not grounded is
// the single most dangerous thing this screen could contain: it would be read as a summary of the
// document and acted on instead of it.
//
// SILENCE IS AN ANSWER. A candidate whose record holds almost nothing produces almost no briefing,
// and the panel says "there is not enough on file" rather than padding to three bullets. That is
// the owner's standing rule about never padding a list to hit a number, applied to the one screen
// where padding would be mistaken for evidence.
//
// The QUESTION is chosen from the biggest hole in the role-fit read, which is the one thing a
// two-minute phone call can actually close. It is a screening prompt, not an interview script.
//
// PURE — this renders inside a client component.

import { candidateRoleFamilyLabels, type CandidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import {
  formatYearsOfExperience,
  type CandidateScreeningFacts,
} from "@/lib/recruitment/candidate-screening-facts";
import type { RoleFitRead } from "@/lib/recruitment/role-fit";

export type RecruiterBriefing = {
  /** What is good about this CV, one clause each. Empty when the record says nothing good yet. */
  strengths: string[];
  /** What is missing or worth checking. Empty is a real answer, not a rendering bug. */
  gaps: string[];
  /** One screening question, or null when nothing on file suggests one worth asking. */
  question: string | null;
};

/**
 * The question to ask, keyed on which dimension came back weakest.
 *
 * One per dimension key, phrased as an open question rather than a yes/no: "have you done admin
 * work?" is answered "yes" by everybody, and tells a screener nothing they did not already have.
 */
const QUESTION_FOR_GAP: Record<string, string> = {
  background:
    "What did you study, and how does it connect to the work you are doing now?",
  current_role:
    "Walk me through what you are doing at the moment — the day-to-day, not the job title.",
  experience:
    "Take me through your work history since you graduated, including any gaps between roles.",
  leadership:
    "How many people have reported to you, and what were you accountable for in that team?",
  location:
    "Which areas can you realistically cover day to day, and are you able to relocate?",
  pharma:
    "Have you sold to doctors or pharmacies before? If not, what is the closest thing you have done?",
};

/** The fallback, used when every dimension is answered and there is no hole to aim at. */
const CLOSING_QUESTION =
  "What are you looking for in your next role, and what would make you leave your current one?";

function years(facts: CandidateScreeningFacts): string | null {
  const value = facts.years;
  if (!value) return null;
  return `${value.confirmed ? "" : "about "}${formatYearsOfExperience(value.value)}`;
}

/**
 * Build the briefing.
 *
 * `family` is the job being hired for, so the gaps are gaps against THAT job. Passing the
 * candidate's own current family would produce a briefing describing them as a perfect fit for
 * being themselves.
 */
export function buildRecruiterBriefing(
  facts: CandidateScreeningFacts,
  fit: RoleFitRead,
  family: CandidateRoleFamily | null,
): RecruiterBriefing {
  const strengths: string[] = [];
  const gaps: string[] = [];

  const role = facts.roleTitle;
  const employer = facts.employer;
  if (role) {
    strengths.push(
      employer
        ? `Currently ${role.value} at ${employer.value}${role.confirmed && employer.confirmed ? "" : " (read off the CV, not confirmed)"}.`
        : `Currently ${role.value}${role.confirmed ? "" : " (read off the CV, not confirmed)"}.`,
    );
  }

  const experience = years(facts);
  if (experience) {
    const met = fit.dimensions.find((dimension) => dimension.key === "experience")?.state;
    if (met === "met") strengths.push(`${experience} of work experience on the CV.`);
    else gaps.push(`Only ${experience} of work experience for a ${family ? candidateRoleFamilyLabels[family].toLowerCase() : "this"} role.`);
  }

  if (facts.pharmaRep?.value === true) {
    strengths.push("Has worked as a medical rep before.");
  } else if (facts.pharmaRep?.value === false) {
    gaps.push("No pharma or medical-rep experience on the CV.");
  }

  if (facts.background) strengths.push(`Studied ${facts.background.value}.`);

  if (facts.area) strengths.push(`Asked to work in ${facts.area.value}.`);
  else if (facts.region?.value.declared) strengths.push(`Asked to work in ${facts.region.value.label}.`);
  else if (facts.region) gaps.push(`No stated preference — the address reads ${facts.region.value.label}.`);
  else gaps.push("Nothing on the record says where they are or where they want to work.");

  if (facts.expectedSalary) strengths.push(`Asked for ${facts.expectedSalary.value}.`);
  else gaps.push("No salary expectation on file.");

  // Every dimension the record could not answer becomes a gap, named. This is the half that keeps
  // the briefing honest: a CV that says almost nothing produces a gaps list and no strengths, which
  // is exactly what the recruiter should see.
  for (const dimension of fit.dimensions) {
    if (dimension.state === "unknown") gaps.push(`${dimension.label} — nothing on the CV answers this.`);
  }

  // The weakest ANSWERED dimension first, then the unknowns — a question about something we already
  // know the answer to is a wasted call.
  const weakest =
    fit.dimensions.find((dimension) => dimension.state === "missing") ??
    fit.dimensions.find((dimension) => dimension.state === "unknown") ??
    fit.dimensions.find((dimension) => dimension.state === "partial") ??
    null;

  return {
    gaps,
    question: weakest ? (QUESTION_FOR_GAP[weakest.key] ?? CLOSING_QUESTION) : CLOSING_QUESTION,
    strengths,
  };
}
