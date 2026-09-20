// Recruitment / ATS — taking ONE education line apart.
//
// A CV writes an education entry as a single line — "Bachelor of Commerce | Banha University, Egypt
// (May 1997)". The rule engine used to store that whole line in the `institution` column and leave
// the degree, the field of study, the university and the year for whoever read the record to
// untangle; the printed application then showed "Bachelor of Commerce | Banha University, Egypt
// (May 1997)" under University and nothing under Course (owner, 2026-09-19, on a real record).
//
// This splits the line into its parts. It is pure — text in, parts out — so the extractor and the
// repair of already-stored rows share one reading.
//
// TWO RULES THE WHOLE FILE SERVES:
//   1. Text is never lost. Everything on the line that is not a date, a grade, a bullet or a filler
//      word ("Holding", "Attested") lands in one of the five parts, in the CV's own wording.
//   2. When the line does not split cleanly, the answer is the OLD answer, not a guess — the whole
//      line in `institution`, exactly what was stored before. A sentence, a course blurb, two entries
//      run together and a line that ends mid-phrase all fall back, so a bad reading can never be
//      WORSE than no reading.

import { DEGREE_KEYWORDS, EGYPT_UNIVERSITIES, FACULTY_KEYWORDS } from "@/lib/recruitment/rule-extraction/dictionaries";
import {
  containsPhrase,
  matchDictionary,
  parseDateRange,
  PRESENT_WORDS,
} from "@/lib/recruitment/rule-extraction/patterns";

export type EducationParts = {
  /** The level, canonical: Bachelor · Master · Diploma · PhD (a qualifier such as "Higher" is kept in front). */
  readonly degree: string | null;
  /** The subject or faculty, as the CV wrote it. */
  readonly fieldOfStudy: string | null;
  /** The grade or GPA, as the CV wrote it. */
  readonly grade: string | null;
  /** The university, academy, institute or school — and a place written straight after it. */
  readonly institution: string | null;
  /** The graduation year; null for a degree still in progress. */
  readonly year: number | null;
};

// ---------------------------------------------------------------------------
// Year
// ---------------------------------------------------------------------------

const YEAR_PATTERN = /\b(19[7-9]\d|20[0-4]\d)\b/g;

/**
 * Whether `line` describes a degree still in progress ("2023 - Present", "2023 – حتى الآن") rather
 * than one that has finished. Such a line's own start year is not a graduation year — a student
 * still enrolled must never read as having graduated the year they started.
 */
export function isOngoingEducationLine(line: string): boolean {
  const range = parseDateRange(line);
  if (range) return range.isCurrent;
  // parseDateRange's own "to" side only recognises a fixed short list of present words, missing
  // "till now" and the Arabic forms PRESENT_WORDS carries — still worth a direct check so a CV
  // written with one of those does not fall through as a completed degree.
  return /\b(19[7-9]\d|20[0-4]\d)\b/.test(line) && PRESENT_WORDS.some((word) => containsPhrase(line, word));
}

/** The LAST year written on a finished entry — a range is dated by when it ended; none while it runs. */
function graduationYear(line: string): number | null {
  if (isOngoingEducationLine(line)) return null;
  return [...line.matchAll(YEAR_PATTERN)].map((match) => Number(match[1])).pop() ?? null;
}

// ---------------------------------------------------------------------------
// Dates and grades — cut out of the text before the rest is read
// ---------------------------------------------------------------------------

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const YEAR = "(?:19[7-9]\\d|20[0-4]\\d)";
// "May 1997", "June, 2018", "01/2021", "1999-06" — a month, in words or digits, is part of the date.
const DATE_POINT = `(?:(?:${MONTH}\\.?,?\\s*|\\d{1,2}\\s*[/.]\\s*)?${YEAR}(?:-(?:0[1-9]|1[0-2])(?!\\d))?)`;
const DATE_END = `(?:${DATE_POINT}|${MONTH}(?![\\p{L}])\\.?|present|current(?:ly)?|now|till\\s+now|to\\s+date|حتى\\s+الآن|الآن)`;
const DATE_SPAN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:from\\s+)?(?:(?:graduat(?:ed|ion|e)|class\\s+of|expected|since)\\s*[:\\-]?\\s*(?:in\\s+)?)?${DATE_POINT}(?:\\s*(?:-|to|until|till)\\s*${DATE_END})?(?![\\p{L}\\p{N}])`,
  "giu",
);

/** Every date on the line replaced by a hard break, so the words either side of it stay apart. */
function withoutDates(text: string): string {
  return text
    .replace(DATE_SPAN, " | ")
    .replace(/\(\s*\|\s*/g, "(")
    .replace(/\s*\|\s*\)/g, ")");
}

const GRADE_WORD =
  "(?:excellent|very\\s+good|good)\\s+with\\s+honou?rs?|very\\s+good|excellent|good|pass|acceptable|جيد\\s+جداً?|امتياز|جيد|مقبول";
const GRADE_NUMBER = "\\d{1,3}(?:[.,]\\d{1,3})?\\s*(?:/\\s*\\d{1,3}(?:[.,]\\d{1,3})?|%)?";
const GRADE_VALUE = `(?:${GRADE_WORD}|${GRADE_NUMBER})(?:\\s*\\(\\s*\\d{1,3}(?:[.,]\\d{1,2})?\\s*%?\\s*\\))?`;
const GRADE_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])((?:(?:first|second|third|fourth|last|1st|2nd|3rd|4th|current|cumulative)[\\s-]*(?:year\\s+|semester\\s+)?)?)(?:grade|gpa|cgpa|estimate|التقدير|تقدير)\\s*(?:is|of)?\\s*[:\\-]?\\s*(${GRADE_VALUE})(?![\\p{L}\\p{N}])`,
  "iu",
);
const GRADE_ONLY = new RegExp(`^(?:${GRADE_WORD})$`, "iu");

/**
 * Cuts the grade out of the text. It is only read where the CV labels it ("Grade: Good", "GPA 3.7") —
 * a bare "Good" inside a sentence is an ordinary word — and a grade that belongs to ONE year
 * ("First-year GPA 3.55") is kept whole with its qualifier, because it is not the graduation grade and
 * must not read as one.
 */
function pullGrade(text: string): { text: string; grade: string | null } {
  const match = GRADE_PATTERN.exec(text);
  if (!match) return { grade: null, text };
  const qualifier = (match[1] ?? "").trim();
  const value = (match[2] ?? "").replace(/\s+/g, " ").trim();
  const grade = qualifier ? match[0].replace(/\s+/g, " ").trim() : value;
  return { grade, text: `${text.slice(0, match.index)} | ${text.slice(match.index + match[0].length)}` };
}

// ---------------------------------------------------------------------------
// Tidying
// ---------------------------------------------------------------------------

/** Removes the brackets a cut-out date or grade left unmatched or empty. */
function balanceBrackets(value: string): string {
  const chars = Array.from(value);
  const keep = chars.map(() => true);
  const open: number[] = [];
  chars.forEach((char, index) => {
    if (char === "(") open.push(index);
    else if (char === ")") {
      if (open.length > 0) open.pop();
      else keep[index] = false;
    }
  });
  for (const index of open) keep[index] = false;
  return chars.filter((_, index) => keep[index]).join("");
}

// Anything that is not a letter, digit or mark is punctuation or a bullet glyph (•, ➢, ✓, ·) — at the
// edge of a piece of text it carries nothing. An opening bracket is kept at the front and a closing one
// at the back, so a parenthesised value keeps its brackets.
function tidy(value: string): string {
  const withoutEmpty = value.replace(/\(\s*[,;:.\-|/]*\s*\)/g, " ");
  return balanceBrackets(withoutEmpty)
    .replace(/\s{2,}/g, " ")
    .replace(/^[^\p{L}\p{N}\p{M}(]+/u, "")
    .replace(/[^\p{L}\p{N}\p{M})]+$/u, "")
    .trim();
}

/**
 * Puts back the spaces a PDF text layer dropped: ")Cairo", "PhilosophyAin", "Arts2022", "2022Cairo".
 * Applied to the text being READ — the fallback keeps the stored text untouched.
 */
function unglue(text: string): string {
  return text
    .replace(/\)(?=[\p{L}])/gu, ") ")
    .replace(/(?<=[a-z]{3})(?=[A-Z][a-z]{2,})/g, " ")
    .replace(/(?<=[\p{L}])(?=(?:19[7-9]\d|20[0-4]\d)(?![\p{N}]))/gu, " ")
    .replace(/(?<=(?:19[7-9]\d|20[0-4]\d))(?=[\p{L}])/gu, " ");
}

/** The line as the CV wrote it, less its bullet and the dash variants, with single spaces. */
function cleanLine(raw: string): string {
  return raw
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}\p{M}(]+/u, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The word with the punctuation around it removed and lowercased — for comparing, never for display. */
function bare(token: string): string {
  return token.replace(/^[("'“\[]+|[)"'”\].,;:]+$/g, "").toLowerCase();
}

const HEAD_WORDS: ReadonlySet<string> = new Set([
  "university", "universities", "univ", "academy", "institute", "college", "school", "جامعة", "معهد", "أكاديمية",
]);
const ARABIC_HEADS: ReadonlySet<string> = new Set(["جامعة", "معهد", "أكاديمية"]);

/** A word that ends the walk leftwards from a university — it belongs to the degree or a sentence, not the name. */
const LEFT_STOP: ReadonlySet<string> = new Set([
  "in", "at", "from", "of", "for", "by", "with", "faculty", "department", "dept", "major", "minor", "bachelor",
  "bachelors", "master", "masters", "diploma", "phd", "degree", "course", "workshop", "certificate",
  "certification", "holding", "graduated", "graduate", "studying", "pursuing", "starting", "grade", "gpa",
  "section", "program", "programme", "|", "-", "&", "and",
]);
/** A word that ends the tail after a university ("for Science and Technology") before it swallows the faculty. */
const RIGHT_STOP: ReadonlySet<string> = new Set([
  "faculty", "department", "dept", "major", "minor", "bachelor", "master", "diploma", "phd", "degree",
  "from", "at", "by", "course", "grade", "gpa", "graduated", "section", "program", "programme", "|",
]);
const CHAIN_OPENERS: ReadonlySet<string> = new Set(["for", "of", "in"]);

/** Verbs and fillers a CV puts in front of a qualification. They carry no fact. */
const LEADING_FILLER =
  /^(?:holding|holds|holder(?:\s+(?:of|in))?|graduated(?:\s+from)?|graduate\s+of|studying(?:\s+for)?|currently\s+studying|pursuing|starting|completed|obtained|earned|awarded(?:\s+by)?|received|attested|registered(?:\s+(?:for|in|from))?|enrolled(?:\s+(?:for|in))?|student(?:\s+(?:of|at))?|validated\s+by|accredited\s+by|issued\s+by)(?:\s+|$)/i;
const TRAILING_FILLER =
  /\s+(?:attested|now|currently|till\s+now|to\s+date|graduation|graduated|graduate|registered|enrolled|studied|completed|obtained|earned|awarded)$/i;
/** A verb that opens a sentence about something the person DID — an award, a grant, a job — not a qualification. */
const SENTENCE_OPENER = /^(?:awarded|won|achieved|participated|organi[sz]ed|volunteered|worked|led|managed|delivered|represented|selected|nominated)(?![\p{L}])/iu;
/** A note about how the degree ended — an honour, a rank — that belongs with the grade, not with the university. */
const ACCOLADE = /^(?:with\s+)?(?:honou?rs?|distinction|first[\s-]class(?:\s+honou?rs?)?|cum\s+laude|summa\s+cum\s+laude|magna\s+cum\s+laude|rank(?:ed)?\s*[:\-]?\s*\S+(?:\s+\S+)?|top\s+\d+.*)$/i;
const QUALIFIER = /^(?:higher|advanced|professional|technical|general|applied|honou?rs?|associate|undergraduate)$/i;
/** A piece that is only a note about the entry, with nothing of the entry in it. */
const NOISE_SEGMENT = /^(?:attested|verified)$/i;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DEGREE_ALIASES: readonly string[] = DEGREE_KEYWORDS.flatMap((entry) => [...entry.aliases]).sort(
  (a, b) => b.length - a.length,
);
// The second look-behind keeps "B.A" from being read out of the middle of "M.B.A".
const DEGREE_TOKEN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}]\\.)(?:${DEGREE_ALIASES.map(escapeRegExp).join("|")})(?:['’]s)?(?:\\s+degrees?)?\\.?(?![\\p{L}\\p{N}])`,
  "giu",
);

/** Known universities as word lists, longest first — the reliable way to find one whose name is unusual. */
const KNOWN_UNIVERSITIES: ReadonlyArray<readonly string[]> = EGYPT_UNIVERSITIES.filter((name) => name.length > 4)
  .map((name) => name.split(" "))
  .sort((a, b) => b.length - a.length);

const FACULTY_LIST: readonly string[] = [...FACULTY_KEYWORDS].sort((a, b) => b.length - a.length);

// ---------------------------------------------------------------------------
// Locating the institution inside one piece of text
// ---------------------------------------------------------------------------

type Span = { readonly start: number; readonly end: number };

function isLeftStop(lower: readonly string[], index: number): boolean {
  const word = lower[index] ?? "";
  if (word === "and" || word === "&") {
    // "Modern Sciences & Arts University": a joiner between two name words belongs to the name.
    const before = lower[index - 1];
    return before === undefined || LEFT_STOP.has(before);
  }
  if (word === "of") {
    // "6th of October University".
    return !/^\d+(?:st|nd|rd|th)$/.test(lower[index - 1] ?? "");
  }
  if (LEFT_STOP.has(word)) return true;
  return /[()]/.test(word);
}

function locateInstitution(tokens: readonly string[]): Span | null {
  const lower = tokens.map(bare);

  // A university the dictionary knows is found by name, whatever surrounds it.
  for (const words of KNOWN_UNIVERSITIES) {
    for (let at = 0; at + words.length <= lower.length; at += 1) {
      if (words.every((word, offset) => lower[at + offset] === word)) {
        return { end: extendAcronym(tokens, at + words.length), start: at };
      }
    }
  }

  const head = lower.findIndex((word) => HEAD_WORDS.has(word));
  if (head < 0) return null;

  if (ARABIC_HEADS.has(lower[head] ?? "")) {
    let end = head + 1;
    while (end < tokens.length && end - head <= 3 && !RIGHT_STOP.has(lower[end] ?? "")) end += 1;
    return { end, start: head };
  }

  let start = head;
  while (start > 0 && head - start < 6 && !isLeftStop(lower, start - 1)) start -= 1;

  let end = head + 1;
  if (end < tokens.length && CHAIN_OPENERS.has(lower[end] ?? "")) {
    let cursor = end + 1;
    while (cursor < tokens.length && cursor - end <= 8 && !RIGHT_STOP.has(lower[cursor] ?? "")) cursor += 1;
    if (cursor > end + 1) end = cursor;
  }
  return { end: extendAcronym(tokens, end), start };
}

/** "(MUST)" written straight after a name is part of it. */
function extendAcronym(tokens: readonly string[], end: number): number {
  const next = tokens[end];
  return next !== undefined && /^\([A-Za-z]{2,10}\)[.,]?$/.test(next) ? end + 1 : end;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

type PieceKind = "institution" | "degree" | "faculty" | "other";
type Piece = { readonly kind: PieceKind; readonly text: string; readonly joiner: string };

/** A segment that is only a label — "University :", "Major", "Degree" — carries no fact of its own. */
const LABEL_ONLY = /^(?:university|school|faculty|institute|college|academy|degree|education|qualifications?|graduation|graduated|year|grade)$/i;
const FIELD_LABEL = /^(?:major|minor|department(?:\s+of)?|dept\.?(?:\s+of)?|specializ?ation|specialisation|field\s+of\s+study)$/i;
const LEADING_FIELD_LABEL = /^(?:major|minor|department(?:\s+of)?|dept\.?(?:\s+of)?|specializ?ation|specialisation|field\s+of\s+study)\s*[:\-]?\s+/i;

/** A school named as a credential — "American High School Diploma" — is the diploma, not the place. */
const CREDENTIAL_SCHOOL = /(?<![\p{L}\p{N}])school\s+(?:diploma|certificate)(?![\p{L}\p{N}])/iu;

function findFaculty(text: string): { start: number; end: number } | null {
  const lowered = text.toLowerCase();
  for (const name of FACULTY_LIST) {
    const at = lowered.indexOf(name);
    if (at < 0) continue;
    const before = lowered[at - 1];
    const after = lowered[at + name.length];
    const glued = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
    if (!glued(before) && !glued(after)) return { end: at + name.length, start: at };
  }
  return null;
}

function stripEdges(value: string): string {
  let out = tidy(value);
  for (;;) {
    const next = out
      .replace(/^(?:in|at|from|of|for|and|&|with)\s+/i, "")
      .replace(/\s+(?:in|at|from|of|for|and|&|with|by)$/i, "")
      .replace(LEADING_FILLER, "")
      .replace(TRAILING_FILLER, "");
    const cleaned = tidy(next);
    if (cleaned === out) return out;
    out = cleaned;
  }
}

function hasDegreeWord(text: string): boolean {
  DEGREE_TOKEN.lastIndex = 0;
  return DEGREE_TOKEN.test(text);
}

/** Turns one segment of the line into pieces — a segment can hold a degree, a faculty AND a university. */
function expand(segment: string, joiner: string): Piece[] {
  const text = stripEdges(segment);
  if (!text || NOISE_SEGMENT.test(bare(text))) return [];

  if (CREDENTIAL_SCHOOL.test(text)) return [{ joiner, kind: "degree", text }];
  // "(Accredited by University of Wales, UK)": a bracketed note is one thing, kept whole as the CV wrote it.
  if (/^\([^()]*\)$/.test(text)) return [{ joiner: " ", kind: "other", text }];

  // A faculty the dictionary knows is lifted out first, so the walk to the university cannot swallow it —
  // unless its name goes on ("Faculty of Tourism and Hotels"), when the whole run is the faculty's.
  const faculty = findFaculty(text);
  if (faculty && (faculty.start > 0 || faculty.end < text.length) && !/^\s*(?:and|&)\s/i.test(text.slice(faculty.end))) {
    const before = text.slice(0, faculty.start);
    const beforePieces = expand(before, joiner);
    // A bracketed note right after it ("Faculty of Science (Zoology/Chemistry)") is part of it.
    const note = /^\s*\([^)]*\)/.exec(text.slice(faculty.end));
    const end = faculty.end + (note ? note[0].length : 0);
    return [
      ...beforePieces,
      { joiner: beforePieces.length > 0 ? " " : joiner, kind: "faculty", text: text.slice(faculty.start, end) },
      ...expand(text.slice(end), " "),
    ];
  }

  const tokens = text.split(" ");
  const found = locateInstitution(tokens);
  // "The British University in Egypt": the article is part of the official name, not a piece of its own.
  const span = found && found.start > 0 && bare(tokens[found.start - 1] ?? "") === "the" ? { ...found, start: found.start - 1 } : found;
  if (span) {
    const before = tokens.slice(0, span.start).join(" ");
    const name = tokens.slice(span.start, span.end).join(" ");
    const after = tokens.slice(span.end).join(" ");
    const pieces: Piece[] = [...expand(before, joiner)];
    pieces.push({ joiner: pieces.length > 0 ? " " : joiner, kind: "institution", text: name.replace(/^the\s+/, "") });
    // "Pretoria Boys High School & Hercules High", "Badr University in Cairo": what follows is joined to the
    // name by the CV's own word, so the word stays.
    if (/^(?:&|and|in|of|for|at)\s/i.test(after)) pieces.push({ joiner: " ", kind: "other", text: after });
    else pieces.push(...expand(after, " "));
    return pieces;
  }

  if (hasDegreeWord(text)) return [{ joiner, kind: "degree", text }];
  if (/^(?:faculty|كلية)(?![\p{L}])/iu.test(text)) return [{ joiner, kind: "faculty", text }];
  return [{ joiner, kind: "other", text }];
}

// The characters a segment boundary can be written with. Inside brackets they are text, not boundaries.
const BOUNDARY_CHARS = ",|·•;:-/";
const SEPARATOR = /(\s*[|·•;]\s*|\s+-\s+|\s+\/\s+|\s*:\s*|\s*,\s*|\s+\.\s+|\s+\.$)/;

function maskBrackets(text: string): string {
  let depth = 0;
  let out = "";
  const chars = Array.from(text);
  chars.forEach((char, index) => {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    const at = BOUNDARY_CHARS.indexOf(char);
    // A comma between digits ("50,000") is a thousands mark, never a boundary.
    const thousands = char === "," && /\d/.test(chars[index - 1] ?? "") && /\d/.test(chars[index + 1] ?? "");
    out += (depth > 0 || thousands) && at >= 0 ? String.fromCharCode(0xe000 + at) : char;
  });
  return out;
}

function unmaskBrackets(text: string): string {
  return text.replace(/[-]/g, (char) => BOUNDARY_CHARS[char.charCodeAt(0) - 0xe000] ?? char);
}

function joinerFor(separator: string): string {
  return /^\s+-\s+$/.test(separator) ? " - " : ", ";
}

function segments(text: string): Array<{ text: string; joiner: string }> {
  const parts = maskBrackets(text).split(SEPARATOR);
  const out: Array<{ text: string; joiner: string }> = [];
  let joiner = ", ";
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 1) {
      joiner = joinerFor(parts[index] ?? "");
      continue;
    }
    const part = unmaskBrackets(parts[index] ?? "").trim();
    if (part) out.push({ joiner, text: part });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The degree segment — level, and the subject after it
// ---------------------------------------------------------------------------

/** The subject a degree phrase names ("Bachelor of Commerce" → "Commerce"), and any qualifier in front of the level. */
function readDegreeSegment(text: string): { field: string | null; qualifier: string | null } {
  DEGREE_TOKEN.lastIndex = 0;
  const matches = [...text.matchAll(DEGREE_TOKEN)];
  if (matches.length === 0) return { field: stripEdges(text) || null, qualifier: null };

  const followedByFieldWord = (match: RegExpMatchArray) => {
    const rest = text.slice((match.index ?? 0) + match[0].length);
    return /\bof$/i.test(match[0]) || /^\s*(?:of|in)\s+\S/i.test(rest);
  };
  const best = matches.find(followedByFieldWord) ?? matches[0]!;
  const start = best.index ?? 0;
  const before = text.slice(0, start);
  const after = text.slice(start + best[0].length).replace(/^\s*(?:of|in|-|:)\s+/i, " ");

  // What stood in front of the level: fillers and a second mention of the level ("Holding MBA ( Master of …")
  // carry nothing; a qualifier ("Higher") belongs with the level; anything else is part of the subject.
  const leftover = stripEdges(before.replace(DEGREE_TOKEN, " ").replace(/\b(?:a|an|the)\b/gi, " "));
  const words = leftover.split(" ").filter(Boolean);
  const qualifiers = words.filter((word) => QUALIFIER.test(word));
  const rest = words.filter((word) => !QUALIFIER.test(word)).join(" ");

  const field = stripEdges([rest, stripEdges(after)].filter(Boolean).join(" "));
  return { field: field || null, qualifier: qualifiers.length > 0 ? qualifiers.join(" ") : null };
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// The whole line
// ---------------------------------------------------------------------------

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

const DANGLING = /(?:^|\s)(?:of|for|in|at|from|and|&|with|by)$|^(?:of|for|in|at|from|and|&|with|by)(?:\s|$)/i;

const DISCIPLINE_WORD = /\b(?:department|dept|section|major|minor|specializ\w*|specialis\w*|programme?|track|division|studies|science|sciences|engineering|pharmacy|medicine|commerce|law|arts|education|management|administration|accounting|marketing|nursing|dentistry|agriculture|economics|business|chemistry|physics|biology|zoology|botany|geology|microbiology|biochemistry|biotechnology|mathematics|statistics|linguistics|literature|translation|psychology|sociology|journalism|mass communication|computer\w*|veterinary)\b/i;

/**
 * Whether a piece straight after the university is part of ITS name or place rather than a subject:
 * a bracketed note, "Qena", "Cairo, Egypt", or the second half of "Arab Academy for Management, Banking &
 * Financial Sciences (AAMBFS)".
 */
function belongsToInstitution(text: string, institution: string): boolean {
  if (/^\(.*\)$/.test(text)) return true;
  // The second half of a long name ends in its acronym, whatever its length.
  if (/\b(?:for|of)\b/i.test(institution) && /\([A-Za-z]{2,10}\)$/.test(text)) return true;
  // A place is a word or three; anything longer is a sentence.
  return !DISCIPLINE_WORD.test(text) && wordCount(text) <= 4;
}

/**
 * Splits one education line into degree, field of study, institution, year and grade.
 *
 * Falls back to the old reading — the whole line as the institution, the level and the year — when the
 * line is not one clean entry: a sentence, a course blurb, two entries run together, a line that stops
 * mid-phrase.
 */
export function splitEducationLine(raw: string): EducationParts {
  const stored = raw.replace(/\s{2,}/g, " ").trim();
  const cleaned = cleanLine(raw);
  const level = matchDictionary(cleaned, DEGREE_KEYWORDS);
  const hasInstitutionWord = /universit|academy|institute|college|school|جامعة|معهد|أكاديمية/i.test(cleaned);
  const fallback: EducationParts = {
    degree: level,
    fieldOfStudy: null,
    grade: null,
    institution: hasInstitutionWord ? stored : null,
    year: graduationYear(cleaned),
  };
  if (!cleaned || cleaned.length > 200) return fallback;
  // "Awarded a competitive … research grant from the Academy of …" is something the person did, not a degree.
  if (SENTENCE_OPENER.test(cleaned) && level === null) return fallback;

  const text = unglue(cleaned);

  // Two different levels on one line — "Bachelor's … Diploma in …" — are two entries run together.
  DEGREE_TOKEN.lastIndex = 0;
  const levels = new Set([...text.matchAll(DEGREE_TOKEN)].map((match) => matchDictionary(match[0], DEGREE_KEYWORDS)));
  levels.delete(null);
  if (levels.size > 1) return fallback;

  const graded = pullGrade(text);
  const undated = tidy(withoutDates(graded.text));
  let grade = graded.grade;

  const pieces: Piece[] = [];
  const accolades: string[] = [];
  let nextIsField = false;
  for (const segment of segments(undated)) {
    const label = bare(segment.text);
    // "Class of 2018 - Good": the dash that followed the cut-out date is left on the front of the grade.
    const gradeLabel = bare(segment.text.replace(/^[\s\-|,;:·•]+/u, ""));
    if (LABEL_ONLY.test(label)) continue;
    if (FIELD_LABEL.test(label)) {
      nextIsField = true;
      continue;
    }
    // "… | 2010 | Very Good": a segment that is only a grade word is the grade, where none was labelled.
    if (grade === null && GRADE_ONLY.test(gradeLabel)) {
      grade = segment.text.replace(/^[\s\-|,;:·•]+/u, "");
      continue;
    }
    // "Honors", "Ranked 6th": how the degree ended, so it rides with the grade.
    if (ACCOLADE.test(segment.text.trim())) {
      accolades.push(segment.text.trim());
      continue;
    }
    const expanded = expand(segment.text, segment.joiner);
    if (nextIsField && expanded.length > 0 && expanded[0]!.kind === "other") {
      pieces.push({ ...expanded[0]!, kind: "faculty" }, ...expanded.slice(1));
    } else {
      pieces.push(...expanded);
    }
    nextIsField = false;
  }

  let institution = "";
  const fields: Array<{ text: string; prose: boolean }> = [];
  let qualifier: string | null = null;
  let sawInstitution = false;
  let sawDegreeOrFaculty = false;

  for (const piece of pieces) {
    if (piece.kind === "institution") {
      institution = institution ? `${institution}${piece.joiner}${piece.text}` : piece.text;
      sawInstitution = true;
    } else if (piece.kind === "degree") {
      sawDegreeOrFaculty = true;
      const read = readDegreeSegment(piece.text);
      if (read.field) fields.push({ prose: false, text: read.field });
      if (read.qualifier && !qualifier) qualifier = read.qualifier;
    } else if (piece.kind === "faculty") {
      sawDegreeOrFaculty = true;
      fields.push({ prose: false, text: piece.text.replace(LEADING_FIELD_LABEL, "") });
    } else if (sawInstitution && belongsToInstitution(piece.text, institution)) {
      institution = `${institution}${/^\(/.test(piece.text) ? " " : piece.joiner}${piece.text}`;
    } else {
      fields.push({ prose: true, text: piece.text.replace(LEADING_FIELD_LABEL, "") });
    }
  }

  // No university, degree or faculty anywhere on the line: whatever is left is a fragment of prose,
  // not an entry — leave it exactly as it was stored.
  if (!sawInstitution && !sawDegreeOrFaculty) return fallback;

  const cleanedFields = fields.map((field) => ({ ...field, text: stripEdges(field.text) })).filter((field) => field.text);
  const fieldTexts = dedupe(cleanedFields.map((field) => field.text));
  const institutionText = stripEdges(institution);

  if (fieldTexts.length === 0 && !institutionText) return fallback;
  if ([...fieldTexts, institutionText].some((part) => part && DANGLING.test(part))) return fallback;
  if (fieldTexts.some((part) => wordCount(part) > 9 || part.length > 80)) return fallback;
  // An unlabelled piece that runs to a sentence is prose ("Work as organizer for children day"), not a subject —
  // and with no degree or faculty on the line to vouch for it, a subject is only a few words.
  const proseLimit = sawDegreeOrFaculty ? 6 : 4;
  if (cleanedFields.some((field) => field.prose && wordCount(field.text) > proseLimit)) return fallback;
  if (wordCount(institutionText) > 14 || institutionText.length > 110) return fallback;

  const gradeText = [grade, ...accolades].filter(Boolean).join(", ");
  return {
    degree: level ? (qualifier ? `${capitalise(qualifier)} ${level}` : level) : null,
    fieldOfStudy: fieldTexts.length > 0 ? fieldTexts.join(", ") : null,
    grade: gradeText || null,
    institution: institutionText || null,
    year: graduationYear(text),
  };
}

/** Drops a field that another, longer one already says ("Pharmacy" beside "Faculty of Pharmacy"), and repeats. */
function dedupe(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const lowered = value.toLowerCase();
    if (out.some((existing) => existing.toLowerCase().includes(lowered))) continue;
    const contained = out.findIndex((existing) => lowered.includes(existing.toLowerCase()));
    if (contained >= 0) out[contained] = value;
    else out.push(value);
  }
  return out;
}
