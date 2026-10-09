/**
 * Refuse to recompute a business rule from a checkout that is BEHIND `origin/main`.
 *
 * WHY THIS EXISTS. On 2026-10-09 three store-split rulings merged within fifteen minutes (#5685's
 * twelve warehouse stems, #5687's طاى جروب, #5689's `تامين`) and were live on production. A session
 * then ran `backfill-attribution-store-split.ts --apply 2026-09` in the PRIMARY checkout, whose
 * local `main` is never fast-forwarded and still sat at `077e838dd`, and wrote 423 net rows computed
 * by pre-merge code — 26 relocation cells short on CNS and Anti Infective. The number was quoted to
 * the owner before it was caught. The same tree had already produced a `DRIFTED — 213 cells /
 * 45,021.99 EGP` reading minutes after a correct rebuild, for the same reason.
 *
 * A rule-recomputing script brings its own code to the comparison, so the tree it runs in IS an
 * input. A stale READ costs a sentence; a stale WRITE sits in production as the number a manager is
 * paid on, and nothing downstream reports it (every line's unit total still balances).
 *
 * WHAT IT CHECKS. Not equality — a feature branch legitimately sits AHEAD of `main`, and a session
 * verifying its own unmerged rule change must be able to run these scripts. The test is ancestry:
 * `origin/main` must be an ancestor of HEAD, i.e. this tree already contains every commit on main.
 * It fetches `origin/main` first (best effort, 20s) because the local remote-tracking ref can itself
 * be hours old.
 *
 * 🔴 IT FAILS OPEN ONLY WHEN GIT CANNOT ANSWER AT ALL, AND SAYS SO LOUDLY. No `origin/main` ref, no
 * git, not a checkout: the script runs with a warning rather than being unusable in a clone that has
 * no remote. Anything git CAN answer is enforced. `PHX_STALE_TREE_OK=1` stands it down for one
 * deliberate run.
 *
 * Account: `docs/testing.md`, "A rule-recomputing script runs from a tree on origin/main".
 */
import { execFileSync } from "node:child_process";

/** Exit code when the tree is behind — EX_UNAVAILABLE, distinct from 64 (bad flags). */
export const STALE_TREE_EXIT_CODE = 69;

export const STALE_TREE_OVERRIDE_ENV = "PHX_STALE_TREE_OK";

export type TreeState = {
  /** HEAD's short sha, or null when git could not answer. */
  head: string | null;
  /** `origin/main`'s short sha, or null when the ref does not exist here. */
  originMain: string | null;
  /** True when every commit on `origin/main` is already in this tree. Null when unknown. */
  originMainIsAncestor: boolean | null;
  /** How many commits on `origin/main` this tree is missing. Null when unknown. */
  behindCount: number | null;
  /** Whether the pre-check fetch of `origin/main` succeeded. */
  fetched: boolean;
};

export type TreeVerdict = {
  allow: boolean;
  /** One line for stdout (allowed) or stderr (refused). Never empty. */
  message: string;
};

function git(args: readonly string[], cwd: string, timeout = 20_000): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
  } catch {
    return null;
  }
}

/** Read the tree's position relative to `origin/main`, fetching that one ref first.
 *
 * `cwd` exists for the test, which builds a real bare remote and a clone genuinely behind it — the
 * only way to exercise the fetch, the ancestry test and the exit code together in one run. */
export function readTreeState(cwd: string = process.cwd()): TreeState {
  const head = git(["rev-parse", "--short", "HEAD"], cwd);
  const fetched = git(["fetch", "--quiet", "origin", "main"], cwd) !== null;
  const originMain = git(["rev-parse", "--short", "origin/main"], cwd);
  if (head === null || originMain === null) {
    return { behindCount: null, fetched, head, originMain, originMainIsAncestor: null };
  }
  const ancestor = git(["merge-base", "--is-ancestor", "origin/main", "HEAD"], cwd);
  const behind = git(["rev-list", "--count", "HEAD..origin/main"], cwd);
  const behindCount = behind === null ? null : Number(behind);
  return {
    behindCount: Number.isFinite(behindCount) ? behindCount : null,
    fetched,
    head,
    originMain,
    // `--is-ancestor` answers by exit status: "" on success, null on a non-zero exit.
    originMainIsAncestor: ancestor === null ? false : true,
  };
}

/**
 * PURE. The whole decision, so it is tested without a repository — including the fail-open branches,
 * which are the ones that would otherwise never be exercised.
 */
export function decideTreeVerdict(
  state: TreeState,
  options: { scriptName: string; override?: boolean },
): TreeVerdict {
  const name = options.scriptName;
  if (options.override) {
    return {
      allow: true,
      message:
        `${name}: ${STALE_TREE_OVERRIDE_ENV} is set — running WITHOUT the origin/main check. `
        + `Whatever this prints or writes carries this tree's code, not main's.`,
    };
  }
  if (state.head === null || state.originMain === null) {
    return {
      allow: true,
      message:
        `${name}: 🔴 CANNOT CHECK THIS TREE against origin/main`
        + `${state.head === null ? " (git did not answer for HEAD)" : " (no origin/main ref here)"}`
        + ` — continuing, but this script recomputes the rule from the code in THIS tree, so confirm `
        + `it holds every merged ruling before quoting what it prints.`,
    };
  }
  if (state.originMainIsAncestor === false) {
    const behind = state.behindCount === null ? "some" : String(state.behindCount);
    return {
      allow: false,
      message:
        `${name}: REFUSING TO RUN — this tree is ${behind} commit(s) BEHIND origin/main `
        + `(HEAD ${state.head}, origin/main ${state.originMain}).\n`
        + `This script recomputes the rule from the code it runs in, so a behind tree produces `
        + `pre-merge numbers and, with --apply, WRITES them to production.\n`
        + `Run it from a tree that holds origin/main: node scripts/new-session.mjs <task>, then `
        + `node --env-file=.env.local … scripts/<this script> from there.\n`
        + `Deliberate pre-merge run? ${STALE_TREE_OVERRIDE_ENV}=1 stands this down for one command.`,
    };
  }
  const ahead = state.head === state.originMain ? "" : " (ahead of it, which is fine)";
  return {
    allow: true,
    message:
      `${name}: tree ${state.head} holds every commit on origin/main ${state.originMain}${ahead}`
      + `${state.fetched ? "" : " — note: the pre-check fetch failed, so that ref may be stale"}.`,
  };
}

/**
 * The call a script makes. Prints the verdict either way — the allowed line is the proof that goes
 * into a report beside the numbers — and exits {@link STALE_TREE_EXIT_CODE} when the tree is behind.
 */
export function assertTreeIsCurrent(scriptName: string): void {
  const verdict = decideTreeVerdict(readTreeState(), {
    override: String(process.env[STALE_TREE_OVERRIDE_ENV] ?? "").trim() !== "",
    scriptName,
  });
  if (!verdict.allow) {
    console.error(verdict.message);
    process.exit(STALE_TREE_EXIT_CODE);
  }
  console.log(verdict.message);
}
