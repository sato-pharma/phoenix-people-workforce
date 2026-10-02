import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkoutPositionLines } from "../scripts/memory-index-budget.mjs";

/**
 * The SessionStart banner must say how far behind `origin/main` the checkout it measured is.
 *
 * WHY THIS EXISTS. Every figure in that banner is counted in the session's own tree, deliberately —
 * a worktree holding a half-finished `AGENTS.md` edit is occupying THIS session's context, so the
 * primary's copy would under-report it. The cost of that choice is that a stale checkout reports a
 * stale margin, and the module already carried the caveat in prose plus the whole account of the
 * misread in a comment.
 *
 * Neither stopped it recurring. On 2026-10-02 the primary's banner read **14 bytes left** of the
 * enforced share while `origin/main` had **1,277** — that checkout was 20 commits behind a trim
 * which had already landed. A session read 14, treated it as an emergency and spent a turn trimming
 * room that already existed. The same stale folder then ran a superseded `new-session.mjs --remove`
 * gate an hour later, which is why this is not only about bytes: the position is the one fact that
 * makes every other number in the banner conditional.
 *
 * WHAT IS PINNED, and in two halves because either alone reads as fixed and is not:
 *   · the FORMATTING, by fixtures — including that an unreadable position is LOUD and a
 *     non-repository is SILENT, which is this module's own rule and the distinction
 *     `autoload-footprint-budget` guards hardest;
 *   · the WIRING, by driving the real hook in a throwaway repository that is genuinely behind. A
 *     formatter nobody calls is the failure mode every source-pinning test here keeps repeating.
 *
 * NO FETCH. The hook reads local refs only — seconds of network on every session start is the worse
 * trade — so the count is a lower bound and the line says so.
 */

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function runSessionStartCheckoutBehindMainTests() {
  // ── 1. The formatter, every shape ───────────────────────────────────────────────────────────
  {
    // Nothing to measure is SILENCE. A scratch session in a folder that is not a repository must
    // not be told its checkout is suspect — there is no checkout.
    assert.deepEqual(checkoutPositionLines(null), [], "a non-repository prints nothing at all");
    assert.deepEqual(checkoutPositionLines(undefined), [], "and so does a missing argument");

    // Level: one quiet line. It still has to be SAID, or a reader cannot tell "current" from
    // "never measured" — the same reason the footprint refuses to let unknown wear the healthy words.
    const level = checkoutPositionLines({ behind: 0, sha: "3da19d616" });
    assert.equal(level.length, 1);
    assert.match(level[0], /3da19d616/);
    assert.match(level[0], /level with the local origin\/main ref/);
    assert.match(level[0], /floor/, "even the healthy line must say the count is a lower bound");
    assert.doesNotMatch(level[0], /BEHIND/, "a current checkout must carry no alarm word");

    // Behind: loud, numbered, and it names both remedies.
    const behind = checkoutPositionLines({ behind: 20, sha: "8cfa02ac4" });
    const text = behind.join("\n");
    assert.match(text, /20 commit\(s\) BEHIND origin\/main/, "the COUNT is the point — prose alone did not work");
    assert.match(text, /8cfa02ac4/, "and it names the sha it measured");
    assert.match(text, /git fetch/, "it must name the re-read");
    assert.match(text, /merge --ff-only origin\/main/, "and the sync, which is what actually fixes it");
    assert.match(text, /14 bytes left where main had 1,277/, "the incident is what makes the line land");
    assert.match(text, /At least this many|as fresh as the last fetch/, "and the count must be stated as a floor");

    // Unreadable is LOUD, never silence and never "level": a detached HEAD, a clone with no
    // origin/main, a shallow CI checkout. The dangerous direction is a stale tree reading as current.
    for (const position of [
      { note: "no comparable origin/main ref in this clone", sha: "abc1234" },
      { note: "could not read HEAD (fatal: not a git repository)" },
      { behind: Number.NaN, sha: "abc1234" },
      { behind: -1, sha: "abc1234" },
      { sha: "abc1234" },
    ]) {
      const lines = checkoutPositionLines(position);
      assert.equal(lines.length, 1, `one line for ${JSON.stringify(position)}`);
      assert.match(lines[0], /POSITION UNKNOWN/, "an unreadable position must say so out loud");
      assert.doesNotMatch(lines[0], /level with/, "and must never borrow the healthy wording");
    }
    // A note with no sha must still produce a usable line rather than "undefined".
    assert.doesNotMatch(checkoutPositionLines({ note: "x" })[0], /undefined/);
  }

  // ── 2. The real hook, in a repository that is genuinely behind ──────────────────────────────
  //
  // This is the half that proves the formatter is CALLED. It builds a throwaway repo with the two
  // auto-loaded files, moves `origin/main` two commits ahead of HEAD, and runs the actual
  // SessionStart hook against it.
  {
    const repoRoot = process.cwd();
    const tmp = mkdtempSync(join(tmpdir(), "phx-banner-"));
    try {
      git(tmp, ["init", "--quiet", "--initial-branch=main"]);
      git(tmp, ["config", "user.email", "test@example.com"]);
      git(tmp, ["config", "user.name", "test"]);
      // The hook resolves the module as `../../scripts/…` from its own file, so the layout matters.
      mkdirSync(join(tmp, ".claude", "hooks"), { recursive: true });
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      copyFileSync(join(repoRoot, ".claude/hooks/memory-index-guard.mjs"), join(tmp, ".claude/hooks/memory-index-guard.mjs"));
      copyFileSync(join(repoRoot, "scripts/memory-index-budget.mjs"), join(tmp, "scripts/memory-index-budget.mjs"));
      writeFileSync(join(tmp, "CLAUDE.md"), "# claude\n".repeat(200));
      writeFileSync(join(tmp, "AGENTS.md"), "# agents\n".repeat(2000));
      git(tmp, ["add", "-A"]);
      git(tmp, ["commit", "--quiet", "-m", "base"]);
      const base = git(tmp, ["rev-parse", "HEAD"]);

      // Two more commits, then point refs/remotes/origin/main at the newer one and HEAD back at the
      // older — exactly the shape of a checkout somebody forgot to pull.
      writeFileSync(join(tmp, "AGENTS.md"), "# agents\n".repeat(2001));
      git(tmp, ["commit", "--quiet", "-am", "ahead one"]);
      writeFileSync(join(tmp, "AGENTS.md"), "# agents\n".repeat(2002));
      git(tmp, ["commit", "--quiet", "-am", "ahead two"]);
      const ahead = git(tmp, ["rev-parse", "HEAD"]);
      git(tmp, ["update-ref", "refs/remotes/origin/main", ahead]);
      git(tmp, ["reset", "--hard", "--quiet", base]);

      assert.equal(git(tmp, ["rev-list", "--count", "HEAD..origin/main"]), "2", "the fixture must really be 2 behind");

      const raw = execFileSync(process.execPath, [join(tmp, ".claude/hooks/memory-index-guard.mjs"), tmp], {
        cwd: tmp,
        encoding: "utf8",
      });
      const context = JSON.parse(raw).hookSpecificOutput.additionalContext as string;

      assert.match(context, /AUTO-LOADED CONTEXT FOOTPRINT/, "the footprint section must still be produced");
      assert.match(
        context,
        /2 commit\(s\) BEHIND origin\/main/,
        "the REAL hook must print the measured position — a formatter nobody calls is the failure "
          + "every source-pinning test here keeps repeating",
      );
      assert.match(context, new RegExp(base.slice(0, 7)), "and it must name the sha it actually measured");
      // It belongs INSIDE the footprint section: the position says which tree those bytes came from,
      // and a section of its own is one more thing to read past.
      const section = context.slice(context.indexOf("AUTO-LOADED CONTEXT FOOTPRINT"));
      assert.match(section, /BEHIND origin\/main/, "the line must sit with the numbers it qualifies");
    } finally {
      rmSync(tmp, { force: true, recursive: true });
    }
  }

  // ── 3. The hook stays a hook: it must never fail a session start ────────────────────────────
  // A hook that throws produces no context at all, which looks exactly like a healthy one — so the
  // git read is wrapped and the whole file still carries its uncaughtException exit.
  {
    const source = readFileSync(join(process.cwd(), ".claude/hooks/memory-index-guard.mjs"), "utf8");
    assert.match(source, /process\.on\("uncaughtException", \(\) => process\.exit\(0\)\)/, "the hook must still fail open");
    const fn = source.slice(source.indexOf("function checkoutPosition"), source.indexOf("const projectDir"));
    assert.ok(fn.length > 100, "could not isolate the position reader — this pin is measuring nothing");
    assert.doesNotMatch(fn, /"fetch"/, "the SessionStart reader must NOT fetch — that is network on every session start");
    assert.match(fn, /timeout: 5000/, "and it must bound the git calls, or a hung git hangs the session start");
    assert.equal((fn.match(/catch/g) ?? []).length >= 3, true, "every git call must be caught — a throw here means no banner at all");
  }

  console.log("session-start checkout behind main: OK");
}
