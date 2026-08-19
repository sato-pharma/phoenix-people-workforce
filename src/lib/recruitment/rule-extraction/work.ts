// Recruitment / ATS — employment history, and the fields derived from it.
//
// This is the hardest thing the rule engine attempts, and the honest place to say why. A CV has no
// standard for how a job is written. The corpus shows at least four date layouts and three ways of
// joining a title to an employer, and plenty of CVs put the date on a different line from the title
// it belongs to.
//
// The design that survives that: DATES ARE THE ANCHOR. A line carrying a parseable date range is
// almost certainly the start of a job entry, and 79% of CVs have at least one. Everything else —
// which half is the title, which is the employer, which lines are duties — is decided relative to
// that anchor. Guessing job boundaries from typography or indentation is hopeless in a text layer,
// and guessing them from job-title keywords alone produces an entry for every bullet that says
// "supported the manager".
//
// What this module does NOT claim to do: it will not reliably tell a promotion from a job change at
// the same employer, and it will not always pick the right half of "Senior HR Specialist — Kazyon"
// when a CV uses an unusual separator. Those are exactly the judgements the AI enhancement pass is
// for. The rule layer's job is to be RIGHT about what it does emit and to mark the rest low.

import {
  JOB_TITLE_KEYWORDS,
  MEDICAL_REP_TITLE_KEYWORDS,
  PHARMA_EMPLOYER_KEYWORDS,
  RESPONSIBILITY_VERBS,
} from "@/lib/recruitment/rule-extraction/dictionaries";
import type { ParsedDateRange } from "@/lib/recruitment/rule-extraction/patterns";
import { containsPhrase, parseDateRange, stripDateRange, toIsoDate } from "@/lib/recruitment/rule-extraction/patterns";
import { high, low } from "@/lib/recruitment/rule-extraction/result";
import type { CvSection } from "@/lib/recruitment/rule-extraction/sections";
import { linesOfKind } from "@/lib/recruitment/rule-extraction/sections";
import type { ExtractedField } from "@/lib/recruitment/cv-extraction-fields";

export type WorkEntry = {
  readonly jobTitle: string | null;
  readonly employer: string | null;
  /** YYYY-MM-DD. */
  readonly from: string | null;
  /** YYYY-MM-DD, or null when the job is current. */
  readonly to: string | null;
  readonly isCurrent: boolean;
  readonly responsibilities: string | null;
};

/** The separators a CV uses between a job title and its employer, longest/least ambiguous first. */
const TITLE_EMPLOYER_SEPARATORS: readonly RegExp[] = [
  /\s+—\s+/,
  /\s+–\s+/,
  /\s+-\s+/,
  /\s+\|\s+/,
  /\s+@\s+/,
  /\s+\bat\b\s+/i,
  /\s*\/\s*/,
  /\s*,\s*/,
];

/**
 * Splits "Senior HR Specialist — Kazyon Egypt" into its two halves.
 *
 * Which half is which is decided by job-title vocabulary, not by position: both "Title - Employer"
 * and "Employer - Title" occur, and a CV that writes "Kazyon Egypt / HR Specialist" would otherwise
 * be recorded with the company as the person's job.
 */
export function splitTitleAndEmployer(raw: string): { readonly jobTitle: string | null; readonly employer: string | null } {
  const text = raw.replace(/\s{2,}/g, " ").trim();
  if (!text) return { employer: null, jobTitle: null };

  for (const separator of TITLE_EMPLOYER_SEPARATORS) {
    const parts = text.split(separator).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;

    const left = parts[0]!;
    const right = parts.slice(1).join(", ");
    const leftIsTitle = looksLikeJobTitle(left);
    const rightIsTitle = looksLikeJobTitle(right);

    if (leftIsTitle && !rightIsTitle) return { employer: right, jobTitle: left };
    if (rightIsTitle && !leftIsTitle) return { employer: left, jobTitle: right };
    // Both or neither look like a title — fall back to the common order.
    return { employer: right, jobTitle: left };
  }

  return looksLikeJobTitle(text) ? { employer: null, jobTitle: text } : { employer: text, jobTitle: null };
}

export function looksLikeJobTitle(value: string): boolean {
  return JOB_TITLE_KEYWORDS.some((keyword) => containsPhrase(value, keyword));
}

function looksLikeResponsibility(line: string): boolean {
  if (/^[•\-–—*]/.test(line.trim())) return true;
  if (line.trim().length > 90) return true;
  const lower = line.toLowerCase();
  return RESPONSIBILITY_VERBS.some((verb) => containsPhrase(lower, verb));
}

/**
 * Reads the experience section into entries.
 *
 * The scan walks the section keeping a "current entry" open. A line with a date range closes the
 * previous entry and opens a new one; a line without one either supplies the entry's title/employer
 * (if the date line carried nothing but dates, which is a common two-line layout) or is collected
 * as a responsibility.
 */
export function extractWorkHistory(sections: readonly CvSection[]): WorkEntry[] {
  const lines = linesOfKind(sections, "experience");
  if (lines.length === 0) return [];

  const entries: WorkEntry[] = [];
  let open: { range: ParsedDateRange; heading: string; duties: string[] } | null = null;

  const close = () => {
    if (!open) return;
    const { employer, jobTitle } = splitTitleAndEmployer(open.heading);
    entries.push({
      employer,
      from: toIsoDate(open.range.from),
      isCurrent: open.range.isCurrent,
      jobTitle,
      responsibilities: open.duties.length > 0 ? open.duties.join("\n") : null,
      to: open.range.to ? toIsoDate(open.range.to) : null,
    });
    open = null;
  };

  for (const line of lines) {
    const range = parseDateRange(line);
    if (range) {
      close();
      open = { duties: [], heading: stripDateRange(line), range };
      continue;
    }
    if (!open) continue;

    // The date line held only dates, so the title/employer is the line that follows it.
    if (open.heading.length === 0 && !looksLikeResponsibility(line)) {
      open.heading = line.trim();
      continue;
    }
    open.duties.push(line.replace(/^[•\-–—*]\s*/, "").trim());
  }
  close();

  // Most recent first, so "the current job" is entries[0] under either CV ordering.
  return entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return (b.from ?? "").localeCompare(a.from ?? "");
  });
}

// ---------------------------------------------------------------------------
// Fields derived from the history
// ---------------------------------------------------------------------------

export function currentEmployerField(entries: readonly WorkEntry[]): ExtractedField<string> | null {
  const current = entries.find((entry) => entry.isCurrent) ?? entries[0];
  return current?.employer ? low(current.employer) : null;
}

export function currentRoleResponsibilitiesField(entries: readonly WorkEntry[]): ExtractedField<string> | null {
  const current = entries.find((entry) => entry.isCurrent) ?? entries[0];
  return current?.responsibilities ? low(current.responsibilities) : null;
}

/**
 * The candidate's current or most recent job title.
 *
 * Prefers a title printed under the NAME at the top of the CV — that is the candidate's own
 * statement of what they are, it is what a modern CV puts there, and it is not entangled with any
 * date parsing. The first work entry is the fallback.
 */
export function currentJobTitleField(
  headerLines: readonly string[],
  entries: readonly WorkEntry[],
): ExtractedField<string> | null {
  const headline = headerLines
    .slice(0, 6)
    .map((line) => line.trim())
    .find((line) => line.length >= 6 && line.length <= 70 && !/[@]/.test(line) && !/\d{4}/.test(line) && looksLikeJobTitle(line));
  if (headline) return high(headline);

  const current = entries.find((entry) => entry.isCurrent) ?? entries[0];
  return current?.jobTitle ? low(current.jobTitle) : null;
}

const YEARS_PHRASE = /(\d{1,2})\s*\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+\w+){0,3}?\s+experience/i;
const YEARS_PHRASE_ARABIC = /(\d{1,2})\s*(?:\+)?\s*(?:سنوات|سنة)\s+(?:من\s+)?(?:الخبرة|خبرة)/;

/**
 * Total years of experience.
 *
 * A CV that STATES a number is believed — it is the candidate's own claim and the number a
 * recruiter screens on. Otherwise it is computed by summing the work history's months, which is an
 * estimate and marked low.
 *
 * Overlapping jobs are merged rather than added. Summing raw durations is the obvious
 * implementation and it inflates: a candidate who held a part-time role alongside a full-time one
 * would be credited with both, and someone with three concurrent entries could pass ten years of
 * experience before the age of thirty.
 */
export function yearsExperienceField(text: string, entries: readonly WorkEntry[]): ExtractedField<number> | null {
  const stated = YEARS_PHRASE.exec(text) ?? YEARS_PHRASE_ARABIC.exec(text);
  if (stated) {
    const years = Number(stated[1]);
    if (Number.isFinite(years) && years > 0 && years <= 50) return high(years);
  }

  const periods = entries
    .filter((entry) => entry.from)
    .map((entry) => ({
      end: entry.to ? monthIndex(entry.to) : monthIndex(new Date().toISOString().slice(0, 10)),
      start: monthIndex(entry.from!),
    }))
    .filter((period) => period.end >= period.start)
    .sort((a, b) => a.start - b.start);
  if (periods.length === 0) return null;

  let months = 0;
  let cursor = -1;
  for (const period of periods) {
    const start = Math.max(period.start, cursor + 1);
    if (period.end >= start) {
      months += period.end - start + 1;
      cursor = period.end;
    }
  }
  const years = Math.round((months / 12) * 10) / 10;
  return years > 0 ? low(years) : null;
}

function monthIndex(iso: string): number {
  const [year, month] = iso.split("-").map(Number);
  return (year ?? 0) * 12 + ((month ?? 1) - 1);
}

export function hasPriorWorkExperienceField(entries: readonly WorkEntry[]): ExtractedField<boolean> | null {
  // Only ever answers TRUE. An empty history means "no job was PARSED", which is not the same as
  // "this person has never worked" — writing false would state a fact about the candidate on the
  // strength of a layout this module failed to read.
  return entries.length > 0 ? high(true) : null;
}

// ---------------------------------------------------------------------------
// Pharma / medical-rep experience
// ---------------------------------------------------------------------------

export type MedicalRepFindings = {
  readonly hasExperience: ExtractedField<boolean> | null;
  readonly employer: ExtractedField<string> | null;
  readonly from: ExtractedField<string> | null;
  readonly to: ExtractedField<string> | null;
};

/**
 * Whether the candidate has carried a medical/pharma sales bag, and where.
 *
 * Fires on a medical-rep JOB TITLE, or on an ordinary title at an employer whose name marks the
 * pharmaceutical industry. Like hasPriorWorkExperience it only ever answers true: the employer
 * dictionary cannot be exhaustive, so a miss means "not recognised", never "no such experience".
 */
export function extractMedicalRepExperience(entries: readonly WorkEntry[]): MedicalRepFindings {
  const empty: MedicalRepFindings = { employer: null, from: null, hasExperience: null, to: null };

  const match = entries.find((entry) => {
    const title = entry.jobTitle ?? "";
    const employer = entry.employer ?? "";
    if (MEDICAL_REP_TITLE_KEYWORDS.some((keyword) => containsPhrase(title, keyword))) return true;
    return PHARMA_EMPLOYER_KEYWORDS.some((keyword) => containsPhrase(employer, keyword));
  });
  if (!match) return empty;

  return {
    employer: match.employer ? low(match.employer) : null,
    from: match.from ? low(match.from) : null,
    hasExperience: high(true),
    to: match.to ? low(match.to) : null,
  };
}
