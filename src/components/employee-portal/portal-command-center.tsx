import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CalendarX2,
  ChartColumnBig,
  CheckCircle2,
  ClipboardCheck,
  Layers,
  Network,
  PieChart,
  ReceiptText,
  Send,
  TrendingUp,
  User,
  Wallet,
} from "lucide-react";

import { EarlyBirdOfTheFortnightCard } from "@/components/early-birds/early-bird-of-the-fortnight-card";
import { IdentityCard } from "@/components/employee-portal/identity-card";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import { DsmCommandCenter } from "@/components/employee-portal/dashboards/dsm-command-center";
import { NsmCommandCenter } from "@/components/employee-portal/dashboards/nsm-command-center";
import { RmCommandCenter } from "@/components/employee-portal/dashboards/rm-command-center";
import { MarketingManagerCommandCenter } from "@/components/employee-portal/dashboards/marketing-manager-command-center";
import { PlanAdherenceDashboardCard } from "@/components/weekly-planning/plan-adherence-report";
import type { AccessContext } from "@/lib/auth/permissions";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import type { PortalPlanAdherence } from "@/lib/weekly-planning/plan-adherence-data";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { currentCairoDateParts, PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

export function egp(n: number) {
  return new Intl.NumberFormat("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

export function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900 px-4 py-2.5 sm:px-5 sm:py-3">
        <h2 className="text-phx-2xs font-bold uppercase tracking-widest text-slate-300">{title}</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>
      <div className="bg-white p-3 sm:p-5">{children}</div>
    </div>
  );
}

export function PremiumNavTile({
  href,
  icon: Icon,
  label,
  description,
  badge,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  description: string;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="group relative flex min-h-[52px] bg-white transition-colors hover:bg-orange-50 active:bg-orange-100 sm:min-h-[72px]"
    >
      {badge != null && badge > 0 && (
        <span className="absolute right-2 top-2 flex h-5 min-w-[20px] items-center justify-center bg-orange-500 px-1 text-phx-3xs font-black text-white">
          {badge}
        </span>
      )}
      <div className="w-[3px] shrink-0 bg-slate-200 transition-colors group-hover:bg-orange-500" />
      <div className="flex flex-1 items-center gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white sm:h-10 sm:w-10">
          <Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500 transition-colors group-hover:text-orange-600">
            {label}
          </p>
          <p className="mt-0.5 hidden text-sm font-semibold leading-snug text-slate-800 sm:block">{description}</p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-orange-500" />
      </div>
    </Link>
  );
}

export function MarketingToolRow({
  href,
  icon: Icon,
  label,
  sub,
}: {
  href: string;
  icon: React.ElementType;
  label: string;
  sub: string;
}) {
  return (
    <Link
      href={href}
      className="group flex min-h-[48px] items-center gap-3 bg-white px-4 py-3 transition-colors hover:bg-slate-50 active:bg-orange-50 sm:min-h-[56px] sm:gap-4 sm:px-5 sm:py-4"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 transition-colors group-hover:border-orange-300 group-hover:bg-orange-50">
        <Icon className="h-4 w-4 text-slate-500 transition-colors group-hover:text-orange-600" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">{label}</p>
        <p className="text-phx-xs leading-snug text-slate-500">{sub}</p>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-orange-500" />
    </Link>
  );
}

export function PendingActions({
  pendingVacationCount,
  pendingExcuseCount,
  plansAwaitingApproval = 0,
}: {
  pendingVacationCount: number;
  pendingExcuseCount: number;
  plansAwaitingApproval?: number;
}) {
  return (
    <SectionShell title="Needs Your Decision">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {plansAwaitingApproval > 0 && (
          <Link
            href="/employee-portals/approvals-hub?module=weekly_plan"
            className="flex items-center justify-between border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800 hover:bg-orange-100"
          >
            <span className="flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4" />
              {plansAwaitingApproval} plan{plansAwaitingApproval > 1 ? "s" : ""} awaiting your approval
            </span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
        {pendingVacationCount > 0 && (
          <Link
            href="/employee-portals/approvals-hub"
            className="flex items-center justify-between border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800 hover:bg-orange-100"
          >
            <span className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4" />
              {pendingVacationCount} vacation request{pendingVacationCount > 1 ? "s" : ""} pending
            </span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
        {pendingExcuseCount > 0 && (
          <Link
            href="/employee-portals/approvals-hub"
            className="flex items-center justify-between border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800 hover:bg-orange-100"
          >
            <span className="flex items-center gap-2">
              <CalendarX2 className="h-4 w-4" />
              {pendingExcuseCount} excuse request{pendingExcuseCount > 1 ? "s" : ""} pending
            </span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        )}
      </div>
    </SectionShell>
  );
}

export function PendingCountsUnavailable() {
  return (
    <div className="flex items-center gap-3 border border-amber-200 bg-amber-50 px-4 py-3 sm:px-5 sm:py-4">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
      <span className="text-sm font-medium text-amber-800">
        Couldn&apos;t load your pending items right now — refresh to try again.
      </span>
    </div>
  );
}

/* ── ProfileIntelBar ─────────────────────────────────────────────── */

function IntelField({
  icon: Icon,
  label,
  value,
  className = "",
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 bg-white px-4 py-3 sm:px-7 sm:py-4 ${className}`}>
      <div className="flex items-center gap-1.5">
        <Icon className="h-3 w-3 shrink-0 text-orange-600" />
        <span className="text-phx-3xs font-black uppercase tracking-[0.18em] text-slate-400">{label}</span>
      </div>
      {/* Wraps rather than clips. The old value carried `whitespace-nowrap` inside an
          `overflow-hidden` band, which is the blindness the golden rule names: a long manager name
          was cut off with `main` still measuring a clean 375/375, because clipped content never
          reaches scrollWidth. Wrapping is the permitted answer; the ellipsis ban is untouched. */}
      <span className="text-sm font-black text-slate-900 sm:text-base">{value}</span>
    </div>
  );
}

export function ProfileIntelBar({ shell }: { shell: EmployeePortalShellData }) {
  const { employee, hrContract } = shell;
  const hireDateLabel = hrContract.hireDate
    ? new Date(hrContract.hireDate).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: PHOENIX_BUSINESS_TIME_ZONE,
      })
    : null;
  if (!employee.line && !hireDateLabel && !employee.manager) return null;
  // The orange accent is a BORDER, not an absolutely-positioned rule. The cells below are opaque
  // white now, and a positioned sibling later in the DOM paints over an absolute one — which is
  // exactly how a 2px rule disappears without anything erroring.
  return (
    <div className="relative border border-t-2 border-slate-200 border-t-orange-500 bg-slate-200">
      {/* The on-light file, NOT `sato-pharma-logo.png`. That one draws the word SATO in WHITE — it
          was made for the navy sidebar and this band's own navy past, and it goes invisible the
          moment the ground turns light. The two files are not interchangeable. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/sato-pharma-logo-on-light.png"
        alt="SATO Pharma"
        className="pointer-events-none absolute right-5 top-1/2 z-10 hidden h-7 w-auto -translate-y-1/2 sm:block"
      />
      {/* Mobile: Line + Joined paired, Reports To stacked below. Desktop (sm+): all three on one
          line. The slate ground shows through the 1px gaps as the rules between cells. */}
      <div className="relative flex flex-col gap-px sm:flex-row">
        {(employee.line || hireDateLabel) && (
          <div className="flex gap-px sm:contents">
            {employee.line && (
              <IntelField icon={Layers} label="Line" value={employee.line} className="flex-1 sm:flex-none sm:shrink-0" />
            )}
            {hireDateLabel && (
              <IntelField icon={CalendarDays} label="Joined" value={hireDateLabel} className="flex-1 sm:flex-none sm:shrink-0" />
            )}
          </div>
        )}
        {employee.manager && (
          <IntelField icon={User} label="Reports To" value={employee.manager} className="sm:min-w-0 sm:flex-1 sm:pr-24" />
        )}
      </div>
    </div>
  );
}

/**
 * The identity band — the FIRST thing on every portal landing surface, and nothing sits above it.
 *
 * OWNER RULE: nothing renders above the identity card. It was first stated with an exception for
 * the portal's own nav rows, and the rows themselves were then removed on the same day — so the
 * rule now has no exception at all: below the fixed header, the identity card is the first thing
 * on the page. See EmployeePortalChrome for why the rows went. The plan
 * score used to be hoisted into PortalCommandCenter and rendered ABOVE the role dashboard, which
 * put it above the identity card too — it pushed a person's own signature card down the page on
 * the one screen that exists to greet them by name. The hoist was there for a good reason (the
 * plan module's population does not follow the role switch, so five separate placements would have
 * been five chances to miss one). That reason is preserved here as a COMPONENT rather than as a
 * position: every landing surface renders this band, and anything that wants to travel with the
 * identity goes INSIDE it, underneath.
 *
 * `planAdherence` is REQUIRED, not optional, and that is the mechanism. DSM, NSM, Product Manager,
 * Group Product Manager and Training Manager all file plans, and an acting DSM keeps the job title
 * "Medical Representative" — so a new landing surface has to state its answer at compile time
 * instead of silently dropping the card for whoever lands there.
 *
 * A fragment, not a wrapper: the three pieces stay direct children of the caller's `space-y-*`
 * container, so the rhythm of the page is unchanged from when they were written out by hand.
 */
export function PortalIdentityBand({
  planAdherence,
  shell,
}: {
  planAdherence: PortalPlanAdherence | null;
  shell: EmployeePortalShellData;
}) {
  return (
    <>
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />
      {planAdherence?.latest ? (
        <PlanAdherenceDashboardCard adherence={planAdherence} planBaseHref="/employee-portals/approvals/plan" />
      ) : null}
      {/* Travels with the identity band, per the design note above — every role lands here, so
          this is the one place a push opt-in nudge reaches every employee-portal role's home in
          a single edit. Renders nothing until it has checked this person's own state. */}
      <PushOptInNudge />
    </>
  );
}

/* ── PortalContextBar ────────────────────────────────────────────── */

export function PortalContextBar({ role, context }: { role: string; context: string }) {
  return (
    <div className="flex items-center gap-3 border border-orange-200 bg-orange-50 px-4 py-3 sm:px-5 sm:py-3.5">
      <Layers className="h-4 w-4 shrink-0 text-orange-600" />
      <div className="min-w-0">
        <p className="text-phx-2xs font-bold uppercase tracking-widest text-orange-500">{role}</p>
        <p className="whitespace-nowrap font-bold text-slate-900">{context}</p>
      </div>
    </div>
  );
}

/* ── GlanceStrip ─────────────────────────────────────────────────── */

type GlanceStripItem = {
  icon: React.ElementType;
  value: string;
  label: string;
  href: string;
  urgent?: boolean;
};

export function GlanceStrip({ items }: { items: GlanceStripItem[] }) {
  /* Three columns are keyed to the STRIP's own width, not the window's. Measured 2026-09-05: at a
     640px viewport `sm:grid-cols-3` fired while `main` was only 608px, leaving each cell 202px and
     the label just 75px — "plans awaiting approval" came out one word per line, three lines deep.
     Nothing was clipped and the page read 608/608, the same blindness the Stars card had. At 672px
     of container the label gets ~132px and reads on two lines. */
  return (
    <div className="@container grid grid-cols-1 gap-px bg-slate-200 @2xl:grid-cols-3">
      {items.map((item, i) => (
        <Link
          key={i}
          href={item.href}
          className={`group flex min-h-[56px] items-center gap-2 bg-white px-3 py-3 transition-colors hover:bg-slate-50 @2xl:min-h-[64px] @2xl:gap-4 @2xl:px-5 border-l-[3px] ${item.urgent ? "border-orange-500" : "border-transparent"}`}
        >
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center border transition-colors group-hover:border-orange-300 group-hover:bg-orange-50${item.urgent ? " border-orange-200 bg-orange-50" : " border-slate-200 bg-slate-50"}`}
          >
            <item.icon
              className={`h-4 w-4 transition-colors group-hover:text-orange-600${item.urgent ? " text-orange-600" : " text-slate-500"}`}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className={`whitespace-nowrap text-sm font-black leading-tight @2xl:text-base${item.urgent ? " text-orange-600" : " text-slate-900"}`}>{item.value}</p>
            {/* The VALUE keeps its nowrap — it is a short number and must not break across
                lines. The label is prose and wraps: in the three-column form each cell leaves it
                about 132px, and "pending requests" does not fit on one line. */}
            <p className="break-words text-xs leading-snug text-slate-500">{item.label}</p>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-orange-400" />
        </Link>
      ))}
    </div>
  );
}

/* ── QuickActions ────────────────────────────────────────────────── */

type QuickAction = {
  href: string;
  icon: React.ElementType;
  label: string;
};

export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    /* The row is CONTENT-driven, not column-driven. `grid-cols-2` gave every action the same
       172px at 375px, and "Review Marketing Requests" — the longest label in the repo at 25
       characters — came out three lines deep, one word per line (measured 2026-09-05 against the
       real portal chain, which is 351px at 375px, not 375). The golden rule's remedy is to MERGE
       columns, but merging unconditionally would stack the general portal's four short labels
       ("My Plans", "Report It") into a needless four-high tower.

       So each item carries `basis-[calc(50%-0.25rem)]` (two per row, allowing for `gap-2`) with
       `min-w-fit` on top: a label wider than half the row raises its own item's minimum past the
       basis, the item no longer fits beside a sibling, and `grow` then stretches it to the full
       row. Short labels never reach that minimum and stay two-up, unchanged. `min-width: fit-content`
       is capped by the available space, so this cannot overflow — verified at 320px, where the item
       still fits and nothing crosses the right edge.

       From `sm` the layout is unchanged: `sm:grow-0 sm:basis-auto` returns the items to content
       width, measured pixel-identical to the previous markup at 1280px. */
    <div className="flex flex-wrap gap-2">
      {actions.map((action, i) => (
        <Link
          key={i}
          href={action.href}
          className="flex min-h-[48px] min-w-fit grow basis-[calc(50%-0.25rem)] items-center justify-center gap-2 border border-slate-200 bg-white px-3 py-3 text-xs font-bold uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 sm:inline-flex sm:min-h-0 sm:grow-0 sm:basis-auto sm:px-4 sm:py-2.5 sm:text-phx-xs"
        >
          <action.icon className="h-4 w-4 shrink-0 sm:h-3.5 sm:w-3.5" />
          <span className="text-center leading-tight whitespace-normal sm:whitespace-nowrap">{action.label}</span>
        </Link>
      ))}
    </div>
  );
}

/* ── SectionHead (navy grid-pattern header used by the richer dashboards) ── */

export function SectionHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden bg-[#0b1f3a] shadow-[0_8px_32px_rgba(11,31,58,0.35)]">
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(rgba(255,255,255,1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,1)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#f47b20] to-transparent" />
      {/* flex-wrap, and the right slot wraps inside itself: it now carries the closing month
          beside whatever it showed before, and at 375px title + stamp + count exceeds the bar.
          This wrapper is overflow-hidden, so a nowrap chip would be CLIPPED rather than scrolled —
          invisible to a scrollWidth check (AGENTS.md §4, the golden rule's second blind spot).
          Wrapping is the permitted answer here; the ellipsis ban rules the other one out. */}
      <div className="relative flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5 sm:py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="h-4 w-[3px] shrink-0 bg-[#f47b20]" />
          <h2 className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-300">
            {title}
          </h2>
        </div>
        {right}
      </div>
    </div>
  );
}

/* ── SectionMeta (the small-caps chips on the right of a SectionHead) ── */

/**
 * The chips on the right of a SectionHead — a closing month, a head count, a sort order.
 *
 * It exists because every performance header now has to name its WINDOW as well as whatever it
 * showed before. The sales figures on these dashboards come from PUBLISHED monthly closings, and a
 * closing only publishes once its month has ended, so in early September the newest numbers are
 * July's — while the cards said "achieved this period", which reads as "right now" and never was.
 * Owner, 2026-09-03: "you must show this achievement is in which window?"
 *
 * Null and blank items are dropped rather than rendered as an empty chip, so a caller can pass a
 * not-yet-published month straight through. It wraps rather than truncating (ellipsis ban) and
 * rather than nowrapping — SectionHead's frame is overflow-hidden, so nowrap clips in silence.
 */
export function SectionMeta({ items }: { items: readonly (string | null | undefined)[] }) {
  const shown = items.filter((item): item is string => Boolean(item && item.trim()));
  if (shown.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-phx-2xs font-bold uppercase tracking-widest text-slate-400">
      {shown.map((item, index) => (
        <span key={item} className="flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden className="text-slate-600">
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </span>
  );
}

/* ── KeycardGrid (icon-square KPI cards, 4-up, under a SectionHead) ──── */

export type Keycard = {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  accent: string;
  valueClass: string;
};

export function KeycardGrid({ cards }: { cards: Keycard[] }) {
  return (
    <div className="grid grid-cols-2 gap-px bg-slate-200 xl:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="relative min-w-0 overflow-hidden bg-white px-4 py-4 sm:px-5 sm:py-5">
          <span className={`absolute inset-x-0 top-0 h-[3px] ${card.accent}`} />
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-slate-900 text-white">
              <card.icon className="h-3.5 w-3.5" />
            </span>
            <p className="min-w-0 break-words text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">
              {card.label}
            </p>
          </div>
          {/* Values are computed (egpCompact, percentages) and can run long — wrap instead of the
              fixed-width nowrap this used to have, which let the grid's minmax(0,1fr) columns
              clip or bleed digits into the next card instead of showing the full number. */}
          <p className={`mt-3 break-words text-xl font-black leading-tight tabular-nums sm:text-2xl ${card.valueClass}`}>
            {card.value}
          </p>
          {/* Owner rule: never truncate with an ellipsis. Subs now name the closing month
              ("Jul 2026 closing"), which is longer than the fixed phrases they replaced. */}
          <p className="break-words text-phx-xs font-medium leading-snug text-slate-500">{card.sub}</p>
        </div>
      ))}
    </div>
  );
}

/* ── DashboardsGrid (icon-tile link grid under a "Dashboards" SectionHead) ── */

export type DashboardLink = { href: string; icon: React.ElementType; label: string };

export function DashboardsGrid({ items }: { items: readonly DashboardLink[] }) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead title="Dashboards" />
      <div className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-4 sm:gap-2.5 sm:p-2.5">
        {items.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className="group flex flex-col items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-4 text-center transition-colors hover:border-orange-300 hover:bg-orange-50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-white transition-colors group-hover:bg-orange-600">
              <d.icon className="h-[18px] w-[18px]" />
            </span>
            {/* Wraps: the frame above is overflow-hidden, so a label wider than its cell
                ("Med Rep Performance" at 375px) would be clipped rather than scrolled. */}
            <span className="min-w-0 break-words text-xs font-bold uppercase leading-snug tracking-wide text-slate-700 transition-colors group-hover:text-orange-700">
              {d.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── RankingPanel (ranked leaderboard with an achievement-% bar) ─────── */

export type RankRow = {
  hrId: string;
  name: string;
  achievementPercent: number;
  totalSales: number;
  totalTarget: number;
  managerName?: string | null;
};

function pctTextClass(pct: number): string {
  return pct >= 100 ? "text-emerald-600" : pct >= 90 ? "text-amber-600" : pct >= 70 ? "text-orange-600" : "text-rose-600";
}
function pctBarClass(pct: number): string {
  return pct >= 100 ? "bg-emerald-500" : pct >= 90 ? "bg-amber-400" : pct >= 70 ? "bg-orange-500" : "bg-rose-500";
}
/** The house medal palette — gold, silver, bronze, then plain. Exported so the Early Birds race
 * panel reuses the same chips as the sales leaderboard instead of a second, drifting copy. */
export function rankChipClass(index: number): string {
  return index === 0
    ? "bg-amber-400 text-slate-900"
    : index === 1
      ? "bg-slate-300 text-slate-900"
      : index === 2
        ? "bg-orange-300 text-slate-900"
        : "bg-slate-900 text-white";
}

export function RankingPanel({
  title,
  subtitle,
  icon: Icon,
  rows,
  showManager,
  windowLabel,
  footer,
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  rows: RankRow[];
  showManager?: boolean;
  /** Which published closing month(s) these achievement percentages cover, e.g. "Jul 2026". */
  windowLabel?: string | null;
  /** Rendered inside the card beneath the last row — this is where DepartedFromBoardNote goes. */
  footer?: React.ReactNode;
}) {
  const ranked = rows.slice().sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales);
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead title={title} right={<SectionMeta items={[windowLabel, subtitle]} />} />
      {ranked.length === 0 ? (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No sales data synced for the current period yet.</p>
      ) : (
        <div className="bg-white">
          {ranked.map((row, i) => {
            const pct = Math.max(0, Math.round(row.achievementPercent));
            // No target means the percent has no meaning — showing 0% would tell someone who
            // sold well that they achieved nothing. Targets start 2026-07, so this is ordinary.
            const hasTarget = row.totalTarget > 0;
            return (
              <div
                key={row.hrId || `${row.name}-${i}`}
                className="flex items-center gap-3 border-b border-slate-100 px-3 py-2.5 last:border-b-0 sm:px-4"
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center text-phx-xs font-black ${rankChipClass(i)}`}>
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon className="hidden h-3.5 w-3.5 shrink-0 text-slate-300 sm:block" />
                  <div className="min-w-0">
                    {/* Wraps, never truncates — owner rule. Egyptian full names run four parts
                        and the old ellipsis cut most of them off on a phone. */}
                    <p className="break-words text-sm font-semibold leading-snug text-slate-800">{row.name}</p>
                    {showManager && row.managerName ? (
                      <p className="break-words text-phx-2xs font-medium uppercase leading-snug tracking-wide text-slate-400">
                        {row.managerName}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="w-16 shrink-0">
                  {hasTarget ? (
                    <>
                      <p className={`text-right text-sm font-black tabular-nums ${pctTextClass(pct)}`}>{pct}%</p>
                      <div className="mt-1 h-1 w-full bg-slate-100">
                        <div className={`h-full ${pctBarClass(pct)}`} style={{ width: `${Math.min(100, Math.max(3, pct))}%` }} />
                      </div>
                    </>
                  ) : (
                    <p className="whitespace-nowrap text-right text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
                      No target
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {footer}
    </div>
  );
}

/* ── DepartedFromBoardNote (why the board is shorter than the total) ─── */

/**
 * Says, under a ranking board, that colleagues who left mid-window are counted in the money above
 * but not listed below.
 *
 * The boards now list only people who are still employed. Before 2026-09-03 a district manager kept
 * seeing resigned reps ranked among his team, months after they left, and the head count above
 * included them — the owner's words were "how the fuck I'm still seeing employees who resigned in
 * his main dashboard". But their SALES are real and stay inside the district/region/line totals on
 * the card above, so dropping the names without saying so would leave a board that no longer adds
 * up to the number over it. This note is that missing sentence.
 *
 * Renders nothing when nobody left, which is the ordinary case.
 */
export function DepartedFromBoardNote({
  count,
  sales,
  totalLabel,
}: {
  count: number;
  sales: number;
  /** The heading of the card whose total still contains these sales, e.g. "District Performance". */
  totalLabel: string;
}) {
  if (count <= 0) return null;
  return (
    <p className="border-t border-slate-100 bg-slate-50 px-3 py-2.5 text-phx-xs leading-relaxed text-slate-500 sm:px-4">
      {count === 1 ? "One colleague who" : `${count} colleagues who`} left during this window{" "}
      {count === 1 ? "is" : "are"} no longer listed here.
      {sales > 0 ? ` Their ${egpCompact(sales)} of sales is still counted in ${totalLabel} above.` : ""}
    </p>
  );
}

/* ── ActionStrip (4-icon quick-submit row) ───────────────────────────── */

export type ActionStripItem = { href: string; icon: React.ElementType; label: string };

export function ActionStrip({ items }: { items: readonly ActionStripItem[] }) {
  return (
    // Two columns on a phone, four from sm. At 375px four cells are ~87px wide and every real
    // label ("Review Team Plan", "Coaching Analytics") is wider than that — with the nowrap this
    // used to carry, the text ran straight out of an overflow-hidden frame and was CLIPPED, not
    // scrolled. That is invisible to a scrollWidth check: main measured 375/375 while the words
    // sat off the edge (AGENTS.md §4). Merging columns is the owner's prescribed fix — fit by
    // merging, never by shrinking type — and the labels wrap inside the wider cell.
    <div className="grid grid-cols-2 gap-px overflow-hidden border border-slate-200 bg-slate-200 sm:grid-cols-4">
      {items.map((a) => (
        <Link
          key={a.href}
          href={a.href}
          className="group flex flex-col items-center justify-center gap-1 bg-white px-2 py-3 text-center transition-colors hover:bg-orange-50 sm:flex-row sm:gap-2"
        >
          <a.icon className="h-4 w-4 shrink-0 text-orange-600" />
          <span className="min-w-0 break-words text-phx-xs font-bold uppercase leading-snug tracking-wide text-slate-700 transition-colors group-hover:text-orange-700 sm:text-xs">
            {a.label}
          </span>
        </Link>
      ))}
    </div>
  );
}

/* ── egpCompact (compact currency, e.g. "128.45 M EGP") ──────────────── */

export function egpCompact(value: number): string {
  const abs = Math.abs(value);
  const unit =
    abs >= 1_000_000_000
      ? { div: 1_000_000_000, suffix: "B" }
      : abs >= 1_000_000
        ? { div: 1_000_000, suffix: "M" }
        : abs >= 1_000
          ? { div: 1_000, suffix: "K" }
          : null;
  if (!unit) return `${Math.round(value).toLocaleString("en-US")} EGP`;
  const scaled = (value / unit.div).toFixed(2).replace(/\.?0+$/, "");
  return `${scaled} ${unit.suffix} EGP`;
}

/* ── Private command center layouts ─────────────────────────────── */

const PM_GPM_DASHBOARDS: readonly DashboardLink[] = [
  { href: "/employee-portals/marketing-requests", icon: Send, label: "Marketing Requests" },
  { href: "/employee-portals/plans", icon: CalendarDays, label: "My Plans" },
  { href: "/employee-portals/source-of-sales", icon: ChartColumnBig, label: "Source of Sales" },
  { href: "/employee-portals/weekly-sales", icon: CalendarRange, label: "Weekly Sales" },
  { href: "/employee-portals/roi", icon: PieChart, label: "ROI Intelligence" },
  { href: "/employee-portals/coaching-analytics", icon: ClipboardCheck, label: "Coaching Analytics" },
  { href: "/employee-portals/double-visit-analytics", icon: Network, label: "Double-Visit Analytics" },
  { href: "/employee-portals/organogram", icon: Building2, label: "Organogram" },
];

const PM_GPM_ACTIONS: readonly ActionStripItem[] = [
  { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Leave" },
  { href: "/employee-portals/excuses", icon: CalendarClock, label: "Excuse" },
  { href: "/employee-portals/marketing-requests", icon: Send, label: "Marketing" },
  { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Expense" },
];

function PmGpmCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const {
    shell,
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    leaveEntitlementDays,
    pmMarketing,
    plansAwaitingManagerApproval,
    plansCountAvailable,
    dvFocus,
  } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount + plansCount;
  // Both legs must have loaded for the sum to mean anything — a failed plans lookup defaults to 0
  // and would otherwise silently understate totalPending rather than reading as unknown.
  const pendingAvailable = pendingCountsAvailable && plansCountAvailable;

  const cards: Keycard[] = [
    {
      icon: Send,
      label: "Marketing Requests",
      value: pmMarketing ? String(pmMarketing.myPendingRequests) : "—",
      sub: "in flight",
      accent: "bg-slate-900",
      valueClass: "text-slate-900",
    },
    {
      icon: CalendarX2,
      label: "Pending Requests",
      value: pendingAvailable ? String(totalPending) : "—",
      sub: "awaiting decision",
      accent: pendingAvailable && totalPending > 0 ? "bg-orange-500" : "bg-slate-900",
      valueClass: pendingAvailable && totalPending > 0 ? "text-orange-600" : "text-slate-900",
    },
    {
      icon: CalendarDays,
      label: "Leave Balance",
      value: leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—",
      sub: "annual entitlement",
      accent: "bg-slate-900",
      valueClass: "text-slate-900",
    },
    // NO PAYSLIP KEYCARD: payslip data (amount OR month) must never render on any overview/landing
    // surface for any role — owner rule. It lives only on /employee-portals/payslips.
  ];

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} />

      {!pendingAvailable ? (
        <PendingCountsUnavailable />
      ) : totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : null}

      <div className="overflow-hidden border border-slate-200 bg-white">
        <SectionHead title="My Workspace" />
        <KeycardGrid cards={cards} />
      </div>

      <DashboardsGrid items={PM_GPM_DASHBOARDS} />

      <ActionStrip items={PM_GPM_ACTIONS} />

      <DoubleVisitFocusSection focus={dvFocus} />
    </div>
  );
}

// --- Medical Rep layout — a data-only field command center ---
//
// THE OWNER'S RULES THIS LAYOUT ENFORCES (stated 2026-09-04). Each one is why some obvious thing
// is missing here, so read them before adding anything back:
//
//   * NO DECORATIVE BLOCK. Every panel prints a measurement. What this replaces opened with a
//     full-width dark gradient hero carrying one sentence and no number — "I don't want big black
//     irrelevant blocks" — so there is no headline band, no lede and no painted hero anywhere.
//   * NO EMPTY TILE. "What the fuck is this empty square" — the Achievement tile printed nothing
//     whenever the CURRENT month had no upload yet, while the chart directly beneath it showed two
//     closed months. A tile that has a number available and shows none is a bug, not an empty
//     state, so achievement now falls back to the newest CLOSED month and names the month it is
//     showing. The only remaining empty text is where no number exists anywhere.
//   * NO PROSE. Dashboard copy: a label, a number, its denominator. No explanatory sentences.
//   * NO ROUND OR SEMI-ROUND CORNERS, anywhere (AGENTS.md §4). tokens.css still defaults
//     --phx-radius to 4px and calls it the card and button default, so square has to be written
//     out; it is never inherited. A 4px corner is invisible in review, which is how it comes back.
//   * NO PAYSLIP on a landing surface — not the amount, not the month label. Only the nav link out.
//   * THE CALL RATE IS TWO NUMBERS. AM against its own target, PM against its own, each with its
//     own attainment bar, printed apart with no separator that could read as a division — he read
//     "1.63 / 6.57" as one number over another. There is deliberately no combined figure to reach
//     for, and MrFieldKpis carries none.
//   * OUTSTATION EXPENSE IS NOT A REP'S HEADLINE. Last in the tool list; in no tile, no alert row.
//
// The two `has*` flags off the CRM KPI board carry the difference between a real zero and no basis
// to score at all, and the tiles must keep rendering those differently: a rep with no plan is NOT a
// 0% performer, and a rep who logged nothing has no call rate rather than a rate of zero. Same
// reason a month with no target draws "no target" instead of a 0% bar.

/** Target-relative tone. One scale for every percentage on this page, so colour means one thing. */
function repTone(pct: number): { rail: string; fill: string; text: string } {
  if (pct >= 100) return { rail: "bg-emerald-600", fill: "bg-emerald-500", text: "text-emerald-700" };
  if (pct >= 90) return { rail: "bg-amber-500", fill: "bg-amber-400", text: "text-amber-700" };
  return { rail: "bg-orange-500", fill: "bg-orange-500", text: "text-orange-700" };
}

/** Square metric tile with a status rail across its top edge. */
function RepTile({
  label,
  meta,
  rail,
  children,
  hint,
}: {
  label: string;
  meta?: string | null;
  rail?: string;
  children: React.ReactNode;
  hint?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col border border-slate-200 bg-white">
      <div aria-hidden="true" className={`h-0.5 w-full ${rail ?? "bg-slate-300"}`} />
      <div className="flex flex-1 flex-col p-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">{label}</span>
          {meta && (
            <span className="ml-auto text-[9px] font-bold uppercase tracking-[0.08em] text-slate-400">{meta}</span>
          )}
        </div>
        <div className="mt-2">{children}</div>
        {hint && <p className="mt-auto pt-2 text-[11px] leading-snug text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

/** Big percentage plus its attainment bar. The 100% line is drawn so a bar reads against target. */
function RepPercent({ pct, note }: { pct: number; note?: React.ReactNode }) {
  const rounded = Math.round(pct);
  const tone = repTone(rounded);
  return (
    <>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-[21px] font-bold leading-none tracking-[-0.01em] tabular-nums ${tone.text}`}>
          {rounded}
        </span>
        <span className="text-[11px] font-bold text-slate-400">%</span>
        {note && <span className="ml-auto">{note}</span>}
      </div>
      <div className="relative mt-2 h-1.5 w-full bg-slate-100">
        <div className={`h-full ${tone.fill}`} style={{ width: `${Math.max(0, Math.min(100, rounded))}%` }} />
        <div aria-hidden="true" className="absolute -bottom-0.5 -top-0.5 right-0 w-0.5 bg-slate-900" />
      </div>
    </>
  );
}

/** One half-day of the call rate: its own number, its own target, its own bar. Never merged. */
/**
 * `target` is nullable so this same component serves Pharmacy, which has no owner-set standard yet
 * (see PHARMACY_CALL_RATE_TARGET) — a null target shows the raw rate with no "of N" and no
 * red/amber/green bar, since there is nothing to be a percentage of.
 */
function RepCallHalf({
  code,
  label,
  rate,
  target,
}: {
  /** The owner's own shorthand — AM, PM, PH — and the one label that fits a phone's half-width tile. */
  code: string;
  label: string;
  rate: number;
  target: number | null;
}) {
  const attainment = target != null && target > 0 ? (rate / target) * 100 : 0;
  const tone = target != null ? repTone(attainment) : null;
  // One ROW per rate, never three side-by-side columns: on a phone the tile is half the screen, and
  // three columns left each figure 49px — too narrow for a 10.2 at any size bigger than its siblings.
  // A row gives the figure the tile's whole width, so it runs at 26px everywhere, with the code,
  // the target and (where there is room) the full name on the same baseline.
  return (
    <div className="relative min-w-0 pl-3">
      <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${tone?.rail ?? "bg-slate-300"}`} />
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="w-7 shrink-0 text-[12px] font-black tracking-[0.06em] text-slate-900">{code}</span>
        <span className={`text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums ${tone?.text ?? "text-slate-700"}`}>
          {rate.toFixed(1)}
        </span>
        <span className="text-[12px] font-semibold tabular-nums text-slate-500">
          {target != null ? `of ${target}` : "no target"}
        </span>
        {/* Hidden where the tile is narrowest (phone, and the 4-up row from lg to xl). */}
        <span className="ml-auto hidden text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400 sm:inline lg:hidden xl:inline">
          {label}
        </span>
      </p>
      {tone ? (
        <div className="relative mt-1.5 h-1.5 w-full bg-slate-100">
          <div className={`h-full ${tone.fill}`} style={{ width: `${Math.max(0, Math.min(100, attainment))}%` }} />
          <div aria-hidden="true" className="absolute -bottom-0.5 -top-0.5 right-0 w-0.5 bg-slate-900" />
        </div>
      ) : (
        // No standard to reach, so no bar to fill — a dashed rule keeps the three rows aligned
        // without drawing an empty bar that reads as 0%.
        <div aria-hidden="true" className="mt-1.5 h-1.5 w-full border-t border-dashed border-slate-300" />
      )}
    </div>
  );
}

function RepPanel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border border-slate-200 bg-white">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.09em] text-slate-600">{title}</h2>
        {right && <div className="ml-auto">{right}</div>}
      </header>
      {children}
    </section>
  );
}

/** An alert row: the count first, the label second, so the panel reads at a glance. */
function RepNeedRow({
  count,
  rail,
  headline,
  detail,
  href,
  cta,
}: {
  count: number;
  rail: string;
  headline: string;
  detail: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-slate-200 px-3 py-2.5 last:border-b-0">
      <span aria-hidden="true" className={`w-1 self-stretch ${rail}`} />
      <span className="min-w-[28px] text-[18px] font-bold leading-none tabular-nums text-slate-900">{count}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-snug text-slate-900">{headline}</span>
        <span className="mt-0.5 block text-[11px] leading-snug tabular-nums text-slate-500">{detail}</span>
      </span>
      <Link
        className="shrink-0 border border-slate-300 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.06em] text-slate-700 transition hover:border-orange-400 hover:bg-orange-50 hover:text-orange-800"
        href={href}
      >
        {cta}
      </Link>
    </div>
  );
}

function RepFact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 bg-white px-3 py-2">
      <dt className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">{label}</dt>
      <dd className={`mt-0.5 text-[13px] font-bold tabular-nums ${tone ?? "text-slate-900"}`}>{value}</dd>
    </div>
  );
}

const REP_TOOLS: { href: string; label: string }[] = [
  { href: "/employee-portals/crm", label: "My visits" },
  { href: "/employee-portals/kpis", label: "My KPIs" },
  { href: "/employee-portals/source-of-sales", label: "Sales dashboard" },
  { href: "/employee-portals/coaching", label: "My coaching reports" },
  { href: "/employee-portals/incentive", label: "My incentive" },
  { href: "/employee-portals/vacation-request", label: "Vacation request" },
  { href: "/employee-portals/payslips", label: "My payslips" },
  // Last, by the owner's instruction: outstation expense is not what a rep's landing page is for.
  { href: "/employee-portals/expenses", label: "Outstation expenses" },
];

function MedicalRepCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const {
    shell,
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    leaveEntitlementDays,
    mrSalesAchievement,
    monthlySalesTrend,
    mrFieldKpis,
    doubleVisitPulse,
    earlyBirdStars,
  } = snapshot;

  const totalPending = pendingVacationCount + pendingExcuseCount;
  const kpis = mrFieldKpis;
  const serviceDuration = shell.hrContract?.serviceDurationText;
  const daysUntilRenewal = shell.hrContract?.daysUntilRenewal;

  // Oldest first, whatever order the snapshot hands over. A month with no target carries no
  // achievement at all — targets only start at 2026-07 — so it is excluded from the scale, from
  // the fallback and from the delta rather than being drawn as 0%, which would read as a collapse.
  const trend = [...(monthlySalesTrend ?? [])].sort((a, b) => a.year - b.year || a.month - b.month);
  const closed = trend.filter((t) => t.targetValue > 0);
  const noTarget = trend.filter((t) => t.targetValue <= 0);
  const trendMax = Math.max(100, ...closed.map((t) => Math.round(t.achievementPercent)));

  // Synthetic UTC dates, formatted as UTC on purpose: these are period labels, not instants, and
  // Cairo would shift them back a month. Same reason the rest of this file does it.
  const monthName = (m: number, y: number) =>
    `${new Date(Date.UTC(2000, m - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${y}`;
  // The board hands over "September 2026"; a tile meta has room for "Sep 2026".
  const shortPeriod = (label: string | undefined) => (label ? label.replace(/^(\w{3})\w*/, "$1") : undefined);
  const monthShort = (m: number) =>
    new Date(Date.UTC(2000, m - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();

  // mrSalesAchievement is the CURRENT Cairo month, which is empty until that month's sales are
  // uploaded. Rather than print an empty tile beside a chart full of closed months, fall back to
  // the newest closed month and say which month is on screen.
  const cairoNow = currentCairoDateParts();
  const latestClosed = closed.length > 0 ? closed[closed.length - 1] : null;
  const priorClosed = closed.length > 1 ? closed[closed.length - 2] : null;
  const achFromCurrent = mrSalesAchievement != null;
  const achValue = mrSalesAchievement ?? latestClosed;
  const achPct = achValue ? Math.max(0, Math.round(achValue.achievementPercent)) : null;
  const achMonth = achFromCurrent
    ? monthName(cairoNow.month, cairoNow.year)
    : latestClosed
      ? monthName(latestClosed.month, latestClosed.year)
      : null;
  // Month on month, only when both months being compared are real closed months.
  const achDelta =
    !achFromCurrent && latestClosed && priorClosed
      ? Math.round(latestClosed.achievementPercent) - Math.round(priorClosed.achievementPercent)
      : null;

  const missedDoctors = kpis?.hasMeasurablePlan ? kpis.missedDoctors : 0;
  const openCount = totalPending + missedDoctors;

  return (
    <div className="mx-auto w-full space-y-2" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} />
      <PortalContextBar context="Field Performance" role="Medical Representative" />

      {/* Four measurements, no ornament. Coverage and frequency stand apart on purpose: they
          disagree by design — production has run 68% coverage against 39% frequency in one month —
          and any blend of them hides exactly the gap they exist to expose. */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <RepTile
          hint={achValue ? `${egp(achValue.salesValue)} of ${egp(achValue.targetValue)}` : "No month uploaded"}
          label="Achievement"
          meta={achMonth}
          rail={achPct !== null ? repTone(achPct).rail : undefined}
        >
          {achPct !== null ? (
            <RepPercent
              note={
                achDelta !== null ? (
                  <span
                    className={`text-[11px] font-bold tabular-nums ${achDelta >= 0 ? "text-emerald-700" : "text-rose-600"}`}
                  >
                    {achDelta >= 0 ? `+${achDelta}` : achDelta} pts
                  </span>
                ) : null
              }
              pct={achPct}
            />
          ) : (
            <p className="text-[13px] font-semibold text-slate-400">No sales uploaded</p>
          )}
        </RepTile>

        <RepTile
          hint={
            kpis?.hasMeasurablePlan
              ? `${kpis.visitedDoctors} of ${kpis.plannedDoctors} doctors seen`
              : "No doctors planned"
          }
          label="Coverage"
          meta={shortPeriod(kpis?.monthLabel)}
          rail={kpis?.hasMeasurablePlan ? repTone(kpis.coveragePct).rail : undefined}
        >
          {kpis?.hasMeasurablePlan ? (
            <RepPercent pct={kpis.coveragePct} />
          ) : (
            <p className="text-[13px] font-semibold text-slate-400">No plan to score</p>
          )}
        </RepTile>

        {/* AM and PM, apart, each against its own target and its own bar. Never averaged, and never
            printed with a slash between them — he read "1.63 / 6.57" as one number over another.
            Pharmacy joined 2026-09-05, separate again — see PHARMACY_CALL_RATE_TARGET for why it
            carries no bar and no "of N". */}
        <RepTile
          hint={
            kpis?.noGpsFeed
              ? "Calls logged, but no GPS check-in reached the CRM to prove them"
              : kpis?.hasCallRate
                ? `${kpis.kpiRules === "phoenix" ? "Visits" : "Verified calls"} per day · ${kpis.workingDays} working days`
                : "No calls logged"
          }
          label="Call rate"
          meta={shortPeriod(kpis?.monthLabel)}
          rail="bg-sky-500"
        >
          {/* Ruling A1 (owner, 2026-09-21): the proved rates are blank, not zero, when no GPS
              check-in reached the CRM at all — so the tile says that rather than drawing three 0.00s. */}
          {kpis?.noGpsFeed ? (
            <p className="text-[13px] font-semibold text-slate-400">No GPS feed</p>
          ) : kpis?.hasCallRate ? (
            <div className="space-y-2.5">
              <RepCallHalf code="AM" label="Morning" rate={kpis.amRate ?? 0} target={kpis.amTarget} />
              <RepCallHalf code="PM" label="Afternoon" rate={kpis.pmRate ?? 0} target={kpis.pmTarget} />
              <RepCallHalf code="PH" label="Pharmacy" rate={kpis.pharmacyRate ?? 0} target={kpis.pharmacyTarget} />
            </div>
          ) : (
            <p className="text-[13px] font-semibold text-slate-400">Nothing logged yet</p>
          )}
        </RepTile>

        <RepTile
          hint={
            kpis?.hasMeasurablePlan
              ? `${kpis.onPlanDoctors} of ${kpis.plannedDoctors} at planned frequency`
              : "No doctors planned"
          }
          label="Frequency"
          meta={shortPeriod(kpis?.monthLabel)}
          rail={kpis?.hasMeasurablePlan ? repTone(kpis.frequencyPct).rail : undefined}
        >
          {kpis?.hasMeasurablePlan ? (
            <RepPercent pct={kpis.frequencyPct} />
          ) : (
            <p className="text-[13px] font-semibold text-slate-400">No plan to score</p>
          )}
        </RepTile>
      </div>

      <div className="grid gap-2 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-2">
          {closed.length > 0 && (
            <RepPanel
              right={
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                  {noTarget.length > 0
                    ? `${noTarget.map((t) => monthShort(t.month)).join(", ")} — no target set`
                    : "Uploaded months"}
                </span>
              }
              title="Achievement by month"
            >
              <div className="px-3 pb-3 pt-4">
                <div className="relative flex h-[118px] items-end gap-2">
                  {/* The 100% line, positioned on the same scale as the bars. */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-300"
                    style={{ bottom: `${(100 / trendMax) * 100}%` }}
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute right-0 text-[9px] font-bold tabular-nums text-slate-400"
                    style={{ bottom: `calc(${(100 / trendMax) * 100}% + 2px)` }}
                  >
                    100%
                  </span>
                  {closed.map((t) => {
                    const pct = Math.max(0, Math.round(t.achievementPercent));
                    const isLatest =
                      latestClosed != null && t.year === latestClosed.year && t.month === latestClosed.month;
                    return (
                      <div className="flex h-full min-w-0 flex-1 flex-col justify-end" key={`bar-${t.year}-${t.month}`}>
                        <p
                          className={`mb-1 text-center text-[10px] font-bold tabular-nums ${isLatest ? "text-slate-900" : "text-slate-500"}`}
                        >
                          {pct}%
                        </p>
                        {/* Capped width: with only two scorable months, full-width bars read as
                            slabs rather than as a chart. */}
                        <div
                          className={`mx-auto w-full max-w-[84px] ${repTone(pct).fill} ${isLatest ? "outline outline-1 outline-slate-900" : ""}`}
                          style={{ height: `${Math.max(2, Math.min(100, (pct / trendMax) * 100))}%` }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1.5 flex gap-2 border-t border-slate-200 pt-1.5">
                  {closed.map((t) => (
                    <div className="min-w-0 flex-1 text-center" key={`lab-${t.year}-${t.month}`}>
                      <p className="text-[10px] font-bold tracking-[0.04em] text-slate-600">{monthShort(t.month)}</p>
                      <p className="text-[9px] uppercase tracking-[0.04em] text-slate-400">
                        {egpCompact(t.salesValue)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </RepPanel>
          )}

          <RepPanel
            right={
              pendingCountsAvailable ? (
                <span
                  className={`border px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.06em] tabular-nums ${openCount > 0 ? "border-orange-300 bg-orange-50 text-orange-800" : "border-emerald-300 bg-emerald-50 text-emerald-800"}`}
                >
                  {openCount} open
                </span>
              ) : null
            }
            title="Needs you"
          >
            {!pendingCountsAvailable ? (
              <p className="px-3 py-3 text-[12px] font-semibold text-slate-400">Requests unavailable — not zero</p>
            ) : openCount === 0 ? (
              <p className="px-3 py-3 text-[12px] font-semibold text-emerald-700">
                Nothing open — no requests waiting, no doctor missed
              </p>
            ) : (
              <>
                {totalPending > 0 && (
                  <RepNeedRow
                    count={totalPending}
                    cta="Track"
                    detail={`${pendingVacationCount} vacation · ${pendingExcuseCount} excuse`}
                    headline="Requests waiting on your manager"
                    href="/employee-portals/approvals-hub"
                    rail="bg-amber-500"
                  />
                )}
                {missedDoctors > 0 && kpis && (
                  <RepNeedRow
                    count={missedDoctors}
                    cta="Open"
                    detail={`${kpis.visitedDoctors} of ${kpis.plannedDoctors} covered · ${kpis.monthLabel}`}
                    headline="Planned doctors not seen yet"
                    href="/employee-portals/kpis"
                    rail="bg-orange-500"
                  />
                )}
              </>
            )}
          </RepPanel>

          <RepPanel title="Your record">
            <dl className="grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-3">
              <RepFact
                label="Annual leave balance"
                value={leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "Not recorded"}
              />
              {serviceDuration && <RepFact label="Employment duration" value={serviceDuration} />}
              {daysUntilRenewal != null && (
                <RepFact
                  label="Until contract renewal"
                  tone={daysUntilRenewal <= 30 ? "text-rose-700" : daysUntilRenewal <= 60 ? "text-amber-700" : undefined}
                  value={`${daysUntilRenewal} days`}
                />
              )}
              {doubleVisitPulse && (
                <>
                  <RepFact label="Double visits this month" value={String(doubleVisitPulse.dvsThisMonth)} />
                  <RepFact label="Double visits, 90 days" value={String(doubleVisitPulse.dvsLast90Days)} />
                  {doubleVisitPulse.daysSinceLastDv != null && (
                    <RepFact
                      label="Last double visit"
                      value={doubleVisitPulse.daysSinceLastDv === 0 ? "Today" : `${doubleVisitPulse.daysSinceLastDv} days ago`}
                    />
                  )}
                </>
              )}
            </dl>
          </RepPanel>
        </div>

        <div className="min-w-0 space-y-2">
          {/* The rep's own landing page is the whole point of the competition — this is where he
              sees who is currently the star and what it would take to be next. */}
          <EarlyBirdOfTheFortnightCard stars={earlyBirdStars} />

          <RepPanel title="My tools">
            <nav>
              {REP_TOOLS.map((tool) => (
                <Link
                  className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 text-[12px] font-medium text-slate-800 transition last:border-b-0 hover:bg-orange-50 hover:text-orange-800"
                  href={tool.href}
                  key={tool.href}
                >
                  {tool.label}
                  <ArrowRight aria-hidden="true" className="ml-auto h-3.5 w-3.5 shrink-0 text-orange-600" />
                </Link>
              ))}
            </nav>
          </RepPanel>
        </div>
      </div>
    </div>
  );
}

// --- Standard / MR layout ---

function StandardCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const {
    shell,
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    leaveEntitlementDays,
    mrSalesAchievement,
    role,
    plansAwaitingManagerApproval,
    plansCountAvailable,
  } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount + plansCount;
  // Both legs must have loaded for the sum to mean anything — a failed plans lookup defaults to 0
  // and would otherwise silently understate totalPending rather than reading as unknown.
  const pendingAvailable = pendingCountsAvailable && plansCountAvailable;

  const ach = mrSalesAchievement;
  const pct = ach ? Math.max(0, Math.min(100, Math.round(ach.achievementPercent))) : null;
  const achColor =
    pct === null ? "text-slate-900" : pct >= 100 ? "text-emerald-600" : pct >= 90 ? "text-amber-600" : "text-orange-500";
  const barColor =
    pct === null ? "bg-orange-500" : pct >= 100 ? "bg-emerald-500" : pct >= 90 ? "bg-amber-400" : "bg-orange-500";

  // Built for the retired Talent Acquisition seat, HR/office staff who had no approval
  // authority (Approvals Hub was hidden from her sidebar entirely, see navigation.ts's
  // showActionsTab) and no outstation expenses of her own, so both quick-access surfaces were
  // dropped here too, matching the sidebar. See navigation.ts: no portal-mode role is HR/office
  // staff since that seat was retired on 2026-08-28 — both successor bundles (HR Advisory, HR
  // Operations) are admin-shell roles — so `isPortalHrOfficeStaff` below is always false and
  // every StandardCommandCenter role now takes the unaffected path.
  const isPortalHrOfficeStaff = new Set<string>([]).has(role);

  return (
    <div className="mx-auto w-full space-y-3 sm:space-y-5" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} />
      <PortalContextBar role={role} context={shell.employee.department || ""} />

      <GlanceStrip
        items={[
          ...(ach && pct !== null
            ? [
                {
                  icon: TrendingUp,
                  value: `${pct}%`,
                  label: "achievement",
                  href: "/employee-portals/source-of-sales",
                  urgent: pct < 70,
                },
              ]
            : []),
          ...(isPortalHrOfficeStaff
            ? []
            : [
                {
                  icon: CalendarX2,
                  value: pendingAvailable ? String(totalPending) : "—",
                  label: pendingAvailable && totalPending === 1 ? "pending request" : "pending requests",
                  href: "/employee-portals/approvals-hub",
                  urgent: pendingAvailable && totalPending > 0,
                },
              ]),
          {
            icon: CalendarDays,
            value: leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—",
            label: "leave balance",
            href: "/employee-portals/vacation-request",
          },
          // NO PAYSLIP TILE: payslip data (amount OR month) must never render on any
          // overview/landing surface for any role — owner rule. It lives only on
          // /employee-portals/payslips.
        ]}
      />
      <QuickActions
        actions={[
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
          ...(isPortalHrOfficeStaff ? [] : [{ href: "/employee-portals/plans", icon: ClipboardCheck, label: "My Plans" }]),
          ...(isPortalHrOfficeStaff ? [] : [{ href: "/employee-portals/expenses", icon: ReceiptText, label: "My Expenses" }]),
          { href: "/employee-portals/report-it", icon: Activity, label: "Report It" },
        ]}
      />
      {!isPortalHrOfficeStaff && !pendingAvailable ? (
        <PendingCountsUnavailable />
      ) : !isPortalHrOfficeStaff && totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : null}

      {ach && pct !== null && (
        <div className="overflow-hidden border border-slate-200">
          <div className="bg-slate-900 px-5 py-3">
            <h2 className="text-phx-2xs font-bold uppercase tracking-widest text-slate-300">
              This Month | Achievement
            </h2>
          </div>
          <div className="bg-white px-4 py-4 sm:px-6 sm:py-6">
            <div className="flex items-end gap-3">
              <p className={`text-4xl font-black leading-none tabular-nums sm:text-5xl ${achColor}`}>{pct}%</p>
              <p className="mb-1 text-sm text-slate-500">of target</p>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden bg-slate-100">
              <div
                className={`h-full transition-[width] duration-700 ${barColor}`}
                style={{ width: `${Math.max(4, pct)}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-800">{egp(ach.salesValue)} sold</span>
              <span className="text-slate-500">target {egp(ach.targetValue)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="overflow-hidden border border-slate-200">
        <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
          <h2 className="text-phx-2xs font-bold uppercase tracking-widest text-slate-300">My Workspace</h2>
          <div className="h-1.5 w-12 bg-orange-500" />
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2">
          {/* The retired Talent Acquisition seat held no `coaching` grant, so this tile landed her on the
              "not authorized to view coaching reports" dead end. Guarded like its two
              neighbours below, which were already hidden from her. */}
          {!isPortalHrOfficeStaff && (
            <PremiumNavTile href="/employee-portals/coaching" icon={ClipboardCheck} label="My Coaching" description="Field coaching reports and history" />
          )}
          {!isPortalHrOfficeStaff && (
            <PremiumNavTile href="/employee-portals/plans" icon={CalendarDays} label="My Plans" description="Weekly and monthly field activity" />
          )}
          {!isPortalHrOfficeStaff && (
            <PremiumNavTile href="/employee-portals/expenses" icon={ReceiptText} label="My Expenses" description="Outstation expense tracker" />
          )}
          <PremiumNavTile href="/employee-portals/payslips" icon={Wallet} label="My Payslips" description="View and download salary slips" />
        </div>
      </div>

      {!isPortalHrOfficeStaff && !pendingAvailable ? (
        <PendingCountsUnavailable />
      ) : !isPortalHrOfficeStaff && totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-4 py-3 sm:px-5 sm:py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear — nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}

/**
 * The role-specific dashboard. Nothing wraps it and nothing precedes it.
 *
 * There used to be a `space-y-4` wrapper here holding the plan score above the role dashboard —
 * and therefore above the identity card, which broke the owner's rule that nothing sits above a
 * person's own identity banner. The card now travels inside PortalIdentityBand, which every branch
 * below renders as its first element. Do not reintroduce a wrapper here: whatever is added would
 * land above the identity card again.
 */
export function PortalCommandCenter({ snapshot, access }: { snapshot: PortalHomeSnapshot; access?: AccessContext }) {
  switch (snapshot.role) {
    case "Product Manager":
    case "Group Product Manager":
      return <PmGpmCommandCenter snapshot={snapshot} />;
    case "Marketing Manager":
      return <MarketingManagerCommandCenter snapshot={snapshot} access={access} />;
    case "District Manager":
      return <DsmCommandCenter snapshot={snapshot} access={access} />;
    case "National Sales Manager":
      return <NsmCommandCenter snapshot={snapshot} access={access} />;
    case "Regional Manager":
      return <RmCommandCenter snapshot={snapshot} access={access} />;
  }
  if (snapshot.role.toLowerCase() === "medical rep") return <MedicalRepCommandCenter snapshot={snapshot} />;
  return <StandardCommandCenter snapshot={snapshot} />;
}
