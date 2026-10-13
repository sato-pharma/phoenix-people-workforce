import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assessDatabaseRestart,
  buildDatabaseRestartMessage,
  cairoTimestamp,
  describeUptime,
  shouldAlertOnRestart,
} from "@/lib/observability/database-restart";

/**
 * The database restart watch — the alarm for the fault that hit production twice in three days
 * (2026-10-10 11:05:48 and 2026-10-12 19:04:50 Cairo) with nothing reporting either one.
 *
 * NOTHING HERE TOUCHES A DATABASE. `database-restart.ts` is pure on purpose so this file can
 * import it; `database-restart-alert.ts` holds the IO and is checked by SOURCE below, because
 * importing it would pull `@/lib/supabase/server` into a unit test.
 */

const MIGRATION = "supabase/migrations/20261013150001_database_restart_watch.sql";
const ALERT = "src/lib/observability/database-restart-alert.ts";
const SWEEP = "app/api/cron/job-heartbeat-sweep/route.ts";

export async function runDatabaseRestartWatchTests() {
  // ---------------------------------------------------------------------------
  // 1. The verdict. `is_new` is the only thing that says something happened.
  // ---------------------------------------------------------------------------
  const unchanged = assessDatabaseRestart({
    currentStartAt: "2026-10-12T16:04:50.000Z",
    isNew: false,
    previousStartAt: "2026-10-10T08:05:48.000Z",
  });
  assert.equal(unchanged.kind, "unchanged", "a start time already on record is not a restart");
  assert.equal(shouldAlertOnRestart(unchanged), false, "an unchanged start time must never alert");

  // ---------------------------------------------------------------------------
  // 2. The install must not fire the alarm it installs.
  // ---------------------------------------------------------------------------
  // A new start time with nothing before it is the watch running for the first time, and alerting
  // there would page the owner about a restart that had already been reported to him by hand —
  // which is how an alarm gets ignored on the day it ships.
  const first = assessDatabaseRestart({
    currentStartAt: "2026-10-12T16:04:50.000Z",
    isNew: true,
    previousStartAt: null,
  });
  assert.equal(first.kind, "first-sighting");
  assert.equal(shouldAlertOnRestart(first), false, "the first sighting must never alert");

  // ---------------------------------------------------------------------------
  // 3. A real restart alerts, and carries how long the previous run lasted.
  // ---------------------------------------------------------------------------
  const restarted = assessDatabaseRestart({
    currentStartAt: "2026-10-12T16:04:50.000Z",
    isNew: true,
    previousStartAt: "2026-10-10T08:05:48.000Z",
  });
  assert.equal(restarted.kind, "restarted");
  assert.equal(shouldAlertOnRestart(restarted), true, "a proven restart must alert");
  assert.equal(
    restarted.kind === "restarted" ? restarted.upForMs : 0,
    new Date("2026-10-12T16:04:50.000Z").getTime() - new Date("2026-10-10T08:05:48.000Z").getTime(),
    "upForMs must be the gap between the two start times",
  );

  // ---------------------------------------------------------------------------
  // 4. Cairo, never UTC — the owner's standing rule for every time he reads.
  // ---------------------------------------------------------------------------
  // 16:04:50Z in October is 19:04:50 in Cairo (UTC+3). A UTC-rendered alarm would have reported
  // the 12 October restart at 16:04, three hours off the time he saw it happen.
  const rendered = cairoTimestamp("2026-10-12T16:04:50.000Z");
  assert.match(rendered, /19:04:50/, `the restart time must render in Cairo local, got "${rendered}"`);
  assert.match(rendered, /Cairo$/, "the rendered time must say which zone it is in");
  assert.equal(
    cairoTimestamp("not a timestamp"),
    "not a timestamp",
    "an unparseable value is returned as-is rather than rendered as Invalid Date",
  );

  // ---------------------------------------------------------------------------
  // 5. Uptime wording — no ellipsis, no bare milliseconds, correct singulars.
  // ---------------------------------------------------------------------------
  assert.equal(describeUptime(60_000), "1 minute");
  assert.equal(describeUptime(45 * 60_000), "45 minutes");
  assert.equal(describeUptime(60 * 60_000), "1 hour");
  assert.equal(describeUptime(90 * 60_000), "1 hour 30 minutes");
  assert.equal(describeUptime(72 * 60 * 60_000), "3 days");
  assert.equal(describeUptime(0), "an unknown length of time");
  assert.equal(describeUptime(Number.NaN), "an unknown length of time");

  // ---------------------------------------------------------------------------
  // 6. The message says what happened, when, and what to read next.
  // ---------------------------------------------------------------------------
  const message = buildDatabaseRestartMessage(restarted);
  assert.match(message, /The production database restarted/, "the message must name the event");
  assert.match(message, /19:04:50/, "the message must carry the Cairo restart time");
  assert.match(message, /11:05:48/, "the message must carry the previous run's Cairo start time");
  assert.match(
    message,
    /not\s*\n?\s*properly shut down/,
    "the message must name the unclean-restart log line, which is the read that identifies this fault",
  );
  assert.match(
    message,
    /server restarted/,
    "the message must name cron.job_run_details' marker, the one proof that outlives the log window",
  );
  assert.equal(
    buildDatabaseRestartMessage(unchanged),
    "",
    "a non-restart verdict must produce no message at all",
  );

  // ---------------------------------------------------------------------------
  // 7. No email, ever. Source-pinned on the alert file.
  // ---------------------------------------------------------------------------
  // The owner's standing rule bans adding an outbound email to any feature, and this alarm can
  // fire because the database holding the notification outbox is unreachable — an emailed alert
  // would depend on the very thing it is reporting broken.
  const alertSource = readFileSync(ALERT, "utf8");
  assert.match(
    alertSource,
    /channels: \["in_app", "telegram", "push"\]/,
    "the restart alert must stay in-app + Telegram + push",
  );
  assert.equal(
    /channels: \[[^\]]*"email"/.test(alertSource),
    false,
    "the restart alert must never send email",
  );

  // ---------------------------------------------------------------------------
  // 8. Keyed by the start time, not by the Cairo day.
  // ---------------------------------------------------------------------------
  // Its two siblings on this clock bucket per day because they report STANDING faults. A restart
  // is a discrete event: two in one day must be two messages, which is exactly the pattern that
  // made this worth building.
  assert.match(
    alertSource,
    /idempotencyKey: `database-restarted:\$\{assessed\.currentStartAt\}/,
    "the idempotency key must be the postmaster start time, so a second restart is a second message",
  );

  // ---------------------------------------------------------------------------
  // 9. The check must never be able to take its own sweep down.
  // ---------------------------------------------------------------------------
  // It runs while the database may still be refusing connections, inside a route whose job is to
  // report that other things have stopped.
  assert.match(
    alertSource,
    /} catch \(error\) \{/,
    "the restart check must swallow its own errors",
  );
  const sweepSource = readFileSync(SWEEP, "utf8");
  assert.match(
    sweepSource,
    /const databaseRestart = await runDatabaseRestartCheck\(\);/,
    "the restart check must be wired into the 15-minute job-heartbeat sweep",
  );
  assert.match(
    sweepSource,
    /databaseRestart: \{/,
    "the sweep's response must report the restart check, so a manual call can be read",
  );

  // ---------------------------------------------------------------------------
  // 10. The RPC is service_role only, and the table is unreachable from a browser.
  // ---------------------------------------------------------------------------
  // A SECURITY DEFINER function reading pg_postmaster_start_time() must not be callable by
  // `authenticated`: it would hand every signed-in employee a server fact and a write path into a
  // monitoring table.
  const migration = readFileSync(MIGRATION, "utf8");
  assert.match(
    migration,
    /grant execute on function public\.note_database_restart\(\) to service_role;/,
    "the RPC must be granted to service_role",
  );
  // PUBLIC has to be in the revoke, and in the SAME statement as anon and authenticated: those two
  // inherit EXECUTE through PUBLIC membership, so revoking only them is a no-op — which is exactly
  // what `scripts/check-migrations.mjs` refuses, and what the first draft of this migration did.
  assert.match(
    migration,
    /revoke execute on function public\.note_database_restart\(\) from public, anon, authenticated;/,
    "the RPC must revoke EXECUTE from public, anon and authenticated together",
  );
  assert.match(
    migration,
    /revoke all on table public\.database_restarts from anon, authenticated;/,
    "the watch table must not be reachable from a browser role",
  );
  assert.match(
    migration,
    /insert into public\.database_restarts \(postmaster_start_at\)\s*\n\s*values \(pg_catalog\.pg_postmaster_start_time\(\)\)/,
    "the migration must seed the current start time, or installing the watch fires it",
  );
}
