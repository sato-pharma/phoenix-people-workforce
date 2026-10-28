"use client";

/**
 * Phoenix CRM — one day of the plan board (owner, 2026-09-29).
 *
 *   - Under the date, the day's START AM and START PM: when he means to start each round, as the old
 *     weekly plan carried them on every day (2026-09-30). Both optional, a Thursday has no PM, and they
 *     are his own statement — nothing is checked against them.
 *   - At the top, the day's OTHER ACTIVITIES as tick boxes — a meeting, a conference, a health day, a
 *     sales day, training, admin work, travel — ONE OF EACH KIND, so a meeting and travel on one day is
 *     planned as exactly that (2026-09-30; the day held one until then). Each is for the whole day or
 *     half of it, with a short note of its own.
 *   - Below it, the day's customers GROUPED BY BRICK WITH TICK BOXES, AM and PM apart (a Thursday is a
 *     morning, so it holds AM only). Ticking places the customer on the day and unticking takes him off.
 *     Each row shows his name, grade, speciality, brick and address, and a column of every day and hour
 *     he receives.
 *   - EACH BRICK HAS ITS OWN TICK BOX (2026-09-30, as the old weekly plan's brick headers did): it places
 *     every customer shown under the brick at once — as many as the list still has room for, in the
 *     order shown — and, once they are all on the day, takes the whole brick off. It is only the ticks
 *     he would have made one by one: no rule of its own.
 *   - NEVER BLOCKED BY HOURS (owner, 2026-09-30: "does not receive on Wednesday — never block, because
 *     the rep didn't add his time; add a column for timings but never block"). A tick places him on
 *     any day and asks nothing: the hours are the rep's own entry and may simply be missing.
 *   - A customer not validated yet is planned like anyone else, with a small inline "Not validated yet"
 *     and iReports360's brick and address where his place would be (owner, the same day).
 *   - The AM and PM caps are the day's only hard limits: a full list cannot be ticked any further, and
 *     its heading says so — no "Day full" word on every row. A list at its cap turns EMERALD (its meter,
 *     its figure on the day's button), and a day whose every list is full lights an emerald rail.
 *   - Ticking numbers the row IN ITS OWN LIST, in the order he ticked: 1 AM, 1 PM, 2 PM, 3 PM (owner,
 *     2026-09-30) — so the day he is building reads as a sequence, and AM and PM are counted apart.
 *   - Each row says when he was LAST SEEN — the latest of iReports360 and Phoenix — with a validated
 *     customer's month beside it; iReports360's USUAL DAYS while he has no days and hours of his own;
 *     and a FOLLOW-UP his latest visit left due inside this week (owner, 2026-10-02; plan-insight.ts).
 *     His own history and his own commitments — nothing on them judges him.
 *
 * Nothing here judges the rep: no distance, no spread and no nearest-customer figure reaches his own
 * plan. The day's spread is shown only on a reviewer's reading of a sent plan (`showSpread`).
 *
 * The brick groups are an INDEX here — he is looking customers up to tick them — so they read
 * alphabetically (brick-groups.ts), and a brick keeps the same colour it has everywhere else
 * (brick-tints.ts), keyed off the whole list so it never moves as he filters.
 *
 * "Suggest this day" sits beside "Copy a day" (owner, 2026-09-30). Both arrive as elements built by the
 * week panel, which hands them the board's one way into the draft — this panel only lays them out. On
 * a day the rep cannot change, the suggestion stays on screen, disabled, with its reason.
 */

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";

import { countText, dayLabel, dayLabelLong } from "@/components/phoenix-crm/format";
import type { BrickTint } from "@/components/phoenix-crm/brick-tints";
import { customerMetaText, matchesWords, PENDING_PILL, plannerRowInsight } from "@/components/phoenix-crm/labels";
import type { CopyReport } from "@/components/phoenix-crm/plan-copy-menu";
import { PlanFilterBar } from "@/components/phoenix-crm/plan-filter-bar";
import {
  CrmBlock,
  CrmButton,
  CrmCardsOnPhone,
  CrmFillBar,
  CrmCheck,
  CrmField,
  CrmNote,
  CrmPill,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { clusterByBrick, NO_BRICK_KEY } from "@/lib/phoenix-crm/brick-groups";
import { fieldWeekStart, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { gradeTarget } from "@/lib/phoenix-crm/coverage";
import { dayActivityLabel, PHOENIX_CRM_DAY_ACTIVITIES, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { describeDayStarts, startInputValue, startMinuteFromInput, type PlanDayStarts } from "@/lib/phoenix-crm/plan-day-starts";
import { filterPlannerCustomers, plannerFilterOptions, type DoctorFilter } from "@/lib/phoenix-crm/plan-filters";
import { dayOffPhrase, type PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import { suggestionCaps, type DayTargets, type GradeTargets } from "@/lib/phoenix-crm/plan-suggest";
import {
  brickTickPress,
  brickTickState,
  customerOnDay,
  dayCounts,
  dayFullness,
  dayOffOf,
  indexCustomers,
  PLANNED_ACTIVITY_NOTE_MAX,
  resolveDayRows,
  roomOnDay,
  type BrickTickState,
  type DailyCaps,
  type PlannedActivity,
} from "@/lib/phoenix-crm/plan-week-draft";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import { PHOENIX_CRM_WEEKDAY_NAMES, weekTimingsText } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade } from "@/lib/phoenix-crm/types";
import type { PlanDayView, PlanItemView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

const NEUTRAL_TINT: BrickTint = { bar: "border-l-slate-300", fill: "bg-slate-50" };

/** One customer the rep may tick on the day. */
type TickRow = {
  customerId: string;
  name: string;
  listType: PhoenixCrmDoctorListType;
  grade: PhoenixCrmGrade | null;
  speciality: string | null;
  pending: boolean;
  brick: string | null;
  /** Which of his clinics, when he has more than one. */
  placeName: string | null;
  /** The place a tick plans him at. */
  placeId: string | null;
  /** Brick and address: the saved place's, or iReports360's while he is not validated yet. */
  where: string | null;
  /** Every day and hour he receives — shown, never a condition on the tick. */
  timings: string;
  /** Where he sits in his OWN list on this day, in tick order (1 AM, 1 PM, 2 PM…). Null when not placed. */
  position: number | null;
  /** His saved hours cover this day: used to order the day, never to refuse it. */
  receives: boolean;
  noRamadanTime: boolean;
  startMinute: number | null;
  placed: boolean;
  /** "Last seen Tue 29 Sept", with a validated customer's month beside it. Null when it was not read. */
  lastSeen: string | null;
  /** "Usually seen Sun, Tue (iReports360)" — only while he has no days and hours of his own. */
  usual: string | null;
  /** "Follow-up due Tue 6 Oct" — his latest visit's next step, due inside this week. */
  followUp: string | null;
};

const NO_HOURS = "No days and hours yet";

function compareTickRows(left: TickRow, right: TickRow): number {
  return (
    Number(right.receives) - Number(left.receives) ||
    (left.startMinute ?? 9999) - (right.startMinute ?? 9999) ||
    left.name.localeCompare(right.name)
  );
}

/** "Ali, Omar and Hany"; past three, "Ali, Omar and 3 more". */
function namesText(names: ReadonlyArray<string>): string {
  if (names.length > 3) return `${names.slice(0, 2).join(", ")} and ${countText(names.length - 2)} more`;
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Every word a customer can be found by. */
function customerWords(customer: PlannerCustomer): Array<string | null> {
  return [customer.name, customer.speciality, ...customer.places.flatMap((place) => [place.brick, place.label, place.zone, place.sharedPlaceName ?? null])];
}

export function PlanDayPanel({
  activities,
  caps,
  copyMenu,
  customers,
  day,
  dayTargets,
  editing,
  fillReport = null,
  filter,
  filterOptions,
  focus,
  gradeTargets,
  idPrefix,
  items,
  locked,
  onActivity,
  onFill,
  onFilter,
  onPlace,
  onQuery,
  onRemove,
  onStarts,
  planCopyMenu,
  query,
  reviewList,
  showSpread,
  starts,
  suggestMenu,
  tints,
  today,
}: {
  /** The day's other activities as the draft holds them (editing), one of each kind. */
  activities: ReadonlyArray<PlannedActivity>;
  caps: DailyCaps;
  /** "Copy a day", when the rep may change this day. */
  copyMenu?: ReactNode;
  customers: ReadonlyArray<PlannerCustomer>;
  day: PlanDayView;
  /**
   * The day's share of this month's visits, AM and PM — what Suggest fills it to. The list's heading
   * names it beside the cap when it is lower. Unset off the rep's own board.
   */
  dayTargets?: DayTargets;
  /** The rep is changing this day: its customers come from the draft and tick on and off. */
  editing: boolean;
  /** What the step form's last "Suggest this day" did here, said under the buttons; null when nothing yet. */
  fillReport?: CopyReport | null;
  filter: DoctorFilter;
  filterOptions: {
    bricks: ReadonlyArray<{ value: string; label: string }>;
    grades: ReadonlyArray<PhoenixCrmGrade>;
    specialities: ReadonlyArray<string>;
    /** Polyclinics and centres customers are seated in; absent or empty hides the picker. */
    venues?: ReadonlyArray<{ value: string; label: string }>;
  };
  /**
   * The rep's step form (owner, 2026-10-02: step 3 "too long, confusing" — he chose all three fixes):
   * ONE list at a time, AM then PM; only the customers who receive that day (or whose hours are not known
   * yet) until he asks for the rest; and the start times, activities, copy and filters folded under "More
   * for this day". Unset is the whole day at once — a manager reviewing from Team.
   */
  focus?: PhoenixCrmDoctorListType;
  /** The grade numbers: a validated customer's row reads his month against his grade's. */
  gradeTargets: GradeTargets;
  idPrefix: string;
  /** The week's drafted placements. */
  items: ReadonlyArray<PlanItemDraft>;
  locked: boolean;
  /** Ticks one kind of activity on the day, or takes it off (null); the day's other kinds stay. */
  onActivity: (activityType: PhoenixCrmDayActivity, next: Pick<PlannedActivity, "halfDay" | "note"> | null) => void;
  /** "Fill the day for me": the day's suggestion, on the step form. */
  onFill?: () => void;
  onFilter: (next: DoctorFilter) => void;
  onPlace: (item: PlanItemDraft) => void;
  onQuery: (next: string) => void;
  onRemove: (customerId: string) => void;
  onStarts: (next: PlanDayStarts) => void;
  /** The step form's week copies — last week's plan and the period plan — beside "Copy a day". */
  planCopyMenu?: ReactNode;
  query: string;
  /**
   * A reviewer's steps (owner, 2026-10-02): the day he is reading, ONE list at a time — its AM, then its
   * PM — read only. Unset shows the whole day. Never set on the rep's own plan.
   */
  reviewList?: PhoenixCrmDoctorListType;
  /** A reviewer's reading: the day's spread may show. Never true for a rep on his own plan. */
  showSpread: boolean;
  /** The day's Start AM / Start PM: the draft's while he is changing the day, else what was saved. */
  starts: PlanDayStarts;
  /** "Suggest this day", on the rep's own plan — disabled, with its reason, when the day cannot change. */
  suggestMenu?: ReactNode;
  tints: ReadonlyMap<string, BrickTint>;
  today: string;
}) {
  // The step form's two folds. Hooks first: the panel returns early for a day he is not changing.
  const [showOthers, setShowOthers] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // The customers a brick's box could not place for want of room, named under that brick.
  const [brickNote, setBrickNote] = useState<{ key: string; text: string } | null>(null);
  const weekday = weekdayOfIsoDay(day.date);
  const weekdayName = PHOENIX_CRM_WEEKDAY_NAMES[weekday];
  const dayName = dayLabel(day.date);
  // A day off holds no list at all (owner, 2026-10-02) — a public holiday, or his own approved leave —
  // so it is never read as a Thursday morning.
  const off = dayOffOf(day);
  const morning = !off && !day.listTypes.includes("PM");
  const byId = indexCustomers(customers);
  // Full: the day's rail turns emerald and the colour blooms off it (owner, 2026-09-30).
  const drafted = editing ? resolveDayRows(day, items, byId) : [];
  const full = dayFullness(editing ? dayCounts(drafted) : day.counts, caps, day.listTypes);
  const startsText = describeDayStarts(starts);

  const header = (
    <CrmBlock
      actions={
        <span className="flex max-w-full flex-wrap gap-1">
          {day.date === today ? <CrmPill tone="info">Today</CrmPill> : null}
          {!day.editable ? <CrmPill>Passed</CrmPill> : null}
          {off ? <CrmPill tone="warn">{off.kind === "leave" ? "Vacation · approved" : "Day off"}</CrmPill> : null}
          {day.pendingLeave ? <CrmPill tone="orange">Vacation · pending approval</CrmPill> : null}
          {day.ramadan ? <CrmPill tone="orange">Ramadan</CrmPill> : null}
          {morning ? <CrmPill>Morning · AM only</CrmPill> : null}
          {showSpread && !editing && day.farApart ? <CrmPill tone="warn">Far apart · {day.spanKm} km</CrmPill> : null}
        </span>
      }
      className={cn(
        "border-l-4 border-t border-slate-100",
        full.day ? "border-l-emerald-500 bg-gradient-to-r from-emerald-50 via-emerald-50/30 to-transparent" : "border-l-orange-500",
      )}
      title="Day"
    >
      <p className="break-words text-lg font-black leading-tight text-slate-950">{dayLabelLong(day.date)}</p>
      {editing && !focus ? (
        <DayStartsEditor dayName={dayName} idPrefix={`${idPrefix}-${day.date}`} locked={locked} morning={morning} onChange={onStarts} starts={starts} />
      ) : startsText ? (
        <p className="mt-1 break-words text-sm font-bold text-slate-700">{startsText}</p>
      ) : null}
      {!day.editable || off || day.pendingLeave || morning || day.ramadan ? (
        <div className="mt-3 grid min-w-0 gap-2">
          {!day.editable ? <CrmNote>This day has passed. It shows what was planned.</CrmNote> : null}
          {off ? <CrmNote tone="warn">{`${dayName} is ${dayOffPhrase(off)}: it holds no customer.`}</CrmNote> : null}
          {day.pendingLeave ? (
            <CrmNote tone="info">{`${day.pendingLeave} is requested for ${dayName} and waiting for approval. You can still plan this day; once it is approved the day holds no customer.`}</CrmNote>
          ) : null}
          {morning ? <CrmNote>Thursday is a morning: it holds AM only.</CrmNote> : null}
          {day.ramadan ? <CrmNote tone="info">A Ramadan day: each customer&apos;s Ramadan hours are used.</CrmNote> : null}
        </div>
      ) : null}
    </CrmBlock>
  );

  if (!editing) {
    return (
      <div className="min-w-0">
        {header}
        {suggestMenu ? (
          <CrmBlock className="border-t border-slate-100" title="Suggest this day">
            {suggestMenu}
          </CrmBlock>
        ) : null}
        <CrmBlock className="border-t border-slate-100" title="Other activities">
          {day.activities.length > 0 ? (
            <ul className="grid min-w-0 gap-2">
              {day.activities.map((activity) => (
                <li className="break-words text-sm font-bold text-slate-800" key={activity.activityType}>
                  {activity.activityLabel}
                  {activity.halfDay ? " · half day" : " · whole day"}
                  {activity.note ? <span className="block break-words text-xs font-semibold leading-5 text-slate-500">{activity.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm font-medium text-slate-500">No other activity planned.</p>
          )}
        </CrmBlock>
        <PlannedDayView day={day} idPrefix={idPrefix} only={reviewList} showSpread={showSpread} tints={tints} weekdayName={weekdayName} />
      </div>
    );
  }

  const counts = dayCounts(drafted);
  const room = roomOnDay(drafted, caps);
  const gone = drafted.filter((row) => row.gone);
  const onTheDay = drafted.filter((row) => !row.gone);
  const placedById = new Map(onTheDay.map((row) => [row.customerId, row]));
  // 1 AM, 1 PM, 2 PM… — each list counted on its own, in the order he ticked (owner, 2026-09-30).
  const order = new Map<string, number>();
  const seen: Record<PhoenixCrmDoctorListType, number> = { AM: 0, PM: 0 };
  for (const row of onTheDay) {
    seen[row.listType] += 1;
    order.set(row.customerId, seen[row.listType]);
  }
  // The rep's AM or PM step is one list on one day (owner walk, 2026-10-28: "AM or PM" and "Receives on"
  // were offered there and gave 0). Neither narrows it; a From / To reads this day's own weekday.
  const timed = filter.fromMinute !== null || filter.toMinute !== null;
  const shownFilter: DoctorFilter = focus ? { ...filter, session: "all", weekday: timed ? weekday : null } : filter;
  const allowed = new Set(filterPlannerCustomers(customers, { ...shownFilter, ramadan: day.ramadan }).map((customer) => customer.customerId));
  // The week this day belongs to: a follow-up shows when it is due inside it.
  const weekStart = fieldWeekStart(day.date);

  const tickRows: TickRow[] = [];
  let offered = 0;
  // Everyone the day could list, before any filter: the step's pickers are built from them.
  const offeredCustomers: PlannerCustomer[] = [];
  for (const customer of customers) {
    const placed = placedById.get(customer.customerId) ?? null;
    if (!placed && !day.listTypes.includes(customer.listType)) continue;
    const fit = customerOnDay(customer, day.date, day.ramadan, placed?.placeId ?? null);
    if (!fit) continue;
    offered += 1;
    offeredCustomers.push(customer);
    if (!placed && !(allowed.has(customer.customerId) && matchesWords(query, customerWords(customer)))) continue;
    const position = fit.place ? customer.places.findIndex((place) => place.placeId === fit.placeId) : -1;
    // The brick and area are the organogram's on both sides — the saved place's, or the sales master's
    // for a customer not validated yet. iReports360's own area and region names are never shown: they
    // disagree with the organogram on 37 of 39 areas (owner, 2026-09-30; see PlannerReference).
    const reference = fit.place ? null : (customer.reference ?? null);
    const brick = fit.place?.brick ?? reference?.brick ?? null;
    const address = fit.place ? fit.place.address : reference?.address ?? null;
    const area = fit.place ? null : reference?.area ?? null;
    const timings = fit.place ? weekTimingsText(fit.place.timings, day.ramadan) : "";
    const insight = plannerRowInsight(customer, { target: gradeTarget({ gradeTargets }, customer.listType, customer.grade), today, weekStart });
    tickRows.push({
      customerId: customer.customerId,
      name: customer.name,
      listType: customer.listType,
      grade: customer.grade,
      speciality: customer.speciality,
      pending: customer.pending,
      brick,
      // A seated customer is shown under the building he receives in, whatever else he has.
      placeName: fit.place?.sharedPlaceName ?? (customer.places.length > 1 && fit.place ? (fit.place.label ?? fit.place.zone ?? `Place ${position + 1}`) : null),
      placeId: fit.placeId,
      where: [brick ? `Brick ${brick}` : null, area, address].filter(Boolean).join(" · ") || null,
      timings: timings || NO_HOURS,
      receives: fit.receives,
      noRamadanTime: fit.receives && fit.noRamadanTime,
      startMinute: fit.windows[0]?.startMinute ?? null,
      placed: placed !== null,
      position: placed ? (order.get(customer.customerId) ?? null) : null,
      lastSeen: insight.lastSeen,
      usual: insight.usual,
      followUp: insight.followUp,
    });
  }
  const shownUnplaced = tickRows.filter((row) => !row.placed).length;
  const filtering =
    query.trim() !== "" ||
    shownFilter.session !== "all" ||
    shownFilter.brick !== null ||
    shownFilter.venue !== null ||
    shownFilter.grade !== null ||
    shownFilter.speciality !== null ||
    shownFilter.weekday !== null;
  const sections = (["AM", "PM"] as const).filter((listType) => day.listTypes.includes(listType) || tickRows.some((row) => row.listType === listType));

  // A tick places him on the day, whatever hours are saved for it — never a reason to ask (owner, 2026-09-30).
  function toggle(row: TickRow, next: boolean) {
    if (locked) return;
    if (!next) {
      onRemove(row.customerId);
      return;
    }
    onPlace({ planDate: day.date, customerId: row.customerId, placeId: row.placeId, exceptionType: null, exceptionNote: null });
  }

  // A whole brick at once: exactly the ticks he would make one by one, through the same `toggle`, so a
  // brick carries no rule of its own (`brickTickPress` decides which). The board applies each over the
  // draft the one before it made, so none of them is lost.
  function pressBrick(rows: ReadonlyArray<TickRow>, listType: PhoenixCrmDoctorListType, groupKey: string) {
    if (locked) return;
    const press = brickTickPress(rows, room[listType]);
    for (const row of press.takeOff) toggle(row, false);
    for (const row of press.place) toggle(row, true);
    // The ones the list had no room for are named, never left off in silence (the role walk, 2026-10-28).
    setBrickNote(
      press.left.length > 0
        ? {
            key: `${day.date}|${listType}|${groupKey}`,
            text: `No room for ${namesText(press.left.map((row) => row.name))}: the ${listType} list on ${dayName} is full.`,
          }
        : null,
    );
  }

  // The day's share of this month's visits — what Suggest fills it to — beside the cap when it is lower
  // (the role walk, 2026-10-28: Suggest stopped at 2 of a cap of 5 and nothing said why). A half-day
  // activity halves it as it halves the suggestion; a whole-day one leaves the heading as it was.
  const goalCaps = suggestionCaps(caps, dayTargets);
  function goalOf(listType: PhoenixCrmDoctorListType): number | null {
    if (!dayTargets || activities.some((activity) => !activity.halfDay)) return null;
    const goal = listType === "AM" ? goalCaps.amDailyCap : goalCaps.pmDailyCap;
    return activities.length > 0 ? Math.floor(goal / 2) : goal;
  }

  const tickRowProps = { dayName, idPrefix, locked, onToggle: toggle, room };

  /** One list of the day — AM or PM — grouped by brick under its fill bar. `top` sits under the bar. */
  function listBlock(listType: PhoenixCrmDoctorListType, rows: ReadonlyArray<TickRow>, emptyText: string, top?: ReactNode) {
    const cap = listType === "AM" ? caps.amDailyCap : caps.pmDailyCap;
    const goal = goalOf(listType);
    const groups = clusterByBrick(rows, (row) => row.brick, "alphabetical");
    const title =
      goal !== null && goal > 0 && goal < cap
        ? `${listType} · ${countText(counts[listType])} of ${countText(goal)} placed (room for ${countText(cap)})`
        : `${listType} · ${countText(counts[listType])} of ${countText(cap)} placed`;
    return (
      <CrmBlock className="border-t border-slate-100" key={listType} title={title}>
        {/* The day filling up, in Today's own shape: orange as it fills, emerald at the cap. */}
        <CrmFillBar full={full[listType]} label={`${listType} on ${dayName}: ${counts[listType]} of ${cap} placed`} of={cap} value={counts[listType]} />
        {top}
        <div className="mt-3" />
        {!day.listTypes.includes(listType) ? (
          <CrmNote className="mb-3" tone="bad">
            {off ? `${dayName} is ${dayOffPhrase(off)}. Take these off it.` : `${dayName} is a morning for AM only. Take these off it.`}
          </CrmNote>
        ) : null}
        {groups.length === 0 ? (
          <p className="text-sm font-medium text-slate-500">{emptyText}</p>
        ) : (
          <div className="grid min-w-0 gap-3">
            {groups.map((group) => {
              const tint = group.key === NO_BRICK_KEY ? NEUTRAL_TINT : (tints.get(group.key) ?? NEUTRAL_TINT);
              const ticked = group.rows.filter((row) => row.placed).length;
              return (
                <div className="min-w-0 border border-slate-200" key={group.key}>
                  <div className={cn("flex min-w-0 flex-wrap items-center justify-between gap-2 border-l-[3px] px-3 py-2", tint.bar, tint.fill)}>
                    <BrickTick
                      dayName={dayName}
                      label={group.label}
                      onPress={() => pressBrick(group.rows, listType, group.key)}
                      state={brickTickState(group.rows, room[listType], locked)}
                    />
                    <span className="text-xs font-bold text-slate-600">
                      {countText(ticked)} of {countText(group.rows.length)} placed
                    </span>
                  </div>
                  {brickNote?.key === `${day.date}|${listType}|${group.key}` ? (
                    <CrmNote className="mx-3 mt-3" tone="warn">
                      {brickNote.text}
                    </CrmNote>
                  ) : null}
                  <CrmCardsOnPhone>
                    {group.rows.map((row) => (
                      <TickCard key={row.customerId} row={row} {...tickRowProps} />
                    ))}
                  </CrmCardsOnPhone>
                  <CrmTable columns={["9%", null, "24%", "28%"]}>
                    <thead>
                      <tr>
                        <th className={crmThClassName} scope="col">
                          <span className="sr-only">On {dayName}</span>
                        </th>
                        <th className={crmThClassName} scope="col">
                          Customer
                        </th>
                        <th className={crmThClassName} scope="col">
                          Speciality
                        </th>
                        <th className={crmThClassName} scope="col">
                          Days and hours
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => (
                        <TickTableRows key={row.customerId} row={row} {...tickRowProps} />
                      ))}
                    </tbody>
                  </CrmTable>
                </div>
              );
            })}
          </div>
        )}
      </CrmBlock>
    );
  }

  const goneNote =
    gone.length > 0 ? (
      <CrmBlock className="border-t border-slate-100" title="No longer on the list">
        <CrmNote tone="warn">
          {gone.map((row) => row.name).join(", ")} {gone.length === 1 ? "was" : "were"} planned on {dayName} before leaving your list. They come off the plan
          at the next save.
        </CrmNote>
      </CrmBlock>
    ) : null;

  // On the step the choices are the list on screen's; the whole-day view keeps the board's.
  const barOptions = focus ? plannerFilterOptions(offeredCustomers.filter((customer) => customer.listType === focus)) : filterOptions;
  const filterBar = (
    <PlanFilterBar
      bricks={barOptions.bricks}
      filter={filter}
      grades={barOptions.grades}
      idPrefix={`${idPrefix}-day`}
      locked={locked}
      onChange={onFilter}
      onQueryChange={onQuery}
      query={query}
      showSession={!focus}
      showWeekday={!focus}
      specialities={barOptions.specialities}
      venues={barOptions.venues}
    />
  );

  // ── The rep's step form: one list, the customers of the day, everything else folded ─────────────
  // Owner, 2026-10-02 ("step 3 needs a smarter way, still too long, confusing" — he chose all three):
  // AM, then PM, as two short screens (the board moves between them); the day arrives already filled by
  // its suggestion, which one tap clears; and only the customers he can see that day lead the list.
  if (focus) {
    const rows = tickRows.filter((row) => row.listType === focus).sort(compareTickRows);
    // He receives that day, his hours are not known yet (a customer not validated yet counts as
    // receiving), or he is already on it. The rest wait behind one button — never refused, only folded.
    const ofTheDay = rows.filter((row) => row.placed || row.receives);
    const others = rows.length - ofTheDay.length;
    const placedHere = onTheDay.filter((row) => row.listType === focus);
    return (
      <div className="min-w-0">
        {header}
        {offered === 0 && gone.length === 0 ? (
          <CrmBlock className="border-t border-slate-100">
            <p className="text-sm font-medium text-slate-500">No {focus} customer to place yet. Customers on your List show here.</p>
          </CrmBlock>
        ) : (
          listBlock(
            focus,
            showOthers ? rows : ofTheDay,
            filtering ? `No ${focus} customer matches the filter. Clear it above.` : `No ${focus} customer receives on ${weekdayName}.`,
            // Owner, 2026-10-02 ("where the combo box? where the suggest? where the copy iReports period
            // and week plan? in step 3"): every way to fill the list sits on ONE row above it, and the
            // filters right under it — none of them folded away.
            <>
              <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                {onFill ? (
                  <CrmButton disabled={locked || room[focus] <= 0} onClick={onFill} size="sm" variant="primary">
                    Suggest this day
                  </CrmButton>
                ) : null}
                {copyMenu}
                {planCopyMenu}
                {placedHere.length > 0 ? (
                  <CrmButton
                    disabled={locked}
                    onClick={() => {
                      for (const row of placedHere) onRemove(row.customerId);
                    }}
                    size="sm"
                    variant="danger"
                  >
                    Clear {focus}
                  </CrmButton>
                ) : null}
              </div>
              {fillReport ? (
                <CrmNote className="mt-3" title={fillReport.title} tone={fillReport.tone}>
                  {fillReport.message}
                </CrmNote>
              ) : null}
              {/* His own board saves itself as he ticks (owner, 2026-10-02): a fill is kept, and only Send sends it. */}
              <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
                The period plan is last month&apos;s — your iReports360 plan if you had none in Phoenix. Nothing is sent until you press Send.
              </p>
              <div className="mt-3 min-w-0">{filterBar}</div>
            </>,
          )
        )}
        {others > 0 ? (
          <CrmBlock className="border-t border-slate-100">
            <CrmButton onClick={() => setShowOthers((current) => !current)}>
              {showOthers
                ? `Hide the ${countText(others)} who do not receive on ${weekdayName}`
                : `Show ${countText(others)} more who do not receive on ${weekdayName}`}
            </CrmButton>
          </CrmBlock>
        ) : null}
        {goneNote}
        <CrmBlock className="border-t border-slate-100" title="More for this day">
          <CrmButton aria-expanded={moreOpen} onClick={() => setMoreOpen((current) => !current)}>
            {moreOpen ? "Hide" : "Start times and activities"}
          </CrmButton>
          {moreOpen ? (
            <div className="mt-4 grid min-w-0 gap-5">
              <DayStartsEditor dayName={dayName} idPrefix={`${idPrefix}-${day.date}`} locked={locked} morning={morning} onChange={onStarts} starts={starts} />
              <div className="min-w-0">
                <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Other activities</p>
                <ActivityEditor activities={activities} dayName={dayName} idPrefix={`${idPrefix}-${day.date}`} locked={locked} onChange={onActivity} />
              </div>
            </div>
          ) : null}
        </CrmBlock>
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {header}

      <CrmBlock className="border-t border-slate-100" title="Other activities">
        <ActivityEditor activities={activities} dayName={dayName} idPrefix={`${idPrefix}-${day.date}`} locked={locked} onChange={onActivity} />
      </CrmBlock>

      {suggestMenu || copyMenu ? (
        <CrmBlock className="border-t border-slate-100" title={suggestMenu && copyMenu ? "Suggest or copy a day" : suggestMenu ? "Suggest this day" : "Copy a day"}>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {suggestMenu}
            {copyMenu}
          </div>
        </CrmBlock>
      ) : null}

      <CrmBlock className="border-t border-slate-100" title="Customers">
        {filterBar}
        <p className="mt-3 break-words text-sm font-semibold leading-6 text-slate-600">
          {morning
            ? `${countText(counts.AM)} of ${countText(caps.amDailyCap)} AM placed.`
            : `${countText(counts.AM)} of ${countText(caps.amDailyCap)} AM and ${countText(counts.PM)} of ${countText(caps.pmDailyCap)} PM placed.`}{" "}
          {filtering
            ? `${countText(shownUnplaced)} more match the filter. Ticked customers always show.`
            : `Tick a customer to place them on ${dayName}.`}
        </p>
      </CrmBlock>

      {offered === 0 && gone.length === 0 ? (
        <CrmBlock className="border-t border-slate-100">
          <p className="text-sm font-medium text-slate-500">{morning ? "No AM customer to place yet." : "No customer to place yet."} Customers on your List show here.</p>
        </CrmBlock>
      ) : null}

      {offered > 0
        ? sections.map((listType) =>
            listBlock(
              listType,
              tickRows.filter((row) => row.listType === listType).sort(compareTickRows),
              `No ${listType} customer matches the filter. Clear it to see them all.`,
            ),
          )
        : null}

      {goneNote}
    </div>
  );
}

// ── The day's start times ───────────────────────────────────────────────────────────────────────

/**
 * Start AM and Start PM, the old weekly plan's own two fields — his statement of when each round
 * starts, never a rule: an empty field is simply a day he did not set one for, and nothing he ticks is
 * checked against it. A Thursday is a morning, so it offers Start AM alone.
 */
function DayStartsEditor({
  dayName,
  idPrefix,
  locked,
  morning,
  onChange,
  starts,
}: {
  dayName: string;
  idPrefix: string;
  locked: boolean;
  morning: boolean;
  onChange: (next: PlanDayStarts) => void;
  starts: PlanDayStarts;
}) {
  const amId = `${idPrefix}-start-am`;
  const pmId = `${idPrefix}-start-pm`;
  return (
    <div aria-label={`When the rounds start on ${dayName}`} className={cn("mt-3 grid min-w-0 gap-3", morning ? "sm:max-w-[14rem]" : "grid-cols-2 sm:max-w-md")} role="group">
      {/* `appearance-none`, as on every time input in the module: without it iOS draws its own rounded control. */}
      <CrmField hint="Optional" htmlFor={amId} label="Start AM">
        <input
          className={cn(crmInputClassName, "appearance-none")}
          disabled={locked}
          id={amId}
          onChange={(event) => onChange({ startAmMinute: startMinuteFromInput(event.target.value), startPmMinute: starts.startPmMinute })}
          step={300}
          type="time"
          value={startInputValue(starts.startAmMinute)}
        />
      </CrmField>
      {morning ? null : (
        <CrmField hint="Optional" htmlFor={pmId} label="Start PM">
          <input
            className={cn(crmInputClassName, "appearance-none")}
            disabled={locked}
            id={pmId}
            onChange={(event) => onChange({ startAmMinute: starts.startAmMinute, startPmMinute: startMinuteFromInput(event.target.value) })}
            step={300}
            type="time"
            value={startInputValue(starts.startPmMinute)}
          />
        </CrmField>
      )}
    </div>
  );
}

// ── The other activities ────────────────────────────────────────────────────────────────────────

/**
 * The day's other activities as TICK BOXES, one of each kind (2026-09-30): the old weekly plan ticks
 * them, and a meeting and travel on one day is an ordinary day. Each ticked kind opens its own line
 * under the boxes, with its half-day box and its own short note.
 *
 * The seven boxes sit in the module's seven-way grid (ui.tsx `CrmChoice` columns 7): two on a phone,
 * four from sm, all seven in one row at lg, and the last one spanning the gap the odd count leaves.
 */
function ActivityEditor({
  activities,
  dayName,
  idPrefix,
  locked,
  onChange,
}: {
  activities: ReadonlyArray<PlannedActivity>;
  dayName: string;
  idPrefix: string;
  locked: boolean;
  onChange: (activityType: PhoenixCrmDayActivity, next: Pick<PlannedActivity, "halfDay" | "note"> | null) => void;
}) {
  const byKind = new Map(activities.map((activity) => [activity.activityType, activity]));
  return (
    <div className="grid min-w-0 gap-3">
      <p className="break-words text-sm font-medium leading-6 text-slate-600">
        Tick every activity planned for {dayName} — a meeting, a conference, travel. They change no call rate.
      </p>
      <div
        aria-label={`Other activities on ${dayName}`}
        className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1"
        role="group"
      >
        {PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => {
          const chosen = byKind.get(entry.key) ?? null;
          return (
            <label
              className={cn(
                "flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 border px-3 py-2 text-sm font-black transition",
                chosen ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                locked && "cursor-not-allowed opacity-50",
              )}
              key={entry.key}
            >
              <input
                checked={chosen !== null}
                className="h-4 w-4 shrink-0 rounded-none accent-orange-600"
                disabled={locked}
                onChange={(event) => onChange(entry.key, event.target.checked ? { halfDay: false, note: null } : null)}
                type="checkbox"
              />
              <span className="min-w-0 break-words">{entry.label}</span>
            </label>
          );
        })}
      </div>
      {activities.map((activity) => {
        const noteId = `${idPrefix}-activity-${activity.activityType}-note`;
        const label = dayActivityLabel(activity.activityType);
        return (
          <div
            className="grid min-w-0 gap-3 border border-l-[3px] border-slate-200 border-l-orange-500 bg-white px-3 py-3 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,1.3fr)] sm:items-start"
            key={activity.activityType}
          >
            <p className="break-words text-sm font-black text-slate-950">{label}</p>
            <CrmCheck
              checked={activity.halfDay}
              disabled={locked}
              onChange={(halfDay) => onChange(activity.activityType, { halfDay, note: activity.note })}
            >
              Half day — the rest of the day is for visits
            </CrmCheck>
            <CrmField hint="Optional" htmlFor={noteId} label={`Short note · ${label}`}>
              <input
                className={crmInputClassName}
                disabled={locked}
                id={noteId}
                maxLength={PLANNED_ACTIVITY_NOTE_MAX}
                onChange={(event) => onChange(activity.activityType, { halfDay: activity.halfDay, note: event.target.value })}
                type="text"
                value={activity.note ?? ""}
              />
            </CrmField>
          </div>
        );
      })}
    </div>
  );
}

// ── A whole brick ───────────────────────────────────────────────────────────────────────────────

/**
 * The brick's own tick box, in the brick's heading (2026-09-30, the old weekly plan's brick headers):
 * checked, half-ticked or clear by `brickTickState`, and a press does what `brickTickPress` says. It
 * stands in the heading, not in a row, so the phone's cards and the desktop's table share the one box.
 */
function BrickTick({ dayName, label, onPress, state }: { dayName: string; label: string; onPress: () => void; state: BrickTickState }) {
  return (
    <label className={cn("flex min-w-0 cursor-pointer items-center gap-2.5", state.disabled && "cursor-not-allowed")}>
      <input
        aria-label={
          state.all
            ? `Take every customer in ${label} off ${dayName}`
            : state.takesOff
              ? `No room for the rest: take the ones placed in ${label} off ${dayName}`
              : `Plan every customer in ${label} on ${dayName}`
        }
        checked={state.all}
        className="h-5 w-5 shrink-0 rounded-none accent-orange-600"
        disabled={state.disabled}
        onChange={onPress}
        // "Half-ticked" is a property, not an attribute: it can only be set on the element itself.
        ref={(node) => {
          if (node) node.indeterminate = state.some;
        }}
        type="checkbox"
      />
      <span className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-700">{label}</span>
    </label>
  );
}

// ── A customer to tick ──────────────────────────────────────────────────────────────────────────

type TickRowProps = {
  dayName: string;
  idPrefix: string;
  locked: boolean;
  onToggle: (row: TickRow, next: boolean) => void;
  room: Record<PhoenixCrmDoctorListType, number>;
  row: TickRow;
};

function tickDisabled(row: TickRow, room: Record<PhoenixCrmDoctorListType, number>, locked: boolean): boolean {
  return locked || (!row.placed && room[row.listType] <= 0);
}

/**
 * "3 PM" — where this customer sits in his own list on the day, in the order the rep ticked him. It
 * appears the moment the box is checked and renumbers as he unticks (owner, 2026-09-30). AM and PM are
 * counted apart, as every figure in the module is.
 */
function OrderChip({ listType, position }: { listType: PhoenixCrmDoctorListType; position: number | null }) {
  if (position === null) return null;
  return (
    <span className="mr-1.5 inline-flex shrink-0 items-center border border-orange-300 bg-orange-100 px-1.5 py-px align-[0.1em] text-phx-2xs font-black uppercase tracking-[0.08em] text-orange-800">
      {position} {listType}
    </span>
  );
}

/** "Grade A · Hospital · Not validated yet" — the not-validated word small and inline, never its own row. */
function MetaLine({ parts, pending }: { parts: Array<string | null>; pending: boolean }) {
  const text = parts.filter(Boolean).join(" · ");
  return (
    <span className="mt-0.5 block break-words text-xs font-semibold leading-5 text-slate-500">
      {text}
      {pending ? <span className="font-bold text-orange-700">{text ? " · " : ""}{PENDING_PILL}</span> : null}
    </span>
  );
}

/** The saved place's brick and address, or iReports360's while he is not validated yet. */
function WhereLine({ where }: { where: string | null }) {
  if (!where) return null;
  return (
    <span className="mt-0.5 block break-words text-xs font-medium leading-5 text-slate-600" dir="auto">
      {where}
    </span>
  );
}

function RowPills({ row }: { row: TickRow }) {
  if (!row.noRamadanTime && !row.followUp) return null;
  return (
    <span className="mt-1 flex max-w-full flex-wrap gap-1">
      {/* His own commitment from his latest visit, due this week — the one thing on the row that asks him to act. */}
      {row.followUp ? <CrmPill tone="info">{row.followUp}</CrmPill> : null}
      {row.noRamadanTime ? <CrmPill tone="warn">No Ramadan hours</CrmPill> : null}
    </span>
  );
}

/** "Last seen Tue 29 Sept · 1 of 3 visits this month" — when he was last seen, and a validated customer's month. */
function SeenLine({ lastSeen }: { lastSeen: string | null }) {
  if (!lastSeen) return null;
  return <span className="mt-0.5 block break-words text-xs font-semibold leading-5 text-slate-600">{lastSeen}</span>;
}

/** iReports360's usual days, quietly, while he has no days and hours of his own — a hint, never a rule. */
function UsualLine({ usual }: { usual: string | null }) {
  if (!usual) return null;
  return <span className="mt-0.5 block break-words text-xs font-medium leading-5 text-slate-500">{usual}</span>;
}

/** A phone's row: the whole row is the tick box's target. */
function TickCard({ dayName, locked, onToggle, room, row }: TickRowProps) {
  const disabled = tickDisabled(row, room, locked);
  return (
    <div className={cn("min-w-0 px-3 py-3", row.placed ? "bg-orange-50/40" : "bg-white")}>
      <label className={cn("flex min-w-0 cursor-pointer items-start gap-3", disabled && "cursor-not-allowed")}>
        <input
          aria-label={`Plan ${row.name} on ${dayName}`}
          checked={row.placed}
          className="mt-0.5 h-5 w-5 shrink-0 rounded-none accent-orange-600"
          disabled={disabled}
          onChange={(event) => onToggle(row, event.target.checked)}
          type="checkbox"
        />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-sm font-black text-slate-950">
            <OrderChip listType={row.listType} position={row.position} />
            {row.name}
          </span>
          <MetaLine parts={[row.grade ? `Grade ${row.grade}` : "No grade", row.speciality, row.placeName]} pending={row.pending} />
          <WhereLine where={row.where} />
          <span className="mt-0.5 block break-words text-sm font-bold text-slate-800">{row.timings}</span>
          <UsualLine usual={row.usual} />
          <SeenLine lastSeen={row.lastSeen} />
          <RowPills row={row} />
        </span>
      </label>
    </div>
  );
}

/** A desktop row. */
function TickTableRows({ dayName, idPrefix, locked, onToggle, room, row }: TickRowProps) {
  const disabled = tickDisabled(row, room, locked);
  const tickId = `${idPrefix}-tick-${row.customerId}`;
  return (
    <tr className={row.placed ? "bg-orange-50/40" : undefined}>
      <td className={crmTdClassName}>
        <input
          aria-label={`Plan ${row.name} on ${dayName}`}
          checked={row.placed}
          className="mt-0.5 h-5 w-5 rounded-none accent-orange-600"
          disabled={disabled}
          id={tickId}
          onChange={(event) => onToggle(row, event.target.checked)}
          type="checkbox"
        />
      </td>
      <td className={crmTdClassName}>
        <label className={cn("block cursor-pointer", disabled && "cursor-not-allowed")} htmlFor={tickId}>
          <span className="block font-black text-slate-950">
            <OrderChip listType={row.listType} position={row.position} />
            {row.name}
          </span>
          <MetaLine parts={[row.grade ? `Grade ${row.grade}` : "No grade", row.placeName]} pending={row.pending} />
          <WhereLine where={row.where} />
          <SeenLine lastSeen={row.lastSeen} />
        </label>
        <RowPills row={row} />
      </td>
      <td className={crmTdClassName}>{row.speciality ?? "—"}</td>
      <td className={crmTdClassName}>
        {row.timings}
        <UsualLine usual={row.usual} />
      </td>
    </tr>
  );
}

// ── A day read back ─────────────────────────────────────────────────────────────────────────────

/**
 * A day nobody is changing: a day that has passed, a week sent or approved, or a manager's reading of
 * his rep's plan. The saved placements, AM and PM apart, grouped by brick.
 */
function PlannedDayView({
  day,
  idPrefix,
  only,
  showSpread,
  tints,
  weekdayName,
}: {
  day: PlanDayView;
  idPrefix: string;
  /** One list alone — a reviewer's step reads AM, then PM (owner, 2026-10-02). Unset: both. */
  only?: PhoenixCrmDoctorListType;
  showSpread: boolean;
  tints: ReadonlyMap<string, BrickTint>;
  weekdayName: string;
}) {
  const shown = only ? day.items.filter((item) => item.listType === only) : day.items;
  if (shown.length === 0) {
    return (
      <CrmBlock className="border-t border-slate-100" title={only ? `${only} customers` : "Customers"}>
        <p className="text-sm font-medium text-slate-500">{only ? `No ${only} customer was planned on this day.` : "Nothing was planned on this day."}</p>
      </CrmBlock>
    );
  }
  const sections = (["AM", "PM"] as const).filter((listType) => shown.some((item) => item.listType === listType));
  return (
    <>
      {sections.map((listType) => {
        const rows = day.items.filter((item) => item.listType === listType);
        const groups = clusterByBrick(rows, (item) => item.brickName, "alphabetical");
        return (
          <CrmBlock className="border-t border-slate-100" key={listType} title={`${listType} · ${countText(rows.length)} planned`}>
            <div className="grid min-w-0 gap-3">
              {groups.map((group) => {
                const tint = group.key === NO_BRICK_KEY ? NEUTRAL_TINT : (tints.get(group.key) ?? NEUTRAL_TINT);
                return (
                  <div className="min-w-0 border border-slate-200" key={group.key}>
                    <div className={cn("flex min-w-0 flex-wrap items-center justify-between gap-2 border-l-[3px] px-3 py-2", tint.bar, tint.fill)}>
                      <p className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-700">{group.label}</p>
                      <span className="text-xs font-bold text-slate-600">{countText(group.rows.length)} planned</span>
                    </div>
                    <CrmCardsOnPhone>
                      {group.rows.map((item) => (
                        <div className="min-w-0 bg-white px-3 py-3" key={item.customerId}>
                          <div className="flex min-w-0 items-start gap-3">
                            <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-orange-600" />
                            <div className="min-w-0 flex-1">
                              <p className="break-words text-sm font-black text-slate-950">{item.name}</p>
                              <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{customerMetaText(item)}</p>
                              <p className="mt-0.5 break-words text-sm font-bold text-slate-800">{item.windowsText}</p>
                              <SavedPills item={item} showSpread={showSpread} />
                              <SavedNote item={item} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </CrmCardsOnPhone>
                    <CrmTable columns={["34%", "24%", null]}>
                      <thead>
                        <tr>
                          <th className={crmThClassName} scope="col">
                            Customer
                          </th>
                          <th className={crmThClassName} scope="col">
                            Speciality
                          </th>
                          <th className={crmThClassName} scope="col">
                            Hours on {weekdayName}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.rows.map((item) => (
                          <tr key={`${idPrefix}-${item.customerId}`}>
                            <td className={crmTdClassName}>
                              <p className="font-black text-slate-950">{item.name}</p>
                              <p className="mt-0.5 text-xs text-slate-500">{item.grade ? `Grade ${item.grade}` : "No grade"}</p>
                              <SavedPills item={item} showSpread={showSpread} />
                            </td>
                            <td className={crmTdClassName}>{item.speciality ?? "—"}</td>
                            <td className={crmTdClassName}>
                              {item.windowsText}
                              <SavedNote item={item} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </CrmTable>
                  </div>
                );
              })}
            </div>
          </CrmBlock>
        );
      })}
    </>
  );
}

function SavedPills({ item, showSpread }: { item: PlanItemView; showSpread: boolean }) {
  // Only a reason an older plan really carries — no reason is asked any more (owner, 2026-09-30), so a
  // missing one is never shown as the rep's fault.
  const off = !item.receives && !item.pending && Boolean(item.exceptionLabel);
  if (!item.pending && !item.stale && !off && !(showSpread && item.isolated)) return null;
  return (
    <span className="mt-1 flex max-w-full flex-wrap gap-1">
      {item.stale ? <CrmPill tone="bad">Left the list</CrmPill> : null}
      {!item.stale && item.pending ? <span className="text-xs font-bold text-orange-700">{PENDING_PILL}</span> : null}
      {off ? <CrmPill tone="warn">{item.exceptionLabel}</CrmPill> : null}
      {showSpread && item.isolated ? (
        <CrmPill tone="warn">{item.nearestKm !== null ? `${item.nearestKm} km from the nearest` : "Far from the others"}</CrmPill>
      ) : null}
    </span>
  );
}

function SavedNote({ item }: { item: PlanItemView }) {
  if (item.receives || !item.exceptionNote) return null;
  return (
    <span className="mt-1 block whitespace-pre-line break-words text-xs font-semibold leading-5 text-slate-600">
      <span className="font-black text-slate-800">Rep&apos;s note: </span>
      {item.exceptionNote}
    </span>
  );
}
