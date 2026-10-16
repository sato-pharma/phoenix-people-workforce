"use client";

/**
 * The Talent Acquisition seat's landing page.
 *
 * WHOSE PAGE AND WHY IT IS NOT `HrCommandCenter`. Yomna Gamal, Talent Acquisition Specialist, first
 * day Sunday 18 October 2026. The owner's instruction on 13 October 2026: *"donot touch photo or
 * identity banner and from scratch build her overview landing page … totally donot show employee
 * requests"*, then, with her handbook attached, *"here is her job description and kpis tailor based
 * on this"*. Every other HR seat still renders `HrCommandCenter`, untouched — the route picks
 * between them on her bundle alone, so the blast radius of this file is one seat.
 *
 * REBUILT FROM SCRATCH ON 16 OCTOBER 2026. After a day of piecemeal fixes he called the page awful —
 * eight cards wrapping into two rows of four, two card styles, a gap between the rows, the Hired
 * window in the wrong place, too much empty space — and then asked for the whole page again,
 * "premium polish", never below 9.5 out of 10. His answers that evening are the spec:
 *
 *   1. The identity strip                          untouched, byte for byte
 *   2. The command rail                            Needs attention (+ overdue) · the Hired window
 *   3. The key cards, ONE container
 *        Conversion                                interview to offer · offer acceptance · offer to join
 *        Seats · Candidates · Outcomes             the eight figures, in THREE LABELLED GROUPS
 *   4. Today                                      today's interviews · joiners in 14 days · CVs today
 *   5. The calendar                               the real interview calendar, unchanged
 *   6. On a vacation today · My record            unchanged
 *
 * Every block below the strip takes its frame from `talent-acquisition/panel.tsx`, so there is one
 * card family, one caption style and one gap on the page — the exact thing he called awful was three
 * of each.
 *
 * WHAT IS GONE, AND STAYS GONE (owner, 2026-10-16, "remove duplicates", all four ticked): the
 * Offer conversion and Filling the field bands, the two charts whose every number is a card, the
 * second count beside Needs attention, and the awaiting-reply chip. Two handbook families (Retention
 * support, Employee connection) are deliberately not here: he was shown that neither has an honest
 * source for this seat and said to leave them off. Probation retention was removed the same day.
 *
 * THE IDENTITY STRIP IS NOT TO BE TOUCHED — *"donot touch photo or identity banner"*, and before
 * that, on 2026-10-12, *"do not touch, do not ever touch"*. The props below are the generic page's
 * byte for byte. Do not restyle it, do not wrap it, do not pass it a fifth prop.
 *
 * A RATE IS NEVER DRAWN AS A ZERO. `TalentKpi.rate` is null when there is nothing to divide by, and
 * the card then prints `emptyLabel` as a sentence and draws no meter.
 *
 * NEVER A HORIZONTAL SCROLL, SQUARE EDGES, NO ELLIPSIS (owner's golden rules). Every column count on
 * this page follows its CONTAINER (`@container` + `@min-[Npx]`), never the window, because the
 * sidebar eats a different amount at every size. Chips carry `whitespace-nowrap` and their ROW
 * wraps; prose is `break-words`; nothing is cut.
 */

import {
  ArrowUpRight,
  Award,
  BriefcaseBusiness,
  CalendarDays,
  DoorOpen,
  FileSearch,
  FileSignature,
  FileSpreadsheet,
  Fingerprint,
  Handshake,
  HeartPulse,
  Hourglass,
  IdCard,
  LifeBuoy,
  Mail,
  Network,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  adminHeroAccentBarClassName,
  adminHeroGlowAmberClassName,
  adminHeroGlowOrangeClassName,
  adminHeroGridOverlayClassName,
} from "@/components/admin/admin-design-tokens";
import { HrMyRecord } from "@/components/hr/hr-my-record";
import { HrOnVacationToday } from "@/components/hr/hr-on-vacation-today";
import { HrTodayPanel } from "@/components/hr/hr-today-panel";
import { TalentAcquisitionCalendar } from "@/components/hr/talent-acquisition-calendar";
import { TaCommandRail } from "@/components/hr/talent-acquisition/command-rail";
import { TaCvArrivals } from "@/components/hr/talent-acquisition/cv-arrivals";
import { TaJoinersArriving } from "@/components/hr/talent-acquisition/joiners-arriving";
import { TA_CAPS_CLASS, TaCaption } from "@/components/hr/talent-acquisition/panel";
import { TaTodayInterviews } from "@/components/hr/talent-acquisition/today-interviews";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import { PhoenixIdentityStrip } from "@/components/phoenix-signature-card/PhoenixIdentityStrip";
import type { HrFunctionKey } from "@/lib/auth/hr-functions";
import type { HrCommandTile } from "@/lib/hr/command-center";
import type { TalentAcquisitionOverviewData } from "@/lib/hr/talent-acquisition-overview";
import {
  groupRecruitingTiles,
  KPI_WINDOW_DAYS,
  longDayLabel,
  rateMeterPercent,
  type TalentKpi,
} from "@/lib/hr/talent-acquisition-logic";

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

/** The conversion key cards, in the order he named them (owner, 2026-10-16). */
const KEY_CARD_ORDER = ["interview-to-offer", "offer-acceptance", "offer-to-join"] as const;

/**
 * Class maps as LITERALS. Tailwind cannot build a class name at runtime, so `grid-cols-${n}` would be
 * purged and the grid would silently collapse to one column.
 *
 * `GROUP_GRID_BY_TOTAL` is the grid the three groups share once the container is wide enough for
 * every figure in ONE ROW (1120px — eight cards of ~130px; at 840px they were 109px and every label broke onto three lines, which he called awful on 2026-10-16), and `GROUP_SPAN_BY_COUNT` is how many of
 * those columns a group takes: one per card, so every card on the row is the same width whichever
 * group it is in ("two card styles", "eight cards wrap into two rows of four" — both fixed here).
 */
const GROUP_GRID_BY_TOTAL: Record<number, string> = {
  1: "@min-[1120px]:grid-cols-1",
  2: "@min-[1120px]:grid-cols-2",
  3: "@min-[1120px]:grid-cols-3",
  4: "@min-[1120px]:grid-cols-4",
  5: "@min-[1120px]:grid-cols-5",
  6: "@min-[1120px]:grid-cols-6",
  7: "@min-[1120px]:grid-cols-7",
  8: "@min-[1120px]:grid-cols-8",
  9: "@min-[1120px]:grid-cols-9",
  10: "@min-[1120px]:grid-cols-10",
};
const GROUP_SPAN_BY_COUNT: Record<number, string> = {
  1: "@min-[1120px]:col-span-1",
  2: "@min-[1120px]:col-span-2",
  3: "@min-[1120px]:col-span-3",
  4: "@min-[1120px]:col-span-4",
  5: "@min-[1120px]:col-span-5",
};
/** Inside one group: its cards side by side at every width, a fourth or fifth wrapping in pairs. */
const GROUP_CARDS_BY_COUNT: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 @min-[480px]:grid-cols-4",
  5: "grid-cols-2 @min-[480px]:grid-cols-5",
};
/**
 * The conversion row: its cards side by side once the band holds 600px. Each card lies down, so a
 * card narrower than ~200px would push its halves onto three lines and grow the band past the air.
 */
const KEY_CARDS_BY_COUNT: Record<number, string> = {
  1: "",
  2: "@min-[400px]:grid-cols-2",
  3: "@min-[600px]:grid-cols-3",
};

/**
 * Shared by every card on the page — the hover lift, the clipping of its watermark and the focus
 * ring. The SURFACE is each card's own: a figure card is white with its group's wash, a key card is
 * glass on the dark scoreboard; and so is the DIRECTION — a key card is a row on a phone.
 */
const CARD_MOTION_CLASS =
  "group/tile relative flex min-w-0 overflow-hidden transition-all duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500";

/** The scoreboard's watermark icons, one per conversion measure. */
const KPI_ICONS: Record<string, LucideIcon> = {
  "interview-to-offer": Handshake,
  "offer-acceptance": FileSignature,
  "offer-to-join": DoorOpen,
};

/**
 * One of the eight recruiting figures, standing eight across (owner, 2026-10-16).
 *
 * REBUILT ON HIS OWN DASHBOARD'S CARD after he called the dressed version "awful" the same evening
 * (five different tone bars across one row, a wash on every card, a medallion over every label and a
 * watermark icon under the text) and said "audit the b-10 dashboard and take ideas from it in
 * design". So this is `HrCommandCenter`'s `MetricTile`: the centred axis, the tracked caps label, the
 * big `text-3xl` figure with air above it, the faded top edge, the arrow that appears on hover, no
 * icons and no watermark — with the edge in Phoenix orange on every card ("stick to phx identity"),
 * so the only thing that differs from card to card is the figure's own colour, which is its meaning
 * (amber waiting, rose a problem, emerald good). Every word wraps; nothing is ever cut.
 */
function MetricTile({ tile }: { tile: HrCommandTile }) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tile.tone];
  return (
    <Link
      aria-label={`${tile.label}: ${tile.valueLabel ?? tile.value.toLocaleString("en-US")}, ${tile.sub}`}
      className={`${CARD_MOTION_CLASS} min-h-32 flex-col items-center border border-slate-200/90 bg-[linear-gradient(180deg,#FFFFFF_0%,#FFFDFB_55%,#FBF8F4_100%)] px-3 py-4 text-center shadow-[0_1px_2px_rgba(15,23,42,0.045)] hover:border-orange-200 hover:bg-[linear-gradient(180deg,#FFFFFF_0%,#FFFFFF_100%)] hover:shadow-[0_14px_30px_rgba(15,23,42,0.11)]`}
      href={tile.href}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.5 bg-[linear-gradient(90deg,transparent_0%,#FDBA74_18%,#F97316_50%,#FDBA74_82%,transparent_100%)]"
      />
      <ArrowUpRight
        aria-hidden="true"
        className="absolute right-2 top-2.5 h-3.5 w-3.5 text-orange-400 opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100"
      />
      {/* The label sits in a box two lines tall, so a one-line label and a wrapped one put their
          figures on the SAME line across the row. */}
      <span className="flex min-h-[23px] items-center break-words text-[9px] font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
        {tile.label}
      </span>
      <span className={`mt-3 break-words text-3xl font-black leading-none tabular-nums ${toneClass}`}>
        {tile.valueLabel ?? tile.value.toLocaleString("en-US")}
      </span>
      <span className="mt-2 break-words text-[10px] font-bold uppercase leading-snug tracking-[0.12em] text-slate-400">
        {tile.sub}
      </span>
    </Link>
  );
}

/**
 * One of her handbook's conversion measures, drawn as a KEY CARD (owner, 2026-10-16) on the dark
 * SCOREBOARD — the one dark band on her page, in the Phoenix hero's own black and ember, so the
 * three numbers she is measured on are the first thing the eye lands on under her name.
 *
 * Glass on black: the percentage in white, the "%" and the label in Phoenix orange, a square meter
 * filling in orange so the rate reads at a glance from across the room, and both halves named under
 * it — because "72%" on its own cannot be checked and "26 accepted of 36 answered" can. The caption
 * is the card's tooltip and part of its accessible name: it carries the honest part ("the figure
 * counts the joining form, not the joining"), so it is moved and never dropped. The measure's icon
 * stands large and faint in the corner as a watermark.
 *
 * A null rate prints the sentence and draws NO meter — see the header.
 *
 * IT LIES DOWN, AT EVERY WIDTH (owner, 2026-10-16: "fit the keycards where i marked" — the air
 * beside her portrait, under the notice rail, about 116px tall at a 1440px window). A standing card
 * is ~130px before its band's header, so the figure stands at the LEFT and the label, the meter and
 * the named halves at its right — one compact row per measure, three rows side by side once the band
 * holds 600px, stacked under that.
 */
function KpiCard({ kpi }: { kpi: TalentKpi }) {
  const measured = kpi.rate !== null;
  const meter = rateMeterPercent(kpi.rate);
  const Icon = KPI_ICONS[kpi.key];

  return (
    <Link
      aria-label={`${kpi.label}. ${kpi.caption} ${kpi.hrefLabel}.`}
      className={`${CARD_MOTION_CLASS} flex-row items-center gap-3 border border-white/10 bg-[linear-gradient(160deg,rgba(255,255,255,0.09)_0%,rgba(255,255,255,0.025)_100%)] px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-sm hover:border-orange-400/60 hover:bg-[linear-gradient(160deg,rgba(255,255,255,0.13)_0%,rgba(255,255,255,0.04)_100%)] hover:shadow-[0_14px_32px_rgba(0,0,0,0.35)]`}
      href={kpi.href}
      title={kpi.caption}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.5 bg-[linear-gradient(90deg,transparent_0%,#FDBA74_18%,#F97316_50%,#FDBA74_82%,transparent_100%)]"
      />
      {Icon ? (
        <Icon
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-3 -right-2 h-14 w-14 text-white opacity-[0.06] transition-opacity duration-200 group-hover/tile:opacity-[0.11]"
          strokeWidth={1}
        />
      ) : null}
      <ArrowUpRight
        aria-hidden="true"
        className="absolute right-1.5 top-1.5 h-3 w-3 text-orange-300 opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100"
      />
      {measured ? (
        <span className="relative w-[4.5rem] shrink-0 break-words text-[2rem] @min-[880px]:w-[4.75rem] font-black leading-none tracking-[-0.02em] tabular-nums text-white [text-shadow:0_2px_18px_rgba(249,115,22,0.35)]">
          {Math.round((kpi.rate ?? 0) * 100)}
          <span className="text-[1.1rem] text-orange-300">%</span>
        </span>
      ) : null}
      <span className="relative flex min-w-0 flex-1 flex-col">
        <span className="text-[9.5px] font-black uppercase leading-tight tracking-[0.16em] text-orange-200">
          {kpi.label}
        </span>
        {measured ? (
          <>
            {meter !== null ? (
              <span aria-hidden="true" className="relative mt-1.5 block h-1 w-full border border-white/10 bg-white/10">
                <span
                  className="block h-full bg-[linear-gradient(90deg,#F97316_0%,#FDBA74_100%)] shadow-[0_0_12px_rgba(249,115,22,0.6)]"
                  style={{ width: `${meter}%` }}
                />
              </span>
            ) : null}
            {/* The two halves, named. A ratio nobody can check is a ratio nobody should trust. */}
            <span className="relative mt-1 break-words text-[9px] font-bold uppercase leading-snug tracking-[0.08em] text-slate-400">
              <span className="tabular-nums text-white">{kpi.numerator.toLocaleString("en-US")}</span>{" "}
              {kpi.numeratorLabel} of{" "}
              <span className="tabular-nums text-white">{kpi.denominator.toLocaleString("en-US")}</span>{" "}
              {kpi.denominatorLabel}
            </span>
          </>
        ) : (
          // Not 0%. A measure with no denominator has nothing to report, and reporting a zero is
          // the misleading figure this page's rules forbid.
          <span className="relative mt-1 break-words text-[10.5px] font-semibold leading-snug text-slate-300">
            {kpi.emptyLabel}
          </span>
        )}
      </span>
    </Link>
  );
}

/**
 * Named rather than counted. A dashboard quietly short one figure reads as "nothing to do today",
 * which is the one wrong answer a queue of people waiting can give.
 */
function UnavailableNotice({ sources }: { sources: string[] }) {
  return (
    <div className="mx-5 mt-4 flex items-start gap-3 border border-amber-200 bg-amber-50 px-4 py-3">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
        Some figures could not be loaded and are not shown below:{" "}
        <span className="font-black">{sources.join(", ")}</span>. Everything else on this page is
        current.
      </p>
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
  // the cards, the pendings, today's panels — is re-read from the server once a minute while the tab
  // is in front, and the moment she comes back to it. `router.refresh()` keeps what she has open
  // (the pendings panel, the calendar tab) and swaps only the server data.
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

  const pendingCount = data.tasks.reduce((total, task) => total + task.count, 0);
  const overdueCount = data.tasks
    .filter((task) => task.urgency === "overdue")
    .reduce((total, task) => total + task.count, 0);

  // Picked out of the two handbook families by KEY, in the order he named them, so an unreadable
  // source simply leaves its card out of the row instead of shifting another card into its place.
  const keyCards = KEY_CARD_ORDER.map((key) =>
    [...data.hiringQuality, ...data.offerConversion].find((one) => one.key === key),
  ).filter((one): one is TalentKpi => Boolean(one));
  const groups = groupRecruitingTiles(data.field.tiles);
  const groupedTotal = groups.reduce((total, group) => total + group.tiles.length, 0);
  const showCvPanel = data.cvToday.status !== "hidden";

  /**
   * ── 1b. CONVERSION — THE SCOREBOARD, standing IN THE AIR BESIDE HER PORTRAIT, under the notice
   * rail (owner, 2026-10-16, circling that air: "fit the keycards where i marked"). The one dark band
   * on her page: the Phoenix hero's black deepening into ember, the platform hero's grid and glows,
   * light falling across its top edge — so it reads as the identity bar continuing, and the three
   * numbers she is measured on sit level with her name. Sized to the reserve: one header line and
   * three lying-down cards; it fills the column, so a taller reserve (a wider window) gives it air,
   * never a gap under it. On a phone there is no portrait and it stands under the rail full width.
   */
  const conversionBand =
    keyCards.length > 0 ? (
      <section
        aria-label="Conversion"
        className="relative flex flex-auto shrink-0 flex-col overflow-hidden border border-[#1a1a1a] bg-[linear-gradient(135deg,#000000_0%,#070707_55%,#1C0E02_100%)] px-3 pb-2.5 pt-2 shadow-[0_10px_28px_rgba(0,0,0,0.22)]"
      >
        <span aria-hidden="true" className={adminHeroGridOverlayClassName} />
        <span aria-hidden="true" className={adminHeroGlowOrangeClassName} />
        <span aria-hidden="true" className={adminHeroGlowAmberClassName} />
        <span aria-hidden="true" className={adminHeroAccentBarClassName} />
        <div className="@container relative flex flex-auto shrink-0 flex-col">
          <div className="mb-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 rotate-45 bg-orange-500" />
            <span className={`${TA_CAPS_CLASS} text-white`}>Conversion</span>
            <span className="break-words text-[10px] font-semibold text-slate-300">
              Last {KPI_WINDOW_DAYS} days · each figure names what it divides by
            </span>
          </div>
          <div className={`grid flex-auto shrink-0 grid-cols-1 gap-2 ${KEY_CARDS_BY_COUNT[keyCards.length] ?? ""}`}>
            {keyCards.map((kpi) => (
              <KpiCard key={kpi.key} kpi={kpi} />
            ))}
          </div>
        </div>
      </section>
    ) : null;

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden">
      {/* ── THE IDENTITY STRIP. DO NOT TOUCH IT.
          *"donot touch photo or identity banner"* (owner, 2026-10-13), and before that *"do not
          touch, do not ever touch"* (2026-10-12). Its four identity props are `HrCommandCenter`'s
          byte for byte, and the component's own height history — 120px on a phone, 160px from `sm`,
          raised by him on 09-04 and again on 2026-10-12 — is documented inside that file. The ONE
          addition is `reserve`, his own instruction (2026-10-16, "fit the keycards where i marked"):
          the Conversion band stands in the air beside the portrait. ── */}
      <PhoenixIdentityStrip
        employeeCode={identity.employeeCode}
        name={identity.displayName}
        photoSrc={identity.photoUrl}
        reserve={conversionBand}
        title={identity.roleLabel}
      />

      <PushOptInNudge />

      {/* ── 2. THE COMMAND RAIL — every pending behind ONE button (his ruling, 2026-10-13: "the needs
          attentions button is fair enough make it show all pendings when clicked on and remove the
          upper part"), and the Hired card's window at its right.

          HER RECRUITING QUEUES ONLY. `RECRUITING_TASK_KEYS` in the data module is an allow-list, so
          the support desk cannot arrive here — "totally donot show employee requests". ── */}
      <TaCommandRail
        hiredWindow={groups.some((group) => group.tiles.some((tile) => tile.key === "hired")) ? data.field.hiredWindow : null}
        onToggle={() => setShowPendings((previous) => !previous)}
        open={showPendings}
        overdueCount={overdueCount}
        panelId={PENDINGS_PANEL_ID}
        pendingCount={pendingCount}
      />

      {showPendings ? (
        <div id={PENDINGS_PANEL_ID}>
          <HrTodayPanel icons={TASK_ICONS} openAll tasks={data.tasks} />
        </div>
      ) : null}

      {data.unavailableSources.length > 0 ? (
        <UnavailableNotice sources={data.unavailableSources} />
      ) : null}

      {/* ── 3 + 4. THE FIGURES AND TODAY, ON ONE WARM GROUND. One container, one gap, one card
          family — what he called awful on 2026-10-16 was two of each. ── */}
      <div className="@container relative overflow-hidden border-b border-slate-200/70 bg-[linear-gradient(180deg,#FFFFFF_0%,#FAF8F5_100%)] px-5 pb-6 pt-5">
        {/* The page ground: two soft Phoenix glows behind the cards — orange at the left, amber at
            the right — and a faint square grid, so the white is a lit surface rather than an empty
            one. Phoenix tones only (owner, 2026-10-16: "stick to phx identity"). All texture:
            aria-hidden, no hit target, no radius (at this blur a square and a circle are one shape). */}
        <span aria-hidden="true" className="pointer-events-none absolute -left-32 top-72 h-80 w-80 bg-orange-300/20 blur-[110px]" />
        <span aria-hidden="true" className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 bg-amber-300/20 blur-[110px]" />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(rgba(148,163,184,.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,.12)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:linear-gradient(180deg,transparent_0%,black_30%,black_70%,transparent_100%)]"
        />
        <div className="relative grid gap-5">
          {/* ── 3b. THE EIGHT FIGURES, IN THREE LABELLED GROUPS (owner, 2026-10-16: "Three labelled
              groups"): Seats · Candidates · Outcomes. Stacked group by group below 1120px of
              container, and every card in ONE ROW from there, each group spanning one column per
              card so all eight are the same width. ── */}
          {groups.length > 0 ? (
            <div className={`grid grid-cols-1 gap-x-2 gap-y-4 ${GROUP_GRID_BY_TOTAL[groupedTotal] ?? ""}`}>
              {groups.map((group) => (
                <section
                  aria-label={group.label}
                  className={`flex min-w-0 flex-col ${GROUP_SPAN_BY_COUNT[group.tiles.length] ?? ""}`}
                  key={group.key}
                >
                  <TaCaption caption={group.caption} label={group.label} />
                  <div className={`grid flex-1 gap-2 ${GROUP_CARDS_BY_COUNT[group.tiles.length] ?? "grid-cols-2"}`}>
                    {group.tiles.map((tile) => (
                      <MetricTile key={tile.key} tile={tile} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}

          {/* ── 4. TODAY — the three panels he chose on 2026-10-16. Two across from 720px of
              container and three from 1080px; the CV panel takes the full second row when there
              are two columns, so no panel ever stands alone beside a blank half. ── */}
          <section aria-label="Today">
            <TaCaption caption={longDayLabel(data.calendar.todayKey)} label="Today" />
            <div
              className={`grid grid-cols-1 items-stretch gap-3 @min-[720px]:grid-cols-2 ${
                showCvPanel ? "@min-[1080px]:grid-cols-3" : ""
              }`}
            >
              <TaTodayInterviews today={data.today} />
              <TaJoinersArriving joiners={data.joiners} />
              {showCvPanel ? (
                <TaCvArrivals className="@min-[720px]:col-span-2 @min-[1080px]:col-span-1" cvToday={data.cvToday} />
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {/* ── 5. THE LIVE CALENDAR — the real interview calendar, mounted, never imitated ── */}
      <TalentAcquisitionCalendar calendar={data.calendar} />

      {/* ── 6. Who is on a vacation today, by name (owner, 2026-09-29). Renders nothing at all
          when the source did not answer; see hr-on-vacation-today.tsx. ── */}
      <HrOnVacationToday rows={data.onVacationToday} />

      {/* ── 7. Her own record — the same card every HR seat carries since 2026-09-01. ── */}
      <HrMyRecord record={data.personal} />

      {/* A quiet footer naming the measures' source. Her handbook is the spec for this page, and a
          session that does not know that will "tidy" the figures back into permission order. */}
      <p
        className={`flex flex-wrap items-center gap-1.5 border-t border-slate-100 px-5 py-4 ${TA_CAPS_CLASS} text-slate-400`}
      >
        <CalendarDays aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        Measures and order from the Talent Acquisition New Starter Handbook, SATO-DIS-2026-01 v1.0
      </p>
    </div>
  );
}
