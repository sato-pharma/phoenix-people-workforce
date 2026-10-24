import Link from "next/link";
import { Suspense } from "react";
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

import { IdentityCard } from "@/components/employee-portal/identity-card";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import { RepKpiMonthPicker } from "@/components/employee-portal/rep-kpi-month-picker";
import { RepHonourStrip } from "@/components/employee-portal/rep-honour-strip";
import { RepTodayPlanPanel } from "@/components/employee-portal/rep-today-plan-panel";
import { StreamedDoubleVisitFocus } from "@/components/employee-portal/dashboards/double-visit-focus-stream";
import { DsmCommandCenter } from "@/components/employee-portal/dashboards/dsm-command-center";
import { NsmCommandCenter } from "@/components/employee-portal/dashboards/nsm-command-center";
import { RmCommandCenter } from "@/components/employee-portal/dashboards/rm-command-center";
import { MarketingManagerCommandCenter } from "@/components/employee-portal/dashboards/marketing-manager-command-center";
import { PlanAdherenceDashboardCard } from "@/components/weekly-planning/plan-adherence-report";
import type { AccessContext } from "@/lib/auth/permissions";
import { MyInterviewsCard } from "@/components/employee-portal/my-interviews-card";
import type {
  PortalHomeRepCards,
  PortalHomeRepSales,
  PortalHomeSnapshot,
  PortalMyInterview,
} from "@/lib/employee-portal/home-snapshot";
import type { RepTodayPlan } from "@/lib/phoenix-crm/server/rep-landing";
import type { PortalPlanAdherence } from "@/lib/weekly-planning/plan-adherence-data";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

export function egp(n: number) {
  return new Intl.NumberFormat("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

export function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
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
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 transition-colors group-hover:border-orange-300 group-hover:bg-orange-50 ${adminControlDepthClassName}`}>
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
    <div className={`flex min-w-0 flex-col gap-1 bg-white px-3 py-3 sm:px-7 sm:py-4 ${className}`}>
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
      {/* 🔒 ONE LINE AT EVERY WIDTH — owner, 2026-10-03: "in mobile view I want Line / Joined / Reports
          To to be in one line, not two". It used to pair Line + Joined on a phone and stack Reports To
          under them. Now the three share one row on a phone too; the slate ground still shows through
          the 1px gaps as the rules between cells.
          🔴 THE LAST CELL TAKES THE REST, AND EVERY CELL MAY WRAP. Line and Joined size to their words;
          whichever cell is last grows into what is left, so the row never ends on a bare slate patch
          when there is no manager. Every cell is min-w-0, so a long manager or line name WRAPS onto a
          second line inside its cell — never an ellipsis (banned) and never a sideways scroll (the
          fits-the-screen rule). From sm up nothing changes: the last cell keeps its pr-24 so the Sato
          mark never sits on a name. */}
      <div className="relative flex gap-px">
        {employee.line && (
          <IntelField
            icon={Layers}
            label="Line"
            value={employee.line}
            className={`sm:shrink-0 ${!hireDateLabel && !employee.manager ? "flex-1 sm:pr-24" : "sm:flex-none"}`}
          />
        )}
        {hireDateLabel && (
          <IntelField
            icon={CalendarDays}
            label="Joined"
            value={hireDateLabel}
            className={`sm:shrink-0 ${!employee.manager ? "flex-1 sm:pr-24" : "sm:flex-none"}`}
          />
        )}
        {employee.manager && (
          <IntelField icon={User} label="Reports To" value={employee.manager} className="flex-1 sm:pr-24" />
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
  myInterviews,
  planAdherence,
  shell,
}: {
  /** This person's own upcoming interviews. REQUIRED, like planAdherence, so no landing surface can
   * silently drop the card: every call site passes snapshot.myInterviews, and the card itself
   * renders nothing when the list is empty (which it is for almost everyone). */
  myInterviews: PortalMyInterview[];
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
      <MyInterviewsCard interviews={myInterviews} />
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
     of container the label gets ~132px and reads on two lines.

     `@container` sits on a WRAPPER, never on the grid itself: an element's own container query
     resolves against its nearest ANCESTOR container, so `@2xl:grid-cols-3` on the element that
     declares `@container` looked past itself, found no container anywhere up the portal, and the
     strip stayed one column at every width (measured 2026-09-25: a single 1408px column at a
     1440px window). The cells' `@2xl:` queries keep working — they read the wrapper. */
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-px bg-slate-200 @2xl:grid-cols-3">
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
          className={`flex min-h-[48px] min-w-fit grow basis-[calc(50%-0.25rem)] items-center justify-center gap-2 border border-slate-200 bg-white px-3 py-3 text-xs font-bold uppercase tracking-wide text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 sm:inline-flex sm:min-h-0 sm:grow-0 sm:basis-auto sm:px-4 sm:py-2.5 sm:text-phx-xs ${adminControlDepthClassName}`}
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
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <SectionHead title="Dashboards" />
      <div className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-4 sm:gap-2.5 sm:p-2.5">
        {items.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className={`group flex flex-col items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-4 text-center transition-colors hover:border-orange-300 hover:bg-orange-50 ${adminControlDepthClassName}`}
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
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
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
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />

      {!pendingAvailable ? (
        <PendingCountsUnavailable />
      ) : totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : null}

      <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <SectionHead title="My Workspace" />
        <KeycardGrid cards={cards} />
      </div>

      <DashboardsGrid items={PM_GPM_DASHBOARDS} />

      <ActionStrip items={PM_GPM_ACTIONS} />

      <StreamedDoubleVisitFocus snapshot={snapshot} />
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
    <div className={`flex min-w-0 flex-col border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div aria-hidden="true" className={`h-0.5 w-full ${rail ?? "bg-slate-300"}`} />
      {/* A container, so what fits in the tile is decided by the TILE's width, not the window's. */}
      <div className="@container flex flex-1 flex-col p-3">
        <div className="flex items-baseline gap-2">
          <span className="text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-500">{label}</span>
          {meta && (
            <span className="ml-auto whitespace-nowrap text-phx-3xs font-bold uppercase tracking-[0.08em] text-slate-400">{meta}</span>
          )}
        </div>
        <div className="mt-2">{children}</div>
        {hint && <p className="mt-auto pt-2 text-phx-xs leading-snug text-slate-500">{hint}</p>}
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
        <span className="text-phx-xs font-bold text-slate-400">%</span>
        {note && <span className="ml-auto">{note}</span>}
      </div>
      <div className="relative mt-2 h-1.5 w-full bg-slate-100">
        <div className={`h-full ${tone.fill}`} style={{ width: `${Math.max(0, Math.min(100, rounded))}%` }} />
        <div aria-hidden="true" className="absolute -bottom-0.5 -top-0.5 right-0 w-0.5 bg-slate-900" />
      </div>
    </>
  );
}

/**
 * The frequency split, shown under the big percentage on the Frequency keycard (owner, 2026-09-23).
 *
 * Three COUNTS of planned doctors — never percentages, the percentage stays whole above:
 *   - Exact  (green)  — seen exactly as many times as the plan asked (`onPlanDoctors`).
 *   - Above  (red)    — seen MORE than planned, a deviation on the owner's rule (`overDoctors`;
 *                       always 0 under the Phoenix rules, where an extra visit is not counted).
 *   - Below  (yellow) — seen at least once but FEWER times than planned (`underDoctors`).
 * The colours are the house emerald / rose / amber, the same scale every other tone on this page
 * uses, so a red here means the same as a red anywhere else.
 */
function RepFrequencyBreakdown({ exact, above, below }: { exact: number; above: number; below: number }) {
  const rows: { label: string; value: number; tone: string }[] = [
    { label: "Exact", value: exact, tone: "text-emerald-700" },
    { label: "Above", value: above, tone: "text-rose-600" },
    { label: "Below", value: below, tone: "text-amber-600" },
  ];
  return (
    <dl className="mt-2.5 space-y-1 border-t border-slate-100 pt-2">
      {rows.map((r) => (
        <div className="flex items-baseline justify-between gap-2" key={r.label}>
          <dt className={`text-phx-xs font-bold uppercase tracking-[0.08em] ${r.tone}`}>{r.label}</dt>
          <dd className={`text-phx-base font-bold tabular-nums ${r.tone}`}>{r.value}</dd>
        </div>
      ))}
    </dl>
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
        <span className="w-7 shrink-0 text-phx-sm font-black tracking-[0.06em] text-slate-900">{code}</span>
        <span className={`text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums ${tone?.text ?? "text-slate-700"}`}>
          {rate.toFixed(1)}
        </span>
        <span className="text-phx-sm font-semibold tabular-nums text-slate-500">
          {target != null ? `of ${target}` : "no target"}
        </span>
        {/* Only where the tile itself has room for it (a container query on RepTile's body): the
            window's width said nothing about the tile once the sidebar opened at lg. */}
        <span className="ml-auto hidden text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400 @[13rem]:inline">
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
    <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <header className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <h2 className="text-phx-xs font-bold uppercase tracking-[0.09em] text-slate-600">{title}</h2>
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
      <span className="min-w-[28px] text-phx-xl font-bold leading-none tabular-nums text-slate-900">{count}</span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-phx-md font-semibold leading-snug text-slate-900">{headline}</span>
        <span className="mt-0.5 block break-words text-phx-xs leading-snug tabular-nums text-slate-500">{detail}</span>
      </span>
      {/* 40px tall on a phone — it is the one thing on this row a thumb has to hit. */}
      <Link
        className="inline-flex min-h-10 shrink-0 items-center border border-slate-300 px-3 text-phx-xs font-bold uppercase tracking-[0.06em] text-slate-700 transition hover:border-orange-400 hover:bg-orange-50 hover:text-orange-800 sm:min-h-8"
        href={href}
      >
        {cta}
      </Link>
    </div>
  );
}

function RepFact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  // `grow` on a fixed basis: two to a row on a phone, three from `sm`, and the last fact in a short
  // row stretches to fill it. The facts are optional (no double visit in 90 days, no renewal date),
  // and on a fixed grid an odd count left a solid grey cell — the "empty square" the owner banned.
  return (
    <div className="min-w-0 grow basis-[calc(50%-1px)] bg-white px-3 py-2 sm:basis-[calc(33.333%-1px)]">
      <dt className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">{label}</dt>
      <dd className={`mt-0.5 break-words text-phx-md font-bold tabular-nums ${tone ?? "text-slate-900"}`}>{value}</dd>
    </div>
  );
}

// Synthetic UTC dates, formatted as UTC on purpose: these are period labels, not instants, and
// Cairo would shift them back a month. Same reason the rest of this file does it.
function monthName(m: number, y: number) {
  return `${new Date(Date.UTC(2000, m - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${y}`;
}

// The board hands over "September 2026"; a tile meta has room for "Sep 2026".
function shortPeriod(label: string | undefined) {
  return label ? label.replace(/^(\w{3})\w*/, "$1") : undefined;
}

function monthShort(m: number) {
  return new Date(Date.UTC(2000, m - 1, 1)).toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
}

/**
 * Everything the Achievement tile and the by-month chart print, from the one sales read. Plain
 * arithmetic, no I/O — both cards call it on the same resolved value, so they cannot disagree.
 */
function repAchievementView(sales: PortalHomeRepSales, kpiMonth: string) {
  const { mrSalesAchievement, monthlySalesTrend, mrAchievementPeriod } = sales;

  // Oldest first, whatever order the snapshot hands over. A month with no target carries no
  // achievement at all — targets only start at 2026-07 — so it is excluded from the scale, from
  // the fallback and from the delta rather than being drawn as 0%, which would read as a collapse.
  const trend = [...(monthlySalesTrend ?? [])].sort((a, b) => a.year - b.year || a.month - b.month);
  const closed = trend.filter((t) => t.targetValue > 0);
  const noTarget = trend.filter((t) => t.targetValue <= 0);
  const trendMax = Math.max(100, ...closed.map((t) => Math.round(t.achievementPercent)));

  // THE MONTH ON SCREEN. `kpiMonth` is the running Cairo month unless the rep picked another one
  // from the month box above these tiles (owner, 2026-10-01), and it drives all four of them — the
  // three CRM measures and achievement — so they can never describe two different windows.
  const selectedYear = Number(kpiMonth.slice(0, 4));
  const selectedMonth = Number(kpiMonth.slice(5, 7));

  // 🔒 THE FALLBACK IS THE OWNER'S OWN RULING, PUT TO HIM AND ANSWERED (2026-10-01): "keep the
  // achievement tile falling back to the last published month". It was raised as an open question
  // the morning the month picker shipped, precisely because the tile can read AUG 2026 beside three
  // tiles reading SEP 2026 and that looks like a defect. It is not. DO NOT "FIX" IT into an empty
  // state, a "September not published yet" message, or a blank — that reads as a bug to whoever
  // meets it next, and ripping it out deletes a decision he made in writing.
  //
  // mrSalesAchievement is the SELECTED month, and it is null until that month's Monthly Closing is
  // PUBLISHED — which never happens while the month is still running (the closing golden rule). So
  // a running month is always null here, and the card falls back to the newest published ("closed")
  // month AND NAMES IT in its own meta, because a tile with a number available that prints none is
  // the empty square the owner banned. The label is what keeps the fallback honest: the tile never
  // claims the picked month's achievement, it says which month it is showing.
  //
  // A published month with NO TARGET takes the same path: its achievement is 0 by arithmetic, not
  // by performance, and drawing it would read as a collapse.
  const latestClosed = closed.length > 0 ? closed[closed.length - 1] : null;
  const achFromSelected = mrSalesAchievement != null && mrSalesAchievement.targetValue > 0;
  const achValue = achFromSelected ? mrSalesAchievement : latestClosed;
  const achPct = achValue ? Math.max(0, Math.round(achValue.achievementPercent)) : null;
  // ONE MONTH NAME, from the snapshot's own `mrAchievementPeriod`, which applies exactly the rule
  // above server-side (picked month when it is published with a target, else the newest published
  // month on the trend that has one). The tile's meta and the honour badges below it both print
  // THIS, so they cannot name two different months — which is precisely what deriving it twice did.
  // Falls back to the old local derivation only if the field is somehow absent, never to a guess.
  const achMonth = mrAchievementPeriod
    ? monthName(Number(mrAchievementPeriod.slice(5, 7)), Number(mrAchievementPeriod.slice(0, 4)))
    : achFromSelected
      ? monthName(selectedMonth, selectedYear)
      : latestClosed
        ? monthName(latestClosed.month, latestClosed.year)
        : null;
  // Month on month, against the published month immediately before whichever month the tile ended up
  // showing. Keyed on the month on screen rather than on "am I on the fallback": a picked month that
  // IS published used to lose its delta for no reason other than which branch it arrived by.
  const achIndex = achValue
    ? closed.findIndex(
        (t) =>
          t.year === (achFromSelected ? selectedYear : latestClosed?.year) &&
          t.month === (achFromSelected ? selectedMonth : latestClosed?.month),
      )
    : -1;
  const achPrior = achIndex > 0 ? closed[achIndex - 1] : null;
  const achDelta =
    achIndex >= 0 && achPrior
      ? Math.round(closed[achIndex].achievementPercent) - Math.round(achPrior.achievementPercent)
      : null;

  return { closed, noTarget, trendMax, latestClosed, achValue, achPct, achMonth, achDelta };
}

/**
 * The rep's four slow reads. The landing page asks the snapshot to hand them back still RUNNING
 * (`streamRepCards`), so it paints on the fast reads and each card fills under its own Suspense
 * boundary (owner, 2026-10-23: "the process of shifting from page to page never take more than 1
 * second"). Any other caller gets an awaited snapshot, and the same values are wrapped here as
 * resolved promises, so the cards have one shape to read either way.
 */
function repCardsOf(snapshot: PortalHomeSnapshot): PortalHomeRepCards {
  if (snapshot.repCards) return snapshot.repCards;
  return {
    sales: Promise.resolve({
      mrSalesAchievement: snapshot.mrSalesAchievement,
      monthlySalesTrend: snapshot.monthlySalesTrend,
      mrAchievementPeriod: snapshot.mrAchievementPeriod,
    }),
    rankStanding: Promise.resolve(snapshot.mrRankStanding),
    fieldKpis: Promise.resolve(snapshot.mrFieldKpis),
    record: Promise.resolve({ leaveDaysRemaining: snapshot.leaveDaysRemaining, doubleVisitPulse: snapshot.doubleVisitPulse }),
  };
}

/**
 * What a streamed tile shows for the moment before its numbers land: the real tile's own frame and
 * label, the value drawn as a shimmer bar. The same frame keeps the grid from jumping when it fills.
 */
function RepTileLoading({ label }: { label: string }) {
  return (
    <RepTile label={label}>
      <div aria-busy="true">
        <span className="sr-only">Loading</span>
        <div aria-hidden="true" className="employee-portal-skeleton h-[21px] w-16" />
        <div aria-hidden="true" className="employee-portal-skeleton mt-2 h-1.5 w-full" />
      </div>
    </RepTile>
  );
}

/** The panel equivalent: the real header, two shimmer rows where the body will be. */
function RepPanelLoading({ title }: { title: string }) {
  return (
    <RepPanel title={title}>
      <div aria-busy="true" className="space-y-2 px-3 py-3">
        <span className="sr-only">Loading</span>
        <div aria-hidden="true" className="employee-portal-skeleton h-4 w-3/4" />
        <div aria-hidden="true" className="employee-portal-skeleton h-4 w-1/2" />
      </div>
    </RepPanel>
  );
}

// 🔴 `REP_TOOLS` — the rep's "My tools" rail — WAS REMOVED HERE ON 2026-09-30 at the owner's own
// instruction, and his day took the column. It listed CRM, My KPIs, Source of Sales, My incentive,
// Vacation request, My payslips and Outstation expenses; every one of those is still in the rep's
// sidebar, which is where he actually reaches them. Restoring the rail needs his word, not a
// tidy-up — `tests/portal-tools-grid-fits-a-phone.test.ts` records the removal and fails if it
// comes back on its own.

function MedicalRepCommandCenter({ repTodayPlan, snapshot }: { repTodayPlan: RepTodayPlan | null; snapshot: PortalHomeSnapshot }) {
  const {
    shell,
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    kpiMonth,
    kpiMonthOptions,
    // `earlyBirdStars` is deliberately NOT read here any more — see the note where the card was.
  } = snapshot;

  // 🔴 THE SLOW CARDS STREAM (2026-10-23). Achievement, rank, the three CRM measures and his record
  // are each a read the page used to wait on before painting anything; the slowest of them held a
  // rep on a blank screen for seven seconds at the median. They now arrive under Suspense, inside
  // the same frames, so the page itself answers on the fast reads. Never await them here again.
  const cards = repCardsOf(snapshot);
  const serviceDuration = shell.hrContract?.serviceDurationText;
  const daysUntilRenewal = shell.hrContract?.daysUntilRenewal;

  return (
    <div className="mx-auto w-full space-y-2" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />
      {/* 🔒 ABOVE the context bar, at the TOP of the page and the FULL width of it — the owner's own
          placement, 2026-10-03: "no, put it above Medical Representative / Field Performance". It
          first shipped tucked under the four tiles, on the reasoning that the rank is earned by the
          percentage printed above it; he moved it here, and this is where it stays. An honour is the
          first thing he wants the rep to see, not a footnote to a keycard. It also no longer belongs
          beside that keycard: the badge ranks the whole published window and the keycard shows one
          month. Renders nothing at all when the rep is outside both bands, which is most reps most
          months — by design, so for them the page simply goes on to the KPI month, nothing moves. */}
      {/* 🔒 ONE STRIP — his rank in the company, his rank in his line, and the buttons that take the
          card with him. Owner, 2026-10-03, after the first build: "the page became so crowded. I want
          only a strip telling the rank in company and line, then buttons telling the export or share.
          That simple, easy cake — not all over-engineered." It replaced two full-width medals and a
          separate export panel, ~330px of a phone before he reached his own keycards. Renders nothing
          when he is outside both bands, which is most reps most months — so it streams with NO
          placeholder: a shimmer for a strip most reps never get would promise them a rank. */}
      <Suspense fallback={null}>
        <RepHonourCard standing={cards.rankStanding} />
      </Suspense>
      {/* 🔒 NO "MEDICAL REPRESENTATIVE · FIELD PERFORMANCE" BAR — removed at the owner's instruction,
          2026-10-03: "remove this section, Medical Representative / Field Performance". The rep's
          landing goes straight from the identity rows (and his rank strip, when he has one) to his KPI
          month and keycards. The bar is still used by the other roles' landings; only this one dropped it.
          Do not put it back as a "section header" for the keycards. */}

      {/* Same reason: two columns only when the row itself has the width for them — and only when
          there is a second column to hold. With no approved day the right-hand column renders
          nothing, and a 1fr track holding nothing is the empty square the owner banned, so the split
          itself is conditional and the panels below run full width. */}
      <div className="@container">
        <div className={`grid gap-2 ${repTodayPlan ? "@3xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : ""}`}>
          <div className="min-w-0 space-y-2">
            {/* The month these four tiles are showing, and the box that changes it (owner, 2026-10-01).
                It sits directly ABOVE them and nowhere else on the page, because it governs exactly
                these four — not his day, not his double visits, not the alert rows, all of which stay
                on the real calendar. One row, one label, one control: no hero, no sentence. */}
            <RepKpiMonthPicker month={kpiMonth} options={kpiMonthOptions} />

            {/* Four measurements, no ornament. Coverage and frequency stand apart on purpose: they
                disagree by design — production has run 68% coverage against 39% frequency in one month —
                and any blend of them hides exactly the gap they exist to expose.
                🔴 THEY MOVED INTO THE LEFT COLUMN ON 2026-09-30, at the owner's own instruction, and
                that is WHY they are here rather than across the top: "take two of the key cores of the
                KPIs and put them under each other, so the left side is more tall — and Your day is
                pushed up, because it is very long now and the page is asymmetric." His day runs the
                whole right-hand column from the top; these four fold to 2x2 beside it.
                🔴 THE FOLD IS THE DAY ITSELF, NOT A WIDTH QUERY — THAT IS THE SECOND HALF OF THE FIX,
                2026-09-30. It first shipped as `@3xl:grid-cols-4` on the wrapper below, reasoning that
                the row only reaches 48rem when there is no day beside it. Measured on the running app,
                that reasoning does not hold: the wrapper is a real `inline-size` container 721px wide
                — inside 48rem — and the row still rendered FOUR tracks of 219px, so on a wide screen
                the tiles went back across the top and the left column finished 143px short of his day.
                He saw exactly that and asked for the stack a second time. A query measured not to hold
                is not worth keeping: with a day beside them the tiles are 2x2, full stop, and the
                four-across form is kept only for the no-day layout, where this column IS the page.
                `lg:` was wrong here for a different reason and must not come back — it fired at a
                1024px window whose content was ~636px once the sidebar opened, leaving each tile
                ~127px, and "SEP 2026" broke in two while "10.2 of 10" wrapped.
                Suspense renders no element of its own, so the four tiles stay direct items of this grid
                whether they are still loading or filled. */}
            <div className="@container">
              <div className={`grid gap-2 ${repTodayPlan ? "grid-cols-2" : "grid-cols-2 @3xl:grid-cols-4"}`}>
                <Suspense fallback={<RepTileLoading label="Achievement" />}>
                  <RepAchievementCard kpiMonth={kpiMonth} sales={cards.sales} />
                </Suspense>
                <Suspense
                  fallback={
                    <>
                      <RepTileLoading label="Coverage" />
                      <RepTileLoading label="Call rate" />
                      <RepTileLoading label="Frequency" />
                    </>
                  }
                >
                  <RepFieldTiles fieldKpis={cards.fieldKpis} />
                </Suspense>
              </div>
            </div>

            <Suspense fallback={<RepPanelLoading title="Achievement by month" />}>
              <RepAchievementByMonth kpiMonth={kpiMonth} sales={cards.sales} />
            </Suspense>

            <Suspense fallback={<RepPanelLoading title="Needs you" />}>
              <RepNeedsYou
                fieldKpis={cards.fieldKpis}
                kpiMonth={kpiMonth}
                pendingCountsAvailable={pendingCountsAvailable}
                pendingExcuseCount={pendingExcuseCount}
                pendingVacationCount={pendingVacationCount}
              />
            </Suspense>

            <Suspense fallback={<RepPanelLoading title="Your record" />}>
              <RepRecord daysUntilRenewal={daysUntilRenewal} record={cards.record} serviceDuration={serviceDuration} />
            </Suspense>
          </div>

          {/* 🔴 EARLY BIRDS AND MY TOOLS WERE REMOVED FROM HERE, AND THE DAY TOOK THEIR PLACE
              (owner, 2026-09-30: "it became awful like this — find a way to put it to be contrasting
              and premium polished with the current overview. I recommend that you remove the Early
              Birds and the My Tools, and put the doctors in a premium polished, in their place").

              🔴 THE EARLY BIRD CARD IS RETIRED FROM THE MEDICAL REP'S LANDING PAGE ONLY — his own
              scope, minutes later: "retire early bird only from med rep accounts". It still draws on
              the CEO board and on the DSM, RM, NSM and Marketing Manager command centres, and the
              card itself and the whole Early Birds module are untouched. So do not read this as the
              feature being dropped, and do not follow it through to the other centres.

              Both were his own earlier calls, so this is a REVERSAL, not a tidy-up: the Early Bird
              card was put here because "the rep's own landing page is the whole point of the
              competition", and My tools was the column's quick-access rail. Every tool it listed is
              still one click away in the sidebar, which is where he goes for them; what he wants in
              front of him on opening the page is who he is seeing today. Do not restore either
              without his word. */}
          {repTodayPlan ? (
            <div className="min-w-0 space-y-2">
              <RepTodayPlanPanel plan={repTodayPlan} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// --- The Medical Rep's streamed cards ---
//
// Each awaits only its own read, and each read resolves (never rejects) to the null the awaited
// snapshot would have carried, so a failed read draws the same honest empty state it always did.

async function RepHonourCard({ standing }: { standing: Promise<PortalHomeSnapshot["mrRankStanding"]> }) {
  const mrRankStanding = await standing;
  return <RepHonourStrip standing={mrRankStanding} />;
}

async function RepAchievementCard({ sales, kpiMonth }: { sales: Promise<PortalHomeRepSales>; kpiMonth: string }) {
  const { achValue, achPct, achMonth, achDelta } = repAchievementView(await sales, kpiMonth);
  return (
    <RepTile
      hint={achValue ? `${egp(achValue.salesValue)} of ${egp(achValue.targetValue)}` : "Awaiting closing"}
      label="Achievement"
      meta={achMonth}
      rail={achPct !== null ? repTone(achPct).rail : undefined}
    >
      {achPct !== null ? (
        <RepPercent
          note={
            achDelta !== null ? (
              <span
                className={`text-phx-xs font-bold tabular-nums ${achDelta >= 0 ? "text-emerald-700" : "text-rose-600"}`}
              >
                {achDelta >= 0 ? `+${achDelta}` : achDelta} pts
              </span>
            ) : null
          }
          pct={achPct}
        />
      ) : (
        <p className="text-phx-md font-semibold text-slate-400">No closing published yet</p>
      )}
    </RepTile>
  );
}

/** Coverage, Call rate and Frequency — one CRM read, so one boundary and one moment they fill. */
async function RepFieldTiles({ fieldKpis }: { fieldKpis: Promise<PortalHomeSnapshot["mrFieldKpis"]> }) {
  const kpis = await fieldKpis;
  return (
    <>
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
          <p className="text-phx-md font-semibold text-slate-400">No plan to score</p>
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
          <p className="text-phx-md font-semibold text-slate-400">No GPS feed</p>
        ) : kpis?.hasCallRate ? (
          <div className="space-y-2.5">
            <RepCallHalf code="AM" label="Morning" rate={kpis.amRate ?? 0} target={kpis.amTarget} />
            <RepCallHalf code="PM" label="Afternoon" rate={kpis.pmRate ?? 0} target={kpis.pmTarget} />
            <RepCallHalf code="PH" label="Pharmacy" rate={kpis.pharmacyRate ?? 0} target={kpis.pharmacyTarget} />
          </div>
        ) : (
          <p className="text-phx-md font-semibold text-slate-400">Nothing logged yet</p>
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
          <>
            <RepPercent pct={kpis.frequencyPct} />
            <RepFrequencyBreakdown
              above={kpis.overDoctors}
              below={kpis.underDoctors}
              exact={kpis.onPlanDoctors}
            />
          </>
        ) : (
          <p className="text-phx-md font-semibold text-slate-400">No plan to score</p>
        )}
      </RepTile>
    </>
  );
}

async function RepAchievementByMonth({ sales, kpiMonth }: { sales: Promise<PortalHomeRepSales>; kpiMonth: string }) {
  const { closed, noTarget, trendMax, latestClosed } = repAchievementView(await sales, kpiMonth);
  if (closed.length === 0) return null;
  return (
    <RepPanel
      right={
        <span className="text-right text-phx-2xs font-semibold uppercase tracking-[0.08em] text-slate-400">
          {noTarget.length > 0
            ? `${noTarget.map((t) => monthShort(t.month)).join(", ")} — no target set`
            : "Uploaded months"}
        </span>
      }
      title="Achievement by month"
    >
      {/* The % label rides ON its bar (absolute, above it) instead of sharing the column with
          it. When the label took ~19px of a 118px column, every bar at 84%+ of the scale was
          squeezed to the same ~99px: 85%, 95% and 100% looked identical, and a 100% month
          stopped short of the dashed 100% line drawn on the same scale. */}
      <div className="px-3 pb-3 pt-6">
        <div className="relative flex h-[98px] items-end gap-2">
          {/* The 100% line, positioned on the same scale as the bars. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-300"
            style={{ bottom: `${(100 / trendMax) * 100}%` }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0 text-phx-3xs font-bold tabular-nums text-slate-400"
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
                {/* Capped width: with only two scorable months, full-width bars read as
                    slabs rather than as a chart. */}
                <div
                  className={`relative mx-auto w-full max-w-[84px] ${repTone(pct).fill} ${isLatest ? "outline outline-1 outline-slate-900" : ""}`}
                  style={{ height: `${Math.max(2, Math.min(100, (pct / trendMax) * 100))}%` }}
                >
                  <p
                    className={`absolute inset-x-0 bottom-full mb-1 text-center text-phx-2xs font-bold tabular-nums ${isLatest ? "text-slate-900" : "text-slate-500"}`}
                  >
                    {pct}%
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex gap-2 border-t border-slate-200 pt-1.5">
          {closed.map((t) => (
            <div className="min-w-0 flex-1 text-center" key={`lab-${t.year}-${t.month}`}>
              <p className="text-phx-2xs font-bold tracking-[0.04em] text-slate-600">{monthShort(t.month)}</p>
              <p className="text-phx-3xs uppercase tracking-[0.04em] text-slate-400">
                {egpCompact(t.salesValue)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </RepPanel>
  );
}

/** Streams because its open count adds the planned doctors not seen yet, which is the CRM read. */
async function RepNeedsYou({
  fieldKpis,
  pendingVacationCount,
  pendingExcuseCount,
  pendingCountsAvailable,
  kpiMonth,
}: {
  fieldKpis: Promise<PortalHomeSnapshot["mrFieldKpis"]>;
  pendingVacationCount: number;
  pendingExcuseCount: number;
  pendingCountsAvailable: boolean;
  kpiMonth: string;
}) {
  const kpis = await fieldKpis;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  const missedDoctors = kpis?.hasMeasurablePlan ? kpis.missedDoctors : 0;
  const openCount = totalPending + missedDoctors;

  return (
    <RepPanel
      right={
        pendingCountsAvailable ? (
          <span
            className={`border px-1.5 py-px text-phx-2xs font-bold uppercase tracking-[0.06em] tabular-nums ${openCount > 0 ? "border-orange-300 bg-orange-50 text-orange-800" : "border-emerald-300 bg-emerald-50 text-emerald-800"}`}
          >
            {openCount} open
          </span>
        ) : null
      }
      title="Needs you"
    >
      {!pendingCountsAvailable ? (
        <p className="px-3 py-3 text-phx-sm font-semibold text-slate-400">Requests unavailable — not zero</p>
      ) : openCount === 0 ? (
        <p className="px-3 py-3 text-phx-sm font-semibold text-emerald-700">
          Nothing open — no requests waiting, no doctor missed
        </p>
      ) : (
        <>
          {/* Each kind goes to the page that actually lists it. "Track" used to open the
              approvals hub, which drops leave and excuse requests from every tab — a dead end
              — and the count includes requests already with HR, so the heading no longer
              says "your manager". */}
          {pendingVacationCount > 0 && (
            <RepNeedRow
              count={pendingVacationCount}
              cta="Track"
              detail="With your manager or HR"
              headline={pendingVacationCount === 1 ? "Vacation request in approval" : "Vacation requests in approval"}
              href="/employee-portals/vacation-report?tab=requests"
              rail="bg-amber-500"
            />
          )}
          {pendingExcuseCount > 0 && (
            <RepNeedRow
              count={pendingExcuseCount}
              cta="Track"
              detail="With your manager or HR"
              headline={pendingExcuseCount === 1 ? "Excuse in approval" : "Excuses in approval"}
              href="/employee-portals/excuses"
              rail="bg-amber-500"
            />
          )}
          {missedDoctors > 0 && kpis && (
            <RepNeedRow
              count={missedDoctors}
              cta="Open"
              detail={`${kpis.visitedDoctors} of ${kpis.plannedDoctors} covered · ${kpis.monthLabel}`}
              headline="Planned doctors not seen yet"
              // The month this row just NAMED, carried through to the board, AND the tab that
              // answers the row. The KPIs page reads `?month=YYYY-MM` and otherwise opens on
              // the running month, so a bare link made the row say September and its own Open
              // button show October; it reads `?tab=coverage` too, and without it the board
              // opened on Summary — three KPIs and no list of the doctors this row counted.
              // Coverage is the one tab that names them (it loads `coverageDoctors`), so the
              // owner asked for the button to land there (2026-10-01). It is a page of its own
              // since 2026-10-14, so the link goes straight to it instead of through the KPIs
              // page's redirect.
              href={`/employee-portals/kpis/coverage?month=${kpiMonth}`}
              rail="bg-orange-500"
            />
          )}
        </>
      )}
    </RepPanel>
  );
}

async function RepRecord({
  record,
  serviceDuration,
  daysUntilRenewal,
}: {
  record: PortalHomeRepCards["record"];
  serviceDuration: string | null | undefined;
  daysUntilRenewal: number | null | undefined;
}) {
  const { leaveDaysRemaining, doubleVisitPulse } = await record;
  return (
    <RepPanel title="Your record">
      <dl className="flex flex-wrap gap-px bg-slate-200">
        <RepFact
          label="Annual leave left"
          value={leaveDaysRemaining != null ? `${leaveDaysRemaining} days` : "Not recorded"}
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
  );
}

// --- Standard / MR layout ---

function StandardCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const {
    shell,
    pendingVacationCount,
    pendingExcuseCount,
    pendingCountsAvailable,
    leaveDaysRemaining,
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
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />
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
            value: leaveDaysRemaining != null ? `${leaveDaysRemaining} days` : "—",
            label: "annual leave left",
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
          {/* The "My Coaching" tile was removed here on 2026-09-29 (owner: hide training-manager +
              coaching system-wide in the portal). */}
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
export function PortalCommandCenter({
  access,
  repTodayPlan = null,
  snapshot,
}: {
  access?: AccessContext;
  /** The rep's planned day — what replaced the Phoenix CRM Today module (owner, 2026-09-30). */
  repTodayPlan?: RepTodayPlan | null;
  snapshot: PortalHomeSnapshot;
}) {
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
  if (snapshot.role.toLowerCase() === "medical rep") return <MedicalRepCommandCenter repTodayPlan={repTodayPlan} snapshot={snapshot} />;
  return <StandardCommandCenter snapshot={snapshot} />;
}
