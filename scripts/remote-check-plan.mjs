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
// The cost of a fresh tree is a fresh `pnpm install` (hard links from the box's store). The eslint
// cache no longer has to be cold: `lintCacheFunction` below carries it between trees (2026-10-08).

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
//
// 🔴 phx-live's DEV SERVER COUNTS AS A RUN. The owner's live dev server (`phx-live`, scope
// `phx-preview-3100.scope`, capped at 5.5 GB) shares this 7,740 MB box, and a `next build` wants
// ~7.4 GB — starting one beside it OOM-kills one of the two. So while that scope is active the probe
// reports it as the run `phx-live-dev-server`, and every busy route (read the PR's run, or NO VERDICT)
// applies exactly as it does to another session's check. Account: docs/agents-worktree-and-machine-limits.md, "phx-live".
export const PHX_LIVE_RUN_ID = "phx-live-dev-server";
export const PHX_LIVE_SCOPE = "phx-preview-3100.scope";

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
    "if systemctl is-active --quiet " + PHX_LIVE_SCOPE + " 2>/dev/null; then echo \"RUN " + PHX_LIVE_RUN_ID + " 0\"; fi",
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

// ---------------------------------------------------------------------------------------------
// WHAT THE BOX SCRIPT'S EXIT CODE MEANS
// ---------------------------------------------------------------------------------------------
// 🔴 ONLY 0 AND 1 ARE VERDICTS. Everything else is "could not tell", and the difference is not
// cosmetic: a FAIL blocks a push (`.claude/hooks/push-typecheck-guard.mjs`) and is reported to the
// owner as "your code is broken". Three non-code failures used to arrive as exit 1 and print the
// `FAIL — <sha>` line — an install that could not run, a run killed by a signal, and a stage that
// gave up waiting for the box's typecheck lock. None of them looked at the branch at all. They now
// have codes of their own, which remote-check.mjs turns into NO VERDICT lines that carry no
// `PASS|FAIL — <sha>` for anything to parse (`a-verdict-line-without-its-sha-matches-an-older-run`).
export const EXIT_TREE_MOVED = 3; // same_tree fired — the tree stopped being the announced sha
export const EXIT_OOM_KILLED = 4; // a stage took SIGKILL from the kernel OOM killer (137)
export const EXIT_SETUP = 7; // the private tree or the install could not be made — nothing ran
export const EXIT_INTERRUPTED = 8; // the run took HUP/INT/TERM — a reap, a reboot, a hand kill
export const EXIT_LOCK_TIMEOUT = 9; // a stage waited out the box's typecheck lock and never started

// 🔴 `flock`'s OWN TIMEOUT MUST NOT LOOK LIKE A FAILING CHECK. A `flock -w` that expires exits 1 —
// the same code `tsc` uses for type errors — so a box so contended that the typecheck never started
// reported the branch as broken. This is the conflict code (EX_TEMPFAIL) the lock PROBE in
// buildRunScript carries via `-E`, and the one the step wrapper reads as LOCK-TIMEOUT. 75 is not a
// code `tsc`, `eslint`, `next build` or the test runner produces.
export const LOCK_CONFLICT_EXIT = 75;

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
    // 🔴 A SIGNAL IS NOT A VERDICT ABOUT THE CODE. This used to `exit 130`, which fell through
    // remote-check.mjs's NO-VERDICT arms and printed the `FAIL — <sha>` line: a run reaped by the
    // box's own memory watchdog, a reboot, or a `kill` aimed at a stranded run then blocked a push
    // and told the session its branch was broken. Same cry-wolf shape as the OOM kill (exit 137).
    "trap 'echo \"remote-check: the run on the box was INTERRUPTED by a signal — NO VERDICT\" >&2; exit " +
      EXIT_INTERRUPTED + "' HUP INT TERM",
    // 🔴 SETUP IS NOT THE BRANCH EITHER. A `worktree add` that cannot run, or a `cd` that fails,
    // says something about the box's disk or git, never about $WANT — so it exits SETUP, not 1.
    'git -C "$BARE" worktree add -q --detach "$RUN" "$WANT" || { echo "remote-check: could not make a private tree at $WANT" >&2; exit ' +
      EXIT_SETUP + "; }",
    'cd "$RUN" || exit ' + EXIT_SETUP,
    "same_tree() {",
    '  local at; at=$(git -C "$RUN" rev-parse HEAD 2>/dev/null || echo unreadable)',
    '  if [ "$at" != "$WANT" ]; then',
    '    echo "" >&2',
    '    echo "remote-check: TREE CHANGED UNDER THE RUN after $1 — HEAD is $at, the run announced $WANT." >&2',
    '    echo "remote-check: NO VERDICT. Nothing above is about $WANT." >&2',
    "    exit " + EXIT_TREE_MOVED,
    "  fi",
    "}",
    'echo "box head: $(git rev-parse --short HEAD)  (private tree runs/' + runId + ')"',
    "same_tree checkout",
  ];
}

// How long a run waits for exclusive use of the box before giving up — with NO VERDICT, never by
// running anyway (owner, 2026-10-08, FUP-010: *"a heavy workload must NEVER proceed without
// successfully acquiring its required exclusive lock"*). It is short on purpose: the busy probe in
// remote-check.mjs has already refused a box with a live run, so this only has to cover the race
// between that probe and this lock. A longer wait would be a hidden queue, which is what the
// 2026-10-08 performance recovery removed.
export const BOX_LOCK_WAIT_SECONDS = 120;

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
  // 🔴 AND A RUN THAT CANNOT TAKE THE LOCK DOES NOT RUN (owner, 2026-10-08, FUP-010). Until then an
  // expired wait printed "running anyway" and started every stage beside whatever held the box — the
  // exact overlap this lock exists to prevent, and the shape that OOM-kills a build. Now it exits
  // EXIT_LOCK_TIMEOUT before the install: no stage ran, so it is NO VERDICT (never PASS, never FAIL),
  // and remote-check.mjs points the caller at the PR's own CI, which is the authoritative gate anyway.
  lines.push("exec 9>>" + lockFile);
  lines.push(
    "flock -w " + BOX_LOCK_WAIT_SECONDS + " 9 || { " +
      'echo "remote-check: could not take the box lock within ' + BOX_LOCK_WAIT_SECONDS +
      's — another run holds the box, so NOTHING was run here (no verdict)" >&2; exit ' + EXIT_LOCK_TIMEOUT + "; }",
  );

  lines.push("FAILED=0");
  lines.push("KILLED=0");
  lines.push("LOCKED=0");
  // 🔴 AN INSTALL THAT FAILED CHECKED NOTHING, SO IT IS NOT A FAIL. It exited 1 until 2026-10-06,
  // which printed `FAIL — <sha>` for a box that ran out of disk, lost its pnpm store or could not
  // reach the registry — a push blocked, and a session sent looking for a type error in a branch
  // nothing had read. (A lockfile that genuinely does not match the manifests fails the PR's own
  // `validate` install too, so nothing is lost by refusing to call this a verdict.)
  lines.push(install + " || { echo 'install failed — the box never checked this sha'; exit " + EXIT_SETUP + "; }");
  lines.push("same_tree install");
  for (const { name, command } of steps) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("remote-check: unsafe check name: " + name);

    // 🔴 A STAGE THAT GIVES UP WAITING FOR A LOCK LOOKS EXACTLY LIKE A FAILING CHECK. `typecheck`
    // and `build` both start by waiting for /tmp/phx-typecheck.lock, which ci.yml's own Typecheck
    // step takes too — and `flock -w` that expires exits **1**, the same code `tsc` uses for type
    // errors. So on a box held for twenty minutes the stage NEVER RAN and the run printed
    // `FAIL — <sha>`, blocking a push over somebody else's typecheck.
    //
    // The conflict is therefore established BEFORE the stage, with a probe that has a conflict code
    // of its own (`-E`). It cannot misread a real failure, because it runs before any of the code
    // does. The lock is not left held: the probe is `true`, so it releases at once and the stage's
    // own `flock` takes it microseconds later. The command is NOT rewritten to carry `-E` itself —
    // tests/ci-typecheck-lock.test.ts pins its `flock -w <seconds> <file>` prefix so this caller and
    // ci.yml cannot drift onto different lock files.
    const waits = /^flock -w (\d+) (\/[^\s;|&$'"]+) /.exec(command);
    if (waits) {
      lines.push(
        "STAGE_LOCK=0; flock -w " + waits[1] + " -E " + LOCK_CONFLICT_EXIT + " " + waits[2] + " true || STAGE_LOCK=$?",
      );
    }
    // 🔴 EXIT 137 IS THE KERNEL OOM KILLER AND SAYS NOTHING ABOUT THE CODE — it must not read as
    // FAIL. A build prints `✓ Compiled successfully` and is killed after, so reporting that as a
    // failure sends a session hunting an error that does not exist, and makes the standing
    // pre-push step cry wolf — which is how a gate stops being read at all.
    //
    // 🔴 AND NEITHER IS `flock`'s CONFLICT CODE (LOCK_CONFLICT_EXIT). A stage that waited out
    // /tmp/phx-typecheck.lock never ran its command, so there is nothing to grade: that is the box
    // being busy, which is the one thing this script already refuses to call a branch failure.
    lines.push(
      'echo ""; echo "=== ' + name + ' ==="; S=$(date +%s); ' +
        (waits ? 'if [ "$STAGE_LOCK" = ' + LOCK_CONFLICT_EXIT + " ]; then R=LOCK-TIMEOUT; LOCKED=1; elif " : "if ") +
        command + "; then R=PASS; else RC=$?; " +
        'if [ "$RC" = 137 ]; then R=OOM-KILLED; KILLED=1; ' +
        'elif [ "$RC" = ' + LOCK_CONFLICT_EXIT + ' ]; then R=LOCK-TIMEOUT; LOCKED=1; ' +
        "else R=FAIL; FAILED=1; fi; fi; " +
        'E=$(date +%s); same_tree ' + name + '; echo "--- ' + name + ' $R in $((E-S))s ---"',
    );
  }
  // A real failure outranks both. Otherwise a kill or a lock timeout is NO VERDICT, never PASS:
  // nothing was learned about this sha, and the caller must not read silence as a green light.
  lines.push('if [ "$FAILED" = 0 ] && [ "$KILLED" = 1 ]; then exit ' + EXIT_OOM_KILLED + "; fi");
  lines.push('if [ "$FAILED" = 0 ] && [ "$LOCKED" = 1 ]; then exit ' + EXIT_LOCK_TIMEOUT + "; fi");
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

// ---------------------------------------------------------------------------------------------
// THE PERSISTENT ESLINT CACHE (2026-10-08 performance recovery, P0-2)
// ---------------------------------------------------------------------------------------------
// 🔴 WHY LINT TOOK 182s HERE AND 4-9s ON GITHUB. Every run lints in a FRESH private tree (see the
// header), and eslint's `.eslintcache` lives inside that tree, so the EXIT trap deleted it every time.
// Worse, a cache COPIED into the next tree would still miss: file-entry-cache keys every entry by the
// file's ABSOLUTE path and drops entries whose path does not exist, and each run's path is new
// (`runs/<runId>`). Measured on the box: lint PASS 8-9s on 30 Sep-1 Oct, 177-195s every day after
// #5062 gave each run its own tree.
//
// So the cache is stored OUTSIDE the tree with the run's own path replaced by a placeholder, and put
// back with this run's path before eslint starts. Correctness does not depend on the rewrite at all:
//   - `--cache-strategy content` (package.json's `lint` script) re-hashes every file's CONTENT, so an
//     edited file is re-linted whatever the cache says, and a deleted file is dropped by eslint itself;
//   - eslint stores a hash of the resolved config (and its own and node's version) per entry, so a
//     config change re-lints everything;
//   - the store's KEY hashes the lockfile, the manifests, the eslint config and tsconfig, so a
//     dependency or plugin change starts from an EMPTY cache rather than trusting entries made by
//     other plugin versions;
//   - a missing, unreadable or corrupt store means a cold run — never a skipped file.
// Two runs saving at once is last-wins through an atomic `mv`; either file is a valid cache for its
// key. The store is app data in remote-check's own folder, not a box setting, and stores untouched
// for LINT_CACHE_KEEP_DAYS are pruned.
export const LINT_CACHE_VERSION = 1;
export const LINT_CACHE_KEEP_DAYS = 14;
export const LINT_RUN_PLACEHOLDER = "@@PHX_RUN_TREE@@";
export const LINT_CACHE_FUNCTION_NAME = "phx_lint_cached";

/**
 * The bash function that runs `corepack pnpm run lint` with the persistent cache around it. It
 * returns eslint's own exit code, untouched — the cache can only ever change how long lint takes.
 *
 * @param {{ remoteRoot: string, runDir: string }} input the run's own tree, from `runPaths`.
 */
export function lintCacheFunction({ remoteRoot, runDir }) {
  for (const value of [remoteRoot, runDir]) {
    if (typeof value !== "string" || !/^\/[A-Za-z0-9._\/-]+$/.test(value)) {
      throw new Error("remote-check: unsafe lint cache path: " + String(value));
    }
  }
  const store = remoteRoot + "/eslint-cache";
  // A regex for the run's path: the validated alphabet above leaves `.` as the only metacharacter.
  const runRe = runDir.replace(/\./g, "\\.");
  return [
    LINT_CACHE_FUNCTION_NAME + "() {",
    "  local dir='" + store + "' key='' store='' tmp='' rc=0",
    "  key=$( { echo v" + LINT_CACHE_VERSION + "; node --version 2>/dev/null; " +
      "sha256sum pnpm-lock.yaml pnpm-workspace.yaml package.json eslint.config.mjs tsconfig.json 2>/dev/null; } " +
      "| sha256sum | cut -c1-16 )",
    '  rm -f .eslintcache',
    '  if [ -n "$key" ] && mkdir -p "$dir" 2>/dev/null; then store="$dir/$key.json"; fi',
    '  if [ -n "$store" ] && [ -s "$store" ]; then',
    "    sed 's|" + LINT_RUN_PLACEHOLDER + "|" + runDir + "|g' \"$store\" > .eslintcache 2>/dev/null || rm -f .eslintcache",
    '    echo "lint cache: warm ($key)"',
    "  else",
    '    echo "lint cache: cold${key:+ ($key)}"',
    "  fi",
    "  corepack pnpm run lint",
    "  rc=$?",
    '  if [ -n "$store" ] && [ -s .eslintcache ]; then',
    '    tmp="$store.$$.tmp"',
    "    if sed 's|" + runRe + "|" + LINT_RUN_PLACEHOLDER + "|g' .eslintcache > \"$tmp\" 2>/dev/null; then " +
      'mv -f "$tmp" "$store"; else rm -f "$tmp"; fi',
    "  fi",
    '  find "$dir" -maxdepth 1 -type f -mtime +' + LINT_CACHE_KEEP_DAYS + " -delete 2>/dev/null",
    "  return $rc",
    "}",
  ];
}

// ---------------------------------------------------------------------------------------------
// THE RUN'S OWN CEILING (2026-10-08 performance recovery, P0-3)
// ---------------------------------------------------------------------------------------------
// 🔴 A RUN THAT HANGS MUST END, AND END AS NO VERDICT. The box script runs under coreutils
// `timeout`, so the BOX itself signals the run's whole process group when the ceiling passes: the
// run's TERM trap fires (exit EXIT_INTERRUPTED), its EXIT trap removes the private tree, and
// `timeout` reports 124 — which remote-check.mjs reads as NO VERDICT, never PASS and never FAIL.
// `--kill-after` follows with SIGKILL for anything that ignores TERM; a tree that survives that is
// what STALE_RUN_MINUTES sweeps.
//
// It is a CEILING, not a wait: a healthy run ends in its own time (measured 2026-10-07/08: typecheck
// ~33s, the suite 113-205s, the build ~120s, setup ~60s). Each budget is roughly 3x the slowest
// healthy run seen, so only a genuinely stuck run ever meets it.
export const RUN_BASE_CEILING_SECONDS = 300; // private tree + install + the box lock (120s)
export const STAGE_CEILING_SECONDS = { lint: 240, typecheck: 300, test: 720, build: 480 };
export const EXIT_CEILING = 124; // coreutils `timeout`'s own code for "the ceiling passed"
export const CEILING_KILL_AFTER_SECONDS = 30;

/** The whole run's ceiling in seconds, for the stages asked for. An unknown stage gets the largest budget. */
export function runCeilingSeconds(names) {
  const largest = Math.max(...Object.values(STAGE_CEILING_SECONDS));
  return (Array.isArray(names) ? names : []).reduce(
    (total, name) => total + (STAGE_CEILING_SECONDS[name] ?? largest),
    RUN_BASE_CEILING_SECONDS,
  );
}

/** The remote command the run script is fed to — bash under the box's own `timeout`. */
export function ceilingCommand(names) {
  return "timeout --kill-after=" + CEILING_KILL_AFTER_SECONDS + " " + runCeilingSeconds(names) + " bash -s";
}

// ---------------------------------------------------------------------------------------------
// THE VERDICT RECORD — what a finished run proved, per commit and per stage
// ---------------------------------------------------------------------------------------------
// 🔴 ONE AUTHORITATIVE RESULT PER SHA, READ BY THE PUSH GUARD INSTEAD OF A SECOND RUN (owner,
// 2026-10-08: *"the push guard must not start a remote check that blocks a normal push. Previously
// completed verification for the exact commit SHA may be reused"*). remote-check writes
// `<git-common-dir>/phx-remote-check/<sha>.json` — shared by every worktree, never tracked — and
// `.claude/hooks/push-typecheck-guard.mjs` only reads it. Only a run that ENDED IN A VERDICT (exit 0
// or 1) is recorded, and only the stages that printed PASS or FAIL: a lock timeout, an OOM kill, a
// moved tree, a dropped ssh, a ceiling or an unknown code records nothing, so silence is never
// stored as a pass. The PR's `validate` + `checks` remain the merge gate whatever this file says.
export const VERDICT_DIR_NAME = "phx-remote-check";
export const VERDICT_KEEP_DAYS = 14;

const STAGE_LINE_RE = /^--- ([a-z][a-z0-9-]*) (PASS|FAIL|OOM-KILLED|LOCK-TIMEOUT) in (\d+)s ---$/;

/**
 * The per-stage verdicts a box run printed: `{ lint: "PASS", typecheck: "FAIL" }`. OOM-KILLED and
 * LOCK-TIMEOUT stages are left out — neither ran to a verdict.
 */
export function stageVerdictsFromOutput(text) {
  const out = {};
  for (const raw of String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
    const m = STAGE_LINE_RE.exec(raw.trim());
    if (m && (m[2] === "PASS" || m[2] === "FAIL")) out[m[1]] = m[2];
  }
  return out;
}

/**
 * The closing line of a run that STOPPED on an error once the commit was known — a failed push to the
 * box, an ssh error, a refused or failed dispatch. 🔴 Until 2026-10-08 those exits (`die()`, exit 2)
 * printed only the error, so a session reading the output for a `PASS|FAIL|NO VERDICT — <sha9>` line
 * found NONE and could not tell which commit, if any, the answer was about. Every terminal path now
 * ends in exactly one such line.
 */
export function stoppedNoVerdictLine(sha) {
  return "remote-check: NO VERDICT — stopped on the error above, so nothing here is a verdict on " + String(sha).slice(0, 9);
}

/** The lines tsc printed between the typecheck banners — what the push guard shows on a recorded FAIL. */
export function typecheckExcerpt(text) {
  const lines = String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^=== typecheck ===/.test(line));
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && /^--- typecheck (?:PASS|FAIL) in /.test(line));
  return lines.slice(start + 1, end >= 0 ? end : undefined).filter((l) => l.trim()).slice(-60).join("\n");
}

/**
 * Merge one finished run's stage verdicts into the record for its sha. Pure: the caller does the IO.
 * A later verdict for the same stage replaces an earlier one (a re-run is newer evidence).
 *
 * @param {any} previous the parsed record already on disk, or null.
 * @param {{ sha: string, stages: Record<string, "PASS"|"FAIL">, source: string, at: string, excerpt?: string }} run
 */
export function mergeVerdictRecord(previous, { sha, stages, source, at, excerpt }) {
  if (!SHA_RE.test(String(sha))) throw new Error("remote-check: not a full 40-character sha: " + sha);
  const base = previous && previous.sha === sha && previous.stages && typeof previous.stages === "object"
    ? previous
    : { sha, stages: {} };
  const next = { sha, stages: { ...base.stages } };
  for (const [name, verdict] of Object.entries(stages ?? {})) {
    if (verdict !== "PASS" && verdict !== "FAIL") continue;
    next.stages[name] = { verdict, at, source, ...(name === "typecheck" && verdict === "FAIL" && excerpt ? { excerpt } : {}) };
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// WHEN THE BOX IS BUSY: WAIT, OR PAY FOR GITHUB ACTIONS
// ---------------------------------------------------------------------------------------------
// 🔴 THE OWNER'S POLICY, 2026-10-06: THE BOX BY DEFAULT BECAUSE IT IS FREE, GITHUB ACTIONS WHEN THE
// WORK CANNOT WAIT. The refusal above this (`not starting a second one`) is right about the box and
// wrong about the session: it ends the run with no route forward, so a session invents its own retry
// loop and the work stalls behind another session's check. Measured 2026-10-06: five consecutive
// refusals over six minutes while one `all` run held the box, with a finished branch waiting to open
// its PR. Nothing was wrong with the branch and nothing was wrong with the box — the work was simply
// parked behind a 7.4 GB build on a 7,740 MB machine.
//
// So the decision is made HERE, as data, with three outcomes and no hidden fourth:
//   run      — the box is free; nothing changes, and this is still the default path.
//   poll     — the caller asked to wait (`--wait <minutes>`): sleep, print a line, ask again.
//   actions  — the wait is spent (or none was asked for) and `--actions` is armed: dispatch ci.yml.
//   refuse   — the wait is spent and nothing else is armed: exit 2 exactly as before.
//
// 🔴 AN UNREACHABLE BOX IS THE SAME DECISION — owner ruling, 2026-10-08: *"make an unreachable box
// escalate to Actions too, not only a busy one"*. `probeKnown: false` (ssh failed, or the box answered
// without `PROBE_OK`) therefore takes the busy routes and never `run`: with the fallback armed it
// dispatches, with a budget it polls — a dropped connection is often a blip and a poll costs nothing —
// and with `--no-actions` it still refuses, exactly as before.
//
// 🔴 THAT DOES NOT WEAKEN THE FAIL-CLOSED PROBE, AND A FUTURE READER MUST NOT "RESTORE" IT. The probe
// fails closed so an unreadable answer is never mistaken for an IDLE BOX — the thing it forbids is
// STARTING A RUN THERE, which is what OOM-kills somebody else's build. `run` stays unreachable from
// `probeKnown: false`, so that invariant is intact; what changes is only that the caller is handed the
// route that does not touch the box at all, instead of nothing. Before this, an ssh blip or a box that
// was down ended the invocation at exit 2 with no verdict, on the one evidence that most argues FOR
// GitHub Actions: the box cannot answer at all.
//
// 🔴 WAITING IS VISIBLE OR IT IS A HANG. The comment on the refusal says a lock "makes the second run
// sit silently for up to half an hour, which reads as a hang", and that is the real objection to
// queueing — not the waiting itself. Every poll therefore prints the runs it is waiting for and how
// much of the budget is left, so a quiet terminal always means something is wrong.

/** How long between asking the box again whether it is free. */
export const BUSY_POLL_SECONDS = 30;

/**
 * 🔴 `--urgent` ESCALATES AT ONCE — owner ruling, 2026-10-06: *"make --urgent escalate immediately
 * instead of after 4 minutes"*. Since 2026-10-08 that is also what a BARE invocation does, so the flag
 * is kept as a documented alias of the default rather than a tier of its own: every caller that already
 * passes it keeps working, and it is still the way to say "immediately" when the house knob below has
 * been set to a wait. An explicit `--wait <minutes>` still WINS over this zero, so `--wait 6 --urgent`
 * waits six minutes and then escalates: the caller's own budget is never shortened.
 */
export const URGENT_WAIT_MINUTES = 0;

/**
 * 🔴 THE BOX WHEN IT IS FREE, GITHUB ACTIONS THE MOMENT IT IS BUSY — owner ruling, 2026-10-08: *"i
 * want to make the run depend on github actions if the self hosted box is busy .. if free use it
 * directly but if busy use github actions"*. So the default wait is ZERO: the probe asks the box, and a
 * busy answer dispatches `ci.yml` immediately instead of polling first.
 *
 * 🔴 THIS REPLACES THE TEN-MINUTE WAIT OF 2026-10-06, WHICH WAS THE SAME POLICY WITH A QUEUE IN FRONT
 * OF IT. That wait was the cheap half of the trade — the box bills nothing — and it bought ten minutes
 * of a session doing nothing on the evidence of the same evening, when the box was three sessions deep
 * for over 25 minutes and the wait expired into a refusal anyway. What it costs now, said out loud: a
 * dispatch is ~14 billable Actions minutes, so a busy box is paid for rather than waited out.
 * `PHX_CHECK_WAIT_MINUTES` below is the knob that buys the waiting back without a code change.
 */
export const DEFAULT_WAIT_MINUTES = 0;

/**
 * 🔴 THE WAIT SURVIVES WHERE IT IS THE ONLY ROUTE TO A VERDICT — `--no-actions` (alias `--free`) says
 * "never bill", so with the escalation disarmed a zero wait would leave the caller nothing at all. That
 * flag therefore keeps the ten-minute poll it has always had, and `--no-wait --no-actions` stays the
 * instant refusal `.claude/hooks/push-typecheck-guard.mjs` asks for on EVERY push.
 */
export const FREE_WAIT_MINUTES = 10;

/**
 * 🔴 THE HOUSE DEFAULT IS AN ENVIRONMENT KNOB, NOT A CODE EDIT — `PHX_CHECK_WAIT_MINUTES=10` restores
 * the pre-2026-10-08 wait-then-escalate for a session, a shell or this whole machine without touching
 * `DEFAULT_WAIT_MINUTES`, and `=0` takes the wait off the `--free` path too. An explicit `--wait`,
 * `--no-wait` or `--urgent` always wins over it, which is what keeps the push guard instant and free.
 *
 * An unreadable value is pushed onto `unknown` rather than ignored: an ignored setting runs the OTHER
 * policy and reports success, which is the same defect this file refuses by name for flags.
 */
export const WAIT_MINUTES_ENV = "PHX_CHECK_WAIT_MINUTES";

/**
 * Flags are parsed, never filtered away.
 *
 * 🔴 THIS FILE USED TO IGNORE EVERY `-` ARGUMENT SILENTLY (`argv.filter((a) => !a.startsWith("-"))`),
 * which is the same defect `scripts/rollup-prs.mjs` refuses by name: a misspelled flag runs the OLD
 * behaviour and reports success, so the caller believes it got something it never asked for. An
 * unknown flag is returned to the caller, which dies on it.
 *
 * @param {string[]} argv the arguments after the script name.
 * It also returns the POSITIONAL arguments, because a flag's VALUE is positional and the check-name
 * parser must never see it: `--wait 3` would otherwise leave a bare `3` behind, which reads as a
 * check called "3" and dies with a message about check names.
 * @param {Record<string, string | undefined>} env the environment, so `PHX_CHECK_WAIT_MINUTES` is
 * testable without mutating `process.env` — this stays a pure function of its two arguments.
 *
 * @returns {{ positional: string[], waitMinutes: number, actions: boolean, dispatch: boolean, unknown: string[], urgent: boolean }}
 *   `actions` — a blocked box may go to GitHub at all (read the open PR's run); `dispatch` — it may also
 *   START a billed ci.yml run when no PR exists, which only `--actions`/`--urgent` arm.
 */
export function parseEscalation(argv, env = process.env) {
  // null means "the caller did not say", which is what the defaults below fill in. A plain `0`/`false`
  // could not be told apart from an explicit `--no-wait`/`--no-actions`, and the whole point of those
  // two flags is that they are louder than the default.
  let waitMinutes = null;
  let actions = null;
  let urgent = false;
  const unknown = [];
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--actions" || arg === "--else-actions") {
      actions = true;
      continue;
    }
    if (arg === "--no-actions" || arg === "--free") {
      actions = false;
      continue;
    }
    if (arg === "--no-wait") {
      waitMinutes = 0;
      continue;
    }
    if (arg === "--urgent") {
      urgent = true;
      actions = true;
      // `--urgent` escalates IMMEDIATELY (URGENT_WAIT_MINUTES is 0), so it sets that zero only when the
      // caller named no budget of their own: `Math.max` then keeps an explicit `--wait 6` in EITHER
      // order, because this zero must never SHORTEN a wait somebody asked for.
      waitMinutes = waitMinutes === null ? URGENT_WAIT_MINUTES : Math.max(waitMinutes, URGENT_WAIT_MINUTES);
      continue;
    }
    const inline = /^--wait=(.*)$/.exec(arg);
    const value = inline ? inline[1] : argv[i + 1];
    if (arg === "--wait" || inline) {
      const minutes = Number(value);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 60) {
        unknown.push(arg + " " + String(value) + " (minutes, 0-60)");
        continue;
      }
      waitMinutes = minutes;
      if (!inline) i += 1;
      continue;
    }
    unknown.push(arg);
  }
  const armed = actions === null ? true : actions;
  // 🔴 AND ONLY AN EXPLICIT `--actions`/`--urgent` MAY BILL A DISPATCH (owner, 2026-10-08 performance
  // recovery: *"do not dispatch paid Actions runs when the PR's own CI gives the same verdict"*). The
  // default still escalates a busy or unreachable box to GitHub — but to READ the branch's open PR run,
  // which is already billed; with no PR it stops at NO VERDICT and says to open one. That replaces the
  // same morning's dispatch-at-once default, which billed ~14 minutes for an answer the PR was about to
  // produce on the same commit.
  const dispatch = actions === true;
  // 🔴 THE DEFAULT DEPENDS ON WHETHER THE ESCALATION IS ARMED, WHICH IS THE WHOLE 2026-10-08 RULING:
  // with Actions available a busy box is PAID FOR AT ONCE (zero), and with `--no-actions` the poll is
  // the only route to a verdict, so it keeps the ten minutes. One shared default could only be wrong
  // for one of the two — a zero would make `--free` an instant refusal, and a ten would reinstate the
  // queue the owner just removed.
  let fallback = armed ? DEFAULT_WAIT_MINUTES : FREE_WAIT_MINUTES;
  const house = env ? env[WAIT_MINUTES_ENV] : undefined;
  if (house !== undefined && String(house).trim() !== "") {
    const minutes = Number(house);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 60) {
      unknown.push(WAIT_MINUTES_ENV + "=" + String(house) + " (minutes, 0-60)");
    } else {
      fallback = minutes;
    }
  }
  return {
    positional,
    waitMinutes: waitMinutes === null ? fallback : waitMinutes,
    actions: armed,
    dispatch,
    unknown,
    urgent,
  };
}

/**
 * What to do about a box that cannot take this run, as a pure decision.
 *
 * 🔴 `probeKnown: false` MEANS THE BOX DID NOT ANSWER — and it takes the same routes as a busy one
 * (owner, 2026-10-08), never `run`. It DEFAULTS TO TRUE deliberately: every caller that predates the
 * ruling keeps its old meaning, and a caller that forgets to pass it gets the busy logic rather than a
 * silent escalation. The one place that must pass it is the probe's own call site.
 *
 * @param {{ busyRuns: string[], waitedSeconds: number, waitMinutes: number, actions: boolean,
 *           probeKnown?: boolean }} input
 * @returns {{ action: "run"|"poll"|"actions"|"refuse", waitLeftSeconds: number, reason: "free"|"busy"|"unreachable" }}
 */
export function decideBusyAction({ busyRuns, waitedSeconds, waitMinutes, actions, probeKnown = true }) {
  const blocked = probeKnown === false || (busyRuns && busyRuns.length > 0);
  const reason = probeKnown === false ? "unreachable" : blocked ? "busy" : "free";
  if (!blocked) return { action: "run", waitLeftSeconds: 0, reason };
  const budget = Math.round((waitMinutes || 0) * 60);
  const left = budget - (waitedSeconds || 0);
  if (left > 0) return { action: "poll", waitLeftSeconds: left, reason };
  return { action: actions ? "actions" : "refuse", waitLeftSeconds: 0, reason };
}

/**
 * 🔴 THE ESCALATION MUST NEVER DISPATCH ON `main` — THAT RUN IS THE PRODUCTION DEPLOY GATE.
 *
 * `ci.yml`'s concurrency group is `CI-<ref>` for a pull request and **`CI-<sha>`** for everything
 * else, with `cancel-in-progress` true only for a PR. So a `workflow_dispatch` on `main` lands in
 * the SAME group as the push run of that exact commit — the run Railway's "Wait for CI" is holding
 * the production deploy on (AGENTS.md §2.3). Two runs in one non-cancelling group is at best a
 * second billed copy of a run that already exists, and at worst it is a session's convenience check
 * tangled up with the only suite that decides whether a merge ships: a cancelled or failed run on
 * that commit makes Railway mark the deploy SKIPPED within minutes, and re-running it green does
 * not resurrect it.
 *
 * There is also nothing to gain. `main` already runs the whole gate on every commit, for free to
 * this caller — so the answer on `main` is to read that run, never to start another beside it.
 *
 * @param {string} branch the ref `gh workflow run --ref` would be given.
 */
export function isProtectedDispatchRef(branch) {
  const name = String(branch ?? "").trim().replace(/^refs\/heads\//, "");
  return name === "main" || name === "master";
}

/**
 * Which CI job actually runs each stage this script can be asked for, and the step inside it.
 *
 * 🔴 A DISPATCH RUNS THE WHOLE WORKFLOW, SO THE RUN'S OWN CONCLUSION IS NOT AN ANSWER ABOUT THE
 * STAGE YOU ASKED FOR. On `workflow_dispatch`, `ci.yml` also runs `mobile` (the Expo typecheck,
 * which REPORTS and never gates — AGENTS.md §7), the Build and the Playwright login smoke. Grading
 * the run as a whole therefore turned `remote-check typecheck` FAIL on a mobile lockfile break or a
 * smoke flake — a verdict about somebody else's code, printed under this sha, blocking this push.
 *
 * 🔴 AND THE EVENT DECIDES WHICH JOB RUNS THE SUITE, SO `test` IS GRADED IN `checks`, NOT
 * `validate`. Since 2026-10-06 the unit suite has two homes in ci.yml, exact complements:
 * `validate`'s `Test` step is `if: github.event_name == 'pull_request'` and `checks`'s is
 * `if: github.event_name != 'pull_request'` (tests/ci-suite-placement.test.ts pins the pair).
 * **The escalation here is always a `workflow_dispatch`**, so `validate`'s Test is SKIPPED on every
 * run this script ever grades, and `gradeConclusion("skipped")` is `no-verdict`. Pointed at
 * `validate` it made `remote-check test` — the owner's standing pre-push step (2026-10-04) — wait
 * ten minutes for the box, bill a full ci.yml run, wait up to 25 minutes more, and then answer NO
 * VERDICT, every single time, taking `all` and a bare `remote-check` down with it. Caught in review
 * the same evening, before the arrangement that caused it had been relied on.
 */
export const STAGE_JOBS = {
  lint: { job: "checks", step: "Lint" },
  typecheck: { job: "checks", step: "Typecheck" },
  test: { job: "checks", step: "Test" },
  build: { job: "validate", step: "Build" },
};

/**
 * The same map for a run `ci.yml` did on a PULL REQUEST — a DIFFERENT map, which is the whole reason
 * it exists rather than being reused (owner ruling, 2026-10-08: *"make the open-PR refusal read that
 * PR's checks instead of exiting 6"*). A branch with an open PR is already running these jobs on this
 * commit, already billed, so the answer is to READ that run; but reading it with the dispatch map
 * above would grade `test` from `checks` / Test, which a pull_request SKIPS — turning an already-green
 * PR into NO VERDICT, which is the defect this closes, not a second copy of it.
 *
 * Read off `.github/workflows/ci.yml` and nothing else, as exact complements of the dispatch map:
 *   validate / Test   `if: github.event_name == 'pull_request'`   → the suite's home ON a pull request
 *   checks   / Test    `if: github.event_name != 'pull_request'`  → its home on a dispatch
 *   checks   / Lint, Typecheck — ungated, so the same in both
 *   validate / Build   `if: github.event_name != 'pull_request'`  → so **a PR never builds at all**
 *
 * 🔴 `build: null` IS THE LOAD-BEARING ENTRY, AND IT IS NOT LAZINESS. A PR's green says nothing
 * whatever about `next build`, so `remote-check all` can never be fully answered by reading one — and
 * the honest answer for that half is NO VERDICT, never a pass inherited from two green checks. Grading
 * it against `validate` / Build instead would read `skipped`, which `gradeConclusion` already calls
 * no-verdict; the `null` exists so the REASON says a pull request does not build, rather than "ended
 * skipped", which reads like a fault in the run and sends the reader to look for one.
 */
export const STAGE_JOBS_PR = {
  lint: { job: "checks", step: "Lint" },
  typecheck: { job: "checks", step: "Typecheck" },
  test: { job: "validate", step: "Test" },
  build: null,
};

/**
 * Which map to grade a run with — chosen from the RUN'S OWN `event`, never from which code path is
 * asking. A route that passed its own expectation down would keep grading correctly right up until the
 * run it found was not the kind it assumed, and ci.yml's two homes for the unit suite are exactly that
 * trap: the same sha can carry a `pull_request` run and a `workflow_dispatch` run at once.
 *
 * Anything that is not a pull request takes the dispatch map, which is also what a `push` run on `main`
 * uses — the complement in ci.yml is `!= 'pull_request'`, not `== 'workflow_dispatch'`.
 *
 * @param {string | null | undefined} event a run's `event` field: `pull_request`, `workflow_dispatch`, `push`.
 */
export function stageJobsFor(event) {
  return String(event ?? "") === "pull_request" ? STAGE_JOBS_PR : STAGE_JOBS;
}

/**
 * The requested stages that the run's own event does not run at all (`build` on a pull request).
 *
 * 🔴 THIS IS WHAT STOPS A WHOLE-RUN `success` BEING READ AS A PASS FOR A STAGE THAT NEVER RAN. The
 * watcher short-circuits on `completed/success` — correct for a dispatch, where the workflow runs
 * everything this script can be asked for — but a green PR run never built, so the same short circuit
 * would print `PASS` for `remote-check build` off a run that did not compile a line.
 *
 * @param {string[]} names the stages asked for.
 * @param {Record<string, { job: string, step: string } | null>} stageJobs the map for that run's event.
 */
export function stagesNotRunBy(names, stageJobs) {
  const wanted = Array.isArray(names) && names.length > 0 ? names : Object.keys(STAGE_JOBS);
  return wanted.filter((name) => !stageJobs[name]);
}

/** A job or step conclusion read the same way everywhere: allow-list the two verdicts, nothing else. */
function gradeConclusion(conclusion) {
  if (conclusion === "success") return "pass";
  if (conclusion === "failure") return "fail";
  return "no-verdict";
}

/**
 * Grade ONLY the stages that were asked for, from a completed run's job list.
 *
 * 🔴 A STAGE THAT DID NOT RUN IS NO VERDICT, NEVER FAIL. A job missing from the run, one still
 * going, one cancelled, and a step skipped because an earlier step in the same job died are all
 * "nobody looked at your stage" — the same call the box script makes for an OOM kill. Only an
 * explicit `failure` on the stage itself is a FAIL.
 *
 * 🔴 A REAL FAILURE OUTRANKS AN UNKNOWN, exactly as it does in the box script: asking for
 * `lint test` and getting a red `lint` beside a cancelled `validate` is a FAIL, not a shrug.
 *
 * 🔴 AND THE MAP IS AN ARGUMENT, BECAUSE THE SAME SHA HAS TWO KINDS OF RUN. A `pull_request` run and a
 * `workflow_dispatch` run put the unit suite in DIFFERENT jobs and only one of them builds, so a
 * hard-coded map grades one route correctly and the other silently as NO VERDICT. The default is the
 * dispatch map, which is what every caller before 2026-10-08 meant.
 *
 * @param {string[]} names the stages the caller asked for (`lint`, `typecheck`, `test`, `build`).
 * @param {Array<{ name?: string, status?: string, conclusion?: string | null, steps?: Array<{ name?: string, conclusion?: string | null }> }> | null | undefined} jobs
 * @param {Record<string, { job: string, step: string } | null>} stageJobs `STAGE_JOBS` or `STAGE_JOBS_PR`, from `stageJobsFor(run.event)`.
 * @returns {{ verdict: "pass"|"fail"|"no-verdict", why: string, otherRed: string[], passed: string[], stages: Record<string, "PASS"|"FAIL"> }}
 */
export function gradeActionsStages(names, jobs, stageJobs = STAGE_JOBS) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { verdict: "no-verdict", why: "the run's job list could not be read", otherRed: [], passed: [], stages: {} };
  }
  const wanted = Array.isArray(names) && names.length > 0 ? names : Object.keys(STAGE_JOBS);
  const graded = [];
  for (const name of wanted) {
    const spec = stageJobs[name];
    if (!spec) {
      // Two different absences, and the reader must be able to tell them apart: a stage this event does
      // not run (`build` on a pull request — the run is fine, it simply never compiled anything), and a
      // stage name no CI job has ever run (a typo, or a stage retired from ci.yml).
      const known = Object.prototype.hasOwnProperty.call(stageJobs, name);
      const where = stageJobs === STAGE_JOBS_PR ? "a pull_request run" : "this run's event";
      graded.push({
        name,
        verdict: "no-verdict",
        why: known
          ? where + " never runs the " + name + ", so its green says nothing about that half"
          : name + " is not a stage any CI job runs",
      });
      continue;
    }
    const job = jobs.find((j) => j && j.name === spec.job);
    if (!job) {
      graded.push({ name, verdict: "no-verdict", why: "the `" + spec.job + "` job, which runs " + name + ", is not in this run" });
      continue;
    }
    if (job.status && job.status !== "completed") {
      graded.push({ name, verdict: "no-verdict", why: "`" + spec.job + "` is still " + job.status });
      continue;
    }
    const step = Array.isArray(job.steps) ? job.steps.find((s) => s && s.name === spec.step) : undefined;
    const conclusion = step ? step.conclusion : job.conclusion;
    const verdict = gradeConclusion(conclusion);
    const where = step ? "`" + spec.job + "` / " + spec.step : "`" + spec.job + "`";
    graded.push({
      name,
      verdict,
      why: verdict === "no-verdict"
        ? where + " ended " + String(conclusion ?? "unknown") + ", so " + name + " never produced a verdict"
        : where + " " + String(conclusion),
    });
  }
  const otherRed = jobs
    .filter((j) => j && j.conclusion === "failure" && !graded.some((g) => stageJobs[g.name]?.job === j.name))
    .map((j) => String(j.name));
  // The stages that really did pass, so a partial answer can SAY which half it has. Reading a PR gives
  // three of `all`'s four stages, and a bare NO VERDICT about the build throws the other three away.
  const passed = graded.filter((g) => g.verdict === "pass").map((g) => g.name);
  // Per-stage PASS/FAIL for the verdict record; a no-verdict stage is left out, never stored as either.
  const stages = Object.fromEntries(
    graded.filter((g) => g.verdict !== "no-verdict").map((g) => [g.name, g.verdict === "pass" ? "PASS" : "FAIL"]),
  );
  const failed = graded.filter((g) => g.verdict === "fail");
  if (failed.length > 0) {
    return { verdict: "fail", why: failed.map((g) => g.why).join("; "), otherRed, passed, stages };
  }
  const unknown = graded.filter((g) => g.verdict === "no-verdict");
  if (unknown.length > 0) {
    return { verdict: "no-verdict", why: unknown.map((g) => g.why).join("; "), otherRed, passed, stages };
  }
  return { verdict: "pass", why: graded.map((g) => g.why).join("; "), otherRed, passed, stages };
}

/**
 * Grade a dispatched GitHub Actions run — ALLOW-LISTING success, never deny-listing the unfinished
 * states.
 *
 * 🔴 A WATCHER THAT `continue`s ON A LIST OF UNFINISHED STATES CALLS AN UNKNOWN STATE GREEN. That is a
 * measured failure in this repository (`a-padded-short-sha-422s-and-a-fallthrough-watcher-calls-it-green`):
 * a loop skipping `queued|in_progress|""` met a 422 error body, matched none of them, fell out of the
 * loop and printed its success line. So the only verdicts here are an explicit `completed/success`
 * (pass) and an explicit `completed/failure` (fail); `cancelled`, `timed_out`, `skipped`, `neutral`,
 * `action_required` and `startup_failure` are NO VERDICT, which is a retry and never a green.
 *
 * 🔴 AND A RUN IS ONLY EVIDENCE ABOUT THE SHA IT RAN. `gh workflow run` takes a REF, so the run checks
 * whatever that branch pointed at when it started — which is not the local commit if a push is
 * missing or someone else pushed. A mismatch is NO VERDICT, with the shas named.
 *
 * `conclusion` is `null`, not absent, while a run is unfinished — the type says so, because a
 * caller that cannot pass what GitHub actually returns would be typed into skipping that case.
 *
 * @param {{ headSha?: string | null, status?: string, conclusion?: string | null, url?: string } | null | undefined} run
 * @param {string} wantSha the 40-char sha the caller actually asked about.
 * @returns {{ settled: boolean, verdict: "pass"|"fail"|"no-verdict"|"pending", why: string }}
 */
export function gradeActionsRun(run, wantSha) {
  if (!run) return { settled: false, verdict: "pending", why: "no dispatched run has appeared yet" };
  if (run.headSha && run.headSha !== wantSha) {
    return {
      settled: true,
      verdict: "no-verdict",
      why: "the run is about " + String(run.headSha).slice(0, 9) + ", not " + wantSha.slice(0, 9),
    };
  }
  if (run.status !== "completed") {
    return { settled: false, verdict: "pending", why: "status " + String(run.status || "unknown") };
  }
  if (run.conclusion === "success") return { settled: true, verdict: "pass", why: "completed/success" };
  if (run.conclusion === "failure") return { settled: true, verdict: "fail", why: "completed/failure" };
  return {
    settled: true,
    verdict: "no-verdict",
    why: "completed/" + String(run.conclusion || "unknown") + " — not a verdict about the code",
  };
}
