// Recruitment / ATS — the old paper "Job Application Form", filled in from what the system already holds.
//
// THE OWNER, 2026-09-19, showing the form Sato Pharma used to hand a walk-in: "this is the old application
// form I used to use ... I want all the fields in the old to be in the new. See what's missing and add it
// in a polished way." The new application sheet (whatsapp-application-sheet.ts) carried a name, a phone, an
// email, a region and the WhatsApp questions. The old form asked for all of this, and this file is the list:
//
//   PERSONAL INFORMATION   full name · phone number · address · email · date of birth · marital status
//   EMPLOYMENT DESIRED     position · expectation for salary · employment type · date available to start
//   EDUCATION              degree / course · university · year of graduation · grade
//   PREVIOUS EMPLOYMENT    company name · position · start · end · package
//   SKILLS · REFERENCES · HOW YOU HEARD ABOUT THIS VACANCY
//
// Region stays, from the earlier sheet: it was on it, and nothing on the sheet is silently dropped.
//
// A FORM KEEPS ITS FIELDS WHEN THERE IS NOTHING TO PUT IN THEM. On the candidate record page a field with no
// value is not printed (his ruling of the same day, for that page). This is a different document: an
// application form is filled in by hand at an interview, so a field with no value stays as an empty line to
// write on, and a table keeps the rows the old form had. What the system knows is printed; what it does not
// know is left for a pen, and NEVER filled with a guess.
//
// THREE FIELDS HAVE NO SOURCE ANYWHERE IN THE SYSTEM — employment type, the package at each previous job, and
// the references. No column, no CV field and no bot question holds them (searched 2026-09-19), so they print
// as empty boxes and lines for every applicant. That is the honest state of the data, not a gap in this file:
// when the system starts recording one of them, this is the one place that reads it.
//
// PURE — no I/O. The loader reads the candidate; this turns the row and the candidate into the form.

import { CAIRO_MONTHS, utcDate } from "@/lib/format/cairo-datetime";
import { candidateSourceChannel } from "@/lib/recruitment/candidate-source-context";
import type { WhatsAppApplicantRow } from "@/lib/recruitment/whatsapp-applicant-filters";
import type { Candidate } from "@/lib/recruitment/types";

/** What the form reads of a candidate — a narrow slice, so a caller (or a test) need not build a whole one. */
export type ApplicationCandidate = Pick<
  Candidate,
  | "address"
  | "currentEmployer"
  | "currentJobTitle"
  | "dateOfBirth"
  | "declaredExpectedSalary"
  | "degree"
  | "expectedSalary"
  | "faculty"
  | "grade"
  | "graduationYear"
  | "maritalStatus"
  | "noticePeriod"
  | "positionSpecificFields"
  | "source"
  | "university"
>;

/** One labelled field. An empty `value` is an empty line to write on, never a dash and never a guess. */
export type FormCell = { label: string; value: string; note: string | null };

export type EducationRow = { course: string; university: string; year: string; grade: string };

export type EmploymentRow = { company: string; position: string; start: string; end: string };

export type ApplicationForm = {
  /** Full name, phone number, address, email, date of birth, marital status — in that reading order. */
  personal: FormCell[];
  /** Position, expectation for salary, region, date available to start. */
  desired: FormCell[];
  /** Only the rows the record holds. The empty rows the paper form had are added where it is drawn. */
  education: EducationRow[];
  employment: EmploymentRow[];
  skills: string[];
  heardAbout: FormCell;
};

/** The three boxes of "Employment type" on the old form, in its own words. Nothing records the answer. */
export const EMPLOYMENT_TYPES = ["Full-time", "Semi-full", "Part-time"] as const;

/** The exact sentence a region answer carries when they tapped one of the listed regions. */
const PLAIN_WHATSAPP_REGION_NOTE = "Their WhatsApp answer";

/**
 * A question HR added that asks WHEN they could start. The wording is HR's own, so this reads the meaning
 * rather than a key: "when could you start", "start date", "notice", "available from". A question that only
 * happens to contain the word ("Can you start commuting to Sheraton?") does not match.
 */
const START_QUESTION = /\bwhen\b[^?]*\b(start|join|begin|available)\b|\b(start|joining)\s+date\b|\bnotice\b|\bavailab/i;

function clean(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "";
}

function joined(parts: readonly string[], separator: string): string {
  return parts.filter(Boolean).join(separator);
}

function capitalised(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** The stored blocks that repeat (a job, a qualification), keeping only the ones that are real objects. */
function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
}

/**
 * "1996-05-14" as "14 May 1996", read as a calendar date and never through a time zone: a birthday is not an
 * instant, and shifting it into Cairo time could move it by a day. `utcDate` is the app's date-only formatter
 * and shares its one month table (with "Sept"), so this is not a second copy of either. Anything that is not
 * a full date is printed as it was stored, because a half date is still what the record says.
 */
export function formatDateOfBirth(raw: unknown): string {
  const text = clean(raw);
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return text;
  const shown = utcDate(text);
  return shown === "—" ? text : shown;
}

/** "2021-09-01" as "Sept 2021", and "2021" as "2021". The day is never printed: the old form asked month and year. */
export function formatMonthYear(raw: unknown): string {
  const text = clean(raw);
  const match = /^(\d{4})(?:-(\d{2}))?/.exec(text);
  if (!match) return text;
  const month = match[2] ? CAIRO_MONTHS[Number(match[2]) - 1] : undefined;
  return month ? `${month} ${match[1]}` : match[1];
}

function educationRows(candidate: ApplicationCandidate | null): EducationRow[] {
  const history = objects(candidate?.positionSpecificFields?.educationHistory)
    .map((item) => ({
      course: joined([clean(item.degree), clean(item.fieldOfStudy)], " · "),
      grade: clean(item.grade),
      university: clean(item.institution),
      year: clean(item.year),
    }))
    .filter((row) => Object.values(row).some(Boolean));
  if (history.length > 0 || !candidate) return history;

  // A record with no education history block still may have its degree, university and year as plain columns.
  const single = {
    course: joined([clean(candidate.degree), clean(candidate.faculty)], " · "),
    grade: clean(candidate.grade),
    university: clean(candidate.university),
    year: clean(candidate.graduationYear),
  };
  return Object.values(single).some(Boolean) ? [single] : [];
}

function employmentRows(candidate: ApplicationCandidate | null): EmploymentRow[] {
  const history = objects(candidate?.positionSpecificFields?.workHistory)
    .map((item) => ({
      company: clean(item.employer),
      // "Present" only when the CV said so. The reader sets `isCurrent` when the end of the range was the word
      // "Present" and leaves `to` empty (rule-extraction/patterns.ts). An empty `to` WITHOUT that flag means it
      // found no end date at all, and the paper must not claim a current job the CV never named.
      end: formatMonthYear(item.to) || (item.isCurrent === true ? "Present" : ""),
      position: clean(item.jobTitle),
      start: formatMonthYear(item.from),
    }))
    .filter((row) => Object.values(row).some(Boolean));
  if (history.length > 0 || !candidate) return history;

  // No job history block, but the CV reader may still have named where they work now.
  const current = { company: clean(candidate.currentEmployer), end: "", position: clean(candidate.currentJobTitle), start: "" };
  return current.company || current.position ? [current] : [];
}

function skillList(candidate: ApplicationCandidate | null): string[] {
  const raw = candidate?.positionSpecificFields?.skills;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const item of raw) {
    const name = clean(typeof item === "object" && item !== null ? (item as { name?: unknown }).name : item);
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      skills.push(name);
    }
  }
  return skills;
}

/**
 * The salary in their own words when they gave any (the WhatsApp answer, then what the record kept of it),
 * else the number the CV reader or an admin typed. The figure carries no currency: none is stored with it.
 */
function expectedSalary(row: WhatsAppApplicantRow, candidate: ApplicationCandidate | null): string {
  const answered = clean(row.answers.find((answer) => answer.key === "salary")?.answer);
  if (answered) return answered;
  const declared = clean(candidate?.declaredExpectedSalary);
  if (declared) return declared;
  const figure = candidate?.expectedSalary;
  return typeof figure === "number" && Number.isFinite(figure) ? figure.toLocaleString("en-US") : "";
}

function availableToStart(row: WhatsAppApplicantRow, candidate: ApplicationCandidate | null): { value: string; note: string | null } {
  const asked = row.answers.find((answer) => answer.key.startsWith("extra:") && START_QUESTION.test(answer.question));
  const answered = clean(asked?.answer);
  if (answered) return { note: null, value: answered };
  const notice = clean(candidate?.noticePeriod);
  return notice ? { note: "Notice period on the record", value: notice } : { note: null, value: "" };
}

function cell(label: string, value: unknown, note: string | null = null): FormCell {
  return { label, note, value: clean(value) };
}

/** The old form, filled in from this applicant's row and record. */
export function buildApplicationForm(input: {
  row: WhatsAppApplicantRow;
  jobTitle: string;
  contact: { email: string | null; phone: string | null };
  candidate: ApplicationCandidate | null;
}): ApplicationForm {
  const { candidate, contact, jobTitle, row } = input;

  const region = row.region;
  const regionNote = region && region.sourceLine !== PLAIN_WHATSAPP_REGION_NOTE ? region.sourceLine : null;
  const start = availableToStart(row, candidate);

  // A manual entry has no channel to name, and "Manual" is not how anyone heard about a vacancy.
  const channel = candidate ? candidateSourceChannel(candidate.source, null) : null;

  return {
    desired: [
      cell("Position", jobTitle),
      cell("Expectation for salary", expectedSalary(row, candidate)),
      cell("Region", region?.label, regionNote),
      cell("Date available to start", start.value, start.note),
    ],
    education: educationRows(candidate),
    employment: employmentRows(candidate),
    heardAbout: cell("How you heard about this vacancy", channel && channel.key !== "manual" ? channel.label : ""),
    personal: [
      cell("Full name", row.name),
      cell("Phone number", contact.phone),
      cell("Address", candidate?.address),
      cell("Email", contact.email),
      cell("Date of birth", formatDateOfBirth(candidate?.dateOfBirth)),
      cell("Marital status", capitalised(clean(candidate?.maritalStatus))),
    ],
    skills: skillList(candidate),
  };
}
