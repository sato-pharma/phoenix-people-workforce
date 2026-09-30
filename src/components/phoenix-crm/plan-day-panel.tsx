"use client";

/**
 * Phoenix CRM — one day of the plan board (owner, 2026-09-29).
 *
 *   - At the top, the day's OTHER ACTIVITY: one a day — a meeting, a conference, a health day, a sales
 *     day, training, admin work or travel — for the whole day or half of it, with a short note.
 *   - Below it, the day's customers GROUPED BY BRICK WITH TICK BOXES, AM and PM apart (a Thursday is a
 *     morning, so it holds AM only). Ticking places the customer on the day and unticking takes him off.
 *     Each row shows his name, grade, speciality, brick and address, and a column of every day and hour
 *     he receives.
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

import type { ReactNode } from "react";
import { Check } from "lucide-react";

import { countText, dayLabel, dayLabelLong } from "@/components/phoenix-crm/format";
import type { BrickTint } from "@/components/phoenix-crm/brick-tints";
import { customerMetaText, matchesWords, PENDING_PILL } from "@/components/phoenix-crm/labels";
import { PlanFilterBar } from "@/components/phoenix-crm/plan-filter-bar";
import {
  CrmBlock,
  CrmCardsOnPhone,
  CrmFillBar,
  CrmCheck,
  CrmChoice,
  CrmField,
  CrmNote,
  CrmPill,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmThClassName,
  type CrmChoiceOption,
} from "@/components/phoenix-crm/ui";
import { clusterByBrick, NO_BRICK_KEY } from "@/lib/phoenix-crm/brick-groups";
import { weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { PHOENIX_CRM_DAY_ACTIVITIES, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { filterPlannerCustomers, type DoctorFilter } from "@/lib/phoenix-crm/plan-filters";
import type { PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import {
  customerOnDay,
  dayCounts,
  dayFullness,
  indexCustomers,
  PLANNED_ACTIVITY_NOTE_MAX,
  resolveDayRows,
  roomOnDay,
  type DailyCaps,
  type PlannedActivity,
} from "@/lib/phoenix-crm/plan-week-draft";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import { PHOENIX_CRM_WEEKDAY_NAMES, weekTimingsText } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import type { PlanDayView, PlanItemView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

const NEUTRAL_TINT: BrickTint = { bar: "border-l-slate-300", fill: "bg-slate-50" };

/** One customer the rep may tick on the day. */
type TickRow = {
  customerId: string;
  name: string;
  listType: PhoenixCrmListType;
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
};

const NO_HOURS = "No days and hours yet";

function compareTickRows(left: TickRow, right: TickRow): number {
  return (
    Number(right.receives) - Number(left.receives) ||
    (left.startMinute ?? 9999) - (right.startMinute ?? 9999) ||
    left.name.localeCompare(right.name)
  );
}

/** Every word a customer can be found by. */
function customerWords(customer: PlannerCustomer): Array<string | null> {
  return [customer.name, customer.speciality, ...customer.places.flatMap((place) => [place.brick, place.label, place.zone])];
}

export function PlanDayPanel({
  activity,
  caps,
  copyMenu,
  customers,
  day,
  editing,
  filter,
  filterOptions,
  idPrefix,
  items,
  locked,
  onActivity,
  onFilter,
  onPlace,
  onQuery,
  onRemove,
  query,
  showSpread,
  suggestMenu,
  tints,
  today,
}: {
  /** The day's other activity as the draft holds it (editing), or null. */
  activity: PlannedActivity | null;
  caps: DailyCaps;
  /** "Copy a day", when the rep may change this day. */
  copyMenu?: ReactNode;
  customers: ReadonlyArray<PlannerCustomer>;
  day: PlanDayView;
  /** The rep is changing this day: its customers come from the draft and tick on and off. */
  editing: boolean;
  filter: DoctorFilter;
  filterOptions: {
    bricks: ReadonlyArray<{ value: string; label: string }>;
    grades: ReadonlyArray<PhoenixCrmGrade>;
    specialities: ReadonlyArray<string>;
  };
  idPrefix: string;
  /** The week's drafted placements. */
  items: ReadonlyArray<PlanItemDraft>;
  locked: boolean;
  onActivity: (next: Omit<PlannedActivity, "planDate"> | null) => void;
  onFilter: (next: DoctorFilter) => void;
  onPlace: (item: PlanItemDraft) => void;
  onQuery: (next: string) => void;
  onRemove: (customerId: string) => void;
  query: string;
  /** A reviewer's reading: the day's spread may show. Never true for a rep on his own plan. */
  showSpread: boolean;
  /** "Suggest this day", on the rep's own plan — disabled, with its reason, when the day cannot change. */
  suggestMenu?: ReactNode;
  tints: ReadonlyMap<string, BrickTint>;
  today: string;
}) {
  const weekday = weekdayOfIsoDay(day.date);
  const weekdayName = PHOENIX_CRM_WEEKDAY_NAMES[weekday];
  const dayName = dayLabel(day.date);
  const morning = !day.listTypes.includes("PM");
  const byId = indexCustomers(customers);
  // Full: the day's rail turns emerald and the colour blooms off it (owner, 2026-09-30).
  const drafted = editing ? resolveDayRows(day, items, byId) : [];
  const full = dayFullness(editing ? dayCounts(drafted) : day.counts, caps, day.listTypes);

  const header = (
    <CrmBlock
      actions={
        <span className="flex max-w-full flex-wrap gap-1">
          {day.date === today ? <CrmPill tone="info">Today</CrmPill> : null}
          {!day.editable ? <CrmPill>Passed</CrmPill> : null}
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
      {!day.editable || morning || day.ramadan ? (
        <div className="mt-3 grid min-w-0 gap-2">
          {!day.editable ? <CrmNote>This day has passed. It shows what was planned.</CrmNote> : null}
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
        <CrmBlock className="border-t border-slate-100" title="Other activity">
          {day.activity ? (
            <p className="break-words text-sm font-bold text-slate-800">
              {day.activity.activityLabel}
              {day.activity.halfDay ? " · half day" : " · whole day"}
              {day.activity.note ? <span className="block break-words text-xs font-semibold leading-5 text-slate-500">{day.activity.note}</span> : null}
            </p>
          ) : (
            <p className="text-sm font-medium text-slate-500">No other activity planned.</p>
          )}
        </CrmBlock>
        <PlannedDayView day={day} idPrefix={idPrefix} showSpread={showSpread} tints={tints} weekdayName={weekdayName} />
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
  const seen: Record<PhoenixCrmListType, number> = { AM: 0, PM: 0 };
  for (const row of onTheDay) {
    seen[row.listType] += 1;
    order.set(row.customerId, seen[row.listType]);
  }
  const allowed = new Set(filterPlannerCustomers(customers, { ...filter, ramadan: day.ramadan }).map((customer) => customer.customerId));

  const tickRows: TickRow[] = [];
  let offered = 0;
  for (const customer of customers) {
    const placed = placedById.get(customer.customerId) ?? null;
    if (!placed && !day.listTypes.includes(customer.listType)) continue;
    const fit = customerOnDay(customer, day.date, day.ramadan, placed?.placeId ?? null);
    if (!fit) continue;
    offered += 1;
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
    tickRows.push({
      customerId: customer.customerId,
      name: customer.name,
      listType: customer.listType,
      grade: customer.grade,
      speciality: customer.speciality,
      pending: customer.pending,
      brick,
      placeName: customer.places.length > 1 && fit.place ? (fit.place.label ?? fit.place.zone ?? `Place ${position + 1}`) : null,
      placeId: fit.placeId,
      where: [brick ? `Brick ${brick}` : null, area, address].filter(Boolean).join(" · ") || null,
      timings: timings || NO_HOURS,
      receives: fit.receives,
      noRamadanTime: fit.receives && fit.noRamadanTime,
      startMinute: fit.windows[0]?.startMinute ?? null,
      placed: placed !== null,
      position: placed ? (order.get(customer.customerId) ?? null) : null,
    });
  }
  const shownUnplaced = tickRows.filter((row) => !row.placed).length;
  const filtering = query.trim() !== "" || filter.session !== "all" || filter.brick !== null || filter.grade !== null || filter.speciality !== null || filter.weekday !== null;
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

  const tickRowProps = { dayName, idPrefix, locked, onToggle: toggle, room };

  return (
    <div className="min-w-0">
      {header}

      <CrmBlock className="border-t border-slate-100" title="Other activity">
        <ActivityEditor activity={activity} dayName={dayName} idPrefix={`${idPrefix}-${day.date}`} locked={locked} onChange={onActivity} />
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
        <PlanFilterBar
          bricks={filterOptions.bricks}
          filter={filter}
          grades={filterOptions.grades}
          idPrefix={`${idPrefix}-day`}
          locked={locked}
          onChange={onFilter}
          onQueryChange={onQuery}
          query={query}
          specialities={filterOptions.specialities}
        />
        <p className="mt-3 break-words text-sm font-semibold leading-6 text-slate-600">
          {morning
            ? `${countText(counts.AM)} of ${countText(caps.amDailyCap)} AM placed.`
            : `${countText(counts.AM)} of ${countText(caps.amDailyCap)} AM and ${countText(counts.PM)} of ${countText(caps.pmDailyCap)} PM placed.`}{" "}
          {filtering
            ? `${countText(shownUnplaced)} more match the filter. Ticked customers always show.`
            : `Tick a customer to place him on ${dayName}.`}
        </p>
      </CrmBlock>

      {offered === 0 && gone.length === 0 ? (
        <CrmBlock className="border-t border-slate-100">
          <p className="text-sm font-medium text-slate-500">{morning ? "No AM customer to place yet." : "No customer to place yet."} Customers on your List show here.</p>
        </CrmBlock>
      ) : null}

      {offered > 0
        ? sections.map((listType) => {
            const rows = tickRows.filter((row) => row.listType === listType).sort(compareTickRows);
            const cap = listType === "AM" ? caps.amDailyCap : caps.pmDailyCap;
            const groups = clusterByBrick(rows, (row) => row.brick, "alphabetical");
            return (
              <CrmBlock className="border-t border-slate-100" key={listType} title={`${listType} · ${countText(counts[listType])} of ${countText(cap)} placed`}>
                {/* The day filling up, in Today's own shape: orange as it fills, emerald at the cap. */}
                <CrmFillBar
                  full={full[listType]}
                  label={`${listType} on ${dayName}: ${counts[listType]} of ${cap} placed`}
                  of={cap}
                  value={counts[listType]}
                />
                <div className="mt-3" />
                {!day.listTypes.includes(listType) ? (
                  <CrmNote className="mb-3" tone="bad">
                    {dayName} is a morning for AM only. Take these off it.
                  </CrmNote>
                ) : null}
                {groups.length === 0 ? (
                  <p className="text-sm font-medium text-slate-500">No {listType} customer matches the filter. Clear it to see them all.</p>
                ) : (
                  <div className="grid min-w-0 gap-3">
                    {groups.map((group) => {
                      const tint = group.key === NO_BRICK_KEY ? NEUTRAL_TINT : (tints.get(group.key) ?? NEUTRAL_TINT);
                      const ticked = group.rows.filter((row) => row.placed).length;
                      return (
                        <div className="min-w-0 border border-slate-200" key={group.key}>
                          <div className={cn("flex min-w-0 flex-wrap items-center justify-between gap-2 border-l-[3px] px-3 py-2", tint.bar, tint.fill)}>
                            <p className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-700">{group.label}</p>
                            <span className="text-xs font-bold text-slate-600">
                              {countText(ticked)} of {countText(group.rows.length)} placed
                            </span>
                          </div>
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
          })
        : null}

      {gone.length > 0 ? (
        <CrmBlock className="border-t border-slate-100" title="No longer on the list">
          <CrmNote tone="warn">
            {gone.map((row) => row.name).join(", ")} {gone.length === 1 ? "was" : "were"} planned on {dayName} before leaving your list. They come off the plan
            when you save.
          </CrmNote>
        </CrmBlock>
      ) : null}
    </div>
  );
}

// ── The other activity ──────────────────────────────────────────────────────────────────────────

function ActivityEditor({
  activity,
  dayName,
  idPrefix,
  locked,
  onChange,
}: {
  activity: PlannedActivity | null;
  dayName: string;
  idPrefix: string;
  locked: boolean;
  onChange: (next: Omit<PlannedActivity, "planDate"> | null) => void;
}) {
  const noteId = `${idPrefix}-activity-note`;
  const options: ReadonlyArray<CrmChoiceOption<"none" | PhoenixCrmDayActivity>> = [
    { value: "none", label: "None", disabled: locked },
    ...PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => ({ value: entry.key, label: entry.label, disabled: locked })),
  ];
  return (
    <div className="grid min-w-0 gap-3">
      <p className="break-words text-sm font-medium leading-6 text-slate-600">A meeting, a conference or another activity planned for {dayName}. It changes no call rate.</p>
      <CrmChoice
        columns={4}
        label={`Other activity on ${dayName}`}
        onChange={(next) =>
          onChange(next === "none" ? null : { activityType: next, halfDay: activity?.halfDay ?? false, note: activity?.note ?? null })
        }
        options={options}
        value={activity?.activityType ?? "none"}
      />
      {activity ? (
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 sm:items-start">
          <CrmCheck
            checked={activity.halfDay}
            disabled={locked}
            onChange={(halfDay) => onChange({ activityType: activity.activityType, halfDay, note: activity.note })}
          >
            Half day — the rest of the day is for visits
          </CrmCheck>
          <CrmField hint="Optional" htmlFor={noteId} label="Short note">
            <input
              className={crmInputClassName}
              disabled={locked}
              id={noteId}
              maxLength={PLANNED_ACTIVITY_NOTE_MAX}
              onChange={(event) => onChange({ activityType: activity.activityType, halfDay: activity.halfDay, note: event.target.value })}
              type="text"
              value={activity.note ?? ""}
            />
          </CrmField>
        </div>
      ) : null}
    </div>
  );
}

// ── A customer to tick ──────────────────────────────────────────────────────────────────────────

type TickRowProps = {
  dayName: string;
  idPrefix: string;
  locked: boolean;
  onToggle: (row: TickRow, next: boolean) => void;
  room: Record<PhoenixCrmListType, number>;
  row: TickRow;
};

function tickDisabled(row: TickRow, room: Record<PhoenixCrmListType, number>, locked: boolean): boolean {
  return locked || (!row.placed && room[row.listType] <= 0);
}

/**
 * "3 PM" — where this customer sits in his own list on the day, in the order the rep ticked him. It
 * appears the moment the box is checked and renumbers as he unticks (owner, 2026-09-30). AM and PM are
 * counted apart, as every figure in the module is.
 */
function OrderChip({ listType, position }: { listType: PhoenixCrmListType; position: number | null }) {
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
  if (!row.noRamadanTime) return null;
  return (
    <span className="mt-1 flex max-w-full flex-wrap gap-1">
      <CrmPill tone="warn">No Ramadan hours</CrmPill>
    </span>
  );
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
        </label>
        <RowPills row={row} />
      </td>
      <td className={crmTdClassName}>{row.speciality ?? "—"}</td>
      <td className={crmTdClassName}>{row.timings}</td>
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
  showSpread,
  tints,
  weekdayName,
}: {
  day: PlanDayView;
  idPrefix: string;
  showSpread: boolean;
  tints: ReadonlyMap<string, BrickTint>;
  weekdayName: string;
}) {
  if (day.items.length === 0) {
    return (
      <CrmBlock className="border-t border-slate-100" title="Customers">
        <p className="text-sm font-medium text-slate-500">Nothing was planned on this day.</p>
      </CrmBlock>
    );
  }
  const sections = (["AM", "PM"] as const).filter((listType) => day.items.some((item) => item.listType === listType));
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
