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

// `steps` is [{ name, command }]; `install` is the bash that installs dependencies.
export function buildRunScript({ remoteRoot, runId, sha, steps, install, prelude = [] }) {
  const lines = privateTree({ remoteRoot, runId, sha, prelude });
  lines.push("FAILED=0");
  lines.push(install + " || { echo 'install failed'; exit 1; }");
  lines.push("same_tree install");
  for (const { name, command } of steps) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("remote-check: unsafe check name: " + name);
    lines.push(
      'echo ""; echo "=== ' + name + ' ==="; S=$(date +%s); ' +
        "if " + command + "; then R=PASS; else R=FAIL; FAILED=1; fi; " +
        'E=$(date +%s); same_tree ' + name + '; echo "--- ' + name + ' $R in $((E-S))s ---"',
    );
  }
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
