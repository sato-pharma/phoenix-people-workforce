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
 * Title-cases an organization name, respecting the acronyms above.
 *
 * Behaviour for everything else is unchanged from the implementation this replaces: a word with no
 * letters at all is passed through untouched (so "1", "(2)" and "-" survive), and every other word
 * gets its first character upper-cased and the rest lower-cased.
 */
export function toOrgTitleCase(value: string): string {
  const perWord = value
    .split(" ")
    .map((word) => {
      // No letters at all — a number, a bracketed suffix, punctuation. Leave it exactly as it is.
      if (!/[a-z]/i.test(word)) {
        return word;
      }

      if (ORG_TITLE_ACRONYMS.has(word.toLowerCase())) {
        return word.toUpperCase();
      }

      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");

  return ORG_TITLE_PHRASES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    perWord,
  );
}
