#!/usr/bin/env node
//
// Run the heavy checks on the self-hosted CI box instead of this laptop.
//
// WHY THIS EXISTS
// ---------------
// AGENTS.md §5 and CLAUDE.md both say the same thing: a local typecheck does not FAIL on this
// machine, it gets KILLED. `tsc` over this repo needs 4.0-4.5 GB of heap against node's own ~4.1 GB
// default, and with the desktop app holding ~4.2 GB across its processes `mem-watchdog.ps1` reaps it
// as the largest node job. It prints nothing and exits non-zero, which a session cannot tell from a
// typo, so it tries the next spelling — 23 of 23 node kills in the watchdog's surviving log window
// were a typecheck. `.claude/hooks/bash-guard.mjs` clause C8 therefore refuses one outright.
//
// That left exactly one answer: push the branch and read the PR. It is the right answer for a change
// you are ready to open a PR for, and the wrong one for the fifteen times before that.
//
// This is the missing middle. It pushes the working commit straight to the CI box over SSH and runs
// the check THERE, where it takes 115s and has 7.7 GB plus 8 GB of swap to itself. Nothing heavy
// touches the laptop; no PR is opened; no Actions minutes are billed.
//
//   node scripts/remote-check.mjs typecheck
//   node scripts/remote-check.mjs lint test
//   node scripts/remote-check.mjs all          # lint, typecheck, unit suite
//   node scripts/remote-check.mjs lockfile     # regenerate pnpm-lock.yaml and bring it back
//
// 🔴 WHY `lockfile` IS HERE, AND WHY IT IS NOT A CHECK. Until 2026-09-30 there was no sanctioned place
// in this setup to regenerate a lockfile at all. `.claude/hooks/bash-guard.mjs` clause C6 denies pnpm
// inside every linked worktree (node_modules there is a junction to the primary checkout's) and,
// unlike C7, C8, C10, C11 and C12, it has NO environment stand-down; the primary checkout belongs to
// whichever session is live in it; and cloud isolation was unavailable. So a branch that bumped
// package.json could not have its lockfile regenerated anywhere, and the gap was closed that night by
// an improvised SSH session — which worked, and which nothing would have caught had it gone wrong.
//
// This mode is that improvisation made repeatable. It runs `pnpm install --lockfile-only` on the box
// and returns BOTH pnpm-lock.yaml and pnpm-workspace.yaml — pnpm writes `minimumReleaseAgeExclude`
// into the second when it adopts a version younger than its release-age quarantine, and a
// --frozen-lockfile install needs those entries, so returning only the lockfile loses them silently.
// It is not a `CHECKS` entry because those are bash fragments in a pass/fail wrapper: a check can
// report a verdict and can never return a file.
//
// 🔴 IT SENDS THE COMMIT, NOT THE WORKING TREE. Uncommitted edits are not checked. Commit (or
// `git stash`-and-commit) first; the script prints the sha it actually ran so a stale result cannot
// be mistaken for a fresh one.
//
// 🔴 NO GITHUB CREDENTIAL IS PLACED ON THE BOX. It pushes over the SSH key you already use, into a
// bare repo owned by the runner user. The box never authenticates to GitHub for this, so losing the
// box does not leak repository access.
//
// 🔴 IT USES A DIRECTORY OF ITS OWN, NEVER THE RUNNER'S `_work`. A CI job owns that tree and cleans
// it between runs; sharing it would make a real CI run fail for reasons nobody could reproduce. If a
// CI job is running when you start, this warns — the box has 4 vCPU and a concurrent job will make
// both slower (see docs/ci-self-hosted-runner.md for the memory arithmetic: `tsc` alone peaks at
// 5.86 GB of 7,740 MB).
//
// Host, user and key are overridable for when the box is replaced:
//   PHX_CHECK_HOST   default 46.225.184.142
//   PHX_CHECK_USER   default phx
//   PHX_CHECK_KEY    default ~/.ssh/railway_phoenix_ed25519

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST = process.env.PHX_CHECK_HOST || "46.225.184.142";
const USER = process.env.PHX_CHECK_USER || "phx";
const KEY = process.env.PHX_CHECK_KEY || path.join(os.homedir(), ".ssh", "railway_phoenix_ed25519");
const REMOTE_ROOT = "/home/" + USER + "/remote-check";
const BARE = REMOTE_ROOT + "/repo.git";
const WORK = REMOTE_ROOT + "/work";

// Each entry is the exact command the box runs. `typecheck` carries the same heap ci.yml gives it,
// so a result here means the same thing a CI result means. It also takes ci.yml's typecheck lock
// (/tmp/phx-typecheck.lock), so it waits for a CI typecheck on the box instead of running beside it —
// two `tsc` runs on this 7.7 GB box is what the lock exists to stop (owner, 2026-09-30).
//
// 🔴 THE TYPECHECK RUNS COLD, AND WITHOUT `--incremental false` THIS SCRIPT RETURNED A FALSE GREEN.
// `tsconfig.json` sets `"incremental": true`, and this box KEEPS its working directory between runs,
// so `tsc` reused `tsconfig.tsbuildinfo` and answered from the cache instead of rechecking. CI cannot
// do that — it checks out fresh, so it holds no build info and is cold by construction. Measured
// 2026-09-30: `PASS in 12s` here on b04b2e80a, whose required `checks` job then went RED on two
// TS2322 errors in test fixtures, and `PASS in 11s` on the commit that fixed them — against the
// ~112s a cold run takes. That is AGENTS.md §5 ("a warm incremental cache lies") arriving through the
// one tool that exists to REPLACE the local typecheck, which makes the false pass worse than no
// answer: it was trusted, and it sent a branch to CI believing it was clean.
const CHECKS = {
  lint: "corepack pnpm run lint",
  typecheck:
    "flock -w 1200 /tmp/phx-typecheck.lock env NODE_OPTIONS=--max-old-space-size=6144 ./node_modules/.bin/tsc --noEmit --incremental false --pretty false",
  test: "corepack pnpm run test",
  build: "corepack pnpm run build",
};
const ALL = ["lint", "typecheck", "test"];

const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=20",
  "-i", KEY,
];

// 🔴 GIT_SSH_COMMAND IS PARSED SHELL-STYLE, SO A WINDOWS KEY PATH IS DESTROYED BY IT. git splits the
// string and treats `\` as an escape, turning C:\Users\satoh\.ssh\id into `C:Userssatoh.sshid` — and
// the only symptom is `Permission denied (publickey)`, which reads as a key the server rejected
// rather than a key that was never opened. Forward slashes work on Windows git and everywhere else;
// the quotes cover a path with spaces.
const GIT_SSH_COMMAND =
  'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20 -i "' +
  KEY.replace(/\\/g, "/") +
  '"';

function die(message) {
  console.error("remote-check: " + message);
  process.exit(2);
}

// 🔴 THE FIRST FAILURE ANYONE HITS IS A CHANGED HOST KEY, AND ITS RAW OUTPUT IS A WALL OF SHOUTING
// ABOUT A MAN-IN-THE-MIDDLE. On this box it has a dull cause: Hetzner rescue runs a DIFFERENT
// system with its own host key, so a `known_hosts` entry recorded while the box was in rescue does
// not match the installed OS afterwards — which is exactly how this one was provisioned
// (docs/ci-self-hosted-runner.md, the 2026-09-30 entry). Say so, and say how to check it is really
// that rather than assuming: compare the offered fingerprint against the key on the box's own disk.
function explainSshFailure(stderr) {
  if (!/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr || "")) return null;
  return (
    "the box's SSH host key does not match ~/.ssh/known_hosts.\n" +
    "  On this host that is USUALLY a stale entry from Hetzner rescue, not an attack — rescue is a\n" +
    "  different system with its own key. VERIFY before trusting it, do not just delete the line:\n" +
    "    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i " + KEY + " " + USER + "@" + HOST + " \\\n" +
    "      'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'\n" +
    "  If that fingerprint equals the one ssh just offered, the host is genuine:\n" +
    "    ssh-keygen -R " + HOST + " && ssh-keyscan -t ed25519 " + HOST + " >> ~/.ssh/known_hosts\n" +
    "  If it does NOT match, stop and treat the host as compromised."
  );
}

function ssh(script, { capture = false } = {}) {
  const args = [...SSH_OPTS, USER + "@" + HOST, "bash -s"];
  if (capture) {
    const run = spawnSync("ssh", args, { input: script, encoding: "utf8" });
    if (run.status !== 0) {
      die(explainSshFailure(run.stderr) || "ssh failed: " + String(run.stderr || "").trim().split("\n").slice(-3).join(" "));
    }
    return String(run.stdout).trim();
  }
  return spawnSync("ssh", args, { input: script, stdio: ["pipe", "inherit", "inherit"] }).status ?? 1;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));

// `lockfile` is not a CHECKS entry and cannot be one: every CHECKS value is a bash fragment dropped
// into a `if <cmd>; then R=PASS; else R=FAIL` wrapper, so a check can only ever pass or fail. This
// mode has to bring two FILES back, which needs its own path. See the header.
const LOCKFILE_MODE = requested.length === 1 && requested[0] === "lockfile";

const names = LOCKFILE_MODE ? [] : requested.length === 0 || requested.includes("all") ? ALL : requested;
for (const name of names) {
  if (!CHECKS[name]) {
    die("unknown check '" + name + "'. Known: " + Object.keys(CHECKS).join(", ") + ", all, lockfile");
  }
}
if (requested.length > 1 && requested.includes("lockfile")) {
  die("`lockfile` regenerates files and cannot be combined with a check. Run it on its own, commit, then check.");
}

if (!existsSync(KEY)) die("no SSH key at " + KEY + ". Set PHX_CHECK_KEY.");

let sha;
let branch;
try {
  sha = git("rev-parse", "HEAD");
  branch = git("rev-parse", "--abbrev-ref", "HEAD");
} catch {
  die("not inside a git repository");
}

// Say plainly what is NOT being checked, rather than letting a clean result imply more than it means.
const dirty = git("status", "--porcelain").split("\n").filter(Boolean);
if (dirty.length > 0) {
  console.log("remote-check: " + dirty.length + " uncommitted change(s) are NOT included — checking " + sha.slice(0, 9) + " as committed:");
  for (const line of dirty.slice(0, 10)) console.log("    " + line);
  if (dirty.length > 10) console.log("    … and " + (dirty.length - 10) + " more");
  console.log("");
}

// 🔴 THE LOCKFILE MODE SENDS THE COMMIT, SO AN UNCOMMITTED MANIFEST WOULD REGENERATE THE WRONG
// LOCKFILE — and silently: it would come back resolving the versions package.json had at the last
// commit, not the ones you just typed, which reads as pnpm ignoring your bump. For a CHECK an
// uncommitted file only narrows what was proved (warned about above); here it corrupts the output.
if (LOCKFILE_MODE) {
  const manifests = dirty.filter((line) => /\s(package\.json|pnpm-workspace\.yaml)$/.test(line));
  if (manifests.length > 0) {
    console.error("remote-check: the manifests this would resolve FROM are uncommitted:");
    for (const line of manifests) console.error("    " + line);
    die("commit them first — this sends the commit, not the working tree, so the lockfile would be generated from the OLD manifests.");
  }
}

console.log("remote-check: " + (LOCKFILE_MODE ? "lockfile" : names.join(" + ")) + "  on " + USER + "@" + HOST);
console.log("             " + branch + " @ " + sha.slice(0, 9));

// One round trip: create the bare repo if this is the first run, and report whether CI is busy.
const state = ssh(
  "set -e\n" +
    "mkdir -p " + REMOTE_ROOT + "\n" +
    "[ -d " + BARE + " ] || git init -q --bare " + BARE + "\n" +
    "if pgrep -f Runner.Worker >/dev/null 2>&1; then echo BUSY; else echo IDLE; fi\n",
  { capture: true },
);
if (state.includes("BUSY")) {
  console.log("             ⚠ a CI job is running on the box — 4 vCPU shared, both will be slower");
}

try {
  execFileSync(
    "git",
    ["push", "--force", "--quiet",
      "ssh://" + USER + "@" + HOST + BARE,
      sha + ":refs/heads/remote-check"],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, GIT_SSH_COMMAND } },
  );
} catch {
  die("could not push to the box. Check SSH: ssh -i " + KEY + " " + USER + "@" + HOST);
}

// ── The lockfile mode, which returns FILES rather than a verdict ────────────────────────────────
//
// The return channel is a git ref in the box's own bare repo, deliberately, for two reasons. The
// obvious one is that `tests/remote-check.test.ts` asserts this script spawns nothing locally except
// `ssh` and `git`, so `scp` is out. The better one is that `ssh()`'s capture mode `.trim()`s what it
// reads, which would eat a YAML file's trailing newline and hand back a lockfile that differs from
// the one the box generated — a corruption nothing downstream would report.
if (LOCKFILE_MODE) {
  const RESULT_REF = "refs/heads/lockfile-result";
  const outcome = ssh(
    "set -uo pipefail\n" +
      "export PATH=/usr/local/lib/nodejs/node/bin:$PATH\n" +
      "export COREPACK_ENABLE_DOWNLOAD_PROMPT=0\n" +
      "[ -d " + WORK + "/.git ] || git clone -q -b remote-check " + BARE + " " + WORK + "\n" +
      "cd " + WORK + "\n" +
      "git fetch -q origin remote-check\n" +
      "git checkout -q -f " + sha + " 2>/dev/null || git checkout -q -f FETCH_HEAD\n" +
      'echo "box head: $(git rev-parse --short HEAD)"\n' +
      // NOT --frozen-lockfile: that is the one flag guaranteed to fail here, because the whole point
      // is that the lockfile does not yet match the manifests.
      "corepack pnpm install --lockfile-only || { echo 'LOCKFILE_FAILED'; exit 1; }\n" +
      "if git diff --quiet -- pnpm-lock.yaml pnpm-workspace.yaml; then echo NOCHANGE; exit 0; fi\n" +
      // pnpm can touch pnpm-workspace.yaml too: adopting a version younger than pnpm 11's release-age
      // quarantine makes it append `minimumReleaseAgeExclude` entries, and a --frozen-lockfile install
      // needs them. Returning only the lockfile would lose them with nothing to show it.
      'git -c user.email=box@phoenix.local -c user.name="remote-check" commit -q ' +
      '-m "chore(deps): regenerate the lockfile on the box" -- pnpm-lock.yaml pnpm-workspace.yaml\n' +
      "git push -q -f origin HEAD:" + RESULT_REF + "\n" +
      "echo REGENERATED\n",
    { capture: true },
  );

  console.log(outcome.split("\n").filter(Boolean).map((line) => "             " + line).join("\n"));

  if (outcome.includes("NOCHANGE")) {
    console.log("\nremote-check: lockfile already matches the manifests at " + sha.slice(0, 9) + " — nothing to bring back.");
    process.exit(0);
  }
  if (!outcome.includes("REGENERATED")) {
    die("the box did not report a regenerated lockfile. Nothing was changed locally.");
  }

  try {
    execFileSync(
      "git",
      ["fetch", "--quiet", "ssh://" + USER + "@" + HOST + BARE, RESULT_REF],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, GIT_SSH_COMMAND } },
    );
    // Overwrites both files from the fetched commit. That is the intent here — but it IS the
    // "names a source AND a path" form that silently discards a local edit to those paths, which is
    // why the uncommitted-manifest refusal above runs before anything is sent.
    execFileSync("git", ["checkout", "FETCH_HEAD", "--", "pnpm-lock.yaml", "pnpm-workspace.yaml"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    die("could not bring the regenerated files back. The box has them on " + RESULT_REF + " in " + BARE + ".");
  }

  console.log("\nremote-check: lockfile regenerated from " + sha.slice(0, 9) + " — pnpm-lock.yaml and pnpm-workspace.yaml are staged.");
  console.log("             Review the diff, commit, and let the PR's --frozen-lockfile install prove it.");
  process.exit(0);
}

const steps = names
  .map((name) =>
    'echo ""; echo "=== ' + name + ' ==="; S=$(date +%s); ' +
    "if " + CHECKS[name] + "; then R=PASS; else R=FAIL; FAILED=1; fi; " +
    'E=$(date +%s); echo "--- ' + name + ' $R in $((E-S))s ---"',
  )
  .join("\n");

const status = ssh(
  "set -uo pipefail\n" +
    "export PATH=/usr/local/lib/nodejs/node/bin:$PATH\n" +
    "FAILED=0\n" +
    // `-b remote-check` because the bare repo's HEAD still points at a branch that was never
    // created, and a plain clone then warns "remote HEAD refers to nonexistent ref" on first run.
    "[ -d " + WORK + "/.git ] || git clone -q -b remote-check " + BARE + " " + WORK + "\n" +
    "cd " + WORK + "\n" +
    "git fetch -q origin remote-check\n" +
    "git checkout -q -f " + sha + " 2>/dev/null || git checkout -q -f FETCH_HEAD\n" +
    'echo "box head: $(git rev-parse --short HEAD)"\n' +
    "corepack pnpm install --frozen-lockfile --reporter=silent || { echo 'install failed'; exit 1; }\n" +
    steps + "\n" +
    "exit $FAILED\n",
);

console.log("");
console.log(status === 0 ? "remote-check: PASS — " + sha.slice(0, 9) : "remote-check: FAIL — " + sha.slice(0, 9));
process.exit(status);
