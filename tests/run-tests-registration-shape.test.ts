// EVERY runTest CALL IN tests/run-tests.ts IS ("a name", aRunFunction) — TWO ARGUMENTS, NOTHING
// ELSE.
//
// WHY THIS EXISTS, MEASURED. Of the 17 `checks/Typecheck` reds on PRs between 9 and 13 Oct 2026,
// THREE were this one shape in this one file:
//
//     tests/run-tests.ts(…): error TS2554: Expected 2 arguments, but got 4.
//     tests/run-tests.ts(…): error TS2554: Expected 2 arguments, but got 1.
//
// Nothing a developer wrote. tests/run-tests.ts is a 5,400-line wall of two-line registrations, and
// every branch that adds a test adds a line in the same region, so the file conflicts on almost
// every merge. git rerere replays the resolution it learned, and when the surrounding lines have
// shifted it merges the TAIL of one registration into the HEAD of the next — leaving one call
// holding four arguments and, further down, one holding only its name. The two tests involved then
// do not run at all, and nothing says so: both registered names are still in the source, both
// imports are still there, the suite still reports success for the tests it did reach, and the only
// evidence is a TS2554 in a DIFFERENT required job from the one that runs the tests.
//
// So this is the `test-wiring-complete` failure mode one step further on. That gate proves a test
// file is imported AND invoked; this proves the invocation is still a well-formed call. A collapsed
// pair passes it on both counts, and is invisible to `pnpm run test`, which type-checks nothing
// (`a-green-test-run-carries-no-type-signal-at-all`).
//
// WHY IT IS SAFE TO ASSERT SO NARROW A SHAPE. Measured on this file, 13 Oct 2026: 2,393 occurrences
// of the call, of which 2,392 are exactly <string literal>, <bare identifier> and the one remainder
// is the function's own declaration. There is no legitimate third shape to accommodate — no inline
// arrow, no spread, no options object, no partial application — so anything else is either the
// collapse above or a new convention that should be decided deliberately rather than arrive through
// a merge artefact.
//
// THE NAME MAY BE SINGLE- OR DOUBLE-QUOTED, AND MAY BE CONCATENATED. 65 of the registrations are
// single-quoted, because the registered name itself contains a double quote; and three are built as
// `'one part ' + 'the next'` across two lines. A gate that demanded one double-quoted literal would
// have reported 68 false offenders on a clean tree — all 68 were found by running this against the
// real file before it was registered, not reasoned about afterwards.
//
// AND THE SCAN IS CODE-LEVEL, NOT A REGEX OVER THE TEXT. A registered name is free prose, and this
// test's own registration names the function it is about — so a plain text search would find that
// mention inside a string literal, parse the prose after it as an argument list, and report a
// false offender in the very line that registers this file. The walk below tracks quote state and
// only counts an occurrence that is actually code.
//
// Source text is read through the shared `stripComments`, as every source-pinning test here must
// be: a hand-rolled stripper is refused at the Write by .claude/hooks/comment-strip-guard.mjs, and
// `comment-strip-ratchet` is itself one of the gates this file is run beside.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/** The file every test in this repo is registered in. Read relative to the repo root, as cwd. */
const RUNNER = "tests/run-tests.ts";

/** The function whose call shape this pins. */
const CALLEE = "runTest";

/**
 * Below this many parsed calls, something is wrong with the reader rather than the file.
 *
 * 🔴 A SOURCE GATE WITH NO FLOOR PASSES VACUOUSLY. If `stripComments` ever changed shape, or the
 * registration style moved, the walk below would find nothing and this file would report a clean
 * sweep of zero calls — the way a sweep reports a clean machine it never looked at. 2,392 calls
 * were parsed on 13 Oct 2026; the floor sits well under that, so adding or retiring tests never
 * touches it, and far above zero.
 */
const MINIMUM_CALLS = 2_000;

/** A bare identifier — the only thing the second argument is ever allowed to be. */
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Is the first argument a STATIC name — one or more quoted literals joined by `+`, and nothing else?
 *
 * Not a regex, because a backreference cannot span a concatenation and the literals here are a
 * thousand characters of prose carrying quotes, commas and escapes. A template literal is
 * deliberately rejected along with every expression: the point of a static name is that the gate
 * which reads this file can report WHICH test is broken, which an interpolated name cannot promise.
 */
function isStaticName(argument: string): boolean {
  let i = 0;
  let expectLiteral = true;

  while (i < argument.length) {
    while (i < argument.length && /\s/.test(argument[i])) i += 1;
    if (i >= argument.length) break;

    if (expectLiteral) {
      const quote = argument[i];
      if (quote !== '"' && quote !== "'") return false;
      i += 1;
      let closed = false;
      for (; i < argument.length; i += 1) {
        if (argument[i] === "\\") {
          i += 1;
          continue;
        }
        if (argument[i] === quote) {
          closed = true;
          i += 1;
          break;
        }
      }
      if (!closed) return false;
      expectLiteral = false;
      continue;
    }

    if (argument[i] !== "+") return false;
    i += 1;
    expectLiteral = true;
  }

  // Ending while still expecting a literal means a dangling `+`, or an empty argument.
  return !expectLiteral;
}

type Occurrence = { at: number; argsFrom: number; isDeclaration: boolean };

/**
 * Every place the source really CALLS or DECLARES `runTest`, ignoring the name wherever it appears
 * inside a string literal.
 *
 * A template literal's `${…}` interpolation is treated as string too. That is deliberate and costs
 * nothing: no registration is built that way, and the alternative — tracking brace depth back out
 * into code — is complexity in exchange for a case that does not exist here.
 */
function occurrences(source: string): Occurrence[] {
  const found: Occurrence[] = [];
  let quote: string | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch !== CALLEE[0]) continue;
    if (/[\w$]/.test(source[i - 1] ?? "")) continue;

    const opens = /^\s*\(/.exec(source.slice(i + CALLEE.length, i + CALLEE.length + 8));
    if (source.slice(i, i + CALLEE.length) !== CALLEE || opens === null) continue;

    found.push({
      at: i,
      argsFrom: i + CALLEE.length + opens[0].length,
      // `async function runTest(name: string, execute: …)` — the declaration itself. Recognised by
      // what precedes it rather than by a line number, so moving it does not break this.
      isDeclaration: /\bfunction\s+$/.test(source.slice(Math.max(0, i - 24), i)),
    });
  }
  return found;
}

/**
 * Split the argument list beginning at `open`, at TOP-LEVEL commas only.
 *
 * A regex cannot do this: the registered names run to a thousand characters of prose and contain
 * commas, parentheses, quotes and escapes. This walks the text instead, tracking quote state and
 * bracket depth, and returns `null` if the list never closes.
 */
function splitArguments(source: string, open: number): string[] | null {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      current += ch;
      if (ch === "\\") {
        current += source[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")" && depth === 0) {
      parts.push(current);
      return parts;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return null;
}

/**
 * The 1-based line a character offset falls on, so an offender can be opened at it.
 *
 * 🔴 CALLED ONLY FOR AN OFFENDER, NEVER PER CALL. Counting newlines from 0 is O(offset), and doing
 * it once for each of 2,392 registrations in a 1.5 MB file cost 3.3s of the run — measured, and the
 * reason this gate reports in well under a tenth of that now. Offenders are rare by construction,
 * so the slow path is the only place that pays.
 */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/** Enough of an argument to recognise, never the whole thousand-character name. */
function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

export function runRunTestsRegistrationShapeTests() {
  const source = stripComments(readFileSync(RUNNER, "utf8"));

  const offenders: string[] = [];
  let declarations = 0;
  let calls = 0;

  for (const occurrence of occurrences(source)) {
    if (occurrence.isDeclaration) {
      declarations += 1;
      continue;
    }

    calls += 1;
    const where = () => `${RUNNER}:${lineOf(source, occurrence.at)}`;
    const parts = splitArguments(source, occurrence.argsFrom);
    if (parts === null) {
      offenders.push(`${where()} — the argument list never closes`);
      continue;
    }

    // A trailing comma leaves a final empty part; that is formatting, not a third argument.
    const args = parts
      .map((part) => part.trim())
      .filter((part, index) => !(index === parts.length - 1 && part === ""));

    if (args.length !== 2) {
      offenders.push(
        `${where()} — ${args.length} argument(s), not 2: ` +
          args.map((arg) => clip(arg, 60)).join(" | "),
      );
      continue;
    }
    if (!isStaticName(args[0])) {
      offenders.push(
        `${where()} — the first argument is not a static quoted name: ` + clip(args[0], 80),
      );
    }
    if (!BARE_IDENTIFIER.test(args[1])) {
      offenders.push(
        `${where()} — the second argument is not a bare run function: ` + clip(args[1], 80),
      );
    }
  }

  assert.equal(
    declarations,
    1,
    `expected ${CALLEE}'s own declaration exactly once in ${RUNNER} and to skip it, found ${declarations} — ` +
      "at 0 this test skipped nothing and is reading a file it no longer understands",
  );

  assert.ok(
    calls >= MINIMUM_CALLS,
    `only ${calls} ${CALLEE} calls were parsed in ${RUNNER}, under the floor of ${MINIMUM_CALLS} — ` +
      "this test is reading the file wrongly, so a clean result here would mean nothing",
  );

  assert.deepEqual(
    offenders,
    [],
    'a test registration in tests/run-tests.ts is not ("a name", aRunFunction). That is the shape a ' +
      "rerere-replayed merge of this file leaves behind — it folds the tail of one registration into " +
      "the head of the next, so two tests stop running while both names and both imports survive, " +
      "and the only evidence is a TS2554 in the `checks` job rather than a test failure. Fix the " +
      "registration; do not relax this test.",
  );

  // 🔴 A FAILING TEST IS RECORDED AND THE SUITE CARRIES ON (26 Oct 2026). Until then runTest's catch
  // rethrew, so a shard died at its first red test and every test after it never ran: on 8 branches
  // in one week the next push found a second red that had been hiding behind the first. The catch
  // must record, mark the run red and return; the end of the file must end a red run itself, or a
  // failed test that left a server open would hang the job the old rethrow used to end.
  const declaredAt = source.indexOf(`async function ${CALLEE}(`);
  assert.ok(declaredAt >= 0, `${CALLEE}'s own declaration must exist in ${RUNNER}`);
  const bodyEnd = source.indexOf("\n}\n", declaredAt);
  assert.ok(bodyEnd > declaredAt, `${CALLEE}'s body never closes at the top level`);
  const body = source.slice(declaredAt, bodyEnd);
  const catchAt = body.indexOf("} catch (error) {");
  assert.ok(catchAt >= 0, `${CALLEE} must catch a failing test`);
  const handler = body.slice(catchAt);
  assert.equal(
    /\bthrow\b/.test(handler),
    false,
    `${CALLEE}'s catch rethrows again — a shard would stop at its first red test and hide every one after it`,
  );
  assert.ok(handler.includes("failedTests.push(name);"), `${CALLEE}'s catch must record the failing test`);
  assert.ok(handler.includes("process.exitCode = 1;"), `${CALLEE}'s catch must still make the run red`);
  assert.ok(
    source.includes("setTimeout(() => process.exit(1), 5_000).unref();"),
    "a red run must end itself after its summary, or a failed test's open handle hangs the CI job",
  );
}
