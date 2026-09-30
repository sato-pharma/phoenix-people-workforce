// TWO ROLL-UPS OVER THE SAME PULL REQUESTS ARE WORSE THAN NO ROLL-UP AT ALL.
//
// A roll-up exists to turn several merges into one. Two of them over overlapping members turn one
// merge back into several AND add their own, which is the opposite of the point — and the second one
// is invisible to the first, because `--apply` looked only at whether its own BRANCH NAME was free
// (rollup-branch-name.mjs) and never at whether the work was already claimed.
//
// Measured on 2026-09-30, three collisions in one afternoon:
//
//   1. #4904 (`codex/rollup-20260930-1000`) and #4905 (`…-1001`) were opened 46 seconds apart with
//      IDENTICAL members — #4901, #4902, #4903 — over the same ten files. Two sessions ran `--apply`
//      in the same minute. The unique-name rule worked perfectly and prevented nothing: the names
//      differed by one minute, so neither run could see the other.
//   2. Then #4901 and #4902 were merged INDIVIDUALLY, out from under #4904, which merged after them.
//      Three intended merges became four. AGENTS.md §6 already says a roll-up's members must not be
//      merged separately; a comment on a PR is not enforcement, which is why that rule alone did not
//      hold.
//   3. `codex/rollup-20260930-1311` was created in the same minute a third session was reading the
//      same open set.
//
// So the question `--apply` must ask is not "is this name free" but "is any of this work already
// carried by an open roll-up". OVERLAP is the test, not equality: a partial overlap is the same
// harm, because whichever roll-up merges first leaves the other carrying members that are already
// on main, and every one of its remaining members is then stuck behind a roll-up nobody can merge.
//
// This module is pure so it can be tested — `--apply` is refused under `PHX_ROLLUP_FIXTURE`, so the
// refusal cannot be reached through the fixture seam the other cases use. The live reading, and the
// rule that an unknown counts as a collision, stay in rollup-prs.mjs where the `gh` call is.

/** Branch-name prefix every roll-up gets from {@link rollupBranchName}. */
export const ROLLUP_BRANCH_PREFIX = 'codex/rollup-';

/**
 * The PR numbers a roll-up's body lists as its members.
 *
 * It matches the line shape the body is BUILT with — `- #4901 — title (3 files)` — and nothing else.
 * A looser `#\d+` sweep would also catch the prose: the body names AGENTS.md sections, quotes
 * `tests/run-tests.ts` as the standing example, and a member's own title can contain an issue
 * reference. Matching the list format keeps a title like "fix(#4123 regression)" from being read as
 * a fourth member and refusing a build for nothing.
 *
 * A body this cannot parse yields NO members, which the caller must treat as unknown rather than as
 * "carries nothing" — see the header.
 */
export function rollupMembers(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  return [...body.matchAll(/^[-*] #(\d+) —/gm)].map((m) => Number(m[1]));
}

/**
 * The open roll-up that already carries some of `wanted`, or `null` when none does.
 *
 * @param wanted   PR numbers this build is about to roll up.
 * @param rollups  Open roll-up PRs, each `{ number, headRefName, members }`. The caller filters to
 *                 {@link ROLLUP_BRANCH_PREFIX} and resolves `members` itself, because reading a body
 *                 is an API call and this has to stay pure.
 * @returns `{ number, headRefName, shared, unreadable }` for the first overlap, or `null`.
 *          `unreadable` marks a roll-up whose members could not be parsed at all: the caller must
 *          refuse on that too, since a body we cannot read is not a body that carries nothing.
 */
export function overlappingRollup({ wanted, rollups }) {
  const want = new Set((wanted ?? []).map(Number).filter((n) => Number.isInteger(n)));
  if (want.size === 0) return null;

  for (const rollup of rollups ?? []) {
    const members = (rollup.members ?? []).map(Number).filter((n) => Number.isInteger(n));
    // A roll-up whose own number is in `wanted` would be rolling itself up; treat it as an overlap
    // rather than reasoning about it, because there is no correct build in that shape either.
    if (members.length === 0) {
      return {
        number: rollup.number,
        headRefName: rollup.headRefName,
        shared: [],
        unreadable: true,
      };
    }
    const shared = [...want].filter((n) => members.includes(n)).sort((a, b) => a - b);
    if (shared.length > 0) {
      return {
        number: rollup.number,
        headRefName: rollup.headRefName,
        shared,
        unreadable: false,
      };
    }
  }
  return null;
}
