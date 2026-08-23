#!/usr/bin/env node
/**
 * Push the Healthchecks.io check schedules that `docs/observability.md` declares.
 *
 * WHY THIS EXISTS
 * A check auto-provisions on its first successful ping (`?create=1`) with Healthchecks' DEFAULTS:
 * a 1-day period and a 1-hour grace. Nothing ever corrects that. So a job that really runs weekly,
 * or at 02:17 Cairo, sits permanently red against a schedule nobody set — and a dashboard that is
 * always red is a dashboard everyone learns to ignore, which is the exact failure this whole
 * observability layer exists to prevent. Tuning fourteen checks by hand in a web UI is how that
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
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(REPO_ROOT, "docs", "observability.md");
const API = "https://healthchecks.io/api/v3";
const TZ = "Africa/Cairo";

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
    const row = /^\s*\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|\s*(.+?)\s*\|\s*(\d+[mh])\s*\|/.exec(line);
    if (!row) continue;
    const [, slug, scheduleCell, graceCell] = row;
    const grace = parseDuration(graceCell);
    if (grace === null) continue;
    // A slug listed twice would silently make one row win. Say so instead.
    if (seen.has(slug)) throw new Error(`${slug} appears twice in the ${DOC} table - remove one row`);

    const simple = /\*\*Simple\*\*,\s*period\s*`(\d+[mh])`/.exec(scheduleCell);
    if (simple) {
      const timeout = parseDuration(simple[1]);
      if (timeout === null) continue;
      seen.add(slug);
      out.push({ slug, kind: "simple", timeout, grace });
      continue;
    }
    const cron = /^`([^`]+)`$/.exec(scheduleCell);
    if (!cron) continue;
    seen.add(slug);
    out.push({ slug, kind: "cron", schedule: cron[1], tz: TZ, grace });
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

/** What differs between what the doc asks for and what Healthchecks currently holds. */
export function diffCheck(desired, actual) {
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
  return { action: changes.length ? "update" : "ok", changes };
}

function payload(desired) {
  const base = { name: desired.slug, grace: desired.grace, unique: ["name"] };
  return desired.kind === "cron"
    ? { ...base, schedule: desired.schedule, tz: desired.tz }
    : { ...base, timeout: desired.timeout };
}

async function main() {
  const desired = parseDesiredChecks(readFileSync(DOC, "utf8"));
  if (desired.length === 0) {
    console.error(`No check rows parsed out of ${DOC}. Has the table format changed?`);
    process.exit(1);
  }
  console.log(`healthchecks-sync — ${desired.length} checks declared in docs/observability.md`);
  console.log(`mode: ${APPLY ? "APPLY" : "dry run (pass --apply to push)"}\n`);

  const key = readApiKey();
  if (!key) {
    console.log("Planned state (no HEALTHCHECKS_API_KEY, so nothing was read or written):\n");
    for (const d of desired) {
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

  let created = 0;
  let updated = 0;
  let ok = 0;
  let failed = 0;

  for (const d of desired) {
    const actual = bySlug.get(d.slug);
    const { action, changes } = diffCheck(d, actual);
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
      await api("/checks/", key, { method: "POST", body: JSON.stringify(payload(d)) });
      if (action === "create") created += 1;
      else updated += 1;
    } catch (err) {
      failed += 1;
      console.log(`             FAILED: ${err.message}`);
    }
  }

  console.log("");
  if (!APPLY) {
    const pending = desired.length - ok;
    console.log(pending === 0 ? "Everything already matches." : `${pending} check(s) would change. Re-run with --apply.`);
    return;
  }
  console.log(`applied — ${created} created, ${updated} updated, ${ok} already correct, ${failed} failed`);
  if (failed > 0) process.exit(1);

  // Read back rather than trusting the write. A 200 on POST is not proof the stored schedule is
  // what we asked for; the whole point of this file is that untuned checks lie quietly.
  const after = await api("/checks/", key);
  const afterBySlug = new Map((after.checks || []).map((c) => [c.slug, c]));
  let drift = 0;
  for (const d of desired) {
    const { action } = diffCheck(d, afterBySlug.get(d.slug));
    if (action !== "ok") {
      drift += 1;
      console.log(`  STILL WRONG after write: ${d.slug}`);
    }
  }
  console.log(drift === 0 ? "verified — every check now matches the doc." : `${drift} check(s) still differ.`);
  if (drift > 0) process.exit(1);
}

// Importable for tests; only runs the sync when executed directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
