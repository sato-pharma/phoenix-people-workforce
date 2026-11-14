import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { compareOldestFirst, WAITING_LONG_HOURS, waitingHours, waitingIsLong, waitingOldestFirst, waitingText } from "../src/lib/phoenix-crm/waiting-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Place checks lists what is WAITING oldest first, and says how long it has waited (owner, 14 Nov 2026).
 *
 * Measured that morning: 46 validations and 38 polyclinic seatings waiting, the oldest for 11.6 days,
 * listed newest first, so the longest wait sat at the bottom of the last page while the customer behind
 * it stayed out of the KPIs. The decided rows keep their newest-first order.
 */

const ROOT = new URL("../", import.meta.url);

function code(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

export function runPhoenixCrmWaitingOldestFirstTests(): void {
  const now = new Date("2026-11-14T06:00:00.000Z");

  // ── The wait, in the board's words ────────────────────────────────────────────────────────────
  assert.equal(waitingText("2026-11-14T05:30:00.000Z", now), "Waiting under 1 hour");
  assert.equal(waitingText("2026-11-14T05:00:00.000Z", now), "Waiting 1 hour", "one hour is singular");
  assert.equal(waitingText("2026-11-13T07:00:00.000Z", now), "Waiting 23 hours", "under a day stays in hours");
  assert.equal(waitingText("2026-11-13T06:00:00.000Z", now), "Waiting 1 day", "a full day is singular");
  assert.equal(waitingText("2026-11-02T15:36:00.000Z", now), "Waiting 11 days", "🔴 the oldest row of that morning reads its 11 days");
  assert.equal(waitingText("2026-11-14T07:00:00.000Z", now), "Waiting under 1 hour", "a stamp a moment ahead of the clock is never a negative wait");
  assert.equal(waitingText(null, now), null, "no instant, no wait — never a guess");
  assert.equal(waitingText("not a date", now), null);
  assert.equal(waitingHours("2026-11-13T06:00:00.000Z", now), 24);

  assert.equal(WAITING_LONG_HOURS, 72, "three days is where the wait turns to the warning tone");
  assert.equal(waitingIsLong("2026-11-11T06:00:00.000Z", now), true, "exactly three days is long");
  assert.equal(waitingIsLong("2026-11-11T06:00:01.000Z", now), false, "a second under it is not");
  assert.equal(waitingIsLong(null, now), false);

  // ── Oldest first, and only among the waiting ──────────────────────────────────────────────────
  assert.ok(compareOldestFirst({ at: "2026-11-01T08:00:00Z", id: "b" }, { at: "2026-11-02T08:00:00Z", id: "a" }) < 0, "the earlier instant first");
  assert.ok(compareOldestFirst({ at: "2026-11-01T08:00:00Z", id: "a" }, { at: "2026-11-01T08:00:00Z", id: "b" }) < 0, "the id breaks a tie, so two reads agree");
  assert.ok(compareOldestFirst({ at: "2026-11-01T10:00:00+02:00", id: "a" }, { at: "2026-11-01T08:30:00Z", id: "b" }) < 0, "compared as instants — an offset in the text cannot reorder them");
  assert.ok(compareOldestFirst({ at: "", id: "a" }, { at: "2026-11-13T08:00:00Z", id: "b" }) > 0, "🔴 a broken stamp goes last, never to the head of the queue");

  type Row = { id: string; at: string; status: "pending" | "approved" | "rejected" };
  const rows: Row[] = [
    { id: "d1", at: "2026-11-14T05:00:00Z", status: "approved" },
    { id: "w-new", at: "2026-11-13T09:00:00Z", status: "pending" },
    { id: "w-mid", at: "2026-11-08T09:00:00Z", status: "pending" },
    { id: "d2", at: "2026-11-07T09:00:00Z", status: "rejected" },
    { id: "w-old", at: "2026-11-02T15:36:00Z", status: "pending" },
    { id: "d3", at: "2026-10-30T09:00:00Z", status: "approved" },
  ];
  const ordered = waitingOldestFirst(
    rows,
    (row) => row.status === "pending",
    (row) => ({ at: row.at, id: row.id }),
  );
  assert.deepEqual(
    ordered.filter((row) => row.status === "pending").map((row) => row.id),
    ["w-old", "w-mid", "w-new"],
    "🔴 the waiting rows are read oldest first",
  );
  assert.deepEqual(
    ordered.filter((row) => row.status !== "pending").map((row) => row.id),
    ["d1", "d2", "d3"],
    "🔴 and the decided rows keep the order they came in — newest first",
  );
  assert.deepEqual(
    ordered.map((row) => row.status),
    rows.map((row) => row.status),
    "each row keeps the kind of slot it held, so a screen that splits the list by status reads the same split",
  );
  assert.equal(ordered.length, rows.length);
  assert.deepEqual(rows.map((row) => row.id), ["d1", "w-new", "w-mid", "d2", "w-old", "d3"], "the list handed in is not changed");

  // ── The reads and the screens ─────────────────────────────────────────────────────────────────
  const reviews = code("src/lib/phoenix-crm/server/validation-reviews.ts");
  assert.ok(reviews.includes("const reviews = [...reviewById.values()].sort(newestValidatedFirst);"), "the merged read keeps its newest-first order");
  assert.match(
    reviews,
    /const ordered = waitingOldestFirst\(\s*keep,\s*\(row\) => row\.status === "pending",\s*\(row\) => \(\{ at: row\.createdAt, id: row\.reviewId \}\),\s*\);\s*return \{ rows: ordered, capped \};/,
    "🔴 and the waiting reviews are re-ordered oldest first on the way out",
  );
  assert.ok(reviews.includes('waitingText: status === "pending" ? waitingText(String(row.created_at), now) : null,'), "only a waiting review carries a wait");
  assert.ok(reviews.includes('waitingLong: status === "pending" && waitingIsLong(String(row.created_at), now),'));

  const places = code("src/lib/phoenix-crm/server/shared-places.ts");
  assert.ok(places.includes("waitingText: held ? waitingText(base.capturedAt, now) : null,"), "only a HELD building carries a wait");
  const picker = places.slice(places.indexOf("function mapSharedPlace("), places.indexOf("function mapSharedPlace(") + 2_000);
  assert.ok(!picker.includes("waitingText"), "🔴 the row the rep's picker reads carries no wait — the board's row alone does");

  const groups = code("src/lib/phoenix-crm/shared-place-groups.ts");
  assert.ok(
    groups.includes("if (venueNeedsDecision(left)) return compareOldestFirst(waitingSinceOf(left), waitingSinceOf(right));"),
    "🔴 a building with something to decide is ordered by how long it has waited",
  );
  assert.ok(groups.includes('waitingText: state === "waiting" ? (row.waitingText ?? null) : null,'), "a seated customer carries his review's wait only while he waits");

  const pill = '<CrmPill tone={row.waitingLong ? "warn" : "neutral"}>{row.waitingText}</CrmPill>';
  assert.ok(code("src/components/phoenix-crm/validation-review-queue.tsx").includes(`{row.waitingText ? ${pill} : null}`), "the review row shows its wait");
  assert.ok(code("src/components/phoenix-crm/shared-place-list.tsx").includes(`{row.waitingText ? ${pill} : null}`), "the held building shows its wait");
  assert.ok(
    code("src/components/phoenix-crm/shared-place-customers.tsx").includes(
      '{customer.waitingText ? <CrmPill tone={customer.waitingLong ? "warn" : "neutral"}>{customer.waitingText}</CrmPill> : null}',
    ),
    "the waiting seated customer shows his wait",
  );
}
