// A NEW TEST FILE THAT STRIPS COMMENTS BY HAND — .claude/hooks/comment-strip-guard.mjs, 2026-10-12.
//
// `tests/comment-strip-ratchet.test.ts` already refuses every hand-rolled line-wise comment strip
// under `tests/`, with a budget of 0 and an empty grandfather list. It is also the LAST assertion of
// a 977-test shard inside the required `validate` job: on PR 5700 it named its offender after 5m34s
// with `checks` already green, and four of the twenty-five red PR runs on 12 Oct 2026 were that one
// ratchet firing on a newly added test file. The hook moves the same verdict to the Write or Edit
// that introduces the shape. This file pins three things:
//
//   1. The hook itself, driven as a subprocess with real tool payloads — every shape refused, every
//      measured negative allowed, every sanctioned file and every path outside the sweep untouched.
//   2. Its wiring: a PreToolUse hook for Write, Edit and MultiEdit in the dispatch table.
//   3. That it and the CI ratchet share ONE detector. The ratchet imports
//      `.claude/hooks/lib/comment-strip-shapes.mjs` and defines none of its own; a hook that drifts
//      into refusing what CI accepts — or into silence about what CI rejects — is worse than none.
//
// The fixtures below are built by joining lines, as the ratchet's own are: a literal chain here
// would be a real offender in a file the sweep reads. This file is sanctioned for exactly that
// reason (`SANCTIONED_TEST_FILES`), which is itself asserted below — if it ever falls out of that
// list, the ratchet would report these fixtures as offenders.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  SANCTIONED_TEST_FILES,
  isSanctioned,
  lineWiseStripSites,
} from "../.claude/hooks/lib/comment-strip-shapes.mjs";
import { commandOf, dispatchedHookGroups } from "./support/hook-wiring.ts";

const HOOK = ".claude/hooks/comment-strip-guard.mjs";
const LIB = ".claude/hooks/lib/comment-strip-shapes.mjs";
const RATCHET = "tests/comment-strip-ratchet.test.ts";

/** The hook's answer: the refusal reason, or "" for no opinion. */
function runHook(
  tool: string,
  filePath: string | null,
  toolInput: Record<string, unknown>,
  env: Record<string, string> = {},
): string {
  const raw = execFileSync(process.execPath, [resolve(HOOK)], {
    input: JSON.stringify({ tool_name: tool, tool_input: { file_path: filePath, ...toolInput } }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20000,
    env: { ...process.env, ...env },
  });
  if (!raw.trim()) return "";
  const decision = JSON.parse(raw).hookSpecificOutput ?? {};
  assert.equal(
    decision.permissionDecision,
    "deny",
    "the only verdict this hook may emit is deny — anything else would ask the owner to click " +
      "through a refusal whose remedy is a one-line import",
  );
  return String(decision.permissionDecisionReason ?? "");
}

const write = (filePath: string | null, content: string, env?: Record<string, string>) =>
  runHook("Write", filePath, { content }, env);

const TARGET = "tests/new-screen-pins.test.ts";

/** Each shape as a real site wrote it, keyed by what it is. */
const SHAPES: ReadonlyArray<readonly [string, string]> = [
  [
    "the four-prefix filter block",
    [
      "const code = component",
      '  .split("\\n")',
      "  .filter((line) => {",
      "    const t = line.trim();",
      '    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("{/*");',
      "  })",
      '  .join("\\n");',
    ].join("\n"),
  ],
  [
    "the SQL `--` filter",
    [
      "const sqlCode = read(path)",
      '  .split("\\n")',
      '  .filter((line) => !line.trimStart().startsWith("--"))',
      '  .join("\\n");',
    ].join("\n"),
  ],
  [
    "the prefix test written as a regex",
    [
      "const adminListCode = adminList",
      '  .split("\\n")',
      "  .filter((line) => !/^\\s*(\\/\\/|\\*|\\/\\*)/.test(line))",
      '  .join("\\n");',
    ].join("\n"),
  ],
  [
    "the loop that SKIPS a comment line",
    [
      'for (const line of block.split("\\n")) {',
      "  const trimmed = line.trim();",
      '  if (trimmed.startsWith("//")) continue;',
      "  keys.add(trimmed);",
      "}",
    ].join("\n"),
  ],
  ["the whole-line replace", 'const panelCode = panel.replace(/^\\s*\\/\\/.*$/gm, "");'],
];

/** Lines that merely look like one, each taken from a real test that must keep working. */
const NEGATIVES: ReadonlyArray<readonly [string, string]> = [
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
    'const docLines = collected.filter((line) => line.trim().startsWith("//")).length;',
  ],
  [
    "a CSS custom-property prefix",
    'const custom = names.filter((name) => !name.startsWith("--phx-")).join("\\n");',
  ],
  [
    "a replace that strips the `--` MARKER to read the prose",
    'const prose = raw.replace(/^\\s*--/gm, "").replace(/\\s+/g, " ");',
  ],
  ["a guard that returns on something which is not a comment", 'if (trimmed.startsWith("import ")) return;'],
];

function testTheHookRefusesEveryShapeAndNothingElse() {
  for (const [what, shape] of SHAPES) {
    const reason = write(TARGET, shape);
    assert.match(
      reason,
      /strips comments line by line/,
      `${what} must be refused at the Write — the alternative is a five-minute CI round that ends ` +
        "in the same one-line import",
    );
    assert.match(reason, /stripComments/, `the refusal of ${what} must hand over the remedy, not just the complaint`);
    assert.match(
      reason,
      /\.\/support\/comment-strip\.ts/,
      `the refusal of ${what} must name the module the import comes from`,
    );
  }

  for (const [what, line] of NEGATIVES) {
    assert.equal(
      write(TARGET, line),
      "",
      `${what} must pass — it is a real line in tests/ today, and a guard that cries wolf is turned off`,
    );
  }
}

function testTheShapeIsCaughtHoweverTheEditArrives() {
  const [, shape] = SHAPES[0]!;
  const remedy = "const code = stripComments(source);";

  assert.match(
    runHook("Edit", TARGET, { new_string: shape }),
    /strips comments line by line/,
    "an Edit that introduces the shape must be refused, not only a whole-file Write",
  );
  assert.match(
    runHook("MultiEdit", TARGET, { edits: [{ new_string: remedy }, { new_string: shape }] }),
    /strips comments line by line/,
    "a MultiEdit must be read edit by edit — the offending one is rarely the first",
  );
  assert.equal(
    runHook("Edit", TARGET, { old_string: shape, new_string: remedy }),
    "",
    "an Edit REMOVING the shape must pass. The hook reads only the text being introduced, so a " +
      "session can always fold an existing offender onto the stripper — a guard that blocks its " +
      "own remedy would have to be turned off to obey it",
  );
  assert.equal(
    runHook("Read", TARGET, { content: shape }),
    "",
    "this hook has no opinion on a Read — it refuses writing the shape, never seeing it",
  );
}

function testItOnlyCoversWhatTheSweepReads() {
  const [, shape] = SHAPES[0]!;

  assert.equal(write("src/lib/sales/office-allocation.ts", shape), "", "the ratchet sweeps tests/ only");
  assert.equal(write("scripts/check-migrations.mjs", shape), "", "a script is outside the sweep");
  assert.equal(
    write("tests/x.test.tsx", shape),
    "",
    "the sweep reads `.ts` only, and a hook stricter than the check it fronts for refuses work CI accepts",
  );
  assert.match(write("tests/support/new-helper.ts", shape), /strips comments/, "the sweep reads tests/support too");
  assert.match(write("tests/fixtures/deep/thing.ts", shape), /strips comments/, "the sweep is recursive");
  assert.match(
    write("F:\\Phoenix Workforce\\_wt-x\\tests\\new-screen-pins.test.ts", shape),
    /strips comments/,
    "a Windows absolute path is the normal shape of a tool payload here",
  );
  assert.equal(write(null, shape), "", "a payload with no file path must never deny");
  assert.equal(write(TARGET, ""), "", "an empty write must never deny");
}

function testTheSanctionedFilesAreUntouchedAndThisOneIsAmongThem() {
  const [, shape] = SHAPES[0]!;

  assert.ok(
    SANCTIONED_TEST_FILES.has("tests/comment-strip-guard.test.ts"),
    "this file must stay sanctioned: its fixtures ARE the shapes, so the sweep would otherwise " +
      "report them as offenders and the hook would refuse every edit to it",
  );
  for (const sanctioned of SANCTIONED_TEST_FILES) {
    assert.equal(write(sanctioned, shape), "", `${sanctioned} is sanctioned and must not be refused`);
    assert.ok(isSanctioned(`F:/Phoenix Workforce/phoenix-workforce/${sanctioned}`), "absolute paths too");
  }
  assert.match(
    write("tests/not-comment-strip-ratchet.test.ts", shape),
    /strips comments/,
    "a file whose name merely ENDS like a sanctioned one is not sanctioned",
  );
  assert.equal(
    write(TARGET, shape, { PHX_COMMENT_STRIP_OFF: "1" }),
    "",
    "PHX_COMMENT_STRIP_OFF=1 must stand the guard down, the same shape as PHX_PRIMARY_GUARD_OFF — " +
      "a guard with no hatch gets deleted instead of stood down",
  );
}

function testItIsWiredAsAPreToolUseHookForEveryWritingTool() {
  const groups = dispatchedHookGroups("PreToolUse").filter((group) =>
    (group.hooks ?? []).some((hook) => String(commandOf(hook) ?? "").includes("comment-strip-guard.mjs")),
  );
  assert.equal(
    groups.length,
    1,
    "the guard must be wired exactly once in .claude/hooks/dispatch.json — PreToolUse hooks go in " +
      "the dispatch table, never in settings.json, and a hook wired twice runs twice",
  );
  const matcher = String(groups[0]?.matcher ?? "");
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    assert.ok(
      new RegExp(`\\b${tool}\\b`).test(matcher),
      `the matcher must cover ${tool} — the shape arrives through all three, and the one left out ` +
        `is the one a session will use`,
    );
  }
}

function testOneDetectorRatherThanTwoCopiesThatDrift() {
  const ratchet = readFileSync(RATCHET, "utf8");
  const hook = readFileSync(HOOK, "utf8");

  for (const [file, source] of [
    [RATCHET, ratchet],
    [HOOK, hook],
  ] as const) {
    assert.match(
      source,
      /comment-strip-shapes\.mjs/,
      `${file} must import the detector from ${LIB}. Two copies of this detector is the failure ` +
        "this test exists to prevent: the CI ratchet and the hook would answer differently, and " +
        "the hook's answer is the one a session acts on",
    );
    assert.doesNotMatch(
      source,
      /function\s+lineWiseStripSites/,
      `${file} must not define its own detector — delete it and import the shared one`,
    );
  }

  // The detector is the thing both sides share, so prove it is the thing that works.
  const [, shape] = SHAPES[0]!;
  assert.equal(lineWiseStripSites(shape).length, 1, "the shared detector must flag the shape");
  assert.deepEqual(lineWiseStripSites(NEGATIVES[0]![1]), [], "and must stay quiet on the remedy");
}

function testTheHookOwnSelftestPasses() {
  const out = execFileSync(process.execPath, [resolve(HOOK), "--selftest"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  assert.match(out, /0 failed/, `the hook's own selftest must report 0 failed:\n${out}`);
  assert.match(out, /SELFTEST OK/, out);
}

export function runCommentStripGuardTests() {
  testTheHookRefusesEveryShapeAndNothingElse();
  testTheShapeIsCaughtHoweverTheEditArrives();
  testItOnlyCoversWhatTheSweepReads();
  testTheSanctionedFilesAreUntouchedAndThisOneIsAmongThem();
  testItIsWiredAsAPreToolUseHookForEveryWritingTool();
  testOneDetectorRatherThanTwoCopiesThatDrift();
  testTheHookOwnSelftestPasses();
}
