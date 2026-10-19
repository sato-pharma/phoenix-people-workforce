// Recruitment / ATS — repairing the text a PDF actually gives us, before any rule reads it.
//
// Why this exists: every rule downstream is only as good as the text handed to it, and a PDF text
// layer is not clean prose. Measured over the 133-CV careers inbox (2026-08-19), the real defects
// are:
//
//   • LIGATURE CORRUPTION (2% of CVs, but total loss on those). A subsetted font maps its ligature
//     glyphs to the wrong code points, so "Operations" extracts as "OperaBons", "Attendance" as
//     "AUendance", "field" as "]eld" and "staff" as "sta`". Every keyword rule misses on such a CV,
//     and so does a human reading the review board.
//   • EMAIL SPLIT ACROSS A LINE BREAK (1%). "bishoysamirfouad@example.or\ng" — the local part and
//     the TLD land on different lines, so an email regex matches ".or" or nothing at all.
//   • MARKDOWN LINKS (13%). cv-extraction.ts asks pdf-parse for parseHyperlinks, which rewrites an
//     anchor as [visible text](real url). The visible text is routinely TRUNCATED
//     ("[https://www.linkedin.com/in/bish](https://www.linkedin.com/in/bishoy-samir-...)"), so the
//     value worth keeping is always the one in parentheses.
//   • ARABIC-INDIC DIGITS (1%) — "٠١٢" must count as a phone number.
//
// EVERY NAME AND ADDRESS IN THIS FILE'S EXAMPLES IS INVENTED. Each was a real applicant's until
// 2026-08-28 — including the shredded address below, which no email regex can see and which the
// first scrub of this repository therefore walked straight past. The defect is what matters here,
// and every one of them reproduces identically on a made-up name.
//
// Pure and dependency-free by design: this is imported by the rule engine, which must stay usable
// from a test, a script, and a server route alike.
//
// NOTE: every character class below is written with explicit \u escapes on purpose. These are
// invisible or near-identical glyphs; spelled literally they are impossible to review in a diff and
// are trivially destroyed by an editor that "tidies up" whitespace.

/** Characters that carry no meaning but break naive matching (RTL marks, zero-width, BOM). */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

/** Every dash variant a CV uses for a date range, folded to a plain hyphen. */
const DASHES = /[‐-―−⁃]/g;

/**
 * Every curly apostrophe a CV writes in "Bachelor's", folded to a plain one.
 *
 * Word autocorrects a typed ' to U+2019, so "Bachelor's degree in Veterinary Medicine" and
 * "Bachelor's degree in veterinary medicine" are the same sentence to a reader and two different
 * strings to a rule. Measured on the 42 medical-rep candidates carrying a degree and no faculty
 * (2026-09-12): the straight-quote spelling resolved the faculty at HIGH confidence and the curly
 * one fell through to the weak bare-word scan at LOW — which is never auto-applied, so an identical
 * CV kept its faculty column blank purely on which quote character Word had chosen.
 */
const APOSTROPHES = /[\u2018\u2019\u02BC\u2032]/g;

/**
 * Bullet glyphs, folded to "• " so a list item is recognisable by one rule instead of nine.
 *
 * The PRIVATE-USE range (U+E000-U+F8FF) is in here for a reason that cost real fields: Word writes
 * a Wingdings bullet as U+F0B7, and a CV whose personal block is bulleted that way begins every
 * line with a character no rule recognised. " Military status: Exempted" then failed to match
 * a label anchored at the start of the line, and military status was found on 7% of CVs when 21%
 * state it. U+FFFD (the replacement character) is included for the same reason — it is what a
 * mis-decoded bullet becomes.
 */
const BULLETS = /^\s*[\u2022\u2023\u25AA\u25CF\u25E6\u2043\u204C\u204D\u2219\u00B7*+\-\uE000-\uF8FF\uFFFD]+\s*/;

/** Arabic-Indic (U+0660…) and Extended Arabic-Indic / Persian (U+06F0…) digits. */
const ARABIC_INDIC = /[٠-٩۰-۹]/g;

function foldArabicIndicDigits(text: string): string {
  return text.replace(ARABIC_INDIC, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    // U+0660 is Arabic-Indic zero; U+06F0 is the Extended (Persian) zero.
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

// ---------------------------------------------------------------------------
// Ligature repair
// ---------------------------------------------------------------------------

// The substitutions a broken subsetted font produces. Each maps ONE stray character, appearing
// INSIDE a word, back to the letter pair whose ligature glyph it stole.
const LIGATURE_SUBSTITUTIONS: ReadonlyArray<{ readonly stray: RegExp; readonly restored: string }> = [
  // "OperaBons" → "Operations". An uppercase B between two lowercase letters does not occur in
  // real English or in a transliterated Arabic name, which is what makes this safe to rewrite.
  { restored: "ti", stray: /(?<=[a-z])B(?=[a-z])/g },
  // "Opera;ons" / "Opera/ons" → "Operations". Punctuation mid-word is never legitimate.
  { restored: "ti", stray: /(?<=[a-z])[;/](?=[a-z])/g },
  // "AUendance" → "Attendance".
  { restored: "tt", stray: /(?<=[A-Za-z])U(?=[a-z])/g },
  // "]eld" → "field", "con]rmation" → "confirmation".
  { restored: "fi", stray: /(?<=^|[A-Za-z\s])\](?=[a-z])/g },
  // "sta`" → "staff", "di`erent" → "different". No lookahead: the ff ligature is just as likely to
  // end a word ("sta`") as to sit inside one, and requiring a following letter silently skipped the
  // end-of-word case. Safe because the whole substitution list runs only on a document already
  // proven corrupted.
  { restored: "ff", stray: /(?<=[a-z])`/g },
];

// Signals that this document IS corrupted. Repair runs ONLY when one fires.
//
// This gate is the whole safety story. The substitutions above are individually safe, but running
// them unconditionally across 126 clean CVs to fix 2 is a bad trade — a single false rewrite inside
// a person's name or an employer is worse than the corruption it was hunting. So the document has
// to prove it is broken first, and a clean CV is returned unchanged.
const CORRUPTION_SIGNALS: readonly RegExp[] = [
  /[a-z]B[a-z]{2}/,
  /[a-z][;/]on\b/,
  /(?:^|\s)\][a-z]{3}/,
  /[a-z]`[a-z]/,
];

export function looksLigatureCorrupted(text: string): boolean {
  return CORRUPTION_SIGNALS.some((signal) => signal.test(text));
}

export function repairLigatures(text: string): string {
  if (!looksLigatureCorrupted(text)) return text;
  let repaired = text;
  for (const { restored, stray } of LIGATURE_SUBSTITUTIONS) {
    repaired = repaired.replace(stray, restored);
  }
  return repaired;
}

// ---------------------------------------------------------------------------
// Line-wrap repair
// ---------------------------------------------------------------------------

/**
 * A PDF whose text layer is shredded into one- and two-character fragments.
 *
 * Real example from the careers inbox (`WASSEF CV.pdf`): every word arrives tab-separated per
 * syllable — "Mi\tcr\tos\tof\tf\ti\tce." for "MicrosoftOffice.", and the email as
 * "wassefnakh\tla\t@gmai\tl\t.\tcom". No rule can read that, and neither can a human.
 *
 * Removing the tabs restores it exactly. The danger is that a tab is normally LOAD-BEARING in a CV
 * — it is what separates "Job Title — Employer" from a right-aligned date — so this must never fire
 * on a normal document. The gate is the giveaway that distinguishes them: shredding produces very
 * many tabs with almost nothing between them, while column alignment produces few tabs with whole
 * phrases between them.
 */
export function looksShredded(text: string): boolean {
  const segments = text.split("\t");
  if (segments.length < 25) return false;
  const tiny = segments.filter((segment) => segment.length > 0 && segment.length <= 3).length;
  return tiny / segments.length > 0.5;
}

export function repairShreddedText(text: string): string {
  return looksShredded(text) ? text.replace(/\t/g, "") : text;
}

/**
 * The endings an address can be rejoined ONTO. A wrapped address is a cut-short ending plus its
 * missing letters — "gmail.co" + "m", "example.or" + "g" — so the join is kept only when it lands on
 * one of these. A complete address followed by a short word is the other shape, and it never does:
 * "gmail.com" + "Car", "P" or "I" from the next line of the CV made "gmail.comcar", "gmail.comp" and
 * "gmail.comi" — six production candidates, read at HIGH confidence, whose mail would bounce
 * (George Samir Lotfy's among them, 2026-10-19; owner: "Fix broken Gmail endings").
 */
const WRAPPED_EMAIL_ENDINGS: ReadonlySet<string> = new Set([
  "com", "net", "org", "edu", "gov", "info", "co", "io", "me", "eg", "sa", "ae", "kw", "qa", "uk", "us",
]);

/**
 * An email or URL broken by a line break, rejoined. Deliberately narrow: the email rule fires only
 * when the two halves TOGETHER form a valid address ending in a real ending, so ordinary prose that
 * happens to end a line in "@" — or a whole address followed by a short word — is left alone.
 */
export function repairWrappedContacts(text: string): string {
  return (
    text
      // "wafaa borhan75 @gmil.com" — spaces hugging the @ are a layout artifact, never part of an
      // address. Closed up on the same line only, so this cannot join two unrelated lines.
      .replace(/[ \t]+@[ \t]*|@[ \t]+/g, "@")
      // "name@gmail.co\nm" → "name@gmail.com".
      //
      // The tail must be a TLD FRAGMENT — at most three letters, nothing else. Merely checking that
      // the joined string parses as an email is not enough: "…@gmail.com" followed by a line
      // starting "https" joins to "…@gmail.comhttps", which still satisfies a naive address regex
      // because "comhttps" is a run of letters after a dot. Capping the tail at three characters
      // admits the wrapped "m" and rejects the next line of the CV.
      .replace(/([\w.+-]+@[\w-]+(?:\.[\w-]+)*)[ \t]*\n[ \t]*([A-Za-z]{1,3})\b/g, (match, head: string, tail: string) => {
        const joined = `${head}${tail}`;
        const ending = joined.slice(joined.lastIndexOf(".") + 1).toLowerCase();
        return /^[\w.+-]+@[\w-]+\.[A-Za-z]{2,}$/.test(joined) && WRAPPED_EMAIL_ENDINGS.has(ending) ? joined : match;
      })
      // "linkedin.com/in/bishoy-\nsamir" → joined, for a URL split at a hyphen or a slash.
      .replace(/((?:https?:\/\/|www\.)\S*[/-])[ \t]*\n[ \t]*(\S+)/g, "$1$2")
  );
}

// ---------------------------------------------------------------------------
// Hyperlink annotations
// ---------------------------------------------------------------------------

export type ExtractedLink = { readonly label: string; readonly url: string };

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g;

/**
 * Pulls every [label](url) pdf-parse produced. The URL is the trustworthy half — the label is
 * whatever glyphs happened to be painted on the page, and is frequently a truncated copy of the
 * very URL it hides.
 */
export function extractMarkdownLinks(text: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    links.push({ label: (match[1] ?? "").trim(), url: (match[2] ?? "").trim() });
  }
  return links;
}

/** Replaces [label](url) with "label url" so both halves stay greppable by the field rules. */
function flattenMarkdownLinks(text: string): string {
  return text.replace(MARKDOWN_LINK, (_match, label: string, url: string) => {
    const trimmed = label.trim();
    return trimmed && !url.startsWith(trimmed) ? `${trimmed} ${url}` : url;
  });
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

export type NormalizedCvText = {
  /** The repaired text, line-trimmed and with runs of blank lines collapsed. */
  readonly text: string;
  /** Same text, lowercased — every case-insensitive keyword rule shares this one allocation. */
  readonly lower: string;
  /** Non-empty lines, in order, already trimmed. */
  readonly lines: readonly string[];
  /** Hyperlink annotations recovered before flattening. */
  readonly links: readonly ExtractedLink[];
  /** Whether ligature repair actually fired — surfaced so a reviewer can be warned. */
  readonly repaired: boolean;
};

export function normalizeCvText(raw: string): NormalizedCvText {
  const links = extractMarkdownLinks(raw);
  const repaired = looksLigatureCorrupted(raw);

  let text = raw.replace(INVISIBLE, "");
  text = flattenMarkdownLinks(text);
  text = repairLigatures(text);
  // Before tabs are folded to spaces below — a shredded document is diagnosed BY its tabs, so this
  // is the last moment the evidence still exists.
  text = repairShreddedText(text);
  text = repairWrappedContacts(text);
  text = foldArabicIndicDigits(text);
  text = text.replace(DASHES, "-");
  text = text.replace(APOSTROPHES, "'");
  // Normalize line endings, then trim each line and fold bullet glyphs. A tab becomes two spaces:
  // tabs are load-bearing in a CV (a tab is what separates "Job Title — Employer" from its
  // right-aligned date range), so it must not vanish, but it must not read as one word gap either.
  text = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t+/g, "  ").replace(BULLETS, "• ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return { lines, links, lower: text.toLowerCase(), repaired, text };
}
