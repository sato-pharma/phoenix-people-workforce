import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { codeEatenByNaiveStrip, stripComments } from "./support/comment-strip.ts";

/**
 * A source-pinning test must not strip comments with a regex that eats the code it is pinning.
 *
 * ## The failure this catches
 *
 * `source.replace(/\/\*[\s\S]*?\*\//g, "")` cannot tell a comment from a string literal. Given a
 * route pattern like `"/api/auth/*"` it reads the `*` as a comment opener and deletes everything
 * up to the next close-comment delimiter, usually hundreds of lines away in another function. Measured
 * 2026-09-02 over the 3,173 files in `src/`, `app/`, `scripts/` and `lib/`, it deletes real code
 * from 39 of them — 62% of `src/lib/security/access-registry.ts`, 53% of
 * `src/config/system-navigation.ts`, 36% of `src/lib/auth/permissions.ts`.
 *
 * A test that strips one of those and then asserts `doesNotMatch` is checking a third of a file
 * and reporting a pin. Nothing goes red: the suite passes, the guard is decorative, and the next
 * person to break the rule it was written to protect is told they did not.
 *
 * The fix is {@link stripComments} in `tests/support/comment-strip.ts`, which scans for string and
 * template state instead of guessing. This ratchet fails when a test strips a file that the naive
 * regex would damage, naming the file and the byte count so the remedy is a one-line import.
 *
 * ## Why it resolves call sites instead of just grepping
 *
 * 9 tests reference an affected file; only 2 of them STRIP one. `territory-preview-link-controls`
 * reads `access-registry.ts` raw and asserts on it positively, which is completely safe. Flagging
 * a test for merely naming a file would have produced 7 false alarms on the first run, and a
 * ratchet that cries wolf is turned off. So this walks stripper → call site → argument → path.
 *
 * That resolution is the fragile part, and a resolver that silently resolves nothing would make
 * this file pass forever while checking nothing. Until 2026-09-25 the guard was a floor on the live
 * pair count: 38 pairs resolved, and fewer than 20 failed the test.
 *
 * That floor is gone, because the population it counted is gone. The last inline naive strip under
 * `tests/` was folded onto {@link stripComments} on 2026-09-25 — 97 JavaScript call sites, 18 SQL
 * and 2 CSS across 115 files — so the sweep resolves ZERO pairs today and a floor on offenders now
 * fails on SUCCESS. {@link testTheResolverWalksStripperToPath} replaces it with the pattern the
 * line-wise half below already uses: the resolver run over fixtures, positives and negatives
 * alike, which do not expire when the tree is clean. {@link SWEPT_FILE_FLOOR} covers the other way
 * to check nothing, which is to sweep an empty tree.
 *
 * ## The second shape: a hand-rolled LINE-WISE filter
 *
 * The naive block regex is not the only way to strip a comment badly, and the check above cannot
 * see the other way at all — because the other way contains no regex. Nine call sites across seven
 * tests had each written a line filter instead:
 *
 *     source.split("\n").filter((line) => {
 *       const t = line.trim();
 *       return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
 *     }).join("\n")
 *
 * It skips a `{/*` line without ever OPENING a comment block, so the BODY of a multi-line JSX
 * comment is scanned as code: the continuation lines are plain indented prose and start with
 * neither `*` nor `//`, so nothing else catches them. It also drops the WHOLE line beginning
 * `{/*`, so real code sharing a line with a one-line JSX comment is never scanned at all.
 *
 * Five of those nine false-positived on a multi-line comment. The one that matters most did the
 * opposite: `direct-orders-collection` pins its screen with a POSITIVE `assert.match`, so a comment
 * cannot turn it red — it turns it GREEN. With the real `Total collected (Finance)` heading renamed
 * on the screen and left behind in a comment above it, that test passed a screen whose heading no
 * longer existed. #4382 folded all nine onto {@link stripComments}; this file could not have caught
 * one of them.
 *
 * {@link lineWiseStripSites} therefore looks for the SHAPE, not for a damaged file. That is the
 * deliberate difference from the check above: the block regex is safe on all but 39 files, so
 * flagging it needs the file resolved, whereas a line filter tracks no block state anywhere — every
 * one of them is one multi-line comment away from the same failure, whatever it is pointed at.
 *
 * Measured 2026-09-25: 47 such call sites in 42 test files. All are now folded onto
 * {@link stripComments} — #4382 took 9, #4388 took 13, and #4390 took the remaining 25 — so
 * {@link GRANDFATHERED} is empty and its budget is 0.
 *
 * ## Three spellings this detector could not see, and the clean tree that was not one
 *
 * With the budget at 0 and the list empty, this check reported a clean tree — and 26 hand-rolled
 * comment-line decisions were sitting in 24 files it had swept. They were written in spellings the
 * detector did not know:
 *
 *     .filter((line) => !line.trimStart().startsWith("--"))   20 sites, SQL
 *     .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))      the prefix test as a REGEX
 *     if (trimmed.startsWith("//")) continue;                  skipped, not removed
 *     .replace(/^\s*\/\/.*$/gm, "")                            no filter anywhere
 *
 * Each has the blindness above, and the SQL ones add their own: a `--` written AFTER code survives,
 * and a `/* … *\/` block survives whole. Measured across the 608 migrations, that left 2,653
 * non-space characters of comment text standing in 34 files. It is not theoretical either —
 * appending `-- the old predicate was not in ('LA003', …)` to a real statement line in the
 * exec-panels migration turns `exec-panels-confidential-reveal` red on a correct file, because its
 * whole job is to assert that predicate is absent from executable SQL.
 *
 * So the detector now reads all three shapes, and the fixtures below carry one of each. A detector
 * that sees one spelling of a shape measures fashion, not the shape — and it says "clean" in
 * exactly the voice it would use if the tree were.
 *
 * A shape detector whose offender count is meant to reach zero cannot be guarded by a floor on
 * offenders at all. That was the argument for this half first, and 2026-09-25 made it true of the
 * block half too. Its guard is
 * {@link testTheLineWiseDetectorFiresOnTheShapesItIsNamedFor} instead: every historical spelling as
 * a fixture, three negatives so it is not simply flagging everything, and a live control that runs
 * the detector over this very file's bytes — the one control that cannot pass while the walk, the
 * paren matcher or the regexes are broken. {@link SWEPT_FILE_FLOOR} covers the remaining way to
 * check nothing, which is to sweep an empty tree.
 */

const TESTS_DIR = "tests";

/**
 * The two files allowed to contain the naive pattern: the sanctioned implementation that exists to
 * measure it, and this ratchet, which must describe what it forbids in order to detect it.
 */
const SANCTIONED = new Set(["tests/support/comment-strip.ts", "tests/comment-strip-ratchet.test.ts"]);

/**
 * Matches the TEXT of a naive block-comment strip inside another file's source — `\/\*` and `\*\/`
 * close together, which covers the `[\s\S]*?` spelling and the `[^]*?` one alike. Deliberately
 * loose: a variant this misses is a variant that escapes the ratchet.
 */
const NAIVE_STRIP_TEXT = /\\\/\\\*[\s\S]{0,24}?\\\*\\\//;

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
const COMMENT_PREFIX_TEST = new RegExp(
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
const COMMENT_SKIP_PREFIX = /startsWith\(\s*(["'`])(?:\/\/|\/\*|\{\/\*|--)\1\s*\)/;

/**
 * `.replace(/^\s*\/\/.*$/gm, "")` — a whole-line comment strip with no `.filter` anywhere.
 *
 * The `$` is load-bearing. `marketing-config-grants` writes `.replace(/^\s*--/gm, "")` to strip the
 * MARKER and read the comment prose it then asserts on: that keeps the text, and folding it onto a
 * stripper would delete the very thing under test. Removing the marker is not removing the comment.
 */
const WHOLE_LINE_COMMENT_REPLACE = new RegExp(
  String.raw`\.replace\(\s*\/\^\\s\*\(?(?:\\\/\\\/|--)[^/\n]*\$\/gm`,
);

/** How far past `if (…)` the `continue` or `return` may sit. A brace and a newline, no more. */
const SKIP_LOOKAHEAD = 40;

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
const SPLIT_LOOKBEHIND = 300;
const JOIN_LOOKAHEAD = 200;

/**
 * A runaway paren scan would swallow the rest of the file and report whatever it found there, so
 * the argument matcher gives up past this. No real filter body comes close.
 */
const MAX_ARGUMENT_CHARS = 2_000;

/** `tests/` holds 1,835 `.ts` files today. A sweep that has stopped reading them must fail. */
const SWEPT_FILE_FLOOR = 1_200;

/**
 * The line-wise strippers that existed when this check was written — 47 sites in 42 files, measured
 * 2026-09-25 — are now ALL folded onto {@link stripComments} (#4382, #4388, and the change that
 * emptied this list). Nothing remains to grandfather.
 *
 * It stays a BUDGET, not a permission: an empty list with a budget of 0 means no test may strip
 * comments line-wise anywhere, so the detector below fails on the very first new site. The list may
 * only shrink — it is already empty — and {@link GRANDFATHERED_SITE_BUDGET} may never rise.
 *
 * Widening the detector to three more spellings the same day surfaced 26 further sites in 24 files.
 * Not one was added here: they were folded, and the budget stayed 0. A widening paid for with a
 * grandfather row is a widening that changed nothing.
 */
const GRANDFATHERED: ReadonlyMap<string, number> = new Map([]);

/** The sum of the budget above. Seeded at 47; every site is now folded, so it is 0. It may never rise. */
const GRANDFATHERED_SITE_BUDGET = 0;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.posix.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Names of functions in `source` whose body performs a naive strip. */
function stripperNames(source: string): Set<string> {
  const names = new Set<string>();
  const matcher = new RegExp(NAIVE_STRIP_TEXT.source, "g");
  for (const hit of source.matchAll(matcher)) {
    const declarations = [
      ...source
        .slice(0, hit.index)
        .matchAll(/(?:function\s+([A-Za-z0-9_]+)\s*\(|const\s+([A-Za-z0-9_]+)\s*=)/g),
    ];
    const nearest = declarations.at(-1);
    if (nearest) names.add(nearest[1] ?? nearest[2]);
  }
  return names;
}

const PATH_LITERAL = /["'`](\.{0,2}[^"'`\n]*\.(?:ts|tsx|mjs|js|jsx))["'`]/;

/** `const NAME = "…"` and `const NAME = anything("…path…")`, so a path held in a constant resolves. */
function constantPaths(source: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of source.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*[^;\n]*/g)) {
    const found = PATH_LITERAL.exec(m[0]);
    if (found && !map.has(m[1])) map.set(m[1], found[1]);
  }
  return map;
}

/** A test path is written relative to `tests/` or to the repo root; both normalise to the root. */
function normalise(candidate: string): string {
  return candidate.replace(/\\/g, "/").replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
}

function resolveArgument(argument: string, constants: Map<string, string>): string | null {
  const trimmed = argument.trim();

  const literal = PATH_LITERAL.exec(trimmed);
  if (literal) return normalise(literal[1]);

  const bare = /^([A-Za-z0-9_]+)$/.exec(trimmed);
  if (bare) {
    const held = constants.get(bare[1]);
    return held ? normalise(held) : null;
  }

  // `read(PATH)`, `readFileSync(PATH, "utf8")`, `source(PATH)` — an identifier inside a call.
  const nested = /\(\s*([A-Za-z0-9_]+)\s*[,)]/.exec(trimmed);
  if (nested) {
    const held = constants.get(nested[1]);
    return held ? normalise(held) : null;
  }

  return null;
}

type Pair = { readonly test: string; readonly file: string };

/**
 * The (test -> stripped source) pairs in ONE file's text.
 *
 * Split out from the tree walk on 2026-09-25 so the resolution can be exercised on a fixture. The
 * live tree no longer contains a single naive stripper, so a run over it proves nothing about
 * whether this still works — see {@link testTheResolverWalksStripperToPath}.
 */
function strippedPairsIn(test: string, source: string): Pair[] {
  const names = stripperNames(source);
  if (names.size === 0) return [];

  const pairs = new Map<string, Pair>();
  const constants = constantPaths(source);
  for (const name of names) {
    const calls = new RegExp(`\\b${name}\\s*\\(([^()]*(?:\\([^()]*\\))?[^()]*)\\)`, "g");
    for (const call of source.matchAll(calls)) {
      const resolved = resolveArgument(call[1], constants);
      if (!resolved || !existsSync(resolved)) continue;
      pairs.set(`${test}::${resolved}`, { test, file: resolved });
    }
  }

  return [...pairs.values()];
}

function resolveStrippedPairs(): Pair[] {
  const pairs = new Map<string, Pair>();

  for (const file of walk(TESTS_DIR)) {
    if (SANCTIONED.has(file)) continue;
    for (const pair of strippedPairsIn(file, readFileSync(file, "utf8"))) {
      pairs.set(`${pair.test}::${pair.file}`, pair);
    }
  }

  return [...pairs.values()];
}

/**
 * The balanced text of the call argument whose `(` sits at `open`, and the index just past its `)`.
 *
 * Paren counting, with no notion of string state — a `(` or `)` written inside a string literal in
 * the filter body would misread where the argument ends. All 47 real sites parse correctly today
 * and the fixtures below pin the shapes, so the cost of that simplification is bounded: a mis-parse
 * that ends early drops the site (the sweep goes quiet on one file, which the live control catches
 * if it ever becomes general), and {@link MAX_ARGUMENT_CHARS} stops one that ends late from reading
 * the rest of the file as a filter body.
 */
function parenthesisedArgument(
  source: string,
  open: number,
): { readonly text: string; readonly end: number } | null {
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
 * benign. The remedy is always the same one-line import of {@link stripComments}.
 */
function lineWiseStripSites(source: string): number[] {
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  const sites = new Set<number>();

  // 1 · the filter shape: `.split(…).filter(<comment prefix test>).join(…)`, or `.some`/`.find`
  //     over the array it keeps.
  for (const hit of source.matchAll(/\.(?:filter|some|find)\s*\(/g)) {
    const open = hit.index + hit[0].length - 1;
    const argument = parenthesisedArgument(source, open);
    if (!argument || !COMMENT_PREFIX_TEST.test(argument.text)) continue;

    const behind = source.slice(Math.max(0, hit.index - SPLIT_LOOKBEHIND), hit.index);
    const ahead = source.slice(argument.end, argument.end + JOIN_LOOKAHEAD);
    if (!/\.split\s*\(/.test(behind) && !/\.join\s*\(/.test(ahead)) continue;

    sites.add(lineOf(hit.index));
  }

  // 2 · the loop shape: `if (line.startsWith("//")) continue;` inside a walk over split lines. It
  //     strips nothing and allocates nothing, which is exactly why a `.filter`-only detector cannot
  //     see it — the comment is skipped rather than removed, with the identical blindness.
  for (const hit of source.matchAll(/\bif\s*\(/g)) {
    const open = hit.index + hit[0].length - 1;
    const argument = parenthesisedArgument(source, open);
    if (!argument || !COMMENT_SKIP_PREFIX.test(argument.text)) continue;

    const ahead = source.slice(argument.end, argument.end + SKIP_LOOKAHEAD);
    if (!/^\s*\{?\s*(?:continue|return)\b/.test(ahead)) continue;

    sites.add(lineOf(hit.index));
  }

  // 3 · the replace shape: `.replace(/^\s*\/\/.*$/gm, "")`, which is the line filter written as one
  //     regex. No split, no filter, no join — nothing for the first two passes to find.
  for (const hit of source.matchAll(new RegExp(WHOLE_LINE_COMMENT_REPLACE.source, "g"))) {
    sites.add(lineOf(hit.index));
  }

  return [...sites].sort((a, b) => a - b);
}

/**
 * The detector must be shown to fire, on a case small enough to read. Without this, every
 * assertion below would pass just as happily if `codeEatenByNaiveStrip` always returned 0.
 */
function testTheDetectorCatchesTheTrapItIsNamedFor() {
  const trap = [
    'const PUBLIC_ROUTES = ["/api/auth/*"];',
    'const SECRET_GATE = "must-not-vanish";',
    "/** A genuine comment, whose closer the naive strip pairs with the route pattern above. */",
  ].join("\n");

  const naive = trap.replace(/\/\*[\s\S]*?\*\//g, "");

  assert.ok(
    !naive.includes("SECRET_GATE"),
    "the naive strip must delete the line between the route pattern and the comment — if this " +
      "ever stops being true the whole ratchet is checking a bug that no longer exists",
  );
  assert.ok(
    codeEatenByNaiveStrip(trap) > 0,
    "the detector must report the code the naive strip ate",
  );
  assert.ok(
    stripComments(trap).includes("SECRET_GATE"),
    "and the sanctioned stripper must keep it, or it is no remedy",
  );
  assert.equal(
    codeEatenByNaiveStrip("const a = 1;\n/* just a comment */\nconst b = 2;\n"),
    0,
    "a file whose only block comment is genuine must not be reported — a detector that flags " +
      "everything is the same as one that flags nothing",
  );
}

function testNoTestStripsAFileTheStripWouldDamage() {
  const files = walk(TESTS_DIR);

  assert.ok(
    files.length >= SWEPT_FILE_FLOOR,
    `the sweep read only ${files.length} files under ${TESTS_DIR}/, below the floor of ` +
      `${SWEPT_FILE_FLOOR}. Zero offenders is the expected answer here now, which is exactly why ` +
      "the walk has to be proved: a sweep that has stopped seeing the tree gives the same answer " +
      "for the wrong reason. Fix walk(), do not lower the floor.",
  );

  const damaged = resolveStrippedPairs()
    .map((pair) => ({ ...pair, eaten: codeEatenByNaiveStrip(readFileSync(pair.file, "utf8")) }))
    .filter((pair) => pair.eaten > 0)
    .sort((a, b) => b.eaten - a.eaten);

  assert.deepEqual(
    damaged.map((d) => `${d.test} strips ${d.file} (${d.eaten} chars of real code deleted)`),
    [],
    'a test is stripping comments with the naive `replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")`, on a ' +
      "file where that regex deletes real code as well. Any assertion made against the result is " +
      "reading a partial file, and a negative one passes for the wrong reason. Import " +
      "`stripComments` from tests/support/comment-strip.ts instead — it scans for string and " +
      "template state, so a route pattern cannot open a comment.",
  );
}

/**
 * The line-wise detector, shown to fire on every spelling it was written for and to stay quiet on
 * three things that are not strippers.
 *
 * This is the whole degradation guard for the check below, and it carries that weight because a
 * floor on offenders cannot: the offender count is MEANT to fall to zero as the 42 files are
 * folded, so `found >= n` would have to be retired exactly when it started mattering. Fixtures do
 * not expire. The negatives matter as much as the positives — a detector that flags every `.filter(`
 * in `tests/` would be silenced within a day, which is the failure mode the resolution above was
 * built to avoid.
 */
/**
 * The resolver, shown to walk stripper -> call site -> argument -> path, and to stay quiet on three
 * things that are not a test stripping a damaged file.
 *
 * This is the whole degradation guard for the check above, and it took over from a floor on the
 * live pair count on 2026-09-25 when that count reached zero. A resolver that quietly resolves
 * nothing is the failure mode: the `damaged` assertion above would then read an empty list and
 * report a clean tree forever, whatever `tests/` actually held.
 *
 * The positives point at a file the naive strip really does damage, so this also exercises the
 * existence gate and {@link codeEatenByNaiveStrip} end to end, on the same path the sweep uses.
 */
function testTheResolverWalksStripperToPath() {
  // 53% of this file is deleted by the naive strip (its route patterns open comments). If it is
  // ever renamed, point the fixtures at another file from the docblock's list — do not delete them.
  const DAMAGED = "src/config/system-navigation.ts";
  assert.ok(
    existsSync(DAMAGED),
    `${DAMAGED} no longer exists, so these fixtures resolve to nothing and would pass for the ` +
      "wrong reason. Point them at another file the naive strip damages.",
  );
  assert.ok(
    codeEatenByNaiveStrip(readFileSync(DAMAGED, "utf8")) > 0,
    `the naive strip no longer damages ${DAMAGED}, so a test stripping it would not be reported ` +
      "and these fixtures prove nothing. Point them at a file it does damage.",
  );

  const positives: ReadonlyArray<readonly [string, string]> = [
    [
      "a named function called with the path written inline",
      [
        "function codeOf(source: string): string {",
        '  return source.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");',
        "}",
        `const code = codeOf(readFileSync("${DAMAGED}", "utf8"));`,
      ].join("\n"),
    ],
    [
      "an arrow const called with a path held in another const",
      [
        `const NAV = "${DAMAGED}";`,
        'const codeOf = (source: string) => source.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");',
        "const code = codeOf(read(NAV));",
      ].join("\n"),
    ],
  ];

  for (const [what, fixture] of positives) {
    assert.deepEqual(
      strippedPairsIn("tests/fixture.test.ts", fixture).map((pair) => pair.file),
      [DAMAGED],
      `the resolver must walk ${what} through to the file it strips. It no longer does, so the ` +
        "sweep above reports a clean tree without looking at one.",
    );
  }

  const negatives: ReadonlyArray<readonly [string, string]> = [
    [
      "a test that merely NAMES an affected file",
      `const NAV = "${DAMAGED}";\nassert.match(readFileSync(NAV, "utf8"), /Reps List/);`,
    ],
    [
      "a stripper pointed at a path that does not exist",
      [
        "function codeOf(source: string): string {",
        '  return source.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "");',
        "}",
        'const code = codeOf(readFileSync("src/config/no-such-file.ts", "utf8"));',
      ].join("\n"),
    ],
    [
      "the sanctioned stripper called on the same damaged file",
      [
        'import { stripComments } from "./support/comment-strip.ts";',
        `const code = stripComments(readFileSync("${DAMAGED}", "utf8"));`,
      ].join("\n"),
    ],
  ];

  for (const [what, fixture] of negatives) {
    assert.deepEqual(
      strippedPairsIn("tests/fixture.test.ts", fixture),
      [],
      `the resolver must not report ${what} — 9 tests reference an affected file and only 2 ever ` +
        "stripped one, so flagging a mention would have cried wolf 7 times on the first run",
    );
  }
}

function testTheLineWiseDetectorFiresOnTheShapesItIsNamedFor() {
  const positives: ReadonlyArray<readonly [string, string]> = [
    [
      "the four-prefix block body (ceo-top-movers-share)",
      [
        "const code = component",
        '  .split("\\n")',
        "  .filter((line) => {",
        "    const t = line.trim();",
        '    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");',
        "  })",
        '  .join("\\n");',
      ].join("\n"),
    ],
    [
      "the two-prefix one-line arrow (direct-orders-approval-flow)",
      [
        "const serviceCode = serviceSource",
        '  .split("\\n")',
        '  .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))',
        '  .join("\\n");',
      ].join("\n"),
    ],
    [
      "the CRLF-tolerant split (direct-orders-approval-flow, second site)",
      [
        "const code = source",
        "  .split(/\\r?\\n/)",
        "  .filter((line) => {",
        "    const t = line.trim();",
        '    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("{/*");',
        "  })",
        '  .join("\\n");',
      ].join("\n"),
    ],
    [
      "the whole chain on one physical line (direct-orders-collection)",
      'const controlCode = control.split("\\n").filter((line) => !line.trim().startsWith("//") && ' +
        '!line.trim().startsWith("*") && !line.trim().startsWith("{/*")).join("\\n");',
    ],
    [
      "trimStart, and the array kept rather than re-joined (drive-cabinet-folders)",
      [
        "const codeLines = source",
        '  .split("\\n")',
        '  .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));',
      ].join("\n"),
    ],
    // The three spellings that escaped this detector until 2026-09-25, each taken from a real site.
    [
      'the SQL `--` filter (20 sites, e.g. crm-cutover)',
      [
        "const sqlCode = read(path)",
        '  .split("\\n")',
        '  .filter((line) => !line.trimStart().startsWith("--"))',
        '  .join("\\n");',
      ].join("\n"),
    ],
    [
      "the prefix test written as a REGEX (direct-orders-approval-detail-names)",
      [
        "const adminListCode = adminList",
        '  .split("\\n")',
        "  .filter((line) => !/^\\s*(\\/\\/|\\*|\\/\\*)/.test(line))",
        '  .join("\\n");',
      ].join("\n"),
    ],
    [
      "the loop that SKIPS a comment line rather than removing it (crm-sync-run-columns)",
      [
        'for (const line of block.split("\\n")) {',
        "  const trimmed = line.trim();",
        '  if (trimmed.startsWith("//")) continue;',
        "  keys.add(trimmed);",
        "}",
      ].join("\n"),
    ],
    [
      "a multi-condition skip, where the comment test is not the first arm (api-errors-must-be-thrown)",
      'if (trimmed.startsWith("import ") || trimmed.startsWith("//") || trimmed.startsWith("*")) return;',
    ],
    [
      "the whole-line replace, with no filter anywhere (approvals-hub, sales-brick-move-sales)",
      'const panelCode = panel.replace(/^\\s*\\/\\/.*$/gm, "");',
    ],
  ];

  for (const [what, fixture] of positives) {
    assert.equal(
      lineWiseStripSites(fixture).length,
      1,
      `the detector must flag ${what} — a spelling it misses is a spelling that escapes it`,
    );
  }

  const negatives: ReadonlyArray<readonly [string, string]> = [
    ["the sanctioned remedy", "const code = stripComments(source);"],
    [
      "a split/join filter that is not about comments",
      [
        "const body = source",
        '  .split("\\n")',
        '  .filter((line) => !line.trim().startsWith("import "))',
        '  .join("\\n");',
      ].join("\n"),
    ],
    [
      "a comment-prefix filter that COUNTS rather than strips",
      "const docLines = collected.filter((line) => line.trim().startsWith(\"//\")).length;",
    ],
    // The three that must stay quiet under the wider spellings added on 2026-09-25. Each is a real
    // line in `tests/`, and flagging any of them would make the ratchet wrong rather than strict.
    [
      "a CSS custom-property prefix, which merely begins with the SQL comment marker",
      'const custom = names.filter((name) => !name.startsWith("--phx-")).join("\\n");',
    ],
    [
      "a replace that strips the `--` MARKER to read the comment prose (marketing-config-grants)",
      'const prose = raw.replace(/^\\s*--/gm, "").replace(/\\s+/g, " ");',
    ],
    [
      "a guard that returns on something which is not a comment",
      'if (trimmed.startsWith("import ")) return;',
    ],
  ];

  for (const [what, fixture] of negatives) {
    assert.deepEqual(
      lineWiseStripSites(fixture),
      [],
      `the detector must not flag ${what} — a ratchet that cries wolf is turned off`,
    );
  }

  // The live control. Fixtures prove the regexes; only this proves the detector still works on real
  // file bytes, read off the disk through the same path the sweep uses. This file is the one place
  // in `tests/` guaranteed to contain the shape, because the fixtures above ARE the shape.
  const self = "tests/comment-strip-ratchet.test.ts";
  assert.ok(
    SANCTIONED.has(self),
    "this file must stay sanctioned — it has to spell out the shape in order to detect it, and " +
      "the sweep below would otherwise report its own fixtures as offenders",
  );
  assert.ok(
    lineWiseStripSites(readFileSync(self, "utf8")).length >= positives.length,
    "the detector found fewer sites in this file than it has fixtures. It is reading the disk, " +
      "the paren matcher or the regexes wrongly — not passing because the tree is clean",
  );
}

/**
 * No test under `tests/` strips comments with a hand-rolled line filter, beyond the ones that
 * already did on 2026-09-25.
 */
function testNoNewTestStripsCommentsLineWise() {
  const files = walk(TESTS_DIR);

  assert.ok(
    files.length >= SWEPT_FILE_FLOOR,
    `the sweep read only ${files.length} files under ${TESTS_DIR}/, below the floor of ` +
      `${SWEPT_FILE_FLOOR}. A sweep that has stopped seeing the tree reports no offenders for the ` +
      "wrong reason. Fix walk(), do not lower the floor.",
  );

  const budgeted = [...GRANDFATHERED.values()].reduce((sum, n) => sum + n, 0);
  assert.ok(
    budgeted <= GRANDFATHERED_SITE_BUDGET,
    `the grandfather list now budgets ${budgeted} sites, above the ${GRANDFATHERED_SITE_BUDGET} it ` +
      "was seeded with. It may only shrink: fold the file onto stripComments and delete its row, " +
      "never add one.",
  );

  const vanished = [...GRANDFATHERED.keys()].filter((file) => !existsSync(file));
  assert.deepEqual(
    vanished,
    [],
    "a grandfathered file no longer exists, so its row is keeping a budget alive for nothing and " +
      "would silently re-permit the shape if the name were ever reused. Delete these rows.",
  );

  const offenders: string[] = [];
  for (const file of files) {
    if (SANCTIONED.has(file)) continue;

    const sites = lineWiseStripSites(readFileSync(file, "utf8"));
    const allowed = GRANDFATHERED.get(file) ?? 0;
    if (sites.length <= allowed) continue;

    offenders.push(
      `${file} strips comments line-wise at line ${sites.join(", ")} ` +
        `(${sites.length} site(s), ${allowed} grandfathered)`,
    );
  }

  assert.deepEqual(
    offenders,
    [],
    "a test is deciding line by line whether something is a comment — with a `.filter`, an " +
      "`if (…) continue`, or a whole-line `.replace`. Every spelling shares one blindness: a line " +
      "is judged by how it STARTS, so nothing tracks whether a comment is already open. In JS/TSX " +
      "the body of a multi-line `{/* … */}` is then scanned as code (its continuation lines begin " +
      "with neither `*` nor `//`), and the whole line beginning `{/*` is dropped, so real code " +
      "sharing it is never scanned at all. In SQL a `--` written AFTER code survives untouched, " +
      "and a `/* … */` block survives entirely — measured 2026-09-25, 2,653 characters of comment " +
      "text across 34 of the 608 migrations. A negative assertion then fails on the comment; a " +
      "positive one PASSES on a file that no longer has the thing it pins. Import `stripComments` " +
      "(JS/TSX), `stripSqlComments` (SQL) or `stripCssComments` (CSS) from " +
      "tests/support/comment-strip.ts and call it on the source instead.",
  );
}

export function runCommentStripRatchetTests() {
  testTheDetectorCatchesTheTrapItIsNamedFor();
  testTheResolverWalksStripperToPath();
  testNoTestStripsAFileTheStripWouldDamage();
  testTheLineWiseDetectorFiresOnTheShapesItIsNamedFor();
  testNoNewTestStripsCommentsLineWise();
}
