import Link from "next/link";
import { CalendarCheck, CalendarClock, CircleSlash, Target, UserCheck, UserMinus, UserX } from "lucide-react";

import {
  planAdherenceTone,
  planAdherenceVerdictLabel,
  type PlanAdherenceHistory,
  type PlanAdherenceItem,
  type PlanAdherenceScore,
  type PlanAdherenceVerdict,
} from "@/lib/weekly-planning/plan-adherence";

// The screen behind the score. Pure render (no client hooks) — usable directly inside the
// server-rendered plan detail page, exactly as plan-summary.tsx is.
//
// THE POINT OF THIS FILE IS THE SECOND HALF, NOT THE NUMBER. The owner asked to be told "where is
// the mismatch and how to keep his score a hundred percent" — so every miss is shown with its day,
// the person it involved, and one plain instruction. A percentage on its own is a scolding.

const VERDICT_ICON: Record<PlanAdherenceVerdict, typeof CalendarCheck> = {
  kept: CalendarCheck,
  no_trace: CircleSlash,
  not_checkable: CircleSlash,
  not_yet_due: CalendarClock,
  partner_alone: UserMinus,
  // UserCheck, not UserX: a swap counts as kept, and an X beside a day that earned full credit
  // reads as a reprimand.
  wrong_partner: UserCheck,
};

const VERDICT_TONE: Record<PlanAdherenceVerdict, string> = {
  kept: "border-emerald-200 bg-emerald-50 text-emerald-800",
  no_trace: "border-rose-200 bg-rose-50 text-rose-800",
  not_checkable: "border-slate-200 bg-slate-50 text-slate-600",
  not_yet_due: "border-sky-200 bg-sky-50 text-sky-700",
  partner_alone: "border-orange-200 bg-orange-50 text-orange-800",
  // Teal, not amber: distinguishable from a plain `kept` day at a glance, but on the credited side
  // of the palette rather than the warning side.
  wrong_partner: "border-teal-200 bg-teal-50 text-teal-800",
};

/**
 * The order the misses are worth reading in — most fixable first.
 *
 * `wrong_partner` is NOT here. It counts as kept (owner's rule, 2026-08-28), so listing it among
 * the things to fix would contradict the number directly above it.
 */
const MISS_ORDER: readonly PlanAdherenceVerdict[] = ["partner_alone", "no_trace"];

function dayLabel(dateIso: string | null): string {
  if (!dateIso) return "No date";
  const date = new Date(`${dateIso}T00:00:00Z`);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC", weekday: "short" });
}

/**
 * Link building takes a BASE STRING, never a `(planId) => href` callback.
 *
 * A callback reads more flexible and is why this file first went red: `plan-approvals-body.tsx` is
 * a server component and `ApprovalsWorkspace` is a client one, so the function could not be
 * serialised and the page 500s at render with "Functions cannot be passed directly to Client
 * Components" — the same crash that took out Doctor Coverage. A string crosses that boundary
 * safely from anywhere, so no future call site can reintroduce it.
 */
function planDetailHref(baseHref: string, planId: string): string {
  return `${baseHref.replace(/\/+$/, "")}/${encodeURIComponent(planId)}`;
}

/**
 * The score as a chip, for a plan row or a page header.
 *
 * Renders "Not measured" rather than a number when the plan held nothing the CRM can confirm —
 * never a 0. Production has 15 such weekly plans out of 92, and one manager whose every plan is in
 * that state: shown as 0% she would read as the worst performer in the company for planning office
 * days.
 */
export function PlanAdherenceBadge({
  score,
  href,
}: {
  score: Pick<PlanAdherenceScore, "checkable" | "kept" | "measurable" | "scorePct">;
  href?: string;
}) {
  const body = score.measurable ? (
    <>
      <Target className="h-3.5 w-3.5" />
      <span className={`font-black tabular-nums ${planAdherenceTone(score.scorePct)}`}>{score.scorePct}%</span>
      <span className="font-bold text-slate-500 tabular-nums">
        {score.kept}/{score.checkable} kept
      </span>
    </>
  ) : (
    <>
      <CircleSlash className="h-3.5 w-3.5 text-slate-400" />
      <span className="font-bold text-slate-500">Not measured</span>
    </>
  );

  const className =
    "inline-flex items-center gap-1.5 whitespace-nowrap border border-slate-200 bg-white px-2.5 py-1 text-xs";

  if (!href) return <span className={className}>{body}</span>;
  return (
    <Link href={href} className={`${className} transition-colors hover:border-orange-300 hover:bg-orange-50`}>
      {body}
    </Link>
  );
}

/**
 * The overview-dashboard card. One click reaches the plan that produced the number.
 *
 * The whole card is the link, not a "view details" affordance tucked in a corner — the owner's ask
 * was that pressing the score takes you to where the mismatch is, and a score you cannot press is
 * the thing he was replacing.
 */
export function PlanAdherenceDashboardCard({
  adherence,
  planBaseHref,
}: {
  adherence: {
    averagePct: number | null;
    latest: { checkable: number; kept: number; measurable: boolean; periodKey: string; planId: string; scorePct: number | null } | null;
    measuredPeriods: number;
  };
  planBaseHref: string;
}) {
  const latest = adherence.latest;
  if (!latest) return null;

  const headline = latest.measurable ? `${latest.scorePct}%` : "Not measured";
  const sub = latest.measurable
    ? `${latest.periodKey} · ${latest.kept} of ${latest.checkable} kept`
    : `${latest.periodKey} · nothing in it the CRM can check`;

  return (
    <Link
      href={planDetailHref(planBaseHref, latest.planId)}
      className="group relative block overflow-hidden border border-slate-200 bg-white px-4 py-4 transition-colors hover:border-orange-300 hover:bg-orange-50/40 sm:px-5 sm:py-5"
    >
      <span className="absolute inset-x-0 top-0 h-[3px] bg-[#f47b20]" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-slate-900 text-white transition-colors group-hover:bg-orange-600">
            <Target className="h-3.5 w-3.5" />
          </span>
          <p className="whitespace-nowrap text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">
            My plan score
          </p>
        </div>
        {adherence.averagePct != null ? (
          <p className="whitespace-nowrap text-phx-xs font-bold text-slate-500 tabular-nums">
            {adherence.averagePct}% across {adherence.measuredPeriods} period{adherence.measuredPeriods === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>
      <p
        className={`mt-3 break-words text-xl font-black leading-tight tabular-nums sm:text-2xl ${
          latest.measurable ? planAdherenceTone(latest.scorePct) : "text-slate-400"
        }`}
      >
        {headline}
      </p>
      {/* whitespace-nowrap, never `truncate`: Tailwind's truncate IS an ellipsis, and text is never
          ellipsised in this product. The longest this line gets is
          "2026-W34 · nothing in it the CRM can check", which fits the card at 375px. */}
      <p className="whitespace-nowrap text-phx-xs font-medium text-slate-500">{sub}</p>
      <p className="mt-1 whitespace-nowrap text-phx-xs font-bold text-orange-600 group-hover:text-orange-700">
        See where the plan and the CRM disagree →
      </p>
    </Link>
  );
}

function ItemRow({ item }: { item: PlanAdherenceItem }) {
  const Icon = VERDICT_ICON[item.verdict];
  return (
    <li className="flex flex-col gap-1 border-b border-slate-100 px-4 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="whitespace-nowrap text-xs font-black tabular-nums text-slate-900">{dayLabel(item.activityDate)}</span>
        <span
          className={`inline-flex items-center gap-1.5 whitespace-nowrap border px-2 py-0.5 text-phx-xs font-bold ${VERDICT_TONE[item.verdict]}`}
        >
          <Icon className="h-3 w-3" />
          {planAdherenceVerdictLabel(item.verdict)}
        </span>
        <span className="whitespace-nowrap text-xs font-semibold text-slate-600">{item.activityType}</span>
        {item.plannedPartnerName ? (
          <span className="whitespace-nowrap text-xs text-slate-500">Planned with {item.plannedPartnerName}</span>
        ) : null}
        {item.actualPartnerNames.length > 0 ? (
          <span className="whitespace-nowrap text-xs font-semibold text-amber-700">
            Actually with {item.actualPartnerNames.join(", ")}
          </span>
        ) : null}
      </div>
      {item.advice ? <p className="text-xs leading-relaxed text-slate-600">{item.advice}</p> : null}
    </li>
  );
}

/**
 * "Where is the mismatch, and how do I get to 100%."
 *
 * Kept items are counted but not listed — a manager reading this wants the exceptions, and a list
 * of everything he did right buries them. What is NOT hidden is the untracked count: office days,
 * meetings and vacation are named and explained rather than silently dropped, because a number that
 * quietly ignores half a plan is the kind a person stops trusting the first time they check it.
 */
export function PlanAdherenceReport({ score }: { score: PlanAdherenceScore }) {
  const misses = MISS_ORDER.flatMap((verdict) => score.items.filter((item) => item.verdict === verdict));
  const upcoming = score.items.filter((item) => item.verdict === "not_yet_due");
  // Shown, but never under "to fix" — these earned their credit.
  const swaps = score.items.filter((item) => item.verdict === "wrong_partner");

  return (
    <section className="border border-phx-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Did the plan hold up</h3>
        {score.measurable ? (
          <span className="whitespace-nowrap text-phx-xs font-bold text-white/70">
            {score.kept} of {score.checkable} checked against the CRM
          </span>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-4 border-b border-slate-100 px-4 py-4">
        {score.measurable ? (
          <p className={`text-3xl font-black leading-none tabular-nums ${planAdherenceTone(score.scorePct)}`}>
            {score.scorePct}%
          </p>
        ) : (
          <p className="text-lg font-black leading-none text-slate-400">Not measured</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {score.measurable ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800">
              <CalendarCheck className="h-3.5 w-3.5" />
              {score.kept} kept
            </span>
          ) : null}
          {swaps.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs font-bold text-teal-800">
              <UserCheck className="h-3.5 w-3.5" />
              {swaps.length} partner {swaps.length === 1 ? "swap" : "swaps"}, counted as kept
            </span>
          ) : null}
          {misses.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-bold text-rose-800">
              <UserX className="h-3.5 w-3.5" />
              {misses.length} to fix
            </span>
          ) : null}
          {score.notYetDue > 0 ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-700">
              <CalendarClock className="h-3.5 w-3.5" />
              {score.notYetDue} still to come
            </span>
          ) : null}
          {score.notCheckable > 0 ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-600">
              <CircleSlash className="h-3.5 w-3.5" />
              {score.notCheckable} not tracked in CRM
            </span>
          ) : null}
        </div>
      </div>

      {/* The one sentence that has to be here. A manager who reads "Not measured" and no explanation
          will assume the system is broken; a manager who reads 100% wants to know it was earned. */}
      <p className="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-xs leading-relaxed text-slate-600">
        {score.measurable
          ? misses.length === 0
            ? `Every field day and double visit in this plan is confirmed by the CRM.${
                swaps.length > 0
                  ? ` ${swaps.length === 1 ? "One day" : `${swaps.length} days`} went ahead with a different colleague, which counts as kept — you were out on the day you committed to.`
                  : ""
              }`
            : `The score counts field days and double visits only, because those are the ones the CRM can confirm. ${misses.length} of ${score.checkable} did not happen — each one below says what happened and what to do about it.${
                swaps.length > 0
                  ? ` A further ${swaps.length === 1 ? "day went" : `${swaps.length} days went`} ahead with a different colleague; those count as kept and are listed for the record only.`
                  : ""
              }`
          : `Nothing in this plan can be checked against the CRM — office days, meetings, training and vacation leave no visit record. That is not a low score, it is no score, and it counts neither for nor against anyone.`}
      </p>

      {misses.length > 0 ? (
        <ul>
          {misses.map((item) => (
            <ItemRow key={item.id} item={item} />
          ))}
        </ul>
      ) : null}

      {/* Separately headed, below the misses. A swap is information, not a task — putting it in the
          same list would make a manager read it as something he owes an answer for. */}
      {swaps.length > 0 ? (
        <>
          <p className="border-y border-slate-100 bg-white px-4 py-2 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
            Went ahead with someone else — counted as kept
          </p>
          <ul>
            {swaps.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      ) : null}

      {upcoming.length > 0 ? (
        <div className="border-t border-slate-100">
          <p className="px-4 pb-1 pt-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
            Still to come — not counted yet
          </p>
          <ul>
            {upcoming.map((item) => (
              <ItemRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * One person's score, week by week — the extra approvals tab.
 *
 * The average is weighted by items rather than a mean of the weekly percentages, so a week holding
 * one double visit cannot outweigh a week holding twelve.
 */
export function PlanAdherenceHistoryPanel({
  history,
  planBaseHref,
  emptyLabel = "No scored plans yet.",
}: {
  history: PlanAdherenceHistory;
  planBaseHref?: string | null;
  emptyLabel?: string;
}) {
  if (history.entries.length === 0) {
    return <p className="border border-phx-line bg-white px-4 py-8 text-center text-sm text-slate-500">{emptyLabel}</p>;
  }

  return (
    <section className="border border-phx-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-slate-900 px-4 py-2.5">
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Plan score history</h3>
        <span className="whitespace-nowrap text-phx-xs font-bold text-white/70">
          {history.averagePct == null
            ? "No measured period yet"
            : `${history.averagePct}% across ${history.measuredPeriods} measured period${history.measuredPeriods === 1 ? "" : "s"}`}
        </span>
      </header>

      <ul>
        {history.entries.map((entry) => {
          const label = (
            <>
              <span className="whitespace-nowrap text-sm font-black text-slate-900">{entry.periodKey}</span>
              <span className="whitespace-nowrap text-xs text-slate-500">
                {dayLabel(entry.periodStartDate)} – {dayLabel(entry.periodEndDate)}
              </span>
            </>
          );
          return (
            <li key={entry.planId} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                {planBaseHref ? (
                  <Link href={planDetailHref(planBaseHref, entry.planId)} className="flex flex-wrap items-center gap-2 hover:text-orange-700">
                    {label}
                  </Link>
                ) : (
                  label
                )}
              </div>
              <div className="flex items-center gap-3">
                {entry.measurable ? (
                  <>
                    <span className="hidden h-1.5 w-28 overflow-hidden bg-slate-100 sm:block">
                      <span
                        className={`block h-full ${
                          (entry.scorePct ?? 0) >= 100
                            ? "bg-emerald-500"
                            : (entry.scorePct ?? 0) >= 90
                              ? "bg-amber-400"
                              : (entry.scorePct ?? 0) >= 70
                                ? "bg-orange-500"
                                : "bg-rose-500"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, entry.scorePct ?? 0))}%` }}
                      />
                    </span>
                    <span className="whitespace-nowrap text-xs font-bold tabular-nums text-slate-500">
                      {entry.kept}/{entry.checkable}
                    </span>
                    <span className={`whitespace-nowrap text-sm font-black tabular-nums ${planAdherenceTone(entry.scorePct)}`}>
                      {entry.scorePct}%
                    </span>
                  </>
                ) : (
                  <span className="whitespace-nowrap text-xs font-bold text-slate-400">Not measured</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
