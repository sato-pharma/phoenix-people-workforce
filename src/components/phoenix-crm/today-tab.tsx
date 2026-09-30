"use client";

import { CalendarDays, Check, Plus } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

import { brickTintMap, type BrickTint } from "@/components/phoenix-crm/brick-tints";
import { crmUrl, useCrmGet } from "@/components/phoenix-crm/api";
import { countText, dayLabelLong } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import {
  CrmBlock,
  CrmButton,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { brickLabel, NO_BRICK_KEY } from "@/lib/phoenix-crm/brick-groups";
import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import {
  nextStop,
  stopWhereLine,
  todayByBrick,
  visitDayMinute,
  type NextStop,
  type NextStopState,
  type TodayStop,
} from "@/lib/phoenix-crm/today-rules";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import { unplannedKindLabel } from "@/lib/phoenix-crm/unplanned-rules";
import type { TodayView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM — Today: the screen a rep lands on.
 *
 * GOLDEN RULE #1, the EASY half (owner, 2026-09-26): "very easy very simple". He opens the app a
 * dozen times a day and lands on his day — the stops in the order he will drive them, grouped by
 * brick, each one either done with the time on it or one tap from being entered.
 *
 * Owner, 2026-09-29: "a dashboard of today's visits, done and not done" — AM and PM as two sections,
 * the visits off the plan beside it with where each has got to, and the day's activity, planned and
 * recorded. "Today" is the VISIT day: until 02:00 it is still the day that just ended.
 *
 * Owner, 2026-09-30: "the best-appearing and easiest CRM, yet controlled". So the screen opens on the
 * two answers he wants between two doors — how much of the plan is done, AM and PM each on its own
 * square bar, and who to go to NEXT, with one big button that opens Add visit on that customer. The
 * list stays underneath, exactly as it was, for when he wants the whole day.
 *
 * Everything here is HIS OWN WORK, which is what the rule keeps visible: his plan, his day, his two
 * targets. There is no measurement of where he stood on this screen, and no count of one.
 *
 * AM and PM are two figures, never summed and never averaged — the call-rate golden rule.
 */

const LIST_TYPES: readonly PhoenixCrmListType[] = ["AM", "PM"];

function stopKey(customerId: string): string {
  return `today-${customerId}`;
}

// ── The clock "Next up" reads ─────────────────────────────────────────────────────────────────────
//
// The phone's clock, to the minute, read again every half minute and whenever the screen comes back
// into view — so a rep who opens the app at 16:59 and again at 17:01 sees the 17:00 clinic come up.
// It only ORDERS a suggestion; nothing is saved from it. The server never needs it, and the server
// render gets none (null), so nothing is ever called "now" from a clock that is not his.

function subscribeToClock(onChange: () => void): () => void {
  const timer = window.setInterval(onChange, 30_000);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onChange);
  };
}

/** The clock floored to the minute, so the snapshot only changes when the minute does. */
function clockMinuteSnapshot(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

function noClockOnServer(): number | null {
  return null;
}

// ── At a glance: AM and PM, two bars, apart ───────────────────────────────────────────────────────

/**
 * One list type's plan as a square bar — planned visits done of planned — with the day's visits
 * against that list's own target underneath. Drawn twice, AM and PM side by side; there is no third,
 * combined bar anywhere, because the call rate is never summed or averaged.
 */
function PlanMeter({
  done,
  listType,
  planned,
  target,
  visited,
}: {
  done: number;
  listType: PhoenixCrmListType;
  planned: number;
  target: number;
  visited: number;
}) {
  const complete = planned > 0 && done >= planned;
  const percent = planned > 0 ? Math.round((Math.min(done, planned) / planned) * 100) : 0;
  const targetMet = target > 0 && visited >= target;
  return (
    <div className="min-w-0 border border-slate-200 bg-white px-3 py-3 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1.5">
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{listText(listType)} plan</p>
        {complete ? <CrmPill tone="good">Done</CrmPill> : null}
      </div>
      <p className="mt-1.5 break-words text-2xl font-black leading-tight text-slate-950">
        {planned > 0 ? (
          <>
            {done}
            <span className="text-sm font-black text-slate-400"> of {planned}</span>
          </>
        ) : (
          <span className="text-base font-black text-slate-400">None planned</span>
        )}
      </p>
      <div
        aria-label={`${listText(listType)} plan: ${done} of ${planned} done`}
        aria-valuemax={planned}
        aria-valuemin={0}
        aria-valuenow={done}
        className="mt-2 h-2.5 min-w-0 border border-slate-200 bg-slate-100"
        role="progressbar"
      >
        <div className={cn("h-full transition-[width]", complete ? "bg-emerald-600" : "bg-orange-500")} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
        <span className="font-black text-slate-800">{visited}</span> visited today · target {target} a day
        {targetMet ? <span className="block font-black text-emerald-700">Target met</span> : null}
      </p>
    </div>
  );
}

function DayGlance({ view }: { view: TodayView }) {
  const plannedDone = (listType: PhoenixCrmListType) => view.stops.filter((stop) => stop.listType === listType && stop.done).length;
  return (
    <CrmBlock title="At a glance">
      {/* AM first, as every sentence in the module says it. Two bars side by side, never one. */}
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <PlanMeter done={plannedDone("AM")} listType="AM" planned={view.counts.plannedAm} target={view.target.am} visited={view.counts.doneAm} />
        <PlanMeter done={plannedDone("PM")} listType="PM" planned={view.counts.plannedPm} target={view.target.pm} visited={view.counts.donePm} />
      </div>
    </CrmBlock>
  );
}

// ── Next up ───────────────────────────────────────────────────────────────────────────────────────

const NEXT_TONES: Record<NextStopState, string> = {
  later: "text-slate-800",
  "no-hours": "text-amber-800",
  "not-today": "text-slate-500",
  now: "text-emerald-700",
  passed: "text-slate-500",
};

const NEXT_MARKS: Record<NextStopState, string> = {
  later: "bg-orange-500",
  "no-hours": "bg-amber-500",
  "not-today": "bg-slate-300",
  now: "bg-emerald-600",
  passed: "bg-slate-300",
};

/** What is still to do, AM and PM apart: "Still to do: 1 AM · 5 PM". */
function stillToDoText(stops: readonly TodayStop[]): string {
  const left = (listType: PhoenixCrmListType) => stops.filter((stop) => stop.listType === listType && !stop.done).length;
  return `Still to do: ${left("AM")} ${listText("AM")} · ${left("PM")} ${listText("PM")}`;
}

function NextUpCard({
  canAdd,
  next,
  onLogVisit,
  stillToDo,
}: {
  canAdd: boolean;
  next: NextStop;
  onLogVisit: () => void;
  stillToDo: string;
}) {
  const { stop } = next;
  const where = stopWhereLine(stop, stop.brick ? brickLabel(stop.brick) : null);
  return (
    <CrmBlock
      actions={<span className="break-words text-xs font-bold text-slate-500">{stillToDo}</span>}
      className="border-t border-slate-100"
      title="Next up"
    >
      <div className="min-w-0 border border-l-4 border-slate-200 border-l-orange-500 bg-white px-4 py-4 shadow-[0_10px_28px_rgba(15,23,42,0.07)] sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CrmPill tone="info">{listText(stop.listType)}</CrmPill>
          <CrmPill tone="neutral">{stop.grade ? `Grade ${stop.grade}` : "No grade"}</CrmPill>
        </div>
        {/* A name may be Arabic: its own direction, never a mixed run. */}
        <p className="mt-2 break-words text-xl font-black leading-snug text-slate-950" dir="auto">
          {stop.name}
        </p>
        {stop.speciality ? <p className="mt-0.5 break-words text-sm font-semibold text-slate-500">{stop.speciality}</p> : null}
        <p className={cn("mt-3 flex min-w-0 items-center gap-2 text-sm font-black", NEXT_TONES[next.state])}>
          <span aria-hidden className={cn("h-2.5 w-2.5 shrink-0", NEXT_MARKS[next.state])} />
          <span className="min-w-0 break-words">{next.status}</span>
        </p>
        <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">{where}</p>
        {canAdd ? (
          // The planned-visit hand-off, the same one the row's Add visit uses: Add Visit opens with this
          // customer already chosen. No new step in his day.
          <CrmButton className="mt-4 min-h-12 w-full text-base sm:w-auto sm:px-10" onClick={onLogVisit} variant="primary">
            Log visit
          </CrmButton>
        ) : null}
      </div>
    </CrmBlock>
  );
}

/** Every planned customer is done: a brief well done, and the way in for anyone else he sees. */
function AllDoneCard({ action }: { action: ReactNode }) {
  return (
    <CrmBlock className="border-t border-slate-100" title="Next up">
      <div className="flex min-w-0 flex-col gap-3 border border-l-4 border-emerald-200 border-l-emerald-600 bg-emerald-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center bg-emerald-600 text-white">
            <Check className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="break-words text-base font-black text-emerald-900">All planned visits done</p>
            <p className="mt-0.5 break-words text-sm font-semibold text-emerald-800">Well done. Anyone else you see today goes in with Add visit.</p>
          </div>
        </div>
        {action ? <div className="flex min-w-0 flex-wrap gap-2">{action}</div> : null}
      </div>
    </CrmBlock>
  );
}

// ── The day's list ────────────────────────────────────────────────────────────────────────────────

/** A square tick: filled when the visit is in, empty while it is still to do. */
function StopTick({ done }: { done: boolean }) {
  return done ? (
    <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border border-emerald-600 bg-emerald-600 text-white">
      <Check className="h-3.5 w-3.5" />
    </span>
  ) : (
    <span aria-hidden className="mt-0.5 h-5 w-5 shrink-0 border-2 border-slate-300 bg-white" />
  );
}

function StopStanding({ stop }: { stop: TodayStop }) {
  return stop.done ? <CrmPill tone="good">Done {stop.doneAt}</CrmPill> : <CrmPill tone="neutral">Not done</CrmPill>;
}

/** "Grade B · Internal Medicine" — nothing when neither is known. */
function stopMeta(stop: TodayStop): string | null {
  const text = [stop.grade ? `Grade ${stop.grade}` : null, stop.speciality].filter((part): part is string => Boolean(part)).join(" · ");
  return text || null;
}

/** One brick's stops: cards on a phone, a table from `md` up. */
function BrickStops({
  canAdd,
  label,
  onAddVisit,
  stops,
  tint,
}: {
  canAdd: boolean;
  label: string;
  onAddVisit: (customerId: string, customerName: string) => void;
  stops: readonly TodayStop[];
  tint: BrickTint | undefined;
}) {
  const done = stops.filter((stop) => stop.done).length;
  return (
    <div className="min-w-0">
      {/* The wash is on the heading, never on a row — the way the List tab and the visit picker draw a
          brick, from the one shared palette. A done row is marked by its tick and a pale green, which
          is not one of the brick hues. */}
      <p
        className={cn(
          "break-words border-l-4 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.16em]",
          tint ? `${tint.bar} ${tint.fill} text-slate-600` : "border-l-amber-500 bg-amber-50 text-amber-800",
        )}
      >
        {label} · done {done} of {stops.length}
      </p>
      <CrmCardsOnPhone>
        {stops.map((stop) => {
          const meta = stopMeta(stop);
          return (
            <div className={cn("flex min-w-0 gap-3 px-2 py-3", stop.done && "bg-emerald-50/60")} key={`${stopKey(stop.customerId)}-card`}>
              <StopTick done={stop.done} />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <p className={cn("min-w-0 flex-1 break-words font-black", stop.done ? "text-slate-500" : "text-slate-950")} dir="auto">
                    {stop.name}
                  </p>
                  <StopStanding stop={stop} />
                </div>
                {meta ? <p className="break-words text-xs font-semibold text-slate-500">{meta}</p> : null}
                <p className="break-words text-xs font-semibold text-slate-500">{stopWhereLine(stop, null)}</p>
                {stop.done || !canAdd ? null : (
                  <div className="pt-1">
                    <CrmButton onClick={() => onAddVisit(stop.customerId, stop.name)} size="sm" variant="primary">
                      Add visit
                    </CrmButton>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </CrmCardsOnPhone>
      <CrmTable columns={["36%", "32%", "16%", "16%"]}>
        <thead>
          <tr>
            <th className={crmThClassName} scope="col">
              Customer
            </th>
            <th className={crmThClassName} scope="col">
              Where and when
            </th>
            <th className={crmThClassName} scope="col">
              Done
            </th>
            <th className={crmThClassName} scope="col">
              <span className="sr-only">Add visit</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {stops.map((stop) => {
            const meta = stopMeta(stop);
            return (
              <tr className={stop.done ? "bg-emerald-50/60" : undefined} key={stopKey(stop.customerId)}>
                <td className={crmTdClassName}>
                  <div className="flex min-w-0 gap-2.5">
                    <StopTick done={stop.done} />
                    <div className="min-w-0">
                      <p className={cn("font-black", stop.done ? "text-slate-500" : "text-slate-950")} dir="auto">
                        {stop.name}
                      </p>
                      {meta ? <p className="mt-0.5 text-xs text-slate-500">{meta}</p> : null}
                    </div>
                  </div>
                </td>
                <td className={crmTdClassName}>
                  <p className="break-words">{stopWhereLine(stop, null)}</p>
                </td>
                <td className={crmTdClassName}>
                  <StopStanding stop={stop} />
                </td>
                <td className={crmTdClassName}>
                  {stop.done || !canAdd ? null : (
                    <CrmButton onClick={() => onAddVisit(stop.customerId, stop.name)} size="sm" variant="primary">
                      Add visit
                    </CrmButton>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </CrmTable>
    </div>
  );
}

/** What the day was planned as, and what it was recorded as — a record only; it moves no figure. */
/**
 * The day's PHARMACIES, beside AM and PM and never inside either (the AM · PM · Pharmacies golden
 * rule). A pharmacy is feedback recorded ON a visit, so there is nothing to plan here and no "Add
 * visit" against one — this is what he took today, read back, with the customer it came from.
 */
function PharmaciesToday({ view }: { view: TodayView }) {
  const pharmacies = view.pharmacies ?? [];
  return (
    <CrmBlock className="border-t border-slate-100" title={`Pharmacies · ${countText(pharmacies.length)} today`}>
      {pharmacies.length === 0 ? (
        <p className="break-words text-sm font-semibold leading-6 text-slate-500">
          No pharmacy yet today. You name the pharmacy on the visit itself, under &ldquo;Pharmacy you took feedback from&rdquo;.
        </p>
      ) : (
        <ul className="grid min-w-0 gap-2">
          {pharmacies.map((pharmacy) => (
            <li className="min-w-0 border border-slate-200 bg-white px-3 py-2.5" key={pharmacy.name.toLocaleLowerCase()}>
              <p className="break-words text-sm font-black text-slate-950" dir="auto">
                {pharmacy.name}
              </p>
              <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500" dir="auto">
                {pharmacy.fromCustomers.join(" · ")} · from {pharmacy.firstAt}
              </p>
            </li>
          ))}
        </ul>
      )}
    </CrmBlock>
  );
}

function DayActivityLines({ view }: { view: TodayView }) {
  const planned = view.plannedActivity;
  const recorded = view.dayActivity;
  if (!planned && !recorded) return null;
  return (
    <CrmBlock className="border-t border-slate-100" title="The day">
      <div className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-700">
        {planned ? (
          <p className="break-words">
            <span className="font-black text-slate-900">Planned: </span>
            {planned.activityLabel}
            {planned.halfDay ? " · half day" : ""}
            {planned.note ? (
              <span className="block text-xs text-slate-500" dir="auto">
                {planned.note}
              </span>
            ) : null}
          </p>
        ) : null}
        {recorded ? (
          <p className="break-words">
            <span className="font-black text-slate-900">Recorded: </span>
            {recorded.activityLabel}
            {recorded.halfDay ? " · half day" : ""}
            {recorded.note ? (
              <span className="block text-xs text-slate-500" dir="auto">
                {recorded.note}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
    </CrmBlock>
  );
}

/**
 * Opens the Plan tab. The page hands its own `openTab` in; without it, the address's `?tab=` is set
 * and the page answers that change without reloading (phoenix-crm-app.tsx), the way the portal's "+"
 * lands a rep on a tab.
 */
function openPlanFromAddress() {
  try {
    const url = new URL(document.URL);
    url.searchParams.set("tab", "plan");
    window.history.replaceState(null, "", url);
  } catch {
    // The address could not be changed; the tab bar above is still one tap away.
  }
}

export function TodayTab({
  onAddVisit,
  onOpenPlan,
  onStartVisit,
  seatId,
  test,
}: {
  /** Opens Add visit with this customer already chosen — the module's existing hand-off. */
  onAddVisit: (customerId: string, customerName: string) => void;
  /** Opens the Plan tab, when the page offers it. */
  onOpenPlan?: () => void;
  /** Opens Add visit's first screen, for the day as a whole. */
  onStartVisit?: () => void;
  seatId: string;
  test: boolean;
}) {
  // The route answers `{ today: TodayView }` and `useCrmGet` already opens the envelope by that key, so
  // what comes back IS the view. (It was typed `{ today: TodayView }` and read `.today` a second time,
  // which is always undefined — the screen never left "Opening your day".)
  const resource = useCrmGet<TodayView>(crmUrl("/api/phoenix-crm/today", { seatId, test }), "today");
  const nowMs = useSyncExternalStore<number | null>(subscribeToClock, clockMinuteSnapshot, noClockOnServer);
  const view = resource.data;

  if (!view) {
    return resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Opening your day" />;
  }

  // A brick keeps one hue across the AM and PM sections: the hues are keyed off the whole day.
  const tints = brickTintMap(
    todayByBrick(view.stops)
      .filter((group) => group.key !== NO_BRICK_KEY)
      .map((group) => group.key),
  );
  const canStart = view.canAdd && Boolean(onStartVisit);
  // In the header the day-wide Add visit is the quiet one: the big orange button on this screen is
  // Log visit on the card below.
  const addDay = canStart ? (
    <CrmButton onClick={onStartVisit}>
      <Plus aria-hidden className="h-4 w-4" />
      Add visit
    </CrmButton>
  ) : null;
  const next = nextStop(view.stops, nowMs === null ? null : visitDayMinute(nowMs, view.date), weekdayOfIsoDay(view.date));

  return (
    <CrmPanel actions={addDay} description={`${view.territory.name} · ${dayLabelLong(view.date)}`} title="Today">
      {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : null}

      <DayGlance view={view} />

      {/*
        His week is still a draft. The day is shown and every Add visit works — the note only says
        the sending is outstanding, and links him to the one screen that does it. Never a refusal:
        whether a visit COUNTS as planned is the server's decision against the sent plan, not this
        screen's (owner, 2026-09-30).
      */}
      {view.unsentNote ? (
        <div className="border-t border-slate-100 px-4 pt-4 sm:px-5">
          <CrmNote tone="warn">
            <span className="break-words">{view.unsentNote}</span>
          </CrmNote>
        </div>
      ) : null}

      {view.stops.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty
            action={
              <>
                <CrmButton onClick={onOpenPlan ?? openPlanFromAddress} variant="primary">
                  <CalendarDays aria-hidden className="h-4 w-4" />
                  Open Plan
                </CrmButton>
                {addDay}
              </>
            }
            message={view.emptyReason ?? undefined}
            title="Nothing planned for today"
          />
        </div>
      ) : next ? (
        <NextUpCard
          canAdd={view.canAdd}
          next={next}
          onLogVisit={() => onAddVisit(next.stop.customerId, next.stop.name)}
          stillToDo={stillToDoText(view.stops)}
        />
      ) : (
        <AllDoneCard
          action={
            canStart ? (
              <CrmButton onClick={onStartVisit} variant="primary">
                <Plus aria-hidden className="h-4 w-4" />
                Add visit
              </CrmButton>
            ) : null
          }
        />
      )}

      <DayActivityLines view={view} />

      {view.stops.length === 0
        ? null
        : LIST_TYPES.map((listType) => {
            const stops = view.stops.filter((stop) => stop.listType === listType);
            const groups = todayByBrick(stops);
            return (
              <CrmBlock
                className="border-t border-slate-100"
                key={listType}
                title={`${listType} · done ${stops.filter((stop) => stop.done).length} of ${stops.length}`}
              >
                {stops.length === 0 ? (
                  <p className="text-sm font-semibold text-slate-500">Nothing planned for {listType} today.</p>
                ) : (
                  <div className="grid min-w-0 gap-4">
                    {groups.map((group) => (
                      <BrickStops
                        canAdd={view.canAdd}
                        key={group.key}
                        label={group.label}
                        onAddVisit={onAddVisit}
                        stops={group.rows}
                        tint={tints.get(group.key)}
                      />
                    ))}
                  </div>
                )}
              </CrmBlock>
            );
          })}

      <PharmaciesToday view={view} />

      {view.alsoVisited.length > 0 ? (
        // Beside the plan, never inside it. Real work he did, and dropping it into the middle of his
        // route would make the list he is reading change shape as he works down it. Each one says where
        // its approval has got to — his own, so he can chase it.
        <CrmBlock className="border-t border-slate-100" title="Also visited today">
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {view.alsoVisited.map((extra) => (
              <li className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-2.5" key={extra.customerId}>
                <div className="flex min-w-0 flex-1 gap-3">
                  <StopTick done />
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-black text-slate-950" dir="auto">
                      {extra.name}
                    </p>
                    <p className="text-xs font-semibold text-slate-500">
                      {extra.listType} · {extra.doneAt}
                    </p>
                  </div>
                </div>
                <span className="flex max-w-full flex-wrap gap-1">
                  {extra.offKind ? <CrmPill tone="orange">{unplannedKindLabel(extra.offKind)}</CrmPill> : null}
                  {extra.statusLabel ? <CrmPill tone="neutral">{extra.statusLabel}</CrmPill> : null}
                </span>
              </li>
            ))}
          </ul>
        </CrmBlock>
      ) : null}
    </CrmPanel>
  );
}
