// The weekly dependency refresh — re-resolve every package to the newest version its range allows,
// and open ONE pull request when anything moved.
//
//   node scripts/deps-refresh/refresh.mjs            run it for real: push a branch, open the PR
//   node scripts/deps-refresh/refresh.mjs --dry-run  do everything up to the PR, print what would move,
//                                                    then delete the branch it pushed
//
// Run it from a checkout of `origin/main` that nobody else is using — `run-refresh.mjs`, the scheduled
// launcher, makes a throwaway worktree for exactly that. It switches that checkout to a new branch.
//
// 🔴 WHY THIS EXISTS (owner, 2026-10-23: "schedule the recurring pnpm update the fast-uri note says is
// due"). The same advisory shape had hit fast-uri five times by 2026-09-30: the range in the graph
// ALLOWED the patched version from the day it published, but the lockfile had resolved the version
// before it and nothing ever re-resolved it, so every fix was a hand-raised floor in
// pnpm-workspace.yaml. The note on that floor said the answer to a fifth occurrence is a scheduled
// `pnpm update`. hono and ip-address had the same shape again on 2026-10-23.
//
// HOW. It cannot run pnpm here: bash-guard C6 refuses pnpm in a worktree, and this laptop runs lean. So
// it pushes a branch identical to `main` (a branch push starts no CI — ci.yml runs on `push` to main
// only), dispatches `lockfile.yml` on it with `mode=refresh`, downloads the two files that run made and
// commits them. The PR is opened with the owner's own `gh`, so its `validate` and `checks` run as on
// any other PR — a PR opened by a workflow's GITHUB_TOKEN would start no CI at all.
//
// WHAT IT REFUSES, writing the reason to its log and opening nothing:
//   - a second refresh PR while one is still open — one at a time, so a slow merge never stacks them
//   - a refresh that changed pnpm-workspace.yaml: pnpm writes `minimumReleaseAgeExclude` there only to
//     adopt a version younger than the quarantine, and the floors' own notes refuse that hole
// A refresh that moved nothing pushes nothing it leaves behind: the branch is deleted again.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "../lib/refuse-arguments.mjs";

refuseUnknownFlags({
  name: "deps-refresh",
  entry: import.meta.url,
  known: ["--dry-run"],
  hints: ["a bare run opens a real PR; --dry-run deletes the branch it pushed and opens nothing"],
});

/** Every refresh branch starts with this. It must not prefix any other branch, or the one-open-PR guard misfires. */
export const BRANCH_PREFIX = "codex/weekly-deps-refresh-";
const WORKFLOW = "lockfile.yml";
const FILES = ["pnpm-lock.yaml", "pnpm-workspace.yaml"];
const WAIT_MINUTES = 30;

/**
 * The resolved versions in a pnpm lockfile's `packages:` section, by package name. Only that section:
 * `snapshots:` repeats every key with its peer suffix, and `importers:` holds ranges, not versions.
 * @param {string} lock
 * @returns {Map<string, Set<string>>}
 */
export function resolvedVersions(lock) {
  const text = lock.replace(/\r\n/g, "\n");
  const start = text.indexOf("\npackages:\n");
  const versions = new Map();
  if (start < 0) return versions;
  const rest = text.slice(start + "\npackages:\n".length);
  const end = rest.search(/^\S/m);
  const section = end < 0 ? rest : rest.slice(0, end);
  for (const match of section.matchAll(/^ {2}'?((?:@[^@\s'/]+\/)?[^@\s'/]+)@([^\s':(]+)'?:/gm)) {
    const [, name, version] = match;
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(version);
  }
  return versions;
}

/**
 * What moved between two lockfiles, one line per package whose resolved versions differ.
 * @param {string} before
 * @param {string} after
 * @returns {{ name: string, from: string, to: string }[]}
 */
export function lockMoves(before, after) {
  const was = resolvedVersions(before);
  const now = resolvedVersions(after);
  const names = [...new Set([...was.keys(), ...now.keys()])].sort();
  const list = (set) => (set && set.size ? [...set].sort().join(", ") : "");
  const moves = [];
  for (const name of names) {
    const from = list(was.get(name));
    const to = list(now.get(name));
    if (from !== to) moves.push({ name, from: from || "(new)", to: to || "(removed)" });
  }
  return moves;
}

const say = (line) => console.log(`deps-refresh: ${line}`);
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

  const open = JSON.parse(gh("pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,url"));
  const waiting = open.find((pr) => pr.headRefName.startsWith(BRANCH_PREFIX));
  if (waiting) {
    say(`a refresh PR is still open (#${waiting.number}, ${waiting.url}) — one at a time, so nothing new is opened`);
    return;
  }

  let branch = `${BRANCH_PREFIX}${cairoDay()}`;
  if (git("ls-remote", "--heads", "origin", branch)) branch = `${branch}-${cairoClock()}`;
  const sha = git("rev-parse", "HEAD");
  say(`refreshing from ${sha.slice(0, 9)} on ${branch}${dryRun ? " (dry run)" : ""}`);

  git("switch", "-q", "-c", branch);
  git("push", "-q", "-u", "origin", branch);
  let keepBranch = false;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "phx-deps-refresh-"));
  try {
    const after = Date.now() - 60_000;
    gh("workflow", "run", WORKFLOW, "--ref", branch, "-f", "mode=refresh");
    say(`dispatched ${WORKFLOW} (mode=refresh) — waiting up to ${WAIT_MINUTES} minutes`);

    const deadline = Date.now() + WAIT_MINUTES * 60_000;
    let found;
    while (Date.now() < deadline) {
      pause(20_000);
      const runs = JSON.parse(
        gh("run", "list", "--workflow", WORKFLOW, "--branch", branch, "--event", "workflow_dispatch", "--limit", "5", "--json", "databaseId,status,conclusion,headSha,createdAt,url"),
      );
      found = runs.find((r) => r.headSha === sha && Date.parse(r.createdAt) >= after);
      if (found?.status === "completed") break;
    }
    if (found?.status !== "completed") throw new Error(`the ${WORKFLOW} run had not finished after ${WAIT_MINUTES} minutes${found?.url ? `: ${found.url}` : ""}`);
    if (found.conclusion !== "success") throw new Error(`the ${WORKFLOW} run ended ${found.conclusion}: ${found.url}`);

    gh("run", "download", String(found.databaseId), "--name", "lockfile", "--dir", scratch);
    const before = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
    const changed = [];
    for (const file of FILES) {
      const produced = path.join(scratch, file);
      if (!existsSync(produced)) continue;
      const target = path.join(root, file);
      if (existsSync(target) && readFileSync(target, "utf8") === readFileSync(produced, "utf8")) continue;
      copyFileSync(produced, target);
      changed.push(file);
    }

    if (changed.length === 0) {
      say("NOCHANGE — every package already resolves to the newest version its range allows");
      return;
    }
    if (changed.includes("pnpm-workspace.yaml")) {
      say("REFUSED — the refresh changed pnpm-workspace.yaml, which means pnpm wanted a minimumReleaseAgeExclude entry; a person decides that, so nothing is opened");
      return;
    }

    const moves = lockMoves(before, readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"));
    for (const m of moves) say(`  ${m.name}  ${m.from} -> ${m.to}`);
    if (moves.length === 0) say("the lockfile changed but no resolved version did (layout or integrity only)");
    if (dryRun) {
      say(`dry run — ${moves.length} package(s) would move; the branch is deleted and no PR is opened`);
      return;
    }

    const title = `chore(deps): weekly dependency refresh — ${moves.length} package${moves.length === 1 ? "" : "s"} move inside their ranges`;
    git("add", ...changed);
    git("commit", "-q", "-m", title);
    git("push", "-q", "origin", branch);
    // GitHub refuses a PR body over 65,536 characters, and the first refresh moved 285 packages in its
    // rehearsal; past the cap the table stops and says how many rows it left out, never a failed PR.
    const rows = moves.map((m) => `| \`${m.name}\` | ${m.from} | ${m.to} |`);
    let table = "";
    for (const [i, row] of rows.entries()) {
      if (table.length + row.length > 50_000) {
        table += `\n| and ${rows.length - i} more | | |`;
        break;
      }
      table += (table ? "\n" : "") + row;
    }
    const body = [
      "The weekly dependency refresh (`scripts/deps-refresh/refresh.mjs`, scheduled on the laptop by `scripts/deps-refresh/install-task.ps1`).",
      "",
      "`lockfile.yml` ran `pnpm update --depth Infinity --no-save` on this branch: every package, transitive ones included, re-resolved to the newest version its declared range allows. `--no-save` leaves every range in `package.json` as written, so exact pins do not move, and the release-age quarantine still applies.",
      "",
      "| Package | Was | Now |",
      "| --- | --- | --- |",
      table || "| (no resolved version changed) | | |",
      "",
      "The PR's `validate` and `checks` are the gate.",
    ].join("\n");
    const bodyFile = path.join(scratch, "body.md");
    writeFileSync(bodyFile, body, "utf8");
    const url = gh("pr", "create", "--base", "main", "--head", branch, "--title", title, "--body-file", bodyFile);
    keepBranch = true;
    say(`opened ${url}`);
  } finally {
    if (!keepBranch) {
      try {
        git("push", "-q", "origin", "--delete", branch);
      } catch {
        say(`could not delete origin/${branch} — delete it by hand`);
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
