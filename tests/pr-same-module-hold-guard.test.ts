import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import {
  HOLD_WINDOW_MS,
  holdDenial,
  holdingPr,
  prScope,
  prTitleFromCommand,
} from "../scripts/pr-same-module-hold.mjs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * bash-guard clause C18 — a second PR for one module is HELD, not opened.
 *
 * THE COST. Every merge to `main` costs two full CI runs whatever its size, and the owner pays for
 * both. On 13 Oct 2026 the repo merged 55 times in a day and the 62 PR branches that day took 122
 * CI runs (1.97 each). A roll-up does not recover that — the roll-up PR pays its own run — so the
 * lever is upstream: related changes to one module go onto ONE branch. AGENTS.md has asked for that
 * ("ONE WIDE PR") since 2026-09-27 and the prose did not hold, so on 2026-10-14 the owner chose a
 * guard on `gh pr create` (cost cuts: "same-module hold").
 *
 * WHAT THIS PINS, in the order a failure would hurt:
 *
 *  1. THE DECISION. The module is the conventional-commit scope of the title. An OPEN PR with a
 *     shared scope holds; a MERGED one holds for 6 hours and not a minute longer; a different scope,
 *     a title with no scope and the dependency / memory plumbing scopes never hold.
 *  2. THE HOOK, AS A SUBPROCESS, exactly as `.claude/settings.json` runs it, against a fake `gh` —
 *     a test that only imported the matcher would pass against a hook wired to nothing. The allow
 *     half matters as much as the deny half: every degraded state (`gh` failing, no readable title)
 *     ALLOWS, because a hold that blocks a real PR on its own blind spot costs more than it saves.
 *  3. THE STAND-DOWN. `PHX_PR_HOLD_OK=1` lets one urgent PR through.
 *  4. THE WIRING. `bash-guard.mjs` must actually load the module and honour the stand-down.
 *
 * Comments are stripped before every source read: this file's prose spells the strings it pins.
 */

const guardPath = resolve(".claude/hooks/bash-guard.mjs");

type Decision = { decision: "allow" | "deny"; reason: string };

const NOW = Date.parse("2026-10-14T12:00:00Z");
const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

/**
 * A directory holding a fake `gh`: `pr list --state open|merged` prints the JSON file the test
 * wrote for it, and a file named `fail` makes it exit 1 like an offline `gh`.
 */
function makeFakeGh(dir: string) {
  writeFileSync(
    join(dir, "fake-gh.mjs"),
    [
      'import { existsSync, readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "const dir = process.env.PHX_FAKE_GH_DIR;",
      'if (existsSync(join(dir, "fail"))) process.exit(1);',
      "const args = process.argv.slice(2);",
      'const state = args[args.indexOf("--state") + 1];',
      'const file = join(dir, state + ".json");',
      'process.stdout.write(existsSync(file) ? readFileSync(file, "utf8") : "[]");',
      "",
    ].join("\n"),
  );
  const script = join(dir, "fake-gh.mjs");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "gh.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
}

export function runPrSameModuleHoldGuardTests() {
  // ── 1. The decision ─────────────────────────────────────────────────────────
  assert.equal(prScope("feat(sales-closing-exports): the ranking wears the Pedia identity"), "sales-closing-exports");
  assert.equal(prScope("fix(Sales-Closing): x"), "sales-closing", "scopes compare lowercased");
  assert.equal(prScope("fix(sales)!: breaking"), "sales", "a breaking-change bang still has a scope");
  for (const unscoped of ["fix: no scope at all", "Merge branch main", "", null, undefined, "docs()"]) {
    assert.equal(prScope(unscoped as string), null, `${String(unscoped)} has no module to hold`);
  }
  for (const plumbing of ["chore(deps): bump next", "chore(deps-dev): bump vitest", "chore(memory): memory fold", "chore(rollup): carry 3"]) {
    assert.equal(prScope(plumbing), null, `${plumbing} is plumbing, never a module`);
  }

  assert.equal(prTitleFromCommand('gh pr create --title "fix(a): b" --body x'), "fix(a): b");
  assert.equal(prTitleFromCommand("gh pr create -t 'fix(a): b' --base main"), "fix(a): b");
  assert.equal(prTitleFromCommand("gh pr create --title=fix(a):b"), "fix(a):b");
  assert.equal(prTitleFromCommand('gh pr create --title "$TITLE"'), "$TITLE", "an unexpanded variable is returned as text");
  assert.equal(prScope(prTitleFromCommand('gh pr create --title "$TITLE"')), null, "...and has no scope, so it allows");
  assert.equal(prTitleFromCommand("gh pr create --fill"), null, "no --title is never guessed at");

  const open = [{ number: 5890, title: "feat(sales-closing-exports): column widths", headRefName: "codex/x" }];
  const held = holdingPr({ title: "fix(sales-closing-exports): the button stays", open, merged: [], now: NOW });
  assert.deepEqual(held, { kind: "open", number: 5890, title: open[0].title }, "an open PR in the same module holds");
  assert.equal(
    holdingPr({ title: "fix(hr-offers): other module", open, merged: [], now: NOW }),
    null,
    "a different module is never held",
  );
  assert.equal(
    holdingPr({ title: "fix(sales, hr-offers): spans two", open, merged: [], now: NOW })?.number,
    undefined,
    "a comma list shares a token only when a token matches",
  );
  assert.equal(
    holdingPr({ title: "fix(sales-closing-exports, hr-offers): spans two", open, merged: [], now: NOW })?.number,
    5890,
    "...and a shared token is the same module",
  );

  const merged = (hours: number) => [
    { number: 5886, title: "feat(sales-closing-exports): the workbook", mergedAt: new Date(NOW - hours * 3600_000).toISOString() },
  ];
  assert.equal(HOLD_WINDOW_MS, 6 * 3600_000, "the hold window is six hours");
  assert.equal(holdingPr({ title: "fix(sales-closing-exports): x", open: [], merged: merged(5.9), now: NOW })?.kind, "merged");
  assert.equal(
    holdingPr({ title: "fix(sales-closing-exports): x", open: [], merged: merged(6.1), now: NOW }),
    null,
    "a PR merged past the window no longer holds its module",
  );
  assert.equal(
    holdingPr({ title: "fix(sales-closing-exports): x", open: [], merged: [{ number: 1, title: "feat(sales-closing-exports): y", mergedAt: "not a date" }], now: NOW }),
    null,
    "an unreadable merge time allows",
  );
  assert.equal(
    holdingPr({ title: "chore(deps): bump", open: [{ number: 7, title: "chore(deps): other bump" }], merged: [], now: NOW }),
    null,
    "dependency bumps never hold each other",
  );

  const text = holdDenial({ title: "fix(sales-closing-exports): x", holder: held!, standDown: "PHX_PR_HOLD_OK=1 <the same command>" });
  assert.match(text, /#5890/, "the refusal names the PR holding the module");
  assert.match(text, /WIDEN THAT PR/, "an open holder is answered with widen-it");
  assert.match(text, /PHX_PR_HOLD_OK=1/, "the refusal says how to stand it down");

  // ── 2. The hook, as a subprocess, against a fake gh ─────────────────────────
  assert.ok(existsSync(guardPath), `bash-guard not found at ${guardPath}`);
  const ghDir = mkdtempSync(join(tmpdir(), "phx-fake-gh-"));
  const cwd = mkdtempSync(join(tmpdir(), "phx-pr-hold-cwd-"));
  makeFakeGh(ghDir);

  const runGuard = (command: string, extraEnv: Record<string, string> = {}): Decision => {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.PHX_PR_HOLD_OK;
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${ghDir}${delimiter}${env[pathKey] ?? ""}`;
    env.PHX_FAKE_GH_DIR = ghDir;
    Object.assign(env, extraEnv);
    const raw = execFileSync(process.execPath, [guardPath], {
      cwd,
      input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
      encoding: "utf8",
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
    });
    if (!raw.trim()) return { decision: "allow", reason: "" };
    const start = raw.indexOf('{"hookSpecificOutput"');
    assert.ok(start >= 0, `hook emitted something that is not a decision:\n${raw}`);
    const output = JSON.parse(raw.slice(start)).hookSpecificOutput;
    return { decision: output.permissionDecision, reason: String(output.permissionDecisionReason ?? "") };
  };
  const setList = (state: "open" | "merged", rows: unknown[]) =>
    writeFileSync(join(ghDir, `${state}.json`), JSON.stringify(rows));
  const create = (title: string) => `gh pr create --title "${title}" --body "text" --base main`;

  try {
    setList("open", [{ number: 5890, title: "feat(sales-closing-exports): column widths", headRefName: "codex/x" }]);
    setList("merged", []);

    const denied = runGuard(create("fix(sales-closing-exports): the button stays"));
    assert.equal(denied.decision, "deny", "a second PR for an open module is refused");
    assert.match(denied.reason, /C18/, "...by C18");
    assert.match(denied.reason, /#5890/, "...naming the PR to widen");

    assert.equal(runGuard(create("fix(hr-offers): another module")).decision, "allow", "a different module goes through");
    assert.equal(runGuard(create("chore(deps): bump next")).decision, "allow", "dependency plumbing goes through");
    assert.equal(runGuard("gh pr create --fill").decision, "allow", "no readable title allows");
    assert.equal(runGuard("gh pr view 5890").decision, "allow", "only `gh pr create` is held");
    assert.equal(runGuard('git commit -m "gh pr create --title \\"fix(sales-closing-exports): x\\""').decision, "allow", "a commit message that spells it is not a PR");

    assert.equal(
      runGuard(create("fix(sales-closing-exports): the button stays"), { PHX_PR_HOLD_OK: "1" }).decision,
      "allow",
      "the environment stand-down lets one PR through",
    );
    assert.equal(
      runGuard(`PHX_PR_HOLD_OK=1 ${create("fix(sales-closing-exports): the button stays")}`).decision,
      "allow",
      "the inline stand-down lets one PR through",
    );

    setList("open", []);
    setList("merged", [{ number: 5886, title: "feat(sales-closing-exports): the workbook", mergedAt: hoursAgo(2) }]);
    const afterMerge = runGuard(create("fix(sales-closing-exports): the button stays"));
    assert.equal(afterMerge.decision, "deny", "a PR merged two hours ago still holds its module");
    assert.match(afterMerge.reason, /#5886/);
    assert.match(afterMerge.reason, /HOLD THIS WORK/, "a merged holder cannot be widened, so the answer is to hold");

    setList("merged", [{ number: 5886, title: "feat(sales-closing-exports): the workbook", mergedAt: hoursAgo(7) }]);
    assert.equal(
      runGuard(create("fix(sales-closing-exports): the button stays")).decision,
      "allow",
      "a PR merged seven hours ago no longer holds",
    );

    setList("open", [{ number: 5890, title: "feat(sales-closing-exports): column widths" }]);
    writeFileSync(join(ghDir, "fail"), "");
    assert.equal(
      runGuard(create("fix(sales-closing-exports): the button stays")).decision,
      "allow",
      "an unreachable gh ALLOWS - the hold never blocks on its own blind spot",
    );
  } finally {
    rmSync(ghDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }

  // ── 4. The wiring ───────────────────────────────────────────────────────────
  const hook = stripComments(readFileSync(guardPath, "utf8")).replace(/\s+/g, " ");
  assert.match(hook, /pr-same-module-hold\.mjs/, "bash-guard must load the decision module");
  assert.match(hook, /PHX_PR_HOLD_OK/, "bash-guard must honour the stand-down");
  assert.match(hook, /holdingPr\(\{ title, open, merged \}\)/, "bash-guard must ask holdingPr with both lists");
}
