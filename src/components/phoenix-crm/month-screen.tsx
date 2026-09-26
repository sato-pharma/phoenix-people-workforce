"use client";

/**
 * Phoenix CRM — the Plan tab as a MONTH, above the week.
 *
 * Owner, 2026-09-25: the rep makes ONE monthly plan — a real calendar — and his weekly plans are its
 * weeks. He approves the month once; a later edit to a single week needs that week approved again. This
 * screen is the month builder: the coverage, frequency and call-rate meters over the whole month (AM and
 * PM apart, never averaged), every doctor with how many days his grade needs and how many are placed
 * (over is a deviation, shown, never blocked), the field-weeks to open, and "Copy last month" from his
 * old iReports360 plan. Opening a week hands off to the proven weekly PlanTab, so the day machinery,
 * the caps and the per-week approval are reused unchanged; the month cascades submit / approve / return
 * down to its weeks on the server.
 */

import { useMemo, useState } from "react";

import { crmGet, crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoStamp, countText, dayLabelWithYear, plural, weekLabel } from "@/components/phoenix-crm/format";
import { territoryLine } from "@/components/phoenix-crm/labels";
import { PlanFilterBar } from "@/components/phoenix-crm/plan-filter-bar";
import { PlanHistoryReference } from "@/components/phoenix-crm/plan-history-reference";
import { PlanTab } from "@/components/phoenix-crm/plan-tab";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmFacts,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmStat,
  CrmStatGrid,
  crmTextareaClassName,
  type NoteTone,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { buildCopyPlacements } from "@/lib/phoenix-crm/plan-copy";
import { PLAN_DECISION_NOTE_MAX } from "@/lib/phoenix-crm/plan-rules";
import { DoctorFilter, EMPTY_DOCTOR_FILTER, filterPlannerCustomers, plannerBricks, plannerGrades, plannerSpecialities } from "@/lib/phoenix-crm/plan-filters";
import { PHOENIX_CRM_WEEKDAY_NAMES, PHOENIX_CRM_WEEKDAY_ORDER } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import type { MonthlyPlannerView, MonthlyWeekView, PlanHistoryView, PlannerView, SavedPlan } from "@/lib/phoenix-crm/view-types";

const STATUS_TONE: Record<PhoenixCrmPlanStatus | "none", PillTone> = {
  none: "neutral",
  draft: "neutral",
  submitted: "warn",
  approved: "good",
  returned: "bad",
};

type Notice = { tone: NoteTone; title: string; message?: string | null };

function weekCounts(week: MonthlyWeekView): { AM: number; PM: number } {
  return week.days.reduce((sum, day) => ({ AM: sum.AM + day.counts.AM, PM: sum.PM + day.counts.PM }), { AM: 0, PM: 0 });
}

/** A week whose days the rep can still change hold nothing yet — the only weeks Copy last month fills. */
function isEmptyEditableWeek(week: MonthlyWeekView): boolean {
  const editable = week.days.filter((day) => day.editable);
  return editable.length > 0 && editable.every((day) => day.items.length === 0);
}

function pctText(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/** The whole Plan experience: the month, and the week it hands off to. */
export function MonthlyPlanTab({
  onBack,
  onChanged,
  onDirtyChange,
  onOpenList,
  seatId,
  test,
}: {
  /**
   * Where this month was opened FROM, when it was not the rep's own Plan tab. The Team tab uses it to
   * put a reviewing manager back on his board: the same month screen, read only, with Approve and
   * Return on it. Nothing here is unsaved, so leaving needs no question — the weekly plan inside asks
   * its own before it lets changes go.
   */
  onBack?: { label: string; onBack: () => void };
  onChanged?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenList?: () => void;
  seatId: string;
  test: boolean;
}) {
  const [openWeek, setOpenWeek] = useState<string | null>(null);
  // Bumped when a week is left, so the month reads its new placements and status.
  const [monthKey, setMonthKey] = useState(0);

  if (openWeek) {
    return (
      <PlanTab
        initialWeekStart={openWeek}
        onChanged={onChanged}
        onClose={{
          label: "Month plan",
          onClose: () => {
            setOpenWeek(null);
            setMonthKey((current) => current + 1);
            onDirtyChange?.(false);
          },
        }}
        onDirtyChange={onDirtyChange}
        onOpenList={onOpenList}
        seatId={seatId}
        test={test}
      />
    );
  }

  return <MonthScreen key={monthKey} onBack={onBack} onChanged={onChanged} onOpenList={onOpenList} onOpenWeek={setOpenWeek} seatId={seatId} test={test} />;
}

function MonthScreen({
  onBack,
  onChanged,
  onOpenList,
  onOpenWeek,
  seatId,
  test,
}: {
  onBack?: { label: string; onBack: () => void };
  onChanged?: () => void;
  onOpenList?: () => void;
  onOpenWeek: (weekStart: string) => void;
  seatId: string;
  test: boolean;
}) {
  const [month, setMonth] = useState<string | null>(null);
  const [filter, setFilter] = useState<DoctorFilter>(EMPTY_DOCTOR_FILTER);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<"submit" | "reopen" | "approve" | "return" | "copy" | null>(null);
  const [note, setNote] = useState("");
  const [noteProblem, setNoteProblem] = useState<string | null>(null);

  const resource = useCrmGet<MonthlyPlannerView>(crmUrl("/api/phoenix-crm/monthly-plans", { seatId, test, month }), "planner");
  const history = useCrmGet<PlanHistoryView>(crmUrl("/api/phoenix-crm/plans/history", { seatId, test, month }), "history");
  const view = resource.data;
  const locked = busy !== null || resource.loading;

  const bricks = useMemo(() => (view ? plannerBricks(view.customers) : []), [view]);
  const grades = useMemo(() => (view ? plannerGrades(view.customers) : []), [view]);
  const specialities = useMemo(() => (view ? plannerSpecialities(view.customers) : []), [view]);
  // The weekdays each validated customer receives on, for the "also receives" chips under his name.
  const receivingDaysByCustomer = useMemo(() => {
    const map = new Map<string, number[]>();
    if (!view) return map;
    for (const customer of view.customers) {
      const days = new Set<number>();
      for (const place of customer.places) for (const timing of place.timings) days.add(timing.weekday);
      map.set(customer.customerId, PHOENIX_CRM_WEEKDAY_ORDER.filter((weekday) => days.has(weekday)));
    }
    return map;
  }, [view]);
  const allowedIds = useMemo(
    () => (view ? new Set(filterPlannerCustomers(view.customers, filter).map((customer) => customer.customerId)) : new Set<string>()),
    [view, filter],
  );
  const restrictById = filter.brick !== null || filter.weekday !== null || filter.grade !== null || filter.speciality !== null;
  const rows = useMemo(() => {
    if (!view) return [];
    return view.tallies.filter((row) => {
      if (filter.session !== "all" && row.listType !== filter.session) return false;
      if (restrictById && !allowedIds.has(row.customerId)) return false;
      return true;
    });
  }, [view, filter.session, restrictById, allowedIds]);

  function show(next: Notice | null) {
    setNotice(next);
  }

  async function transition(action: "submit" | "reopen") {
    if (!view || locked) return;
    setBusy(action);
    setNotice(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/monthly-plans", { seatId, test, month: view.monthStart, action }, "plan");
      show(
        action === "submit"
          ? { tone: "good", title: "Month sent for review", message: view.isTest ? "This is a test plan, so nobody is notified." : "The reviewing manager is notified." }
          : { tone: "info", title: "Month taken back", message: "Change any week, then send the month for review again." },
      );
      onChanged?.();
      resource.reload();
    } catch (error) {
      show({ tone: "bad", title: action === "submit" ? "The month was not sent" : "The month was not taken back", message: messageOf(error) });
      resource.reload();
    } finally {
      setBusy(null);
    }
  }

  async function decide(action: "approve" | "return") {
    if (!view?.plan || locked) return;
    const trimmed = note.trim();
    if (action === "return" && !trimmed) {
      setNoteProblem("Write a note for the rep on what to change.");
      return;
    }
    setNoteProblem(null);
    setBusy(action);
    setNotice(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/monthly-plans/reviews",
        { monthlyPlanId: view.plan.monthlyPlanId, action, expectedVersion: view.plan.version, note: trimmed || null },
        "plan",
      );
      show({
        tone: "good",
        title: action === "approve" ? "Month approved" : "Month returned for changes",
        message: view.isTest ? "This is a test plan, so nobody is notified." : "The rep is notified.",
      });
      setNote("");
      onChanged?.();
      resource.reload();
    } catch (error) {
      show({ tone: "bad", title: action === "approve" ? "The month was not approved" : "The month was not returned", message: messageOf(error) });
      resource.reload();
    } finally {
      setBusy(null);
    }
  }

  /** Copy last month into the weeks not started yet, each saved through the ordinary weekly save. */
  async function copyLastMonth() {
    if (!view || !history.data || locked) return;
    const emptyWeeks = view.weeks.filter(isEmptyEditableWeek);
    const placementsByWeek = buildCopyPlacements(
      history.data.entries.map((entry) => ({ nativeCustomerId: entry.nativeCustomerId, listType: entry.listType, weekdays: entry.weekdays })),
      view.customers,
      emptyWeeks.map((week) => ({
        weekStart: week.weekStart,
        days: week.days.map((day) => ({ date: day.date, listTypes: day.listTypes, editable: day.editable, items: day.items.map((item) => ({ customerId: item.customerId, listType: item.listType })) })),
      })),
      { amDailyCap: view.rules.amDailyCap, pmDailyCap: view.rules.pmDailyCap },
    );
    if (placementsByWeek.size === 0) {
      show({ tone: "info", title: "Nothing to copy", message: "Last month's customers are either off the list, or the weeks you can still change are already started." });
      return;
    }
    setBusy("copy");
    setNotice(null);
    let savedWeeks = 0;
    let placed = 0;
    try {
      for (const [weekStart, drafts] of placementsByWeek) {
        // Read the week's current version, then write the copied placements as its draft. An empty week
        // has no placements to preserve, so the copy is the whole payload.
        const weekView = await crmGet<PlannerView>(crmUrl("/api/phoenix-crm/plans", { seatId, test, weekStart }), "planner").catch(() => null);
        const expectedVersion = weekView?.plan?.version ?? null;
        await crmPost<SavedPlan>("/api/phoenix-crm/plans", { seatId, test, weekStart, expectedVersion, items: drafts }, "plan");
        savedWeeks += 1;
        placed += drafts.length;
      }
      show({
        tone: "good",
        title: "Copied last month",
        message: `${plural(placed, "placement", "placements")} added across ${plural(savedWeeks, "week", "weeks")}. Open a week to review and change it, then send the month.`,
      });
      onChanged?.();
      resource.reload();
    } catch (error) {
      show({ tone: "bad", title: "The copy did not finish", message: `${messageOf(error)} ${savedWeeks > 0 ? `${plural(savedWeeks, "week was", "weeks were")} copied before it stopped.` : ""}`.trim() });
      resource.reload();
    } finally {
      setBusy(null);
    }
  }

  if (!view) {
    return (
      <CrmPanel eyebrow="Plan" title="Monthly plan">
        {onBack ? <CrmBackBar backLabel={onBack.label} onBack={onBack.onBack} title="Monthly plan" /> : null}
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the monthly plan" />}
      </CrmPanel>
    );
  }

  const { plan } = view;
  const status = plan?.status ?? null;
  const facts: Array<{ label: string; value: string }> = [
    // Owner, 2026-09-26: the month is due the last Thursday of the month before. It is a DATE on the
    // screen, never a gate — a late month is accepted and stamped, because a rep who cannot plan
    // cannot work.
    { label: "Due", value: `${dayLabelWithYear(view.dueOn)}${view.overdue ? " · overdue" : ""}` },
    { label: "Last change", value: plan ? cairoStamp(plan.updatedAt) : "Not started yet" },
    { label: "Reviewer", value: view.isTest ? "You (test entries)" : (view.territory.reviewerName ?? "No manager above this territory") },
  ];
  if (plan?.submittedAt) {
    facts.push({
      label: "Last sent for review",
      value: `${cairoStamp(plan.submittedAt)}${plan.submittedByName ? ` · ${plan.submittedByName}` : ""}${plan.submittedLate ? " · late" : ""}`,
    });
  }
  if (plan?.decidedAt && (status === "approved" || status === "returned")) {
    facts.push({
      label: status === "approved" ? "Approved" : "Returned",
      value: `${cairoStamp(plan.decidedAt)}${plan.decidedByName ? ` · ${plan.decidedByName}` : ""}${plan.decidedBySfe ? " (SFE Manager)" : ""}`,
    });
  }

  const totalPlacements = view.amMeter.placements + view.pmMeter.placements;

  return (
    <CrmPanel description={territoryLine(view.territory)} eyebrow={view.isTest ? "Plan · test entries" : "Plan"} title={view.monthLabel}>
      {onBack ? <CrmBackBar backLabel={onBack.label} onBack={onBack.onBack} title={`${view.territory.name} · ${view.monthLabel}`} /> : null}
      {notice ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title={notice.title} tone={notice.tone}>
            {notice.message}
          </CrmNote>
        </div>
      ) : null}

      <CrmBlock title="Month">
        <CrmChoice
          columns={4}
          label="Month"
          onChange={(next) => {
            setMonth(next);
            setNotice(null);
          }}
          options={view.months.map((option) => ({
            value: option.monthStart,
            label: option.label,
            note: option.statusLabel,
            disabled: locked && option.monthStart !== view.monthStart,
          }))}
          value={view.monthStart}
        />
      </CrmBlock>

      {view.blockedReason ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote tone="warn">
            <span className="block">{view.blockedReason}</span>
          </CrmNote>
        </CrmBlock>
      ) : null}

      {/* The deadline, said once where he is working. Never a block: his ruling was that a late month
          is accepted and stamped. Only the rep is told he is behind — a manager reading the month sees
          the stamp on the review board instead. */}
      {view.viewerIsRep && view.overdue ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title={`This month was due ${dayLabelWithYear(view.dueOn)}`} tone="warn">
            Send it as soon as it is ready. It will still be accepted, and it will be marked as sent late.
          </CrmNote>
        </CrmBlock>
      ) : null}
      {plan?.submittedLate ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title="Sent late" tone="warn">
            This month was due {dayLabelWithYear(view.dueOn)} and was sent on {cairoStamp(plan.submittedAt ?? plan.updatedAt)}.
          </CrmNote>
        </CrmBlock>
      ) : null}

      <CrmBlock className="border-t border-slate-100" title="This month">
        <CrmStatGrid>
          <CrmStat label="AM covered" note={`${countText(view.amMeter.covered)} of ${countText(view.amMeter.panel)} placed`} value={pctText(view.amMeter.coveragePct)} />
          <CrmStat
            label="AM frequency"
            note={`${countText(view.amMeter.metNorm)} of ${countText(view.amMeter.withNorm)} at the grade`}
            tone={view.amMeter.underNorm > 0 ? "warn" : "neutral"}
            value={pctText(view.amMeter.frequencyPct)}
          />
          <CrmStat label="PM covered" note={`${countText(view.pmMeter.covered)} of ${countText(view.pmMeter.panel)} placed`} value={pctText(view.pmMeter.coveragePct)} />
          <CrmStat
            label="PM frequency"
            note={`${countText(view.pmMeter.metNorm)} of ${countText(view.pmMeter.withNorm)} at the grade`}
            tone={view.pmMeter.underNorm > 0 ? "warn" : "neutral"}
            value={pctText(view.pmMeter.frequencyPct)}
          />
        </CrmStatGrid>
        {view.amMeter.overNorm + view.pmMeter.overNorm > 0 ? (
          <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
            {countText(view.amMeter.overNorm + view.pmMeter.overNorm)} planned over the grade norm — allowed, shown as a deviation.
          </p>
        ) : null}
      </CrmBlock>

      {/* The call rate is AM against its target and PM against its, side by side, never one averaged figure. */}
      <CrmBlock className="border-t border-slate-100" title="Call rate">
        <CrmStatGrid>
          <CrmStat
            label="AM per day"
            note={`Target ${countText(view.callRate.amTarget)} · ${countText(view.callRate.workingDays)} working days`}
            tone={view.callRate.amPerDay !== null && view.callRate.amPerDay < view.callRate.amTarget ? "warn" : "neutral"}
            value={view.callRate.amPerDay === null ? "—" : String(view.callRate.amPerDay)}
          />
          <CrmStat label="AM placed" note={`Of ${countText(view.callRate.amExpected)} at the target`} value={countText(view.callRate.amPlacements)} />
          <CrmStat
            label="PM per day"
            note={`Target ${countText(view.callRate.pmTarget)} · ${countText(view.callRate.workingDays)} working days`}
            tone={view.callRate.pmPerDay !== null && view.callRate.pmPerDay < view.callRate.pmTarget ? "warn" : "neutral"}
            value={view.callRate.pmPerDay === null ? "—" : String(view.callRate.pmPerDay)}
          />
          <CrmStat label="PM placed" note={`Of ${countText(view.callRate.pmExpected)} at the target`} value={countText(view.callRate.pmPlacements)} />
        </CrmStatGrid>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="Weeks">
        <p className="mb-3 break-words text-sm font-medium leading-6 text-slate-600">Open a week to place its days. Each week keeps its own approval once the month is approved.</p>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {view.weeks.map((week) => {
            const counts = weekCounts(week);
            return (
              <button
                className="flex min-w-0 flex-col items-stretch gap-1.5 rounded-none border border-l-[3px] border-slate-200 border-l-orange-400 bg-white px-3.5 py-3 text-left transition hover:bg-slate-50"
                key={week.weekStart}
                onClick={() => onOpenWeek(week.weekStart)}
                type="button"
              >
                <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-black text-slate-950">{weekLabel(week.weekStart)}</span>
                  <CrmPill tone={STATUS_TONE[week.status ?? "none"]}>{week.statusLabel}</CrmPill>
                </span>
                <span className="block break-words text-sm font-bold text-slate-800">
                  {countText(counts.AM)} AM · {countText(counts.PM)} PM
                </span>
              </button>
            );
          })}
        </div>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="Copy last month">
        <PlanHistoryReference canCopy={view.canEdit} copyBusy={busy === "copy"} history={history.data} onCopy={() => void copyLastMonth()} />
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="Customers">
        <PlanFilterBar bricks={bricks} filter={filter} grades={grades} idPrefix="month" locked={locked} onChange={setFilter} specialities={specialities} />
        <p className="mt-3 break-words text-sm font-semibold leading-6 text-slate-600">
          {countText(rows.length)} of {countText(view.tallies.length)} shown. Needs is the grade&apos;s monthly frequency; over it is a deviation.
        </p>
        {view.pendingCount > 0 ? (
          <CrmNote className="mt-3" tone="info" title={`${countText(view.pendingCount)} not validated yet`}>
            <span className="block">A carried-over customer is planned as he is and validated at the door. He has no grade norm until then.</span>
            {onOpenList ? (
              <span className="mt-2 block">
                <CrmButton onClick={onOpenList} size="sm">
                  Open the list
                </CrmButton>
              </span>
            ) : null}
          </CrmNote>
        ) : null}
        <div className="mt-3 grid min-w-0 gap-2">
          {rows.length === 0 ? (
            <p className="text-sm font-medium text-slate-500">No customer matches the filter. Clear it to see the whole list.</p>
          ) : (
            rows.map((row) => {
              const meta = [row.listType, row.grade ? `Grade ${row.grade}` : null, row.speciality].filter(Boolean).join(" · ");
              const receivingDays = receivingDaysByCustomer.get(row.customerId) ?? [];
              return (
                <article className="min-w-0 border border-slate-200 bg-white px-3.5 py-2.5" key={row.customerId}>
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 basis-56">
                      <h4 className="break-words text-sm font-black text-slate-950">{row.name}</h4>
                      {meta ? <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{meta}</p> : null}
                      {receivingDays.length > 0 ? (
                        <div className="mt-1.5 flex max-w-full flex-wrap items-center gap-1">
                          <span className="text-xs font-semibold text-slate-500">Receives</span>
                          {receivingDays.map((day) => (
                            <span
                              key={day}
                              className="inline-flex min-h-6 items-center border border-slate-200 bg-slate-50 px-1.5 text-xs font-bold text-slate-700"
                            >
                              {PHOENIX_CRM_WEEKDAY_NAMES[day].slice(0, 3)}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <span className="flex max-w-full flex-wrap justify-end gap-1">
                      {row.pending ? (
                        <CrmPill tone="orange">Not validated yet</CrmPill>
                      ) : (
                        <>
                          <CrmPill tone={row.done ? "good" : "neutral"}>
                            {countText(row.placed)} placed{row.required !== null ? ` of ${countText(row.required)}` : ""}
                          </CrmPill>
                          {row.deviation !== null && row.deviation > 0 ? <CrmPill tone="warn">+{countText(row.deviation)} over</CrmPill> : null}
                          {row.deviation !== null && row.deviation < 0 ? <CrmPill tone="warn">{countText(-row.deviation)} to go</CrmPill> : null}
                        </>
                      )}
                    </span>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="Status">
        <div className="flex flex-wrap items-center gap-1.5">
          <CrmPill tone={STATUS_TONE[status ?? "none"]}>{plan?.statusLabel ?? "Not started"}</CrmPill>
        </div>
        <div className="mt-3">
          <CrmFacts facts={facts} />
        </div>
        {plan?.decisionNote && (status === "returned" || status === "approved") ? (
          <CrmNote className="mt-3" title={status === "returned" ? "What to change" : "Manager's note"} tone={status === "returned" ? "warn" : "good"}>
            <span className="block whitespace-pre-line">{plan.decisionNote}</span>
          </CrmNote>
        ) : null}
      </CrmBlock>

      {view.canSubmit ? (
        <CrmBlock className="border-t border-slate-100" title="Send the month for review">
          <div className="grid min-w-0 gap-2">
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              {status === "returned" ? "Change what the manager asked for, then send the month again." : "When the month is ready, send it. It sends every week with it."}
            </p>
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton busy={busy === "submit"} disabled={locked || totalPlacements === 0} onClick={() => void transition("submit")} variant="primary">
                {status === "returned" ? "Send the month again" : "Send the month for review"}
              </CrmButton>
            </div>
            {totalPlacements === 0 ? <p className="text-xs font-semibold leading-5 text-slate-500">Place at least one customer on a day before sending the month.</p> : null}
          </div>
        </CrmBlock>
      ) : null}

      {view.canReopen && plan ? (
        <CrmBlock className="border-t border-slate-100" title={status === "approved" ? "Approved month" : "Waiting for review"}>
          <div className="grid min-w-0 gap-2">
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              {status === "approved" ? "The month is approved." : "The month is waiting for review."} To change it, take it back first.
            </p>
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton busy={busy === "reopen"} disabled={locked} onClick={() => void transition("reopen")}>
                Take the month back to change it
              </CrmButton>
            </div>
          </div>
        </CrmBlock>
      ) : null}

      {view.canApprove || view.canReturn ? (
        <CrmBlock className="border-t border-slate-100" title="Your decision">
          <p className="break-words text-sm font-medium leading-6 text-slate-600">
            {view.canApprove ? "Approve the month, or return it to the rep with a note on what to change." : "Return the month to the rep with a note on what to change."}
          </p>
          <div className="mt-3 grid min-w-0 gap-2">
            <CrmField hint={view.canApprove ? "Needed to return the month. The rep reads it." : "The rep reads it."} htmlFor="month-decision-note" label="Note for the rep">
              <textarea
                className={crmTextareaClassName}
                disabled={locked}
                id="month-decision-note"
                maxLength={PLAN_DECISION_NOTE_MAX}
                onChange={(event) => {
                  setNote(event.target.value);
                  setNoteProblem(null);
                }}
                rows={3}
                value={note}
              />
            </CrmField>
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              {view.canApprove ? (
                <CrmButton busy={busy === "approve"} disabled={locked} onClick={() => void decide("approve")} variant="success">
                  Approve the month
                </CrmButton>
              ) : null}
              {view.canReturn ? (
                <CrmButton busy={busy === "return"} disabled={locked} onClick={() => void decide("return")} variant="danger">
                  Return for changes
                </CrmButton>
              ) : null}
            </div>
            {noteProblem ? <CrmNote tone="bad">{noteProblem}</CrmNote> : null}
          </div>
        </CrmBlock>
      ) : null}
    </CrmPanel>
  );
}
