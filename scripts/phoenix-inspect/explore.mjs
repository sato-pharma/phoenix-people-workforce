#!/usr/bin/env node
/**
 * Phoenix visual explorer — walks a module's real UI on STAGING as authorized personas and writes
 * masked full-page screenshots, accessibility snapshots, measurements and a manifest.
 *
 *   node scripts/phoenix-inspect/explore.mjs --module kpi-reports [options]
 *
 *   --origin <url>         target (default: staging; production is refused)
 *   --personas a,b         persona ids (default: all of the module's)
 *   --states a,b           state ids (default: each persona's matrix)
 *   --viewports a,b        desktop, tablet, mobile (default: each persona's matrix)
 *   --credentials <file>   JSON { "<login>": "<password>" } (default: ~/.phoenix-inspect/staging-personas.json)
 *   --repo <dir>           where the module's source files are read for kept literals (default: cwd)
 *   --out <dir>            run root (default: artifacts/phoenix-inspection)
 *   --plan                 print the run plan and exit; no browser, no sign-in
 *   --run-id <id>          the run folder's name (default: the Cairo time it started)
 *   --max-minutes <n>      stop starting new captures after n minutes (at most 45)
 *   --no-prune             keep every earlier run (default: the newest 5, none older than 14 days)
 *   --source-commit <sha>  the git commit the module's source files were read from (on-spare.ps1 passes
 *                          it; "+dirty" when they differ from it); recorded in the manifest
 *   --min-free-mb <n>      memory guard for a small machine: before each page, when free memory is under
 *                          n MB the browser is closed and the run waits (up to 30 minutes) for n + 350 MB,
 *                          then starts a fresh browser with the same in-memory sessions (no new sign-in)
 *   --relaunch-every <n>   with --min-free-mb: a fresh browser every n pages (default 3), because one
 *                          browser grows with every page it opens (14 Nov 2026: 441 MB after one page,
 *                          621 MB after three, on the owner's 16 GB laptop)
 *   --resume               carry on an earlier run of the same --run-id: its manifest is kept and every
 *                          page it already captured is skipped. The manifest is saved after every page,
 *                          so a run stopped from outside loses at most the page it was on.
 *
 * Read-only toward the app: the browsing contexts send GET and nothing else (lib/fence.mjs); the one
 * request that is not a GET is each persona's sign-in POST, made from a throwaway context. Passwords
 * are read from the credentials file and never printed, logged or written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureOne, launchBrowser, probeDenied, signIn } from "./lib/capture.mjs";
import { STAGING_ORIGIN, classifyRequest } from "./lib/fence.mjs";
import { buildKeepIndex, sourceCandidatesFor } from "./lib/redact.mjs";
import { RUN_BOUNDS, VIEWPORTS, assertTargetOrigin } from "./lib/safety.mjs";
import { KPIS_MODULE, addressFor, statesFor, viewportsFor } from "./modules/kpis.mjs";
import { prune } from "./prune.mjs";

export const MODULES = Object.freeze({ "kpi-reports": KPIS_MODULE });

export function cairoStamp(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Cairo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    id: `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`,
    text: `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} Cairo`,
  };
}

/**
 * The run plan: every (persona, state, viewport) in order, bounded. Pure.
 *
 * With no `states`, each persona walks its own matrix (statesFor). Named `states` may be ANY state of
 * the persona's board (its shell), so a tool call can ask a "landing" persona for one more tab; the
 * denied persona still only gets its landing state, as a denied check. Named `viewports` replace the
 * matrix's.
 */
export function buildPlan(spec, { personas, states, viewports } = {}) {
  const jobs = [];
  const chosen = spec.personas.filter((persona) => !personas || personas.includes(persona.id));
  for (const persona of chosen) {
    const pool =
      states && persona.matrix !== "denied"
        ? spec.states.filter((state) => states.includes(state.id) && state.shells.includes(persona.shell))
        : statesFor(persona).filter((state) => !states || states.includes(state.id));
    for (const state of pool) {
      const sizes = viewports ? viewports.filter((name) => name in VIEWPORTS) : viewportsFor(persona, state);
      for (const viewport of sizes) {
        jobs.push({ persona, state, viewport, address: addressFor(persona, state), denied: persona.matrix === "denied" });
      }
    }
  }
  return { jobs: jobs.slice(0, RUN_BOUNDS.maxPagesPerRun), truncated: Math.max(0, jobs.length - RUN_BOUNDS.maxPagesPerRun) };
}

export function loadSourceIndex(spec, repoRoot) {
  const files = [];
  const missing = [];
  for (const file of spec.sourceFiles) {
    const full = path.join(repoRoot, file);
    if (existsSync(full)) files.push({ file, source: readFileSync(full, "utf8") });
    else missing.push(file);
  }
  const index = buildKeepIndex(files);
  return { index, keepList: [...index.keys()], missing };
}

export async function runExplorer(options) {
  const spec = MODULES[options.module];
  if (!spec) throw new Error(`unknown module ${options.module}`);
  const origin = assertTargetOrigin(options.origin ?? STAGING_ORIGIN, { allowLoopback: options.allowLoopback });
  const plan = buildPlan(spec, options);
  const stamp = cairoStamp();
  const runId = options.runId ?? stamp.id;
  const outDir = path.join(options.out ?? "artifacts/phoenix-inspection", spec.id, runId);
  mkdirSync(outDir, { recursive: true });
  const { index, keepList, missing } = loadSourceIndex(spec, options.repo ?? process.cwd());
  const lookup = (kept) => sourceCandidatesFor(kept, index);

  const credentialsFile = options.credentials ?? path.join(os.homedir(), ".phoenix-inspect", "staging-personas.json");
  const credentials = existsSync(credentialsFile) ? JSON.parse(readFileSync(credentialsFile, "utf8")) : {};

  let revision = null;
  try {
    const health = await fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
    revision = typeof health?.revision === "string" ? health.revision : null;
  } catch {
    revision = null;
  }

  const deadline = Date.now() + (options.maxMinutes ?? RUN_BOUNDS.maxMinutesPerRun) * 60_000;
  const manifest = {
    runId,
    module: spec.id,
    moduleTitle: spec.title,
    origin,
    revision,
    sourceCommit: options.sourceCommit ?? null,
    startedAt: stamp.text,
    finishedAt: null,
    keptLiterals: keepList.length,
    sourceFilesMissing: missing,
    personas: [],
    shots: [],
    denied: [],
    notRun: [],
    totals: {},
  };
  const networkLog = [];
  const manifestFile = path.join(outDir, "manifest.json");
  const networkFile = path.join(outDir, "network.jsonl");
  const jobKey = (personaId, stateId, viewport) => `${personaId}|${stateId}|${viewport}`;
  const done = new Set();
  let n = 0;
  if (options.resume && existsSync(manifestFile)) {
    const earlier = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (earlier.module !== manifest.module || earlier.origin !== manifest.origin) throw new Error("--resume: the earlier run is for another module or origin");
    manifest.startedAt = earlier.startedAt;
    manifest.resumedAt = [...(earlier.resumedAt ?? []), stamp.text];
    manifest.personas = earlier.personas ?? [];
    manifest.shots = (earlier.shots ?? []).filter((shot) => shot.outcome === "captured" || shot.outcome === "deleted-privacy-check-failed");
    manifest.denied = earlier.denied ?? [];
    for (const shot of manifest.shots) done.add(jobKey(shot.persona, shot.state, shot.viewport));
    for (const denied of manifest.denied) done.add(jobKey(denied.persona, denied.state, denied.viewport));
    n = Math.max(0, ...[...manifest.shots, ...manifest.denied].map((item) => Number(String(item.id ?? "").slice(0, 3)) || 0));
    if (existsSync(networkFile)) for (const line of readFileSync(networkFile, "utf8").split("\n").filter(Boolean)) networkLog.push(JSON.parse(line));
  }
  // Saved after every page, so a run stopped from outside (the laptop's memory watchdog) loses at most
  // the page it was on, and --resume carries on from there.
  const save = () => {
    writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(networkFile, networkLog.map((item) => JSON.stringify(item)).join("\n") + "\n");
  };

  // The memory guard (--min-free-mb). os.freemem() is the machine's available physical memory.
  const freeMb = () => Math.round(os.freemem() / 1_048_576);
  const guard = options.minFreeMb ? { pauseBelow: options.minFreeMb, resumeAt: options.minFreeMb + 350, relaunchEvery: options.relaunchEvery ?? 3 } : null;
  manifest.memoryGuard = guard ? { ...guard, pauses: 0, relaunches: 0 } : null;
  // A hard stop from the caller (the MCP door's time limit): close whichever browser is open, so every
  // page operation in flight rejects and the run ends rather than carrying on unseen.
  if (options.signal?.aborted) throw new Error("the run was stopped before it started");
  let browser = await launchBrowser();
  const stopBrowser = () => void browser.close().catch(() => {});
  options.signal?.addEventListener("abort", stopBrowser, { once: true });
  let sinceLaunch = 0;
  const makeRoom = async () => {
    if (!guard) return;
    if (sinceLaunch < guard.relaunchEvery && freeMb() >= guard.pauseBelow) return;
    await browser.close().catch(() => {});
    if (freeMb() < guard.resumeAt) {
      manifest.memoryGuard.pauses += 1;
      process.stdout.write(`  memory guard: ${freeMb()} MB free, waiting for ${guard.resumeAt} MB\n`);
      const until = Date.now() + 30 * 60_000;
      while (freeMb() < guard.resumeAt) {
        if (Date.now() > until) throw new Error(`memory guard: free memory stayed under ${guard.resumeAt} MB for 30 minutes`);
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    }
    browser = await launchBrowser();
    manifest.memoryGuard.relaunches += 1;
    sinceLaunch = 0;
  };
  try {
    const byPersona = new Map();
    for (const job of plan.jobs) byPersona.set(job.persona.id, [...(byPersona.get(job.persona.id) ?? []), job]);
    for (const [personaId, allJobs] of byPersona) {
      const persona = allJobs[0].persona;
      // A page the fence refuses is never opened: its address writes or hands over a file when read
      // (generated/side-effect-routes.json). Refused here, before any browser opens it.
      const jobs = [];
      for (const job of allJobs) {
        if (done.has(jobKey(personaId, job.state.id, job.viewport))) continue;
        const verdict = classifyRequest({ method: "GET", url: new URL(job.address, origin).href }, { origin });
        if (verdict.allow) jobs.push(job);
        else manifest.notRun.push({ persona: personaId, state: job.state.id, viewport: job.viewport, reason: `the fence refuses this address (${verdict.reason}); it is never opened` });
      }
      if (jobs.length === 0) continue;
      const password = credentials[persona.login];
      manifest.personas = manifest.personas.filter((item) => item.id !== personaId);
      if (!password) {
        manifest.personas.push({ id: personaId, role: persona.role, signIn: { ok: false, code: "no-credentials-on-this-machine" } });
        for (const job of jobs) manifest.notRun.push({ persona: personaId, state: job.state.id, viewport: job.viewport, reason: "persona could not sign in: no credentials on this machine" });
        continue;
      }
      await makeRoom();
      const session = await signIn(browser, origin, persona.login, password);
      manifest.personas.push({ id: personaId, role: persona.role, signIn: { ok: session.ok, status: session.status, code: session.code } });
      if (!session.ok) {
        for (const job of jobs) manifest.notRun.push({ persona: personaId, state: job.state.id, viewport: job.viewport, reason: `sign-in refused (${session.status} ${session.code})` });
        continue;
      }
      for (const job of jobs) {
        if (options.signal?.aborted) throw new Error("the run was stopped at its time limit");
        if (Date.now() > deadline) {
          manifest.notRun.push({ persona: personaId, state: job.state.id, viewport: job.viewport, reason: "run time limit reached" });
          continue;
        }
        await makeRoom();
        sinceLaunch += 1;
        n += 1;
        const shotId = `${String(n).padStart(3, "0")}-${personaId}-${job.state.id}-${job.viewport}`;
        if (job.denied) {
          const result = await probeDenied(browser, { origin, persona, address: job.address, keepList, storageState: session.state, outDir, shotId });
          manifest.denied.push({ id: shotId, ...result, state: job.state.id, viewport: job.viewport });
          process.stdout.write(`  ${shotId}: ${result.outcome}\n`);
          save();
          continue;
        }
        const { entry, network } = await captureOne(browser, {
          origin,
          persona,
          state: job.state,
          viewport: job.viewport,
          address: job.address,
          outDir,
          shotId,
          keepList,
          sourceIndexLookup: lookup,
          neverTouch: spec.neverTouch,
          storageState: session.state,
        });
        manifest.shots.push(entry);
        for (const item of network) networkLog.push({ shot: shotId, ...item });
        process.stdout.write(`  ${shotId}: ${entry.outcome}${entry.error ? ` (${entry.error})` : ""} ${entry.ms}ms\n`);
        save();
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", stopBrowser);
    await browser.close().catch(() => {});
  }
  manifest.finishedAt = cairoStamp().text;
  const shots = manifest.shots;
  // On a resumed run, `notRun` lists only this pass's refusals; a job captured in an earlier pass is
  // in `shots`, never in both.
  manifest.notRun = manifest.notRun.filter((item) => !done.has(jobKey(item.persona, item.state, item.viewport)) && !shotsHave(manifest, item));
  manifest.totals = {
    planned: plan.jobs.length,
    truncatedByBounds: plan.truncated,
    captured: shots.filter((shot) => shot.outcome === "captured").length,
    deletedByPrivacyCheck: shots.filter((shot) => shot.outcome === "deleted-privacy-check-failed").length,
    otherOutcomes: shots.filter((shot) => !["captured", "deleted-privacy-check-failed"].includes(shot.outcome)).length,
    deniedChecks: manifest.denied.length,
    notRun: manifest.notRun.length,
    writesStopped: shots.reduce((sum, shot) => sum + shot.writesStopped.length, 0) + manifest.denied.reduce((sum, d) => sum + d.writesStopped.length, 0),
  };
  save();
  if (!options.noPrune) prune(path.dirname(path.dirname(outDir)), { keep: 5, days: 14 });
  return { outDir, manifest };
}

function shotsHave(manifest, item) {
  return manifest.shots.some((shot) => shot.outcome === "captured" && shot.persona === item.persona && shot.state === item.state && shot.viewport === item.viewport);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--module") options.module = next();
    else if (flag === "--origin") options.origin = next();
    else if (flag === "--personas") options.personas = next().split(",");
    else if (flag === "--states") options.states = next().split(",");
    else if (flag === "--viewports") options.viewports = next().split(",");
    else if (flag === "--credentials") options.credentials = next();
    else if (flag === "--repo") options.repo = next();
    else if (flag === "--out") options.out = next();
    else if (flag === "--plan") options.plan = true;
    else if (flag === "--no-prune") options.noPrune = true;
    else if (flag === "--source-commit") {
      options.sourceCommit = next();
      if (!/^[0-9a-f]{7,40}(?:\+dirty)?$/.test(options.sourceCommit)) throw new Error("--source-commit must be a git sha, optionally followed by +dirty");
    }
    else if (flag === "--run-id") {
      options.runId = next();
      if (!/^\d{8}-\d{6}(?:-[a-z0-9]{1,12})?$/.test(options.runId)) throw new Error("--run-id must look like 20261114-210501 or 20261114-210501-mcp");
    } else if (flag === "--max-minutes") {
      options.maxMinutes = Math.min(Number(next()), RUN_BOUNDS.maxMinutesPerRun);
      if (!(options.maxMinutes > 0)) throw new Error("--max-minutes must be a positive number");
    } else if (flag === "--min-free-mb") {
      options.minFreeMb = Number(next());
      if (!(options.minFreeMb >= 500 && options.minFreeMb <= 16_000)) throw new Error("--min-free-mb must be between 500 and 16000");
    } else if (flag === "--relaunch-every") {
      options.relaunchEvery = Number(next());
      if (!(Number.isInteger(options.relaunchEvery) && options.relaunchEvery >= 1 && options.relaunchEvery <= 50)) throw new Error("--relaunch-every must be a whole number from 1 to 50");
    } else if (flag === "--resume") options.resume = true;
    else throw new Error(`unknown option ${flag}`);
  }
  options.module ??= "kpi-reports";
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2));
  if (options.plan) {
    const spec = MODULES[options.module];
    const plan = buildPlan(spec, options);
    console.log(JSON.stringify({ jobs: plan.jobs.map((job) => ({ persona: job.persona.id, state: job.state.id, viewport: job.viewport, address: job.address })), truncated: plan.truncated }, null, 2));
    process.exit(0);
  }
  const { outDir, manifest } = await runExplorer(options);
  console.log(`\nrun ${manifest.runId} -> ${outDir}`);
  console.log(JSON.stringify(manifest.totals));
  for (const persona of manifest.personas) console.log(`  sign-in ${persona.id}: ${persona.signIn.ok ? "ok" : `refused (${persona.signIn.code})`}`);
  process.exit(manifest.totals.deletedByPrivacyCheck > 0 ? 3 : 0);
}
