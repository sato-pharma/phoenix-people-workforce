import assert from "node:assert/strict";

import { assignablePhoenixRoles, createAccessContext, permissionMatrix } from "../src/lib/auth/permissions.ts";
import { getOperationalRecentActivity } from "../src/lib/operations/events.ts";
import { withPostgrestStandIn, type Row, type StandIn } from "./support/postgrest-stand-in.ts";

// REC-079 (phase 2): src/lib/operations — the business activity feed on the admin landing — run.
//
// getOperationalRecentActivity reads payroll batch movements and sales import decisions from the
// shared in-memory PostgREST. Its main rule (23 Oct 2026):
//
//   1. A source that cannot be read is NAMED in staleSources — a payroll or sales outage must never
//      look like a quiet day — and the other source still shows.
//   2. Test fixtures never reach the feed or its counts, and the 24-hour counts are read over the
//      whole window, failures counted by their status.
//   3. A viewer reads only the sources their grants open: no payroll read without payroll:read.

const MINUTES = 60 * 1000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTES).toISOString();

function world(): Record<string, Row[]> {
  return {
    sales_audit_logs: [
      { action: "import.approved", actor_display_name: "Stand-in Analyst", actor_username: "analyst", created_at: ago(30), id: "s1", line: "CNS", period: "2026-10" },
      // A disposable fixture: its period sits in the far future the fixture suites write.
      { action: "import.rejected", actor_display_name: "Fixture", actor_username: "fixture", created_at: ago(10), id: "s2", line: "CNS", period: "2099-01" },
    ],
    salary_batches: [
      { approved_at: ago(20), approved_by: "B-10", created_at: ago(300), id: "p1", month: 10, status: "approved", updated_at: ago(20), uploaded_by: "HR-9", year: 2026 },
      { approved_at: null, approved_by: null, created_at: ago(200), id: "p2", month: 9, status: "rejected", updated_at: ago(60), uploaded_by: "HR-9", year: 2026 },
      // A disposable fixture: a year the fixture suites own.
      { approved_at: null, approved_by: null, created_at: ago(5), id: "p3", month: 1, status: "uploaded", updated_at: ago(5), uploaded_by: "phase-21 fixture", year: 2099 },
      // Older than a day: in the newest list, never in the 24-hour counts.
      { approved_at: null, approved_by: null, created_at: ago(3 * 24 * 60), id: "p4", month: 8, status: "locked", updated_at: ago(3 * 24 * 60), uploaded_by: "HR-9", year: 2026 },
    ],
  };
}

const OWNER = createAccessContext({ hrId: "B-10", loginId: "b-10", role: "Super Admin", source: "session" });

export async function runOperationsActivityFeedBehaviourTests(): Promise<void> {
  // ── 2. Fixtures out, counts over the window ────────────────────────────────────────────────────
  await withPostgrestStandIn({ tables: world() }, async () => {
    const feed = await getOperationalRecentActivity(OWNER, { limit: 10 });
    assert.deepEqual(feed.staleSources, [], "both sources read");
    assert.deepEqual(
      feed.recent.map((event) => event.description),
      ["Payroll approved for 10/2026", "Sales batch approved for 2026-10", "Payroll rejected for 9/2026", "Payroll locked for 8/2026"],
      "HEADLINE: newest first, and no test fixture reaches the business feed",
    );
    assert.equal(feed.totalEvents24h, 3, "three real events inside the day; the fixtures and the three-day-old batch are not counted");
    assert.equal(feed.failureCount24h, 1, "the rejected payroll batch is the day's one failure");
    assert.equal(feed.lastEventAt, feed.recent[0].timestamp);
  });

  // ── 1. A source that cannot be read is named, and the other still shows ─────────────────────────
  const unreadable: StandIn = {
    failReads: { salary_batches: { body: { code: "XX000", message: "stand-in read failure" }, status: 500 } },
    tables: world(),
  };
  await withPostgrestStandIn(unreadable, async () => {
    const feed = await getOperationalRecentActivity(OWNER, { limit: 10 });
    assert.deepEqual(feed.staleSources, ["Payroll"], "HEADLINE: a payroll outage is named once, never a quiet day");
    assert.deepEqual(feed.recent.map((event) => event.module), ["Sales"], "the sales events still show");
    assert.equal(feed.totalEvents24h, 1, "and only what was read is counted");
  });

  // ── 3. Only the sources the viewer's grants open ───────────────────────────────────────────────
  const blind = assignablePhoenixRoles.find(
    (role) => !(permissionMatrix[role].payroll ?? []).includes("read") && !(permissionMatrix[role].sales ?? []).includes("read"),
  );
  assert.ok(blind, "precondition: at least one seat holds neither payroll:read nor sales:read");
  await withPostgrestStandIn({ tables: world() }, async (seen) => {
    const viewer = createAccessContext({ hrId: "STAND-IN-O", loginId: "stand.in.ops", role: blind, source: "session" });
    const feed = await getOperationalRecentActivity(viewer, { limit: 10 });
    assert.deepEqual(feed.recent, [], `${blind} sees no payroll or sales activity`);
    assert.deepEqual(feed.staleSources, [], "and that is not an outage");
    assert.equal(
      seen.filter((entry) => entry.table === "salary_batches" || entry.table === "sales_audit_logs").length,
      0,
      `HEADLINE: neither source is even read for ${blind}`,
    );
  });
}
