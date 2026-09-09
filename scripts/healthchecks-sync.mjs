#!/usr/bin/env node
/**
 * Push the Healthchecks.io check schedules that `docs/observability.md` declares.
 *
 * WHY THIS EXISTS
 * A check auto-provisions on its first successful ping (`?create=1`) with Healthchecks' DEFAULTS:
 * a 1-day period and a 1-hour grace. Nothing ever corrects that. So a job that really runs weekly,
 * or at 02:17 Cairo, sits permanently red against a schedule nobody set — and a dashboard that is
 * always red is a dashboard everyone learns to ignore, which is the exact failure this whole
 * observability layer exists to prevent. Tuning every check by hand in a web UI is how that
 * correction keeps not happening.
 *
 * The table in docs/observability.md is the source of truth. This script reads it and makes
 * Healthchecks match. It is idempotent: run it as often as you like.
 *
 *   node scripts/healthchecks-sync.mjs            # dry run - print the diff, change nothing
 *   node scripts/healthchecks-sync.mjs --apply    # push the differences
 *
 * NEEDS `HEALTHCHECKS_API_KEY` - a Healthchecks *project API key* (Settings > API keys, full
 * access), sent as `X-Api-Key`. This is NOT `HEALTHCHECKS_PING_KEY`: a ping key can create a check
 * but cannot set its schedule, timezone or grace. Both live in the same project; they are different
 * credentials. The key is read from the environment or from .env.local, and is never printed.
 *
 * TIMEZONE. Every schedule in that table is Africa/Cairo local, because cron-job.org - which fires
 * almost all of them - is configured in Africa/Cairo. Leaving a check on UTC puts its expected-ping
 * window two to three hours off the real one, and shifts it again at every Egyptian DST change.
 *
 * CHANNELS. Every check declared here is also made to carry every notification channel configured
 * in the Healthchecks project (Settings > Integrations) - there is no per-check channel column in
 * the doc table, and no reason for one: this is a single-owner project and a check that alerts
 * nobody is the exact failure the rest of this script exists to prevent. Found 2026-08-27 - two
 * checks (`phoenix-db-health-snapshot`, `phoenix-direct-orders-probation`) had sat with zero
 * channels attached, silently, since whenever they were created; a broken job on either would have
 * gone red on the dashboard forever with no alert reaching anyone. If the project ever has zero
 * channels configured, channel enforcement is skipped entirely rather than writing an empty list -
 * see readChannels below.
 *
 * IN-HOUSE ONLY. A row whose last column carries `in-house only` is declared for the in-house
 * register (src/lib/observability/job-schedule.ts + public.job_heartbeats) and is deliberately NOT
 * pushed here. The Healthchecks project is at its check limit: creating one more answers HTTP 403
 * with an empty body, and the owner has ruled out raising the plan (2026-09-08). Without this
 * marker every future run of this script reports two permanent CREATE ... FAILED lines for jobs
 * that are working exactly as intended - which is the same "always red, so ignored" failure the WHY
 * THIS EXISTS note above describes, reintroduced by the tool meant to prevent it.
 *
 * The marker withholds the PUSH, never the WATCH. Both jobs stay declared in JOB_SCHEDULES, so the
 * heartbeat sweep still alerts in-app + Telegram + push when one stops reporting, and the sweep
 * itself is externally watched by `phoenix-job-heartbeat-sweep`. What is given up is only the
 * outside observer for that one job - already covered for "is Phoenix alive?" by the three
 * minute-level checks, which is why the two daily/monthly jobs are the right ones to leave off.
 *
 * TO GIVE ONE ITS SLOT BACK: free a check in the Healthchecks project (or raise the plan), drop the
 * marker from its row, and re-run with --apply.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(REPO_ROOT, "docs", "observability.md");
const API = "https://healthchecks.io/api/v3";
const TZ = "Africa/Cairo";

/**
 * The last column's opt-out: a row carrying `in-house only` is declared for the IN-HOUSE register
 * and never pushed to Healthchecks. See IN-HOUSE ONLY in this file's header.
 */
const IN_HOUSE_ONLY_MARKER = /\bin-house only\b/i;

const APPLY = process.argv.includes("--apply");

/** `10m` / `2h` / `12h` -> seconds. Returns null for anything else. */
export function parseDuration(text) {
  const m = /^(\d+)([mh])$/.exec(String(text).trim());
  if (!m) return null;
  return Number(m[1]) * (m[2] === "h" ? 3600 : 60);
}

/**
 * Read the "Check slug | Cron expression | Suggested grace" table out of the doc.
 *
 * Two shapes appear in that column, and both are real:
 *   | `phoenix-notify-daily`          | `36 6 * * *`              | 1h  | ...
 *   | `phoenix-ireports360-live-poll` | **Simple**, period `5m`   | 15m | ...
 * The second is a period check, not a cron one - it is pinged by an in-process poller on a plain
 * interval, so it has no cron expression to give.
 */
export function parseDesiredChecks(markdown) {
  const out = [];
  const seen = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const row = /^\s*\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|\s*(.+?)\s*\|\s*(\d+[mh])\s*\|(.*)$/.exec(line);
    if (!row) continue;
    const [, slug, scheduleCell, graceCell, pingedByCell] = row;
    const grace = parseDuration(graceCell);
    if (grace === null) continue;
    // A slug listed twice would silently make one row win. Say so instead.
    if (seen.has(slug)) throw new Error(`${slug} appears twice in the ${DOC} table - remove one row`);

    // Parsed for EVERY row, including the ones this script will not push. The register test asserts
    // this table and JOB_SCHEDULES declare exactly the same slugs, so an in-house-only job must
    // still be RETURNED here - it is main() that declines to push it, not the parser that hides it.
    const externalSync = !IN_HOUSE_ONLY_MARKER.test(pingedByCell);

    const simple =/\*\*Simple\*\*,\s*period\s*`(\d+[mh])`/.exec(scheduleCell);
    if (simple) {
      const timeout = parseDuration(simple[1]);
      if (timeout === null) continue;
      seen.add(slug);
      out.push({ slug, kind: "simple", timeout, grace, externalSync });
      continue;
    }
    const cron = /^`([^`]+)`$/.exec(scheduleCell);
    if (!cron) continue;
    seen.add(slug);
    out.push({ slug, kind: "cron", schedule: cron[1], tz: TZ, grace, externalSync });
  }
  return out;
}

function readApiKey() {
  if (process.env.HEALTHCHECKS_API_KEY) return process.env.HEALTHCHECKS_API_KEY.trim();
  const envFile = join(REPO_ROOT, ".env.local");
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^HEALTHCHECKS_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "") || null;
  }
  return null;
}

async function api(path, key, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "X-Api-Key": key, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    // Never echo the body blindly on 401 - it is short and safe, but be explicit about the cause
    // because "wrong key type" is by far the likeliest mistake here.
    if (res.status === 401) {
      throw new Error(
        "HTTP 401 from Healthchecks. HEALTHCHECKS_API_KEY must be a project API KEY " +
          "(Settings > API keys), not the PING key.",
      );
    }
    throw new Error(`HTTP ${res.status} from ${path}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * The API stores/returns `channels` as a comma-separated list of channel UUIDs in whatever order
 * it feels like. Sort before comparing, or an identically-configured check reads as drift forever
 * and every run re-POSTs it for no reason.
 */
function normalizeChannels(csv) {
  return (csv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

/**
 * What differs between what the doc (plus, for channels, the project's own channel list) asks for
 * and what Healthchecks currently holds. `desiredChannels` is optional and omitted entirely from
 * the diff when undefined - see readChannels' "zero channels configured" case in main().
 */
export function diffCheck(desired, actual, desiredChannels) {
  if (!actual) return { action: "create", changes: ["does not exist yet"] };
  const changes = [];
  if (desired.kind === "cron") {
    if ((actual.schedule || "") !== desired.schedule) {
      changes.push(`schedule ${actual.schedule ? `\`${actual.schedule}\`` : `(period ${actual.timeout}s)`} -> \`${desired.schedule}\``);
    }
    if ((actual.tz || "UTC") !== desired.tz) changes.push(`tz ${actual.tz || "UTC"} -> ${desired.tz}`);
  } else if (Number(actual.timeout) !== desired.timeout) {
    changes.push(`period ${actual.timeout}s -> ${desired.timeout}s`);
  }
  if (Number(actual.grace) !== desired.grace) changes.push(`grace ${actual.grace}s -> ${desired.grace}s`);
  if (desiredChannels !== undefined) {
    const want = normalizeChannels(desiredChannels);
    const have = normalizeChannels(actual.channels);
    if (want !== have) changes.push(`channels ${have || "(none)"} -> ${want || "(none)"}`);
  }
  return { action: changes.length ? "update" : "ok", changes };
}

export function payload(desired, desiredChannels) {
  // `slug` MUST be sent. A check created through this API is stored with an EMPTY slug unless it is
  // given one explicitly - and the app pings by slug (`hc-ping.com/<ping-key>/<slug>?create=1`), not
  // by name. A slugless check therefore never receives the ping it is watching for: it goes red on
  // its own schedule while the job runs perfectly, and the next real ping auto-provisions a SECOND
  // check beside it. Found on the first live run, by the read-back below.
  const base = { name: desired.slug, slug: desired.slug, grace: desired.grace, unique: ["name"] };
  if (desiredChannels !== undefined) base.channels = desiredChannels;
  return desired.kind === "cron"
    ? { ...base, schedule: desired.schedule, tz: desired.tz }
    : { ...base, timeout: desired.timeout };
}

/**
 * Re-read the project and return the slugs that STILL do not match the doc. `readChecks` is
 * injected so this is testable without a network call.
 *
 * A check whose write failed will legitimately appear here, and that is the useful part: the caller
 * learns which of the OTHER checks landed. Run this whether or not anything failed.
 */
export async function verifyAfterApply(syncable, desiredChannels, readChecks) {
  const after = await readChecks();
  const afterBySlug = new Map((after.checks || []).map((c) => [c.slug, c]));
  const stillWrong = [];
  for (const d of syncable) {
    const { action } = diffCheck(d, afterBySlug.get(d.slug), desiredChannels);
    if (action !== "ok") stillWrong.push(d.slug);
  }
  return stillWrong;
}

/**
 * The exit code for an `--apply` run. A write that failed and a write that silently did not stick
 * are the same outcome to whoever runs this - the doc and Healthchecks disagree - so both are 1.
 */
export function applyExitCode(failed, stillWrongCount) {
  return failed > 0 || stillWrongCount > 0 ? 1 : 0;
}

/**
 * Every channel id configured in the project (Settings > Integrations), comma-joined and sorted -
 * the set every declared check should carry. Returns "" if the project has none, which callers
 * must treat as "skip channel enforcement", not "set channels to empty": a project that genuinely
 * has no channels yet is mid-setup, not asking to have channels stripped from every check.
 */
async function readChannels(key) {
  const resp = await api("/channels/", key);
  return (resp.channels || [])
    .map((c) => c.id)
    .sort()
    .join(",");
}

async function main() {
  const desired = parseDesiredChecks(readFileSync(DOC, "utf8"));
  if (desired.length === 0) {
    console.error(`No check rows parsed out of ${DOC}. Has the table format changed?`);
    process.exit(1);
  }
  // Declared-and-pushed vs declared-and-watched-in-house. Both halves are printed: a skipped row
  // that vanished from the output silently would be worse than the FAILED line this replaces.
  const syncable = desired.filter((d) => d.externalSync);
  const inHouseOnly = desired.filter((d) => !d.externalSync);

  console.log(`healthchecks-sync — ${desired.length} checks declared in docs/observability.md`);
  console.log(`mode: ${APPLY ? "APPLY" : "dry run (pass --apply to push)"}\n`);
  if (inHouseOnly.length) {
    console.log(`${inHouseOnly.length} declared in-house only — watched by the heartbeat register, not pushed here:`);
    for (const d of inHouseOnly) console.log(`  skip     ${d.slug}`);
    console.log("");
  }

  const key = readApiKey();
  if (!key) {
    console.log("Planned state (no HEALTHCHECKS_API_KEY, so nothing was read or written):\n");
    for (const d of syncable) {
      const sched = d.kind === "cron" ? `${d.schedule}  ${d.tz}` : `simple, period ${d.timeout}s`;
      console.log(`  ${d.slug.padEnd(46)} ${sched.padEnd(28)} grace ${d.grace}s`);
    }
    console.error(
      "\nHEALTHCHECKS_API_KEY is not set. Add a Healthchecks project API key (Settings > API keys,\n" +
        "full access) to .env.local as HEALTHCHECKS_API_KEY, then re-run. It is NOT the ping key.",
    );
    process.exit(1);
  }

  const existing = await api("/checks/", key);
  const bySlug = new Map((existing.checks || []).map((c) => [c.slug, c]));

  const channelsCsv = await readChannels(key);
  const desiredChannels = channelsCsv || undefined;
  if (!desiredChannels) {
    console.log("(no notification channels configured in this Healthchecks project — channel enforcement skipped;\n add one under Settings > Integrations, then re-run)\n");
  }

  let created = 0;
  let updated = 0;
  let ok = 0;
  let failed = 0;

  for (const d of syncable) {
    const actual = bySlug.get(d.slug);
    const { action, changes } = diffCheck(d, actual, desiredChannels);
    if (action === "ok") {
      ok += 1;
      console.log(`  ok       ${d.slug}`);
      continue;
    }
    const label = action === "create" ? "CREATE  " : "UPDATE  ";
    console.log(`  ${label} ${d.slug}`);
    for (const c of changes) console.log(`             ${c}`);
    if (!APPLY) continue;
    try {
      await api("/checks/", key, { method: "POST", body: JSON.stringify(payload(d, desiredChannels)) });
      if (action === "create") created += 1;
      else updated += 1;
    } catch (err) {
      failed += 1;
      console.log(`             FAILED: ${err.message}`);
    }
  }

  console.log("");
  if (!APPLY) {
    const pending = syncable.length - ok;
    console.log(pending === 0 ? "Everything already matches." : `${pending} check(s) would change. Re-run with --apply.`);
    return;
  }
  console.log(`applied — ${created} created, ${updated} updated, ${ok} already correct, ${failed} failed`);

  // Read back rather than trusting the write. A 200 on POST is not proof the stored schedule is
  // what we asked for; the whole point of this file is that untuned checks lie quietly.
  //
  // UNCONDITIONAL, AND THE ORDERING IS THE POINT. This used to `process.exit(1)` on `failed > 0`
  // immediately above, so the one run that most needed verifying - the run where something went
  // wrong - was the only run that never checked what it had actually stored. A partial apply is
  // exactly when you need to know which of the OTHER checks landed, and the failure of one write
  // says nothing about the rest. Live example: the 2026-09-08 run updated six checks correctly and
  // hit HTTP 403 on two creates; it exited 1 here and printed no verification at all, so the six
  // good writes were confirmed only by re-reading the API by hand afterwards.
  const stillWrong = await verifyAfterApply(syncable, desiredChannels, () => api("/checks/", key));
  for (const slug of stillWrong) console.log(`  STILL WRONG after write: ${slug}`);
  console.log(
    stillWrong.length === 0
      ? "verified — every check now matches the doc."
      : `${stillWrong.length} check(s) still differ.`,
  );
  // `process.exitCode`, not `process.exit()`: the latter can truncate pending stdout on Windows,
  // which would eat the very verification lines printed just above.
  process.exitCode = applyExitCode(failed, stillWrong.length);
}

// Importable for tests; only runs the sync when executed directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
