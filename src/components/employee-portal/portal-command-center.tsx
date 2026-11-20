import Link from "next/link";
import { NO_PUBLISHED_MONTH } from "@/lib/employee-portal/unranked-managers";
import {
  achievementBand,
  compactEgp,
  pendingItems,
  rankingBoardEmptyText,
  wholePercent,
  type AchievementBand,
} from "@/lib/employee-portal/rsm-home-summary";
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
  User,
  Wallet,
} from "lucide-react";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import { TelegramHomeCard } from "@/components/notifications/telegram-home-card";
import { RepKpiMonthPicker } from "@/components/employee-portal/rep-kpi-month-picker";
import { RepHonourStrip } from "@/components/employee-portal/rep-honour-strip";
import { RepTodayPlanPanel } from "@/components/employee-portal/rep-today-plan-panel";
import { StreamedDoubleVisitFocus } from "@/components/employee-portal/dashboards/double-visit-focus-stream";
import { DsmCommandCenter } from "@/components/employee-portal/dashboards/dsm-command-center";
import { NsmCommandCenter } from "@/components/employee-portal/dashboards/nsm-command-center";
import { RmCommandCenter } from "@/components/employee-portal/dashboards/rm-command-center";
import { MyMapSnapshotCard } from "@/components/employee-portal/dashboards/my-map-snapshot-card";
import { MarketingManagerCommandCenter } from "@/components/employee-portal/dashboards/marketing-manager-command-center";
import { PlanAdherenceDashboardCard } from "@/components/weekly-planning/plan-adherence-report";
import type { AccessContext } from "@/lib/auth/permissions";
import { MyInterviewsCard } from "@/components/employee-portal/my-interviews-card";
import type {
  PortalHomeRepCards,
  PortalHomeRepSales,
  PortalHomeSnapshot,
  PortalMyInterview,
  Streamed,
} from "@/lib/employee-portal/home-snapshot";
import type { RepTodayPlan } from "@/lib/phoenix-crm/server/rep-landing";
import type { PortalPlanAdherence } from "@/lib/weekly-planning/plan-adherence-data";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { adminControlDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_FOCUS,
  LANDING_ROW_LINK,
  LandingBar,
  LandingEmpty,
  LandingFigure,
  LandingMeta,
  LandingNavyBoard,
  LandingPanel,
  LandingTick,
} from "@/components/employee-portal/landing-kit";

export function egp(n: number) {
  return new Intl.NumberFormat("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

/**
 * The navy-headed panel the ADMIN shell's command centres still draw (CEO, Finance, Needs You,
 * System Admin, the personal workspace). The portal landing no longer uses it — its pending rows
 * moved into the landing kit's white panel in the 2026-11-20 redesign — and its look is left for the
 * admin batch of that redesign, so this file changes no admin page.
 */
export function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5 sm:px-5 sm:py-3">
        <h2 className="min-w-0 break-words text-phx-xs font-bold uppercase tracking-widest text-slate-300">{title}</h2>
        <div className="h-1.5 w-12 shrink-0 bg-orange-500" />
      </div>
      <div className="bg-white p-3 sm:p-5">{children}</div>
    </div>
  );
}

/**
 * One row of a landing's workspace list: the icon in plain line weight, the name in navy capitals,
 * its one-line purpose from `sm` up, and an arrow that steps forward on hover. No filled icon square
 * and no orange wash — the 2026-11-20 redesign keeps orange for the title tick alone.
 */
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
      className={`group flex min-h-[52px] min-w-0 items-center gap-3 bg-white px-3 py-3 sm:min-h-[64px] sm:px-4 ${LANDING_ROW_LINK}`}
    >
      <Icon className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-[#08111f] motion-reduce:transition-none" />
      <span className="min-w-0 flex-1">
        <span className="block break-words text-phx-sm font-bold uppercase tracking-[0.1em] text-[#08111f]">{label}</span>
        <span className="mt-0.5 hidden break-words text-phx-sm leading-snug text-slate-500 sm:block">{description}</span>
      </span>
      {badge != null && badge > 0 && (
        <span className="shrink-0 border border-[#08111f] px-1.5 py-px text-phx-xs font-bold tabular-nums text-[#08111f]">{badge}</span>
      )}
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-[#08111f] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
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
      className={`group flex min-h-[52px] items-center gap-3 border-b border-slate-200 bg-white px-3 py-3 last:border-b-0 sm:px-4 ${LANDING_ROW_LINK}`}
    >
      <Icon className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-[#08111f] motion-reduce:transition-none" />
      <div className="min-w-0 flex-1">
        <p className="break-words text-phx-md font-bold text-[#08111f]">{label}</p>
        <p className="break-words text-phx-xs leading-snug text-slate-500">{sub}</p>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-[#08111f] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
    </Link>
  );
}

/**
 * One pending item as a whole-row link: a status rail, the icon, the words in navy, the arrow.
 * The rail carries the tone — orange for a decision that waits on the viewer, amber for the
 * viewer's own request waiting on someone else — the same two the rep's Needs you rows use.
 */
function PendingRow({
  href,
  icon: Icon,
  rail,
  text,
}: {
  href: string;
  icon: React.ElementType;
  rail: string;
  text: string;
}) {
  return (
    <Link
      href={href}
      className={`group flex min-h-12 items-center gap-3 border-b border-slate-200 px-3 py-3 last:border-b-0 sm:px-4 ${LANDING_ROW_LINK}`}
    >
      <span aria-hidden="true" className={`w-1 self-stretch ${rail}`} />
      <Icon className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1 break-words text-phx-md font-bold leading-snug text-[#08111f]">{text}</span>
      <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-[#08111f] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
    </Link>
  );
}

/**
 * What waits on the viewer, and apart from it, what the viewer is waiting on.
 *
 * The vacation and excuse counts on the landing snapshot are the viewer's OWN requests
 * (`employee_hr_id` is the viewer), waiting on the viewer's manager or HR. They used to sit under
 * "Needs Your Decision" beside the plans awaiting the viewer's approval and open the Approvals Hub,
 * where there was nothing to decide. `pendingItems` (rsm-home-summary.ts) splits them; the viewer's
 * own requests open the viewer's own request pages.
 *
 * Two white panels of whole-row links since the 2026-11-20 redesign — the orange-filled tiles they
 * replaced shouted every pending item at the same volume as an alarm.
 */
export function PendingActions({
  pendingVacationCount,
  pendingExcuseCount,
  plansAwaitingApproval = 0,
}: {
  pendingVacationCount: number;
  pendingExcuseCount: number;
  plansAwaitingApproval?: number;
}) {
  const { decisions, own } = pendingItems({
    plansAwaitingApproval,
    ownVacationRequests: pendingVacationCount,
    ownExcuseRequests: pendingExcuseCount,
  });
  if (decisions.length === 0 && own.length === 0) return null;
  return (
    <div className="space-y-2">
      {decisions.length > 0 ? (
        <LandingPanel right={<LandingMeta items={[`${decisions.length} waiting`]} />} title="Needs Your Decision">
          {decisions.map((item) => (
            <PendingRow href={item.href} icon={ClipboardCheck} key={item.key} rail="bg-orange-500" text={item.text} />
          ))}
        </LandingPanel>
      ) : null}
      {own.length > 0 ? (
        <LandingPanel title="Your Requests in Progress">
          {own.map((item) => (
            <PendingRow
              href={item.href}
              icon={item.key === "excuse" ? CalendarX2 : CalendarDays}
              key={item.key}
              rail="bg-amber-500"
              text={item.text}
            />
          ))}
        </LandingPanel>
      ) : null}
    </div>
  );
}

/** A failed count is said in words — never drawn as a calm zero. */
export function PendingCountsUnavailable() {
  return (
    <div className={`flex items-center gap-3 border border-slate-200 bg-white px-3 py-3 sm:px-4 ${adminSoftDepthClassName}`} role="status">
      <span aria-hidden="true" className="w-1 self-stretch bg-amber-500" />
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
      <span className="min-w-0 break-words text-phx-md font-semibold text-[#08111f]">
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
    // `min-w-min`, not `min-w-0`: a cell never shrinks below its own words. With `min-w-0` the
    // last cell (basis 0) was squeezed to nothing on a small Android phone on Large text (~280px
    // CSS wide) and "REPORTS TO / Osama Mohamed" ran out past the screen edge, clipped. Now each
    // cell keeps its unbroken label and its longest word, and the values wrap inside their cells.
    <div className={`flex min-w-min flex-col gap-1 bg-white px-2 py-3 min-[360px]:px-3 sm:px-7 sm:py-4 ${className}`}>
      {/* The LABEL never breaks — "REPORTS / TO" on two lines beside one-line "LINE" and "JOINED" is
          the irregular row he saw on his phone. The tracking eases to 0.12em on a phone so the
          three labels fit a 360px Android row in Roboto and an iPhone's Helvetica Neue; under 360px
          the icon steps aside to keep all three on the one line. The VALUE below still wraps inside
          its cell, so nothing is ever cut. */}
      <div className="flex items-center gap-1.5">
        <Icon className="hidden h-3 w-3 shrink-0 text-slate-400 min-[360px]:block" />
        <span className="whitespace-nowrap text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500 sm:tracking-[0.18em]">{label}</span>
      </div>
      {/* Wraps rather than clips. The old value carried `whitespace-nowrap` inside an
          `overflow-hidden` band, which is the blindness the golden rule names: a long manager name
          was cut off with `main` still measuring a clean 375/375, because clipped content never
          reaches scrollWidth. Wrapping is the permitted answer; the ellipsis ban is untouched. */}
      <span className="text-sm font-black leading-snug text-[#08111f] [overflow-wrap:break-word] sm:text-base">{value}</span>
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
    <div className={`relative border border-t-2 border-slate-200 border-t-[#F05A1A] bg-slate-200 ${adminSoftDepthClassName}`}>
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
async function BandPlanAdherence({ adherence }: { adherence: Streamed<PortalPlanAdherence | null> }) {
  const planAdherence = await adherence;
  if (!planAdherence?.latest) return null;
  return <PlanAdherenceDashboardCard adherence={planAdherence} planBaseHref="/employee-portals/approvals/plan" />;
}

async function BandInterviews({ interviews }: { interviews: Streamed<PortalMyInterview[]> }) {
  const myInterviews = await interviews;
  return <MyInterviewsCard interviews={myInterviews} />;
}

export function PortalIdentityBand({
  myInterviews,
  planAdherence,
  shell,
}: {
  /** This person's own upcoming interviews. REQUIRED, like planAdherence, so no landing surface can
   * silently drop the card: every call site passes snapshot.myInterviews, and the card itself
   * renders nothing when the list is empty (which it is for almost everyone). */
  myInterviews: Streamed<PortalMyInterview[]>;
  planAdherence: Streamed<PortalPlanAdherence | null>;
  shell: EmployeePortalShellData;
}) {
  return (
    <>
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />
      {/* Each fills in on its own, and draws nothing until it does: most people have neither card, so a
          placeholder here would be an empty square for nearly everyone (2026-11-01, "fix the portal home
          slow opens"). Suspense adds no element, so they stay direct children of the caller's rhythm. */}
      <Suspense fallback={null}>
        <BandPlanAdherence adherence={planAdherence} />
      </Suspense>
      <Suspense fallback={null}>
        <BandInterviews interviews={myInterviews} />
      </Suspense>
      {/* Travels with the identity band, per the design note above — every role lands here, so
          this is the one place a push opt-in nudge reaches every employee-portal role's home in
          a single edit. Renders nothing until it has checked this person's own state. */}
      <PushOptInNudge />
      <TelegramHomeCard />
    </>
  );
}

/* ── PortalContextBar ────────────────────────────────────────────── */

/**
 * The role and the territory it covers, under the identity rows. A white strip with the house tick
 * since the 2026-11-20 redesign — the orange-washed bar it replaced was the loudest thing on a
 * manager's landing while saying the least.
 */
export function PortalContextBar({ role, context }: { role: string; context: string }) {
  return (
    <div className={`flex items-center gap-3 border border-slate-200 bg-white px-3 py-2.5 sm:px-4 ${adminSoftDepthClassName}`}>
      <LandingTick />
      <div className="min-w-0">
        <p className="break-words text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">{role}</p>
        {/* Wraps: a Regional Manager's territory names every region under the seat (#162), which
            ran past a phone's edge with the nowrap this used to carry. */}
        {context ? <p className="break-words text-phx-base font-bold leading-snug text-[#08111f]">{context}</p> : null}
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
     1440px window). The cells' `@2xl:` queries keep working — they read the wrapper.

     The 2026-11-20 redesign: each cell is a figure first — 22px navy, the label in small capitals
     under it — and an urgent cell says so with a status rail on its left edge, not an orange box. */
  return (
    <div className={`border border-slate-200 ${adminSoftDepthClassName}`}>
      <div className="@container">
        <div className="grid grid-cols-1 gap-px bg-slate-200 @2xl:grid-cols-3">
          {items.map((item, i) => (
            <Link
              key={i}
              href={item.href}
              className={`group relative flex min-h-[64px] items-center gap-3 bg-white px-3 py-3 @2xl:px-4 ${LANDING_ROW_LINK}`}
            >
              <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${item.urgent ? "bg-orange-500" : "bg-transparent"}`} />
              <item.icon className={`h-4 w-4 shrink-0 ${item.urgent ? "text-orange-600" : "text-slate-400"}`} />
              <div className="min-w-0 flex-1">
                <p
                  className={`whitespace-nowrap text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums ${item.urgent ? "text-orange-700" : "text-[#08111f]"}`}
                >
                  {item.value}
                </p>
                {/* The VALUE keeps its nowrap — it is a short number and must not break across
                    lines. The label is prose and wraps: in the three-column form each cell leaves it
                    about 132px, and "pending requests" does not fit on one line. */}
                <p className="mt-1 break-words text-phx-xs font-bold uppercase leading-snug tracking-[0.08em] text-slate-500">{item.label}</p>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-[#08111f] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
            </Link>
          ))}
        </div>
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
       width. The 2026-11-20 redesign made each one the landing's own button — a navy frame that
       fills navy on hover — instead of a grey chip that washed orange. */
    <div className="flex flex-wrap gap-2">
      {actions.map((action, i) => (
        <Link
          key={i}
          href={action.href}
          className={`flex min-h-[48px] min-w-fit grow basis-[calc(50%-0.25rem)] items-center justify-center gap-2 border border-[#08111f] bg-white px-3 py-3 text-phx-xs font-bold uppercase tracking-[0.08em] text-[#08111f] transition hover:bg-[#08111f] hover:text-white motion-reduce:transition-none sm:inline-flex sm:min-h-10 sm:grow-0 sm:basis-auto sm:px-4 sm:py-2 ${adminControlDepthClassName} ${LANDING_FOCUS}`}
        >
          <action.icon className="h-4 w-4 shrink-0 sm:h-3.5 sm:w-3.5" />
          <span className="text-center leading-tight whitespace-normal sm:whitespace-nowrap">{action.label}</span>
        </Link>
      ))}
    </div>
  );
}

/* ── SectionHead (the navy header bar of the richer dashboards) ── */

/**
 * A flat night-navy header bar with the house tick — the ground of the portal's top bar (owner,
 * 2026-11-20: "A: night navy"). It used to carry a gradient hairline, a 4% grid texture and a 32px
 * navy glow; the redesign took all three off, because each is an ornament that reads as made by a
 * machine rather than by a designer. The early-birds and rep-ranks pages put light-on-dark content
 * in its right slot, which is why it stays navy rather than turning white like a landing panel.
 */
export function SectionHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="bg-[#08111f]">
      {/* flex-wrap, and the right slot wraps inside itself: it now carries the closing month
          beside whatever it showed before, and at 375px title + stamp + count exceeds the bar.
          Nothing here clips any more (the old frame was overflow-hidden, which hid a nowrap chip
          from a scrollWidth check — AGENTS.md §4's second blind spot), and the ellipsis ban rules
          out cutting it, so wrapping is the answer. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2.5 sm:px-4">
        <h2 className="flex min-w-0 items-center gap-2 break-words text-phx-xs font-black uppercase tracking-[0.14em] text-white/80">
          <LandingTick />
          <span className="min-w-0">{title}</span>
        </h2>
        {right ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-white/50">{right}</div> : null}
      </div>
    </div>
  );
}

/* ── SectionMeta (the small-caps chips on the right of a header) ── */

/**
 * The chips on the right of a header — a closing month, a head count, a sort order.
 *
 * It exists because every performance header now has to name its WINDOW as well as whatever it
 * showed before. The sales figures on these dashboards come from PUBLISHED monthly closings, and a
 * closing only publishes once its month has ended, so in early September the newest numbers are
 * July's — while the cards said "achieved this period", which reads as "right now" and never was.
 * Owner, 2026-09-03: "you must show this achievement is in which window?"
 *
 * Null and blank items are dropped rather than rendered as an empty chip, so a caller can pass a
 * not-yet-published month straight through. It wraps rather than truncating (ellipsis ban).
 *
 * It takes its COLOUR from the header it sits in (2026-11-20): white at half strength on a navy
 * SectionHead, slate on a white LandingPanel — one component, legible on both grounds.
 */
export function SectionMeta({ items }: { items: readonly (string | null | undefined)[] }) {
  const shown = items.filter((item): item is string => Boolean(item && item.trim()));
  if (shown.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-phx-xs font-bold uppercase tracking-[0.08em]">
      {shown.map((item, index) => (
        <span key={item} className="flex items-center gap-2">
          {index > 0 ? (
            <span aria-hidden className="opacity-50">
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </span>
  );
}

/* ── KeycardGrid (KPI cards, 2-up on a phone, 4-up on a wide screen) ──── */

export type Keycard = {
  icon: React.ElementType;
  label: string;
  value: string;
  sub: string;
  accent: string;
  valueClass: string;
};

/**
 * The callers' card colours are written for a white tile (`achievementTone`, `figureInk` and their
 * kin, pinned per money tile by tests/portal-unpublished-keycards.test.ts). On the night-navy board
 * the same classes are swapped here, one for one, for the board's own — so a caller's data and its
 * tone rules stay exactly as they are, and slate-900 is never drawn on #08111f. Every value is a
 * literal, so Tailwind sees each one it has to generate.
 */
const KEYCARD_ON_NAVY: Record<string, string> = {
  "text-emerald-600": "text-emerald-300",
  "text-emerald-700": "text-emerald-300",
  "text-amber-600": "text-amber-300",
  "text-amber-700": "text-amber-300",
  "text-orange-500": "text-orange-300",
  "text-orange-600": "text-orange-300",
  "text-orange-700": "text-orange-300",
  "text-rose-600": "text-rose-300",
  "text-rose-700": "text-rose-300",
  "text-slate-950": "text-white",
  "text-slate-900": "text-white",
  "text-slate-800": "text-white",
  "text-slate-700": "text-white",
  "text-slate-600": "text-white/60",
  "text-slate-500": "text-white/45",
  "text-slate-400": "text-white/45",
  "text-[#08111f]": "text-white",
  "bg-slate-950": "bg-white/15",
  "bg-slate-900": "bg-white/15",
  "bg-slate-800": "bg-white/15",
};

function keycardOnNavy(classes: string): string {
  return classes
    .split(/\s+/)
    .map((c) => KEYCARD_ON_NAVY[c] ?? c)
    .join(" ");
}

export function KeycardGrid({ cards, onNavy = false }: { cards: Keycard[]; onNavy?: boolean }) {
  // A wrapping row, not a fixed grid: with an odd count (three, on the Product Managers' landing) a
  // two-column grid left a solid grey cell — the "empty square" the owner banned — and `grow` makes
  // the last card of an odd row take the rest of it instead.
  //
  // `onNavy` draws the cards as the tiles of a LandingNavyBoard — a manager's headline board, the
  // same night navy as the rep's month tiles — with the callers' colours swapped above.
  //
  // The cards count off the GRID's own width, never the window's: one to a row under 17rem (a small
  // Android phone on Large text leaves the board about 238px, where two cards split "ACHIEVEMENT"
  // mid-word and "EGP 1.42M" over two lines — measured 2026-11-20), two from 17rem, four from 48rem.
  return (
    <div className="@container">
      <div className={onNavy ? "flex flex-wrap gap-2" : "flex flex-wrap gap-px bg-slate-200"}>
        {cards.map((card) => (
          <div
            key={card.label}
            className={`relative min-w-0 grow basis-full px-3 py-3 sm:px-4 sm:py-4 ${
              onNavy
                ? "border border-white/[0.08] bg-[#0d1828] @[17rem]:basis-[calc(50%-0.25rem)] @3xl:basis-[calc(25%-0.375rem)]"
                : "bg-white @[17rem]:basis-[calc(50%-1px)] @3xl:basis-[calc(25%-1px)]"
            }`}
          >
            <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-0.5 ${onNavy ? keycardOnNavy(card.accent) : card.accent}`} />
            <div className="flex items-start gap-1.5">
              <card.icon className={`mt-px h-3.5 w-3.5 shrink-0 ${onNavy ? "text-white/40" : "text-slate-400"}`} />
              <p className={`min-w-0 break-words text-phx-xs font-bold uppercase tracking-[0.1em] ${onNavy ? "text-white/65" : "text-slate-500"}`}>
                {card.label}
              </p>
            </div>
            {/* Values are computed (egpCompact, percentages) and can run long — wrap instead of the
                fixed-width nowrap this used to have, which let the grid's minmax(0,1fr) columns
                clip or bleed digits into the next card instead of showing the full number. */}
            <p
              className={`mt-3 break-words text-[24px] font-bold leading-none tracking-[-0.02em] tabular-nums ${onNavy ? keycardOnNavy(card.valueClass) : card.valueClass}`}
            >
              {card.value}
            </p>
            {/* Owner rule: never truncate with an ellipsis. Subs now name the closing month
                ("Jul 2026 closing"), which is longer than the fixed phrases they replaced. */}
            <p className={`mt-1.5 break-words text-phx-xs font-medium leading-snug ${onNavy ? "text-white/45" : "text-slate-500"}`}>{card.sub}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── DashboardsGrid (the link list under a "Dashboards" panel) ── */

export type DashboardLink = { href: string; icon: React.ElementType; label: string };

export function DashboardsGrid({ items, title = "Dashboards" }: { items: readonly DashboardLink[]; title?: string }) {
  // Hairline-ruled cells, two to a row on a phone and four from `sm`; the last cell of an odd row
  // grows into the rest of it, so no grey hole is ever left. Labels wrap inside their cell —
  // "Double-Visit Analytics" at 375px — never clip.
  return (
    <LandingPanel title={title}>
      <div className="flex flex-wrap gap-px bg-slate-200">
        {items.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className={`group flex min-h-[52px] min-w-0 grow basis-[calc(50%-1px)] items-center gap-2.5 bg-white px-3 py-3 sm:basis-[calc(25%-1px)] sm:px-4 ${LANDING_ROW_LINK}`}
          >
            <d.icon className="h-4 w-4 shrink-0 text-slate-400 transition-colors group-hover:text-[#08111f] motion-reduce:transition-none" />
            <span className="min-w-0 flex-1 break-words text-phx-xs font-bold uppercase leading-snug tracking-[0.08em] text-[#08111f]">
              {d.label}
            </span>
          </Link>
        ))}
      </div>
    </LandingPanel>
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

const BAND_TEXT: Record<AchievementBand, string> = {
  met: "text-emerald-700",
  near: "text-amber-700",
  behind: "text-orange-700",
  far: "text-rose-700",
};
const BAND_BAR: Record<AchievementBand, string> = {
  met: "bg-emerald-500",
  near: "bg-amber-400",
  behind: "bg-orange-500",
  far: "bg-rose-500",
};
function pctTextClass(pct: number): string {
  return BAND_TEXT[achievementBand(pct)];
}
function pctBarClass(pct: number): string {
  return BAND_BAR[achievementBand(pct)];
}
/** The house medal palette — gold, silver, bronze, then a plain framed number. Exported so the Early
 * Birds race panel reuses the same chips as the sales leaderboard instead of a second, drifting copy.
 * Fourth place down is a hairline frame since 2026-11-20: a column of filled navy squares under the
 * three medals read heavier than the medals themselves. */
export function rankChipClass(index: number): string {
  return index === 0
    ? "bg-amber-400 text-slate-900"
    : index === 1
      ? "bg-slate-300 text-slate-900"
      : index === 2
        ? "bg-orange-300 text-slate-900"
        : "border border-slate-300 text-slate-600";
}

export function RankingPanel({
  title,
  subtitle,
  icon: Icon,
  rows,
  showManager,
  windowLabel,
  footer,
  unranked = [],
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  rows: RankRow[];
  showManager?: boolean;
  /**
   * People on the team with no row in the window yet — a manager who joined after it (owner, 2026-11-09).
   * Listed under the ranked rows with no rank and no percentage; `note` says when they joined.
   */
  unranked?: ReadonlyArray<{ hrId: string; name: string; note: string }>;
  /** Which published closing month(s) these achievement percentages cover, e.g. "Jul 2026". */
  windowLabel?: string | null;
  /** Rendered inside the card beneath the last row — this is where DepartedFromBoardNote goes. */
  footer?: React.ReactNode;
}) {
  const ranked = rows.slice().sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales);
  return (
    <LandingPanel right={<SectionMeta items={[windowLabel, subtitle]} />} title={title}>
      {ranked.length === 0 && unranked.length === 0 ? (
        <LandingEmpty>{rankingBoardEmptyText(windowLabel)}</LandingEmpty>
      ) : (
        <div>
          {ranked.map((row, i) => {
            // Never rounded UP across a line: 89.6% reads 89%, the same as Districts Needing Attention.
            const pct = wholePercent(row.achievementPercent);
            // No target means the percent has no meaning — showing 0% would tell someone who
            // sold well that they achieved nothing. Targets start 2026-07, so this is ordinary.
            const hasTarget = row.totalTarget > 0;
            return (
              <div
                key={row.hrId || `${row.name}-${i}`}
                className="flex items-center gap-3 border-b border-slate-200 px-3 py-2.5 last:border-b-0 sm:px-4"
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center text-phx-xs font-black tabular-nums ${rankChipClass(i)}`}>
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon className="hidden h-3.5 w-3.5 shrink-0 text-slate-300 sm:block" />
                  <div className="min-w-0">
                    {/* Wraps, never truncates — owner rule. Egyptian full names run four parts
                        and the old ellipsis cut most of them off on a phone. */}
                    <p className="break-words text-phx-md font-bold leading-snug text-[#08111f]">{row.name}</p>
                    {showManager && row.managerName ? (
                      <p className="break-words text-phx-xs font-bold uppercase leading-snug tracking-[0.08em] text-slate-400">
                        {row.managerName}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="w-20 shrink-0">
                  {hasTarget ? (
                    <>
                      <p className={`text-right text-phx-base font-bold tabular-nums ${pctTextClass(pct)}`}>{pct}%</p>
                      <div className="mt-1.5">
                        <LandingBar fill={pctBarClass(pct)} pct={pct} />
                      </div>
                    </>
                  ) : (
                    <p className="break-words text-right text-phx-xs font-bold uppercase leading-snug tracking-[0.08em] text-slate-400">
                      No target
                    </p>
                  )}
                </div>
              </div>
            );
          })}
          {unranked.map((person) => (
            <div
              key={`unranked-${person.hrId}`}
              className="flex items-center gap-3 border-b border-slate-200 px-3 py-2.5 last:border-b-0 sm:px-4"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center border border-dashed border-slate-300 text-phx-xs font-black text-slate-400">
                –
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Icon className="hidden h-3.5 w-3.5 shrink-0 text-slate-300 sm:block" />
                <div className="min-w-0">
                  <p className="break-words text-phx-md font-bold leading-snug text-[#08111f]">{person.name}</p>
                  {person.note ? (
                    <p className="break-words text-phx-xs font-bold uppercase leading-snug tracking-[0.08em] text-slate-400">
                      {person.note}
                    </p>
                  ) : null}
                </div>
              </div>
              <p className="w-24 shrink-0 break-words text-right text-phx-xs font-bold uppercase leading-snug tracking-[0.08em] text-slate-400">
                {NO_PUBLISHED_MONTH}
              </p>
            </div>
          ))}
        </div>
      )}
      {footer}
    </LandingPanel>
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
    <p className="border-t border-dashed border-slate-200 px-3 py-2.5 text-phx-xs leading-relaxed text-slate-500 sm:px-4">
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
    <div className={`grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 sm:grid-cols-4 ${adminSoftDepthClassName}`}>
      {items.map((a) => (
        <Link
          key={a.href}
          href={a.href}
          className={`group flex min-h-[52px] flex-col items-center justify-center gap-1.5 bg-white px-2 py-3 text-center sm:flex-row sm:gap-2 ${LANDING_ROW_LINK}`}
        >
          <a.icon className="h-4 w-4 shrink-0 text-[#08111f]" />
          <span className="min-w-0 break-words text-phx-xs font-bold uppercase leading-snug tracking-[0.08em] text-[#08111f]">
            {a.label}
          </span>
        </Link>
      ))}
    </div>
  );
}

/* ── egpCompact (compact currency, e.g. "128.45 M EGP") ──────────────── */

export function egpCompact(value: number): string {
  return compactEgp(value);
}

/* ── The night-navy figure tile shared by the Product Managers' and the standard landings ── */

/**
 * One headline figure on a landing's night-navy board: the rep's month tile (`RepTile`) carrying a
 * single big number, optionally a whole-tile link. It sits in a wrapping row — two to a row on a
 * phone, all in one row once the board is wide — and the last tile of an odd row takes the rest of
 * it, so no grey hole is ever left.
 */
function BoardFigureTile({
  label,
  hint,
  href,
  children,
}: {
  label: string;
  hint?: string | null;
  href?: string;
  children: React.ReactNode;
}) {
  const tile = (
    <RepTile hint={hint} label={label}>
      {children}
    </RepTile>
  );
  return (
    <div className="flex min-w-0 grow basis-[calc(50%-0.25rem)] @3xl:basis-0 [&>*]:flex-1">
      {href ? (
        <Link className={`flex min-w-0 [&>div]:flex-1 [&>div]:transition-colors hover:[&>div]:border-white/30 ${LANDING_FOCUS}`} href={href}>
          {tile}
        </Link>
      ) : (
        tile
      )}
    </div>
  );
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
  } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount + plansCount;
  // Both legs must have loaded for the sum to mean anything — a failed plans lookup defaults to 0
  // and would otherwise silently understate totalPending rather than reading as unknown.
  const pendingAvailable = pendingCountsAvailable && plansCountAvailable;

  return (
    <div className="mx-auto w-full space-y-2" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />

      {/* 🔒 THE HEADLINE BOARD — night navy, the landing's one board (2026-11-20 redesign). Three
          figures: what he has in flight with marketing, what is pending, his leave entitlement.
          NO PAYSLIP TILE: payslip data (amount OR month) must never render on any overview/landing
          surface for any role — owner rule. It lives only on /employee-portals/payslips. */}
      <LandingNavyBoard label="My Workspace">
        <div className="@container">
          <div className="flex flex-wrap gap-2">
            <BoardFigureTile hint="In flight" href="/employee-portals/marketing-requests" label="Marketing requests">
              <LandingFigure onNavy>{pmMarketing ? String(pmMarketing.myPendingRequests) : "—"}</LandingFigure>
            </BoardFigureTile>
            <BoardFigureTile hint="Awaiting decision" label="Pending requests">
              <LandingFigure onNavy tone={pendingAvailable && totalPending > 0 ? "text-orange-300" : undefined}>
                {pendingAvailable ? String(totalPending) : "—"}
              </LandingFigure>
            </BoardFigureTile>
            <BoardFigureTile hint="Annual entitlement" href="/employee-portals/vacation-request" label="Leave balance">
              <LandingFigure onNavy unit={leaveEntitlementDays != null ? "days" : undefined}>
                {leaveEntitlementDays != null ? String(leaveEntitlementDays) : "—"}
              </LandingFigure>
            </BoardFigureTile>
          </div>
        </div>
      </LandingNavyBoard>

      {!pendingAvailable ? (
        <PendingCountsUnavailable />
      ) : totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : null}

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

/**
 * The same scale, drawn on the rep's night-navy month board (owner, 2026-11-20: the landing
 * redesign after his "A: night navy" top bar). The figures themselves stay white; the colour rides
 * on the bar and the small words only, so the board stays flat and calm.
 */
function repNightTone(pct: number): { fill: string; text: string } {
  if (pct >= 100) return { fill: "bg-emerald-400", text: "text-emerald-300" };
  if (pct >= 90) return { fill: "bg-amber-400", text: "text-amber-300" };
  return { fill: "bg-orange-500", text: "text-orange-300" };
}

/** The night-navy ground of the month board, and the one step lighter that its tiles stand on. */
const REP_BOARD_GROUND = "bg-[#08111f]";
const REP_BOARD_TILE = "bg-[#0d1828]";

/** One of the four month tiles on the night-navy board: label, period, figure, one quiet line. */
function RepTile({
  label,
  meta,
  children,
  hint,
}: {
  label: string;
  meta?: string | null;
  children: React.ReactNode;
  hint?: string | null;
}) {
  return (
    <div className={`flex min-w-0 flex-col border border-white/[0.08] ${REP_BOARD_TILE}`}>
      {/* A container, so what fits in the tile is decided by the TILE's width, not the window's. */}
      <div className="@container flex flex-1 flex-col p-3">
        {/* The period STACKS under the label in a narrow tile and sits beside it from 13rem up. Side by
            side in a phone's two-column grid it needed ~190px in a 140px tile: on an iPhone (Helvetica
            Neue) and Android (Roboto) — both wider than the Aptos this was sized against — "OCT 2026"
            was cut at the tile edge and "CALL RATE" broke onto two lines while its neighbours did not. */}
        <div className="flex flex-col gap-0.5 @[13rem]:flex-row @[13rem]:items-baseline @[13rem]:gap-2">
          <span className="text-phx-sm font-bold uppercase tracking-[0.1em] text-white/65">{label}</span>
          {meta && (
            <span className="whitespace-nowrap text-phx-xs font-bold uppercase tracking-[0.08em] text-white/35 @[13rem]:ml-auto">{meta}</span>
          )}
        </div>
        <div className="mt-3">{children}</div>
        {hint && <p className="mt-auto pt-3 text-phx-xs leading-snug text-white/45">{hint}</p>}
      </div>
    </div>
  );
}

/** Big percentage plus its attainment bar. The 100% line is drawn so a bar reads against target. */
function RepPercent({ pct, note }: { pct: number; note?: React.ReactNode }) {
  const rounded = Math.round(pct);
  const tone = repNightTone(rounded);
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-1">
        <span className="text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums text-white">{rounded}</span>
        <span className="text-phx-sm font-bold text-white/45">%</span>
        {note && <span className="ml-auto">{note}</span>}
      </div>
      <div className="relative mt-3 h-1 w-full bg-white/10">
        <div className={`h-full ${tone.fill}`} style={{ width: `${Math.max(0, Math.min(100, rounded))}%` }} />
        <div aria-hidden="true" className="absolute -bottom-1 -top-1 right-0 w-px bg-white/70" />
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
    { label: "Exact", value: exact, tone: "text-emerald-300" },
    { label: "Above", value: above, tone: "text-rose-300" },
    { label: "Below", value: below, tone: "text-amber-300" },
  ];
  return (
    <dl className="mt-3 space-y-1 border-t border-white/10 pt-2.5">
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
  const tone = target != null ? repNightTone(attainment) : null;
  // One ROW per rate, never three side-by-side columns: on a phone the tile is half the screen, and
  // three columns left each figure 49px — too narrow for a 10.2 at any size bigger than its siblings.
  // A row gives the figure the tile's whole width, with the code, the target and (where there is
  // room) the full name on the same baseline.
  return (
    <div className="relative min-w-0 pl-2.5">
      <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${tone?.fill ?? "bg-white/20"}`} />
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="w-7 shrink-0 text-phx-sm font-black tracking-[0.06em] text-white/60">{code}</span>
        <span className="text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums text-white">
          {rate.toFixed(1)}
        </span>
        <span className="text-phx-sm font-semibold tabular-nums text-white/45">
          {target != null ? `of ${target}` : "no target"}
        </span>
        {/* Only where the tile itself has room for it (a container query on RepTile's body): the
            window's width said nothing about the tile once the sidebar opened at lg. */}
        <span className="ml-auto hidden text-phx-xs font-bold uppercase tracking-[0.08em] text-white/35 @[13rem]:inline">
          {label}
        </span>
      </p>
      {tone ? (
        <div className="relative mt-2 h-1 w-full bg-white/10">
          <div className={`h-full ${tone.fill}`} style={{ width: `${Math.max(0, Math.min(100, attainment))}%` }} />
          <div aria-hidden="true" className="absolute -bottom-1 -top-1 right-0 w-px bg-white/70" />
        </div>
      ) : (
        // No standard to reach, so no bar to fill — a dashed rule keeps the three rows aligned
        // without drawing an empty bar that reads as 0%.
        <div aria-hidden="true" className="mt-2 h-1 w-full border-t border-dashed border-white/20" />
      )}
    </div>
  );
}

/**
 * Every white panel on the rep's landing: a plain white header with the house's short orange tick
 * before the title — the tick of his honour-strip footer and the line on top of the night-navy bar
 * (owner, 2026-11-20 redesign). `RepTodayPlanPanel` and My map's rep frame wear the same header.
 */
function RepPanel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <header className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
        <h2 className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-[#08111f]">
          <span aria-hidden="true" className="h-0.5 w-3 shrink-0 bg-[#F05A1A]" />
          {title}
        </h2>
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
    <div className="flex items-center gap-3 border-b border-slate-200 px-3 py-3 last:border-b-0">
      <span aria-hidden="true" className={`w-1 self-stretch ${rail}`} />
      <span className="min-w-[28px] text-[24px] font-bold leading-none tracking-[-0.02em] tabular-nums text-[#08111f]">{count}</span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-phx-md font-bold leading-snug text-[#08111f]">{headline}</span>
        <span className="mt-0.5 block break-words text-phx-xs leading-snug tabular-nums text-slate-500">{detail}</span>
      </span>
      {/* 40px tall on a phone — it is the one thing on this row a thumb has to hit. */}
      <Link
        className="inline-flex min-h-10 shrink-0 items-center border border-[#08111f] px-3 text-phx-xs font-bold uppercase tracking-[0.08em] text-[#08111f] transition hover:bg-[#08111f] hover:text-white sm:min-h-8"
        href={href}
      >
        {cta}
      </Link>
    </div>
  );
}

function RepFact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  // One fact per ROW — label on the left, value on the right — so a long label ("Until contract
  // renewal") wraps inside its own row and never leaves its neighbour a row taller than it needs
  // (owner, 2026-11-20 redesign: the old two-up grid ran uneven heights on a phone). Two rows to a
  // line from `sm`; `grow` makes the last fact of an odd count take the whole line, so a fixed grid's
  // solid grey cell — the "empty square" the owner banned — can never appear.
  return (
    <div className="flex min-w-0 grow basis-full items-baseline justify-between gap-3 bg-white px-3 py-2.5 sm:basis-[calc(50%-1px)]">
      <dt className="min-w-0 text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-500">{label}</dt>
      <dd className={`max-w-[60%] break-words text-right text-phx-md font-bold tabular-nums ${tone ?? "text-[#08111f]"}`}>{value}</dd>
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
        <div aria-hidden="true" className="employee-portal-skeleton h-[28px] w-16 opacity-20" />
        <div aria-hidden="true" className="employee-portal-skeleton mt-3 h-1 w-full opacity-20" />
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

function MedicalRepCommandCenter({
  access,
  repTodayPlan,
  snapshot,
}: {
  access?: AccessContext;
  repTodayPlan: Promise<RepTodayPlan | null>;
  snapshot: PortalHomeSnapshot;
}) {
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
          itself is conditional and the panels below run full width.
          🔴 THE CONDITION IS IN THE CSS SINCE 2026-11-01 ("fix the portal home slow opens"): his day now
          fills under its own Suspense, so the server draws this row before it knows whether there is a
          day. The column carries `data-rep-day` while it loads and when it holds a day; a day that turns
          out to be null removes it, and the split and the tiles below go with it. */}
      <div className="@container">
        <div className="group/rep-day grid gap-2 @3xl:has-[>[data-rep-day]]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-2">
            {/* 🔒 THE MONTH BOARD — night navy, the ground of the top bar he chose (owner, 2026-11-20,
                "A: night navy", then the from-scratch redesign of this landing). One flat orange line
                on top, the month box as its header row, the four tiles a step lighter beneath it. Flat
                colour only: no gradient, no glow; the figures are white and the colour is on the bars. */}
            <section aria-label="KPI month" className={`border border-[#08111f] ${REP_BOARD_GROUND} ${adminSoftDepthClassName}`}>
              <div aria-hidden="true" className="h-0.5 w-full bg-[#F05A1A]" />
              <div className="space-y-2 p-2 pt-2.5">
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
                  {/* Two tiles to a row at every phone width (his 2026-09-30 rule above). On a small
                      Android phone on Large text (~280px) each tile is ~128px, so RepTile stacks its
                      period under its label rather than cutting either. */}
                  <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4 group-has-[>[data-rep-day]]/rep-day:grid-cols-2">
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
              </div>
            </section>

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

            {/* My map — his own territory's validated customers as pins, AM, PM and pharmacies in their own
                colours (owner, 2026-10-27). It loads itself under its own Suspense, so the page never waits
                for it, and it opens the full map with directions to any pin. */}
            {access ? (
              <Suspense fallback={<RepPanelLoading title="My map" />}>
                <MyMapSnapshotCard access={access} frame="rep" />
              </Suspense>
            ) : null}

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
          <Suspense
            fallback={
              <div className="min-w-0 space-y-2" data-rep-day="">
                <RepPanelLoading title="Your day" />
              </div>
            }
          >
            <RepDayColumn plan={repTodayPlan} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

// --- The Medical Rep's streamed cards ---
//
// Each awaits only its own read, and each read resolves (never rejects) to the null the awaited
// snapshot would have carried, so a failed read draws the same honest empty state it always did.

/**
 * His day, the right-hand column. It no longer holds the rep's whole landing back: the read is the
 * slowest on the page (2026-11-01, "fix the portal home slow opens"), so it fills in on its own.
 * `loadRepTodayPlan` never rejects, and no day draws nothing, so the column and its split go with it.
 */
async function RepDayColumn({ plan }: { plan: Promise<RepTodayPlan | null> }) {
  const day = await plan;
  if (!day) return null;
  return (
    <div className="min-w-0 space-y-2" data-rep-day="">
      <RepTodayPlanPanel plan={day} />
    </div>
  );
}

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
    >
      {achPct !== null ? (
        <RepPercent
          note={
            achDelta !== null ? (
              <span
                className={`text-phx-xs font-bold tabular-nums ${achDelta >= 0 ? "text-emerald-300" : "text-rose-300"}`}
              >
                {achDelta >= 0 ? `+${achDelta}` : achDelta} pts
              </span>
            ) : null
          }
          pct={achPct}
        />
      ) : (
        <p className="text-phx-md font-semibold text-white/40">No closing published yet</p>
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
      >
        {kpis?.hasMeasurablePlan ? (
          <RepPercent pct={kpis.coveragePct} />
        ) : (
          <p className="text-phx-md font-semibold text-white/40">No plan to score</p>
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
      >
        {/* Ruling A1 (owner, 2026-09-21): the proved rates are blank, not zero, when no GPS
            check-in reached the CRM at all — so the tile says that rather than drawing three 0.00s. */}
        {kpis?.noGpsFeed ? (
          <p className="text-phx-md font-semibold text-white/40">No GPS feed</p>
        ) : kpis?.hasCallRate ? (
          <div className="space-y-3">
            <RepCallHalf code="AM" label="Morning" rate={kpis.amRate ?? 0} target={kpis.amTarget} />
            <RepCallHalf code="PM" label="Afternoon" rate={kpis.pmRate ?? 0} target={kpis.pmTarget} />
            <RepCallHalf code="PH" label="Pharmacy" rate={kpis.pharmacyRate ?? 0} target={kpis.pharmacyTarget} />
          </div>
        ) : (
          <p className="text-phx-md font-semibold text-white/40">Nothing logged yet</p>
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
          <p className="text-phx-md font-semibold text-white/40">No plan to score</p>
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
        <span className="text-right text-phx-sm font-semibold uppercase tracking-[0.08em] text-slate-400">
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
          stopped short of the dashed 100% line drawn on the same scale.
          The "100%" mark sits in a gutter of its own on the LEFT (owner, 2026-11-20 redesign):
          drawn at the right edge it landed on the newest bar's own label — a 98% October read
          "98%100%". The bars are slim columns now, not slabs, and the newest month is named in navy. */}
      <div className="px-3 pb-3 pt-6">
        <div className="flex gap-2">
          <div aria-hidden="true" className="relative w-8 shrink-0">
            <span
              className="absolute right-0 translate-y-1/2 text-phx-xs font-bold tabular-nums text-slate-400"
              style={{ bottom: `${(100 / trendMax) * 100}%` }}
            >
              100%
            </span>
          </div>
          <div className="relative flex h-[96px] min-w-0 flex-1 items-end gap-3">
            {/* The 100% line, positioned on the same scale as the bars. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-slate-300"
              style={{ bottom: `${(100 / trendMax) * 100}%` }}
            />
            {closed.map((t) => {
              const pct = Math.max(0, Math.round(t.achievementPercent));
              const isLatest =
                latestClosed != null && t.year === latestClosed.year && t.month === latestClosed.month;
              return (
                <div className="flex h-full min-w-0 flex-1 flex-col justify-end" key={`bar-${t.year}-${t.month}`}>
                  <div
                    className={`relative mx-auto w-full max-w-[36px] ${repTone(pct).fill}`}
                    style={{ height: `${Math.max(2, Math.min(100, (pct / trendMax) * 100))}%` }}
                  >
                    <p
                      className={`absolute left-1/2 bottom-full mb-1 -translate-x-1/2 whitespace-nowrap text-phx-sm font-bold tabular-nums ${isLatest ? "text-[#08111f]" : "text-slate-500"}`}
                    >
                      {pct}%
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="ml-10 mt-2 flex gap-3 border-t border-slate-200 pt-2">
          {closed.map((t) => {
            const isLatest =
              latestClosed != null && t.year === latestClosed.year && t.month === latestClosed.month;
            return (
              <div className="min-w-0 flex-1 text-center" key={`lab-${t.year}-${t.month}`}>
                <p className={`text-phx-sm tracking-[0.06em] ${isLatest ? "font-black text-[#08111f]" : "font-bold text-slate-500"}`}>
                  {monthShort(t.month)}
                </p>
                <p className="break-words text-phx-xs tabular-nums text-slate-400">{egpCompact(t.salesValue)}</p>
              </div>
            );
          })}
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
            className={`border px-1.5 py-px text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums ${openCount > 0 ? "border-orange-500/50 text-orange-700" : "border-emerald-600/40 text-emerald-700"}`}
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

  // Built for the retired Talent Acquisition seat, HR/office staff who had no approval
  // authority (Approvals Hub was hidden from her sidebar entirely, see navigation.ts's
  // showActionsTab) and no outstation expenses of her own, so both quick-access surfaces were
  // dropped here too, matching the sidebar. See navigation.ts: no portal-mode role is HR/office
  // staff since that seat was retired on 2026-08-28 — both successor bundles (HR Advisory, HR
  // Operations) are admin-shell roles — so `isPortalHrOfficeStaff` below is always false and
  // every StandardCommandCenter role now takes the unaffected path.
  const isPortalHrOfficeStaff = new Set<string>([]).has(role);

  return (
    <div className="mx-auto w-full space-y-2" dir="auto">
      <PortalIdentityBand shell={shell} planAdherence={snapshot.planAdherence} myInterviews={snapshot.myInterviews} />
      <PortalContextBar role={role} context={shell.employee.department || ""} />

      {/* 🔒 THE HEADLINE BOARD (2026-11-20 redesign) — night navy, this landing's one board. It took
          the place of two things that said the same numbers twice: the three-cell glance strip and
          a separate "This Month | Achievement" block with a 48px figure under a slate bar. Each tile
          opens the page that holds its number.
          NO PAYSLIP TILE: payslip data (amount OR month) must never render on any overview/landing
          surface for any role — owner rule. It lives only on /employee-portals/payslips. */}
      <LandingNavyBoard label="At a glance">
        <div className="@container">
          <div className="flex flex-wrap gap-2">
            {ach && pct !== null ? (
              <BoardFigureTile
                hint={`${egp(ach.salesValue)} of ${egp(ach.targetValue)}`}
                href="/employee-portals/source-of-sales"
                label="Achievement"
              >
                <RepPercent pct={pct} />
              </BoardFigureTile>
            ) : null}
            {isPortalHrOfficeStaff ? null : (
              <BoardFigureTile
                hint={pendingAvailable ? (totalPending === 1 ? "Pending request" : "Pending requests") : "Could not be read"}
                href="/employee-portals/approvals-hub"
                label="Pending"
              >
                <LandingFigure onNavy tone={pendingAvailable && totalPending > 0 ? "text-orange-300" : undefined}>
                  {pendingAvailable ? String(totalPending) : "—"}
                </LandingFigure>
              </BoardFigureTile>
            )}
            <BoardFigureTile hint="Annual leave left" href="/employee-portals/vacation-request" label="Leave">
              <LandingFigure onNavy unit={leaveDaysRemaining != null ? "days" : undefined}>
                {leaveDaysRemaining != null ? String(leaveDaysRemaining) : "—"}
              </LandingFigure>
            </BoardFigureTile>
          </div>
        </div>
      </LandingNavyBoard>

      <QuickActions
        actions={[
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
          ...(isPortalHrOfficeStaff ? [] : [{ href: "/employee-portals/plans", icon: ClipboardCheck, label: "My Plans" }]),
          ...(isPortalHrOfficeStaff ? [] : [{ href: "/employee-portals/expenses", icon: ReceiptText, label: "My Expenses" }]),
          { href: "/employee-portals/report-it", icon: Activity, label: "Report It" },
        ]}
      />

      {/* ONE place for what is pending. This landing used to draw the pending panels TWICE — once
          under the quick actions and again under the workspace — so every waiting request was listed
          two times on the same screen. Now: the panels when something waits, the all-clear line
          when nothing does, and a plain "could not load" when the count itself failed. */}
      {!isPortalHrOfficeStaff && !pendingAvailable ? (
        <PendingCountsUnavailable />
      ) : !isPortalHrOfficeStaff && totalPending > 0 ? (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      ) : (
        <div className={`flex items-center gap-3 border border-slate-200 bg-white px-3 py-3 sm:px-4 ${adminSoftDepthClassName}`} role="status">
          <span aria-hidden="true" className="w-1 self-stretch bg-emerald-500" />
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="min-w-0 break-words text-phx-md font-semibold text-[#08111f]">All clear — nothing needs your attention right now.</span>
        </div>
      )}

      <LandingPanel title="My Workspace">
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
      </LandingPanel>
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
  repTodayPlan = Promise.resolve(null),
  snapshot,
}: {
  access?: AccessContext;
  /** The rep's planned day — what replaced the Phoenix CRM Today module (owner, 2026-09-30). */
  repTodayPlan?: Promise<RepTodayPlan | null>;
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
  if (snapshot.role.toLowerCase() === "medical rep") return <MedicalRepCommandCenter access={access} repTodayPlan={repTodayPlan} snapshot={snapshot} />;
  return <StandardCommandCenter snapshot={snapshot} />;
}
