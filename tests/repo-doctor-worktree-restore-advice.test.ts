import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// repo-doctor must never tell anyone to run `pnpm install` in a worktree.
//
// `--strip-idle` deletes `node_modules` and `.next` from idle worktrees, and both its offer and its
// completion line closed with "pnpm install restores them" — the one command AGENTS.md §5 forbids
// there. `pnpm install`/`pnpm run` inside a worktree purges the primary's `node_modules` once it
// sees the lockfile has moved, destroying the junction; the restore is
// `node scripts/new-session.mjs --repair <task>`.
//
// It read as authoritative because the tool had just done the stripping, and it is exactly the line
// a tired session copies at 4am without checking it against §5. The script that CREATES worktrees
// always got this right ("Never run pnpm there") — only the one that strips them was wrong, so the
// two tools contradicted each other.
//
// PINNED AS A PATTERN, NOT TWO CALL SITES. The wording regenerates: any future message about
// restoring a stripped worktree gets written by someone reasoning "the caches came from an install,
// so an install brings them back" — true of the primary checkout, false of every worktree. So this
// asserts the shape (every mention in printed output is a prohibition) rather than the two
// sentences that happened to be wrong.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Design rationale in comments may discuss `pnpm install` freely; printed OUTPUT may not.
 *
 * Drops whole comment LINES rather than regex-stripping comment SPANS. The span form was written
 * first and silently ate the very region under test: this file's regex literals contain sequences a
 * non-greedy block-comment match treats as a comment, so the strip swallowed the --strip-idle
 * message entirely and the assertions below ran against text that was no longer there. The baseline
 * caught it only because it was checked before trusting a single red.
 */
function codeOnly(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

export function runRepoDoctorWorktreeRestoreAdviceTests() {
  const doctor = codeOnly(read("scripts/repo-doctor.mjs"));

  // ── 1. Every mention in real output is a prohibition, never an instruction ──
  {
    const mentions = doctor.match(/[^\n]*pnpm install[^\n]*/g) ?? [];
    for (const line of mentions) {
      assert.ok(
        /NEVER/.test(line),
        "repo-doctor must not advise `pnpm install` in its output — a worktree restore is " +
          `\`new-session.mjs --repair\` (AGENTS.md §5). Offending line: ${line.trim()}`,
      );
    }
  }

  // ── 2. Both restore hints name the command that actually works ─────────────
  //
  // Anti-vacuity for check 1: with no restore advice at all, the loop above passes over an empty
  // list. These assert the correct advice is present, in the offer and in the completion line.
  {
    assert.match(
      doctor,
      /Run with --strip-idle[\s\S]{0,200}new-session\.mjs --repair/,
      "the --strip-idle offer must say how to restore a stripped worktree",
    );
    assert.match(
      doctor,
      /path entries reclaimed[\s\S]{0,400}new-session\.mjs --repair/,
      "the post-strip completion line must say how to restore — it is the line that gets copied",
    );
  }

  // ── 3. The doc that seeded both says the same thing ────────────────────────
  //
  // The wrong advice was in the reference doc too, so fixing only the script would leave the next
  // reader to reintroduce it from the prose.
  {
    const doc = read("docs/agents-worktree-and-machine-limits.md");
    const at = doc.indexOf("Restore a stripped worktree");
    assert.ok(at >= 0, "the doc must still explain how to restore a stripped worktree");
    const paragraph = doc.slice(at, at + 400);
    assert.match(paragraph, /new-session\.mjs --repair/, "the doc must name --repair as the restore");
    assert.ok(
      !/Restore a stripped worktree with `pnpm install`/.test(paragraph),
      "the doc must not offer `pnpm install` as a worktree restore",
    );
  }
}
