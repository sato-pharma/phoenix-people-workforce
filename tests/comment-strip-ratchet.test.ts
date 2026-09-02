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
 * this file pass forever while checking nothing. {@link RESOLVED_PAIR_FLOOR} is the guard: 38
 * pairs resolve today, and the floor fails the test long before the resolver degrades to useless.
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

/** 38 pairs resolve today. A resolver that has quietly stopped working must fail, not pass. */
const RESOLVED_PAIR_FLOOR = 20;

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

function resolveStrippedPairs(): Pair[] {
  const pairs = new Map<string, Pair>();

  for (const file of walk(TESTS_DIR)) {
    if (SANCTIONED.has(file)) continue;

    const source = readFileSync(file, "utf8");
    const names = stripperNames(source);
    if (names.size === 0) continue;

    const constants = constantPaths(source);
    for (const name of names) {
      const calls = new RegExp(`\\b${name}\\s*\\(([^()]*(?:\\([^()]*\\))?[^()]*)\\)`, "g");
      for (const call of source.matchAll(calls)) {
        const resolved = resolveArgument(call[1], constants);
        if (!resolved || !existsSync(resolved)) continue;
        pairs.set(`${file}::${resolved}`, { test: file, file: resolved });
      }
    }
  }

  return [...pairs.values()];
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
  const pairs = resolveStrippedPairs();

  assert.ok(
    pairs.length >= RESOLVED_PAIR_FLOOR,
    `only ${pairs.length} (test -> stripped source) pairs resolved, below the floor of ` +
      `${RESOLVED_PAIR_FLOOR}. The resolver has stopped seeing call sites it used to see, so this ` +
      "ratchet is no longer checking anything. Fix resolveStrippedPairs, do not lower the floor.",
  );

  const damaged = pairs
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

export function runCommentStripRatchetTests() {
  testTheDetectorCatchesTheTrapItIsNamedFor();
  testNoTestStripsAFileTheStripWouldDamage();
}
