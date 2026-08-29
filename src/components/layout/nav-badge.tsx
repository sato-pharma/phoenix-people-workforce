"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix Workforce — the pending-count badge, and the ONE switch that maps a
// nav item's `navBadge` key to the endpoint that counts it.
//
// Extracted from sidebar.tsx on 2026-08-29, when the horizontal nav rows became
// a third surface that needs these counts. Importing it FROM the sidebar would
// have dragged the whole sidebar module — dnd-kit, the layout editor, the
// localStorage preference machinery — into the bundle of every page that
// renders a row, for a thirty-line badge.
//
// ONE switch, never a copy per surface. `employee-portal-layout.tsx` still
// carries a hand-written chain of its own; it happens to cover exactly the six
// values the portal's own sections declare today, so it is correct right now
// and silently wrong the moment a seventh reaches the portal. That is the whole
// argument for this file — the same argument as the `doctor` customer type that
// was omitted from one hand-written copy and rejected 59 of 65 customers.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, type ReactNode } from "react";

import { type NavigationSectionItem } from "@/config/system-navigation";
import { subscribeNavBadge } from "@/lib/nav-badge-store";
import { cn } from "@/lib/utils";

// ── Pending-count badge for the Action Center nav item ───────────────────────
// Reused verbatim by the admin sidebar, the employee-portal sidebar and the
// horizontal nav rows, so all three share the exact same polling client
// (src/lib/nav-badge-store.ts) — no separate badge mechanism anywhere.
export function NavBadge({ compact = false, src }: { compact?: boolean; src: string }): ReactNode {
  const [count, setCount] = useState<number | null>(null);
  const [overdue, setOverdue] = useState(false);
  useEffect(
    () =>
      subscribeNavBadge(src, (nextCount, nextOverdue) => {
        setCount(nextCount);
        setOverdue(nextOverdue);
      }),
    [src],
  );
  if (!count) return null;
  // Graduated urgency: once any awaiting item breaches its SLA, the pump switches from
  // orange to a faster, redder alarm — see APPROVALS_SLA_THRESHOLDS and isXAwaitingOverdue.
  const alarmClass = overdue ? "nav-badge-alarm-overdue bg-red-600" : "nav-badge-alarm bg-orange-500";
  const label = `${count} pending — action required${overdue ? ", overdue" : ""}`;
  if (compact) {
    // Icon-rail mode has no room for a label + count pill — a pumping dot on the
    // icon itself is the only way a pending item is visible when collapsed.
    return (
      <span
        aria-label={label}
        className={cn("absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-slate-900", alarmClass)}
        role="status"
      />
    );
  }
  return (
    // min-w/px tightened 2026-08-10: a badge row leaves the label only ~98px, and this pill was
    // spending 32px of it to show a 1-2 digit count. 18px still fits "99+" at 10px/900.
    <span
      aria-label={label}
      className={cn("ml-auto min-w-[18px] rounded-full px-1 py-0.5 text-center text-phx-2xs font-black leading-none text-white", alarmClass)}
      role="status"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

// Shared between the sidebar's expanded label row, its collapsed icon-rail and the horizontal nav
// rows, so every surface recognizes the same set of navBadge values without duplicating the switch.
export function ApprovalNavBadge({ compact, navBadge }: { compact: boolean; navBadge: NavigationSectionItem["navBadge"] }): ReactNode {
  switch (navBadge) {
    case "approvals-hub-pending":
      return <NavBadge compact={compact} src="/api/approvals-hub/pending-count" />;
    case "vacation-approvals-pending":
      return <NavBadge compact={compact} src="/api/approvals/vacation/pending-count" />;
    case "excuse-approvals-pending":
      return <NavBadge compact={compact} src="/api/approvals/excuse/pending-count" />;
    case "plan-approvals-pending":
      return <NavBadge compact={compact} src="/api/approvals/plan/pending-count" />;
    // The ONE Direct Orders row. Sums the approval queue and Finance's unbooked queue because a
    // nav item carries one badge and the two audiences barely overlap — see the endpoint's note.
    case "direct-orders-needs-action":
      return <NavBadge compact={compact} src="/api/direct-orders/needs-action-count" />;
    case "direct-orders-approvals-pending":
      return <NavBadge compact={compact} src="/api/approvals/direct-orders/pending-count" />;
    // Approved orders with no sales month — Finance's queue, not an approval queue. Rides the same
    // batched poll (BATCH_KEY_BY_SRC) and the same overdue alarm as its siblings; the threshold is
    // APPROVALS_SLA_THRESHOLDS.directOrderMonth.
    case "direct-orders-unbooked":
      return <NavBadge compact={compact} src="/api/direct-orders/unbooked-count" />;
    case "marketing-approvals-pending":
      return <NavBadge compact={compact} src="/api/marketing-requests/pending-count" />;
    default:
      return null;
  }
}
