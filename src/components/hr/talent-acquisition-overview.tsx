"use client";

/**
 * The Talent Acquisition seat's landing page.
 *
 * WHOSE PAGE AND WHY IT IS NOT `HrCommandCenter`. Yomna Gamal, Talent Acquisition Specialist, first
 * day Sunday 18 October 2026. The owner's instruction on 13 October 2026: *"donot touch photo or
 * identity banner and from scratch build her overview landing page but note i like Live candidates,
 * by pipeline stage / live calendar and Job offers, by status / totally donot show employee
 * requests"*, then, with her handbook attached, *"here is her job description and kpis tailor based
 * on this"*. Every other HR seat still renders `HrCommandCenter`, untouched — the route picks
 * between them on her bundle alone, so the blast radius of this file is one seat.
 *
 * THE BANDS ARE HER HANDBOOK'S KPI FAMILIES, in its order — Hiring quality, Offer conversion,
 * Filling the field — not her permission bundle's functions. Two more families in that handbook
 * (Retention support, Employee connection) are deliberately not here: he was shown that neither has
 * an honest source for this seat and said to leave them off. See the data module's header.
 *
 * WHAT IS BORROWED, AND IT IS NEARLY ALL OF IT (AGENTS.md §4: match the sibling pages, never invent
 * a one-off look). `PhoenixIdentityStrip` with the same four props the generic page passes;
 * `MetricTile`'s exact resting state, tone bar and hover lift; `HrCommandCharts` for both charts, so
 * his two favourites render the same way they do today, down to the caption and the orange;
 * `HrTodayPanel`, `HrOnVacationToday` and `HrMyRecord` unchanged. The KPI card below is the one new
 * shape on the page, and it is `ChartCard`'s frame with a figure in place of the plot.
 *
 * THE IDENTITY STRIP IS NOT TO BE TOUCHED — *"donot touch photo or identity banner"*, and before
 * that, on 2026-10-12, *"do not touch, do not ever touch"*. The props below are the generic page's
 * byte for byte. Do not restyle it, do not wrap it, do not pass it a fifth prop.
 *
 * A RATE IS NEVER DRAWN AS A ZERO. `TalentKpi.rate` is null when there is nothing to divide by, and
 * the card then prints `emptyLabel` as a sentence. Production on 13 October 2026 holds 36 probation
 * cases and 0 decided — a 0% there would tell her no new hire has ever passed probation.
 *
 * NEVER A HORIZONTAL SCROLL, SQUARE EDGES, NO ELLIPSIS (owner's golden rules). No table at any
 * breakpoint: every figure here is a link to the page that actions it, so it is a grid of cards at
 * 375px and a grid of cards at 1440px. Chips carry `whitespace-nowrap` and their ROW wraps; prose
 * is `break-words`; nothing is cut.
 */

import {
  ArrowUpRight,
  BriefcaseBusiness,
  CalendarDays,
  FileSignature,
  Gauge,
  LifeBuoy,
  Award,
  FileSearch,
  Fingerprint,
  HeartPulse,
  Hourglass,
  IdCard,
  Mail,
  Network,
  FileSpreadsheet,
  ShieldCheck,
  Target,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { HrCommandCharts } from "@/components/hr/hr-command-charts";
import { HrMyRecord } from "@/components/hr/hr-my-record";
import { HrOnVacationToday } from "@/components/hr/hr-on-vacation-today";
import { HrTodayPanel } from "@/components/hr/hr-today-panel";
import { TalentAcquisitionCalendar } from "@/components/hr/talent-acquisition-calendar";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import { PhoenixIdentityStrip } from "@/components/phoenix-signature-card/PhoenixIdentityStrip";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import type { HrFunctionKey } from "@/lib/auth/hr-functions";
import type { HrCommandTile } from "@/lib/hr/command-center";
import type { TalentAcquisitionOverviewData } from "@/lib/hr/talent-acquisition-overview";
import type { TalentKpi } from "@/lib/hr/talent-acquisition-logic";

/**
 * What the identity strip needs. The same narrowed shape `HrCommandCenter` takes, deliberately —
 * the page resolves one identity and hands it to whichever of the two components it renders.
 */
export type TalentAcquisitionIdentity = {
  displayName: string;
  employeeCode: string | null;
  photoUrl: string | null;
  /** The seat's JOB TITLE, already resolved — never the raw permission key. */
  roleLabel: string;
};

/**
 * `HrTodayPanel` wants an icon per function key, and it holds no map of its own.
 *
 * Exhaustive over `HrFunctionKey` for the reason the generic page's copy is: a missing key is a
 * runtime crash on somebody's home page. Only `recruiting` is ever drawn here, because
 * `RECRUITING_TASK_KEYS` is the only set of tasks this page passes.
 */
const TASK_ICONS: Record<HrFunctionKey, LucideIcon> = {
  cv_lookup: FileSearch,
  employee_requests: LifeBuoy,
  engagement_retention: HeartPulse,
  hiring_paperwork: FileSignature,
  hr_communication: Mail,
  hr_governance: ShieldCheck,
  payroll_inputs: FileSpreadsheet,
  people_records: IdCard,
  performance_probation: Hourglass,
  recognition: Award,
  recruiting: BriefcaseBusiness,
  time_attendance: Fingerprint,
  workforce_context: Network,
  workforce_insight: Network,
};

/** The pendings panel the "Needs attention" button opens — named once so `aria-controls` and the
 *  panel's own `id` can never drift into a dangling reference. */
const PENDINGS_PANEL_ID = "ta-pendings";

/**
 * Tailwind cannot build a class name at runtime — `lg:grid-cols-${n}` is purged and silently
 * renders as one column. So the column counts are literals, looked up by tile count.
 */
const GRID_BY_COUNT: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
  6: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6",
  7: "sm:grid-cols-2 lg:grid-cols-4",
  8: "sm:grid-cols-2 lg:grid-cols-4",
  9: "sm:grid-cols-3 lg:grid-cols-3",
  10: "sm:grid-cols-2 lg:grid-cols-5",
};

/** A tile carrying a queue. Reuses the data layer's own tone rather than re-deciding urgency. */
function needsAttention(tile: HrCommandTile): boolean {
  return tile.tone === "amber" || tile.tone === "rose";
}

/**
 * The generic page's `MetricTile`, unchanged.
 *
 * Copied rather than imported because `hr-command-center.tsx` does not export it, and exporting it
 * from a 700-line client component to reach one tile would make this page's render depend on that
 * whole module's. The RESTING STATE is what must not drift — it matches Finance's pixel for pixel,
 * which is the owner's 2026-09-03 premium pass — so the class lists below are byte-identical to
 * that file's, and `tests/talent-acquisition-overview.test.ts` pins them against it.
 */
function MetricTile({ tile }: { tile: HrCommandTile }) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tile.tone];
  const toneBarClass = {
    amber: "bg-[linear-gradient(90deg,transparent_0%,#FBBF24_18%,#F59E0B_50%,#FBBF24_82%,transparent_100%)]",
    emerald: "bg-[linear-gradient(90deg,transparent_0%,#34D399_18%,#10B981_50%,#34D399_82%,transparent_100%)]",
    rose: "bg-[linear-gradient(90deg,transparent_0%,#FB7185_18%,#F43F5E_50%,#FB7185_82%,transparent_100%)]",
    slate: "bg-[linear-gradient(90deg,transparent_0%,#CBD5E1_20%,#94A3B8_50%,#CBD5E1_80%,transparent_100%)]",
  }[tile.tone];

  return (
    <Link
      className="group/tile relative min-h-32 border border-slate-200/90 bg-[linear-gradient(180deg,#FFFFFF_0%,#FDFEFF_55%,#F7F9FC_100%)] px-4 py-4 text-center shadow-[0_1px_2px_rgba(15,23,42,0.045)] transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-200 hover:bg-[linear-gradient(180deg,#FFFFFF_0%,#FFFFFF_100%)] hover:shadow-[0_14px_30px_rgba(15,23,42,0.11)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      href={tile.href}
    >
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-0.5 ${toneBarClass}`} />
      <ArrowUpRight
        aria-hidden="true"
        className="absolute right-2 top-2.5 h-3.5 w-3.5 text-orange-400 opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100"
      />
      <div className="text-[9px] font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
        {tile.label}
      </div>
      <p className={`mt-4 break-words text-3xl font-black leading-none tabular-nums ${toneClass}`}>
        {tile.valueLabel ?? tile.value.toLocaleString("en-US")}
      </p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
        {tile.sub}
      </p>
    </Link>
  );
}

/**
 * One of her handbook's measures.
 *
 * `ChartCard`'s frame — same border, same header gradient, same 11px black caps title, same footer
 * link — with a percentage where the plot would be. That is deliberate: a KPI and a chart are the
 * same kind of object on this page (a measure with a caption and a way in), and giving them two
 * different frames would make the page read as two pages.
 *
 * THE PERCENTAGE IS NEVER THE WHOLE ANSWER. Both halves are printed under it, named, because "72%"
 * on its own cannot be checked and "26 accepted of 36 offers answered" can. A null rate prints the
 * sentence instead and no figure at all — see the header.
 */
function KpiCard({ kpi }: { kpi: TalentKpi }) {
  const measured = kpi.rate !== null;

  return (
    <figure className="min-w-0 border border-slate-200 bg-white">
      <figcaption className="border-b border-slate-200/70 bg-gradient-to-b from-white to-slate-50/60 px-4 py-3">
        <span className="break-words text-[11px] font-black uppercase tracking-[0.14em] text-slate-950">
          {kpi.label}
        </span>
        <p className="mt-1.5 break-words text-[11px] font-medium leading-5 text-slate-500">
          {kpi.caption}
        </p>
      </figcaption>

      <div className="px-4 py-5">
        {measured ? (
          <>
            <p className="break-words text-4xl font-black leading-none tabular-nums text-slate-900">
              {Math.round((kpi.rate ?? 0) * 100)}%
            </p>
            {/* The two halves, named. A ratio nobody can check is a ratio nobody should trust. */}
            <p className="mt-3 break-words text-[11px] font-bold uppercase leading-relaxed tracking-[0.1em] text-slate-500">
              <span className="tabular-nums text-slate-900">
                {kpi.numerator.toLocaleString("en-US")}
              </span>{" "}
              {kpi.numeratorLabel} of{" "}
              <span className="tabular-nums text-slate-900">
                {kpi.denominator.toLocaleString("en-US")}
              </span>{" "}
              {kpi.denominatorLabel}
            </p>
          </>
        ) : (
          // Not 0%. A measure with no denominator has nothing to report, and reporting a zero is
          // the misleading figure this page's rules forbid.
          <p className="break-words text-[12px] font-semibold leading-relaxed text-slate-400">
            {kpi.emptyLabel}
          </p>
        )}
      </div>

      <div className="border-t border-slate-200/70 px-4 py-2.5">
        <Link
          className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-black uppercase tracking-[0.1em] text-orange-600 transition-colors hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          href={kpi.href}
        >
          {kpi.hrefLabel}
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      </div>
    </figure>
  );
}

/** A band header. The generic page's group header, minus the collapse — these are her job, not a
 *  list of functions, and a band she can fold away is a measure she can forget she has. */
function BandHeader({
  icon: Icon,
  id,
  summary,
  title,
}: {
  icon: LucideIcon;
  id: string;
  summary: string;
  title: string;
}) {
  return (
    <div
      className="flex items-start gap-3 border-b border-slate-200/70 bg-gradient-to-b from-white to-slate-50/60 px-5 py-4"
      id={id}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-orange-200 bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 shadow-[0_4px_10px_rgba(249,115,22,0.14)]">
        <Icon aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-950">
          {title}
        </h2>
        <p className="mt-1 break-words text-[11px] font-semibold leading-relaxed text-slate-500">
          {summary}
        </p>
      </div>
    </div>
  );
}

/**
 * Named rather than counted. A dashboard quietly short one figure reads as "nothing to do today",
 * which is the one wrong answer a queue of people waiting can give.
 */
function UnavailableNotice({ sources }: { sources: string[] }) {
  return (
    <div className="mx-5 mb-5 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
        Some figures could not be loaded and are not shown below:{" "}
        <span className="font-black">{sources.join(", ")}</span>. Everything else on this page is
        current.
      </p>
    </div>
  );
}

/**
 * The Hired tile's window, as a from/to pair.
 *
 * The generic page's picker, unchanged, for the same reason it exists there: the count is made on
 * the SERVER over every application the seat can see, not over a subset already on the page, so
 * changing the window has to reach the server. The query string also makes a chosen range
 * shareable and survivable across a reload, and "This month" is the absence of both params.
 */
function HiredWindowPicker({ window: current }: { window: { fromIso: string; toIso: string } }) {
  // The caller gives this a `key` built from the resolved window, so a window the server normalised
  // REMOUNTS it and the boxes re-seed from what was actually counted. Syncing props into state with
  // an effect would do the same job and is a lint ERROR in this repo.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [from, setFrom] = useState(current.fromIso);
  const [to, setTo] = useState(current.toIso);

  function apply(next: { from: string; to: string } | null) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next) {
      params.set("hiredFrom", next.from);
      params.set("hiredTo", next.to);
    } else {
      params.delete("hiredFrom");
      params.delete("hiredTo");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const isDefault = !searchParams?.get("hiredFrom") && !searchParams?.get("hiredTo");

  return (
    <div className="flex flex-wrap items-end gap-2 border-b border-slate-200/70 bg-slate-50/60 px-5 py-3">
      <span className="w-full text-[9px] font-black uppercase tracking-[0.14em] text-slate-500 sm:w-auto sm:self-center">
        Hired between
      </span>
      <label className="flex flex-col gap-1">
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">From</span>
        <input
          className={phxFieldClassName}
          onChange={(event) => setFrom(event.target.value)}
          type="date"
          value={from}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">To</span>
        <input
          className={phxFieldClassName}
          onChange={(event) => setTo(event.target.value)}
          type="date"
          value={to}
        />
      </label>
      <button
        className="border border-orange-300 bg-orange-50 px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-orange-700 transition-colors hover:bg-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        onClick={() => apply({ from, to })}
        type="button"
      >
        Apply
      </button>
      {isDefault ? null : (
        <button
          className="border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          onClick={() => apply(null)}
          type="button"
        >
          This month
        </button>
      )}
    </div>
  );
}

/** How often the open overview re-reads its figures from the server while the tab is in front. */
const OVERVIEW_REFRESH_MS = 60_000;

export function TalentAcquisitionOverview({
  data,
  identity,
}: {
  data: TalentAcquisitionOverviewData;
  /**
   * The signed-in seat, for the identity strip at the top. Resolved by the page from
   * `resolveViewerIdentityFromPage` — the same source the topbar chip reads, so the strip and the
   * chip can never disagree about whose account this is.
   */
  identity: TalentAcquisitionIdentity;
}) {
  const [showPendings, setShowPendings] = useState(false);

  // The page is rendered fresh on every load, but she leaves it open all day. Every figure on it —
  // the tiles, the pendings, the offers — is re-read from the server once a minute while the tab is
  // in front, and the moment she comes back to it. `router.refresh()` keeps what she has open (the
  // pendings panel, the calendar tab) and swaps only the server data.
  const refreshRouter = useRouter();
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refreshRouter.refresh();
    };
    const timer = window.setInterval(refreshIfVisible, OVERVIEW_REFRESH_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refreshRouter]);

  // One answer to "does anything need me", across every tile on the page — the same count the
  // generic page shows, reusing each tile's own tone rather than forming a second opinion on it.
  const attentionCount = data.field.tiles.filter(needsAttention).length;
  const pendingCount = data.tasks.reduce((total, task) => total + task.count, 0);

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      {/* ── THE IDENTITY STRIP. DO NOT TOUCH IT.
          *"donot touch photo or identity banner"* (owner, 2026-10-13), and before that *"do not
          touch, do not ever touch"* (2026-10-12). These four props are `HrCommandCenter`'s byte for
          byte, and the component's own height history — 120px on a phone, 160px from `sm`, raised by
          him on 09-04 and again on 2026-10-12 — is documented inside that file. Read it before
          quoting any older figure at anyone. ── */}
      <PhoenixIdentityStrip
        employeeCode={identity.employeeCode}
        name={identity.displayName}
        photoSrc={identity.photoUrl}
        title={identity.roleLabel}
      />

      <PushOptInNudge />

      {/* ── EVERY PENDING, BEHIND ONE BUTTON — his own ruling on this page type, 2026-10-13: "the
          needs attentions button is fair enough make it show all pendings when clicked on and
          remove the upper part". So the count is visible the moment the page opens, the work is one
          press away with every task already expanded (`openAll`), and nothing stands open above the
          figures.

          HER RECRUITING QUEUES ONLY. `RECRUITING_TASK_KEYS` in the data module is an allow-list, so
          the support desk cannot arrive here — "totally donot show employee requests". ── */}
      <div className="border-b border-slate-200/70 bg-white px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            aria-controls={PENDINGS_PANEL_ID}
            aria-expanded={showPendings}
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${
              showPendings
                ? "border-orange-300 bg-orange-50 text-orange-700"
                : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            }`}
            onClick={() => setShowPendings((previous) => !previous)}
            type="button"
          >
            <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
            Needs attention
            <span className="tabular-nums">({pendingCount})</span>
          </button>
          {/* The tile count is a SECOND signal and says so. It is the number of figures below
              carrying a queue, which is not the number of rows waiting — conflating the two is how
              a dashboard ends up with two different answers to one question. */}
          {attentionCount > 0 ? (
            <span className="whitespace-nowrap border border-orange-200 bg-orange-50 px-2 py-1.5 text-[9px] font-black uppercase tracking-[0.12em] text-orange-700">
              {attentionCount} {attentionCount === 1 ? "figure" : "figures"} to action
            </span>
          ) : null}
        </div>
      </div>

      {showPendings ? (
        <div id={PENDINGS_PANEL_ID}>
          <HrTodayPanel icons={TASK_ICONS} openAll tasks={data.tasks} />
        </div>
      ) : null}

      {data.unavailableSources.length > 0 ? (
        <UnavailableNotice sources={data.unavailableSources} />
      ) : null}

      {/* ── 1. HIRING QUALITY — her handbook's first KPI family ─────────────────────────────── */}
      {data.hiringQuality.length > 0 ? (
        <section className="border-t border-slate-100">
          <BandHeader
            icon={Gauge}
            id="hr-group-hiring-quality"
            summary="Managers get relevant candidates, and new hires pass their probation. Both measures are windowed, and both say what they divide by."
            title="Hiring quality"
          />
          <div
            className={`grid grid-cols-1 gap-3 p-5 ${
              data.hiringQuality.length > 1 ? "lg:grid-cols-2" : ""
            }`}
          >
            {data.hiringQuality.map((kpi) => (
              <KpiCard key={kpi.key} kpi={kpi} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── 2. OFFER CONVERSION — and the Job-offers chart he named ─────────────────────────── */}
      {data.offerConversion.length > 0 || data.offerChart ? (
        <section className="border-t border-slate-100">
          {/* The summary is her handbook's own sentence for this KPI family, and nothing else. It
              used to add "the same Job offers, by status he asked to keep" — which is provenance,
              not information: it means nothing to the person reading her own page, and
              `tests/neutral-wording.test.ts` was right to refuse a visible string that assumes its
              subject is a man. The provenance belongs in a comment like this one. */}
          <BandHeader
            icon={FileSignature}
            id="hr-group-offer-conversion"
            summary="The candidates you choose accept the offer and actually join."
            title="Offer conversion"
          />
          {/* His own words: "Job offers, by status". Rendered by `HrCommandCharts`, the same
              component the generic page uses, so it is the chart he already approved — same
              caption, same colours, same footer link — only moved up beside the two rates it
              explains. */}
          {data.offerChart ? <HrCommandCharts charts={[data.offerChart]} /> : null}
          {data.offerConversion.length > 0 ? (
            <div
              className={`grid grid-cols-1 gap-3 p-5 ${
                data.offerConversion.length > 1 ? "lg:grid-cols-2" : ""
              }`}
            >
              {data.offerConversion.map((kpi) => (
                <KpiCard key={kpi.key} kpi={kpi} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── 3. FILLING THE FIELD — responsibilities 01-04, and the pipeline chart he named ──── */}
      {data.field.tiles.length > 0 || data.field.charts.length > 0 ? (
        <section className="border-t border-slate-100">
          {/* Her handbook's responsibilities 01-04, verbatim and nothing else. The chart below is
              the "Live candidates, by pipeline stage" the owner named — provenance, which belongs
              in a comment and not in a sentence she reads, and which is also why
              `tests/neutral-wording.test.ts` refuses it as a visible string. */}
          <BandHeader
            icon={Target}
            id="hr-group-filling-the-field"
            summary="Recruit for the field, headhunt for the hard roles, build the pools and shortlist with care."
            title="Filling the field"
          />
          {/* The Hired tile is the one period figure on this page, so the window belongs here and
              nowhere else — every other tile counts how things stand right now. */}
          <HiredWindowPicker
            key={`${data.field.hiredWindow.fromIso}|${data.field.hiredWindow.toIso}`}
            window={data.field.hiredWindow}
          />
          <HrCommandCharts charts={data.field.charts} />
          {data.field.tiles.length > 0 ? (
            <div
              className={`grid grid-cols-2 gap-2 p-5 ${
                GRID_BY_COUNT[data.field.tiles.length] ?? "sm:grid-cols-2 lg:grid-cols-4"
              }`}
            >
              {data.field.tiles.map((tile) => (
                <MetricTile key={tile.key} tile={tile} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ── 4. THE LIVE CALENDAR — his second named block, and "all above" on what it shows ─── */}
      <TalentAcquisitionCalendar calendar={data.calendar} />

      {/* ── 5. Who is on a vacation today, by name (owner, 2026-09-29). Renders nothing at all
          when the source did not answer; see hr-on-vacation-today.tsx. ── */}
      <HrOnVacationToday rows={data.onVacationToday} />

      {/* ── 6. Her own record — the same card every HR seat carries since 2026-09-01. ── */}
      <HrMyRecord record={data.personal} />

      {/* A quiet footer naming the band order's source. Her handbook is the spec for this page, and
          a session that does not know that will "tidy" the bands back into permission order. */}
      <p className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-5 py-4 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
        <CalendarDays aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        Measures and order from the Talent Acquisition New Starter Handbook, SATO-DIS-2026-01 v1.0
      </p>
    </div>
  );
}
