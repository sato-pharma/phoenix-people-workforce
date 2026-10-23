import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { permissionMatrix } from "@/lib/auth/permissions.ts";
import { employeePortalNavigationSections } from "@/config/system-navigation.ts";
import { MARKET_AWARENESS_DECIDER_ROLES } from "@/lib/employee-portal/navigation.ts";
import {
  MARKETING_MANAGER_ROLE,
  NATIONAL_SALES_MANAGER_ROLE,
} from "@/lib/market-awareness/approvers.ts";
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

/** Hossam — the Marketing Manager, and the first member of every group below. */
const HOSSAM = { role: "Marketing Manager", hrId: "a-9" } as const;
/** Magdy — National Sales Manager for ANTI INFECTIVE, line 1. */
const MAGDY = { role: "National Sales Manager", hrId: "ai-0008" } as const;
/** Ali — National Sales Manager for PEDIA, line 2. Three people hold that title, one per line. */
const ALI = { role: "National Sales Manager", hrId: "a-12" } as const;
const CEO = { role: "CEO", hrId: "a-1" } as const;
const SUPER_ADMIN = { role: "Super Admin", hrId: "a-99" } as const;

const NOW = "2026-09-07T12:00:00.000Z";
/** 2 days before NOW — inside the 3-day awareness SLA. */
const TWO_DAYS_AGO = "2026-09-05T12:00:00.000Z";
/** 3 days before NOW — on the threshold, which slaTone reads as overdue. */
const THREE_DAYS_AGO = "2026-09-04T12:00:00.000Z";

type BadgeSlot = {
  approverRole: "marketing_manager" | "nsm";
  lineId: number | null;
  assignedHrId: string | null;
  decision: "approve" | "reject" | "return" | null;
};

/** The Marketing Manager's slot and the Anti Infective NSM's — the ordinary two-person group. */
function group(overrides: { mm?: "approve" | null; nsm?: "approve" | null } = {}): BadgeSlot[] {
  return [
    {
      approverRole: "marketing_manager",
      lineId: null,
      assignedHrId: "A-9",
      decision: overrides.mm ?? null,
    },
    { approverRole: "nsm", lineId: 1, assignedHrId: "AI-0008", decision: overrides.nsm ?? null },
  ];
}

function row(overrides: {
  approvers?: BadgeSlot[];
  managerHrId?: string | null;
  openedAt?: string | null;
  status: string;
}) {
  return {
    approvers: overrides.approvers ?? group(),
    managerHrId: overrides.managerHrId === undefined ? null : overrides.managerHrId,
    openedAt: overrides.openedAt === undefined ? TWO_DAYS_AGO : overrides.openedAt,
    status: overrides.status,
  };
}

export function runMarketAwarenessApprovalInboxNavBadgeTests() {
  // ── 1. ONE request counts on TWO badges at once ─────────────────────────────
  // That is the whole shape of the parallel group (owner, 2026-09-09): the Marketing Manager and the
  // line's National Sales Manager are asked at the same time, so the same row is owed by both of
  // them and drops off each badge separately as each answers.
  {
    const rows = [row({ status: "pending_group" })];
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: HOSSAM, now: NOW, rows }).count,
      1,
      "1: the Marketing Manager owes it",
    );
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: MAGDY, actorLineId: 1, now: NOW, rows }).count,
      1,
      "1: and the Anti Infective NSM owes the same one, at the same time",
    );
    // Three people hold the NSM title, one per line. A role check with no line in it would pump
    // orange at all three for a decision only one of them can make.
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: ALI, actorLineId: 2, now: NOW, rows }).count,
      0,
      "1: the PEDIA national sales manager owes nothing on an Anti Infective request",
    );
  }

  // ── 2. A member who has answered stops counting it ─────────────────────────
  // Without this the badge would keep a permanent number on the link of somebody who has already
  // approved, for a request he cannot act on again.
  {
    const rows = [row({ approvers: group({ mm: "approve" }), status: "pending_group" })];
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: HOSSAM, now: NOW, rows }).count,
      0,
      "2: the Marketing Manager has approved, so it is no longer his",
    );
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: MAGDY, actorLineId: 1, now: NOW, rows }).count,
      1,
      "2: it is still the NSM's until he answers — he is the one holding it up",
    );
  }

  // ── 3. HR ids are mixed-case, and the badge must survive it ─────────────────
  // `assigned_hr_id` carries the employee master's real casing while the session id is lower-cased.
  // A raw comparison would return 0 for every activity — a badge silent in exactly the state it
  // exists to announce, and silence is indistinguishable from "nothing is waiting".
  {
    const badge = summarizeMarketAwarenessDecisionBadge({
      access: MAGDY,
      actorLineId: null,
      now: NOW,
      rows: [row({ status: "pending_group" })],
    });
    assert.equal(
      badge.count,
      1,
      "3: 'AI-0008' on the slot and 'ai-0008' in the session are one person, line or no line",
    );
  }

  // ── 4. The CEO step is ROLE-checked, and only for the CEO ───────────────────
  {
    const rows = [row({ approvers: group({ mm: "approve", nsm: "approve" }), status: "pending_ceo" })];
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: CEO, now: NOW, rows }).count,
      1,
      "4: the CEO owes the CEO step",
    );
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: HOSSAM, now: NOW, rows }).count,
      0,
      "4: the group who already approved must not keep counting it — their step is done",
    );
    assert.equal(
      summarizeMarketAwarenessDecisionBadge({ access: SUPER_ADMIN, now: NOW, rows }).count,
      1,
      "4: Super Admin can act on any step",
    );
  }

  // ── 5. `returned` and `on_hold` are in the open queue and belong to NOBODY ──
  // The open view deliberately includes both so a request cannot vanish from every list. Neither has
  // a current step: a returned one is the requester's, and a FROZEN one is waiting on nobody until
  // it is released. Counting either would put a number on an approver's link for work he cannot do.
  {
    const rows = [row({ status: "returned" }), row({ status: "on_hold" })];
    const audience = [
      ["the Marketing Manager", HOSSAM, null],
      ["the NSM", MAGDY, 1],
      ["the CEO", CEO, null],
      ["Super Admin", SUPER_ADMIN, null],
    ] as const;
    for (const [who, access, actorLineId] of audience) {
      assert.equal(
        summarizeMarketAwarenessDecisionBadge({ access, actorLineId, now: NOW, rows }).count,
        0,
        `5: a returned or held activity is never ${who}'s to decide`,
      );
    }
  }

  // ── 6. A slot with an empty seat cannot be claimed by identity ──────────────
  {
    const badge = summarizeMarketAwarenessDecisionBadge({
      access: HOSSAM,
      now: NOW,
      rows: [
        row({
          approvers: [{ approverRole: "nsm", lineId: 1, assignedHrId: null, decision: null }],
          status: "pending_group",
        }),
      ],
    });
    assert.equal(badge.count, 0, "6: an empty seat matches nobody — never everybody");
  }

  // ── 7. Overdue graduates on the awareness SLA ───────────────────────────────
  {
    const inside = summarizeMarketAwarenessDecisionBadge({
      access: HOSSAM,
      now: NOW,
      rows: [row({ openedAt: TWO_DAYS_AGO, status: "pending_group" })],
    });
    assert.equal(inside.count, 1, "7: two days waiting still counts");
    assert.equal(inside.overdue, false, "7: two days waiting against a 3-day SLA is not overdue");

    const breached = summarizeMarketAwarenessDecisionBadge({
      access: HOSSAM,
      now: NOW,
      rows: [row({ openedAt: THREE_DAYS_AGO, status: "pending_group" })],
    });
    assert.equal(breached.overdue, true, "7: three days waiting breaches the 3-day SLA");
  }

  // ── 8. Overdue is ANY of them, and a clock that cannot be read is never late ─
  {
    const mixed = summarizeMarketAwarenessDecisionBadge({
      access: HOSSAM,
      now: NOW,
      rows: [
        row({ openedAt: TWO_DAYS_AGO, status: "pending_group" }),
        row({ openedAt: THREE_DAYS_AGO, status: "pending_group" }),
      ],
    });
    assert.equal(mixed.count, 2, "8: both count");
    assert.equal(mixed.overdue, true, "8: one breach is enough to escalate the badge");

    assert.equal(isDecisionOverdue(null, Date.parse(NOW)), false, "8: no clock is not a late clock");
    assert.equal(
      isDecisionOverdue("not-a-date", Date.parse(NOW)),
      false,
      "8: an unparseable clock is not a late clock",
    );
    assert.equal(
      isDecisionOverdue("2026-09-09T12:00:00.000Z", Date.parse(NOW)),
      false,
      "8: a clock in the future is not a late clock — skew must not paint the badge red",
    );
  }

  // ── 8b. An overdue row somebody else owes never colours YOUR badge ──────────
  // The overdue flag is computed AFTER the ownership filter, never over the raw queue.
  {
    const badge = summarizeMarketAwarenessDecisionBadge({
      access: ALI,
      actorLineId: 2,
      now: NOW,
      rows: [row({ openedAt: THREE_DAYS_AGO, status: "pending_group" })],
    });
    assert.deepEqual(
      badge,
      { count: 0, overdue: false },
      "8b: another line's breach must not light up this person's link",
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
      /market_awareness_activity_approvers\(id, approver_role, line_id, assigned_hr_id, decision\)/,
      "9: the badge reads a named column list with the approvers EMBEDDED — a select-star here is " +
        "a hydrate by another name, and a second query for the slots doubles a 30-second poll",
    );
    assert.ok(
      !/\.select\("\*"\)/.test(badgeFn),
      "9: the badge must never select-star",
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
      /openedAt: row\.step_opened_at \?\? row\.updated_at/,
      "9: the wait is measured from step_opened_at — the moment the CURRENT step opened. " +
        "`updated_at` is stamped by a trigger on EVERY write, so under a parallel group one " +
        "member approving would restart the clock for everyone still to answer",
    );
  }

  // ── 10. The rule reuses the decision route's predicate, not a copy ──────────
  {
    const badgeRule = readFileSync("src/lib/market-awareness/badge.ts", "utf8");
    assert.match(
      badgeRule,
      /canDecideStep\(\{[\s\S]{0,260}approvers: row\.approvers[\s\S]{0,260}\}\)/,
      "10: ownership is decided by the same canDecideStep the decision route enforces, over the " +
        "same slots — a badge built from its own predicate shows a number its inbox cannot explain",
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
    const badgeCountsRoute = readFileSync("src/lib/approvals-hub/badge-counts-payload.ts", "utf8");
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

  // ── 15. Every slot holder can reach the queue AND answer it ────────────────
  //
  // The parallel group (#3573) made the National Sales Manager an approver on every activity that
  // touches his line, and three surfaces were left behind: the permission matrix, the portal
  // sidebar and the seed nav. The result was the worst shape a queue can take — he was routed
  // decisions, notified about them, counted on the badge he could not see, and refused by the
  // decision route if he ever reached the page. Owner, 2026-09-09: "the nsm now have a role is
  // awareness approval but he doesnot have a place to approve like marketing manager."
  //
  // Derived from the slot roles rather than hard-coded, so adding a third kind of approver to
  // MARKET_AWARENESS_APPROVER_ROLES fails here until its seat can both open the inbox and answer.
  {
    const slotHolderRoles = [MARKETING_MANAGER_ROLE, NATIONAL_SALES_MANAGER_ROLE] as const;

    for (const role of slotHolderRoles) {
      const grants = permissionMatrix[role]?.market_awareness ?? [];
      assert.ok(
        grants.includes("approve"),
        `15: ${role} holds a slot in the approval group, so the matrix must grant market_awareness:approve — decideActivity asserts it before canDecideSlot is ever reached`,
      );
      assert.ok(
        MARKET_AWARENESS_DECIDER_ROLES.includes(role),
        `15: ${role} must be offered the Awareness Approvals inbox — this list is what draws the link in the portal shell`,
      );
    }

    // And the seeds, which are a second copy of the same list. They do not draw the portal link,
    // but a role missing from them is missing from every audit that reads the seeds as the truth.
    const inboxItem = employeePortalNavigationSections
      .flatMap((section) => section.items)
      .find((item) => item.href === "/employee-portals/market-awareness/inbox");
    assert.ok(inboxItem, "15: the Awareness Approvals nav seed must still exist");
    for (const role of slotHolderRoles) {
      assert.ok(
        inboxItem?.roles?.includes(role),
        `15: the Awareness Approvals nav seed must list ${role}, in step with MARKET_AWARENESS_DECIDER_ROLES`,
      );
    }
  }
}
