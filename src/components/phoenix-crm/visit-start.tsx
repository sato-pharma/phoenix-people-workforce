"use client";

/**
 * Phoenix CRM — the first screen of Add visit: what is he recording?
 *
 * Owner, 2026-09-29: the first choice is one of eleven — Planned · Unplanned · Meeting · Conference ·
 * Health day · Sales day · Training · Admin work · Travel · RTD · Group meeting. Big targets, one tap each (Golden Rule #1,
 * the EASY half): he is standing at a door with the phone in one hand.
 *
 *   - Planned offers only the customers on today's SENT plan.
 *   - Unplanned replaces the old CRM's "Campaign" and splits in two: out of plan (his list, not today's
 *     plan — a reason, then his manager and SFE approve it) and out of list (someone not on his list at
 *     all — validated on the spot, and it counts once the customer is added).
 *   - Pharmacy (owner, 2026-10-03: "It is visit is logged normally") offers the pharmacies on his list
 *     and goes straight to the form: no plan, no reason, no approval and no validation, and it counts
 *     the moment he logs it.
 *   - The nine others are the day's ACTIVITY, a record only: it moves no call rate, no coverage and no
 *     plan-against-actual (owner, 2026-09-26). They go through the ONE day-activity save below, which the
 *     day screen's own block uses too — there is no second way to write a day.
 */

import { useState } from "react";
import {
  CalendarCheck,
  Car,
  ClipboardList,
  GraduationCap,
  HeartPulse,
  ListX,
  MessagesSquare,
  Pill,
  Presentation,
  Route,
  ShoppingBag,
  UserSearch,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { crmPost, useCrmAction } from "@/components/phoenix-crm/api";
import { countText } from "@/components/phoenix-crm/format";
import { OffPlanAllowanceCard } from "@/components/phoenix-crm/offplan-allowance";
import { CrmBackBar, CrmBlock, CrmButton, CrmCheck, CrmField, CrmNote, CrmPanel, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { DAY_ACTIVITY_NOTE_MAX, PHOENIX_CRM_DAY_ACTIVITIES, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import type { OffPlanAllowance } from "@/lib/phoenix-crm/offplan-cap-rules";
import { plannedStartEmptyNote } from "@/lib/phoenix-crm/today-rules";
import type { DayActivityRow, VisitFormView } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** What a day was, when it was not only calls. Null clears the day back to a field day. */
export type DayActivityChoice = { activityType: PhoenixCrmDayActivity; halfDay: boolean; note: string | null };

type DayActivitySaved = { cleared: boolean; activity: DayActivityRow | null };

/**
 * The ONE write of today's activity, for both places that make it: this screen and the day screen's
 * own block. The date is never sent — the server files it under his visit day, which runs to 02:00.
 */
export function saveDayActivity(seatId: string, test: boolean, choice: DayActivityChoice | null): Promise<DayActivitySaved> {
  const body = choice === null ? { clear: true, seatId, test } : { ...choice, seatId, test };
  return crmPost<DayActivitySaved>("/api/phoenix-crm/day-activities", body, "saved");
}

const ACTIVITY_ICONS: Record<PhoenixCrmDayActivity, LucideIcon> = {
  meeting: Users,
  conference: Presentation,
  health_day: HeartPulse,
  sales_day: ShoppingBag,
  training: GraduationCap,
  admin_work: ClipboardList,
  travel: Car,
  rtd: MessagesSquare,
  group_meeting: UsersRound,
};

/** The owner's own word on this screen ("Travel"); the record keeps the module's label. */
function startLabel(key: PhoenixCrmDayActivity, label: string): string {
  return key === "travel" ? "Travel" : label;
}

/**
 * One big target. A CrmButton, stretched: the whole card is the thumb's target. `compact` is for the
 * seven day activities — still far past the 44px a thumb needs, but a notch lower than the two visit
 * targets, so the page reads visits first and the day's record second.
 */
function StartTarget({
  compact = false,
  disabled = false,
  icon: Icon,
  label,
  note,
  onClick,
  primary = false,
}: {
  compact?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  note?: string | null;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <CrmButton
      className={cn("w-full flex-col items-start justify-center gap-1 text-left", compact ? "min-h-16" : "min-h-20", primary ? null : "text-slate-800")}
      disabled={disabled}
      onClick={onClick}
      variant={primary ? "primary" : "secondary"}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden className="h-5 w-5 shrink-0" />
        <span className="min-w-0 break-words text-base font-black">{label}</span>
      </span>
      {note ? (
        <span className={cn("min-w-0 break-words text-xs font-semibold", primary ? "text-orange-50" : "text-slate-500")}>{note}</span>
      ) : null}
    </CrmButton>
  );
}

function ActivityEntry({
  activity,
  current,
  onCancel,
  onSaved,
  seatId,
  test,
}: {
  activity: PhoenixCrmDayActivity;
  current: DayActivityRow | null;
  onCancel: () => void;
  onSaved: (saved: DayActivityRow | null, label: string) => void;
  seatId: string;
  test: boolean;
}) {
  const action = useCrmAction();
  const [halfDay, setHalfDay] = useState(false);
  const [note, setNote] = useState("");
  const entry = PHOENIX_CRM_DAY_ACTIVITIES.find((option) => option.key === activity);
  const label = entry ? startLabel(entry.key, entry.label) : activity;
  const busy = action.busy !== null;

  async function save() {
    const saved = await action.run("day-activity", () => saveDayActivity(seatId, test, { activityType: activity, halfDay, note: note.trim() || null }));
    if (saved !== undefined) onSaved(saved.activity, label);
  }

  return (
    <CrmBlock title={label}>
      <div className="grid min-w-0 gap-3">
        {current && current.activityType !== activity ? (
          <CrmNote tone="info">Today is recorded as {current.activityLabel}. Saving records it as {label} instead.</CrmNote>
        ) : null}
        <CrmCheck checked={halfDay} disabled={busy} onChange={setHalfDay}>
          Half day — the other half was field work
        </CrmCheck>
        <CrmField hint={`Optional · ${note.trim().length} of ${DAY_ACTIVITY_NOTE_MAX} characters`} htmlFor="phoenix-crm-day-activity-note" label="Note">
          <textarea
            className={crmTextareaClassName}
            dir="auto"
            disabled={busy}
            id="phoenix-crm-day-activity-note"
            maxLength={DAY_ACTIVITY_NOTE_MAX}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            value={note}
          />
        </CrmField>
        <p className="text-xs font-semibold text-slate-500">Recorded so your manager can see the day. It changes none of your figures.</p>
        {action.error ? (
          <CrmNote title="Not saved" tone="bad">
            {action.error}
          </CrmNote>
        ) : null}
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={busy} onClick={() => void save()} variant="primary">
            Save {label}
          </CrmButton>
          <CrmButton disabled={busy} onClick={onCancel}>
            Back
          </CrmButton>
        </div>
      </div>
    </CrmBlock>
  );
}

export function VisitStart({
  canSetDayActivity,
  dayActivity,
  onActivitySaved,
  onBack,
  onPharmacy,
  onPlanned,
  onUnplanned,
  pharmacyCount,
  planToday,
  plannedCount,
  seatId,
  test,
}: {
  /**
   * The territory's own rep describes his day, and so does a district manager (on his own seat, never
   * the rep's — owner, 2026-10-20); anyone else entering a visit for him does not. Null while
   * the day is still loading — the portal's "+ Add visit" opens this screen before the day has
   * answered, and saying "recorded by the territory's own rep" to that very rep was wrong (owner walk,
   * 2026-09-30).
   */
  canSetDayActivity: boolean | null;
  /** What today is already recorded as, if anything. */
  dayActivity: DayActivityRow | null;
  onActivitySaved: (activity: DayActivityRow | null, label: string) => void;
  onBack: () => void;
  onPharmacy: () => void;
  onPlanned: () => void;
  onUnplanned: () => void;
  /** How many pharmacies are on his list; null while the form is still loading. */
  pharmacyCount: number | null;
  /**
   * Today's plan as it stands — its status and the stops he has SAVED for today, sent or not. Null
   * while the form is still loading. It is what lets the empty note say WHY (owner, 2026-10-01).
   */
  planToday: VisitFormView["planToday"] | null;
  /** How many customers today's sent plan holds; null while the form is still loading. */
  plannedCount: number | null;
  seatId: string;
  test: boolean;
}) {
  const [activity, setActivity] = useState<PhoenixCrmDayActivity | null>(null);

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Visits" onBack={onBack} title="Add visit" />
      {activity ? (
        <ActivityEntry
          activity={activity}
          current={dayActivity}
          onCancel={() => setActivity(null)}
          onSaved={onActivitySaved}
          seatId={seatId}
          test={test}
        />
      ) : (
        <>
          {/* Two groups, in the order he reaches for them: a visit (almost every tap), then the day's
              record. Planned spans the phone's width — the target he hits most is the biggest one. */}
          <CrmBlock title="A customer visit">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <StartTarget
                icon={CalendarCheck}
                label="Planned visit"
                note={
                  plannedCount === null || planToday === null
                    ? "A customer on today's plan"
                    : plannedCount === 0
                      ? // Never a bare "nobody": it says whether the plan is a draft, was sent back, or
                        // was never started, and how many he has already placed (today-rules.ts).
                        plannedStartEmptyNote(planToday)
                      : `${countText(plannedCount)} on today's plan`
                }
                onClick={onPlanned}
                primary
              />
              <StartTarget icon={Route} label="Unplanned visit" note="Out of plan, or out of list" onClick={onUnplanned} />
              <StartTarget
                icon={Pill}
                label="Pharmacy visit"
                note={pharmacyCount === null || pharmacyCount === 0 ? "No plan and no approval" : `No plan and no approval · ${countText(pharmacyCount)} on your list`}
                onClick={onPharmacy}
              />
            </div>
          </CrmBlock>
          <CrmBlock className="border-t border-slate-100" title="Or record the day as">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
              {PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => (
                <StartTarget
                  compact
                  disabled={canSetDayActivity !== true}
                  icon={ACTIVITY_ICONS[entry.key]}
                  key={entry.key}
                  label={startLabel(entry.key, entry.label)}
                  note={dayActivity?.activityType === entry.key ? `Recorded today${dayActivity.halfDay ? " · half day" : ""}` : null}
                  onClick={() => setActivity(entry.key)}
                />
              ))}
            </div>
            {canSetDayActivity === false ? (
              <p className="mt-3 text-xs font-semibold text-slate-500">The day&apos;s activity is recorded by the territory&apos;s own rep.</p>
            ) : canSetDayActivity === null ? (
              <p className="mt-3 text-xs font-semibold text-slate-500">Opening your day.</p>
            ) : (
              <p className="mt-3 text-xs font-semibold text-slate-500">A record so your manager can see the day. It changes none of your figures.</p>
            )}
          </CrmBlock>
        </>
      )}
    </CrmPanel>
  );
}

/**
 * Unplanned: which way off the plan (owner, 2026-09-29). Out of plan is someone on his list; out of
 * list is someone who is not on it at all.
 */
export function UnplannedChoice({
  offPlan,
  onBack,
  onOutOfList,
  onOutOfPlan,
  outOfPlanCount,
  outOfPlanOpenCount,
  voice,
  waitingCount,
}: {
  /** What the out-of-plan allowance still holds today and this week (owner, 2026-10-10). */
  offPlan: OffPlanAllowance;
  onBack: () => void;
  onOutOfList: () => void;
  onOutOfPlan: () => void;
  /** Customers on his list and not on today's plan. */
  outOfPlanCount: number;
  /** Of those, the ones the allowance still lets him take out of plan. */
  outOfPlanOpenCount: number;
  voice: "rep" | "manager";
  /** Customers he met outside his list, waiting to be added. */
  waitingCount: number;
}) {
  return (
    <CrmPanel>
      <CrmBackBar backLabel="Add visit" onBack={onBack} title="Unplanned visit" />
      <CrmBlock title="Who did you visit?">
        <OffPlanAllowanceCard allowance={offPlan} className="mb-3" voice={voice} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <StartTarget
            disabled={outOfPlanOpenCount === 0 && outOfPlanCount > 0}
            icon={UserSearch}
            label="Out of plan"
            note={
              outOfPlanOpenCount === 0 && outOfPlanCount > 0
                ? "No place is left for a new customer. Plan the next one for another day."
                : `Someone on your list who is not on today's plan · ${countText(outOfPlanCount)} on your list`
            }
            onClick={onOutOfPlan}
            primary
          />
          <StartTarget
            icon={ListX}
            label="Out of list"
            note={waitingCount > 0 ? `Someone not on your list · ${countText(waitingCount)} met before` : "Someone not on your list at all"}
            onClick={onOutOfList}
          />
        </div>
        <p className="mt-3 text-xs font-semibold leading-5 text-slate-500">
          Out of plan counts once your manager and SFE approve it. Out of list counts once the customer is added to your list.
        </p>
      </CrmBlock>
    </CrmPanel>
  );
}
