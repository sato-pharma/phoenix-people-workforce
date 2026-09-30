// THE ROLL-UP BRANCH NAME HAS TO BE UNIQUE ACROSS HISTORY, NOT JUST AMONG LIVE BRANCHES.
//
// It used to be `codex/rollup-<YYYYMMDD>`, one name per day. Two roll-ups in one day therefore reuse
// it, and the second reuse is the dangerous one: `delete_branch_on_merge` removes the remote branch
// the moment the first roll-up merges, so `git switch --create` succeeds cleanly and nothing anywhere
// objects. What breaks is a LOOKUP, quietly and later —
//
//   gh pr list --head codex/rollup-20260930 --state merged
//
// now matches TWO pull requests, and returns the older one. That is the exact query
// `new-session.mjs --remove` uses to decide a worktree is safe to delete, and the one `--settle`
// reasons from when it closes a carried PR. Both read a match as permission. On 2026-09-30 a second
// roll-up was attempted the same day as merged roll-up #4871 and was held back for this reason.
//
// So the name carries the MINUTE as well as the day, and — because a clock is an assumption and this
// is a lookup that grants permission — it is checked against history rather than trusted. The caller
// supplies `isTaken`, which keeps this module pure and lets a test drive every branch of it.

/** How many suffixed attempts to make before giving up rather than looping. */
const MAX_ATTEMPTS = 20;

/**
 * `codex/rollup-YYYYMMDD-HHMM`, in UTC to match the stamp this replaced, suffixed `-2`, `-3`… if that
 * name has ever been used. Throws rather than returning a name that is already taken: handing back a
 * colliding name is the failure this exists to prevent, and a thrown error stops the build before it
 * pushes anything.
 *
 * @param {object} input
 * @param {Date} input.now clock reading to stamp with.
 * @param {(name: string) => boolean} input.isTaken true when a branch, or ANY pull request past or
 *   present, has already used this name. Anything it cannot determine must answer TRUE — an unknown
 *   must not read as free, because the cost of a false "free" is an ambiguous lookup that grants
 *   permission, and the cost of a false "taken" is one harmless suffix.
 * @returns {string}
 */
export function rollupBranchName({ now, isTaken }) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, '');
  const minute = iso.slice(11, 16).replace(':', '');
  const base = `codex/rollup-${day}-${minute}`;

  if (!isTaken(base)) return base;
  for (let n = 2; n <= MAX_ATTEMPTS; n += 1) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(
    `every roll-up branch name from ${base} to ${base}-${MAX_ATTEMPTS} is already used. `
      + 'Refusing to reuse one: `gh pr list --head <branch> --state merged` would then match two pull '
      + 'requests and return the older, which is what `--remove` and `--settle` read as permission.',
  );
}

/** The old one-per-day shape, kept only so a test can assert the new name is not it. */
export const RETIRED_DAILY_NAME = /^codex\/rollup-\d{8}$/;
