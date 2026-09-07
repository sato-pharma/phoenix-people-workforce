import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isDecisionOverdue,
  summarizeMarketAwarenessDecisionBadge,
} from "@/lib/market-awareness/badge.ts";

/**
 * Awareness Approvals nav badge.
 *
 * The inbox shipped (#3406) with a link and nothing on it. Four siblings sit beside it in Approvals
 * Hub — Leave, Excuse, Plan, Marketing — and every one carries a live pending count, while this one
 * gave no sign at all that a decision was waiting behind it; an approver had to open the page on the
 * off-chance. Owner, 2026-09-07: "the awareness inbox doesnt show any sign when it have
 * notifications."
 *
 * This pins BOTH halves: the counting RULE (whose decisions, and when they are late) and the
 * end-to-end WIRING — because a rule with no wiring is a badge that never renders, and wiring with
 * no rule is a badge that counts the wrong thing.
 */

/** Rasha — a Group Product Manager, and the manager step on the rows below is routed to her. */
const RASHA = { role: "Group Product Manager", hrId: "a-8" } as const;
/** Hossam — also a Group Product Manager, and in nobody's chain here. */
const HOSSAM = { role: "Group Product Manager", hrId: "a-12" } as const;
const CEO = { role: "CEO", hrId: "a-1" } as const;
const SUPER_ADMIN = { role: "Super Admin", hrId: "a-99" } as const;

const NOW = "2026-09-07T12:00:00.000Z";
/** 2 days before NOW — inside the 3-day awareness SLA. */
const TWO_DAYS_AGO = "2026-09-05T12:00:00.000Z";
/** 3 days before NOW — on the threshold, which slaTone reads as overdue. */
const THREE_DAYS_AGO = "2026-09-04T12:00:00.000Z";

function row(overrides: { managerHrId?: string | null; openedAt?: string | null; status: string }) {
  return {
    managerHrId: overrides.managerHrId === undefined ? "A-8" : overrides.managerHrId,
    openedAt: overrides.openedAt === undefined ? TWO_DAYS_AGO : overrides.openedAt,
    status: overrides.status,
  };
}

export function runMarketAwarenessApprovalInboxNavBadgeTests() {
  // ── 1. The manager step is IDENTITY-checked, so the badge is too ────────────
  // Two Group Product Managers, one pending activity: the count is 1 for the one it was routed to
  // and 0 for the other. A role-checked badge would pump orange at every GPM in the company for a
  // decision only one of them can make — and the inbox behind it would then be empty, which reads
  // as a broken badge rather than as somebody else's work.
  {
    const rows = [row({ status: "pending_manager" })];
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: RASHA, now: NOW, rows }).count,
      1,
      "1: the manager the activity was routed to owes the decision",
    );
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: HOSSAM, now: NOW, rows }).count,
      0,
      "1: another manager of the same rank owes nothing — the step is identity-checked",
    );
  }

  // ── 2. HR ids are mixed-case, and the badge must survive it ─────────────────
  // `manager_hr_id` carries the employee master's real casing while the session id is lower-cased.
  // A raw comparison here would return 0 for every activity — a badge silent in exactly the state
  // it exists to announce, and silence is indistinguishable from "nothing is waiting".
  {
    const badge = summarizeMarketAwarenessDecisionBadge({
      access: RASHA,
      now: NOW,
      rows: [row({ managerHrId: "A-8", status: "pending_manager" })],
    });
    assert.equal(badge.count, 1, "2: 'A-8' on the row and 'a-8' in the session are one person");
  }

  // ── 3. The CEO step is ROLE-checked, and only for the CEO ───────────────────
  {
    const rows = [row({ status: "pending_ceo" })];
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: CEO, now: NOW, rows }).count,
      1,
      "3: the CEO owes the CEO step",
    );
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: RASHA, now: NOW, rows }).count,
      0,
      "3: the manager who already approved must not keep counting it — her step is done",
    );
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: SUPER_ADMIN, now: NOW, rows }).count,
      1,
      "3: Super Admin can act on any step",
    );
  }

  // ── 4. `returned` is in the open queue and belongs to NOBODY's badge ────────
  // The inbox's open view deliberately includes `returned` so the requester can see it come back.
  // It has no current step, so it is the requester's to act on — counting it would put a permanent
  // number on an approver's link for work that is not theirs and that they cannot clear.
  {
    const rows = [row({ status: "returned" }), row({ managerHrId: null, status: "returned" })];
    const audience = [
      ["Rasha", RASHA],
      ["the CEO", CEO],
      ["Super Admin", SUPER_ADMIN],
    ] as const;
    for (const [who, access] of audience) {
      assert.equal(
        summarizeMarketAwarenessDecisionBadge({ access, now: NOW, rows }).count,
        0,
        `4: a returned activity is the requester's, never ${who}'s`,
      );
    }
  }

  // ── 5. A row with no manager on it cannot be claimed by identity ────────────
  {
    const badge = summarizeMarketAwarenessDecisionBadge({
      access: RASHA,
      now: NOW,
      rows: [row({ managerHrId: null, status: "pending_manager" })],
    });
    assert.equal(badge.count, 0, "5: a null manager matches nobody — never everybody");
  }

  // ── 6. Overdue graduates on the awareness SLA ───────────────────────────────
  {
    const inside = summarizeMarketAwarenessDecisionBadge({
      access: RASHA,
      now: NOW,
      rows: [row({ openedAt: TWO_DAYS_AGO, status: "pending_manager" })],
    });
    assert.equal(inside.count, 1, "6: two days waiting still counts");
    assert.equal(inside.overdue, false, "6: two days waiting against a 3-day SLA is not overdue");

    const breached = summarizeMarketAwarenessDecisionBadge({
      access: RASHA,
      now: NOW,
      rows: [row({ openedAt: THREE_DAYS_AGO, status: "pending_manager" })],
    });
    assert.equal(breached.overdue, true, "6: three days waiting breaches the 3-day SLA");
  }

  // ── 7. Overdue is ANY of them, and a clock that cannot be read is never late ─
  {
    const mixed = summarizeMarketAwarenessDecisionBadge({
      access: RASHA,
      now: NOW,
      rows: [
        row({ openedAt: TWO_DAYS_AGO, status: "pending_manager" }),
        row({ openedAt: THREE_DAYS_AGO, status: "pending_manager" }),
      ],
    });
    assert.equal(mixed.count, 2, "7: both count");
    assert.equal(mixed.overdue, true, "7: one breach is enough to escalate the badge");

    assert.equal(isDecisionOverdue(null, Date.parse(NOW)), false, "7: no clock is not a late clock");
    assert.equal(
      isDecisionOverdue("not-a-date", Date.parse(NOW)),
      false,
      "7: an unparseable clock is not a late clock",
    );
    assert.equal(
      isDecisionOverdue("2026-09-09T12:00:00.000Z", Date.parse(NOW)),
      false,
      "7: a clock in the future is not a late clock — skew must not paint the badge red",
    );
  }

  // ── 8. An overdue row somebody else owes never colours YOUR badge ───────────
  // The overdue flag is computed AFTER the ownership filter, never over the raw queue.
  {
    const badge = summarizeMarketAwarenessDecisionBadge({
      access: HOSSAM,
      now: NOW,
      rows: [row({ managerHrId: "A-8", openedAt: THREE_DAYS_AGO, status: "pending_manager" })],
    });
    assert.deepEqual(
      badge,
      { count: 0, overdue: false },
      "8: a stranger's breach must not light up this person's link",
    );
  }

  // ── 9. The service reads the queue itself, not the hydrating list ───────────
  // listDecisionInbox hydrates every row — six further queries plus the employee lookups — to
  // produce a number that needs three columns, and this is polled every 30s by every open tab.
  // What it must NOT do is grow its own idea of who is in the queue: same statuses, same narrowing.
  {
    const service = readFileSync("src/lib/market-awareness/service.ts", "utf8");
    const badgeFn = service.slice(
      service.indexOf("export async function getMarketAwarenessDecisionBadge"),
      service.indexOf("export async function listActivityComments"),
    );
    assert.ok(badgeFn.length > 0, "9: getMarketAwarenessDecisionBadge must exist in the service");
    assert.match(
      badgeFn,
      /\.select\("status, manager_hr_id, updated_at"\)/,
      "9: the badge reads three columns — a select-star here is a hydrate by another name",
    );
    assert.match(
      badgeFn,
      /\.in\("status", OPEN_STATUSES\)/,
      "9: the badge must reuse the inbox's own status set, never a second copy of it",
    );
    assert.match(
      badgeFn,
      /ownActivityFilter\(visibility\)/,
      "9: the badge must reuse the inbox's own visibility narrowing",
    );
    assert.match(
      badgeFn,
      /summarizeMarketAwarenessDecisionBadge\(/,
      "9: the count must come from the shared rule, not a filter rewritten inline here",
    );
    assert.ok(
      !/listDecisionInbox|listInbox\(/.test(badgeFn),
      "9: the badge must not go through the hydrating list — that is six extra queries every 30s",
    );
    assert.match(
      badgeFn,
      /assertPermission\(access, "market_awareness", "read"\)/,
      "9: the badge asserts the module's own read permission before it queries anything",
    );
    assert.match(
      badgeFn,
      /openedAt: row\.updated_at/,
      "9: the wait is measured from updated_at — the moment the CURRENT step opened. From " +
        "submitted_at the CEO would inherit a clock the manager had already half spent",
    );
  }

  // ── 10. The rule reuses the decision route's predicate, not a copy ──────────
  {
    const badgeRule = readFileSync("src/lib/market-awareness/badge.ts", "utf8");
    assert.match(
      badgeRule,
      /canDecideStep\(\{ access: input\.access, managerHrId: row\.managerHrId, step \}\)/,
      "10: ownership is decided by the same canDecideStep the decision route enforces",
    );
    assert.match(
      badgeRule,
      /APPROVALS_SLA_THRESHOLDS\.marketAwareness/,
      "10: overdue reuses the shared SLA vocabulary, not a hardcoded number",
    );
    const thresholds = readFileSync("src/components/approvals-hub/sla-thresholds.ts", "utf8");
    assert.match(
      thresholds,
      /marketAwareness: 3/,
      "10: the awareness approval SLA is 3 days, declared beside its siblings",
    );
  }

  // ── 11. The badge kind exists and the nav item carries it ───────────────────
  {
    const navigation = readFileSync("src/config/system-navigation.ts", "utf8");
    assert.match(
      navigation,
      /navBadge\?:[^;]*"market-awareness-approvals-pending"/,
      "11: system-navigation must declare the awareness badge kind",
    );
    const itemStart = navigation.indexOf('href: "/employee-portals/market-awareness/inbox"');
    assert.ok(itemStart > 0, "11: the Awareness Approvals nav item must still be in the seeds");
    const inboxItem = navigation.slice(itemStart, itemStart + 1600);
    assert.match(
      inboxItem,
      /navBadge: "market-awareness-approvals-pending"/,
      "11: the Awareness Approvals nav item must carry the badge — this is the whole bug",
    );
  }

  // ── 12. Every shell renders it through the ONE shared badge pump ────────────
  {
    const navBadge = readFileSync("src/components/layout/nav-badge.tsx", "utf8");
    assert.match(
      navBadge,
      /case "market-awareness-approvals-pending":\s*\n\s*return <NavBadge[^>]*src="\/api\/market-awareness\/pending-count"[^>]*\/>;/,
      "12: the shared badge switch must resolve the awareness badge to its count API",
    );
    const portalLayout = readFileSync(
      "src/components/employee-portal/employee-portal-layout.tsx",
      "utf8",
    );
    assert.match(
      portalLayout,
      /navBadge: "market-awareness-approvals-pending" as const/,
      "12: the portal layout's own nav list must set the badge on its Awareness Approvals item",
    );
    assert.match(
      portalLayout,
      /<NavBadge src="\/api\/market-awareness\/pending-count" \/>/,
      "12: the portal must reuse the exported NavBadge against the same API — no second mechanism",
    );
  }

  // ── 13. It rides the existing batched poll, not a seventh 30s request ───────
  {
    const navBadgeStore = readFileSync("src/lib/nav-badge-store.ts", "utf8");
    assert.match(
      navBadgeStore,
      /"\/api\/market-awareness\/pending-count": "marketAwareness"/,
      "13: the awareness src must be batched, or it costs an extra HTTP request every 30s per tab",
    );
    const badgeCountsRoute = readFileSync("app/api/approvals/badge-counts/route.ts", "utf8");
    assert.match(
      badgeCountsRoute,
      /getMarketAwarenessDecisionBadge\(access\)/,
      "13: the batched endpoint must actually produce the slot the store now reads",
    );
    assert.match(
      badgeCountsRoute,
      /marketAwareness:\s*\n?\s*marketAwareness\.status === "fulfilled" \? marketAwareness\.value : \{ count: 0, overdue: false \}/,
      "13: a failing awareness count must fall back like every other domain, never blank the others",
    );
  }

  // ── 14. The dedicated endpoint exists, is registered, and cannot break a poll ─
  {
    const route = readFileSync("app/api/market-awareness/pending-count/route.ts", "utf8");
    assert.match(
      route,
      /getMarketAwarenessDecisionBadge\(access\)/,
      "14: the endpoint must serve the domain badge, not build its own count",
    );
    assert.match(
      route,
      /catch\s*\{[\s\S]*?count: 0, overdue: false/,
      "14: a refusal must render as an unbadged link, never as a broken poll",
    );
    const registry = readFileSync("src/lib/security/access-registry.ts", "utf8");
    const pendingCountEntry = registry.indexOf('pattern: "/api/market-awareness/pending-count"');
    assert.ok(pendingCountEntry > 0, "14: the count endpoint must be in the access registry");
    assert.ok(
      pendingCountEntry < registry.indexOf('pattern: "/api/market-awareness/:activityId"'),
      "14: it is a literal segment and must be registered before the :activityId patterns",
    );
    assert.match(
      registry.slice(pendingCountEntry, pendingCountEntry + 220),
      /resource: "market_awareness", action: "read"/,
      "14: the count is gated exactly like the inbox it counts",
    );
  }
}
