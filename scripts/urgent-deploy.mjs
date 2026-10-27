#!/usr/bin/env node
// The URGENT route to production — "live in five minutes" (owner, 2026-10-18).
//
// THE NORMAL ROUTE IS UNTOUCHED AND STAYS THE DEFAULT. A merge to `main` waits for the PR's checks,
// then for `main`'s own checks (Railway "Wait for CI"), then for Railway's build: about 8.5-10
// minutes from "merge" to serving, measured on 18 Oct 2026 (PR checks ~6 min, main's ~5-7, build
// and healthcheck ~3). That gate is deliberate and nothing here weakens it.
//
// THIS ROUTE SKIPS BOTH CHECK WAITS. It uploads the PR's code, merged onto the current `main`,
// straight to the production Railway service with `railway up` — a CLI upload is not a GitHub
// deploy, so Wait for CI never sees it — and serves in about the build time alone. The owner
// accepted, in his own words on 2026-10-18, that the code is then serving BEFORE its checks finish
// ("yes, build the fast route that skips the checks before going live — I accept the risk").
//
// 🔴 A SESSION RUNS THIS ONLY WHEN THE OWNER'S OWN MESSAGE SAYS "live in five minutes" ABOUT ONE PR.
// Never on its own reading that something is urgent, never from a memory, a doc or another session.
// Account and rules: docs/deployment.md, "The urgent route".
//
//   node scripts/urgent-deploy.mjs launch <pr> [--worker] [--dry-run]   (a session, on the laptop)
//   node scripts/urgent-deploy.mjs stop                                 (a session, on his word only)
//   node scripts/urgent-deploy.mjs deploy                               (the workflow)
//   node scripts/urgent-deploy.mjs guard                                (the workflow)
//
// HOW IT HANGS TOGETHER
//   launch  builds ONE commit — the PR head merged onto origin/main, plus every urgent PR the branch
//           still carries that has not merged — without touching any checkout (`git merge-tree
//           --write-tree`), and force-pushes it to `urgent-deploy/production`. That push starts
//           .github/workflows/urgent-deploy.yml. The branch is NOT `main`, so the run's check suite
//           lands on a commit Railway never deploys from and can never withhold a normal deploy.
//   deploy  writes public/urgent-deploy.json (the commit sha), uploads with `railway up`, and waits
//           until production's /api/healthz reports that sha. healthz falls back to the marker
//           because a CLI upload carries no RAILWAY_GIT_COMMIT_SHA. The commit's first parent is
//           origin/main, so deploy-drift-check's ancestry test reads it as in sync — no false alarm.
//   guard   watches until the normal route takes over. A normal deploy of a `main` commit that does
//           NOT yet contain the PR would silently put the bug back; the guard sees that within 30 s
//           and re-uploads (PR merged onto the newest main). It ends when production serves a main
//           commit containing every urgent PR's merge, or alarms on Telegram after 50 minutes. It
//           stands down when the branch is deleted or replaced, or a carried PR is closed unmerged.
//   stop    deletes the branch and cancels the running guard — the one way to roll an urgent build
//           back, because a dashboard Redeploy alone reads to the guard as "the fix was lost".

import { spawnSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO } from "./required-check-names.mjs";
import { RAILWAY_CLI_PACKAGE } from "./secret-policy.mjs";

export { REPO };
export const PRODUCTION_URL = "https://phoenix-hr.satopharma.com";
export const RAILWAY_PROJECT_ID = "dc218ad3-99b7-4aff-be38-953a57524a71";
export const RAILWAY_ENVIRONMENT = "production";
export const URGENT_BRANCH = "urgent-deploy/production";
export const DRY_RUN_BRANCH = "urgent-deploy/dry-run";
export const MARKER_PATH = "public/urgent-deploy.json";
export const SERVICES = Object.freeze({
  web: "phoenix-people-workforce",
  worker: "phoenix-workforce-worker",
});
export const GUARD_MINUTES = 50;
export const LIVE_WAIT_MINUTES = 15;
export const MAX_REBUILDS = 3;

// ── Pure helpers (pinned by tests/urgent-deploy.test.ts) ──────────────────────────────────────────

/** Trailers carried on the urgent commit: which PRs it serves and which services it deploys. */
export function formatTrailers({ prs, services }) {
  return [...prs.map((n) => `Urgent-PR: ${n}`), `Urgent-Services: ${services.join(",")}`].join("\n");
}

export function parseTrailers(message) {
  const prs = [];
  let services = ["web"];
  for (const line of String(message).split(/\r?\n/)) {
    const pr = /^Urgent-PR:\s*(\d+)\s*$/.exec(line);
    if (pr) prs.push(Number(pr[1]));
    const sv = /^Urgent-Services:\s*([a-z,]+)\s*$/.exec(line);
    if (sv) services = sv[1].split(",").filter((s) => s in SERVICES);
  }
  return { prs: [...new Set(prs)], services: services.length ? services : ["web"] };
}

/**
 * What production is serving, relative to the urgent build.
 *   unknown         no revision could be read (a blip, or the edge between deploys)
 *   urgent-serving  the urgent build itself
 *   handed-over     a build containing EVERY urgent PR's merge commit — the normal route has it
 *   regressed       anything else: a build that lacks the fix
 * `contains(ancestor, descendant)` is git ancestry; it must answer false for an unknown commit.
 */
export function classifyLive({ live, urgentSha, prs, contains }) {
  if (!live) return "unknown";
  // Handed over is asked FIRST: once every PR has merged, the guard may upload main's own tip, and
  // that build is both the one it uploaded and a main commit carrying every merge — it must end the
  // watch, never read as "still urgent" for the rest of the 50 minutes.
  if (prs.length > 0 && prs.every((p) => p.mergeSha && contains(p.mergeSha, live))) return "handed-over";
  if (live === urgentSha) return "urgent-serving";
  return "regressed";
}

/**
 * Where the urgent branch stands against the commit this guard put there.
 *   ours      still that commit
 *   gone      deleted — `stop` ran, or the run that handed over removed it
 *   replaced  another commit — a newer launch owns it
 *   unknown   the branch could not be read (`remote` is null); never a reason to stand down
 */
export function branchVerdict({ remote, expected }) {
  if (remote == null) return "unknown";
  if (remote === "") return "gone";
  return remote === expected ? "ours" : "replaced";
}

// ── Process helpers ───────────────────────────────────────────────────────────────────────────────

function run(cmd, args, { allowFail = false, input, env } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    input,
    env: env ?? process.env,
    shell: process.platform === "win32" && cmd === "npx",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFail && res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${res.status}): ${(res.stderr || res.stdout || "").trim()}`);
  }
  return res;
}

const git = (args, opts) => run("git", args, opts);
const gitOut = (args) => git(args).stdout.trim();

function ghJson(path) {
  return JSON.parse(run("gh", ["api", path]).stdout);
}

function prInfo(number) {
  const p = ghJson(`repos/${REPO}/pulls/${number}`);
  return {
    number,
    title: p.title,
    state: p.state,
    merged: Boolean(p.merged),
    mergeSha: p.merged ? p.merge_commit_sha : null,
  };
}

/** The urgent branch's sha on origin: "" when it does not exist, null when it could not be read. */
function remoteBranchSha() {
  const res = git(["ls-remote", "--exit-code", "origin", `refs/heads/${URGENT_BRANCH}`], { allowFail: true });
  if (res.status === 2) return "";
  if (res.status !== 0) return null;
  return res.stdout.trim().split(/\s+/)[0] ?? "";
}

function isAncestor(ancestor, descendant) {
  return git(["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true }).status === 0;
}

async function fetchLiveRevision() {
  try {
    const res = await fetch(`${PRODUCTION_URL}/api/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.revision === "string" && body.revision ? body.revision : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = (ms) => `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ALERT_CHAT_ID;
  console.log(`[urgent-deploy] ${text}`);
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.log(`::warning::Telegram message not delivered: ${error.message}`);
  }
}

// ── Building the urgent commit ────────────────────────────────────────────────────────────────────

/**
 * The PR heads still open, merged in order onto the newest origin/main. Returns null when every PR
 * is already merged (main has them all). Throws on a conflict — an urgent fix that does not merge
 * cleanly onto main is not deployable unchecked, and resolving it is the session's job.
 */
export function buildUrgentCommit({ prs, services }) {
  git(["fetch", "--quiet", "origin", "main"]);
  const infos = prs.map(prInfo);
  for (const info of infos) {
    if (!info.merged && info.state !== "open") {
      throw new Error(`PR #${info.number} is closed without being merged — refusing to deploy it.`);
    }
  }
  const open = infos.filter((i) => !i.merged);
  if (open.length === 0) return null;

  let tip = gitOut(["rev-parse", "origin/main"]);
  open.forEach((info, index) => {
    git(["fetch", "--quiet", "origin", `+pull/${info.number}/head:refs/urgent/pr-${info.number}`]);
    const head = gitOut(["rev-parse", `refs/urgent/pr-${info.number}`]);
    const merge = git(["merge-tree", "--write-tree", "--name-only", tip, head], { allowFail: true });
    if (merge.status !== 0) {
      throw new Error(
        `PR #${info.number} does not merge cleanly onto main — resolve the conflict on its branch first.\n${merge.stdout}`,
      );
    }
    const tree = merge.stdout.split("\n")[0].trim();
    const last = index === open.length - 1;
    const message = last
      ? `urgent deploy: ${open.map((i) => `#${i.number}`).join(", ")} on top of main\n\n${formatTrailers({
          prs: open.map((i) => i.number),
          services,
        })}\n`
      : `urgent deploy: #${info.number} on top of main\n`;
    tip = git(["commit-tree", tree, "-p", tip, "-p", head, "-F", "-"], { input: message }).stdout.trim();
  });
  return { sha: tip, prs: open };
}

// ── Railway ──────────────────────────────────────────────────────────────────────────────────────

// The repo's one Railway secret may be an ACCOUNT or a PROJECT token, and the CLI reads them from
// different variables; scripts/sync-railway-production-secrets.mjs explains the failure that reads
// like expiry. Try the account name first, then the project name, and remember the one that works.
let workingTokenVar = null;
function railwayEnv(varName) {
  const token = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN || "";
  return {
    ...process.env,
    RAILWAY_API_TOKEN: varName === "RAILWAY_API_TOKEN" ? token : "",
    RAILWAY_TOKEN: varName === "RAILWAY_TOKEN" ? token : "",
  };
}

function railwayArgs(args, service) {
  return ["--yes", RAILWAY_CLI_PACKAGE, ...args, "--service", service, "--environment", RAILWAY_ENVIRONMENT, "--project", RAILWAY_PROJECT_ID];
}

function railwayStreaming(args, service) {
  const order = workingTokenVar ? [workingTokenVar] : ["RAILWAY_API_TOKEN", "RAILWAY_TOKEN"];
  return (async () => {
    let last = { code: 1, output: "" };
    for (const varName of order) {
      last = await new Promise((resolvePromise) => {
        let output = "";
        const child = spawn("npx", railwayArgs(args, service), {
          env: railwayEnv(varName),
          shell: process.platform === "win32",
        });
        child.stdout.on("data", (d) => { output += d; process.stdout.write(d); });
        child.stderr.on("data", (d) => { output += d; process.stderr.write(d); });
        child.on("close", (code) => resolvePromise({ code, output }));
      });
      if (last.code === 0) {
        workingTokenVar = varName;
        return last;
      }
      if (!/Unauthorized|Invalid RAILWAY/i.test(last.output)) return last;
    }
    return last;
  })();
}

async function waitForLive(sha, label) {
  const started = Date.now();
  while (Date.now() - started < LIVE_WAIT_MINUTES * 60_000) {
    const live = await fetchLiveRevision();
    if (live === sha) return Date.now() - started;
    await sleep(10_000);
  }
  throw new Error(`${label}: production did not report ${sha.slice(0, 9)} within ${LIVE_WAIT_MINUTES} minutes.`);
}

/** Write the marker, upload, and wait until production serves `sha`. */
async function uploadAndWait({ sha, prs, services, dryRun }) {
  writeFileSync(
    resolve(MARKER_PATH),
    `${JSON.stringify({ revision: sha, prs, builtAt: new Date().toISOString() }, null, 2)}\n`,
  );
  if (dryRun) {
    const probe = await railwayStreaming(["deployment", "list", "--limit", "1", "--json"], SERVICES.web);
    if (probe.code !== 0) throw new Error("Dry run: the Railway credential could not read the production service.");
    console.log(`[urgent-deploy] DRY RUN — built ${sha.slice(0, 9)} for ${prs.map((n) => `#${n}`).join(", ")}; credential works; nothing uploaded.`);
    return 0;
  }
  // The worker first and detached, so the web build — the one employees wait on — is not queued
  // behind it. The worker has no URL to prove; its deploy shows in Railway.
  if (services.includes("worker")) {
    const worker = await railwayStreaming(["up", "--detach"], SERVICES.worker);
    if (worker.code !== 0) throw new Error("railway up for the worker service failed.");
  }
  const web = await railwayStreaming(["up", "--ci"], SERVICES.web);
  if (web.code !== 0) throw new Error("railway up for the web service failed — read the build log above.");
  return waitForLive(sha, "web");
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

async function launch(argv) {
  const known = new Set(["--worker", "--dry-run"]);
  const unknown = argv.filter((a) => a.startsWith("--") && !known.has(a));
  if (unknown.length) throw new Error(`Unknown option(s): ${unknown.join(" ")}`);
  const pr = Number(argv.find((a) => /^\d+$/.test(a)));
  if (!pr) throw new Error("Usage: node scripts/urgent-deploy.mjs launch <pr> [--worker] [--dry-run]");
  const dryRun = argv.includes("--dry-run");
  const services = argv.includes("--worker") ? ["web", "worker"] : ["web"];

  // Carry every earlier urgent PR still open on the urgent branch — otherwise this upload would remove
  // that fix, and its guard (cancelled by this push) would not put it back. Read from the BRANCH, never
  // only when healthz names it: a healthz timeout, or a guard caught mid-recovery, used to drop the
  // earlier fix with nothing watching. A merged PR is main's now and a closed one was abandoned, so
  // only open ones ride along; `stop` deletes the branch, so a fix rolled back on purpose never does.
  const prs = [pr];
  if (!dryRun) {
    const remote = remoteBranchSha();
    if (remote == null) throw new Error(`Could not read ${URGENT_BRANCH} — refusing to launch without knowing what it carries.`);
    if (remote) {
      git(["fetch", "--quiet", "origin", URGENT_BRANCH]);
      const carried = parseTrailers(gitOut(["log", "-1", "--format=%B", remote]));
      for (const n of carried.prs) {
        if (prs.includes(n)) continue;
        const info = prInfo(n);
        if (info.merged || info.state !== "open") continue;
        prs.push(n);
        console.log(`[urgent-deploy] carrying the earlier urgent PR #${n} ${info.title} — it has not merged yet.`);
      }
      for (const s of carried.services) if (!services.includes(s)) services.push(s);
    }
  }

  const built = buildUrgentCommit({ prs, services });
  if (!built) {
    console.log(`[urgent-deploy] PR #${pr} is already merged — the normal route is carrying it. Nothing to upload.`);
    return;
  }
  const branch = dryRun ? DRY_RUN_BRANCH : URGENT_BRANCH;
  git(["push", "--force", "origin", `${built.sha}:refs/heads/${branch}`]);
  console.log(
    `[urgent-deploy] pushed ${built.sha.slice(0, 9)} (${built.prs.map((i) => `#${i.number} ${i.title}`).join("; ")}) to ${branch}.`,
  );
  console.log(`[urgent-deploy] follow it: gh run list -R ${REPO} --workflow urgent-deploy.yml --branch ${branch} -L 1`);
}

async function deploy() {
  const sha = gitOut(["rev-parse", "HEAD"]);
  const { prs, services } = parseTrailers(gitOut(["log", "-1", "--format=%B", "HEAD"]));
  if (prs.length === 0) throw new Error("This commit carries no Urgent-PR trailer — it was not built by launch.");
  const dryRun = process.env.GITHUB_REF_NAME === DRY_RUN_BRANCH;
  const started = Date.now();
  await uploadAndWait({ sha, prs, services, dryRun });
  if (!dryRun) {
    // The fix is live from here on: a title lookup that fails must not fail this step, or the guard
    // step after it is skipped and the owner is told the deploy failed while it serves unguarded.
    const titles = prs
      .map((n) => {
        try {
          return `#${n} ${prInfo(n).title}`;
        } catch {
          return `#${n}`;
        }
      })
      .join("\n");
    await notify(`URGENT DEPLOY LIVE in ${minutes(Date.now() - started)}\n${titles}\n\nIts checks are still running on the PR. The PR must still merge the normal way; until then the guard keeps the fix live.`);
  }
}

async function guard() {
  let urgentSha = gitOut(["rev-parse", "HEAD"]);
  // What the urgent BRANCH points at — moves only when this guard pushes, unlike urgentSha, which also
  // becomes main's tip when every PR has merged and the guard serves main itself.
  let branchSha = urgentSha;
  const { prs, services } = parseTrailers(gitOut(["log", "-1", "--format=%B", "HEAD"]));
  const deadline = Date.now() + GUARD_MINUTES * 60_000;
  let rebuilds = 0;
  let lastState = "";
  while (Date.now() < deadline) {
    // `stop` deletes the branch (and cancels this run); a newer launch replaces it. Either way the fix
    // is no longer this guard's to keep — above all when the owner is rolling a bad urgent build back,
    // which this loop would otherwise read as "regressed" and undo by uploading the bad build again.
    const branch = branchVerdict({ remote: remoteBranchSha(), expected: branchSha });
    if (branch === "gone" || branch === "replaced") {
      await notify(
        `URGENT DEPLOY: the guard stood down — ${branch === "gone" ? "the urgent branch was removed (stop)" : "a newer urgent launch took over"}. It will not re-upload PRs ${prs.map((n) => `#${n}`).join(", ")}.`,
      );
      return;
    }
    const live = await fetchLiveRevision();
    const infos = prs.map(prInfo);
    const abandoned = infos.filter((i) => !i.merged && i.state !== "open");
    if (abandoned.length > 0) {
      await notify(
        `URGENT DEPLOY: ${abandoned.map((i) => `#${i.number}`).join(", ")} was closed without merging, so the guard stood down. Whatever production serves now stays until the next normal deploy.`,
      );
      return;
    }
    if (live && live !== urgentSha) {
      git(["fetch", "--quiet", "origin", "main"], { allowFail: true });
      git(["fetch", "--quiet", "origin", live], { allowFail: true });
    }
    const state = classifyLive({ live, urgentSha, prs: infos, contains: isAncestor });
    if (state !== lastState) console.log(`[urgent-deploy] production: ${state} (${live ? live.slice(0, 9) : "no revision"})`);
    lastState = state;

    if (state === "handed-over") {
      // Delete the branch only if it still points at this run's commit; a newer launch owns it otherwise.
      git(["push", `--force-with-lease=${URGENT_BRANCH}:${branchSha}`, "origin", `:refs/heads/${URGENT_BRANCH}`], { allowFail: true });
      console.log("[urgent-deploy] the normal route now serves every urgent PR. Guard finished.");
      return;
    }

    if (state === "regressed") {
      if (rebuilds >= MAX_REBUILDS) {
        await notify(`URGENT DEPLOY: production lost the fix ${MAX_REBUILDS + 1} times; guard stopped re-uploading. PRs ${prs.map((n) => `#${n}`).join(", ")}. ${process.env.RUN_URL ?? ""}`);
        process.exit(1);
      }
      rebuilds += 1;
      await notify(`URGENT DEPLOY: a normal deploy without the fix went live (${live.slice(0, 9)}). Re-uploading the fix on top of the newest main now.`);
      const built = buildUrgentCommit({ prs, services });
      // Every PR merged: main has the fix and its own deploy is on the way; serve main's tip now.
      const next = built ? built.sha : gitOut(["rev-parse", "origin/main"]);
      if (built) {
        const pushed = git(
          ["push", `--force-with-lease=${URGENT_BRANCH}:${branchSha}`, "origin", `${next}:refs/heads/${URGENT_BRANCH}`],
          { allowFail: true },
        );
        if (pushed.status !== 0) {
          // A refused lease means someone else moved the branch; anything else is a real failure (a
          // GitHub error, a token that may not push a workflow file) and the fix is OFF production.
          const after = branchVerdict({ remote: remoteBranchSha(), expected: branchSha });
          if (after === "gone" || after === "replaced") {
            console.log("[urgent-deploy] the urgent branch moved under the guard (a newer launch, or stop) — it stands down.");
            return;
          }
          await notify(
            `URGENT DEPLOY: production lost the fix and the guard could not push the rebuilt commit, so it is NOT back. PRs ${prs.map((n) => `#${n}`).join(", ")}. ${(pushed.stderr || "").trim().slice(0, 300)} ${process.env.RUN_URL ?? ""}`,
          );
          process.exit(1);
        }
        branchSha = next;
      }
      git(["checkout", "--quiet", "--detach", next]);
      await uploadAndWait({ sha: next, prs, services, dryRun: false });
      urgentSha = next;
      continue;
    }
    await sleep(30_000);
  }
  const open = prs.map(prInfo).filter((i) => !i.merged);
  await notify(
    `URGENT DEPLOY: ${GUARD_MINUTES} minutes and ${open.map((i) => `#${i.number}`).join(", ") || "the PR"} has still not reached production the normal way. The fix is live from the urgent build, but the NEXT normal deploy will remove it unless the PR merges first. ${process.env.RUN_URL ?? ""}`,
  );
  process.exit(1);
}

/**
 * Stand the urgent route down, on the owner's word only. Deletes the branch — a guard still watching
 * reads "gone" and stops, and the next launch carries nothing from it — then cancels every run still
 * uploading or guarding. Production keeps serving what it serves now: rolling a bad urgent build back
 * is the Railway dashboard's Redeploy, done AFTER this, or the guard re-uploads it within 30 seconds.
 */
async function stop() {
  const remote = remoteBranchSha();
  if (remote == null) throw new Error(`Could not read ${URGENT_BRANCH} — nothing was stopped; run stop again.`);
  if (remote) {
    git(["push", `--force-with-lease=${URGENT_BRANCH}:${remote}`, "origin", `:refs/heads/${URGENT_BRANCH}`]);
    console.log(`[urgent-deploy] deleted ${URGENT_BRANCH} (it pointed at ${remote.slice(0, 9)}).`);
  } else {
    console.log(`[urgent-deploy] ${URGENT_BRANCH} does not exist — no urgent build is carried.`);
  }
  const runs = JSON.parse(
    run("gh", [
      "run", "list", "-R", REPO, "--workflow", "urgent-deploy.yml", "--branch", URGENT_BRANCH,
      "-L", "20", "--json", "databaseId,status",
    ]).stdout,
  );
  const live = runs.filter((r) => r.status !== "completed");
  for (const r of live) {
    run("gh", ["run", "cancel", String(r.databaseId), "-R", REPO]);
    console.log(`[urgent-deploy] cancelled urgent run ${r.databaseId} (${r.status}).`);
  }
  if (live.length === 0) console.log("[urgent-deploy] no urgent run was still going.");
  console.log("[urgent-deploy] stopped. Production serves what it served a moment ago; a Redeploy from the Railway dashboard is now safe.");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "launch") return launch(rest);
  if (rest.length) throw new Error(`${command} takes no arguments.`);
  if (command === "deploy") return deploy();
  if (command === "guard") return guard();
  if (command === "stop") return stop();
  throw new Error("Usage: node scripts/urgent-deploy.mjs launch <pr> [--worker] [--dry-run] | stop | deploy | guard");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[urgent-deploy] ${error.message}`);
    process.exit(1);
  });
}
