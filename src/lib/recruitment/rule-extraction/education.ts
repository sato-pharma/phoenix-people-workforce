// Recruitment / ATS — the education block, plus the list sections (skills, languages, courses).
//
// Education is the rule engine's best structured field after contact details: 82% of the careers
// inbox has a literal EDUCATION heading, 77% names a university, and the vocabulary is small and
// closed — there are only so many Egyptian universities, faculties, degrees and grades. Section
// scoping does the heavy lifting: "Cairo University" appearing in a duty bullet is not where the
// candidate studied, and only the education section is consulted.

import {
  DEGREE_KEYWORDS,
  EGYPT_UNIVERSITIES,
  FACULTY_KEYWORDS,
  GRADE_KEYWORDS,
  LANGUAGE_KEYWORDS,
  LANGUAGE_PROFICIENCY,
} from "@/lib/recruitment/rule-extraction/dictionaries";
import { containsPhrase, matchDictionary } from "@/lib/recruitment/rule-extraction/patterns";
import { high, low } from "@/lib/recruitment/rule-extraction/result";
import type { CvSection } from "@/lib/recruitment/rule-extraction/sections";
import { linesOfKind, textOfKind } from "@/lib/recruitment/rule-extraction/sections";
import type { ExtractedField } from "@/lib/recruitment/cv-extraction-fields";

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

/** Title-cases a dictionary hit so the record reads "Cairo University", never "cairo university". */
function titleCase(value: string): string {
  return value
    .split(" ")
    .map((word) => (word.length > 2 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export function findUniversity(sections: readonly CvSection[]): ExtractedField<string> | null {
  const text = textOfKind(sections, "education");
  if (!text) return null;
  // Longest first: "Misr University for Science and Technology" must beat the "university" inside it.
  for (const name of [...EGYPT_UNIVERSITIES].sort((a, b) => b.length - a.length)) {
    if (containsPhrase(text, name)) return high(name.length <= 4 ? name.toUpperCase() : titleCase(name));
  }
  // An unknown institution still names itself on the line that says "University".
  const line = linesOfKind(sections, "education").find((candidate) => /universit|academy|institute|جامعة/i.test(candidate));
  return line && line.length <= 90 ? low(line.trim()) : null;
}

export function findFaculty(sections: readonly CvSection[]): ExtractedField<string> | null {
  const text = textOfKind(sections, "education");
  if (!text) return null;
  for (const name of [...FACULTY_KEYWORDS].sort((a, b) => b.length - a.length)) {
    if (containsPhrase(text, name)) return high(titleCase(name));
  }
  return null;
}

export function findDegree(sections: readonly CvSection[]): ExtractedField<string> | null {
  const text = textOfKind(sections, "education");
  if (!text) return null;
  const matched = matchDictionary(text, DEGREE_KEYWORDS);
  return matched ? high(matched) : null;
}

export function findGrade(sections: readonly CvSection[]): ExtractedField<string> | null {
  const text = textOfKind(sections, "education");
  if (!text) return null;
  // Only when the CV frames it as a grade. "Good" is an ordinary English word and would otherwise
  // match a sentence about good communication skills.
  if (!/grade|gpa|estimate|التقدير|تقدير/i.test(text)) return null;
  const matched = matchDictionary(text, GRADE_KEYWORDS);
  return matched ? high(matched) : null;
}

/**
 * Graduation year — the LATEST plausible year in the education section.
 *
 * Latest, because the section routinely carries a range ("2015 - 2019") and the qualification is
 * dated by when it finished. Bounded to the last fifty years and to no later than next year, so a
 * stray phone fragment or a course code cannot be read as a date.
 */
export function findGraduationYear(sections: readonly CvSection[]): ExtractedField<number> | null {
  const text = textOfKind(sections, "education");
  if (!text) return null;
  const thisYear = new Date().getUTCFullYear();
  const years = [...text.matchAll(/\b(19[7-9]\d|20[0-4]\d)\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= thisYear - 50 && year <= thisYear + 1);
  if (years.length === 0) return null;
  return high(Math.max(...years));
}

export type EducationEntry = {
  readonly degree: string | null;
  readonly institution: string | null;
  readonly year: number | null;
};

/** One entry per line of the education section that names an institution or a degree. */
export function extractEducationHistory(sections: readonly CvSection[]): EducationEntry[] {
  const entries: EducationEntry[] = [];
  for (const line of linesOfKind(sections, "education")) {
    const hasInstitution = /universit|academy|institute|college|school|جامعة|معهد|أكاديمية/i.test(line);
    const degree = matchDictionary(line, DEGREE_KEYWORDS);
    if (!hasInstitution && !degree) continue;
    const year = [...line.matchAll(/\b(19[7-9]\d|20[0-4]\d)\b/g)].map((match) => Number(match[1])).pop() ?? null;
    entries.push({ degree, institution: hasInstitution ? line.replace(/\s{2,}/g, " ").trim() : null, year });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Skills, languages, certifications
// ---------------------------------------------------------------------------

/** Splits a skills block into items, whether it is one per line or comma/bullet separated. */
function splitListItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[•\-–—*]\s*/, "").trim();
    if (!cleaned) continue;
    // A long prose line is a sentence about the candidate, not a list of skills.
    if (cleaned.length > 120) continue;
    const parts = cleaned.includes("•")
      ? cleaned.split("•")
      : /[,;|]/.test(cleaned) && cleaned.length > 24
        ? cleaned.split(/[,;|]/)
        : [cleaned];
    for (const part of parts) {
      const item = part.replace(/^[•\-–—*\s]+|[\s.]+$/g, "").trim();
      if (item.length >= 2 && item.length <= 60) items.push(item);
    }
  }
  return [...new Set(items)];
}

export function findSkills(sections: readonly CvSection[]): ExtractedField<Array<Record<string, unknown>>> | null {
  const items = splitListItems(linesOfKind(sections, "skills"));
  if (items.length === 0) return null;
  // Capped: a CV that lists sixty "skills" is listing adjectives, and a review board cannot show
  // them all usefully.
  return high(items.slice(0, 30).map((name) => ({ name })));
}

export function findCertifications(sections: readonly CvSection[]): ExtractedField<Array<Record<string, unknown>>> | null {
  const items = splitListItems(linesOfKind(sections, "certifications"));
  if (items.length === 0) return null;
  return high(
    items.slice(0, 20).map((name) => {
      const year = /\b(19[7-9]\d|20[0-4]\d)\b/.exec(name);
      return year ? { name: name.replace(year[0], "").replace(/[(),\s]+$/, "").trim(), year: Number(year[1]) } : { name };
    }),
  );
}

/**
 * Languages, with proficiency where the CV states one.
 *
 * Driven by the language dictionary rather than by splitting the block into items: the section is
 * written as "Arabic: Native", "English (Very Good)", or a two-column table that collapses
 * unpredictably, and looking for the nine languages anyone actually lists is far more robust than
 * parsing whichever layout this CV used.
 */
export function findLanguages(sections: readonly CvSection[]): ExtractedField<Array<Record<string, unknown>>> | null {
  const lines = linesOfKind(sections, "languages");
  if (lines.length === 0) return null;

  const found: Array<Record<string, unknown>> = [];
  for (const entry of LANGUAGE_KEYWORDS) {
    const line = lines.find((candidate) => entry.aliases.some((alias) => containsPhrase(candidate, alias)));
    if (!line) continue;
    // Proficiency is read from the same line only — the word "Native" three lines down belongs to
    // whichever language is printed beside it, not to this one.
    const proficiency = matchDictionary(line, LANGUAGE_PROFICIENCY);
    found.push(proficiency ? { language: entry.canonical, proficiency } : { language: entry.canonical });
  }
  return found.length > 0 ? high(found) : null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * The candidate's own professional summary, copied verbatim.
 *
 * Verbatim is the point: this field exists to show a reviewer how the candidate describes
 * themselves, so paraphrasing it — which is what an AI would do — actively destroys its value.
 */
// Stored whole, never abbreviated: the owner's standing rule is that text is not truncated with an
// ellipsis anywhere a human will read it, and this value goes straight to the review board.
export function findProfessionalSummary(sections: readonly CvSection[]): ExtractedField<string> | null {
  const text = textOfKind(sections, "summary").replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (text.length < 40) return null;
  return high(text);
}
