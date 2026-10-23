// The nightly cloud-mirror refresh — mirror the laptop's live memory into the repo and keep ONE pull
// request carrying it.
//
//   node scripts/cloud-mirror/refresh.mjs            run it for real: commit, push, open or update the PR
//   node scripts/cloud-mirror/refresh.mjs --dry-run  do everything up to the push, print the drift, open nothing
//
// Run it from a checkout nobody else is using — `run-refresh.mjs`, the scheduled launcher, makes a
// throwaway worktree for exactly that. It switches that checkout to a branch.
//
// 🔴 WHY THIS EXISTS (owner, 2026-10-23: "widen 6337 with an automatic nightly mirror refresh"). A CLOUD
// session is an isolated clone: it never sees `~/.claude`, so `.claude/cloud-context/` IS its memory and
// its copy of the standing rules. The mirror only moves when a refresh MERGES, and refreshing it was a
// thing a person had to remember — so the drift was carried by the SessionStart banner instead, which
// read 9 files behind on 2026-10-23 (2 stale, 7 missing). Every one of those was a fact a cloud session
// would have had wrong while answering confidently.
//
// WHY A LAPTOP TASK AND NOT A WORKFLOW CRON — two independent reasons, either one enough. The source is
// `~/.claude/projects/<slug>/memory/`, which exists only on this laptop and is in no repository; and a
// pull request opened by a workflow's GITHUB_TOKEN starts no CI, so its required `validate` and `checks`
// would never report and it could never merge (`scripts/deps-refresh/install-task.ps1` carries the same
// reasoning for the weekly dependency refresh).
//
// WHAT IT STAGES, AND WHY ALL THREE PATHS TOGETHER. `sync-cloud-context.mjs` mirrors the notes AND runs
// `build.mjs --file-new`, which files each new slug in `scripts/module-memory/assignments.json` and
// rebuilds every module's generated notes block. A commit that stages the mirror alone ships notes no
// module claims — an ORPHAN — and `build.mjs --check` fails the required `validate` job: that turned
// `main` red on three consecutive commits on 2026-10-02 and WITHHELD three production deploys
// (`a-mirror-refresh-must-carry-assignments-json-or-main-goes-red`).
//
// WHAT IT REFUSES, writing the reason to its log and opening nothing:
//   - a second refresh PR while one is still open — it pushes onto that one instead, so the owner is
//     never handed two of the same PR, and a .claude-only PR is never put to him at all (AGENTS.md §6)
//   - a refresh that leaves module memory unhealthy — it would open a PR that cannot go green
//   - a refresh carrying key material. The laptop's push guard (`bash-guard.mjs` C12, gitleaks) reads
//     BASH commands, and this job pushes from node, so nothing else would stop a credential a memory
//     note happened to quote from reaching a public branch.
// A run that moved nothing pushes nothing and leaves no branch behind.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "cloud-mirror-refresh",
  entry: import.meta.url,
  known: ["--dry-run"],
  hints: ["a bare run pushes and opens or updates a real PR; --dry-run pushes nothing and opens nothing"],
});

/** Every refresh branch starts with this. It must not prefix any other branch, or the one-open-PR guard misfires. */
export const BRANCH_PREFIX = "codex/cloud-mirror-refresh";

/**
 * The three paths a refresh commit must carry, together.
 * 🔴 Staging the mirror alone is the defect this list exists to prevent: a new note no module claims is
 * an orphan, and `build.mjs --check` is inside the required `validate` job.
 */
export const STAGE_PATHS = [".claude/cloud-context", ".claude/rules", "scripts/module-memory/assignments.json"];

/**
 * Key material that must never ride into a public branch inside a memory note. Names, not just
 * patterns, so a refusal says which shape it saw. Deliberately NOT the word "service_role" or any other
 * prose a note legitimately discusses — 11 mirrored notes already name it, and a scanner that cries at
 * prose is a scanner nobody keeps.
 */
export const SECRET_PATTERNS = [
  ["an OpenAI-style key", /\bsk-[A-Za-z0-9]{20,}/],
  ["a JWT (Supabase anon or service key)", /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/],
  ["a Supabase access token", /\bsbp_[a-f0-9]{40}/],
  ["a private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["an AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
];

/**
 * Which secret shapes a blob of text holds, by name. Pure, so the test can hand it both real key
 * material and the prose that must not trip it.
 * @param {string} text
 * @returns {string[]}
 */
export function secretFindings(text) {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/**
 * The refresh PR already waiting, if any — the one this run must push onto rather than duplicate.
 * @param {{ number: number, headRefName: string, url: string }[]} prs
 */
export function openRefreshPr(prs) {
  return prs.find((pr) => pr.headRefName.startsWith(BRANCH_PREFIX)) ?? null;
}

const say = (line) => console.log(`cloud-mirror: ${line}`);
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();

function cairoDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function cairoClock() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date())
    .replace(":", "");
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const root = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  const git = (...args) => run("git", args, root);
  const gh = (...args) => run("gh", args, root);
  const node = (...args) => run(process.execPath, args, root);

  // Where this run will put its commit: onto the refresh PR already open, or onto a new branch.
  const open = JSON.parse(gh("pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,url"));
  const waiting = openRefreshPr(open);
  let branch;
  if (waiting) {
    say(`a refresh PR is already open (#${waiting.number}, ${waiting.url}) — this run pushes onto it rather than opening a second`);
    branch = waiting.headRefName;
    git("fetch", "-q", "origin", branch);
    git("switch", "-q", "-c", `${branch}-run-${cairoClock()}`, `origin/${branch}`);
  } else {
    branch = `${BRANCH_PREFIX}-${cairoDay()}`;
    if (git("ls-remote", "--heads", "origin", branch)) branch = `${branch}-${cairoClock()}`;
    git("switch", "-q", "-c", branch);
  }

  // The refresh itself. It always writes into the checkout it lives in, so this worktree's mirror is
  // what moves; the memory it reads is the laptop's, named by a constant inside that script.
  for (const line of node(path.join(root, "scripts", "sync-cloud-context.mjs")).split(/\r?\n/).filter(Boolean)) say(line);

  const dirty = git("status", "--porcelain", "--", ...STAGE_PATHS);
  if (!dirty) {
    say("NOCHANGE — the mirror already matches the laptop's live memory; nothing pushed, no PR touched");
    return;
  }
  const files = dirty.split(/\r?\n/).filter(Boolean);
  say(`${files.length} mirror file(s) moved`);

  // A PR that cannot go green is worse than no PR: it sits in the open-PR list and blocks the next
  // night's run on the one-open-PR guard above.
  const health = node(path.join(root, "scripts", "module-memory", "build.mjs"), "--check");
  if (!/module memory: healthy/.test(health)) {
    say(`REFUSED — module memory is not healthy after the refresh, so nothing is pushed: ${health.split(/\r?\n/).slice(-3).join(" | ")}`);
    process.exitCode = 1;
    return;
  }
  say("module memory: healthy");

  git("add", "--", ...STAGE_PATHS);

  // The staged text, scanned before it can reach a public branch (see the header: the laptop's gitleaks
  // guard reads bash commands, and this job never runs one).
  const staged = git("diff", "--cached", "--unified=0", "--no-color");
  const found = secretFindings(staged);
  if (found.length > 0) {
    say(`REFUSED — the refresh carries ${found.join(" and ")}; nothing is pushed. Redact the note on the laptop, then run this again`);
    process.exitCode = 1;
    return;
  }

  const title = "docs(agents): refresh the cloud context mirror";
  if (dryRun) {
    say(`dry run — ${files.length} file(s) would be committed as "${title}"; nothing pushed, nothing opened`);
    return;
  }

  git("commit", "-q", "-m", `${title}\n\nThe nightly refresh (scripts/cloud-mirror/refresh.mjs).\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>`);
  git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  if (waiting) {
    say(`pushed onto #${waiting.number} — ${files.length} file(s), ${git("rev-parse", "--short", "HEAD")}`);
    return;
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), "phx-cloud-mirror-"));
  try {
    const body = [
      "The nightly cloud-mirror refresh (`scripts/cloud-mirror/refresh.mjs`, scheduled on the laptop by `scripts/cloud-mirror/install-task.ps1`).",
      "",
      "A cloud session is an isolated clone and never sees `~/.claude`, so `.claude/cloud-context/` is the only memory and the only copy of the standing rules it has — and it is only as fresh as its last merged refresh.",
      "",
      "| Moved | |",
      "| --- | --- |",
      `| mirror files | ${files.length} |`,
      "",
      "`scripts/module-memory/assignments.json` and the rebuilt module notes blocks are in the same commit on purpose: a mirror note no module claims is an orphan and `build.mjs --check` fails the required `validate` job.",
      "",
      "`node scripts/module-memory/build.mjs --check` printed `module memory: healthy` before the push, and the staged text was scanned for key material.",
      "",
      "The PR's `validate` and `checks` are the gate.",
    ].join("\n");
    const bodyFile = path.join(scratch, "body.md");
    writeFileSync(bodyFile, body, "utf8");
    const url = gh("pr", "create", "--base", "main", "--head", branch, "--title", title, "--body-file", bodyFile);
    say(`opened ${url}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
