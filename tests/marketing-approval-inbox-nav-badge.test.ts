import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeMarketingApproverBadge } from "@/lib/marketing-requests/service.ts";

/**
 * Marketing Approval Inbox sidebar badge.
 *
 * The nav item carried a comment promising it was pulled onto its own tab so it would be "visible
 * at a glance with its pending badge" — but it had no navBadge, and no supported badge kind could
 * ever have covered it: marketing is deliberately excluded from the consolidated approvals hub
 * (app/api/approvals-hub/hub-data/route.ts), so "approvals-hub-pending" counts everything EXCEPT
 * this inbox. This pins both halves of the fix — the counting RULE and the end-to-end WIRING.
 */

const REQUEST_A = "11111111-1111-1111-1111-111111111111";
const REQUEST_B = "22222222-2222-2222-2222-222222222222";
const REQUEST_C = "33333333-3333-3333-3333-333333333333";

const NOW = "2026-08-04T12:00:00.000Z";
/** 3 days before NOW — past the 2-day SLA every production step actually carries. */
const THREE_DAYS_AGO = "2026-08-01T12:00:00.000Z";
/** 1 day before NOW — inside a 2-day SLA. */
const ONE_DAY_AGO = "2026-08-03T12:00:00.000Z";

function step(overrides: {
  createdAt?: string | null;
  requestId: string;
  stepCode?: string;
  updatedAt?: string | null;
  workflowStepId?: number | null;
}) {
  return {
    createdAt: overrides.createdAt ?? ONE_DAY_AGO,
    requestId: overrides.requestId,
    stepCode: overrides.stepCode ?? "manager_chain",
    updatedAt: overrides.updatedAt === undefined ? ONE_DAY_AGO : overrides.updatedAt,
    workflowStepId: overrides.workflowStepId === undefined ? 2 : overrides.workflowStepId,
  };
}

/** Mirrors production: every marketing_workflow_steps row carries default_sla_days = 2. */
const SLA_BY_ID = new Map<number, number | null>([[2, 2]]);
const SLA_BY_CODE = new Map<string, number | null>([["manager_chain", 2]]);

export function runMarketingApprovalInboxNavBadgeTests() {
  // ── 1. The count is the gating rows, and only the gating rows ───────────────
  // getApproverPendingRequests returns three buckets. `advisoryRows` are CC comments (explicitly
  // non-blocking) and `upcomingRows` are steps that have not opened yet — neither is this person's
  // decision, so a badge that counted them would pump orange at someone with nothing to do. The
  // reducer is fed ONLY gating steps by getMarketingApproverBadge (status='current', is_cc=false),
  // which is the assertion the query below re-pins at source level.
  {
    const badge = summarizeMarketingApproverBadge({
      gatingSteps: [step({ requestId: REQUEST_A }), step({ requestId: REQUEST_B })],
      liveRequestIds: [REQUEST_A, REQUEST_B],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(badge.count, 2, "1: every gating step whose request is still live counts");
  }

  // ── 2. A gating step whose request has left pending_approval does NOT count ──
  // getApproverPendingRequests builds its row set from requests filtered on status
  // 'pending_approval' and drops any step whose request is missing, so a badge counting the raw
  // step rows would show a number the inbox itself cannot explain.
  {
    const badge = summarizeMarketingApproverBadge({
      gatingSteps: [
        step({ requestId: REQUEST_A }),
        step({ requestId: REQUEST_B }),
        step({ requestId: REQUEST_C }),
      ],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(
      badge.count,
      1,
      "2: only steps whose request is still pending_approval count — the badge must match the inbox it labels",
    );
  }

  // ── 3. Overdue graduates on the step's OWN default_sla_days ─────────────────
  {
    const inside = summarizeMarketingApproverBadge({
      gatingSteps: [step({ requestId: REQUEST_A, updatedAt: ONE_DAY_AGO })],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(inside.overdue, false, "3: 1 day waiting against a 2-day SLA is not overdue");

    const breached = summarizeMarketingApproverBadge({
      gatingSteps: [step({ requestId: REQUEST_A, updatedAt: THREE_DAYS_AGO })],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(breached.overdue, true, "3: 3 days waiting against a 2-day SLA breaches it");
  }

  // ── 4. Overdue is measured from the step's last status change, not creation ─
  // `updated_at` is stamped when a step is made `current` (including on resubmission of a returned
  // request), which is the same "waiting since" clock the daily SLA scan uses — so a reassigned or
  // resumed step does not arrive pre-breached against whoever inherits it.
  {
    const badge = summarizeMarketingApproverBadge({
      gatingSteps: [step({ createdAt: THREE_DAYS_AGO, requestId: REQUEST_A, updatedAt: ONE_DAY_AGO })],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(
      badge.overdue,
      false,
      "4: a step made current 1 day ago is not overdue just because its row was created 3 days ago",
    );
  }

  // ── 5. A missing SLA suppresses the alarm — it never reads as a 0-day SLA ───
  // default_sla_days is nullable. Treating null as 0 would make every request instantly overdue,
  // i.e. absent data rendering as the loudest possible state.
  {
    const badge = summarizeMarketingApproverBadge({
      gatingSteps: [step({ requestId: REQUEST_A, updatedAt: THREE_DAYS_AGO, workflowStepId: 99 })],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: new Map<string, number | null>([["manager_chain", null]]),
      slaDaysByWorkflowStepId: new Map<number, number | null>([[99, null]]),
    });
    assert.equal(badge.count, 1, "5: a null SLA must not affect the count");
    assert.equal(badge.overdue, false, "5: a null default_sla_days must not be read as a 0-day SLA");
  }

  // ── 6. Overdue is ANY breached row, and dropped rows cannot raise the alarm ─
  {
    const mixed = summarizeMarketingApproverBadge({
      gatingSteps: [
        step({ requestId: REQUEST_A, updatedAt: ONE_DAY_AGO }),
        step({ requestId: REQUEST_B, updatedAt: THREE_DAYS_AGO }),
      ],
      liveRequestIds: [REQUEST_A, REQUEST_B],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(mixed.overdue, true, "6: one breached row is enough to graduate the whole badge");

    const breachedButDead = summarizeMarketingApproverBadge({
      gatingSteps: [
        step({ requestId: REQUEST_A, updatedAt: ONE_DAY_AGO }),
        step({ requestId: REQUEST_B, updatedAt: THREE_DAYS_AGO }),
      ],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(
      breachedButDead.overdue,
      false,
      "6: a step excluded from the count must not still turn the badge red",
    );
  }

  // ── 7. Nothing assigned → no badge at all ───────────────────────────────────
  {
    const badge = summarizeMarketingApproverBadge({
      gatingSteps: [],
      liveRequestIds: [],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.deepEqual(badge, { count: 0, overdue: false }, "7: an approver with nothing waiting gets no badge");
  }

  // ── 8. The query behind the reducer selects the gating rows and nothing else ─
  const service = readFileSync("src/lib/marketing-requests/service.ts", "utf8");
  const badgeQuery = service.slice(
    service.indexOf("export async function getMarketingApproverBadge"),
    service.indexOf("export type MarketingOverviewMetrics"),
  );
  assert.ok(badgeQuery.length > 0, "8: getMarketingApproverBadge must exist in the marketing service");
  assert.match(
    badgeQuery,
    /\.eq\("status", "current"\)[\s\S]{0,80}\.eq\("is_cc", false\)/,
    "8: the badge query must take only current, non-CC steps — CC comments are non-blocking",
  );
  assert.match(
    badgeQuery,
    /\.in\("assigned_hr_id", actorHrKeys\)/,
    "8: the badge must be scoped to the actor's own HR_ID dialects, or it counts a stranger's rung",
  );
  assert.match(
    badgeQuery,
    /\.eq\("status", "pending_approval"\)/,
    "8: the badge must confirm the request is still pending_approval, exactly as the inbox does",
  );

  // ── 9. The badge kind exists and both nav items carry it ────────────────────
  const navigation = readFileSync("src/config/system-navigation.ts", "utf8");
  assert.match(
    navigation,
    /navBadge\?:[^;]*"marketing-approvals-pending"/,
    "9: system-navigation must declare the marketing badge kind",
  );
  // Bounded by the END OF ITS OWN ROW, not by the next marketing href. It was sliced to
  // /admin/marketing-requests/all until 2026-10-08, when the owner moved this row out of the
  // Marketing Workspace section into the "Approvals Hub" band — hundreds of lines earlier in the
  // file. The old slice still passed, because the PORTAL row with the same badge had fallen inside
  // it: the assertion read as though it covered the admin tab while covering nothing of the sort.
  // A row is one object literal, so its own closing brace is the only end that cannot drift.
  const adminInboxStart = navigation.indexOf('href: "/admin/marketing-requests/inbox"');
  assert.ok(adminInboxStart >= 0, '9: the admin Marketing Inbox row must exist in the nav config');
  const adminInboxItem = navigation.slice(
    adminInboxStart,
    navigation.indexOf("},", adminInboxStart),
  );
  assert.match(
    adminInboxItem,
    /navBadge: "marketing-approvals-pending"/,
    '9: the admin "Marketing Approval Inbox" tab must carry the badge its own comment promises',
  );
  const portalInboxItem = navigation.slice(
    navigation.indexOf('href: "/employee-portals/marketing-requests/inbox"'),
    navigation.indexOf('href: "/employee-portals/marketing-requests/all"'),
  );
  assert.match(
    portalInboxItem,
    /navBadge: "marketing-approvals-pending"/,
    "9: the portal Approval Inbox item must carry the same badge — DM/NSM/Marketing Manager approve there",
  );

  // ── 10. Both shells render it through the ONE shared NavBadge pump ──────────
  // ONE switch, shared by the sidebar and the horizontal nav rows since 2026-08-29.
  const navBadge = readFileSync("src/components/layout/nav-badge.tsx", "utf8");
  // Prop-TOLERANT: what is pinned is that THIS case resolves to THAT count API, not the prop list
  // the switch happens to forward. It pinned the call verbatim until 2026-09-04, when every case
  // gained `dark` so the badge could ring itself in the rail's own background — and this went red
  // for a change it has no opinion about.
  assert.match(
    navBadge,
    /case "marketing-approvals-pending":\s*\n\s*return <NavBadge[^>]*compact=\{compact\}[^>]*src="\/api\/marketing-requests\/pending-count"[^>]*\/>;/,
    "10: the shared badge switch must resolve the marketing badge to its count API",
  );
  const portalLayout = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  assert.match(
    portalLayout,
    /navBadge: "marketing-approvals-pending" as const/,
    "10: the portal layout's own nav list must set the badge on its Marketing Requests Inbox item",
  );
  assert.match(
    portalLayout,
    /<NavBadge src="\/api\/marketing-requests\/pending-count" \/>/,
    "10: the portal must reuse the exported NavBadge against the same count API — no second mechanism",
  );

  // ── 11. It rides the existing batched poll, not a sixth 30s request ─────────
  const navBadgeStore = readFileSync("src/lib/nav-badge-store.ts", "utf8");
  assert.match(
    navBadgeStore,
    /"\/api\/marketing-requests\/pending-count": "marketing"/,
    "11: the marketing src must be batched, or it costs an extra HTTP request every 30s per tab",
  );
  const badgeCountsRoute = readFileSync("src/lib/approvals-hub/badge-counts-payload.ts", "utf8");
  assert.match(
    badgeCountsRoute,
    /getMarketingApproverBadge\(access\)/,
    "11: the batched endpoint must actually produce the marketing slot the store now reads",
  );
  assert.match(
    badgeCountsRoute,
    /marketing: marketing\.status === "fulfilled" \? marketing\.value : \{ count: 0, overdue: false \}/,
    "11: a failing marketing count must fall back like every other domain, never blank the other badges",
  );

  // ── 12. The dedicated endpoint exists and is self-scoped ────────────────────
  const countRoute = readFileSync("app/api/marketing-requests/pending-count/route.ts", "utf8");
  assert.match(
    countRoute,
    /getMarketingApproverBadge\(access\)/,
    "12: the dedicated endpoint must serve the same count source as the batched one",
  );
  assert.doesNotMatch(
    countRoute,
    /assertPermission\(|@\/lib\/auth\/permissions/,
    "12: marketing has no permission resource — the guard is the actor's own assigned_hr_id, as in /inbox",
  );

  // ── 13. Overdue is measured from when the rung OPENED, not when the row was last written ────
  //
  // `updated_at` is a generic row-modification stamp. On 2026-08-19 a config backfill that turned
  // `allow_return` off across every live Finance Execution rung wrote `updated_at = now()` on four
  // in-flight steps, which would have quietly cleared the orange badge on a request that had been
  // stuck for days. The badge must read `openedAt` (the step_opened event) and only fall back to
  // the row stamps when no opening was ever recorded — capture began 2026-08-15, so older requests
  // genuinely have none, and dropping those would hide the most stuck work of all.
  {
    const openedLongAgo = summarizeMarketingApproverBadge({
      gatingSteps: [{ ...step({ requestId: REQUEST_A, updatedAt: NOW }), openedAt: THREE_DAYS_AGO }],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(
      openedLongAgo.overdue,
      true,
      "13: a rung opened 3 days ago stays overdue even though a config write just touched its row",
    );

    const freshlyOpened = summarizeMarketingApproverBadge({
      gatingSteps: [{ ...step({ requestId: REQUEST_A, updatedAt: THREE_DAYS_AGO }), openedAt: ONE_DAY_AGO }],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(
      freshlyOpened.overdue,
      false,
      "13: reopening a returned rung restarts its clock — an old row stamp must not keep it orange",
    );

    const noOpeningRecorded = summarizeMarketingApproverBadge({
      gatingSteps: [{ ...step({ requestId: REQUEST_A, updatedAt: THREE_DAYS_AGO }), openedAt: null }],
      liveRequestIds: [REQUEST_A],
      now: NOW,
      slaDaysByStepCode: SLA_BY_CODE,
      slaDaysByWorkflowStepId: SLA_BY_ID,
    });
    assert.equal(
      noOpeningRecorded.overdue,
      true,
      "13: a pre-2026-08-15 rung with no step_opened event must still be judged, via the row stamps",
    );
  }
}
