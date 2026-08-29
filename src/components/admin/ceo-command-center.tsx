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
import type { AccessContext } from "@/lib/auth/permissions";
import type {
  CeoAttentionTone,
  CeoCommandCenterData,
} from "@/lib/ceo/command-center";
import { cn } from "@/lib/utils";

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

function pct(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100)}%`;
}

function MetricTile({
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
      <div className="flex items-center gap-2 text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">
        <span className="text-orange-600">{icon}</span>
        {label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none ${toneClass}`}>{value}</p>
      <p className="mt-2 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p>
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
      <div className="mt-1 flex justify-between text-phx-3xs text-slate-400">
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
          <span className="truncate text-phx-4xs text-slate-400">{row.label}</span>
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
}: {
  title: string;
  icon: ReactNode;
  headline: string;
  headlineSub: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-2 text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-300">
          <span className="text-orange-400">{icon}</span>
          {title}
        </div>
        {badge}
      </div>
      <div className="border-b border-slate-100 px-4 py-4">
        <p className="text-[32px] font-black leading-none tracking-tight text-slate-900">{headline}</p>
        <p className="mt-1 text-phx-2xs font-bold uppercase tracking-[0.14em] text-slate-400">{headlineSub}</p>
      </div>
      <div className="flex-1 px-4 py-4">{children}</div>
    </div>
  );
}

// ── Quick-link card (instant — no data fetch) ─────────────────────────────────

function QuickLinkCard({
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
        <span className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-300">{title}</span>
      </div>
      <div className="flex flex-1 flex-col items-start justify-between gap-6 px-4 py-5">
        <div>
          <p className="text-[28px] font-black leading-none tracking-tight text-slate-900">Open →</p>
          <p className="mt-2 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">{headline}</p>
        </div>
        <div className="border border-slate-200 px-3 py-2 text-xs text-slate-500 group-hover:border-orange-300 group-hover:text-orange-700">
          {sub}
        </div>
      </div>
    </Link>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CeoCommandCenter({
  data,
  welcome: _welcome,
  access: _access,
  variant = "ceo",
}: {
  data: CeoCommandCenterData;
  welcome: CeoWelcomeProfile;
  access: AccessContext;
  variant?: "ceo" | "sfe";
}) {
  const { attention, approvals, dataUnavailable, headcount, health, payroll, sos } = data;
  const isSfe = variant === "sfe";
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
      <AdminHeroFrame className="z-10 overflow-visible">
        <div className="p-5 sm:p-6 lg:p-8">
          <div className="mb-5 inline-flex items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3 py-1.5 text-phx-3xs font-black uppercase tracking-[0.22em] text-orange-100">
            <HeartPulse aria-hidden="true" className="h-3.5 w-3.5" />
            {isSfe ? "SFE Manager Overview" : "CEO Command Center"}
          </div>
          <CeoHeroIdentity
            fullName={_welcome.fullName}
            roleLabel={_welcome.roleLabel}
            imageUrl={_welcome.imageUrl}
            initials={_welcome.initials}
            personal={!isSfe}
          />
        </div>
      </AdminHeroFrame>

      <DataUnavailableNotice owner={isSfe ? "SFE" : "CEO"} sources={visibleDataUnavailable} />

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
              sub={sos?.period ? `Source of Sales · ${sos.period}` : "No monthly sales loaded"}
              tone={sos && sos.totalValue > 0 ? "emerald" : "amber"}
            />
          )}
          {/* Total structure and Vacancies both read the Organogram / AU seat model, which the
              SFE Manager holds no `organogram` or `vacancies` grant for — the sales-achievement
              tile below takes their place on his overview. */}
          {!isSfe ? <MetricTile
            icon={<BriefcaseBusiness className="h-3.5 w-3.5" />}
            label="Total structure"
            value={n(headcount.total)}
            sub="Employees plus vacancies"
          /> : null}
          {!isSfe ? <MetricTile
            icon={<Building2 className="h-3.5 w-3.5" />}
            label="Vacancies"
            value={n(headcount.vacancies)}
            sub="Open positions"
            tone={headcount.vacancies > 0 ? "amber" : "emerald"}
          /> : null}
          {isSfe ? <MetricTile
            icon={<Target className="h-3.5 w-3.5" />}
            label="Sales achievement"
            value={pct(health.salesAchievementRate)}
            sub="Company sales vs target"
            tone={health.salesAchievementRate >= 0.9 ? "emerald" : "amber"}
          /> : null}
          {!isSfe ? <MetricTile
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
            label="Employee health"
            value={pct(health.employeeHealthRate)}
            sub="Active/total quality"
            tone={health.employeeHealthRate >= 0.9 ? "emerald" : "amber"}
          /> : null}
          {/* Lines/Areas from the employee directory are gated by canReadCompanyWorkforceAggregates
              (system scope, Super Admin, or CEO) and read a hard ZERO for everyone else — which is
              exactly how the SFE overview came to show "Lines 0 / Areas 0" against a live 59%
              achievement. His counts come from the SoS dataset instead: same question, sales data,
              no HR gate. */}
          {isSfe ? <MetricTile
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="Lines selling"
            value={n(sos?.lineCount ?? 0)}
            sub={sos ? `In ${sos.period ?? "the latest period"}` : "No monthly sales loaded"}
            tone={sos && sos.lineCount > 0 ? "slate" : "amber"}
          /> : <MetricTile
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="Lines"
            value={n(headcount.uniqueLines)}
            sub="Lookup-backed count"
          />}
          {/* NOT the region count: regions cannot be filtered to his lines (see
              applySfeSalesLineScope), so that tile would read a flat "0" and assert nobody is
              selling anywhere. Products carry the line, so this one is real. */}
          {isSfe ? <MetricTile
            icon={<MapPinned className="h-3.5 w-3.5" />}
            label="Products selling"
            value={n(sos?.byProduct.length ?? 0)}
            sub={sos ? `Across ${n(sos.lineCount)} lines · ${sos.period ?? "latest period"}` : "No monthly sales loaded"}
            tone={sos && sos.byProduct.length > 0 ? "slate" : "amber"}
          /> : <MetricTile
            icon={<MapPinned className="h-3.5 w-3.5" />}
            label="Areas"
            value={n(headcount.uniqueAreas)}
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
            value={n(payroll.unresolvedSalaryFlags)}
            sub="Unresolved payroll risks"
            tone={payroll.unresolvedSalaryFlags > 0 ? "rose" : "emerald"}
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
              className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
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
                        <span className={`w-20 shrink-0 text-phx-3xs font-black uppercase tracking-[0.14em] ${tone.text}`}>
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
        {/* Three columns only when there is something to put in them. The SFE variant drops the
            Weekly Sales shortcut (it gets the real trend further down), which left the SoS card
            alone in a third of the row and two thirds of blank white beside it. */}
        <div className={cn("grid divide-x divide-slate-200", isSfe ? "lg:grid-cols-1" : "lg:grid-cols-3")}>
          {/* SoS — immediate */}
          <PerfCard
            title="Source of Sales"
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            headline={sos ? egp(sos.totalValue) : "—"}
            headlineSub={sos?.period ? `Monthly · ${sos.period}` : "Monthly"}
            badge={sos ? <span className="text-phx-2xs text-slate-400">{n(sos.totalQty)} units</span> : null}
          >
            {/* Full-width on the SFE page, so the two tables sit side by side instead of one
                stacked under the other across the whole screen. */}
            <div className={cn(isSfe ? "grid gap-6 lg:grid-cols-2" : "space-y-5")}>
              <div>
                <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Top Lines</p>
                <CeoTopMoversTable
                  movers={sos?.topLines ?? []}
                  title="SoS Top Lines"
                  exportTitle="Source of Sales — Top Lines"
                  subtitle={sos?.period ?? undefined}
                  labelHeader="Product Line"
                  empty="No monthly sales loaded yet."
                />
              </div>
              <div>
                <p className="mb-2 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Top Regions</p>
                <CeoTopMoversTable
                  movers={sos?.topRegions ?? []}
                  title="SoS Top Regions"
                  exportTitle="Source of Sales — Top Regions"
                  subtitle={sos?.period ?? undefined}
                  labelHeader="Region"
                  empty="No regional sales data yet."
                />
              </div>
            </div>
          </PerfCard>

          {/* Weekly Sales — a shortcut for the CEO. The SFE Manager gets the real week-over-week
              series instead (the "Weekly sales trend" section in Phase B), because weekly sales
              is his job rather than something he occasionally clicks through to. */}
          {!isSfe ? <QuickLinkCard
            title="Weekly Sales"
            icon={<Activity className="h-3.5 w-3.5" />}
            headline="7-week trend + region breakdown"
            sub="Click to open Weekly Sales"
            href="/sales/weekly/dashboard"
          /> : null}

        </div>

        {/* ── Company field-sales command — NSM-parity dashboards at company scope ── */}
        {/* Six cards. Four columns leaves a ragged half-empty second row; three gives two full
            rows. Scoped to the SFE variant to keep this change to the page under review. */}
        <div
          className={cn(
            "grid divide-x divide-slate-200 border-t border-slate-200 sm:grid-cols-2",
            isSfe ? "lg:grid-cols-3" : "lg:grid-cols-4",
          )}
        >
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
            CEO reads from this page moved — only the hub door closed.
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

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3 text-phx-2xs text-slate-400">
        <span className="flex items-center gap-2">
          <Users aria-hidden="true" className="h-3 w-3" />
          Phoenix Workforce · {isSfe ? "SFE Manager Overview" : "CEO Command Center"}
        </span>
        <span className="flex items-center gap-2">
          <Wallet aria-hidden="true" className="h-3 w-3" />
          Data as of {generatedLabel}
        </span>
      </div>
    </div>
  );
}
