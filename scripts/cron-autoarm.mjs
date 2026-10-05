#!/usr/bin/env node
/**
 * Arm a NEWLY-DECLARED cron-job.org job on the deploy that ships it — one job at a time, never a sweep.
 *
 * WHY THIS EXISTS
 * Merging a cron route ships the code and arms nothing: cron-job.org is a third-party scheduler with
 * no representation in this repo, so a route can be live, CI-green and called by nobody until someone
 * runs `scripts/cronjob-sync.mjs --job <key> --apply` by hand. That hand step is the last manual link
 * in shipping a cron, and it has been forgotten before (territory-restamp merged 2026-08-29 and had
 * never run). This closes it: when a push to `main` ADDS an entry to the JOBS map in cronjob-sync.mjs,
 * CI arms exactly that new job.
 *
 * WHY IT STAYS WITHIN cronjob-sync's RULE, and must keep doing so.
 * That script's header is emphatic: the cron-job.org API allows only 100 requests PER DAY, a bulk
 * edit cannot be rolled back, and so it does one job at a time and refuses to sweep every declaration.
 * This runner HONORS that. It never calls a sweep and never patches an existing job. It diffs the one
 * file, finds only the keys that were ADDED on this push, and shells out to the sanctioned
 * `cronjob-sync.mjs --job <key> --apply` once per new key — the exact command a person would run. A
 * job whose SCHEDULE changed, or that someone disabled by hand, is left entirely alone: those stay a
 * deliberate manual decision. New jobs are rare, so this fires seldom and spends a handful of requests.
 *
 * WIRED BY .github/workflows/cron-autoarm.yml, which triggers only on a push to main that touches
 * scripts/cronjob-sync.mjs, and passes CRON_SECRET + CRONJOB_API_KEY from the repo's Actions secrets.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SYNC_SCRIPT = "scripts/cronjob-sync.mjs";

/**
 * The JOBS map entries are the ONLY two-space-indented quoted keys in cronjob-sync.mjs
 * (`  "job-key": {`); every other quoted string in the file sits deeper, inside a job body or the
 * create payload. Pull the keys ADDED by a unified diff, and drop any key that also appears on the
 * removed side — a reorder or a reformat moves a line without declaring a new job.
 *
 * Pure, so the test can exercise every shape (a new key, a removed key, a reorder, an edit inside an
 * existing job, several at once) without a repo or the network.
 */
export function newlyAddedJobKeys(diff) {
  const added = new Set();
  const removed = new Set();
  for (const line of String(diff).split(/\r?\n/)) {
    // A diff body line is the +/- marker then the file line; a JOBS key is `  "key": {`.
    const m = /^([+-]) {2}"([a-z0-9][a-z0-9-]*)":\s*\{/.exec(line);
    if (!m) continue;
    (m[1] === "+" ? added : removed).add(m[2]);
  }
  for (const key of removed) added.delete(key);
  return [...added];
}

function main() {
  // The squash merge is one commit on main, so HEAD^..HEAD is exactly what this push introduced;
  // github.event.before is preferred when the workflow passes a reachable one.
  const base = process.env.AUTOARM_BASE_SHA && process.env.AUTOARM_BASE_SHA.trim();
  let diff = "";
  for (const ref of [base, "HEAD^"].filter(Boolean)) {
    try {
      diff = execFileSync("git", ["diff", ref, "HEAD", "--", SYNC_SCRIPT], { encoding: "utf8" });
      break;
    } catch {
      // base may be unreachable with a shallow fetch; fall through to HEAD^.
    }
  }

  const keys = newlyAddedJobKeys(diff);
  if (keys.length === 0) {
    console.log(`No newly-declared cron jobs in ${SYNC_SCRIPT} on this push; nothing to arm.`);
    return;
  }

  console.log(`Newly-declared cron job(s) to arm: ${keys.join(", ")}`);

  // The arming genuinely needs the API key. If it is absent, FAIL loudly rather than skip — a new job
  // left unarmed is the exact silent gap this workflow exists to close. (With no new jobs, above, a
  // missing key is harmless and the run is green.)
  if (!process.env.CRONJOB_API_KEY || !process.env.CRONJOB_API_KEY.trim()) {
    console.error(
      "::error::CRONJOB_API_KEY is not set on this repository, so the new cron job(s) cannot be armed. " +
        "Add it to the repo's GitHub Actions secrets (same value as Railway), then re-run this workflow.",
    );
    process.exitCode = 1;
    return;
  }

  for (const key of keys) {
    console.log(`\n── arming ${key} ──`);
    // The sanctioned one-at-a-time command. inherit so its own request-count line is visible in the
    // Actions log; a non-zero exit (e.g. a 429, or a stale CRON_SECRET caught by its bearer check)
    // fails the run.
    execFileSync("node", [SYNC_SCRIPT, "--job", key, "--apply"], { stdio: "inherit" });
  }
}

// Run only when invoked directly, so the test can import newlyAddedJobKeys without arming anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
