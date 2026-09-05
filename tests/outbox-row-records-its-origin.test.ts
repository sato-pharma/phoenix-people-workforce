import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// AN OUTBOX ROW MUST SAY WHICH RUNTIME WROTE IT.
//
// `.env.local` points at PRODUCTION Supabase (AGENTS.md §3), so `pnpm run dev` writes real rows
// into the real outbox. That local process has no `EMAIL_NOTIFICATIONS_ENABLED`, so every such row
// is instantly skipped with "EMAIL_NOTIFICATIONS_ENABLED is not true" — and nothing on the row said
// where it came from. 63 of them sit in production, indistinguishable from a genuine outage.
//
// That ambiguity is what made "the system is not firing emails" look real on 2026-09-05. Settling
// it took clock forensics: 40 of those 63 rows have `updated_at` EARLIER than `created_at`, because
// the two timestamps are written by different machines — against 2 of 2,231 rows everywhere else.
// The origin stamp turns that into one glance.

const EMAIL = fileURLToPath(new URL("../src/lib/notifications/email.ts", import.meta.url));

function testTheEnqueueStampsItsEnvironment() {
  const source = readFileSync(EMAIL, "utf8");

  assert.ok(
    source.includes("originEnvironment: enqueueOriginEnvironment()"),
    "enqueueNotificationEmail must stamp the runtime that wrote the row",
  );
  assert.ok(
    source.includes("originEnvironment?: string;"),
    "the payload type must declare the field, so it is not an untyped stowaway",
  );
}

function testTheStampCannotChangeDedupeBehaviour() {
  const source = readFileSync(EMAIL, "utf8");
  const fnStart = source.indexOf("async function enqueueNotificationEmail");
  assert.ok(fnStart > 0, "enqueueNotificationEmail must still exist");
  const body = source.slice(fnStart, fnStart + 1600);

  // The dedupe key must be derived from the CALLER's input, before the stamp is mixed in.
  // Deriving it from the stamped object would change every key, so the same notification enqueued
  // from a local run and from production would no longer deduplicate against each other — turning
  // an observability improvement into a duplicate-email bug.
  const dedupeAt = body.indexOf("notificationDedupeKey(input)");
  const stampAt = body.indexOf("originEnvironment: enqueueOriginEnvironment()");
  assert.ok(dedupeAt > 0, "the dedupe key must still be computed from `input`");
  assert.ok(stampAt > 0, "the stamp must be applied in this function");
  assert.ok(dedupeAt < stampAt, "the dedupe key must be computed BEFORE the origin stamp is added");
  assert.ok(
    !body.includes("notificationDedupeKey({ ...input"),
    "the dedupe key must never be computed from the stamped payload",
  );
}

function testTheLabelMatchesTheErrorMonitorsDefinition() {
  // One definition of "which environment am I". If these drift, the outbox and the error monitor
  // will disagree about the same run, which is worse than neither having it.
  const source = readFileSync(EMAIL, "utf8");
  assert.ok(
    source.includes('process.env.APP_ENV || process.env.NODE_ENV || "development"'),
    "the origin label must use the same expression as the error monitor's currentEnvironmentLabel",
  );
}

export function runOutboxRowRecordsItsOriginTests() {
  testTheEnqueueStampsItsEnvironment();
  testTheStampCannotChangeDedupeBehaviour();
  testTheLabelMatchesTheErrorMonitorsDefinition();
}
