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
 * TWO TABLES, BOTH REQUIRED. The schedule table gives each check its cron/period, timezone and
 * grace; the tags/description table beneath it gives the module tag and the sentence saying what a
 * red MEANS. Measured on the owner's audit, 15 Oct 2026: 0 of the 40 live checks carried either, so
 * the dashboard was 40 undifferentiated slugs and an alert named a slug and a status and nothing
 * about what had stopped. A declared slug missing from the second table, or a row there for a slug
 * nothing declares, STOPS the run - see attachCheckMeta for why that is a stop and not a warning.
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
 * IN-HOUSE ONLY WITHHOLDS THE *CREATE*, NOT THE TUNING. A row whose last column carries
 * `in-house only` is declared for the in-house register (src/lib/observability/job-schedule.ts +
 * public.job_heartbeats) and this script never CREATES a check for it: the project has a ceiling,
 * creating one past it answers HTTP 403 with an empty body, and the owner has ruled out raising the
 * plan (2026-09-08). A marker that withheld the create spared the run two permanent
 * CREATE ... FAILED lines for jobs that are working exactly as intended.
 *
 * 🔴 BUT IT USED TO WITHHOLD THE WHOLE WRITE, WHICH RE-CREATED THE EXACT FAILURE THE WHY THIS
 * EXISTS NOTE ABOVE DESCRIBES - inside the tool meant to prevent it. Those jobs ping with
 * `?create=1`, so Healthchecks auto-provisioned a check for nearly every one of them anyway, each
 * born on the Healthchecks DEFAULTS (1-day period, 1-hour grace). Nothing then tuned them, because
 * the marker made this script skip them entirely - so it printed "Everything already matches" while
 * 13 of the project's 40 live checks were wrong (measured 2026-10-15, on the owner's audit):
 * `phoenix-retention-risk-pre-payroll` (monthly, day 25) had been RED for 20 days against a job the
 * register reported healthy, `private-calendar-gap-notice` and `phoenix-crm-fraud-scan` (both
 * weekly) were red six days in seven, and `phoenix-crm-visit-rollup` (hourly) and
 * `phoenix-interview-reminders` (every 10 minutes) were judged once a DAY - 24x and 144x too loose
 * to notice a stop.
 *
 * So the rule is existence, not the marker: a declared check that EXISTS is tuned in place (an
 * update costs no slot), and the marker only stops this script asking for a new one. A marked row
 * with no check is listed as withheld on every run - never silently dropped.
 *
 * The marker never withholds the WATCH. Every row stays declared in JOB_SCHEDULES, so the heartbeat
 * sweep alerts in-app + Telegram + push when one stops reporting, and the sweep itself is externally
 * watched by `phoenix-job-heartbeat-sweep`.
 *
 * TO GIVE A WITHHELD ROW ITS OWN CHECK: free a check in the Healthchecks project (or raise the
 * plan), drop the marker from its row, and re-run with --apply.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "healthchecks-sync",
  entry: import.meta.url,
  known: ["--apply"],
});

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOC = join(REPO_ROOT, "docs", "observability.md");
const API = "https://healthchecks.io/api/v3";
const TZ = "Africa/Cairo";

/**
 * The last column's opt-out: a row carrying `in-house only` is declared for the IN-HOUSE register
 * and never pushed to Healthchecks. See IN-HOUSE ONLY in this file's header.
 */
const IN_HOUSE_ONLY_MARKER = /\bin-house only\b/i;

/**
 * The closed tag vocabulary, exported so the doc table, this script and the test read ONE list.
 *
 * Exactly one MODULE tag per check, because the Healthchecks dashboard shows a check's schedule and
 * its status and nothing about which part of Phoenix it belongs to - and a project of 40 checks
 * with no tags at all (measured 15 Oct 2026: 0 of 40 carried a tag or a description) is 40
 * undifferentiated slugs. There is deliberately NO cadence tag: the dashboard already prints the
 * schedule beside each check, so a hand-written `daily`/`hourly` would add nothing and drift.
 */
export const MODULE_TAGS = Object.freeze([
  "crm",
  "direct-orders",
  "hr",
  "marketing",
  "platform",
  "production-planning",
  "recruitment",
  "sales",
]);

/**
 * `in-house-only` must agree with the schedule row's own marker - the test asserts that, so the two
 * tables cannot drift into saying different things about the same check. `silent-when-clean` marks
 * the jobs whose normal outcome is to send nothing, which is the single most useful thing to know
 * before concluding from silence that one has stopped.
 */
export const EXTRA_TAGS = Object.freeze(["in-house-only", "silent-when-clean"]);

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
 * Two shapes are accepted in that column:
 *   | `phoenix-daily-birthday`        | `38 6 * * *`              | 1h  | ...
 *   | `phoenix-example-poll`          | **Simple**, period `5m`   | 15m | ...
 * The second is a period check, not a cron one - it is pinged by an in-process poller on a plain
 * interval, so it has no cron expression to give. No declared job uses it since the iReports360
 * live poller was retired on 6 November 2026; the parser keeps it for the next one that does.
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

/**
 * The tags/description table: `| `slug` | `tags` | what a red means |`.
 *
 * THREE CELLS, NOT FOUR, AND THAT IS WHAT KEEPS THE TWO TABLES APART. The schedule table's rows
 * carry four cells, so the `\|\s*$` anchor below cannot match one; and this table's tags cell is
 * backticked lowercase words, which no cron expression can be. Neither parser can read the other's
 * rows, and `tests/healthchecks-schedule-sync.test.ts` asserts the counts both ways so a reformat
 * that makes them overlap fails rather than silently halving a sync.
 */
const META_ROW = /^\s*\|\s*`([a-z0-9][a-z0-9-]*)`\s*\|\s*`([a-z][a-z0-9 -]*?)`\s*\|\s*([^|]+?)\s*\|\s*$/;

/** slug -> { tags, desc } for every row of that table. */
export function parseCheckMeta(markdown) {
  const out = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const m = META_ROW.exec(line);
    if (!m) continue;
    const [, slug, tagCell, desc] = m;
    if (out.has(slug)) {
      throw new Error(`${slug} appears twice in the ${DOC} tags/description table - remove one row`);
    }
    out.set(slug, { tags: tagCell.trim().split(/\s+/), desc: desc.trim() });
  }
  return out;
}

/**
 * Join the two tables, and REFUSE rather than push a partial truth.
 *
 * A declared check with no tags/description row would be pushed with neither - which is the state
 * this whole addition exists to end - and a row naming an undeclared slug is a check nobody pings,
 * usually a slug that was renamed on one table and not the other. Both are a stop, not a warning:
 * the sync is the only thing that reads these tables together, so if it shrugs, nothing else looks.
 */
export function attachCheckMeta(desired, meta) {
  const declared = new Set(desired.map((d) => d.slug));
  const missing = desired.filter((d) => !meta.has(d.slug)).map((d) => d.slug);
  const orphans = [...meta.keys()].filter((slug) => !declared.has(slug));
  if (missing.length || orphans.length) {
    const parts = [];
    if (missing.length) parts.push(`declared with no tags/description row: ${missing.join(", ")}`);
    if (orphans.length) parts.push(`tags/description rows for undeclared slugs: ${orphans.join(", ")}`);
    throw new Error(`the two tables in ${DOC} disagree - ${parts.join("; ")}`);
  }
  return desired.map((d) => ({ ...d, ...meta.get(d.slug) }));
}

/**
 * Tags are stored and returned as ONE space-separated string, in whatever order the API feels
 * like - the same hazard as `channels`. Sort before comparing or every run re-POSTs every check.
 */
export function normalizeTags(value) {
  return (Array.isArray(value) ? value : String(value || "").split(/\s+/))
    .map((t) => t.trim())
    .filter(Boolean)
    .sort()
    .join(" ");
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
  // Both are OPTIONAL on `desired`, so a caller holding only the schedule table (the offline
  // listing, and every pre-2026-10-15 test) diffs exactly as before rather than being told that
  // every check is missing a description it never asked for.
  if (desired.tags !== undefined) {
    const want = normalizeTags(desired.tags);
    const have = normalizeTags(actual.tags);
    if (want !== have) changes.push(`tags ${have || "(none)"} -> ${want}`);
  }
  if (desired.desc !== undefined) {
    const have = (actual.desc || "").trim();
    // The whole sentence, never a shortened one: this is the line that says what a red means, and a
    // clipped diff is unreadable at the moment somebody is deciding whether the wording is right.
    if (have !== desired.desc) changes.push(have ? `description -> ${desired.desc}` : `description (none) -> ${desired.desc}`);
  }
  if (desiredChannels !== undefined) {
    const want = normalizeChannels(desiredChannels);
    const have = normalizeChannels(actual.channels);
    if (want !== have) changes.push(`channels ${have || "(none)"} -> ${want || "(none)"}`);
  }
  return { action: changes.length ? "update" : "ok", changes };
}

/**
 * Split the declared rows into the ones this run may write and the ones it must withhold.
 *
 * THE RULE IS EXISTENCE, NOT THE MARKER. `in-house only` withholds a CREATE, because the project
 * has a ceiling and asking past it answers HTTP 403 with an empty body. It must NOT withhold an
 * UPDATE: those jobs ping with `?create=1`, so Healthchecks auto-provisioned most of their checks
 * anyway - on its own defaults - and an update costs no slot. Skipping them is what let 13 of the
 * project's 40 live checks sit wrong for weeks while this script printed "Everything already
 * matches" (see IN-HOUSE ONLY in this file's header).
 *
 * `withheld` is returned rather than dropped: a marked row with no check is the one case where the
 * external watch really is absent, and every run says so by name.
 */
export function selectSyncTargets(desired, bySlug) {
  const tuneInPlace = [];
  const withheld = [];
  const syncable = [];
  for (const d of desired) {
    if (d.externalSync) {
      syncable.push(d);
    } else if (bySlug.has(d.slug)) {
      tuneInPlace.push(d);
      syncable.push(d);
    } else {
      withheld.push(d);
    }
  }
  return { syncable, tuneInPlace, withheld };
}

/**
 * `update` picks the endpoint's shape, not the fields. A create goes to `/checks/` and carries
 * `unique` so a re-run matches the check it made last time instead of making a second one; an
 * update goes to `/checks/<uuid>`, which identifies the check outright, so `unique` is meaningless
 * there and is left off rather than sent and ignored.
 */
export function payload(desired, desiredChannels, { update = false } = {}) {
  // `slug` MUST be sent. A check created through this API is stored with an EMPTY slug unless it is
  // given one explicitly - and the app pings by slug (`hc-ping.com/<ping-key>/<slug>?create=1`), not
  // by name. A slugless check therefore never receives the ping it is watching for: it goes red on
  // its own schedule while the job runs perfectly, and the next real ping auto-provisions a SECOND
  // check beside it. Found on the first live run, by the read-back below.
  const base = { name: desired.slug, slug: desired.slug, grace: desired.grace };
  if (desired.tags !== undefined) base.tags = normalizeTags(desired.tags);
  if (desired.desc !== undefined) base.desc = desired.desc;
  if (!update) base.unique = ["name"];
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
  const markdown = readFileSync(DOC, "utf8");
  const schedules = parseDesiredChecks(markdown);
  if (schedules.length === 0) {
    console.error(`No check rows parsed out of ${DOC}. Has the table format changed?`);
    process.exit(1);
  }
  // Throws when the two tables disagree - see attachCheckMeta. Deliberately BEFORE the API key is
  // read, so a doc mistake is reported on a laptop with no credentials at all.
  const desired = attachCheckMeta(schedules, parseCheckMeta(markdown));
  console.log(`healthchecks-sync — ${desired.length} checks declared in docs/observability.md`);
  console.log(`mode: ${APPLY ? "APPLY" : "dry run (pass --apply to push)"}\n`);

  const key = readApiKey();
  if (!key) {
    // Which marked rows have a check cannot be known without reading the project, so this offline
    // listing shows the rows that would be pushed outright and nothing about the marked ones.
    console.log("Planned state (no HEALTHCHECKS_API_KEY, so nothing was read or written):\n");
    for (const d of desired.filter((c) => c.externalSync)) {
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

  // Both halves are printed. A row that vanished from the output silently would be worse than the
  // FAILED line the marker replaced.
  const { syncable, tuneInPlace, withheld } = selectSyncTargets(desired, bySlug);
  if (tuneInPlace.length) {
    console.log(`${tuneInPlace.length} declared in-house only but already present — tuned in place (an update costs no slot):`);
    for (const d of tuneInPlace) console.log(`  in place ${d.slug}`);
    console.log("");
  }
  if (withheld.length) {
    console.log(`${withheld.length} declared in-house only with no check here — NOT created, so NOTHING outside Phoenix watches it:`);
    for (const d of withheld) console.log(`  withheld ${d.slug}`);
    console.log("");
  }

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
      // An existing check is written BY UUID. `unique: ["name"]` would also match it — every check
      // in this project is named after its slug — but only by coincidence of that convention: a
      // check whose name had drifted would be answered with a SECOND check beside it, which is the
      // duplicate this script already learned about once (see payload's slug note).
      const update = Boolean(actual?.uuid);
      const path = update ? `/checks/${actual.uuid}` : "/checks/";
      await api(path, key, { method: "POST", body: JSON.stringify(payload(d, desiredChannels, { update })) });
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
