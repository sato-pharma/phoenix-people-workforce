// Recruitment / ATS — the personal block: birth, gender, marital and military status, address.
//
// These fields are labelled far more often than they are implied ("Date of Birth: 12/5/1996",
// "Military Status: Exempted"), so the workhorse here is a label reader rather than a set of
// bespoke regexes. Presence in the corpus: a birth-date label on 26% of CVs, marital status on 22%,
// military status on 21%. Absent is the NORMAL case, and a rule that guesses to avoid an empty slot
// would be wrong far more often than it was right.
//
// Military status is worth the care it gets here. It applies to men only, "Exempted" (settled
// forever) and "Postponed" (expires, and the candidate may vanish for a year) mean completely
// different things to a hiring manager, and getting it wrong wastes an interview.

import {
  EGYPT_DISTRICTS,
  EGYPT_GOVERNORATES,
  MARITAL_STATUS_KEYWORDS,
  MILITARY_STATUS_KEYWORDS,
  NATIONALITY_KEYWORDS,
} from "@/lib/recruitment/rule-extraction/dictionaries";
import { containsPhrase, matchDictionary } from "@/lib/recruitment/rule-extraction/patterns";
import { high, low } from "@/lib/recruitment/rule-extraction/result";
import type { CvSection } from "@/lib/recruitment/rule-extraction/sections";
import { linesOfKinds } from "@/lib/recruitment/rule-extraction/sections";
import type { NormalizedCvText } from "@/lib/recruitment/rule-extraction/normalize";
import type { ExtractedField } from "@/lib/recruitment/cv-extraction-fields";

// ---------------------------------------------------------------------------
// Labelled values
// ---------------------------------------------------------------------------

/**
 * Reads "Label: value", tolerating the separators and decoration a CV puts in between.
 *
 * Also handles the layout where the label ends the line and the value begins the next one, which is
 * what a two-column "Personal Information" table collapses to in a text layer.
 */
export function readLabelledValue(lines: readonly string[], labels: readonly string[]): string | null {
  for (const [index, line] of lines.entries()) {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // The label may begin the line or follow any non-letter (a bullet, a pipe, a comma). It must
      // NOT be allowed to start mid-word, or "military" would match inside "paramilitary".
      const boundary = `(?:^|(?<![\\p{L}\\p{N}]))${escaped}`;
      // The separator is REQUIRED when a value follows on the same line. Without that, "military"
      // occurring in a sentence would capture the rest of the sentence as a status.
      const inline = new RegExp(`${boundary}\\s*[:：\\-–]\\s*(.+)$`, "iu").exec(line);
      if (!inline) {
        // "Marital Status" (or "Marital Status:") alone on its line — a two-column personal table
        // collapses to exactly this, with the value on the following line.
        if (new RegExp(`${boundary}\\s*[:：]?\\s*$`, "iu").test(line)) {
          const next = lines[index + 1]?.trim();
          if (next && next.length > 0 && next.length <= 60) return next;
        }
        continue;
      }
      {
        // Stop at the next column separator or the next "Label:" on the same line. CVs routinely
        // pack a whole personal block onto one line — "Date of Birth: August 23, 1997 | Marital
        // Status: Single | Military Status: Exempted" — and without this the first label would
        // swallow the other two as its value.
        const value = (inline[1] ?? "")
          .split(/\s*[|•]\s*/)[0]!
          .split(/\s{2,}(?=[A-Za-z][A-Za-z ]{2,20}\s*[:：])/)[0]!
          .trim()
          .replace(/^[:\-–\s]+/, "")
          .trim();
        if (value.length > 0) return value;
        // The separator was there but everything after it was decoration — fall through to the
        // following line rather than returning an empty string.
        const next = lines[index + 1]?.trim();
        if (next && next.length > 0 && next.length <= 60) return next;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date of birth
// ---------------------------------------------------------------------------

const MONTH_NAMES: Readonly<Record<string, number>> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  const age = new Date().getUTCFullYear() - year;
  if (age < 15 || age > 80) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * A full calendar date, in the forms a CV writes one.
 *
 * Numeric dates are read DAY-first. That is the Egyptian convention and this is an Egypt-only
 * recruitment pipeline, but it IS an assumption: "05/06/1996" is genuinely ambiguous and is
 * therefore reported as low confidence by the caller. When the first number exceeds 12 the reading
 * is forced and no assumption is involved.
 */
export function parseFullDate(raw: string): { readonly iso: string; readonly ambiguous: boolean } | null {
  const value = raw.trim().toLowerCase();

  // 1995-01-20
  const iso = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(value);
  if (iso) {
    const result = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (result) return { ambiguous: false, iso: result };
  }

  // 20 January 1995  /  January 20, 1995
  const dayMonthName = /(\d{1,2})\s*(?:st|nd|rd|th)?[\s,]+([a-z]{3,9})[\s,]+(\d{4})/.exec(value);
  if (dayMonthName) {
    const month = MONTH_NAMES[dayMonthName[2] ?? ""];
    if (month) {
      const result = isoDate(Number(dayMonthName[3]), month, Number(dayMonthName[1]));
      if (result) return { ambiguous: false, iso: result };
    }
  }
  const monthNameDay = /([a-z]{3,9})[\s,]+(\d{1,2})\s*(?:st|nd|rd|th)?[\s,]+(\d{4})/.exec(value);
  if (monthNameDay) {
    const month = MONTH_NAMES[monthNameDay[1] ?? ""];
    if (month) {
      const result = isoDate(Number(monthNameDay[3]), month, Number(monthNameDay[2]));
      if (result) return { ambiguous: false, iso: result };
    }
  }

  // 20/1/1995 — day first.
  const numeric = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(value);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = Number(numeric[3]);
    const dayFirst = isoDate(year, second, first);
    if (first > 12 && dayFirst) return { ambiguous: false, iso: dayFirst };
    if (dayFirst) return { ambiguous: second <= 12, iso: dayFirst };
    const monthFirst = isoDate(year, first, second);
    if (monthFirst) return { ambiguous: false, iso: monthFirst };
  }

  return null;
}

const BIRTH_LABELS = ["date of birth", "birth date", "birthdate", "born on", "born", "d.o.b", "dob", "تاريخ الميلاد", "الميلاد"];

export function findDateOfBirth(lines: readonly string[]): ExtractedField<string> | null {
  const labelled = readLabelledValue(lines, BIRTH_LABELS);
  if (labelled) {
    const parsed = parseFullDate(labelled);
    if (parsed) return parsed.ambiguous ? low(parsed.iso) : high(parsed.iso);
    // "Date of Birth: 1996" — a year alone is still worth keeping.
    const yearOnly = /\b(19[6-9]\d|20[0-1]\d)\b/.exec(labelled);
    if (yearOnly) return low(`${yearOnly[1]}-01-01`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gender
// ---------------------------------------------------------------------------

const GENDER_LABELS = ["gender", "sex", "النوع", "الجنس"];

/**
 * Gender, in strict order of how much the document actually SAID it.
 *
 * The national ID is exact (its 13th digit encodes sex). An explicit label is exact. A military
 * status of Exempted/Completed/Postponed implies a man, because conscription in Egypt applies to
 * men — a sound inference, but an inference, so it is marked low.
 *
 * A name is deliberately NOT used to infer gender anywhere in this file. It is the obvious next
 * idea and it is the wrong one: it is unreliable across transliterations and it would write a
 * guess about a person into a column that looks like a fact.
 */
export function findGender(
  lines: readonly string[],
  fromNationalId: "Male" | "Female" | null,
  militaryStatus: string | null,
): ExtractedField<string> | null {
  if (fromNationalId) return high(fromNationalId);

  const labelled = readLabelledValue(lines, GENDER_LABELS);
  if (labelled) {
    const lower = labelled.toLowerCase();
    if (/^(male|m|ذكر)\b/.test(lower)) return high("Male");
    if (/^(female|f|أنثى|انثى)\b/.test(lower)) return high("Female");
  }

  if (militaryStatus && militaryStatus !== "Not applicable") return low("Male");
  return null;
}

// ---------------------------------------------------------------------------
// Marital, military, nationality
// ---------------------------------------------------------------------------

const MARITAL_LABELS = ["marital status", "marital", "social status", "الحالة الاجتماعية", "الحاله الاجتماعيه"];
const MILITARY_LABELS = [
  "military status", "military situation", "military service", "military position", "military",
  "الموقف من التجنيد", "الخدمة العسكرية", "التجنيد",
];
const NATIONALITY_LABELS = ["nationality", "citizenship", "الجنسية"];

export function findMaritalStatus(lines: readonly string[]): ExtractedField<string> | null {
  const labelled = readLabelledValue(lines, MARITAL_LABELS);
  if (labelled) {
    const matched = matchDictionary(labelled, MARITAL_STATUS_KEYWORDS);
    if (matched) return high(matched);
  }
  return null;
}

export function findMilitaryStatus(lines: readonly string[]): ExtractedField<string> | null {
  const labelled = readLabelledValue(lines, MILITARY_LABELS);
  if (labelled) {
    const matched = matchDictionary(labelled, MILITARY_STATUS_KEYWORDS);
    if (matched) return high(matched);
  }
  return null;
}

export function findNationality(lines: readonly string[]): ExtractedField<string> | null {
  const labelled = readLabelledValue(lines, NATIONALITY_LABELS);
  if (labelled) {
    const matched = matchDictionary(labelled, NATIONALITY_KEYWORDS);
    if (matched) return high(matched);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Address and governorate
// ---------------------------------------------------------------------------

const ADDRESS_LABELS = ["address", "location", "residence", "based in", "living in", "العنوان", "محل الإقامة", "الإقامة"];

/**
 * The governorate, resolved from a DISTRICT first and only then from a governorate name.
 *
 * District-first is the whole point. Egyptians write where they live as a district — "Nasr City",
 * "Maadi", "6th of October", "El Khanka" — so a rule that only knew the 27 governorate names would
 * answer "unknown" for most CVs that state their address perfectly clearly. The three mappings that
 * are routinely got wrong by hand are pinned in the dictionary: 6th of October is Giza, 10th of
 * Ramadan is Sharqia, and Obour/Khanka/Shubra El Kheima are Qalyubia — none of them Cairo.
 */
export function resolveGovernorate(text: string): { readonly governorate: string; readonly viaDistrict: boolean } | null {
  for (const entry of EGYPT_DISTRICTS) {
    if (entry.aliases.some((alias) => containsPhrase(text, alias))) {
      return { governorate: entry.governorate, viaDistrict: true };
    }
  }
  for (const entry of EGYPT_GOVERNORATES) {
    if (entry.aliases.some((alias) => containsPhrase(text, alias))) {
      return { governorate: entry.canonical, viaDistrict: false };
    }
  }
  return null;
}

export function findAddressAndGovernorate(
  normalized: NormalizedCvText,
  sections: readonly CvSection[],
): { readonly address: ExtractedField<string> | null; readonly governorate: ExtractedField<string> | null } {
  const contactLines = linesOfKinds(sections, ["header", "contact", "personal"]);

  const labelled = readLabelledValue(contactLines.length > 0 ? contactLines : normalized.lines, ADDRESS_LABELS);
  let address: ExtractedField<string> | null = null;
  if (labelled && labelled.length <= 120) address = high(labelled);

  // No "Address:" label — a modern CV prints the city on the contact line instead
  // ("Cairo, Egypt | +20 10 … | name@…"). Take the shortest header line that names a real place.
  if (!address) {
    const placeLine = contactLines
      .filter((line) => line.length <= 80 && !/@/.test(line) && resolveGovernorate(line))
      .sort((a, b) => a.length - b.length)[0];
    if (placeLine) address = low(placeLine.replace(/\s*[|•]\s*/g, ", ").replace(/,\s*,/g, ",").trim());
  }

  // Resolve the governorate from the address when there is one, and from the contact block
  // otherwise. Never from the whole CV: an employer's head office or a university's city would be
  // read as the candidate's home.
  const haystack = address?.value ?? contactLines.join("\n");
  const resolved = resolveGovernorate(haystack);

  // A district and a governorate name are equally exact once matched as whole words — the
  // difference between them is which dictionary answered, not how much to trust the answer.
  return { address, governorate: resolved ? high(resolved.governorate) : null };
}
