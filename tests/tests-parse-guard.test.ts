import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parses, REGISTRY } from "../scripts/check-tests-parse.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * `scripts/check-tests-parse.mjs` answers ONE question — does `tests/run-tests.ts` still parse — and it
 * exists because nothing else local could answer it.
 *
 * On 2026-09-30 a registration description in that file was given a double-quoted phrase inside a
 * double-quoted string. `TS1005`. It reached a pull request and was caught by
 * `scripts/remote-check.mjs typecheck` on the CI box, 118 seconds, AFTER the local run had reported
 * green. The local run reported green because it never parsed that file: iterating on one suite means
 * `import('./tests/x.test.ts')` then calling its exported `runXTests()`, which is the right way to work
 * and never loads the registry at all. `pnpm run test` WOULD have crashed on it — `--experimental-strip-types`
 * erases types but still has to parse, and `run-tests.ts` is the suite's own entry point — so the blind
 * spot is the ISOLATED run, not the suite, and the remedy is a 0.3s parse rather than a remote typecheck.
 *
 * 🔴 THIS FILE IS THE GUARD'S OWN GUARD, AND THAT IS ITS WHOLE POINT. A checker that always answers
 * "fine" is indistinguishable from a clean repository, which is the shape of bug that cost four separate
 * fixes to `scripts/rollup-prs.mjs` on the same day (docs/agents-session-traps.md, "Four defects in one
 * afternoon were one bug"). So every case below drives the REAL script as a subprocess against a file
 * written for the occasion, and asserts the NEGATIVE outcomes as hard as the positive one: a broken file
 * must exit 1, an unreadable path must exit 2 rather than reading as a clean parse, and the exact
 * unescaped-quote shape that shipped must be the thing that trips it.
 *
 * The fixtures are built here in TypeScript rather than by a shell, deliberately: writing them with
 * `printf` produced a "good" fixture that did not parse either, because the shell ate the backslashes —
 * a green-looking test whose two cases both failed for the same wrong reason.
 */

type Run = { code: number; out: string };

/** The real script, as a subprocess — the script's own CLI is half of what is being pinned. */
function runGuard(args: string[]): Run {
  try {
    const out = execFileSync(process.execPath, ["scripts/check-tests-parse.mjs", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function fixture(name: string, source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "phx-parse-"));
  const file = path.join(dir, name);
  writeFileSync(file, source, "utf8");
  return file;
}

/**
 * The exact shape that shipped: an inner phrase in plain double quotes inside a double-quoted string.
 * Written as a single-quoted TS literal so the inner quotes reach the file unescaped, which is the
 * defect. Anything else here would be testing the escaping of this test file rather than the guard.
 */
const UNESCAPED = 'await runTest(\n  "a description with an inner "quoted" phrase",\n  runSomething,\n);\n';

/** The same line written correctly — the inner quotes escaped for the file, not for this source. */
const ESCAPED = 'await runTest(\n  "a description with an inner \\"quoted\\" phrase",\n  runSomething,\n);\n';

export function runTestsParseGuardTests(): void {
  // ── 1. The two fixtures differ ONLY in the escaping, or nothing below means anything ─────────
  {
    assert.equal(
      UNESCAPED.replace(/\\"/g, '"'),
      ESCAPED.replace(/\\"/g, '"'),
      "the good and bad fixtures must be the same line with and without escapes — a first attempt at "
        + "this built them with shell printf and BOTH came out broken, which reads as a working guard",
    );
    assert.ok(ESCAPED.includes('\\"'), "the good fixture must actually carry escaped quotes");
    assert.ok(!UNESCAPED.includes('\\"'), "and the bad one must not");
  }

  // ── 2. The unescaped shape does NOT parse, and the escaped one does ─────────────────────────
  {
    const bad = parses(fixture("bad.ts", UNESCAPED));
    assert.equal(bad.ok, false, "the shape that shipped on 2026-09-30 must not parse");
    assert.equal(bad.unreadable, undefined, "and it is a PARSE failure, not a missing file");
    assert.match(String(bad.why), /Expected/, "the parser's own message is what a session needs to see");

    const good = parses(fixture("good.ts", ESCAPED));
    assert.equal(good.ok, true, `the escaped form must parse, got: ${good.why ?? ""}`);
  }

  // ── 3. TYPE annotations are stripped, not rejected — it is a parse of TypeScript ─────────────
  // A guard that choked on ordinary TS would be turned off within the day, and turning it off is the
  // same outcome as it never existing.
  {
    const ts = parses(fixture("typed.ts", "type A = { n: number };\nconst a: A = { n: 1 };\nexport default a satisfies A;\n"));
    assert.equal(ts.ok, true, `ordinary TypeScript must pass, got: ${ts.why ?? ""}`);
  }

  // ── 4. A path that cannot be READ is its own answer, never a clean parse ────────────────────
  // The fail-open this guard would otherwise become: a typo'd path answering "parsed fine".
  {
    const missing = parses("tests/this-file-does-not-exist.ts");
    assert.equal(missing.ok, false, "a file that cannot be read has NOT parsed");
    assert.equal(missing.unreadable, true, "and it says so, so a path typo can never read as a pass");
  }

  // ── 5. The CLI's three exit codes, driven as a session would ────────────────────────────────
  {
    const clean = runGuard(["--registry"]);
    assert.equal(clean.code, 0, `the registry must parse on this branch:\n${clean.out}`);
    assert.match(clean.out, /parsed in \d+ms/, "and it reports how long it took, because 0.3s is the argument for it");
    assert.match(
      clean.out,
      /not a typecheck/,
      "it must SAY it is not a typecheck. A session that reads this as type cover skips the one check "
        + "that reads types, and `bash-guard.mjs` C8 means the local typecheck it replaces is denied anyway",
    );

    const broken = runGuard([fixture("broken.ts", UNESCAPED)]);
    assert.equal(broken.code, 1, `a file that does not parse must exit non-zero:\n${broken.out}`);
    assert.match(broken.out, /DOES NOT PARSE/);

    const absent = runGuard(["tests/this-file-does-not-exist.ts"]);
    assert.equal(absent.code, 2, `an unreadable path exits 2, distinctly from a parse failure:\n${absent.out}`);
    assert.match(absent.out, /COULD NOT READ/);
  }

  // ── 6. The registry is named, and it is the file the guard exists for ───────────────────────
  {
    assert.equal(REGISTRY, "tests/run-tests.ts", "the registry path is the reason this script exists");
    const registry = parses(REGISTRY);
    assert.equal(registry.ok, true, `${REGISTRY} does not parse — \`pnpm run test\` cannot start: ${registry.why ?? ""}`);
  }

  // ── 7. The script never invokes `tsc`, or C8 would refuse the thing meant to replace it ─────
  // `bash-guard.mjs` clause C8 denies every spelling of a local typecheck. This guard's entire value is
  // that it is a parse and therefore allowed; a future edit reaching for `tsc` to "improve" it would
  // make it undeniably refused, and a refused guard prints nothing — the very failure mode C8 exists for.
  {
    const source = readFileSync("scripts/check-tests-parse.mjs", "utf8");
    assert.ok(
      source.includes("stripTypeScriptTypes"),
      "the guard must use Node's own type stripper, which parses without executing — importing "
        + "`run-tests.ts` to find out whether it parses would run the whole suite to answer a question "
        + "about punctuation",
    );
    // Comments are excluded with `stripComments`, NEVER line-wise. A `.filter` on
    // `line.trimStart().startsWith("//")` judges a line by how it STARTS, which is blind to a `/* … */`
    // block and to a `//` inside a string — so `/* tsc */` would survive the strip and this assertion
    // would pass while the code carried exactly the machinery it forbids. That is this PR's own subject
    // pointed at itself, and `tests/comment-strip-ratchet.test.ts` caught the first version of this
    // clause in CI for precisely that reason. The word `typecheck` is deliberately NOT on the list: the
    // script says in its own output that it is not one, and that sentence is the point.
    const codeOnly = stripComments(source);
    for (const machinery of ["tsc", "noEmit", "child_process", "execFileSync", "spawn"]) {
      assert.ok(
        !codeOnly.includes(machinery),
        `the guard's CODE must not reach for \`${machinery}\` — bash-guard C8 denies a local typecheck in `
          + "every spelling, and a denied guard prints nothing at all, which is the failure mode C8 exists for",
      );
    }
  }
}
