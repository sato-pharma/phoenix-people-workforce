import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { noticeAlreadyReached } from "../src/lib/notifications/stored-notice.ts";

/**
 * A stored notice is never rewritten once it reached somebody (src/lib/notifications/stored-notice.ts).
 * Returns what is MISSING from the sender's source, so the test can hand it a broken copy and require
 * the pin to fire. Comments are stripped first: the fix is explained in prose beside the code.
 */
export function storedNoticeGuardMissing(systemSource: string): string[] {
  const code = stripComments(systemSource).replace(/\r\n/g, "\n");
  const body = code.match(/async function createNotificationEvent\([\s\S]*?\n}\n/)?.[0] ?? "";
  const missing: string[] = [];
  const guard = body.search(/const reachedId = await reachedNoticeId\(eventKey\);\s*if \(reachedId\) return reachedId;/);
  const write = body.indexOf(".upsert(row");
  if (guard < 0) missing.push("createNotificationEvent must return the reached notice before writing");
  else if (write >= 0 && guard > write) missing.push("the reached-notice check must run BEFORE the upsert");
  const reached = code.match(/async function reachedNoticeId\([\s\S]*?\n}\n/)?.[0] ?? "";
  if (!/\.in\("notification_deliveries\.status", \[\.\.\.REACHED_DELIVERY_STATUSES\]\)/.test(reached)) {
    missing.push("reachedNoticeId must read the deliveries that reached the person");
  }
  // Performance phase 1 (2026-10-23): the event and its reached deliveries are ONE embedded read, not a
  // second sequential round trip in front of every notification write.
  if (!/\.select\("id, notification_deliveries\(status\)"\)/.test(reached)) {
    missing.push("reachedNoticeId must read the event and its deliveries in one embedded call");
  }
  if (/\.from\("notification_deliveries"\)/.test(reached)) {
    missing.push("reachedNoticeId must not make a second, separate deliveries read");
  }
  return missing;
}

export async function runNotificationStoredNoticeTests() {
  // The decision itself: sent, pending and retrying reached the person; skipped and failed did not.
  assert.equal(noticeAlreadyReached(["sent"]), true, "a sent delivery keeps the stored notice");
  assert.equal(noticeAlreadyReached(["skipped", "pending"]), true, "a delivery on its way keeps it");
  assert.equal(noticeAlreadyReached(["retrying"]), true, "a retrying delivery keeps it");
  assert.equal(noticeAlreadyReached(["skipped", "failed"]), false, "a notice that reached nobody may be rewritten");
  assert.equal(noticeAlreadyReached([]), false, "no deliveries at all reached nobody");
  assert.equal(noticeAlreadyReached([null, undefined]), false, "an unknown status is not a delivery");

  // The sender honours it, before the write — on the real source, and fires on a broken copy.
  const source = readFileSync(new URL("../src/lib/notifications/system.ts", import.meta.url), "utf8");
  assert.deepEqual(storedNoticeGuardMissing(source), [], "every sender keeps a notice that already reached somebody");
  const broken = source.replace(/const reachedId = await reachedNoticeId\(eventKey\);\s*if \(reachedId\) return reachedId;/, "");
  assert.notEqual(broken, source, "the broken copy must actually remove the guard");
  assert.ok(storedNoticeGuardMissing(broken).length > 0, "the pin fires when the guard is removed");

  // The one-call read fires when it is split back into the old event-then-deliveries pair.
  const split = source.replace(
    '.select("id, notification_deliveries(status)")',
    '.select("id")',
  );
  assert.notEqual(split, source, "the split copy must actually drop the embed");
  assert.ok(
    storedNoticeGuardMissing(split).includes("reachedNoticeId must read the event and its deliveries in one embedded call"),
    "the pin fires when the deliveries read leaves the embed",
  );
}
