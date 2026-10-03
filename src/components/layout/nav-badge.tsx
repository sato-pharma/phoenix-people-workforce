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

import { alarmGlowRef } from "@/components/layout/alarm-glow";
import { type NavigationSectionItem } from "@/config/system-navigation";
import { subscribeNavBadge } from "@/lib/nav-badge-store";
import { cn } from "@/lib/utils";

// ── Pending-count badge for the Action Center nav item ───────────────────────
// Reused verbatim by the admin sidebar, the employee-portal sidebar and the
// horizontal nav rows, so all three share the exact same polling client
// (src/lib/nav-badge-store.ts) — no separate badge mechanism anywhere.
export function NavBadge({
  compact = false,
  dark = false,
  showCount = false,
  src,
}: {
  compact?: boolean;
  /** True on the dark admin rail. The portal never passes it — its rail is light. */
  dark?: boolean;
  /**
   * Compact mode only: render the NUMBER on the icon's corner instead of a bare dot.
   *
   * Opt-in, default off, so the admin icon rail keeps the dot it has always had. The portal's phone
   * bar passes it (owner, 2026-09-29). That reverses his 2026-09-07 "dot, never a count" ruling for
   * that one surface, and he confirmed it knowing so: the reason he gave then was that a count pill
   * "would take its width out of the label", and this badge is absolutely positioned, so it spends
   * no label width at all. It is NOT the in-flow pill below — that one stays banned on the bar.
   */
  showCount?: boolean;
  src: string;
}): ReactNode {
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
  // Graduated urgency, in three dimensions rather than one. THE MOTION IS DELIBERATE AND STAYS
  // (owner, 2026-09-04): the pump is what makes a pending item catch the eye from across the
  // room, and the faster/bigger red pump is what says "this one is late".
  //
  // What changed that day is the FILL. Both states used to be a solid pill — orange-500 or
  // red-600, white 10px/900 — so an ordinary pending count and an SLA breach differed only by
  // hue, and every awaiting item shouted at the same volume as the worst one. Pending is now a
  // tinted pill with a hairline ring, the same soft-accent treatment the portal already uses for
  // a row awaiting attention; overdue keeps the solid fill. So the escalation now reads as
  // soft -> solid AND orange -> red AND 1s -> 0.7s, and the resting state stops competing with
  // the label beside it.
  const alarmClass = overdue ? "nav-badge-alarm-overdue" : "nav-badge-alarm";
  const label = `${count} pending — action required${overdue ? ", overdue" : ""}`;
  if (compact) {
    // Icon-rail mode has no room for a label + count pill — a pumping dot on the
    // icon itself is the only way a pending item is visible when collapsed.
    //
    // The dot stays SOLID in both states: 10px of tinted fill behind a hairline ring is not a
    // colour, it is a smudge. The ring is the rail's own background punched around it, so it
    // has to follow the rail — it was hardcoded to the dark one, which was right only because
    // the light rail has never rendered a compact badge.
    //
    // ONE anchor literal for both variants. Both sit on the icon's corner, out of flow, so neither
    // adds a pixel to any tab's layout floor — which is the property the phone bar's whole width
    // model depends on, and the reason tests/employee-portal-bottom-nav-badges.test.ts pins this
    // exact string.
    const anchor = "absolute -right-0.5 -top-0.5";
    if (!showCount) {
      return (
        <span
          aria-label={label}
          className={cn(
            anchor,
            "h-2.5 w-2.5 rounded-full ring-2",
            dark ? "ring-slate-900" : "ring-white",
            overdue ? "bg-red-600" : "bg-orange-500",
            alarmClass,
          )}
          ref={alarmGlowRef}
          role="status"
        />
      );
    }
    // The number, for a surface that asked for it. `tabular-nums` because the badge pumps and
    // digits of different widths would jitter; `99+` so three digits can never outgrow the icon.
    return (
      <span
        aria-label={label}
        className={cn(
          anchor,
          "flex h-[15px] min-w-[15px] items-center justify-center px-[3px] text-phx-3xs font-black leading-none tabular-nums text-white ring-2",
          dark ? "ring-slate-900" : "ring-white",
          overdue ? "bg-red-600" : "bg-orange-500",
          alarmClass,
        )}
        ref={alarmGlowRef}
        role="status"
      >
        {count > 99 ? "99+" : count}
      </span>
    );
  }
  return (
    // min-w/px tightened 2026-08-10: a badge row leaves the label only ~98px, and this pill was
    // spending 32px of it to show a 1-2 digit count. 18px still fits "99+" at 10px/900.
    //
    // tabular-nums because the pill SCALES on every pump: proportional digits change the pill's
    // width as the count crosses 1 -> 2 digits mid-animation, which reads as a stutter.
    <span
      aria-label={label}
      className={cn(
        "ml-auto min-w-[18px] rounded-full px-1 py-0.5 text-center text-phx-2xs font-black leading-none tabular-nums",
        overdue
          ? "bg-red-600 text-white ring-1 ring-red-400/50"
          : dark
            ? "bg-orange-400/20 text-orange-200 ring-1 ring-orange-400/45"
            : "bg-orange-100 text-orange-700 ring-1 ring-orange-300/80",
        alarmClass,
        // The one see-through fill: it keeps the box-shadow glow, because the cheap one draws a copy
        // of the fill over itself and a copy of a 20% fill reads as 36%. See `.nav-badge-alarm` in
        // app/globals.css.
        !overdue && dark && "nav-badge-alarm-glass",
      )}
      ref={alarmGlowRef}
      role="status"
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

// Shared between the sidebar's expanded label row, its collapsed icon-rail and the horizontal nav
// rows, so every surface recognizes the same set of navBadge values without duplicating the switch.
export function ApprovalNavBadge({
  compact,
  dark = false,
  navBadge,
  showCount = false,
}: {
  compact: boolean;
  dark?: boolean;
  navBadge: NavigationSectionItem["navBadge"];
  /** Compact mode only: the number on the icon corner instead of a dot. See NavBadge. */
  showCount?: boolean;
}): ReactNode {
  switch (navBadge) {
    case "approvals-hub-pending":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/approvals-hub/pending-count" />;
    case "vacation-approvals-pending":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/approvals/vacation/pending-count" />;
    case "excuse-approvals-pending":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/approvals/excuse/pending-count" />;
    case "plan-approvals-pending":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/approvals/plan/pending-count" />;
    // The ONE Direct Orders row. Sums the approval queue and Finance's unbooked queue because a
    // nav item carries one badge and the two audiences barely overlap — see the endpoint's note.
    case "direct-orders-needs-action":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/direct-orders/needs-action-count" />;
    case "direct-orders-approvals-pending":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/approvals/direct-orders/pending-count" />;
    // Approved orders with no sales month — Finance's queue, not an approval queue. Rides the same
    // batched poll (BATCH_KEY_BY_SRC) and the same overdue alarm as its siblings; the threshold is
    // APPROVALS_SLA_THRESHOLDS.directOrderMonth.
    case "direct-orders-unbooked":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/direct-orders/unbooked-count" />;
    case "marketing-approvals-pending":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/marketing-requests/pending-count" />;
    // Market Awareness keeps its own inbox for the same reason marketing does — the owner asked for
    // a separate queue — so the hub's count can never cover it.
    case "market-awareness-approvals-pending":
      return <NavBadge compact={compact} dark={dark} showCount={showCount} src="/api/market-awareness/pending-count" />;
    default:
      return null;
  }
}
