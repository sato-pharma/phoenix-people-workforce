// scripts/post-deploy-errors.mjs: after a merge reaches production, did it bring a NEW error?
//
// Usage:
//   node scripts/post-deploy-errors.mjs <pr>            one reading
//   node scripts/post-deploy-errors.mjs <pr> --wait     re-read every 90 s until the window is covered or a new
//                                                       error shows (run it with run_in_background: true)
//   --window <minutes>   how long the merge must have served before CLEAN can be said (default 15)
//   --sha <merge sha>    instead of a PR number
//   --json               the whole reading, machine-readable
//
// Exit: 0 clean · 1 new errors · 2 too early (NOT a pass) · 3 not live · 4 not merged · 5 cannot tell.
//
// READ-ONLY EVERYWHERE: GitHub (the PR, the compare, the production deployments), the production health probe,
// the production app_error_events table (service role, from .env.local), and Sentry when SENTRY_READ_TOKEN is
// set. It writes nothing anywhere. The ship skill runs it after verify-shipped.mjs answers SHIPPED
// (.claude/skills/ship/SKILL.md, phase 7b). The decisions live in scripts/lib/post-deploy-errors.mjs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";
import {
  BASELINE_DAYS,
  DEFAULT_WINDOW_MINUTES,
  EXIT,
  classifyErrors,
  errorRowFilters,
  goLiveFrom,
  postDeployVerdict,
  readErrorRows,
  readSentryIssues,
} from "./lib/post-deploy-errors.mjs";

refuseUnknownFlags({
  name: "post-deploy-errors",
  entry: import.meta.url,
  known: ["--wait", "--window", "--sha", "--json"],
  hints: [
    "one reading:        node scripts/post-deploy-errors.mjs <pr>",
    "watch the window:   node scripts/post-deploy-errors.mjs <pr> --wait   (in the background)",
  ],
});

const REPO = "Gawish-1997/phoenix-people-workforce";
const HEALTHZ = "https://phoenix-hr.satopharma.com/api/healthz";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLL_MS = 90_000;
const WAIT_SLACK_MINUTES = 30;

const argv = process.argv.slice(2);
const flagValue = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
};
const asJson = argv.includes("--json");
const wait = argv.includes("--wait");
const windowMinutes = Number(flagValue("--window") ?? DEFAULT_WINDOW_MINUTES);
const shaArg = flagValue("--sha");
const prArg = argv.find((a, i) => /^\d+$/.test(a) && argv[i - 1] !== "--window");

if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || (!prArg && !shaArg)) {
  console.error("usage: node scripts/post-deploy-errors.mjs <pr> [--wait] [--window <minutes>] [--json]   (or --sha <merge sha>)");
  process.exit(EXIT.CANNOT_TELL);
}

// Loaded by hand rather than via a dependency, as backfill-cvs-to-drive.mjs does: this runs from a bare worktree,
// where `pnpm exec` is banned. A variable already set in the environment wins.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(ROOT, ".env.local"));

// The repo's own noise rules, never a copy of them (browser-noise.ts imports through the `@/` alias, so the test
// suite's alias loader is registered first; it resolves from the working directory, hence the chdir). If they
// cannot load, every row is judged, which only makes the report noisier: the browser's network wording is in
// every week's baseline, so it reads as recurring, never as new.
const TS_AS_MODULE = `export async function load(url, context, nextLoad) {
  if (!context.format && /\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, { ...context, format: "module-typescript" });
  return nextLoad(url, context);
}`;

async function loadClassifiers() {
  try {
    process.chdir(ROOT);
    register(pathToFileURL(path.join(ROOT, "tests/alias-loader.mjs")).href);
    // Registered last, so it runs first: a .ts file is loaded as TypeScript ESM outright, instead of Node guessing
    // and printing a "reparsing as ES module" warning on every run (the repo's package.json declares no type).
    register(`data:text/javascript,${encodeURIComponent(TS_AS_MODULE)}`);
    const noise = await import(pathToFileURL(path.join(ROOT, "src/lib/error-monitor/browser-noise.ts")).href);
    const refusal = await import(pathToFileURL(path.join(ROOT, "src/lib/error-monitor/expected-refusal.ts")).href);
    return { classifiers: { isBrowserNoiseMessage: noise.isBrowserNoiseMessage, isModuleLockRefusal: refusal.isModuleLockRefusal }, note: null };
  } catch (error) {
    return { classifiers: null, note: `the noise rules did not load (${error instanceof Error ? error.message : String(error)}); every row was judged` };
  }
}

function gh(args) {
  try {
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

const cairo = (iso) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)) + " Cairo"
    : "unknown";
const short = (sha) => String(sha ?? "").slice(0, 9);

async function readOnce(classifierLoad) {
  const out = { pr: prArg ? Number(prArg) : null, windowMinutes, readAt: new Date().toISOString(), notes: [] };
  if (classifierLoad.note) out.notes.push(classifierLoad.note);

  // 1 · the merge
  if (shaArg) {
    // Always the FULL sha. Releases on error rows and Sentry events are stamped with all 40
    // characters, so a short `--sha` matched none of them: the merge's own errors fell into the
    // baseline and the verdict read CLEAN (code review, 19 Oct 2026).
    const commit = gh(["api", `repos/${REPO}/commits/${shaArg}`]);
    if (!commit?.sha) return { ...out, verdict: { code: EXIT.CANNOT_TELL, label: "CANNOT TELL", note: `GitHub could not resolve --sha ${shaArg} to a commit` } };
    out.mergeSha = commit.sha;
  } else {
    const view = gh(["pr", "view", prArg, "--repo", REPO, "--json", "number,title,state,mergedAt,mergeCommit"]);
    if (!view) return { ...out, verdict: { code: EXIT.CANNOT_TELL, label: "CANNOT TELL", note: "gh could not read the PR" } };
    out.title = view.title;
    out.mergedAt = view.mergedAt;
    out.mergeSha = view.mergeCommit?.oid ?? null;
    if (view.state !== "MERGED" || !out.mergeSha) return { ...out, verdict: postDeployVerdict({ merged: false }) };
  }

  // 2 · what production serves, and whether it carries the merge
  try {
    const res = await fetch(HEALTHZ, { signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
    out.liveRevision = (await res.json())?.revision ?? null;
  } catch {
    out.liveRevision = null;
  }
  if (!out.liveRevision) return { ...out, verdict: { code: EXIT.CANNOT_TELL, label: "CANNOT TELL", note: "the production health probe gave no revision" } };
  let releases = [out.mergeSha];
  if (out.liveRevision !== out.mergeSha) {
    const compare = gh(["api", `repos/${REPO}/compare/${out.mergeSha}...${out.liveRevision}`]);
    if (!compare) return { ...out, verdict: { code: EXIT.CANNOT_TELL, label: "CANNOT TELL", note: "GitHub could not compare the merge with the live revision" } };
    if (compare.status !== "ahead" && compare.status !== "identical") return { ...out, verdict: postDeployVerdict({ live: false }) };
    releases = [out.mergeSha, ...(compare.commits ?? []).map((c) => c.sha)];
  }
  out.releases = [...new Set(releases)];

  // 3 · since when the merge has served: the first production `success` of any release that carries it
  const deployments = [];
  for (const sha of out.releases) {
    for (const d of gh(["api", `repos/${REPO}/deployments?sha=${sha}&per_page=10`]) ?? []) {
      deployments.push({ environment: d.environment, statuses: gh(["api", `repos/${REPO}/deployments/${d.id}/statuses`]) ?? [] });
    }
  }
  out.liveSince = goLiveFrom(deployments);
  out.liveMinutes = out.liveSince ? Math.max(0, Math.floor((Date.now() - Date.parse(out.liveSince)) / 60_000)) : null;

  // 4 · the app's own error table
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let appRead = false;
  if (!supabaseUrl || !serviceKey) {
    out.notes.push("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set, so the error table was not read");
  } else {
    try {
      const baselineSince = new Date(Date.now() - BASELINE_DAYS * 86_400_000).toISOString();
      const filters = errorRowFilters({ releases: out.releases, baselineSince });
      const examined = await readErrorRows({ supabaseUrl, serviceKey, filters: filters.examined });
      const baseline = await readErrorRows({ supabaseUrl, serviceKey, filters: filters.baseline });
      out.app = { rows: examined.length, baselineRows: baseline.length, ...classifyErrors({ examined, baseline, classifiers: classifierLoad.classifiers }) };
      appRead = true;
    } catch (error) {
      out.notes.push(`the error table read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 5 · Sentry, when a token that can read it exists
  out.sentry = await readSentryIssues({ token: process.env.SENTRY_READ_TOKEN, releases: out.releases });

  out.verdict = postDeployVerdict({ appRead, fresh: out.app?.fresh ?? [], sentry: out.sentry, liveMinutes: out.liveMinutes, windowMinutes });
  return out;
}

function render(out) {
  const L = [];
  L.push(`post-deploy errors: ${out.pr ? `PR ${out.pr}` : "merge"}${out.title ? ` "${out.title}"` : ""}${out.mergeSha ? ` · merge ${short(out.mergeSha)}` : ""}`);
  if (out.liveRevision) L.push(`  serving        ${short(out.liveRevision)}${out.releases ? `, carries the merge · live since ${cairo(out.liveSince)}${out.liveMinutes !== null && out.liveMinutes !== undefined ? `, ${out.liveMinutes} min` : ""}` : ""}`);
  if (out.releases) L.push(`  releases read  ${out.releases.map(short).join(", ")}`);
  if (out.app) {
    const recurringRows = out.app.recurring.reduce((n, g) => n + g.count, 0);
    L.push(`  error table    ${out.app.rows} rows in these releases: ${out.app.fresh.length} new, ${out.app.recurring.length} recurring (${recurringRows} rows), ${out.app.noise} noise · baseline ${out.app.baselineRows} rows over ${BASELINE_DAYS} days`);
    for (const g of out.app.fresh) {
      L.push(`  NEW  ${g.source} · ${g.message}  (in ${g.releases.map(short).join(", ") || "no release"})`);
      L.push(`       ${g.count}× · first ${cairo(g.firstAt)} · last ${cairo(g.lastAt)}${g.modules.length ? ` · ${g.modules.join(", ")}` : ""}${g.routes.length ? ` · ${g.routes.slice(0, 5).join(", ")}` : ""}`);
    }
    for (const g of out.app.recurring.slice(0, 5)) L.push(`  recurring  ${g.count}× ${g.source} · ${g.message}`);
  }
  if (out.sentry) {
    if (!out.sentry.read) L.push(`  Sentry         not read: ${out.sentry.reason}`);
    else {
      L.push(`  Sentry         ${out.sentry.fresh.length + out.sentry.recurring.length} issue(s) in these releases: ${out.sentry.fresh.length} new, ${out.sentry.recurring.length} recurring${out.sentry.capped ? " (the first 100 by events)" : ""}`);
      for (const i of out.sentry.fresh) L.push(`  SENTRY NEW  ${i.shortId} · ${i.title} · ${i.count} events, ${i.users} users · first ${cairo(i.firstSeen)}${i.link ? ` · ${i.link}` : ""}`);
      for (const i of out.sentry.recurring.slice(0, 5)) L.push(`  recurring  ${i.count}× Sentry ${i.shortId} · ${i.title}`);
    }
  }
  for (const note of out.notes) L.push(`  note           ${note}`);
  L.push(`VERDICT: ${out.verdict.label} (${out.verdict.code}): ${out.verdict.note}`);
  return L.join("\n");
}

const classifierLoad = await loadClassifiers();
const startedAt = Date.now();
let reading = await readOnce(classifierLoad);
if (wait) {
  const capMs = (windowMinutes + WAIT_SLACK_MINUTES) * 60_000;
  const settled = (r) => [EXIT.CLEAN, EXIT.NEW, EXIT.NOT_MERGED].includes(r.verdict.code);
  while (!settled(reading) && Date.now() - startedAt < capMs) {
    console.error(`post-deploy-errors: ${reading.verdict.label}, reading again in ${POLL_MS / 1000} s (${reading.verdict.note})`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    reading = await readOnce(classifierLoad);
  }
  if (!settled(reading)) reading.notes.push(`gave up waiting after ${Math.round((Date.now() - startedAt) / 60_000)} minutes: this last reading is NOT a pass`);
}
console.log(asJson ? JSON.stringify(reading, null, 2) : render(reading));
process.exit(reading.verdict.code);
