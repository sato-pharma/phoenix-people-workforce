"use client";

/**
 * Phoenix CRM — the three copies on the plan board (owner, 2026-09-29): "copy last month, copy last
 * week, and copy last Tuesday — the same day of the week before, or the week before that".
 *
 *   - Copy last month: the previous month's own Phoenix plan, Week N / weekday onto Week N / weekday.
 *     A territory with no Phoenix month before this one (its first month) falls back to its old
 *     iReports360 plan, placed by weekday.
 *   - Copy last week: the previous field-week, each day onto the same weekday.
 *   - Copy a day: the same weekday one or two weeks back, onto the day on screen.
 *
 * A copy only FILLS THE DRAFT. It never saves and never sends: the board's own Save and Send do that,
 * when the rep presses them. Every copy lands only on days he can still change, never past a day's AM or
 * PM cap and never twice on a day (plan-copy.ts), whatever hours are saved against that day — a time the
 * rep did not enter never keeps a customer off (owner, 2026-09-30). What could not be placed is said in
 * numbers — a full day, no place left, no longer on the list.
 *
 * Beside them, the two suggestions (owner, 2026-09-30 — plan-suggest.ts decides who): "Suggest this
 * day" and "Suggest the week" hand their placements to the SAME `onPlace` a copy does, so a suggestion
 * lands in the draft exactly like a copy — the unsaved-changes bar appears, and nothing is saved or
 * sent until the rep presses Save or Send.
 *
 * On the rep's OWN board the week saves itself as he ticks (owner, 2026-10-02), and a copy or a
 * suggestion is a tick like any other: it is kept a moment later, and still nothing is SENT until he
 * presses Send. `autosave` says so in the words under the buttons and in the report after them.
 */

import { useState } from "react";

import { crmGet, crmUrl, messageOf } from "@/components/phoenix-crm/api";
import { countText, dayLabel, monthLabel, plural, shiftIsoDay, weekLabel } from "@/components/phoenix-crm/format";
import { CrmButton, CrmNote, type NoteTone } from "@/components/phoenix-crm/ui";
import { fieldWeeksOfMonth, monthKeyOf, monthStartOf, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import {
  buildCopyPlacements,
  buildDayCopyPlacements,
  buildMonthCopyPlacements,
  buildWeekCopyPlacements,
  dayCopySources,
  type CopyWeek,
} from "@/lib/phoenix-crm/plan-copy";
import type { PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import {
  copyWeekOf,
  indexCustomers,
  onTheDay,
  sameWeekdayIn,
  sameWeekNumberIn,
  settleCopiedPlaces,
  summarizeCopy,
  type CopySummary,
  type DailyCaps,
  type DraftDay,
  type DraftWeek,
} from "@/lib/phoenix-crm/plan-week-draft";
import { suggestDay, suggestWeek, type SuggestInput, type SuggestResult } from "@/lib/phoenix-crm/plan-suggest";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import { PHOENIX_CRM_WEEKDAY_NAMES } from "@/lib/phoenix-crm/timings";
import type { PlanCopySourceView, PlanHistoryView } from "@/lib/phoenix-crm/view-types";

/** A week the copy may fill, with what its draft already holds. */
export type CopyTargetWeek = { week: DraftWeek; items: ReadonlyArray<PlanItemDraft> };

export type CopyScope =
  | { kind: "month"; monthStart: string; weeks: ReadonlyArray<CopyTargetWeek> }
  | { kind: "week"; target: CopyTargetWeek }
  | { kind: "day"; target: CopyTargetWeek; date: string };

type CopyReport = { tone: NoteTone; title: string; message: string };

/** The placements a copy made, by week — what the board adds to its drafts. */
export type CopiedPlacements = ReadonlyMap<string, PlanItemDraft[]>;

/** "3 could not be placed: 2 on a full day, 1 no longer on the list." */
function missedSentence(summary: Pick<CopySummary, "full" | "noPlace" | "notOnList">): string | null {
  const parts: string[] = [];
  if (summary.full > 0) parts.push(`${countText(summary.full)} on a full day`);
  if (summary.noPlace > 0) parts.push(`${countText(summary.noPlace)} with no place left`);
  if (summary.notOnList > 0) parts.push(`${countText(summary.notOnList)} no longer on the list`);
  if (parts.length === 0) return null;
  const missed = summary.full + summary.noPlace + summary.notOnList;
  return `${countText(missed)} could not be placed: ${parts.join(", ")}.`;
}

/** Under the buttons: what a press keeps, and what still waits for him. */
function keptLine(autosave: boolean): string {
  return autosave ? "Nothing is sent until you press Send." : "Nothing is saved or sent until you do.";
}

function reportOf(summary: CopySummary, from: string, autosave: boolean): CopyReport {
  const missed = missedSentence(summary);
  if (summary.placed === 0) {
    return {
      tone: "info",
      title: "Nothing was copied",
      message: missed ?? `There is nothing to copy from ${from} onto the days you can still change.`,
    };
  }
  return {
    tone: "good",
    title: `Copied ${plural(summary.placed, "planned visit", "planned visits")} from ${from}`,
    message: [
      missed,
      autosave ? "They save by themselves. Check the days — nothing is sent until you press Send." : "Nothing is saved or sent yet. Check the days, then save.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/** Who is on each target day before the copy, so a customer already there is not counted as missed. */
function alreadyOnOf(weeks: ReadonlyArray<CopyWeek>): (date: string) => ReadonlySet<string> {
  const byDay = new Map<string, Set<string>>();
  for (const week of weeks) for (const day of week.days) byDay.set(day.date, new Set(day.items.map((item) => item.customerId)));
  return (date) => byDay.get(date) ?? new Set<string>();
}

function dayFinder(weeks: ReadonlyArray<DraftWeek>): (date: string) => DraftDay | null {
  const byDate = new Map<string, DraftDay>();
  for (const week of weeks) for (const day of week.days) byDate.set(day.date, day);
  return (date) => byDate.get(date) ?? null;
}

export function PlanCopyMenu({
  autosave = false,
  caps,
  compact = false,
  customers,
  disabled,
  onPlace,
  scope,
  seatId,
  test,
}: {
  /** The rep's own board, which saves itself (owner, 2026-10-02): the words say a copy is kept, not that it waits for Save. */
  autosave?: boolean;
  caps: DailyCaps;
  /**
   * The rep's step 3 (owner, 2026-10-02: "where the suggest? where the copy iReports period and week
   * plan?"): buttons only, in the row beside Suggest this day, named for what they copy. The words
   * that explain each copy are dropped there — the report after a copy still says what landed.
   */
  compact?: boolean;
  customers: ReadonlyArray<PlannerCustomer>;
  /** The board is saving or reading: nothing may land in the draft under it. */
  disabled: boolean;
  onPlace: (placements: CopiedPlacements) => void;
  scope: CopyScope;
  seatId: string;
  test: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<CopyReport | null>(null);

  function readSource(from: string, to: string): Promise<PlanCopySourceView> {
    return crmGet<PlanCopySourceView>(crmUrl("/api/phoenix-crm/plans/copy-source", { seatId, test, from, to }), "source");
  }

  async function run(key: string, work: () => Promise<CopyReport>) {
    if (disabled || busy !== null) return;
    setBusy(key);
    setReport(null);
    try {
      setReport(await work());
    } catch (error) {
      setReport({ tone: "bad", title: "The copy did not run", message: `${messageOf(error)} Nothing in the plan was changed.` });
    } finally {
      setBusy(null);
    }
  }

  const byId = indexCustomers(customers);

  /** Copy last month: the previous month's Phoenix plan, else (its first month) the iReports360 plan. */
  async function copyMonth(monthStart: string, targets: ReadonlyArray<CopyTargetWeek>): Promise<CopyReport> {
    const previousMonth = monthStartOf(shiftIsoDay(monthStart, -1));
    const sourceWeeks = fieldWeeksOfMonth(previousMonth);
    const weeks = targets.map((target) => target.week);
    const copyWeeks = targets.map((target) => copyWeekOf(target.week, target.items, byId));
    const dayOf = dayFinder(weeks);
    const placed: PlanItemDraft[] = [];
    const byWeek = new Map<string, PlanItemDraft[]>();

    const source =
      sourceWeeks.length > 0 ? await readSource(sourceWeeks[0], shiftIsoDay(sourceWeeks[sourceWeeks.length - 1], 5)) : null;
    if (source && source.placements.length > 0) {
      const targetDayOf = sameWeekNumberIn(weeks);
      const built = buildMonthCopyPlacements(source.placements, customers, copyWeeks, caps);
      for (const [weekStart, drafts] of built) {
        const settled = settleCopiedPlaces(drafts, dayOf, byId);
        if (settled.kept.length > 0) byWeek.set(weekStart, settled.kept);
        placed.push(...settled.kept);
      }
      if (byWeek.size > 0) onPlace(byWeek);
      const summary = summarizeCopy({ source: source.placements, targetDayOf, byId, alreadyOn: alreadyOnOf(copyWeeks), placed });
      return reportOf(summary, monthLabel(monthKeyOf(previousMonth)), autosave);
    }

    // His first Phoenix month: last month's iReports360 plan, placed by the weekdays he had then.
    const history = await crmGet<PlanHistoryView>(crmUrl("/api/phoenix-crm/plans/history", { seatId, test, month: monthKeyOf(monthStart) }), "history");
    const entries = history.available ? history.entries : [];
    if (entries.length === 0) {
      return {
        tone: "info",
        title: "Nothing to copy",
        message: `There is no plan for ${monthLabel(monthKeyOf(previousMonth))} to copy from, in Phoenix or in iReports360.`,
      };
    }
    const built = buildCopyPlacements(
      entries.map((entry) => ({ nativeCustomerId: entry.nativeCustomerId, listType: entry.listType, weekdays: entry.weekdays })),
      customers,
      copyWeeks,
      caps,
    );
    let noPlace = 0;
    for (const [weekStart, drafts] of built) {
      const settled = settleCopiedPlaces(drafts, dayOf, byId);
      noPlace += settled.noPlace;
      if (settled.kept.length > 0) byWeek.set(weekStart, settled.kept);
      placed.push(...settled.kept);
    }
    if (byWeek.size > 0) onPlace(byWeek);
    const notOnList = entries.filter((entry) => !entry.nativeCustomerId || !byId.has(entry.nativeCustomerId)).length;
    return reportOf({ placed: placed.length, full: 0, noPlace, notOnList }, `your iReports360 plan for ${history.historyMonthLabel}`, autosave);
  }

  /** Copy last week: the previous field-week, weekday onto weekday. */
  async function copyWeek(target: CopyTargetWeek): Promise<CopyReport> {
    const previous = shiftIsoDay(target.week.weekStart, -7);
    const source = await readSource(previous, shiftIsoDay(previous, 5));
    const targetDayOf = sameWeekdayIn(target.week);
    const targetWeek = copyWeekOf(target.week, target.items, byId);
    const drafts = buildWeekCopyPlacements(source.placements, customers, targetWeek, caps);
    const settled = settleCopiedPlaces(drafts, dayFinder([target.week]), byId);
    if (settled.kept.length > 0) onPlace(new Map([[target.week.weekStart, settled.kept]]));
    const summary = summarizeCopy({ source: source.placements, targetDayOf, byId, alreadyOn: alreadyOnOf([targetWeek]), placed: settled.kept });
    return reportOf(summary, weekLabel(previous), autosave);
  }

  /** Copy a day: the same weekday one or two weeks back, onto this day. */
  async function copyDay(target: CopyTargetWeek, date: string, from: string): Promise<CopyReport> {
    const day = target.week.days.find((entry) => entry.date === date) ?? null;
    const targetWeek = copyWeekOf(target.week, target.items, byId);
    const copyDayTarget = targetWeek.days.find((entry) => entry.date === date) ?? null;
    if (!day || !copyDayTarget) return { tone: "info", title: "Nothing was copied", message: "Open a day of this week, then copy onto it." };
    const source = await readSource(from, from);
    const targetDayOf = onTheDay(day);
    const drafts = buildDayCopyPlacements(
      source.placements.map((placement) => placement.customerId),
      customers,
      copyDayTarget,
      caps,
    );
    const settled = settleCopiedPlaces(drafts, dayFinder([target.week]), byId);
    if (settled.kept.length > 0) onPlace(new Map([[target.week.weekStart, settled.kept]]));
    const summary = summarizeCopy({ source: source.placements, targetDayOf, byId, alreadyOn: alreadyOnOf([targetWeek]), placed: settled.kept });
    return reportOf(summary, dayLabel(from), autosave);
  }

  const locked = disabled || busy !== null;
  let explain: string;
  let buttons: Array<{ key: string; label: string; onClick: () => void }>;
  if (scope.kind === "month") {
    const { monthStart, weeks } = scope;
    const previousMonth = monthLabel(monthKeyOf(monthStartOf(shiftIsoDay(monthStart, -1))));
    explain = `Week 1 onto Week 1, Saturday onto Saturday, from ${previousMonth}. Only the days you can still change are filled.`;
    buttons = [{ key: "month", label: compact ? "Copy the period plan" : "Copy last month", onClick: () => void run("month", () => copyMonth(monthStart, weeks)) }];
  } else if (scope.kind === "week") {
    const { target } = scope;
    const previous = shiftIsoDay(target.week.weekStart, -7);
    explain = `Each day of ${weekLabel(previous)} onto the same day of this week.`;
    buttons = [{ key: "week", label: compact ? "Copy last week's plan" : "Copy last week", onClick: () => void run("week", () => copyWeek(target)) }];
  } else {
    const { target, date } = scope;
    explain = "The same day one or two weeks back, onto this day.";
    buttons = dayCopySources(date).map((from) => ({
      key: from,
      label: `Copy ${dayLabel(from)}`,
      onClick: () => void run(from, () => copyDay(target, date, from)),
    }));
  }

  return (
    <div className={compact ? "contents" : "grid min-w-0 gap-2"}>
      {compact ? null : <p className="break-words text-xs font-semibold leading-5 text-slate-500">{explain} {keptLine(autosave)}</p>}
      <div className={compact ? "contents" : "grid gap-2 sm:flex sm:flex-wrap"}>
        {buttons.map((button) => (
          <CrmButton busy={busy === button.key} disabled={locked} key={button.key} onClick={button.onClick} size="sm">
            {button.label}
          </CrmButton>
        ))}
      </div>
      {report ? (
        <CrmNote className={compact ? "w-full basis-full" : undefined} title={report.title} tone={report.tone}>
          {report.message}
        </CrmNote>
      ) : null}
    </div>
  );
}

// ── The two suggestions ─────────────────────────────────────────────────────────────────────────

/** What the board knows that a suggestion needs beyond the week: the grade numbers and the month so far. */
export type SuggestContext = Pick<SuggestInput, "gradeTargets" | "placedThisMonth" | "weeksLeft" | "dayTargets">;

export type SuggestScope = { kind: "day"; date: string } | { kind: "week" };

/** "Placed 2 AM and 9 PM across 2 bricks" — AM and PM apart, and a Thursday morning reads AM alone. */
function suggestedTitle(result: SuggestResult, morningOnly: boolean, scope: SuggestScope): string {
  const { am, bricks, days, pm } = result.summary;
  const lists = morningOnly ? `${countText(am)} AM` : `${countText(am)} AM and ${countText(pm)} PM`;
  const where = bricks > 0 ? ` across ${plural(bricks, "brick", "bricks")}` : "";
  const when = scope.kind === "week" ? ` over ${plural(days, "day", "days")}` : "";
  return `Placed ${lists}${where}${when}`;
}

function suggestReport(result: SuggestResult, morningOnly: boolean, scope: SuggestScope, autosave: boolean): CopyReport {
  if (result.placements.length === 0) {
    const days = scope.kind === "day" ? `on ${PHOENIX_CRM_WEEKDAY_NAMES[weekdayOfIsoDay(scope.date)]}` : "on the days left";
    return {
      tone: "info",
      title: "Nothing to suggest",
      message: `Every customer who receives ${days} is already at their grade this month, or already planned.`,
    };
  }
  const noHours = result.summary.noHours;
  return {
    tone: "good",
    title: suggestedTitle(result, morningOnly, scope),
    message: [
      noHours > 0 ? `${plural(noHours, "of them has", "of them have")} no days and hours yet.` : null,
      autosave ? "They save by themselves. Review them — nothing is sent until you press Send." : "Nothing is saved or sent yet. Review them, then save.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * "Suggest this day" / "Suggest the week". The placements go through `onPlace` — the board's own copy
 * path — so a suggestion is a draft he reviews, never a save and never a send. When the day or week
 * cannot take one, the button stays on screen, disabled, with the reason under it in plain words.
 */
export function PlanSuggestMenu({
  autosave = false,
  blockedReason,
  disabled,
  input,
  onPlace,
  scope,
}: {
  /** The rep's own board, which saves itself (owner, 2026-10-02): the words say a suggestion is kept, not that it waits for Save. */
  autosave?: boolean;
  /** Why the day or week cannot take a suggestion; null when it can. */
  blockedReason: string | null;
  /** The board is saving or reading: nothing may land in the draft under it. */
  disabled: boolean;
  /** The week as the draft holds it, with the month so far. Null when the week is not his to change. */
  input: SuggestInput | null;
  onPlace: (placements: CopiedPlacements) => void;
  scope: SuggestScope;
}) {
  const [report, setReport] = useState<CopyReport | null>(null);
  const date = scope.kind === "day" ? scope.date : null;
  const day = date !== null && input ? (input.week.days.find((entry) => entry.date === date) ?? null) : null;
  const morningOnly = day !== null && !day.listTypes.includes("PM");

  function run() {
    if (disabled || blockedReason !== null || !input) return;
    const result = scope.kind === "day" ? suggestDay({ ...input, date: scope.date }) : suggestWeek(input);
    if (result.placements.length > 0) onPlace(new Map([[input.week.weekStart, result.placements]]));
    setReport(suggestReport(result, morningOnly, scope, autosave));
  }

  const explain =
    scope.kind === "day"
      ? `The customers furthest behind their grade this month who receive on ${dayLabel(scope.date)}, one brick at a time, up to the day's ${morningOnly ? "AM" : "AM and PM"} room.`
      : "Every day you can still change, the same way. A customer is never placed beyond their grade, and is spread over the weeks left.";

  return (
    <div className="grid min-w-0 content-start gap-2">
      <p className="break-words text-xs font-semibold leading-5 text-slate-500">{explain} {keptLine(autosave)}</p>
      <div className="grid gap-2 sm:flex sm:flex-wrap">
        <CrmButton disabled={disabled || blockedReason !== null || !input} onClick={run} size="sm">
          {scope.kind === "day" ? "Suggest this day" : "Suggest the week"}
        </CrmButton>
      </div>
      {blockedReason ? <p className="break-words text-xs font-bold leading-5 text-slate-600">{blockedReason}</p> : null}
      {/* Kept after the day fills up: the fill is what made it full, and he should still read what it placed. */}
      {report ? (
        <CrmNote title={report.title} tone={report.tone}>
          {report.message}
        </CrmNote>
      ) : null}
    </div>
  );
}
