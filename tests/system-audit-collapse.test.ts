import assert from "node:assert/strict";

import {
  COLLAPSE_GAP_MS,
  MAX_SOURCE_REFS,
  foldOccurrences,
  pageLoadStartMs,
  stillOpen,
  type FoldEvent,
  type OpenOccurrence,
} from "../src/lib/system-audit/collapse.ts";

/**
 * Retries are one operation. The owner's brief counts what happened to a PERSON, so one streamed
 * page that threw 24 times, or a save pressed five times, is one row — and two people are never one.
 */

const BASE = Date.parse("2026-10-20T10:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

function event(id: string, offsetMs: number, overrides: Partial<FoldEvent> = {}): FoldEvent {
  return {
    id,
    createdAt: at(offsetMs),
    actorKey: "hr:b-10",
    signatureKey: "app:v1:aaaaaaaaaaaaaaaa",
    routeFamily: "/employee-portals/field-crm",
    sinceNavMs: null,
    ...overrides,
  };
}

export function runSystemAuditCollapseTests() {
  // ── 24 errors in one page load are ONE occurrence, with one page load ──────────────────────────
  const burst: FoldEvent[] = [];
  for (let index = 0; index < 24; index += 1) {
    // One page loaded at BASE; each throw is `index * 300` ms after it.
    burst.push(event(`burst-${String(index).padStart(2, "0")}`, index * 300, { sinceNavMs: index * 300 }));
  }
  const burstFolded = foldOccurrences(burst);
  assert.equal(burstFolded.length, 1, "24 errors in one page load must fold into ONE occurrence");
  assert.equal(burstFolded[0].attemptCount, 24);
  assert.equal(burstFolded[0].pageLoads, 1, "one page load must count once");
  assert.equal(burstFolded[0].dedupeKey, "app:v1:aaaaaaaaaaaaaaaa:hr:b-10:burst-00");
  assert.equal(burstFolded[0].firstEventAt, at(0));
  assert.equal(burstFolded[0].lastEventAt, at(23 * 300));

  // ── 11 minutes apart is two operations; 9 minutes is one, with two page loads ──────────────────
  const apart = foldOccurrences([event("a1", 0), event("a2", 11 * 60 * 1000)]);
  assert.equal(apart.length, 2, "two errors 11 minutes apart must be TWO occurrences");
  const near = foldOccurrences([event("n1", 0), event("n2", 9 * 60 * 1000)]);
  assert.equal(near.length, 1, "two errors 9 minutes apart must be ONE occurrence");
  assert.equal(near[0].pageLoads, 2, "a server row with no sinceNavMs is its own page load");
  assert.equal(near[0].attemptCount, 2);

  // The gap is measured from the LAST event, so a steady trickle stays one operation.
  const trickle = foldOccurrences([event("t1", 0), event("t2", 8 * 60 * 1000), event("t3", 16 * 60 * 1000)]);
  assert.equal(trickle.length, 1);
  assert.equal(COLLAPSE_GAP_MS, 10 * 60 * 1000);

  // Same page load long after the last event: still the same load (a tab left open).
  const sameLoad = foldOccurrences([
    event("s1", 0, { sinceNavMs: 1_000 }),
    event("s2", 30 * 60 * 1000, { sinceNavMs: 30 * 60 * 1000 + 1_000 }),
  ]);
  assert.equal(sameLoad.length, 1, "one page load is one operation however long the tab stays open");
  assert.equal(sameLoad[0].pageLoads, 1);

  // ── Different people, signatures and route families never merge ────────────────────────────────
  assert.equal(foldOccurrences([event("p1", 0), event("p2", 1_000, { actorKey: "hr:a-1" })]).length, 2, "two people must be TWO occurrences");
  assert.equal(foldOccurrences([event("g1", 0), event("g2", 1_000, { signatureKey: "app:v1:bbbbbbbbbbbbbbbb" })]).length, 2);
  assert.equal(foldOccurrences([event("r1", 0), event("r2", 1_000, { routeFamily: "/admin/visits" })]).length, 2);

  // ── Order does not matter ──────────────────────────────────────────────────────────────────────
  const shuffled = foldOccurrences([event("o3", 2_000), event("o1", 0), event("o2", 1_000)]);
  assert.equal(shuffled.length, 1);
  assert.equal(shuffled[0].dedupeKey.endsWith(":o1"), true, "the key is the FIRST event's, whatever order the rows came in");
  assert.deepEqual(shuffled[0].sourceRefs, ["o1", "o2", "o3"]);

  // ── Source refs are capped ─────────────────────────────────────────────────────────────────────
  const many: FoldEvent[] = [];
  for (let index = 0; index < MAX_SOURCE_REFS + 10; index += 1) many.push(event(`m-${String(index).padStart(3, "0")}`, index * 1_000));
  const capped = foldOccurrences(many);
  assert.equal(capped[0].attemptCount, MAX_SOURCE_REFS + 10);
  assert.equal(capped[0].sourceRefs.length, MAX_SOURCE_REFS);

  // ── Extending what the ledger already holds: only the NEW counts are emitted ───────────────────
  const open: OpenOccurrence[] = [
    {
      dedupeKey: "app:v1:aaaaaaaaaaaaaaaa:hr:b-10:first",
      signatureKey: "app:v1:aaaaaaaaaaaaaaaa",
      actorKey: "hr:b-10",
      routeFamily: "/employee-portals/field-crm",
      occurredAt: at(-5 * 60 * 1000),
      firstEventAt: at(-5 * 60 * 1000),
      lastEventAt: at(-60 * 1000),
      lastPageLoadAt: at(-5 * 60 * 1000),
    },
  ];
  const extended = foldOccurrences([event("x1", 0)], open);
  assert.equal(extended.length, 1);
  assert.equal(extended[0].isExtension, true, "an event 1 minute after the ledger's last must extend it");
  assert.equal(extended[0].dedupeKey, open[0].dedupeKey);
  assert.equal(extended[0].attemptCount, 1, "an extension carries only the new attempts — the ledger adds them");
  assert.equal(extended[0].pageLoads, 1);
  assert.equal(extended[0].occurredAt, open[0].occurredAt, "an extension keeps the occurrence's own start");

  // In the ledger's own page load: 0 new page loads.
  const inKnownLoad = foldOccurrences([event("k1", 3 * 60 * 1000, { sinceNavMs: 8 * 60 * 1000 })], open);
  assert.equal(inKnownLoad[0].isExtension, true);
  assert.equal(inKnownLoad[0].pageLoads, 0, "an event in a page load the ledger already counts adds no page load");

  // Too late to extend: a new occurrence.
  const fresh = foldOccurrences([event("f1", 20 * 60 * 1000)], open);
  assert.equal(fresh[0].isExtension, false);
  assert.equal(fresh[0].dedupeKey.endsWith(":f1"), true);

  // ── Batches fold across their boundary exactly as one fold would ───────────────────────────────
  const all = [event("b1", 0), event("b2", 60_000), event("b3", 120_000), event("b4", 15 * 60 * 1000)];
  const whole = foldOccurrences(all);
  const firstHalf = foldOccurrences(all.slice(0, 2));
  const carried = stillOpen([], firstHalf);
  const secondHalf = foldOccurrences(all.slice(2), carried);
  assert.equal(whole.length, 2);
  assert.equal(secondHalf[0].dedupeKey, firstHalf[0].dedupeKey, "the batch boundary must not split one operation");
  assert.equal(secondHalf[0].isExtension, true);
  assert.equal(firstHalf[0].attemptCount + secondHalf[0].attemptCount, whole[0].attemptCount);
  assert.equal(secondHalf[1].dedupeKey, whole[1].dedupeKey);

  // ── Page-load start ────────────────────────────────────────────────────────────────────────────
  assert.equal(pageLoadStartMs({ createdAt: at(5_000), sinceNavMs: 2_000 }), BASE + 3_000);
  assert.equal(pageLoadStartMs({ createdAt: at(5_000), sinceNavMs: null }), BASE + 5_000);
  assert.equal(pageLoadStartMs({ createdAt: at(5_000), sinceNavMs: -1 }), BASE + 5_000);
}
