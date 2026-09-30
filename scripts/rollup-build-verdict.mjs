// A MEMBER CAN MERGE WHILE THE ROLL-UP IS BEING BUILT, AND THAT MUST NOT BE A CRASH.
//
// `--apply` builds its branch by fetching each member and merging it. But the members are live pull
// requests that other sessions are merging, and `delete_branch_on_merge` removes a branch the moment
// its PR merges — so the fetch of a branch that existed a second ago fails. On 2026-09-30 that killed
// a build outright:
//
//   fatal: couldn't find remote ref codex/spotlight-report-it-look
//
// #4875 had merged mid-build. The script died with a half-built local branch and left the worktree
// switched onto it, which then confused the worktree's own retirement gate, because `--remove` judges
// by whatever branch it finds checked out.
//
// Surviving it means three separate things, and skipping is the LAST resort of the three:
//
//   1. a failed fetch is not the question — the member's commit is usually still here from the
//      classification pass, and if we HAVE the object the merge is still exactly as correct as it was.
//      So ask for the object, not for the fetch;
//   2. a member whose commit is genuinely gone is skipped and SAID, never dropped silently;
//   3. and if too few survive, the build is abandoned rather than opening a roll-up that carries one
//      PR — a roll-up of one is a rename with a full CI run attached.
//
// This module holds only the arithmetic of (3), because that is the part with a decision in it.

/** A roll-up must carry at least this many members to be worth one merge instead of several. */
export const MIN_MEMBERS = 2;

/**
 * Whether a build that lost members mid-flight should still be pushed.
 *
 * @param {object} input
 * @param {number} input.carried members merged into the branch successfully.
 * @param {ReadonlyArray<number>} input.skipped PR numbers whose commit was gone by the time we got
 *   to them — merged by someone else while this ran.
 * @returns {{ kind: 'build' } | { kind: 'abandon', why: string }}
 */
export function rollupBuildVerdict({ carried, skipped }) {
  if (carried >= MIN_MEMBERS) return { kind: 'build' };

  const lost = skipped.length
    ? `${skipped.map((n) => `#${n}`).join(', ')} merged while this ran`
    : 'no member survived';
  return {
    kind: 'abandon',
    why:
      `only ${carried} member(s) could be carried — ${lost}. A roll-up needs at least ${MIN_MEMBERS} `
      + 'to replace more than one merge, so nothing is pushed: whatever is left merges on its own.',
  };
}
