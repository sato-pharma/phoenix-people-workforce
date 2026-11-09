"use client";

/**
 * Phoenix CRM — the daily plan, a section of the Reports tab (owner, 2026-09-30: "build the daily plan
 * report").
 *
 * iReports360's Daily Plan, from Phoenix CRM's own plans: one territory, day by day. Each day opens
 * with how its plan stands, its Start AM and Start PM and its other activities; then its AM customers
 * and its PM customers — two groups, never one list and never a total — each with where he is, his
 * hours that day and whether he was seen. The rules are pure (src/lib/phoenix-crm/daily-plan-report.ts);
 * this only lays them out: one table per day on a desktop, cards on a phone, nothing that scrolls
 * sideways.
 *
 * It keeps its OWN days, apart from the tab's other sections: a plan is about the days AHEAD, which
 * the shared period refuses, so its quick picks run forward (tomorrow, next week) and its date inputs
 * reach the last day a rep can plan.
 *
 * A rep reads his own plan here. Nothing on it is a distance, a flag or a check (Golden Rule #1).
 */

import { Fragment, useState, type ReactNode } from "react";

import type { CrmResource } from "@/components/phoenix-crm/api";
import { CustomerPhoneLink } from "@/components/phoenix-crm/customer-phone";
import { countText, dayLabel, dayLabelLong, dayLabelWithYear, plural } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmCard,
  CrmCardsOnPhone,
  CrmChoice,
  CrmEmpty,
  CrmFacts,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPill,
  CrmSaveError,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmThClassName,
  type CrmChoiceOption,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import {
  DAILY_PLAN_PRESETS,
  dailyPlanActivityText,
  dailyPlanCustomerFacts,
  dailyPlanDayIsEmpty,
  dailyPlanOffPlanText,
  dailyPlanPeriodProblem,
  dailyPlanPresetPeriod,
  dailyPlanStateLabel,
  dailyPlanVisitText,
  dailyPlanWhereText,
  lastPlannableDay,
  type DailyPlanCustomer,
  type DailyPlanDay,
  type DailyPlanPeriod,
  type DailyPlanPreset,
  type DailyPlanReportView,
  type DailyPlanState,
  type DailyPlanVisitStatus,
} from "@/lib/phoenix-crm/daily-plan-report";
import { LEAVE_UNREAD_NOTE } from "@/lib/phoenix-crm/plan-leave";
import { REPORT_MAX_DAYS } from "@/lib/phoenix-crm/report-rules";
import type { PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";
import { cn } from "@/lib/utils";

// ── Its own days ────────────────────────────────────────────────────────────────────────────────

export type DailyPlanDays = {
  preset: DailyPlanPreset | null;
  period: DailyPlanPeriod;
  presetLabel: string | null;
  choosePreset: (next: DailyPlanPreset) => void;
  chooseDays: (next: DailyPlanPeriod) => void;
};

/** The days the section reads — this field week, Saturday to Thursday, until he picks others. */
export function useDailyPlanDays(today: string): DailyPlanDays {
  const [preset, setPreset] = useState<DailyPlanPreset | null>("this_week");
  const [period, setPeriod] = useState<DailyPlanPeriod>(() => dailyPlanPresetPeriod("this_week", today));
  return {
    preset,
    period,
    presetLabel: preset ? (DAILY_PLAN_PRESETS.find((option) => option.value === preset)?.label ?? null) : null,
    choosePreset(next) {
      setPreset(next);
      setPeriod(dailyPlanPresetPeriod(next, today));
    },
    chooseDays(next) {
      setPreset(null);
      setPeriod(next);
    },
  };
}

/** "Tue 29 Sept", or "Sat 26 Sept – Thu 1 Oct". */
function shortRange(period: DailyPlanPeriod): string {
  return period.from === period.to ? dayLabel(period.from) : `${dayLabel(period.from)} – ${dayLabel(period.to)}`;
}

/** "This week · Sat 26 Sept – Thu 1 Oct 2026", the phone's one-line summary of the folded filters. */
export function dailyPlanDaysSummary(days: DailyPlanDays): string {
  const range = days.period.from === days.period.to ? dayLabelWithYear(days.period.from) : `${dayLabel(days.period.from)} – ${dayLabelWithYear(days.period.to)}`;
  return days.presetLabel ? `${days.presetLabel} · ${range}` : range;
}

/** The quick picks and the two dates, in the place the other sections keep theirs. */
export function DailyPlanDaysFilter({ days, firstDay, idPrefix, today }: { days: DailyPlanDays; firstDay: string; idPrefix: string; today: string }) {
  const lastDay = lastPlannableDay(today);
  const problem = dailyPlanPeriodProblem(days.period, today);
  const options: Array<CrmChoiceOption<DailyPlanPreset>> = DAILY_PLAN_PRESETS.map(({ label, value }) => {
    const range = dailyPlanPresetPeriod(value, today);
    const beforeOpening = range.to < firstDay;
    return { value, label, note: beforeOpening ? "Before Phoenix CRM opened" : shortRange(range), disabled: beforeOpening };
  });
  return (
    <>
      <CrmField label="Days">
        <CrmChoice columns={3} label="Days" onChange={days.choosePreset} options={options} value={days.preset} />
      </CrmField>
      <div className="grid min-w-0 grid-cols-2 gap-3 md:max-w-md">
        <CrmField htmlFor={`${idPrefix}-daily-from`} label="From">
          <input
            className={cn(crmInputClassName, "appearance-none")}
            id={`${idPrefix}-daily-from`}
            max={lastDay}
            min={firstDay}
            onChange={(event) => days.chooseDays({ from: event.target.value, to: days.period.to })}
            type="date"
            value={days.period.from}
          />
        </CrmField>
        <CrmField htmlFor={`${idPrefix}-daily-to`} label="To">
          <input
            className={cn(crmInputClassName, "appearance-none")}
            id={`${idPrefix}-daily-to`}
            max={lastDay}
            min={firstDay}
            onChange={(event) => days.chooseDays({ from: days.period.from, to: event.target.value })}
            type="date"
            value={days.period.to}
          />
        </CrmField>
      </div>
      <p className={cn("break-words text-xs font-semibold leading-5", problem ? "text-rose-700" : "text-slate-500")}>
        {problem ?? `Up to ${countText(REPORT_MAX_DAYS)} days at a time, as far ahead as ${dayLabelWithYear(lastDay)} — the last day a rep can plan today.`}
      </p>
    </>
  );
}

// ── The report ──────────────────────────────────────────────────────────────────────────────────

const STATE_TONES: Record<DailyPlanState, PillTone> = {
  approved: "good",
  submitted: "info",
  returned: "warn",
  draft: "neutral",
  not_sent: "warn",
  none: "neutral",
};

const VISIT_TONES: Record<DailyPlanVisitStatus, PillTone> = {
  visited: "good",
  not_visited: "warn",
  not_yet: "info",
  ahead: "neutral",
  // A fact HR recorded about him, never a shortfall — so never the warning colour "Not visited" wears.
  on_leave: "neutral",
};

const SENT_STATES: ReadonlyArray<DailyPlanState> = ["submitted", "approved", "returned"];

/** "Grade A · Paediatrics", "No grade". */
function customerMeta(customer: DailyPlanCustomer): string {
  return [customer.grade ? `Grade ${customer.grade}` : "No grade", customer.speciality].filter((part): part is string => Boolean(part)).join(" · ");
}

/** The place's own name and its address on one line, when there is either. */
function placeLine(customer: DailyPlanCustomer): string | null {
  const parts = [customer.placeLabel, customer.address].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function VisitPill({ customer }: { customer: DailyPlanCustomer }) {
  return <CrmPill tone={VISIT_TONES[customer.status]}>{dailyPlanVisitText(customer.status, customer.visitedMinute)}</CrmPill>;
}

function listsOf(day: DailyPlanDay): Array<{ listType: PhoenixCrmDoctorListType; customers: DailyPlanCustomer[] }> {
  return (["AM", "PM"] as const)
    .map((listType) => ({ listType, customers: listType === "AM" ? day.am : day.pm }))
    .filter((list) => day.listTypes.includes(list.listType) || list.customers.length > 0);
}

/** "AM · 3 customers" — each list counted on its own, never beside a total. */
function listHeading(listType: PhoenixCrmDoctorListType, count: number): string {
  return count === 0 ? `${listType} · nothing planned` : `${listType} · ${plural(count, "customer", "customers")}`;
}

function CustomerCard({ customer }: { customer: DailyPlanCustomer }) {
  const facts = dailyPlanCustomerFacts(customer);
  const place = placeLine(customer);
  const where = dailyPlanWhereText(customer);
  return (
    <CrmCard meta={customerMeta(customer)} status={<VisitPill customer={customer} />} title={<span dir="auto">{customer.name}</span>}>
      <CrmFacts
        facts={[
          // An empty place shows nothing - no "Where" line at all, never "No place yet".
          ...(where || place
            ? [
                {
                  label: "Where",
                  value: (
                    <>
                      {where ? <span className="block">{where}</span> : null}
                      {place ? (
                        <span className="block font-semibold text-slate-500" dir="auto">
                          {place}
                        </span>
                      ) : null}
                    </>
                  ),
                },
              ]
            : []),
          { label: "Hours that day", value: customer.hoursText },
          // The rep's own typed phone (owner, 2026-09-30); a customer without one simply has no row.
          ...(customer.phone ? [{ label: "Phone", value: <CustomerPhoneLink phone={customer.phone} /> }] : []),
        ]}
      />
      {facts.length > 0 || customer.offPlan ? (
        <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
          {[...facts, ...(customer.offPlan ? [dailyPlanOffPlanText(customer.offPlan)] : [])].join(" · ")}
        </p>
      ) : null}
    </CrmCard>
  );
}

function CustomerRow({ customer }: { customer: DailyPlanCustomer }) {
  const facts = dailyPlanCustomerFacts(customer);
  const place = placeLine(customer);
  const where = dailyPlanWhereText(customer);
  return (
    <tr>
      <td className={crmTdClassName}>
        <p className="font-black text-slate-950" dir="auto">
          {customer.name}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">{customerMeta(customer)}</p>
        {customer.phone ? (
          <p className="mt-0.5 text-xs">
            <CustomerPhoneLink phone={customer.phone} />
          </p>
        ) : null}
        {facts.length > 0 ? <p className="mt-0.5 text-xs text-amber-800">{facts.join(" · ")}</p> : null}
      </td>
      <td className={crmTdClassName}>
        {where ? <p className="text-slate-800">{where}</p> : null}
        {place ? (
          <p className="mt-0.5 text-xs text-slate-500" dir="auto">
            {place}
          </p>
        ) : null}
      </td>
      <td className={crmTdClassName}>{customer.hoursText}</td>
      <td className={crmTdClassName}>
        <VisitPill customer={customer} />
        {customer.offPlan ? <p className="mt-1 text-xs text-slate-500">{dailyPlanOffPlanText(customer.offPlan)}</p> : null}
      </td>
    </tr>
  );
}

function DayHeader({ day, headingId, today }: { day: DailyPlanDay; headingId: string; today: string }) {
  const pills: ReactNode[] = [];
  // A day with nothing on it says so in words below; "Not sent before the day" beside an empty day would
  // read as a failure about a day nobody planned anything for. The download follows the same rule
  // (writeDailyPlan in server/reports-workbook.ts) — change the two together.
  const planned = !dailyPlanDayIsEmpty(day);
  if (planned && day.state !== "none") pills.push(<CrmPill key="state" tone={STATE_TONES[day.state]}>{dailyPlanStateLabel(day.state)}</CrmPill>);
  if (planned && day.submittedLate && SENT_STATES.includes(day.state)) pills.push(<CrmPill key="late" tone="warn">Sent late</CrmPill>);
  // The visit day runs to 02:00, so just after midnight yesterday is the day still running.
  if (day.running) pills.push(<CrmPill key="running" tone="info">{day.date === today ? "Today" : "Still running"}</CrmPill>);
  // HR approved his leave for the day: its customers he did not see read "On leave", never "Not visited".
  if (day.onLeave) pills.push(<CrmPill key="leave" tone="neutral">On leave</CrmPill>);
  if (day.isTest) pills.push(<CrmPill key="test" tone="neutral">Test entries</CrmPill>);
  return (
    <div className="px-4 pt-4 sm:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="break-words text-sm font-black text-slate-950" id={headingId}>
          {dayLabelLong(day.date)}
        </h3>
        {pills}
      </div>
      {day.startsText ? <p className="mt-1 break-words text-xs font-bold leading-5 text-slate-700">{day.startsText}</p> : null}
      {day.activities.length > 0 ? (
        <ul className="mt-1 grid gap-0.5">
          {day.activities.map((activity) => (
            <li className="break-words text-xs font-semibold leading-5 text-slate-600" dir="auto" key={activity.activityType}>
              {dailyPlanActivityText(activity)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DayBlock({ day, idPrefix, today }: { day: DailyPlanDay; idPrefix: string; today: string }) {
  const headingId = `${idPrefix}-daily-${day.date}${day.isTest ? "-test" : ""}`;
  const lists = listsOf(day);
  const nothing = day.am.length === 0 && day.pm.length === 0;
  return (
    <section aria-labelledby={headingId} className="min-w-0 border-t border-slate-100">
      <DayHeader day={day} headingId={headingId} today={today} />
      {nothing ? (
        <p className="px-4 pb-4 pt-2 text-sm font-semibold text-slate-400 sm:px-5">
          {day.state === "none" ? "No plan for this week." : dailyPlanDayIsEmpty(day) ? "Nothing planned this day." : "No customer planned this day."}
        </p>
      ) : (
        <div className="mt-3 min-w-0">
          <CrmCardsOnPhone>
            {lists.map((list) => (
              <Fragment key={list.listType}>
                <p className="px-4 py-2 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{listHeading(list.listType, list.customers.length)}</p>
                {list.customers.map((customer) => (
                  <CustomerCard customer={customer} key={customer.customerId} />
                ))}
              </Fragment>
            ))}
          </CrmCardsOnPhone>
          <CrmTable columns={["32%", "30%", "18%", "20%"]}>
            <thead>
              <tr>
                <th className={crmThClassName} scope="col">
                  Customer
                </th>
                <th className={crmThClassName} scope="col">
                  Where
                </th>
                <th className={crmThClassName} scope="col">
                  Hours that day
                </th>
                <th className={crmThClassName} scope="col">
                  Status
                </th>
              </tr>
            </thead>
            {lists.map((list) => (
              <tbody key={list.listType}>
                <tr>
                  <th className="border-b border-slate-100 px-3 pb-1.5 pt-3 text-left text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500" colSpan={4} scope="rowgroup">
                    {listHeading(list.listType, list.customers.length)}
                  </th>
                </tr>
                {list.customers.map((customer) => (
                  <CustomerRow customer={customer} key={customer.customerId} />
                ))}
              </tbody>
            ))}
          </CrmTable>
        </div>
      )}
    </section>
  );
}

function ChooseTerritory() {
  return (
    <div className="border-t border-slate-100">
      <CrmEmpty message="A daily plan is one rep's plan, day by day. Choose a territory in the filters above." title="Choose a territory" />
    </div>
  );
}

export function DailyPlanSection({
  idPrefix,
  needsTerritory,
  problem,
  resource,
}: {
  idPrefix: string;
  /** The viewer reads several territories and has chosen none — known on the phone before any read. */
  needsTerritory: boolean;
  /** Why the chosen days cannot be read; null when they can. */
  problem: string | null;
  resource: CrmResource<DailyPlanReportView>;
}) {
  if (needsTerritory) return <ChooseTerritory />;
  if (problem) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty message="Pick a quick choice above, or change the first or last day." title="Choose the days to read" />
      </div>
    );
  }
  const report = resource.data;
  if (!report) {
    return (
      <div className="border-t border-slate-100">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Reading the plan" />}
      </div>
    );
  }
  if (!report.territory) return <ChooseTerritory />;

  const territory = report.territory;
  return (
    <>
      {resource.error ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmSaveError message={resource.error} onRetry={resource.reload} title="This plan could not be refreshed" tone="warn" />
        </div>
      ) : null}
      {report.leaveUnread ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title="Leave could not be read" tone="warn">
            {LEAVE_UNREAD_NOTE}
          </CrmNote>
        </div>
      ) : null}
      <CrmBlock className="border-t border-slate-100" title={territory.name}>
        <p className="break-words text-sm font-semibold leading-6 text-slate-700">{territory.repName ?? "No rep in this territory"}</p>
        <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">
          Each day as it was planned: its start times and other activities, then the AM and the PM customers. A day that has passed shows the plan as it stood when that day ended; today and the days ahead show it as it is now. Visited means a visit to them was saved that day. On a day HR approved the rep&apos;s leave, a customer not seen reads On leave, never Not visited.
        </p>
      </CrmBlock>
      {report.days.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Friday holds no plan. Choose other days above." title="No working day in these days" />
        </div>
      ) : (
        report.days.map((day) => <DayBlock day={day} idPrefix={idPrefix} key={`${day.date}|${day.isTest}`} today={report.cairoToday} />)
      )}
    </>
  );
}
