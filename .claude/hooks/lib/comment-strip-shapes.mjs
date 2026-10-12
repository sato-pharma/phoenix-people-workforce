// The hand-rolled comment-strip SHAPES, in one place — read by the CI ratchet and by the hook that
// refuses one at the moment it is written.
//
// WHY THIS MODULE EXISTS. `tests/comment-strip-ratchet.test.ts` has detected these shapes since
// 2026-09-25 and fails the required `validate` job on the first new site. It works, and it is also
// the LAST thing in a 977-test shard: measured on 2026-10-09 (PR 5700) it named its offender after
// 5m34s, with `checks` already green, so the run reads healthy until the final second. On 12 Oct
// 2026 that cost four of the twenty-five red PR runs in one day — every one of them a newly added
// test file that stripped comments by hand, every one of them a five-minute round trip to be told
// so. `.claude/hooks/comment-strip-guard.mjs` moves the same verdict to the Write/Edit that
// introduces the shape, which is the only moment it costs nothing to fix.
//
// ONE DEFINITION, NOT TWO COPIES. The precedent beside it (`test-registration-check.mjs`) copies
// its CI guard's regexes verbatim and has a test comparing the copies, because a guard that warns
// about files CI accepts — or stays quiet about files CI rejects — is worse than no guard. Here the
// detector is ~80 lines with a paren matcher, so it is EXTRACTED instead: the ratchet imports
// {@link lineWiseStripSites} from this file and defines none of its own, and
// `tests/comment-strip-guard.test.ts` fails if it ever grows one back. Drift is then not a thing
// that can happen rather than a thing a test watches for.
//
// WHAT THE SHAPES HAVE IN COMMON — the reason this is zero-tolerance and needs no file resolved: a
// line judged by how it STARTS cannot know a block comment is already open. In JS/TSX the body of a
// multi-line `{/* … */}` is scanned as code, and the whole line beginning `{/*` is dropped with any
// real code sharing it; in SQL a `--` after code survives untouched and a block comment survives
// whole. A negative assertion then fails on a comment, and a POSITIVE one passes on a file that no
// longer contains the thing it pins — which is how `direct-orders-collection` pinned a heading that
// had been renamed on the screen and left behind in a comment above it (#4382).
//
// The full account, the 47 sites this was measured over and the three spellings that escaped the
// first detector: the header of `tests/comment-strip-ratchet.test.ts`, and `docs/testing.md`.

/**
 * The files allowed to contain these shapes: the sanctioned implementation that exists to measure
 * them, the ratchet, which must spell out what it forbids in order to detect it, and the guard's own
 * test, whose fixtures ARE the shapes. Both the sweep and the hook skip these three.
 */
export const SANCTIONED_TEST_FILES = new Set([
  "tests/support/comment-strip.ts",
  "tests/comment-strip-ratchet.test.ts",
  "tests/comment-strip-guard.test.ts",
]);

/**
 * Matches the TEXT of a naive block-comment strip inside another file's source — `\/\*` and `\*\/`
 * close together, which covers the `[\s\S]*?` spelling and the `[^]*?` one alike. Deliberately
 * loose: a variant this misses is a variant that escapes the ratchet.
 */
export const NAIVE_STRIP_TEXT = /\\\/\\\*[\s\S]{0,24}?\\\*\\\//;

/**
 * A comment-prefix test applied to one line, in either spelling.
 *
 * `startsWith("//")`, `startsWith("/*")`, `startsWith("{/*")`, `startsWith("*")` and the SQL
 * `startsWith("--")`, in any of three quote styles — and the same test written as a regex,
 * `/^\s*\/\//`, `/^\s*(\/\/|\*|\/\*)/`, `/^\s*--/`.
 *
 * The regex arm and the `--` arm were added on 2026-09-25, after the `startsWith`-only version
 * reported a clean tree while 26 sites in 24 files were still stripping comments by hand: 20 SQL
 * filters keyed on `--`, and six JavaScript ones written with a regex instead. A detector that
 * sees one spelling of a shape measures nothing but fashion.
 *
 * The quote must CLOSE immediately after the marker. `name.startsWith("--phx-")` in
 * `design-tokens-contract` is a CSS custom-property test, not a comment test, and flagging it
 * would be the first false alarm — which is how a ratchet gets switched off.
 */
export const COMMENT_PREFIX_TEST = new RegExp(
  [
    String.raw`startsWith\(\s*(["'\`])(?:\/\/|\/\*|\{\/\*|\*|--)\1\s*\)`,
    String.raw`\^\\s\*\(?(?:\\\/\\\/|\\\*|--)`,
  ].join("|"),
);

/**
 * The same test, for the `if (…) continue` shape, WITHOUT the bare `*` arm.
 *
 * That shape carries no `.split(`/`.join(` to corroborate it (see {@link SPLIT_LOOKBEHIND}), so it
 * is judged on the marker alone — and a bare `"*"` is a markdown bullet as often as a comment
 * continuation. The four unambiguous openers are enough: every real site found on 2026-09-25 used
 * one.
 */
export const COMMENT_SKIP_PREFIX = /startsWith\(\s*(["'`])(?:\/\/|\/\*|\{\/\*|--)\1\s*\)/;

/**
 * `.replace(/^\s*\/\/.*$/gm, "")` — a whole-line comment strip with no `.filter` anywhere.
 *
 * The `$` is load-bearing. `marketing-config-grants` writes `.replace(/^\s*--/gm, "")` to strip the
 * MARKER and read the comment prose it then asserts on: that keeps the text, and folding it onto a
 * stripper would delete the very thing under test. Removing the marker is not removing the comment.
 */
export const WHOLE_LINE_COMMENT_REPLACE = new RegExp(
  String.raw`\.replace\(\s*\/\^\\s\*\(?(?:\\\/\\\/|--)[^/\n]*\$\/gm`,
);

/** How far past `if (…)` the `continue` or `return` may sit. A brace and a newline, no more. */
export const SKIP_LOOKAHEAD = 40;

/**
 * How far either side of the `.filter(` the line-splitting may sit.
 *
 * A `.filter(` testing a comment prefix is only a STRIPPER when the lines came from a split or go
 * back into a join — otherwise it is counting comment lines, or picking them out to assert on, both
 * of which are fine. Measured 2026-09-25 across the 47 real sites: all 47 have a `.split(` behind
 * them within 300 characters, and 45 a `.join(` ahead within 200. The two without a join keep the
 * array and scan it with `.some(...)` / `.find(...)`, which is the identical bug, so either signal
 * alone is enough.
 */
export const SPLIT_LOOKBEHIND = 300;
export const JOIN_LOOKAHEAD = 200;

/**
 * A runaway paren scan would swallow the rest of the file and report whatever it found there, so
 * the argument matcher gives up past this. No real filter body comes close.
 */
export const MAX_ARGUMENT_CHARS = 2_000;

/**
 * The text between `source[open]` — a `(` — and its matching `)`, with the index just past it.
 *
 * Paren counting, with no notion of string state — a `(` or `)` written inside a string literal in
 * the filter body would misread where the argument ends. All 47 real sites parse correctly and the
 * ratchet's fixtures pin the shapes, so the cost of that simplification is bounded: a mis-parse
 * that ends early drops the site, and {@link MAX_ARGUMENT_CHARS} stops one that ends late from
 * reading the rest of the file as a filter body.
 */
export function parenthesisedArgument(source, open) {
  const limit = Math.min(source.length, open + MAX_ARGUMENT_CHARS);
  let depth = 0;
  for (let i = open; i < limit; i += 1) {
    const c = source[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * The 1-based line numbers in `source` where a hand-rolled LINE-WISE comment stripper sits.
 *
 * `.filter(…)` whose body tests a comment prefix on a line, with the line-splitting either behind
 * it or the re-join ahead of it. That is the whole shape, and it is reported wherever it appears:
 * unlike the naive block regex, a line filter is not safe on any file, because it tracks no block
 * state at all — so there is no file to resolve and no measurement that could make one instance
 * benign. The remedy is always the same one-line import of `stripComments`.
 */
export function lineWiseStripSites(source) {
  const text = String(source);
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const sites = new Set();

  // 1 · the filter shape: `.split(…).filter(<comment prefix test>).join(…)`, or `.some`/`.find`
  //     over the array it keeps.
  for (const hit of text.matchAll(/\.(?:filter|some|find)\s*\(/g)) {
    const open = hit.index + hit[0].length - 1;
    const argument = parenthesisedArgument(text, open);
    if (!argument || !COMMENT_PREFIX_TEST.test(argument.text)) continue;

    const behind = text.slice(Math.max(0, hit.index - SPLIT_LOOKBEHIND), hit.index);
    const ahead = text.slice(argument.end, argument.end + JOIN_LOOKAHEAD);
    if (!/\.split\s*\(/.test(behind) && !/\.join\s*\(/.test(ahead)) continue;

    sites.add(lineOf(hit.index));
  }

  // 2 · the loop shape: `if (line.startsWith("//")) continue;` inside a walk over split lines. It
  //     strips nothing and allocates nothing, which is exactly why a `.filter`-only detector cannot
  //     see it — the comment is skipped rather than removed, with the identical blindness.
  for (const hit of text.matchAll(/\bif\s*\(/g)) {
    const open = hit.index + hit[0].length - 1;
    const argument = parenthesisedArgument(text, open);
    if (!argument || !COMMENT_SKIP_PREFIX.test(argument.text)) continue;

    const ahead = text.slice(argument.end, argument.end + SKIP_LOOKAHEAD);
    if (!/^\s*\{?\s*(?:continue|return)\b/.test(ahead)) continue;

    sites.add(lineOf(hit.index));
  }

  // 3 · the replace shape: `.replace(/^\s*\/\/.*$/gm, "")`, which is the line filter written as one
  //     regex. No split, no filter, no join — nothing for the first two passes to find.
  for (const hit of text.matchAll(new RegExp(WHOLE_LINE_COMMENT_REPLACE.source, "g"))) {
    sites.add(lineOf(hit.index));
  }

  return [...sites].sort((a, b) => a - b);
}

/**
 * Is `file` one of the files allowed to carry the shapes? Takes any path spelling — absolute,
 * relative, backslashes — and asks only about the `tests/<name>` tail, because that is how the
 * sweep names them and how a payload's `file_path` arrives.
 */
export function isSanctioned(file) {
  const slashed = String(file || "").replace(/\\/g, "/");
  for (const sanctioned of SANCTIONED_TEST_FILES) {
    if (slashed === sanctioned || slashed.endsWith(`/${sanctioned}`)) return true;
  }
  return false;
}
