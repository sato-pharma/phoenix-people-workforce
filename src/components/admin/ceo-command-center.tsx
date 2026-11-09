import Link from "next/link";
import { type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Fingerprint,
  HeartPulse,
  MapPinned,
  Megaphone,
  ShieldCheck,
  Target,
  Users,
  Wallet,
} from "lucide-react";

import { AdminHeroFrame } from "@/components/admin/admin-design-system";
import { CeoHeroIdentity } from "@/components/admin/ceo-hero-identity";
import { CeoTopMoversTable } from "@/components/admin/ceo-top-movers-table";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import type { AccessContext } from "@/lib/auth/permissions";
import type {
  CeoAttentionTone,
  CeoCommandCenterData,
} from "@/lib/ceo/command-center";
import { sosPeriodDisplayLabel } from "@/lib/ceo/command-center";
import type { UncomputedRate } from "@/lib/platform/metrics";
import { SALES_ACHIEVEMENT_WINDOW_LABEL } from "@/lib/sales/metrics";
import { cn } from "@/lib/utils";

/**
 * The identity band's data. Back, and it is the ORIGINAL band, not the thin strip.
 *
 * THE HISTORY, because four instructions now sit on this one block and a session holding any
 * three of them will undo the fourth:
 *
 *   1. 2026-09-03 — the band went from here and from 131 other admin pages: "remove from all
 *      pages this dump block". `welcome`, this type and the `resolveViewerIdentityFromPage` round
 *      trips that fed it were all deleted.
 *   2. Later the same day — the identity back, but THIN: "I want it to be narrow, to have much
 *      space for the page to show data", under 96px. That is `PhoenixIdentityStrip`, and it
 *      shipped on the HR overview and on /admin.
 *   3. 2026-09-06 — the strip put on the SFE, CEO and Finance boards too. WRONG, and he said so
 *      immediately: "I WANT THE SFE AND THE FINANCE AND CEO TO HAVE THEIR PREVIOUS IDENTITY
 *      BANNER, THE NEW ONE IS ONLY FOR HRs."
 *   4. So this band is restored on those three, byte-for-byte what it was before (1), and the
 *      strip stays where he put it: the HR overview and /admin. Asked and answered the same day
 *      — /admin keeps the strip, because he named only the other three.
 *
 * `welcome: null` is what /admin passes, and it is REQUIRED rather than optional on purpose:
 * this component serves three variants, so a call site has to state its answer at compile time
 * instead of silently inheriting a band — or silently losing one, which is exactly how the SFE
 * Manager's identity went missing for three days.
 */
export type CeoWelcomeProfile = {
  fullName: string;
  roleLabel: string;
  hrId: string | null;
  imageUrl?: string | null;
  initials?: string;
};

// ── Formatters ───────────────────────────────────────────────────────────────

function egp(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(1)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return `EGP ${Math.round(safe).toLocaleString("en-US")}`;
}

function n(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "-";
}

/**
 * A rate that was never computed prints "—", the same as every other unread figure on this page.
 * `null` arrives here from `emptyPlatformMetrics()` — a failed read OR a section this viewer holds
 * no grant for — and the old signature could not express that: it took `number`, so the absence of
 * a measurement had to be spelled as one, and 100% was what it got spelled as.
 */
function pct(value: UncomputedRate) {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

// Exported so the personal workspace overview draws the SAME tile rather than a copy of its
// markup — the owner asked for that page to match the command centres, and four pages only stay
// matching if a restyle here reaches all of them. `SectionShell` is already shared this way with
// the Finance command centre.
export function MetricTile({
  icon,
  label,
  value,
  sub,
  tone = "slate",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: "slate" | "emerald" | "amber" | "rose";
}) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tone];

  return (
    <div className="min-h-32 border border-slate-200 bg-white px-4 py-4">
      <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
        <span className="text-orange-600">{icon}</span>
        {label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none ${toneClass}`}>{value}</p>
      <p className="mt-2 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p>
    </div>
  );
}

function DataUnavailableNotice({ owner, sources }: { owner: string; sources: string[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="border border-amber-200 bg-amber-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div>
          <p className="text-sm font-black text-amber-900">Some {owner} data sources are unavailable.</p>
          <p className="mt-1 text-xs font-medium text-amber-800">
            All-clear status is paused until these sources recover: {sources.join(", ")}.
          </p>
        </div>
      </div>
    </div>
  );
}


// ── SFE Manager scope ─────────────────────────────────────────────────────────
// The SFE variant reuses this CEO layout, so every partition has to be filtered down to
// what the SFE Manager can actually reach. His permission matrix (permissions.ts) grants
// sales / weekly_sales / crm_visits / coaching / probation / attendance / leave / expenses /
// double_visit_analytics / weekly_plans and NOTHING from the HR-lifecycle or finance side:
// `contracts`, `resignations`, `employees`, `organogram`, `vacancies`, `deductions` and
// `admin` are all absent. Linking him at a page that redirects to /employee-portals is worse
// than not showing the row at all, so the keys below are the only attention rows that both
// carry a number he owns and land on a page he can open.
//
//   contracts      -> /contracts    requires contracts:read     — denied
//   resignations   -> /resignations requires resignations:read  — denied
//   salaryFlags    -> /admin/m-payroll                          — payroll surface, not his
//   leaveSla       -> /admin/approvals/vacation                 — leave is HR, not sales or CRM
//
// What is left is field-force performance: probation (he submits the SFE assessment) and the
// coaching red zone (rep effectiveness). Both are sales-force questions he is measured on.
export const SFE_ATTENTION_KEYS = new Set(["probationOverdue", "probationDue", "coaching"]);

/**
 * `dataUnavailable` is built by the shared CEO aggregator, so it can name sources the SFE
 * Manager never sees. Warning him that "Resignation risk signals" are down — for a partition
 * that is not on his page — reads as a system fault he has to chase. Keep only the sources
 * that back a partition he is actually shown.
 */
export function isSfeDataSource(source: string) {
  return !/(salary|payroll|resignation|contract|expense|leave|attendance)/i.test(source);
}

// ── Attention tone mapping ────────────────────────────────────────────────────

const toneStyles: Record<CeoAttentionTone, { border: string; badge: string; text: string; label: string }> = {
  rose:  { border: "border-l-rose-500",   badge: "bg-rose-500 text-white",    text: "text-rose-700",   label: "URGENT"  },
  amber: { border: "border-l-amber-400",  badge: "bg-amber-400 text-white",   text: "text-amber-700",  label: "WARNING" },
  blue:  { border: "border-l-blue-400",   badge: "bg-blue-400 text-white",    text: "text-blue-700",   label: "INFO"    },
};

// ── Area sparkline ────────────────────────────────────────────────────────────

export function AreaSparkline({
  points,
  stroke = "#F97316",
  gradId,
}: {
  points: Array<{ label: string; value: number }>;
  stroke?: string;
  gradId: string;
}) {
  if (points.length < 2) {
    return (
      <div className="flex h-20 items-center justify-center">
        <p className="text-xs text-slate-400">Not enough history yet.</p>
      </div>
    );
  }
  const W = 300;
  const H = 72;
  const vals = points.map((p) => p.value);
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const step = W / (points.length - 1);
  const pts = points.map((p, i) => ({
    x: i * step,
    y: H - 4 - ((p.value - min) / range) * (H - 12),
  }));
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area = `${line} L ${pts[pts.length - 1]!.x.toFixed(1)} ${H} L 0 ${H} Z`;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-18 w-full" style={{ height: 72 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradId})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex justify-between text-phx-xs text-slate-400">
        <span>{first.label}</span>
        <span>{last.label}</span>
      </div>
    </div>
  );
}

// ── Two-series bar chart ──────────────────────────────────────────────────────

export function TwoSeriesBars({
  data,
  colorA,
  colorB,
}: {
  data: Array<{ label: string; a: number; b: number }>;
  colorA: string;
  colorB: string;
}) {
  if (!data.length) return <p className="text-xs text-slate-400">No data yet.</p>;
  const max = Math.max(...data.flatMap((row) => [row.a, row.b]), 1);
  return (
    <div className="flex h-20 items-end gap-1.5">
      {data.map((row, index) => (
        <div key={`${row.label}-${index}`} className="flex flex-1 flex-col items-center gap-0.5">
          <div className="flex h-16 w-full items-end justify-center gap-0.5">
            <div
              className="w-1/2"
              style={{ height: `${Math.max(3, (row.a / max) * 100)}%`, backgroundColor: colorA }}
            />
            <div
              className="w-1/2"
              style={{ height: `${Math.max(3, (row.b / max) * 100)}%`, backgroundColor: colorB }}
            />
          </div>
          <span className="break-words text-phx-xs leading-tight text-slate-400">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Section shell ─────────────────────────────────────────────────────────────

export function SectionShell({
  title,
  description,
  children,
  action,
  header,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
  /** Replaces the default left-aligned title row entirely. Used for the SFE department banner. */
  header?: ReactNode;
}) {
  return (
    <div className="border border-slate-200 bg-white">
      {header ?? (
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-4">
          <div>
            <h2 className="text-sm font-black uppercase tracking-[0.12em] text-white">{title}</h2>
            {description ? <p className="mt-0.5 text-phx-xs text-slate-400">{description}</p> : null}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * The SFE department banner — centered, and the one header on this page that is allowed to be
 * a statement rather than a label. Replaces the old "SFE Manager Overview" title and its
 * confidential-products caveat; the caveat is now enforced in the data layer and the loader
 * (canViewHeadOfficeLine), so it no longer needs saying in a heading.
 */
function SfeDepartmentBanner() {
  return (
    // Same vertical footprint as the default header (px-5 py-4) — centered and graded, but not
    // taller. A department banner that pushes the KPIs down the page costs more than it adds.
    <div className="relative overflow-hidden border-b border-slate-200 bg-slate-900 px-5 py-4 text-center">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent_0%,rgba(249,115,22,0.7)_50%,transparent_100%)]"
      />
      <div className="relative flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <h2 className="bg-[linear-gradient(180deg,#FFFFFF_0%,#FFE7CF_60%,#F8B56B_100%)] bg-clip-text text-sm font-black uppercase tracking-[0.14em] text-transparent">
          SFE Department
        </h2>
        <span aria-hidden="true" className="h-1 w-1 rotate-45 bg-phx-accent" />
        <p className="text-phx-xs font-semibold uppercase tracking-[0.22em] text-[#F8B56B]">
          Where Your Achievement Belongs
        </p>
      </div>
      {/* Right corner, absolutely placed so it cannot shift the centred title off-centre. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/sato-pharma-logo.png"
        alt="SATO Pharma"
        className="absolute right-5 top-1/2 hidden h-7 w-auto -translate-y-1/2 opacity-95 sm:block"
      />
    </div>
  );
}

// ── Performance card ──────────────────────────────────────────────────────────

function PerfCard({
  title,
  icon,
  headline,
  headlineSub,
  badge,
  children,
  className,
}: {
  title: string;
  icon: ReactNode;
  headline: string;
  headlineSub: string;
  badge?: ReactNode;
  children: ReactNode;
  /** Grid placement from the caller - this card is wide, so it usually spans more than one column. */
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col border border-slate-200 bg-white", className)}>
      {/* `flex-wrap` so a long badge drops to its own line instead of overflowing the card.
          It pairs with `whitespace-nowrap` on the badge itself: together they mean no PHRASE ever
          breaks mid-sentence (the owner's rule) while the header still cannot overflow at a narrow
          width — this row is one column on anything below `lg`. It is inert whenever both items
          fit, which is every desktop width, so the other cards in this row are unaffected. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-2 text-phx-sm font-black uppercase tracking-[0.16em] text-slate-300">
          <span className="text-orange-400">{icon}</span>
          {title}
        </div>
        {badge}
      </div>
      <div className="border-b border-slate-100 px-4 py-4">
        <p className="text-[32px] font-black leading-none tracking-tight text-slate-900">{headline}</p>
        <p className="mt-1 text-phx-sm font-bold uppercase tracking-[0.14em] text-slate-400">{headlineSub}</p>
      </div>
      <div className="flex-1 px-4 py-4">{children}</div>
    </div>
  );
}

// ── Quick-link card (instant — no data fetch) ─────────────────────────────────

/** Exported so the System Administrator Overview's own hub band uses the identical card. */
export function QuickLinkCard({
  title,
  icon,
  headline,
  sub,
  href,
}: {
  title: string;
  icon: ReactNode;
  headline: string;
  sub: string;
  href: string;
}) {
  return (
    <Link href={href} className="group flex flex-col border border-slate-200 bg-white hover:border-orange-300">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3">
        <span className="text-orange-400">{icon}</span>
        <span className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-300">{title}</span>
      </div>
      <div className="flex flex-1 flex-col items-start justify-between gap-6 px-4 py-5">
        <div>
          <p className="text-[28px] font-black leading-none tracking-tight text-slate-900">Open →</p>
          <p className="mt-2 text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">{headline}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2 text-xs text-slate-500 group-hover:border-orange-300 group-hover:text-orange-700">
          {sub}
        </div>
      </div>
    </Link>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * The one surface three roles land on.
 *
 * `variant` selects the wording and the partitions, never a different page. The SFE variant is a
 * SUBSET — every partition is filtered down to what an SFE Manager can act on. The `admin` variant
 * is the opposite: it is the CEO layout verbatim, because the Super Admin can action strictly more
 * than the CEO can, so filtering anything out of his copy would hide work only he can do. That is
 * why every branch below asks `isSfe` and not `!isCeo` — `admin` deliberately falls through to the
 * full layout, and a future band that must NOT reach the Super Admin has to say so explicitly.
 */
export function CeoCommandCenter({
  data,
  extraBands,
  salesColumnSlot,
  topBands,
  welcome,
  access: _access,
  variant = "ceo",
}: {
  data: CeoCommandCenterData;
  /** Rendered as the last band before the footer. The admin overview passes its Finance bands here. */
  extraBands?: ReactNode;
  /**
   * The third column of the Sales & marketing row — where the empty "Weekly Sales" card used to be.
   *
   * Owner, 2026-09-07: "put the resignation risk reps in the place of weekly sales". A ReactNode so
   * the caller can wrap it in its own <Suspense> and the sales tables do not wait on a CRM scan.
   */
  salesColumnSlot?: ReactNode;
  /**
   * Rendered FIRST, directly under the hero and above every metric tile.
   *
   * A ReactNode rather than data on `CeoCommandCenterData`, and that is the point: the caller
   * wraps it in its own `<Suspense>`, so a band that has to scan the CRM mirror streams in on its
   * own without holding up the tiles. It also means a band reaches only the surfaces that pass it
   * — the retention-risk board goes to the Super Admin and the SFE Manager, and the CEO variant
   * simply never supplies one, so nothing here has to ask which variant is rendering.
   */
  topBands?: ReactNode;
  /**
   * The identity band's subject, or `null` for a surface that draws its own identity another way.
   * /admin passes null — it carries `PhoenixIdentityStrip` one level up in
   * `SystemAdminOverview`, and a band here as well would stack two identities on that page.
   * See `CeoWelcomeProfile` for why this is required rather than optional.
   */
  welcome: CeoWelcomeProfile | null;
  access: AccessContext;
  variant?: "admin" | "ceo" | "sfe";
}) {
  const { attention, approvals, dataUnavailable, headcount, health, payroll, sos } = data;
  // Name the month AND say what it is, everywhere the month appears. This card shows the last
  // published closing rather than the newest upload (see getCeoCommandCenterData), so a bare
  // "2026-07" read in August would look like a stale page; the word "closing" is what turns it
  // into a deliberate figure.
  const sosPeriodLabel = sosPeriodDisplayLabel(sos);
  // "August is loading" — the one thing a reader of a deliberately-last-month figure still needs.
  const sosNewerLabel =
    sos && sos.newerPeriods.length > 0 && sos.periodBasis === "published-closing"
      ? `${sos.newerPeriods[0]} is still loading`
      : null;
  const isSfe = variant === "sfe";
  const surfaceLabel =
    variant === "sfe"
      ? "SFE Manager Overview"
      : variant === "admin"
        ? "System Administrator Overview"
        : "CEO Command Center";
  const visibleAttention = isSfe
    ? attention.filter((item) => SFE_ATTENTION_KEYS.has(item.key))
    : attention;
  const visibleDataUnavailable = dataUnavailable.filter((source) => !isSfe || isSfeDataSource(source));
  const generatedLabel = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date(data.generatedAt));

  const dataAvailable = visibleDataUnavailable.length === 0;
  /**
   * A COUNT is a claim about rows that were actually read.
   *
   * The RATES no longer need this: `emptyPlatformMetrics()` carries `null` for every one of them,
   * so `pct()` prints "—" on its own. The counts still do, because 0 is a legitimate count and an
   * unread section is indistinguishable from an empty one — "Vacancies 0" next to a dead
   * organogram read is a claim nobody measured.
   *
   * These booleans also only see a source that THREW: `dataUnavailable` is appended from
   * `metricOrDefault`'s catch alone, never from a permission refusal. That blind spot is exactly
   * why the rates were moved onto `null` instead.
   */
  const workforceWasRead = !visibleDataUnavailable.some((source) =>
    /(workforce|employee directory|structure totals)/i.test(source),
  );
  // Weekly-plan approval is Super Admin + CEO only (weekly_plans:approve is absent from the SFE
  // Manager's matrix), so that tile is a number he can never action. Leave he CAN approve, but the
  // `leaveSla` attention row below already carries the pending count and links to the same
  // /admin/approvals/vacation page — showing both would double-count one queue.
  const showApprovalTiles = !isSfe;
  const totalApprovals = showApprovalTiles ? (approvals.leavePending ?? 0) + (approvals.plansPending ?? 0) : 0;
  const hasUnavailableApprovals =
    showApprovalTiles && (approvals.leavePending === null || approvals.plansPending === null);
  const allClear = dataAvailable && visibleAttention.length === 0 && totalApprovals === 0;

  return (
    <div className="space-y-0 divide-y divide-slate-200">

      {/* ── Hero ────────────────────────────────────────────────────────────── */}
      {/* THE ORIGINAL IDENTITY BAND, restored 2026-09-06 on the owner's instruction: "I WANT THE
          SFE AND THE FINANCE AND CEO TO HAVE THEIR PREVIOUS IDENTITY BANNER, THE NEW ONE IS ONLY
          FOR HRs."

          It is byte-for-byte the block removed on 2026-09-03 ("remove from all pages this dump
          block"), and the two halves of that day are NOT the same decision:

            • the BAND — this one — came off every page, including this one;
            • the STRIP (`PhoenixIdentityStrip`, 92px) was what he asked for INSTEAD, later the
              same day, and it belongs to the HR overview and /admin. It is not a smaller version
              of this band to be swapped in here. Putting it on these three boards on 2026-09-06
              was the mistake this restore reverses, within the hour.

          So: the CEO, SFE and Finance boards wear THIS band; the HR overview and /admin wear the
          strip. `tests/admin-landing-identity-strip.test.ts` pins that split per surface, in both
          directions, so neither can quietly become the other again.

          `welcome === null` is /admin, and it is the whole reason this is a conditional rather
          than an unconditional block: that page carries the strip in `SystemAdminOverview`, one
          level up, so a band here as well would stack two identities on it. */}
      {welcome ? (
        <AdminHeroFrame className="z-10 overflow-visible">
          <div className="p-4 sm:p-4 lg:p-5">
            <div className="mb-3 inline-flex items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3 py-1.5 text-phx-xs font-black uppercase tracking-[0.22em] text-orange-100">
              <HeartPulse aria-hidden="true" className="h-3.5 w-3.5" />
              {surfaceLabel}
            </div>
            <CeoHeroIdentity
              // The portrait is `h-full` of this band and was hanging 11px BELOW it, so the next
              // section clipped him mid-figure. Flush-bottom ends the photo exactly on the band edge.
              // Finance already passes this; the CEO was the one surface still bleeding.
              flushToEdges
              fullName={welcome.fullName}
              roleLabel={welcome.roleLabel}
              imageUrl={welcome.imageUrl}
              initials={welcome.initials}
              // The CEO's OWN greeting — "Good morning, Dr. Anwar" and the note written for the
              // Chief Executive — belongs to exactly one person. `!isSfe` handed both to the Super
              // Admin the moment the admin variant existed, which is why this asks for the CEO by
              // name rather than for "not the SFE". Pinned by tests/ceo-command-center.test.ts.
              personal={variant === "ceo"}
              // The shared fallback sub-line is "Here is where sales and the field stand today."
              // True for a sales seat, wrong for the one that also owns access, data and payroll.
              subGreeting={
                variant === "admin"
                  ? "Everything the company is doing, and everything only you can fix."
                  : undefined
              }
            />
          </div>
        </AdminHeroFrame>
      ) : null}

      {/* Outside the `welcome ?` guard on purpose: this band renders for all three variants
          (CEO, SFE, admin) including /admin, which passes `welcome={null}` and draws its own
          identity strip one level up in SystemAdminOverview. One nudge here reaches all three
          admin-shell home surfaces this component serves. */}
      <PushOptInNudge />

      <DataUnavailableNotice
        owner={variant === "sfe" ? "SFE" : variant === "admin" ? "system" : "CEO"}
        sources={visibleDataUnavailable}
      />

      {/* Above the tiles deliberately. What this slot carries is the work somebody has to do
          TODAY, and a band placed under four screens of metrics is a band nobody reads. */}
      {topBands}

      <SectionShell
        title={isSfe ? "SFE Department" : "Sato Pharma"}
        description={isSfe ? undefined : "A healthier life is our commitment."}
        header={isSfe ? <SfeDepartmentBanner /> : undefined}
        action={
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/brand/sato-pharma-logo.png" alt="SATO Pharma" className="mr-[28px] h-8 w-auto shrink-0" />
        }
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {/* Active employees reads the same directory aggregate as Lines/Areas below, so it too
              renders a hard zero for the SFE Manager. His headline number is the sales figure. */}
          {!isSfe ? (
            <MetricTile
              icon={<Users className="h-3.5 w-3.5" />}
              label="Active employees"
              value={n(headcount.active)}
              sub="Active and on leave"
              tone={headcount.active > 0 ? "emerald" : "amber"}
            />
          ) : (
            <MetricTile
              icon={<Wallet className="h-3.5 w-3.5" />}
              label="Monthly sales"
              value={sos ? egp(sos.totalValue) : "—"}
              sub={sosPeriodLabel ? `Source of Sales · ${sosPeriodLabel}` : "No monthly sales loaded"}
              tone={sos && sos.totalValue > 0 ? "emerald" : "amber"}
            />
          )}
          {/* Total structure and Vacancies both read the Organogram / AU seat model, which the
              SFE Manager holds no `organogram` or `vacancies` grant for — the sales-achievement
              tile below takes their place on his overview. */}
          {!isSfe ? <MetricTile
            icon={<BriefcaseBusiness className="h-3.5 w-3.5" />}
            label="Total structure"
            value={workforceWasRead ? n(headcount.total) : "—"}
            sub="Employees plus vacancies"
          /> : null}
          {!isSfe ? <MetricTile
            icon={<Building2 className="h-3.5 w-3.5" />}
            label="Vacancies"
            value={workforceWasRead ? n(headcount.vacancies) : "—"}
            sub="Open positions"
            tone={!workforceWasRead || headcount.vacancies > 0 ? "amber" : "emerald"}
          /> : null}
          {isSfe ? <MetricTile
            icon={<Target className="h-3.5 w-3.5" />}
            label="Sales achievement"
            value={pct(health.salesAchievementRate)}
            // The window has to be on the tile. This rate is cumulative from the engine's 2026-01
            // floor, and it sits two tiles from "Monthly sales", which is stamped with a single
            // closing month — so unlabelled it read as that month's achievement.
            sub={`Company sales vs target · ${SALES_ACHIEVEMENT_WINDOW_LABEL}`}
            tone={health.salesAchievementRate !== null && health.salesAchievementRate >= 0.9 ? "emerald" : "amber"}
          /> : null}
          {!isSfe ? <MetricTile
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
            label="Employee health"
            value={pct(health.employeeHealthRate)}
            sub="Active/total quality"
            tone={health.employeeHealthRate !== null && health.employeeHealthRate >= 0.9 ? "emerald" : "amber"}
          /> : null}
          {/* Lines/Areas from the employee directory are gated by canReadCompanyWorkforceAggregates
              (system scope, Super Admin, or CEO) and read a hard ZERO for everyone else — which is
              exactly how the SFE overview came to show "Lines 0 / Areas 0" against a live 59%
              achievement. His counts come from the SoS dataset instead: same question, sales data,
              no HR gate.

              Both SoS tiles read `—` rather than 0 when `sos` is null — the same choice the
              "Monthly sales" tile above already makes off this very object. A hard 0 asserts that
              nothing sold, which is a far stronger claim than "nothing loaded". */}
          {isSfe ? <MetricTile
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="Lines selling"
            value={sos ? n(sos.lineCount) : "—"}
            sub={sos ? `In ${sosPeriodLabel ?? "the latest period"}` : "No monthly sales loaded"}
            tone={sos && sos.lineCount > 0 ? "slate" : "amber"}
          /> : <MetricTile
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="Lines"
            value={workforceWasRead ? n(headcount.uniqueLines) : "—"}
            sub="Lookup-backed count"
          />}
          {/* NOT the region count: regions cannot be filtered to his lines (see
              applySfeSalesLineScope), so that tile would read a flat "0" and assert nobody is
              selling anywhere. Products carry the line, so this one is real. */}
          {isSfe ? <MetricTile
            icon={<MapPinned className="h-3.5 w-3.5" />}
            label="Products selling"
            value={sos ? n(sos.byProduct.length) : "—"}
            sub={sos ? `Across ${n(sos.lineCount)} lines · ${sosPeriodLabel ?? "latest period"}` : "No monthly sales loaded"}
            tone={sos && sos.byProduct.length > 0 ? "slate" : "amber"}
          /> : <MetricTile
            icon={<MapPinned className="h-3.5 w-3.5" />}
            label="Areas"
            value={workforceWasRead ? n(headcount.uniqueAreas) : "—"}
            sub="Lookup-backed count"
          />}
          {!isSfe ? <MetricTile
            icon={<Wallet className="h-3.5 w-3.5" />}
            label="Net payroll"
            value={egp(payroll.net)}
            sub={payroll.batchLabel}
            tone={payroll.available ? "slate" : "amber"}
          /> : null}
          {!isSfe ? <MetricTile
            icon={<ClipboardCheck className="h-3.5 w-3.5" />}
            label="Salary flags"
            // Green-with-0 is an all-clear, and `payroll.available === false` is the one case where
            // the 0 means "nothing was counted" rather than "nothing is wrong". The "Net payroll"
            // tile beside it already reads that same flag.
            value={payroll.available ? n(payroll.unresolvedSalaryFlags) : "—"}
            sub="Unresolved payroll risks"
            tone={!payroll.available ? "amber" : payroll.unresolvedSalaryFlags > 0 ? "rose" : "emerald"}
          /> : null}
        </div>
      </SectionShell>

      {/* ── Attention & approvals ─────────────────────────────────────────── */}
      <SectionShell
        title="Attention & pending approvals"
        description={
          isSfe
            ? "Field-force signals you can act on — probation decisions and the coaching red zone."
            : "What needs your decision or your eye — by priority."
        }
        action={
          !allClear ? (
            // "Other Approvals" carries resignation / contract / outstation items only, and the
            // SFE Manager holds none of those grants — his queue is the probation assessments.
            <Link
              href={isSfe ? "/probation" : "/admin/approvals-hub"}
              className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-sm font-bold text-white hover:bg-white/20"
            >
              {isSfe ? "Probation" : "Approvals Hub"} <ArrowRight aria-hidden="true" className="h-3 w-3" />
            </Link>
          ) : null
        }
      >
        <div className="p-5 sm:p-6">
          {allClear ? (
            <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
              <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-emerald-600" />
              <span className="text-sm font-semibold text-emerald-800">
                All clear — nothing awaiting your approval and no open risk signals.
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Approval tiles */}
              {visibleDataUnavailable.length > 0 ? (
                <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <span className="text-sm font-semibold text-amber-900">
                    Not all {isSfe ? "SFE" : "executive"} risk sources loaded. This section is not treated as all clear.
                  </span>
                </div>
              ) : null}

              {showApprovalTiles && (totalApprovals > 0 || hasUnavailableApprovals) ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Link
                    href="/admin/approvals/vacation"
                    className="group flex items-center justify-between border border-slate-200 bg-slate-50 px-4 py-3 hover:border-orange-300 hover:bg-orange-50/40"
                  >
                    <span className="flex items-center gap-3">
                      <ClipboardCheck aria-hidden="true" className="h-4 w-4 text-orange-600" />
                      <span className="text-sm font-semibold text-slate-700">Leave requests</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-2xl font-black text-slate-900">{n(approvals.leavePending)}</span>
                      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                  <Link
                    href="/admin/approvals-hub"
                    className="group flex items-center justify-between border border-slate-200 bg-slate-50 px-4 py-3 hover:border-orange-300 hover:bg-orange-50/40"
                  >
                    <span className="flex items-center gap-3">
                      <CalendarClock aria-hidden="true" className="h-4 w-4 text-orange-600" />
                      <span className="text-sm font-semibold text-slate-700">Weekly plans</span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-2xl font-black text-slate-900">{n(approvals.plansPending)}</span>
                      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </div>
              ) : null}

              {/* Attention items: numbered priority list */}
              {visibleAttention.length > 0 ? (
                <div className="divide-y divide-slate-100 border border-slate-200">
                  {visibleAttention.map((item, idx) => {
                    const tone = toneStyles[item.tone];
                    return (
                      <Link
                        key={item.key}
                        href={item.href}
                        className={`group flex items-center gap-0 hover:bg-slate-50`}
                      >
                        {/* Color bar */}
                        <div className={`w-1 self-stretch ${tone.border.replace("border-l-", "bg-")}`} />
                        {/* Index */}
                        <span className="w-10 shrink-0 text-center text-phx-xs font-black text-slate-300">
                          #{idx + 1}
                        </span>
                        {/* Priority label */}
                        <span className={`w-20 shrink-0 text-phx-xs font-black uppercase tracking-[0.14em] ${tone.text}`}>
                          {tone.label}
                        </span>
                        {/* Description */}
                        <span className="flex-1 py-3 text-sm font-medium text-slate-700">{item.label}</span>
                        {/* Count */}
                        <span className="w-12 text-center text-xl font-black text-slate-900">{n(item.count)}</span>
                        {/* Arrow */}
                        <ArrowRight
                          aria-hidden="true"
                          className="mr-4 h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5"
                        />
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}
        </div>
      </SectionShell>

      {/* ── Sales performance ─────────────────────────────────────────────── */}
      <SectionShell
        title="Sales & marketing performance"
        description={
          isSfe
            ? "Source of Sales (monthly, live) — your lines and regions, plus the company field-sales dashboards."
            : "Source of Sales (monthly, live) — plus one-click access to Weekly Sales and Marketing ROI dashboards."
        }
      >
        {/* Three columns, but only ever TWO cards in them - so the Source of Sales card spans two
            and the row closes. Before 2026-08-30 it did not: the third column was empty for the CEO
            and the Super Admin, 583px tall, the single largest blank area on the page. The SFE
            variant drops the Weekly Sales shortcut entirely (it gets the real trend further down),
            so its row is one full-width card and the span is irrelevant there.

            Read this as the rule for every grid on this page: the column count must match the
            number of cards that actually render for THAT variant. A card removed by a ruling and a
            column count left behind is exactly how these gaps appear. */}
        <div className="grid divide-x divide-slate-200 lg:grid-cols-3">
          {/* SoS — immediate. The month in progress rides on this card's own header line, next to
              the units: the one place a reader looking at a deliberately-last-month figure is
              already looking. `whitespace-nowrap` on that badge because an owner rule forbids this
              text wrapping, and it uses a plain className rather than cn(), which silently drops
              text-phx-* named sizes. */}
          <PerfCard
            className="lg:col-span-2"
            title="Source of Sales"
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            headline={sos ? egp(sos.totalValue) : "—"}
            headlineSub={sosPeriodLabel ? `Monthly · ${sosPeriodLabel}` : "Monthly"}
            badge={sos ? (
              <span className="whitespace-nowrap text-phx-sm text-slate-400">
                {n(sos.totalQty)} units{sosNewerLabel ? ` · ${sosNewerLabel}` : ""}
              </span>
            ) : null}
          >
            {/* Full-width on the SFE page, so the two tables sit side by side instead of one
                stacked under the other across the whole screen. */}
            <div className={cn(isSfe ? "grid gap-6 lg:grid-cols-2" : "space-y-5")}>
              <div>
                <p className="mb-2 text-phx-xs font-black uppercase tracking-[0.16em] text-slate-400">Top Lines</p>
                <CeoTopMoversTable
                  movers={sos?.topLines ?? []}
                  title="SoS Top Lines"
                  exportTitle="Source of Sales — Top Lines"
                  subtitle={sos?.period ?? undefined}
                  labelHeader="Product Line"
                  // `topLines` is the top FIVE (topMoversFromSos slices it), so Share must divide by
                  // EVERY line carrying sales this period — not by the handful listed here.
                  total={(sos?.byLine ?? []).reduce((sum, line) => sum + line.totalValue, 0)}
                  empty="No monthly sales loaded yet."
                />
              </div>
              <div>
                <p className="mb-2 text-phx-xs font-black uppercase tracking-[0.16em] text-slate-400">Top Regions</p>
                <CeoTopMoversTable
                  movers={sos?.topRegions ?? []}
                  title="SoS Top Regions"
                  exportTitle="Source of Sales — Top Regions"
                  subtitle={sos?.period ?? undefined}
                  labelHeader="Region"
                  // Same slice, and this is where it actually bit: 13 regions carried sales in
                  // August and the five listed are 90.4% of their value, so every share here read
                  // about 11% high until this denominator was passed.
                  total={(sos?.byRegion ?? []).reduce((sum, region) => sum + region.totalValue, 0)}
                  empty="No regional sales data yet."
                />
              </div>
            </div>
          </PerfCard>

          {/* THE RESIGNATION-RISK REPS LIVE HERE. Owner, 2026-09-07, with a screenshot: "put the
              resignation risk reps in the place of weekly sales".

              What was here was a lone "Weekly Sales" QuickLinkCard whose entire content was the
              words "Open →". Beside the Source of Sales tables it stretched to match and was the
              largest blank area on the page — and it was a duplicate, since "Weekly Sales · Company"
              in the row below opens the same module. Nothing is lost by replacing it.

              Both variants get the column now. The SFE Manager's row was single-column only because
              he was the one who did NOT get that empty card; he is one of the four people this alert
              is addressed to, so he gets it too. */}
          {/* THE CEO KEEPS HIS WEEKLY SALES LINK. tests/ceo-account-contract.test.ts requires the
              command centre to link directly to /sales/weekly/dashboard, and that contract is his,
              not the Super Admin's. He is also the one variant that never receives a slot — the
              resignation-risk column is addressed to the Super Admin and the SFE Manager — so the
              fallback and the contract are the same condition, expressed once.

              The SFE Manager never reaches the fallback either, because his page passes a slot; the
              recorded decision that he gets the real week-over-week series instead of a
              click-through therefore still holds. */}
          {salesColumnSlot ?? (
            <QuickLinkCard
              title="Weekly Sales"
              icon={<Activity className="h-3.5 w-3.5" />}
              headline="7-week trend + region breakdown"
              sub="Click to open Weekly Sales"
              href="/sales/weekly/dashboard"
            />
          )}

        </div>

        {/* ── Company field-sales command — NSM-parity dashboards at company scope ── */}
        {/* FIVE cards, so five columns - one full row, no blank cells. It said "six cards" and
            split 3/4 until 2026-08-30, which was true until ruling 11 removed the Sales Analytics
            card and left the column counts behind: the CEO saw 4 + 1 with three empty cells
            (413px), the SFE Manager 3 + 2 with one. Count the cards below before changing this. */}
        <div className="grid divide-x divide-slate-200 border-t border-slate-200 sm:grid-cols-2 lg:grid-cols-5">
          <QuickLinkCard
            title="Weekly Sales · Company"
            icon={<Activity className="h-3.5 w-3.5" />}
            headline="All lines · all regions · week-over-week"
            sub="Open the company weekly dashboard"
            href="/admin/field-sales/weekly-sales"
          />
          <QuickLinkCard
            title="Source of Sales · Company"
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            headline="Channel mix, regions, areas, products, distributors"
            sub="Open the company SoS dashboard"
            href="/admin/field-sales/source-of-sales"
          />
          <QuickLinkCard
            title="DSM Performance"
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            headline="Every line's district managers vs target"
            sub="Open company DSM performance"
            href="/admin/field-sales/dsm-performance"
          />
          <QuickLinkCard
            title="Med-Rep Performance"
            icon={<Activity className="h-3.5 w-3.5" />}
            headline="Every line's reps, grouped by district"
            sub="Open company med-rep performance"
            href="/admin/field-sales/med-reps-performance"
          />
          {/*
            "Sales Analytics" (/admin/analytics) removed by ruling 11 — "no analytics module, no
            sales analytics". This was the CEO's last shortcut into that hub; the SFE Manager's
            equivalent in ceo-phase-b.tsx went in the same change. The Source of Sales and Med-Rep
            Performance cards around it still open their own dashboards directly, so no number the
            CEO reads from this page moved — only the hub door closed. The owner retired the module
            itself on 2026-09-17; its old addresses redirect.
          */}
          <QuickLinkCard
            title="Double-Visit Intelligence"
            icon={<MapPinned className="h-3.5 w-3.5" />}
            headline="Coverage, AM/PM split, per-rep intensity"
            sub="Open Double-Visit Analytics"
            href="/admin/double-visit-analytics"
          />
        </div>
      </SectionShell>

      {/* ── Operations hubs — consolidated cross-module quick links ─────────── */}
      <SectionShell
        title="Operations hubs"
        description={
          isSfe
            ? "One click into the CRM workspace, or every marketing & ROI module."
            : "One click into every attendance module, or every marketing & ROI module."
        }
      >
        <div className="grid divide-x divide-slate-200 sm:grid-cols-2">
          {/* Attendance is an HR hub. The SFE Manager gets the CRM workspace in its place —
              same slot, but the module he is actually accountable for. */}
          {isSfe ? (
            <QuickLinkCard
              title="CRM Workspace"
              icon={<MapPinned className="h-3.5 w-3.5" />}
              headline="Visits, check-ins, contacts & integrity"
              sub="Open the CRM workspace"
              href="/admin/crm"
            />
          ) : (
            <QuickLinkCard
              title="Attendance Management"
              icon={<Fingerprint className="h-3.5 w-3.5" />}
              headline="Reports, reviews, policies & devices"
              sub="Open the Attendance Management hub"
              href="/attendance"
            />
          )}
          <QuickLinkCard
            title="Marketing & ROI"
            icon={<Megaphone className="h-3.5 w-3.5" />}
            headline="Requests, ROI reports & coverage"
            sub="Open the Marketing & ROI hub"
            href="/admin/marketing-roi"
          />
        </div>
      </SectionShell>

      {/* Bands the variant adds on top of the shared layout. Last before the footer so the
          "Data as of" line stays the final thing on the page whatever was inserted. */}
      {extraBands}

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3 text-phx-sm text-slate-400">
        <span className="flex items-center gap-2">
          <Users aria-hidden="true" className="h-3 w-3" />
          Phoenix Workforce · {surfaceLabel}
        </span>
        <span className="flex items-center gap-2">
          <Wallet aria-hidden="true" className="h-3 w-3" />
          Data as of {generatedLabel}
        </span>
      </div>
    </div>
  );
}
