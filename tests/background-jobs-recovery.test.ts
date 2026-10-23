import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  STALE_BACKGROUND_JOB_MINUTES,
  planStaleBackgroundJobRecovery,
  recoverStaleBackgroundJobs,
} from "../src/lib/background-jobs/service.ts";
import { STALE_OUTBOX_REAP_REASON, planStaleOutboxReap, reapStaleProcessingOutboxRows } from "../src/lib/notifications/email.ts";
import { DELIVERY_RETRY_LEASE_MS, claimDeliveryRetry } from "../src/lib/notifications/system.ts";
import { fakeSupabaseClient } from "./fixtures/fake-supabase-table.ts";

/**
 * THE BACKGROUND QUEUES NEVER LOOP AND NEVER SEND TWICE (23 Oct 2026 technical audit).
 *
 *  F-04  the email outbox reaper returned a stale `processing` row to `pending` WITHOUT counting an
 *        attempt, so a send interrupted every time looped for ever. Each reap now spends one attempt,
 *        the last one is terminal, and the write is pinned to the lock it read.
 *  F-05  a background job whose process died mid-run stayed `processing` for good. The drain now
 *        re-queues it (or fails it, out of attempts) before claiming new work.
 *  Pass 5  the Telegram and push retry drains sent first and wrote after, so two overlapping drains
 *        both sent one row. A compare-and-set claim on `attempts` now runs BEFORE the send.
 *  S-INT-01  markNotificationOutboxFailed dropped its own write error; it is logged now.
 */
export async function runBackgroundJobsRecoveryTests() {
  const now = "2026-10-23T10:00:00.000Z";

  // ── F-04: the outbox reaper counts the interrupted attempt ──────────────────────────────────────
  const first = planStaleOutboxReap({ attempts: 0, id: "a", locked_at: "x", max_attempts: 5 }, now);
  assert.equal(first.attempts, 1, "a reap spends one attempt, exactly as a failed send does");
  assert.equal(first.status, "pending");
  assert.equal(first.next_attempt_at, now);
  assert.equal(first.locked_at, null);
  assert.equal(first.last_error, STALE_OUTBOX_REAP_REASON);
  const last = planStaleOutboxReap({ attempts: 4, id: "b", locked_at: "x", max_attempts: 5 }, now);
  assert.equal(last.status, "failed", "the reap that uses the last attempt is terminal — the loop ends");
  assert.equal(last.next_attempt_at, null);

  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const fresh = new Date().toISOString();
  const outbox = fakeSupabaseClient({
    notification_outbox: [
      { attempts: 1, id: "stale", locked_at: old, max_attempts: 5, status: "processing" },
      { attempts: 4, id: "stale-last", locked_at: old, max_attempts: 5, status: "processing" },
      { attempts: 0, id: "live", locked_at: fresh, max_attempts: 5, status: "processing" },
      { attempts: 0, id: "queued", locked_at: null, max_attempts: 5, status: "pending" },
    ],
  });
  const reaped = await reapStaleProcessingOutboxRows(outbox as never);
  assert.equal(reaped, 2, "only the two rows locked past the stale window are reaped");
  const rows = Object.fromEntries(outbox.rows("notification_outbox").map((row) => [row.id, row]));
  assert.equal(rows.stale.attempts, 2, "the reaped row carries the interrupted attempt");
  assert.equal(rows.stale.status, "pending");
  assert.equal(rows["stale-last"].status, "failed");
  assert.equal(rows["stale-last"].attempts, 5);
  assert.equal(rows.live.status, "processing", "a row a live drain still holds is untouched");
  assert.equal(rows.live.attempts, 0);

  const emailSource = readFileSync("src/lib/notifications/email.ts", "utf8");
  const reaper = emailSource.slice(emailSource.indexOf("export async function reapStaleProcessingOutboxRows"));
  assert.match(
    reaper.slice(0, 2_500),
    /\.eq\("locked_at", row\.locked_at as string\)/,
    "each reap write is pinned to the lock it read, so a row re-claimed in between is never disturbed",
  );
  // S-INT-01
  const markFailed = emailSource.slice(emailSource.indexOf("async function markNotificationOutboxFailed"));
  assert.match(
    markFailed.slice(0, 2_500),
    /const \{ error: writeError \} = await supabase[\s\S]*if \(writeError\) \{[\s\S]*outbox_mark_failed_write_failed/,
    "markNotificationOutboxFailed reads its own write's error and logs it (S-INT-01)",
  );

  // ── F-05: an abandoned background job is re-queued or failed ────────────────────────────────────
  const retry = planStaleBackgroundJobRecovery({ attempts: 1, id: "j1", max_attempts: 3, updated_at: "x" }, now);
  assert.equal(retry.status, "queued", "a job with attempts left gets another run");
  assert.equal(retry.started_at, null);
  const spent = planStaleBackgroundJobRecovery({ attempts: 3, id: "j2", max_attempts: 3, updated_at: "x" }, now);
  assert.equal(spent.status, "failed", "a job that used every attempt is finished as failed, never re-queued for ever");
  assert.equal(spent.finished_at, now);

  const nowMs = Date.parse(now);
  const staleAt = new Date(nowMs - (STALE_BACKGROUND_JOB_MINUTES + 5) * 60_000).toISOString();
  const recentAt = new Date(nowMs - 5 * 60_000).toISOString();
  const jobs = fakeSupabaseClient({
    background_jobs: [
      { attempts: 1, id: "requeue", max_attempts: 3, status: "processing", updated_at: staleAt },
      { attempts: 3, id: "exhausted", max_attempts: 3, status: "processing", updated_at: staleAt },
      { attempts: 1, id: "running", max_attempts: 3, status: "processing", updated_at: recentAt },
      { attempts: 0, id: "waiting", max_attempts: 3, status: "queued", updated_at: staleAt },
    ],
  });
  const recovered = await recoverStaleBackgroundJobs(jobs as never, nowMs);
  assert.deepEqual(recovered, { failed: 1, requeued: 1 });
  const jobRows = Object.fromEntries(jobs.rows("background_jobs").map((row) => [row.id, row]));
  assert.equal(jobRows.requeue.status, "queued");
  assert.equal(jobRows.exhausted.status, "failed");
  assert.equal(jobRows.running.status, "processing", "a job touched inside the window belongs to a live worker");
  assert.equal(jobRows.waiting.status, "queued");

  const worker = readFileSync("src/lib/background-jobs/worker.ts", "utf8");
  assert.ok(
    worker.indexOf("recoverStaleBackgroundJobs(") > -1 &&
      worker.indexOf("recoverStaleBackgroundJobs(") < worker.indexOf("claimNextBackgroundJob("),
    "the drain recovers abandoned jobs BEFORE it claims new work",
  );

  // ── Pass 5: a Telegram/push retry is claimed before it is sent ──────────────────────────────────
  const deliveries = fakeSupabaseClient({
    notification_deliveries: [
      { attempts: 2, id: "d1", status: "retrying" },
      { attempts: 0, id: "d2", status: "sent" },
      { attempts: null, id: "d3", status: "pending" },
    ],
  });
  const claimNow = Date.parse(now);
  assert.equal(await claimDeliveryRetry(deliveries as never, { attempts: 2, id: "d1" }, { nowMs: claimNow }), true);
  const d1 = deliveries.rows("notification_deliveries").find((row) => row.id === "d1")!;
  assert.equal(d1.attempts, 3, "the claim spends the attempt");
  assert.equal(d1.next_attempt_at, new Date(claimNow + DELIVERY_RETRY_LEASE_MS).toISOString(), "and moves the row out of the drain window");
  assert.equal(
    await claimDeliveryRetry(deliveries as never, { attempts: 2, id: "d1" }, { nowMs: claimNow }),
    false,
    "a second drain that read the SAME row loses the claim and sends nothing",
  );
  assert.equal(await claimDeliveryRetry(deliveries as never, { attempts: 0, id: "d2" }), false, "a sent row is never claimed by a drain");
  assert.equal(await claimDeliveryRetry(deliveries as never, { attempts: null, id: "d3" }), true, "a row with no attempt count yet is claimable once");
  const failing = fakeSupabaseClient({ notification_deliveries: [{ attempts: 0, id: "e", status: "pending" }] }, { failOn: { notification_deliveries: "boom" } });
  assert.equal(await claimDeliveryRetry(failing as never, { attempts: 0, id: "e" }), false, "a claim that cannot be written is a skip, never a send");

  const system = readFileSync("src/lib/notifications/system.ts", "utf8");
  for (const [drain, send] of [
    ["export async function processTelegramDeliveryRetries", "await sendTelegramNotification("],
    ["export async function processPushDeliveryRetries", "await sendPushNotification("],
    ["export async function retryTelegramDeliveryById", "await sendTelegramNotification("],
  ] as const) {
    const body = system.slice(system.indexOf(drain));
    const claimAt = body.indexOf("claimDeliveryRetry(");
    const sendAt = body.indexOf(send);
    assert.ok(claimAt > -1 && claimAt < sendAt, `${drain.replace("export async function ", "")} claims the row before it sends`);
  }
}
