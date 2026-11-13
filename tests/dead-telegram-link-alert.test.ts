import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  alertMessage,
  DEAD_TELEGRAM_AUDIENCE,
  MIN_DROPPED,
  NOT_CONNECTED_ERROR,
  rollUpDrops,
  WINDOW_HOURS,
} from "../src/lib/notifications/dead-telegram-link-alert.ts";
import { DAILY_JOBS, dailyJobHeartbeatSlug } from "../src/lib/scheduled-jobs/daily-jobs.ts";
import { jobSchedulesFor } from "../src/lib/observability/job-schedule.ts";

/**
 * Telegram messages thrown away with nothing saying so.
 *
 * A Telegram delivery to somebody with no live link is written `status: "skipped"`,
 * `last_error: "Telegram is not connected."` — the SAME word used when a module policy deliberately
 * turns the channel off. A dead link and a decision are therefore identical in the data, and neither
 * turns anything red.
 *
 * Measured on production 2026-09-28: NOT ONE link in the company was active (10 pending, 1 failed,
 * 0 active) and 1,656 messages had been dropped that way, 311 in the last seven days — 448 of them
 * to the CEO. Every one was a notification somebody decided was worth sending.
 *
 * What this pins, in the order a failure would cost most:
 *
 *   1. IN-APP ALONE. The channel this alert is ABOUT is the broken one; a Telegram notice would be
 *      swallowed by the exact fault it reports. Email is not used either.
 *   2. LIVE LOSS, NOT A LIST. It reads a 24-hour window, so it falls silent by itself once the links
 *      are fixed — nothing to remember, nothing to stand down.
 *   3. NO SCHEDULE OF ITS OWN. A JOB_SCHEDULES entry whose cron job does not exist reads to
 *      job-heartbeat-assess as a job that has STOPPED and Telegrams every Super Admin for ever.
 */
export function runDeadTelegramLinkAlertTests(): void {
  const source = (path: string) => stripComments(readFileSync(path, "utf8"));
  const drop = (hrId: string, times: number) => Array.from({ length: times }, () => ({ recipient_hr_id: hrId }));

  // ── 1. Who is worth naming ──────────────────────────────────────────────────────────────────────
  {
    assert.equal(NOT_CONNECTED_ERROR, "Telegram is not connected.", "the sentence must match the sender's EXACTLY, or the alert reads zero for ever");
    assert.equal(WINDOW_HOURS, 24, "a 24-hour window: the alert is about messages being lost NOW");
    assert.equal(MIN_DROPPED, 3, "one or two drops is not worth a Super Admin's morning");

    assert.deepEqual(rollUpDrops([]), [], "a quiet window says nothing at all — the good outcome");
    assert.deepEqual(rollUpDrops(drop("A-2", 2)), [], "below the floor, nobody is named");

    const rolled = rollUpDrops([...drop("A-2", 5), ...drop("B-12", 9), ...drop("X-1", 1), ...drop("b-12", 2)]);
    assert.deepEqual(rolled, [{ hrId: "B-12", dropped: 11 }, { hrId: "A-2", dropped: 5 }], "worst first, case-folded, and the one below the floor dropped");

    assert.deepEqual(rollUpDrops([{ recipient_hr_id: null }, { recipient_hr_id: "  " }]), [], "a delivery with no recipient id is skipped, never counted as a person");
  }

  // ── 2. The words say why it was invisible ───────────────────────────────────────────────────────
  {
    const text = alertMessage([
      { hrId: "A-1", dropped: 448, name: "Anwar Gaweesh", linkStatus: "pending" },
      { hrId: "A-2", dropped: 12, name: "Khaled Bedair", linkStatus: "failed" },
    ]);
    assert.match(text, /^460 Telegram messages were thrown away in the last 24 hours/, "the total opens it");
    assert.match(text, /• Anwar Gaweesh — 448 dropped — link is pending/, "name, count and the link's state, which decides the fix");
    assert.match(text, /• Khaled Bedair — 12 dropped — link is failed/);
    assert.match(text, /same word used when a channel is deliberately switched off/, "WHY nothing ever went red — the point of the whole alert");
    assert.match(text, /linking Telegram again from their own profile/, "and what the person does about it");

    const single = alertMessage([{ hrId: "A-1", dropped: 1, name: "Solo", linkStatus: "never linked" }]);
    assert.match(single, /^1 Telegram message was thrown away/, "one message reads as one message");
    assert.match(single, /link is never linked/, "never linked is a DIFFERENT problem from linked-and-broken");
  }

  // ── 3. In-app alone, and it reads live loss ─────────────────────────────────────────────────────
  {
    const alert = source("src/lib/notifications/dead-telegram-link-alert.ts");
    assert.ok(/channels: \["in_app"\],/.test(alert), "in-app ALONE — a Telegram notice would be swallowed by the fault it reports");
    assert.ok(!/"telegram",/.test(alert.slice(alert.indexOf("channels:"))), "the alert must never ask for the telegram channel");
    assert.ok(!/"email"/.test(alert), "and never email");
    assert.ok(/\.gte\("created_at", since\)/.test(alert), "it reads a WINDOW, not every broken link ever");
    assert.ok(/\.eq\("last_error", NOT_CONNECTED_ERROR\)/.test(alert), "matched on the sender's exact sentence");
    assert.equal(DEAD_TELEGRAM_AUDIENCE, "weekly_system_health_digest", "the existing Super Admin system-health audience, not a new registry key");
  }

  // ── 4. It is its own morning job, on its own schedule and heartbeat ─────────────────────────────
  {
    // It rides the 06:36 fan-out under the fan-out's heartbeat while PHOENIX_DAILY_JOBS_SPLIT is off.
    // On 13 Nov 2026 the owner gave every morning job its own schedule: it is the job
    // `dead-telegram-link-alert`, with a cron-job.org entry and, once the switch is on, a heartbeat
    // of its own, `phoenix-daily-dead-telegram-link-alert`.
    const job = DAILY_JOBS.find((entry) => entry.key === "dead-telegram-link-alert");
    assert.ok(job, "it is one of the morning jobs (src/lib/scheduled-jobs/daily-jobs.ts)");
    assert.ok(
      jobSchedulesFor(true).some((entry) => entry.slug === dailyJobHeartbeatSlug("dead-telegram-link-alert")),
      "and it has its own heartbeat declaration once PHOENIX_DAILY_JOBS_SPLIT is on (while it is off, the fan-out's covers it)",
    );
    const daily = source("app/api/cron/daily/_lib/daily-job-runners.ts");
    assert.ok(/runDeadTelegramLinkAlert\(\)\.catch\(/.test(daily), "it runs as a morning job, with its own catch like every other job");
    // 🔴 The count is checked against REALITY: every morning job is exactly one pass with its own
    // failure handler, so the passes in the runners equal the jobs in the registry. The old
    // hand-maintained `totalJobs` that this used to pin went with the fan-out.
    const passes = (daily.match(/\.catch\(\s*onJobFailure\(/g) ?? []).length;
    assert.equal(
      passes,
      DAILY_JOBS.length,
      `the runners carry ${passes} guarded passes for ${DAILY_JOBS.length} morning jobs — each job is exactly one`,
    );
    assert.ok(passes >= 29, "the morning jobs must not silently LOSE passes either");
  }
}
