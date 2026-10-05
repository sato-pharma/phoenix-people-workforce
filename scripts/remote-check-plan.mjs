// The bash that scripts/remote-check.mjs sends to the CI box, built as a pure function so a test can
// RUN it (tests/remote-check.test.ts) instead of only reading it.
//
// 🔴 WHY EVERY INVOCATION GETS A TREE OF ITS OWN. Until 2026-10-01 every invocation, from every
// session, ran in ONE shared directory (`~/remote-check/work`): push the sha to the single
// `remote-check` branch, `git checkout -f <sha>` there, run the checks. Several sessions use this
// script at once — it is the sanctioned way to typecheck — so a second invocation checked ITS commit
// out in the middle of the first one's run. Measured on the box's own reflog: 19442c382 checked out
// at 05:59:44 Cairo, 5d2bfaa24 checked out over it at 06:01:25 while the first run was still going.
// The first run then printed `box head: 19442c382` and reported
//   - typecheck FAIL: `TS6053: File '.../tests/fake-supabase-table-sql-nulls.test.ts' not found` —
//     tsc had listed the file from one tree and tried to read it from the other;
//   - unit suite PASS with 2,085 files — the OTHER commit's count; CI ran 2,086 on 19442c382.
// Wrong in both directions, under a header naming the right commit. The typecheck lock did not help:
// it wrapped `tsc` alone, never the checkout.
//
// So now: the sha is pushed to a ref named for THIS run, `git worktree add` makes a directory named
// for this run, every check runs there, and the EXIT trap removes both. Nothing else ever checks
// anything out in that directory. There is also no `|| git checkout FETCH_HEAD` fallback any more —
// that fallback silently ran whatever the shared branch held if the requested sha was missing.
//
// 🔴 AND IT STILL VERIFIES. After the checkout, the install and EVERY check, `same_tree` re-reads HEAD
// and exits 3 if it is not the sha the run announced. A run whose tree moved has no verdict, and must
// never print one: that is the exact failure above, and isolation alone would only make it unlikely.
//
// The cost of a fresh tree is a fresh `pnpm install` (hard links from the box's store) and a cold
// eslint cache. Both are the price of an answer that is about the commit it names.

const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[0-9a-z][0-9a-z-]{7,80}$/;

// A run dir untouched for this long belongs to a run that was killed too hard for its EXIT trap to
// fire (kill -9, a box reboot). No real run comes near it: the typecheck lock waits at most 20 minutes
// and the slowest check is a few minutes.
export const STALE_RUN_MINUTES = 360;

export function newRunId(sha, now = Date.now(), rand = Math.random().toString(36).slice(2, 8)) {
  return sha.slice(0, 12) + "-" + now.toString(36) + "-" + rand.replace(/[^0-9a-z]/g, "").padEnd(4, "0");
}

export function runPaths(remoteRoot, runId) {
  return {
    bare: remoteRoot + "/repo.git",
    runsDir: remoteRoot + "/runs",
    runDir: remoteRoot + "/runs/" + runId,
    ref: "refs/remote-check/" + runId,
    resultRef: "refs/remote-check-result/" + runId,
  };
}

// 🔴 A LOCK CANNOT BIND A BRANCH THAT HAS NEVER HEARD OF IT, SO THE BOX IS ASKED BEFORE ANYTHING
// STARTS. `remote-check` runs the committed sha of whatever branch it is invoked from, so the
// run-level lock in buildRunScript only protects runs launched from a branch that already carries
// it. Measured 2026-10-05, while that very change sat unmerged: two `pnpm run test` runs on the box
// at once, 1313s and 208s, and this session's suite took 1313s against the 463s it takes alone.
//
// Refusing beats waiting. A lock makes the second run sit silently for up to thirty minutes, which
// is indistinguishable from a hang, and it does nothing at all about an older branch. A refusal
// that names what is already running is immediately actionable and works against every branch.
//
// The probe reads /proc rather than a lock file or `pgrep`, because it must see runs that predate
// this code: every version of this script `cd`s into its own run directory, so a process whose CWD
// is under runs/ IS a live run. A stale directory left by `kill -9` has no process and is invisible
// here — which is the point, since STALE_RUN_MINUTES keeps such directories around for six hours.
export function buildBusyProbeScript(remoteRoot) {
  const runs = runPaths(remoteRoot, "x").runsDir;
  return [
    "set -u",
    'for p in /proc/[0-9]*; do',
    '  c=$(readlink "$p/cwd" 2>/dev/null) || continue',
    '  case "$c" in',
    '    ' + runs + '/*)',
    '      r=${c#' + runs + '/}; r=${r%%/*}',
    '      echo "RUN $r $(cat "$p/stat" 2>/dev/null | awk \'{print $22}\')"',
    "      ;;",
    "  esac",
    "done",
    "echo PROBE_OK",
  ].join("\n") + "\n";
}

/**
 * Turn the probe's output into the distinct run ids currently live on the box.
 *
 * 🔴 ABSENT OUTPUT IS NOT AN IDLE BOX. The probe ends with PROBE_OK, and without that marker the
 * answer is "unknown" — an ssh that failed, a box with no /proc, a truncated read. Reporting
 * unknown as idle would turn every probe failure into a green light, which is the one direction
 * this must never fail in.
 */
export function parseBusyProbe(output) {
  const text = typeof output === "string" ? output : "";
  if (!text.split("\n").some((line) => line.trim() === "PROBE_OK")) return { known: false, runs: [] };
  const runs = new Set();
  for (const line of text.split("\n")) {
    const m = /^RUN ([0-9a-z][0-9a-z-]{7,80})(?:\s|$)/.exec(line.trim());
    if (m) runs.add(m[1]);
  }
  return { known: true, runs: [...runs].sort() };
}

function assertInputs(sha, runId) {
  if (!SHA_RE.test(sha)) throw new Error("remote-check: not a full 40-character sha: " + sha);
  if (!RUN_ID_RE.test(runId)) throw new Error("remote-check: unsafe run id: " + runId);
}

// The shared head of both scripts: a private worktree at exactly `sha`, torn down on any exit, and the
// `same_tree` guard. `prelude` is a list of bash lines (PATH and similar) run first.
function privateTree({ remoteRoot, runId, sha, prelude }) {
  assertInputs(sha, runId);
  const p = runPaths(remoteRoot, runId);
  return [
    "set -uo pipefail",
    ...prelude,
    "BARE='" + p.bare + "'",
    "RUNS='" + p.runsDir + "'",
    "RUN='" + p.runDir + "'",
    "REF='" + p.ref + "'",
    "WANT='" + sha + "'",
    'mkdir -p "$RUNS"',
    'find "$RUNS" -mindepth 1 -maxdepth 1 -type d -mmin +' + STALE_RUN_MINUTES + " -exec rm -rf {} + 2>/dev/null",
    'git -C "$BARE" worktree prune 2>/dev/null',
    'cleanup() { cd / || true; git -C "$BARE" worktree remove --force "$RUN" >/dev/null 2>&1 || rm -rf "$RUN"; ' +
      'git -C "$BARE" worktree prune 2>/dev/null; git -C "$BARE" update-ref -d "$REF" 2>/dev/null; return 0; }',
    "trap cleanup EXIT",
    "trap 'exit 130' HUP INT TERM",
    'git -C "$BARE" worktree add -q --detach "$RUN" "$WANT" || { echo "remote-check: could not make a private tree at $WANT" >&2; exit 1; }',
    'cd "$RUN" || exit 1',
    "same_tree() {",
    '  local at; at=$(git -C "$RUN" rev-parse HEAD 2>/dev/null || echo unreadable)',
    '  if [ "$at" != "$WANT" ]; then',
    '    echo "" >&2',
    '    echo "remote-check: TREE CHANGED UNDER THE RUN after $1 — HEAD is $at, the run announced $WANT." >&2',
    '    echo "remote-check: NO VERDICT. Nothing above is about $WANT." >&2',
    "    exit 3",
    "  fi",
    "}",
    'echo "box head: $(git rev-parse --short HEAD)  (private tree runs/' + runId + ')"',
    "same_tree checkout",
  ];
}

// How long a run waits for exclusive use of the box before giving up and running anyway.
export const BOX_LOCK_WAIT_SECONDS = 1800;

// `steps` is [{ name, command }]; `install` is the bash that installs dependencies.
// 🔴 THE LOCK PATH IS AN ARGUMENT, BECAUSE A RUN CAN CONTAIN ANOTHER RUN. The unit suite's own
// section 9 launches two generated scripts at once to prove each sees its own tree — and the suite
// itself runs INSIDE a run that already holds this lock, so with one hard-coded path the inner
// scripts blocked on their own parent and waited out the whole 1800s fall-through, twice. Measured
// 2026-10-05: the `test` stage sat at 31 minutes with `flock -w 1800 9` waiting and fd 9 on
// /tmp/phx-remote-check.lock held by the outer run. The default is what a real run uses; a nested
// or test run passes its own file, which keeps the lock mechanism exercised without self-blocking.
export const BOX_LOCK_FILE = "/tmp/phx-remote-check.lock";

export function buildRunScript({ remoteRoot, runId, sha, steps, install, prelude = [], lockFile = BOX_LOCK_FILE }) {
  if (typeof lockFile !== "string" || !/^[A-Za-z0-9._\/-]+$/.test(lockFile)) {
    throw new Error("unsafe lock file path: " + String(lockFile));
  }
  const lines = privateTree({ remoteRoot, runId, sha, prelude });

  // 🔴 ONE RUN OWNS THE BOX, BECAUSE PER-STAGE LOCKING LEFT TWO STAGES UNGUARDED AND THAT IS WHAT
  // KILLED A BUILD. The box is 7,740 MB and `next build` needs about 7.4 GB of it, so it survives
  // alone and dies beside anything substantial. #5333 put the build behind the typecheck lock,
  // which serialises it against a typecheck and against ci.yml's Typecheck step — but NOT against
  // another session's `lint` or `test`, which take no lock at all. Measured 2026-10-05: a build on
  // an otherwise-identical tree was OOM-killed at "Collecting page data using 3 workers" while two
  // other node processes on the box held ~4.7 GB, and a second remote-check (a 5.5 GB
  // `tsc --noEmit`) was running there minutes later. Four earlier runs on an idle box all passed.
  //
  // So the unit of exclusion is the RUN, not the stage. The lock file differs from the per-stage
  // one on purpose: flock(2) locks an open file DESCRIPTION, so taking /tmp/phx-typecheck.lock
  // here and again inside the typecheck would deadlock this run against itself.
  //
  // It never fails the run. If the wait elapses it says so and proceeds, exactly as ci.yml's
  // Typecheck step does — a lock that can turn a check red teaches people to skip the check.
  lines.push("exec 9>>" + lockFile);
  lines.push(
    "flock -w " + BOX_LOCK_WAIT_SECONDS + " 9 || " +
      'echo "remote-check: waited ' + BOX_LOCK_WAIT_SECONDS / 60 +
      ' minutes for the box lock — running anyway, so a slow stage here may be contention" >&2',
  );

  lines.push("FAILED=0");
  lines.push("KILLED=0");
  lines.push(install + " || { echo 'install failed'; exit 1; }");
  lines.push("same_tree install");
  for (const { name, command } of steps) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("remote-check: unsafe check name: " + name);
    // 🔴 EXIT 137 IS THE KERNEL OOM KILLER AND SAYS NOTHING ABOUT THE CODE — it must not read as
    // FAIL. A build prints `✓ Compiled successfully` and is killed after, so reporting that as a
    // failure sends a session hunting an error that does not exist, and makes the standing
    // pre-push step cry wolf — which is how a gate stops being read at all.
    lines.push(
      'echo ""; echo "=== ' + name + ' ==="; S=$(date +%s); ' +
        "if " + command + "; then R=PASS; else RC=$?; " +
        'if [ "$RC" = 137 ]; then R=OOM-KILLED; KILLED=1; else R=FAIL; FAILED=1; fi; fi; ' +
        'E=$(date +%s); same_tree ' + name + '; echo "--- ' + name + ' $R in $((E-S))s ---"',
    );
  }
  // A real failure outranks a kill. Otherwise a kill is NO VERDICT (4), never PASS: nothing was
  // learned about this sha, and the caller must not read silence as a green light.
  lines.push('if [ "$FAILED" = 0 ] && [ "$KILLED" = 1 ]; then exit 4; fi');
  lines.push("exit $FAILED");
  return lines.join("\n") + "\n";
}

// The lockfile mode: regenerate, commit inside the private tree, and hand the commit back on a ref
// named for this run (`resultRef`), which the laptop fetches and then deletes.
export function buildLockfileScript({ remoteRoot, runId, sha, prelude = [] }) {
  const p = runPaths(remoteRoot, runId);
  const lines = privateTree({ remoteRoot, runId, sha, prelude });
  lines.push(
    // NOT --frozen-lockfile: that is the one flag guaranteed to fail here, because the whole point is
    // that the lockfile does not yet match the manifests.
    "corepack pnpm install --lockfile-only || { echo 'LOCKFILE_FAILED'; exit 1; }",
    "same_tree 'pnpm install --lockfile-only'",
    "if git diff --quiet -- pnpm-lock.yaml pnpm-workspace.yaml; then echo NOCHANGE; exit 0; fi",
    // pnpm can touch pnpm-workspace.yaml too: adopting a version younger than pnpm 11's release-age
    // quarantine makes it append `minimumReleaseAgeExclude` entries, and a --frozen-lockfile install
    // needs them. Returning only the lockfile would lose them with nothing to show it.
    'git -c user.email=box@phoenix.local -c user.name="remote-check" commit -q ' +
      '-m "chore(deps): regenerate the lockfile on the box" -- pnpm-lock.yaml pnpm-workspace.yaml || exit 1',
    // The commit moved HEAD on purpose, so the guard here is that its PARENT is still the sha.
    '[ "$(git rev-parse HEAD^)" = "$WANT" ] || { echo "remote-check: TREE CHANGED UNDER THE RUN — NO VERDICT" >&2; exit 3; }',
    'git -C "$BARE" update-ref \'' + p.resultRef + "' HEAD",
    "echo REGENERATED",
  );
  return lines.join("\n") + "\n";
}
