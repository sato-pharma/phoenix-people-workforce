// How an organization display name is cased when the importer has to invent one.
//
// WHY THIS EXISTS. When an employee upload names a department/line/area/team/position that does not
// exist yet, the importer has no human-written label to use — so it builds one from the CODE:
// `toOrgTitleCase(code.replace(/_/g, " "))`. The old implementation upper-cased the first letter of
// each word and lower-cased the rest, which is right for "medical representative" and wrong for every
// acronym this company actually uses. Measured in production 2026-08-28, it is what produced the
// titles `Hr Manager`, `Qppv`, `Ceo`, `Sfe Manager` and `R And D Manager` — none of which anybody
// typed. They were corrected by hand that day; this module stops the next one being born wrong.
//
// THE SAFETY PROPERTY. A display name must still map back to the code it came from, or the next
// import stops matching the row and silently creates a duplicate seat. Every entry here is therefore
// required to round-trip: `createOrgCode(toOrgTitleCase(code.replace(/_/g, " "))) === code`.
// That holds because `createOrgCode` lower-cases before slugging and rewrites `&` to " and ", so
// casing is free and `R&D` slugs back to `r_and_d`. `tests/org-title-case-acronyms.test.ts` asserts
// the round trip for every acronym and phrase rather than trusting that reasoning.
//
// This lived as two byte-identical private copies — `org-rule-engine.ts` and
// `employee-normalizers.ts` — so a fix to one silently left the other wrong. One module now, imported
// by both, and the test pins that neither file has grown a local copy again.
//
// THE MINOR-WORD RULE, added 2026-09-06. Casing every word alike is wrong in the other direction:
// it renders "Finance and Admin Manager" as "Finance And Admin Manager". That mattered the moment
// #3311 routed `employees.job_title` through here, because production stores the lower-case "and"
// on BOTH B-185's employee row and the `finance_and_admin_manager` position row — so the next
// employee upload would have rewritten a correct, human-entered title. Measured 2026-09-06: of the
// 24 distinct job titles live in production, that was the only one this function did not already
// leave alone. A repair that regenerates a different defect is the thing this module exists to stop.

/**
 * Words that are acronyms in this company's org vocabulary and must be fully upper-cased.
 *
 * GROUNDED, NOT GUESSED — every entry below appears in production data today:
 * `CEO`, `HR` (positions), `QPPV`, `SFE`, `R&D` (departments and positions), `CNS` (line),
 * `BHR` (the ALEX-BHR teams). Add to this set only when a real name needs it.
 *
 * Deliberately NOT here: `it`. "IT" would be a plausible acronym, but `it` is also an ordinary
 * English word, and this set is applied to every word of every department, line, area, team and
 * position name. The cost of a false positive (silently renaming a legitimate word) is higher than
 * the cost of hand-fixing one "It Manager" if that role is ever created. Same reasoning applies to
 * any other two-letter word — weigh it before adding.
 */
export const ORG_TITLE_ACRONYMS: ReadonlySet<string> = new Set([
  "bhr",
  "ceo",
  "cns",
  "hr",
  "qppv",
  // `r&d` is here so this function is IDEMPOTENT. The phrase rule below turns the from-code form
  // "r and d" into "R&D"; without this entry, running the result back through would split "R&D" as an
  // ordinary word and produce "R&d". No call site does that today — all four feed it
  // `code.replace(/_/g, " ")`, and a code can never contain `&` — but a function whose output is not a
  // fixed point of itself is a trap waiting for the first caller that re-normalizes a display name.
  "r&d",
  "sfe",
  // `TMM`, Toll Manufacturing Manager — Dr. Sahar Khalil's title is "Toll Manufacturing Manager (TMM)"
  // since 2026-11-10 (owner). Matched inside its brackets by isOrgAcronym below.
  "tmm",
]);

/**
 * Whether a word is one of the acronyms above, ignoring brackets and punctuation around it, so
 * "(TMM)" and "HR," are recognised as well as the bare word. Before 2026-11-10 only the bare word
 * matched, and "Toll Manufacturing Manager (TMM)" came out of the importer as "(tmm)".
 */
function isOrgAcronym(lowerCasedWord: string): boolean {
  return ORG_TITLE_ACRONYMS.has(lowerCasedWord.replace(/^[^a-z&]+|[^a-z&]+$/g, ""));
}

/**
 * Words left lower-case in the MIDDLE of a name — ordinary English title case.
 *
 * Only `and` is attested in this company's org data today (B-185's job title and the matching
 * position row). The rest are the standard English function words, included because the next title
 * to need one — "Head of Quality", "Director for the Delta" — should be born right rather than
 * hand-fixed after somebody reads it in a report, which is the exact loop that produced this module.
 *
 * The risk here is the MIRROR of the acronym set's: that set can wrongly UPPER-case an ordinary word
 * (which is why `it` is excluded), and this one can wrongly LOWER-case a word that is really a code.
 * Weigh an addition the same way, and note the first/last-word guard does not protect a word in the
 * middle of a name.
 *
 * Deliberately NOT here: `a`. The live sales LINE codes are the bare letters `A`, `C` and `P`, so a
 * team or area name carrying one ("Team A Support") must keep its capital. Every other entry is at
 * least two letters and cannot collide with a line code.
 */
export const ORG_TITLE_MINOR_WORDS: ReadonlySet<string> = new Set([
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/**
 * Multi-word rules, applied AFTER the per-word pass.
 *
 * `createOrgCode` rewrites `&` to " and ", so `R&D` becomes the code `r_and_d` and comes back out as
 * the three words "r and d". No per-word rule can rebuild that — it needs a phrase rule.
 *
 * Order matters only if two patterns can overlap; they do not today.
 */
export const ORG_TITLE_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  // "R And D Manager" -> "R&D Manager". Anchored on word boundaries so it cannot fire inside a
  // longer word, and case-insensitive because it runs after the per-word pass has already cased it.
  [/\br\s+and\s+d\b/gi, "R&D"],
];

/**
 * Title-cases an organization name, respecting the acronyms and minor words above.
 *
 * A word with no letters at all is passed through untouched (so "1", "(2)" and "-" survive). An
 * acronym is fully upper-cased. A minor word is lower-cased, but only in the middle of the name —
 * the first and last letter-bearing words always capitalise, as ordinary title case does. Every
 * other word gets its first character upper-cased and the rest lower-cased.
 *
 * The function is idempotent: f(f(x)) === f(x), pinned by tests/org-title-case-acronyms.test.ts.
 */
export function toOrgTitleCase(value: string): string {
  const words = value.split(" ");

  // Which words ordinary title case always capitalises: the first and the last. Located by counting
  // only words that CARRY LETTERS, so a trailing bracketed suffix — "Delta (1)", the live team
  // naming — cannot push the real last word into the middle and lower-case it.
  const letterBearing = words.reduce<number[]>((indexes, word, index) => {
    if (/[a-z]/i.test(word)) {
      indexes.push(index);
    }

    return indexes;
  }, []);
  const firstWord = letterBearing[0];
  const lastWord = letterBearing[letterBearing.length - 1];

  const perWord = words
    .map((word, index) => {
      // No letters at all — a number, a bracketed suffix, punctuation. Leave it exactly as it is.
      if (!/[a-z]/i.test(word)) {
        return word;
      }

      const lowerCased = word.toLowerCase();

      // An acronym wins over everything, including the minor-word rule below. The two sets are
      // asserted disjoint by the test, so this ordering is belt-and-braces rather than load-bearing.
      if (isOrgAcronym(lowerCased)) {
        return word.toUpperCase();
      }

      if (
        ORG_TITLE_MINOR_WORDS.has(lowerCased) &&
        index !== firstWord &&
        index !== lastWord
      ) {
        return lowerCased;
      }

      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");

  return ORG_TITLE_PHRASES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    perWord,
  );
}

/**
 * The correction to OFFER for a hand-typed job title, or `null` when there is nothing to say.
 *
 * WHY THIS IS NOT `toOrgTitleCase`. The Employees screen is one person deliberately typing one
 * title, and the casing IS the intent — the opposite of a spreadsheet cell. Running the full caser
 * over free text damages it: "QA/QC Supervisor" becomes "Qa/qc Supervisor" and "eCommerce Manager"
 * becomes "Ecommerce Manager", because neither is one of this vocabulary's words and per-word title
 * case cannot know that. Suggesting a WORSE value than the one that was typed is a worse failure
 * than staying quiet, so this function is surgical: it rewrites only words this module actually
 * knows — an acronym, a minor word out of place, and the `R and D` phrase — and returns every other
 * character exactly as it was typed.
 *
 * It is a SUGGESTION, deliberately. Nothing here writes to `employees.job_title`; the Employees
 * screen shows the result and the person chooses. The importer is the path that normalizes without
 * asking, and it is allowed to because a sheet is bulk data with no author standing behind each
 * cell. Owner's rule for the system generally: the system flags, it does not auto-correct.
 *
 * Returns `null` — not the unchanged string — so a caller cannot accidentally render a hint that
 * proposes exactly what is already in the box.
 */
export function suggestOrgTitleCasing(value: string): string | null {
  if (!value.trim()) {
    return null;
  }

  const words = value.split(" ");
  const letterBearing = words.reduce<number[]>((indexes, word, index) => {
    if (/[a-z]/i.test(word)) {
      indexes.push(index);
    }

    return indexes;
  }, []);
  const firstWord = letterBearing[0];
  const lastWord = letterBearing[letterBearing.length - 1];

  const corrected = words
    .map((word, index) => {
      const lowerCased = word.toLowerCase();

      // A known acronym typed as anything but full caps — "Ceo", "Hr", "Sfe Manager". This is the
      // case that put a mangled title on the CEO's own record.
      if (isOrgAcronym(lowerCased)) {
        return word.toUpperCase();
      }

      // A minor word capitalised mid-title — "Finance And Admin Manager".
      if (
        ORG_TITLE_MINOR_WORDS.has(lowerCased) &&
        index !== firstWord &&
        index !== lastWord
      ) {
        return lowerCased;
      }

      // Everything else is returned BYTE-IDENTICAL. No first-letter capitalisation, no
      // lower-casing of the remainder — that is precisely what would wreck "QA/QC" and "eCommerce".
      return word;
    })
    .join(" ");

  const withPhrases = ORG_TITLE_PHRASES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    corrected,
  );

  return withPhrases === value ? null : withPhrases;
}
