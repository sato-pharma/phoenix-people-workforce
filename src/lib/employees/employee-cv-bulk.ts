/**
 * Matching a folder of CV files to the people they belong to.
 *
 * HR keeps years of CVs in a folder, named however the sender named them. This turns that folder
 * into a reviewed list of file → person, so 96 documents can be filed in one sitting instead of
 * ninety-six separate uploads.
 *
 * 🔴 IT PROPOSES. A PERSON CONFIRMS. NOTHING IS FILED BY A MATCH ALONE. The same rule as the
 * candidate carry beside it, for the same measured reason: on this production data an automatic
 * pairing was wrong 3 times in 8, and a stranger's CV filed permanently under an employee's name —
 * downloadable afterwards from the organogram by the SFE Manager — is worse than no CV at all.
 * What this module decides is only whether a row may be PRE-SELECTED in a table somebody is about
 * to read, never whether it is written.
 *
 * WHY EXACT TOKENS AND NOT SUBSTRINGS. "ali" is a substring of "salim" and "sam" of "samaa", so a
 * substring match quietly pairs unrelated people with common Egyptian name fragments. A token is
 * compared whole.
 *
 * WHY NOISE WORDS ARE DROPPED. Half these files are called "CV", "Resume", "final", "updated",
 * "copy (2)". Counting those as evidence would make every file look like a match for everybody,
 * and the certainty test below would then fire on nothing but noise.
 */

/** Words that appear in CV filenames and say nothing about who the person is. */
const NOISE_TOKENS = new Set([
  "ats",
  "copy",
  "cv",
  "doc",
  "docx",
  "document",
  "draft",
  "eng",
  "final",
  "format",
  "latest",
  "new",
  "optimized",
  "pdf",
  "rep",
  "resume",
  "sato",
  "updated",
  "version",
]);

/** What the caller knows about each employee — the directory row, narrowed. */
export type BulkCvEmployee = {
  displayName: string;
  fullName?: string | null;
  hasCv: boolean;
  hrId: string;
};

export type BulkCvCandidate = {
  displayName: string;
  hasCv: boolean;
  hrId: string;
  /** Matched name words; an HR id in the filename scores above any name. */
  score: number;
};

export type BulkCvMatch = {
  candidates: BulkCvCandidate[];
  /**
   * Whether this row may start with its employee already chosen. False is the safe answer and the
   * common one: the row then sits unassigned until somebody picks, and cannot be uploaded.
   */
  certain: boolean;
  fileName: string;
  /** The pre-selection — only ever set when `certain`. */
  hrId: string | null;
  /** Set when the chosen person already has a CV: filing this one would REPLACE theirs. */
  wouldReplace: boolean;
};

/** An HR id as it might appear in a filename: PD-0015, pd0015, PD 0015. */
function hrIdPattern(hrId: string): RegExp | null {
  const match = /^([A-Za-z]{1,3})[-\s]?(\d{2,5})$/.exec(String(hrId ?? "").trim());
  if (!match) return null;
  return new RegExp(`(^|[^a-z0-9])${match[1]}[-_\\s]?${match[2]}([^a-z0-9]|$)`, "i");
}

/** The words of a filename that could identify a person. */
export function fileNameTokens(fileName: string | null | undefined): string[] {
  const base = String(fileName ?? "")
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .toLowerCase();
  return base
    // Splits on anything that is not a Latin letter, a digit, or a character in the Arabic block —
    // a CV filename here is as often Arabic as English.
    //
    // 🔴 THE ARABIC RANGE IS LITERAL CHARACTERS, AND THIS FILE MUST NEVER BE ROUND-TRIPPED THROUGH
    // A TOOL THAT RE-ENCODES IT. Reading it as ANSI and writing it back as UTF-8 turns the range
    // into mojibake, and the file then dies at PARSE time with "Range out of order in character
    // class" while looking untouched in a diff. (Measured here on 2026-09-29: PowerShell 5.1's
    // Get-Content -Raw does exactly that.) Edit it with a UTF-8-aware editor.
    .split(/[^a-z0-9؀-ۿ]+/i)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !NOISE_TOKENS.has(word) && !/^\d+$/.test(word));
}

/** The words of a person's name, from both the display name and the full legal name. */
export function employeeNameTokens(employee: BulkCvEmployee): Set<string> {
  const names = `${employee.displayName ?? ""} ${employee.fullName ?? ""}`.toLowerCase();
  const tokens = new Set<string>();
  for (const word of names.split(/[^a-z0-9؀-ۿ]+/i)) {
    const trimmed = word.trim();
    if (trimmed.length >= 3) tokens.add(trimmed);
  }
  return tokens;
}

/**
 * Rank the people one file could belong to, and say whether the top one is safe to pre-select.
 *
 * CERTAIN means all of:
 *   - the filename carries this person's HR id (decisive on its own), OR
 *     at least TWO name words match and no other person matches as many; and
 *   - that person has no CV on file yet.
 *
 * The second condition is not a detail. Pre-selecting a replacement would let one careless press
 * overwrite a document somebody attached deliberately, and a CV is not recoverable from the app
 * once it is replaced. A replacement is always a deliberate, separate choice.
 */
export function matchCvFileName(
  fileName: string,
  employees: readonly BulkCvEmployee[],
  options: { limit?: number } = {},
): BulkCvMatch {
  const limit = Math.max(1, options.limit ?? 6);
  const tokens = fileNameTokens(fileName);
  const idMatches: BulkCvCandidate[] = [];
  const scored: BulkCvCandidate[] = [];

  for (const employee of employees) {
    const pattern = hrIdPattern(employee.hrId);
    const candidate: BulkCvCandidate = {
      displayName: employee.displayName,
      hasCv: employee.hasCv,
      hrId: employee.hrId,
      score: 0,
    };
    if (pattern && pattern.test(String(fileName ?? ""))) {
      // An HR id is an identifier, not a coincidence — it outranks every name match.
      idMatches.push({ ...candidate, score: 1000 });
      continue;
    }
    const nameTokens = employeeNameTokens(employee);
    const score = tokens.reduce((total, token) => (nameTokens.has(token) ? total + 1 : total), 0);
    if (score > 0) scored.push({ ...candidate, score });
  }

  scored.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
  const candidates = [...idMatches, ...scored].slice(0, limit);
  const top = candidates[0] ?? null;
  const runnerUp = candidates[1] ?? null;

  // Exactly one HR id match is decisive; two files claiming the same id is not something to guess
  // about, so it falls through to the unassigned path.
  const byId = idMatches.length === 1 && idMatches[0] ? idMatches[0] : null;
  const byName =
    top && !byId && top.score >= 2 && (!runnerUp || runnerUp.score < top.score) ? top : null;
  const chosen = byId ?? byName;
  const certain = Boolean(chosen && !chosen.hasCv);

  return {
    candidates,
    certain,
    fileName: String(fileName ?? ""),
    hrId: certain && chosen ? chosen.hrId : null,
    wouldReplace: Boolean(chosen?.hasCv),
  };
}

/**
 * Match a whole folder, and refuse to pre-select a person twice.
 *
 * TWO FILES CANNOT BOTH BE PRE-SELECTED ONTO ONE PERSON. A folder holding "Ahmed CV.pdf" and
 * "Ahmed CV final.pdf" would otherwise fill the same record twice, and the second upload would
 * silently replace the first — the person would end up with whichever the loop happened to send
 * last. When it happens, BOTH rows drop to unassigned so somebody decides which document is the
 * real one.
 */
export function matchCvFolder(
  fileNames: readonly string[],
  employees: readonly BulkCvEmployee[],
): BulkCvMatch[] {
  const matches = fileNames.map((fileName) => matchCvFileName(fileName, employees));
  const counts = new Map<string, number>();
  for (const match of matches) {
    if (!match.hrId) continue;
    counts.set(match.hrId, (counts.get(match.hrId) ?? 0) + 1);
  }
  return matches.map((match) =>
    match.hrId && (counts.get(match.hrId) ?? 0) > 1
      ? { ...match, certain: false, hrId: null }
      : match,
  );
}
