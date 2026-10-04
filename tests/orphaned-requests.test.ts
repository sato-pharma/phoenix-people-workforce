import assert from "node:assert/strict";

import {
  selectOrphanedRequests,
  summarizeOrphans,
  type OrphanedActorRecord,
  type OrphanedRequestCandidate,
} from "../src/lib/approvals/orphaned-requests.ts";
import { needsYouAdapters } from "../src/lib/needs-you/sources.ts";
import {
  needsYouDestinations,
  needsYouSourceIds,
  needsYouSourceLabels,
} from "../src/lib/needs-you/types.ts";

/**
 * The orphaned-request detector — a request stranded because the one person who must act next has
 * left. The rule whose wrong answer has a cost is PURE here (the reader just feeds it rows), so it is
 * checkable without a database.
 *
 * WHAT EACH ASSERTION CATCHES, in the words of the change that would break it:
 *
 *  1. A resigned actor is flagged — including through a casing difference, because `assigned_hr_id`
 *     keeps the master's own casing and a bare `===` would miss `b-23` vs `B-23`.
 *  2. An ACTIVE actor is not flagged — the whole point is "cannot act", and a returned request with an
 *     active rep is simply pending that rep, not stranded.
 *  3. A role rung (null actor) is never flagged — a direct-order role rung resolves its approver by
 *     role at decision time, so one departure never strands it.
 *  4. An actor the master does not hold is left ALONE — this detects a KNOWN departure, never guesses
 *     one from a missing row, because a false "stuck" sends him to a cleanup that is not needed.
 *  5. Grouping is by (module, reason), dedupes the people, and keeps the OLDEST timestamp — so the
 *     board shows one row per kind, aged by the request that has waited longest.
 *  6. The source is wired into the Needs You board in all four places (id, label, destination,
 *     adapter), so it actually reaches the morning digest and the board rather than only existing.
 */
export function runOrphanedRequestsTests() {
  const actors = new Map<string, OrphanedActorRecord>([
    ["B-23", { name: "Yehya Mohamed", employmentStatus: "resigned" }],
    ["B-99", { name: "Active Rep", employmentStatus: "active" }],
    ["A-2", { name: "Khaled Bedair", employmentStatus: "active" }],
  ]);

  const candidates: OrphanedRequestCandidate[] = [
    { module: "direct-order", requestKey: "do-1", status: "returned", actorRole: "requester", actorHrId: "B-23", oldestAt: "2026-08-13T00:00:00.000Z" },
    { module: "direct-order", requestKey: "do-2", status: "returned", actorRole: "requester", actorHrId: "B-23", oldestAt: "2026-08-12T00:00:00.000Z" },
    // Active rep — pending him, not stranded.
    { module: "direct-order", requestKey: "do-3", status: "returned", actorRole: "requester", actorHrId: "B-99", oldestAt: "2026-08-20T00:00:00.000Z" },
    // Active approver — not stranded.
    { module: "marketing", requestKey: "mk-1", status: "pending_approval", actorRole: "approver", actorHrId: "A-2", oldestAt: "2026-09-01T00:00:00.000Z" },
    // Role rung, no named person — never orphaned by one departure.
    { module: "marketing", requestKey: "mk-2", status: "pending_approval", actorRole: "approver", actorHrId: null, oldestAt: "2026-09-02T00:00:00.000Z" },
    // Actor not in the master — left alone.
    { module: "vacation", requestKey: "vac-1", status: "pending_manager", actorRole: "approver", actorHrId: "GONE", oldestAt: "2026-09-03T00:00:00.000Z" },
    // Lowercase casing of a resigned actor — must still be flagged.
    { module: "marketing", requestKey: "mk-3", status: "returned", actorRole: "requester", actorHrId: "b-23", oldestAt: "2026-07-01T00:00:00.000Z" },
  ];

  // ── 1–4. The decision ──────────────────────────────────────────────────────────────────────────
  const orphans = selectOrphanedRequests(candidates, actors);
  assert.deepEqual(
    orphans.map((orphan) => orphan.requestKey).sort(),
    ["do-1", "do-2", "mk-3"],
    "Only the three requests whose next actor the master reports as resigned may be flagged: the two " +
      "direct orders and the marketing request on B-23 (one of them keyed lowercase). An active rep, " +
      "an active approver, a role rung with no named person, and an actor the master does not hold are " +
      "every one of them NOT stranded, and a change that flags any of them sends him to a cleanup that " +
      "is not needed.",
  );
  for (const orphan of orphans) {
    assert.equal(orphan.actorName, "Yehya Mohamed", "The orphan must carry the actor's NAME, never an id — the board prints names.");
    assert.equal(orphan.employmentStatus, "resigned");
  }

  // ── 5. Grouping ──────────────────────────────────────────────────────────────────────────────────
  const groups = summarizeOrphans(orphans).sort((a, b) => `${a.module}:${a.actorRole}`.localeCompare(`${b.module}:${b.actorRole}`));
  assert.equal(groups.length, 2, "Two (module, reason) groups: direct-order/requester and marketing/requester.");

  const direct = groups.find((group) => group.module === "direct-order");
  assert.equal(direct?.count, 2);
  assert.deepEqual(direct?.people, ["Yehya Mohamed"], "One resigned rep behind both direct orders — named once, not twice.");
  assert.equal(
    direct?.oldestAt,
    "2026-08-12T00:00:00.000Z",
    "The group ages on its OLDEST request, not the one that happened to be read first.",
  );

  const marketing = groups.find((group) => group.module === "marketing");
  assert.equal(marketing?.count, 1);
  assert.equal(marketing?.oldestAt, "2026-07-01T00:00:00.000Z");

  // An empty input is an empty board, not a thrown error.
  assert.deepEqual(summarizeOrphans([]), [], "No orphans is a clean, empty summary.");

  // ── 6. Wired into the Needs You board, all four places ──────────────────────────────────────────
  assert.ok(
    (needsYouSourceIds as readonly string[]).includes("orphaned-requests"),
    "The source id must be in the closed union, or classify.ts never walks it and the board cannot carry it.",
  );
  assert.ok(
    needsYouSourceLabels["orphaned-requests"]?.trim().length,
    "The source needs a human label for the every-source band and the amber 'could not be read' row.",
  );
  assert.ok(
    needsYouDestinations["orphaned-requests"]?.href.startsWith("/"),
    "The source needs a default destination for the amber row.",
  );
  assert.ok(
    needsYouAdapters.some((adapter) => adapter.id === "orphaned-requests"),
    "An id with no adapter renders as a permanent amber row nobody can clear — the adapter must exist.",
  );
}
