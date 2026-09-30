import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { RETIRED_DAILY_NAME, rollupBranchName } from "../scripts/rollup-branch-name.mjs";

/**
 * The roll-up branch name has to be unique across HISTORY, not just among the branches alive today.
 *
 * It was `codex/rollup-<YYYYMMDD>` — one name per day. Two roll-ups in one day reuse it, and the reuse
 * is silent: `delete_branch_on_merge` removes the remote branch the moment the first roll-up merges, so
 * `git switch --create` succeeds and nothing objects. What breaks is a LOOKUP, later —
 *
 *   gh pr list --head codex/rollup-20260930 --state merged
 *
 * matches TWO pull requests and returns the older one. That is the query `new-session.mjs --remove`
 * uses to decide a worktree is safe to delete, and the one `rollup-prs.mjs --settle` reasons from when
 * it closes a carried PR. Both read a match as PERMISSION, which is why a wrong answer there is worse
 * than a crash. A second roll-up was held back for this on 2026-09-30, the same day #4871 merged.
 *
 * The direction of the `isTaken` failure mode is the other half of this. A clock is an assumption, so
 * the name is checked against history rather than trusted — and anything the check cannot determine
 * must answer TAKEN, because a false "free" produces the ambiguous lookup while a false "taken" costs
 * one harmless suffix. `gh()` in that script returns '' on failure and never null, so the empty string
 * has to be read as a failed call rather than as an empty list.
 */
export function runRollupBranchNameTests(): void {
  const at = (iso: string) => new Date(iso);
  const free = () => false;

  // ── 1. The minute is in the name, so two roll-ups in one day cannot collide ──────────────────
  {
    const morning = rollupBranchName({ now: at("2026-09-30T08:00:45Z"), isTaken: free });
    const later = rollupBranchName({ now: at("2026-09-30T11:00:41Z"), isTaken: free });
    assert.equal(morning, "codex/rollup-20260930-0800");
    assert.equal(later, "codex/rollup-20260930-1100");
    assert.notEqual(morning, later, "two roll-ups on one day must not share a name");
    for (const name of [morning, later]) {
      assert.doesNotMatch(name, RETIRED_DAILY_NAME, `${name} must not be the retired one-per-day shape`);
    }
  }

  // ── 2. A name already used ANYWHERE in history is stepped over, not reused ───────────────────
  // Not "already a live branch": a merged roll-up's branch is deleted, and its PR is what makes the
  // lookup ambiguous. So the predicate is asked about history and the answer is respected.
  {
    const used = new Set(["codex/rollup-20260930-1100", "codex/rollup-20260930-1100-2"]);
    const name = rollupBranchName({ now: at("2026-09-30T11:00:00Z"), isTaken: (n) => used.has(n) });
    assert.equal(name, "codex/rollup-20260930-1100-3", "it steps past every used name rather than reusing one");
    assert.equal(used.has(name), false);
  }

  // ── 3. It THROWS rather than handing back a colliding name ───────────────────────────────────
  // Returning a taken name is the whole failure being prevented, so exhausting the suffixes must stop
  // the build before it pushes anything — never fall back to the base name.
  {
    assert.throws(
      () => rollupBranchName({ now: at("2026-09-30T11:00:00Z"), isTaken: () => true }),
      /already used/,
      "with every candidate taken it must throw, not return one of them",
    );
  }

  // ── 4. The same minute is stable, so a retry does not invent a second branch ─────────────────
  {
    const a = rollupBranchName({ now: at("2026-09-30T11:00:41Z"), isTaken: free });
    const b = rollupBranchName({ now: at("2026-09-30T11:00:59Z"), isTaken: free });
    assert.equal(a, b, "two reads inside one minute give one name — the suffix handles a real collision");
  }

  // ── 5. The script asks history, and reads an unknown as TAKEN ────────────────────────────────
  {
    const source = readFileSync("scripts/rollup-prs.mjs", "utf8");
    assert.match(source, /rollupBranchName\(\{/, "the script builds its branch name through the tested function");
    assert.doesNotMatch(
      source,
      /`codex\/rollup-\$\{stamp\}`/,
      "the retired one-per-day name must be gone from the script, not merely unused",
    );
    assert.match(source, /'--state', 'all'/, "it asks about pull requests in ANY state — a closed roll-up makes the lookup ambiguous too");
    assert.match(source, /if \(!prs\) return true;/, "and an unreachable GitHub counts as TAKEN, never as free");
    assert.match(
      source,
      /remote === null \|\| remote\.length > 0/,
      "a failed ls-remote counts as taken too",
    );
  }
}
