import { AlertTriangle, CalendarOff, ShieldCheck, SignalZero } from "lucide-react";
import Link from "next/link";

import { SectionShell } from "@/components/admin/ceo-command-center";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { formatRetentionRiskDate } from "@/lib/retention-risk/messages";
import { getRetentionRiskView, type RetentionRiskView } from "@/lib/retention-risk/service";
import type { RetentionRiskSignal } from "@/lib/retention-risk/types";

/**
 * "Who might be about to take the salary and go" — on the Super Administrator and SFE Manager
 * boards, and deliberately nowhere else.
 *
 * WHY IT IS HERE. Payroll pays Part 1 at the start of the month and Part 2 the day after. Measured
 * on production 2026-09-06: 23 of 59 recorded resignations land in the first ten days of a month;
 * five medical reps resigned on 9 August alone; four of those five had already gone silent in the
 * CRM five or more days earlier. Every one of those facts was in the database and on no screen.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. Not one word here calls anybody a flight risk or predicts a
 * resignation. The backtest puts the hit rate at roughly one in five, so four in five of the people
 * named on this board are staying — some are ill, some are on leave nobody filed, some have a
 * broken phone. The board reports the measurement and the empty state says so out loud.
 */

const TRIGGER_LABEL = {
  crm_silence: "No CRM activity",
  extended_leave: "Consecutive leave",
} as const;

function signalKey(signal: RetentionRiskSignal): string {
  return `${signal.trigger}:${signal.hrId}:${signal.startDate}`;
}

function personCode(signal: RetentionRiskSignal): string {
  return canonicalHrIdForDisplay(signal.hrId) ?? signal.hrId;
}

function contextLine(signal: RetentionRiskSignal): string {
  return [signal.jobTitle, signal.areaName, signal.lineName].filter(Boolean).join(" · ");
}

function spanLine(signal: RetentionRiskSignal): string {
  return `${formatRetentionRiskDate(signal.startDate)} to ${formatRetentionRiskDate(signal.endDate)}`;
}

/**
 * The one number on the row, in words rather than a bare integer.
 *
 * Never "6" alone: the whole rule is measured in WORKING days, and a reader who assumes calendar
 * days reads a six-working-day gap as under a week when it can span nine.
 */
function daysLine(signal: RetentionRiskSignal): string {
  return `${signal.workingDays} working ${signal.workingDays === 1 ? "day" : "days"}`;
}

function TriggerChip({ trigger }: { trigger: RetentionRiskSignal["trigger"] }) {
  const isSilence = trigger === "crm_silence";
  const Icon = isSilence ? SignalZero : CalendarOff;
  return (
    // Square, like everything else in the admin shell — no rounded corners anywhere (owner rule).
    <span
      className={`inline-flex items-center gap-1.5 border px-2 py-1 text-phx-xs font-bold uppercase tracking-[0.1em] ${
        isSilence ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-800"
      }`}
    >
      <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
      {TRIGGER_LABEL[trigger]}
    </span>
  );
}

function OngoingChip({ ongoing }: { ongoing: boolean }) {
  return (
    <span
      className={`inline-flex items-center border px-2 py-1 text-phx-xs font-bold uppercase tracking-[0.1em] ${
        ongoing ? "border-rose-300 bg-rose-600 text-white" : "border-slate-200 bg-slate-50 text-slate-600"
      }`}
    >
      {ongoing ? "Still open" : "Ended"}
    </span>
  );
}

function PersonLink({ signal }: { signal: RetentionRiskSignal }) {
  // Both surfaces that render this band (Super Admin, SFE Manager) hold whole-company Employee 360
  // scope, so the admin-shell address is reachable for every viewer who can see this block. A
  // notification sent to a portal-mode manager carries its own per-role address instead — see
  // roleHrefsForSubject in retention-risk/messages.ts.
  return (
    <Link
      className="font-bold text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-orange-500"
      href={`/employee-360/${encodeURIComponent(personCode(signal))}`}
    >
      {signal.displayName}
    </Link>
  );
}

/**
 * Mobile: one card per person. Desktop: the table below.
 *
 * The admin shell's rule is that a phone never gets a table, and the no-horizontal-scroll golden
 * rule is why this is two renderings rather than one table that shrinks — a five-column table at
 * 375px either scrolls sideways or squeezes type, and both are forbidden.
 */
function SignalCards({ signals }: { signals: readonly RetentionRiskSignal[] }) {
  return (
    <ul className="divide-y divide-slate-200 md:hidden">
      {signals.map((signal) => (
        <li className="min-w-0 px-4 py-3" key={signalKey(signal)}>
          <div className="flex flex-wrap items-center gap-2">
            <TriggerChip trigger={signal.trigger} />
            <OngoingChip ongoing={signal.ongoing} />
          </div>
          <p className="mt-2 break-words text-sm">
            <PersonLink signal={signal} />
            <span className="text-slate-500"> ({personCode(signal)})</span>
          </p>
          {contextLine(signal) ? (
            <p className="mt-0.5 break-words text-phx-xs text-slate-500">{contextLine(signal)}</p>
          ) : null}
          <p className="mt-1.5 break-words text-phx-xs font-bold text-slate-900">{daysLine(signal)}</p>
          <p className="break-words text-phx-xs text-slate-500">{spanLine(signal)}</p>
          {signal.trigger === "crm_silence" ? (
            <p className="mt-1 break-words text-phx-xs text-slate-500">
              {signal.lastCrmActivityDate
                ? `Last CRM entry ${formatRetentionRiskDate(signal.lastCrmActivityDate)}`
                : "No CRM entry in the period reviewed"}
            </p>
          ) : null}
          {signal.managerName ? (
            <p className="mt-1 break-words text-phx-xs text-slate-500">Manager: {signal.managerName}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SignalTable({ signals }: { signals: readonly RetentionRiskSignal[] }) {
  return (
    <div className="hidden md:block">
      {/* `table-fixed` + colgroup, never a min-width floor inside an overflow-x wrapper: the
          golden rule is that this page never scrolls sideways, and a min-width floor IS the bug
          rather than the fix. Every column wraps instead. */}
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[28%]" />
          <col className="w-[18%]" />
          <col className="w-[14%]" />
          <col className="w-[24%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-left text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
            <th className="px-4 py-2.5 align-bottom font-black">Employee</th>
            <th className="px-4 py-2.5 align-bottom font-black">Signal</th>
            <th className="px-4 py-2.5 align-bottom font-black">Length</th>
            <th className="px-4 py-2.5 align-bottom font-black">Period</th>
            <th className="px-4 py-2.5 align-bottom font-black">Manager</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {signals.map((signal) => (
            <tr className="align-top" key={signalKey(signal)}>
              <td className="px-4 py-3">
                <span className="break-words text-sm">
                  <PersonLink signal={signal} />
                </span>
                <p className="break-words text-phx-xs text-slate-500">{personCode(signal)}</p>
                {contextLine(signal) ? (
                  <p className="break-words text-phx-xs text-slate-500">{contextLine(signal)}</p>
                ) : null}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  <TriggerChip trigger={signal.trigger} />
                  <OngoingChip ongoing={signal.ongoing} />
                </div>
              </td>
              <td className="px-4 py-3">
                <p className="break-words text-sm font-bold text-slate-900">{signal.workingDays}</p>
                <p className="break-words text-phx-xs text-slate-500">
                  working {signal.workingDays === 1 ? "day" : "days"}
                </p>
              </td>
              <td className="px-4 py-3">
                <p className="break-words text-phx-xs text-slate-700">{spanLine(signal)}</p>
                {signal.trigger === "crm_silence" ? (
                  <p className="break-words text-phx-xs text-slate-500">
                    {signal.lastCrmActivityDate
                      ? `Last CRM entry ${formatRetentionRiskDate(signal.lastCrmActivityDate)}`
                      : "No CRM entry in the period reviewed"}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-3">
                <p className="break-words text-phx-xs text-slate-700">{signal.managerName ?? "Not recorded"}</p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RetentionRiskBand({ view }: { view: RetentionRiskView }) {
  const silence = view.signals.filter((signal) => signal.trigger === "crm_silence").length;
  const leave = view.signals.length - silence;
  const summary =
    view.signals.length === 0
      ? "Nobody has reached three consecutive working days of leave or of missing CRM activity."
      : `${silence} with no CRM activity, ${leave} on extended leave. Reviewed ${formatRetentionRiskDate(view.windowStart)} to ${formatRetentionRiskDate(view.measurableThrough)}.`;

  return (
    <SectionShell
      description="Medical Reps with no CRM record, or on leave, for three working days running and still not seen. Thursday and Friday are not counted. An early warning to check on someone — never a conclusion about them."
      title="Retention risk"
    >
      <div className="border-b border-slate-200 bg-slate-50 px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {view.signals.length === 0 ? (
            <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600" />
          ) : (
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-rose-600" />
          )}
          <p className="min-w-0 break-words text-sm font-bold text-slate-900">
            {view.signals.length === 0
              ? "Nobody is flagged"
              : `${view.signals.length} ${view.signals.length === 1 ? "employee" : "employees"} flagged`}
          </p>
        </div>
        <p className="mt-1 break-words text-phx-xs text-slate-600">{summary}</p>
      </div>

      {/* A data outage must never render as "nobody is flagged" — with no CRM rows every rep reads
          as silent, so the service drops that half of the rule and this says which half is
          missing. An empty board and a broken board look identical without this line. */}
      {view.crmUnavailable ? (
        <p className="border-b border-amber-200 bg-amber-50 px-5 py-3 break-words text-phx-xs text-amber-900">
          The CRM visits mirror could not be read, so the &ldquo;no CRM activity&rdquo; half of this
          board is not shown. Only recorded leave was measured on this run.
        </p>
      ) : null}

      {view.signals.length === 0 ? (
        <p className="px-5 py-6 break-words text-sm text-slate-600">
          No Medical Rep is currently away. Nobody has three or more consecutive working days of
          leave or of missing CRM activity still running.
        </p>
      ) : (
        <>
          <SignalCards signals={view.signals} />
          <SignalTable signals={view.signals} />
        </>
      )}

      <p className="border-t border-slate-200 px-5 py-3 break-words text-phx-xs text-slate-500">
        Medical Reps only, on both rules (owner, 2026-09-07). A manager has no contact list of their
        own — a rep logs the visit and tags them — so their CRM silence measures the rep&rsquo;s data
        entry, and their approved leave is a holiday rather than a retention signal. CRM activity is
        read up to {formatRetentionRiskDate(view.measurableThrough)}, never today, because reps
        enter visits through and after the working day.
      </p>
    </SectionShell>
  );
}

/**
 * The same board, as the third column of the Sales & marketing row.
 *
 * Owner, 2026-09-07: "put the resignation risk reps in the place of weekly sales". That column held
 * a single link whose entire content was the words "Open →", stretched to the height of the Source
 * of Sales tables beside it — the largest blank area on the page. This is what belongs in it: the
 * people who may not be here next month, on the same screen as the sales they carry.
 *
 * A COLUMN, not a shrunken band. One rep per block rather than a five-column table, because 260px
 * of width cannot hold a table without either scrolling sideways or shrinking the type, and both
 * are forbidden. Square, and every line wraps rather than truncating.
 */
export function RetentionRiskColumn({ view }: { view: RetentionRiskView }) {
  return (
    <div className="flex min-w-0 flex-col border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3">
        <span className="text-orange-400">
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 break-words text-phx-sm font-black uppercase tracking-[0.16em] text-slate-300">
          Resignation risk
        </span>
      </div>

      <div className="border-b border-slate-100 px-4 py-3">
        <p className="break-words text-[28px] font-black leading-none tracking-tight text-slate-900">
          {view.signals.length}
        </p>
        <p className="mt-2 break-words text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-400">
          {view.signals.length === 1 ? "Medical Rep still away" : "Medical Reps still away"}
        </p>
      </div>

      {view.crmUnavailable ? (
        <p className="border-b border-amber-200 bg-amber-50 px-4 py-3 break-words text-phx-xs text-amber-900">
          The CRM mirror could not be read, so only recorded leave was measured on this run.
        </p>
      ) : null}

      {view.signals.length === 0 ? (
        <p className="flex-1 break-words px-4 py-5 text-phx-xs text-slate-500">
          Nobody is away. Every Medical Rep has logged CRM activity, and none is on three or more
          consecutive working days of leave.
        </p>
      ) : (
        <ul className="flex flex-1 flex-col divide-y divide-slate-100">
          {view.signals.map((signal) => (
            <li className="min-w-0 px-4 py-3" key={signalKey(signal)}>
              <div className="flex flex-wrap items-center gap-1.5">
                <TriggerChip trigger={signal.trigger} />
                <span className="inline-flex items-center border border-rose-300 bg-rose-600 px-2 py-1 text-phx-xs font-bold uppercase tracking-[0.1em] text-white">
                  {signal.workingDays} working {signal.workingDays === 1 ? "day" : "days"}
                </span>
              </div>
              <p className="mt-2 break-words text-sm">
                <PersonLink signal={signal} />
              </p>
              <p className="break-words text-phx-xs text-slate-500">
                {personCode(signal)}
                {contextLine(signal) ? ` · ${contextLine(signal)}` : ""}
              </p>
              <p className="mt-1 break-words text-phx-xs text-slate-500">
                {signal.trigger === "crm_silence"
                  ? signal.lastCrmActivityDate
                    ? `Last seen in the CRM on ${formatRetentionRiskDate(signal.lastCrmActivityDate)}`
                    : "No CRM entry in the period reviewed"
                  : `On leave since ${formatRetentionRiskDate(signal.startDate)}`}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-slate-200 px-4 py-3 break-words text-phx-xs text-slate-500">
        Three working days running with no CRM record, or on leave, and not seen since. Thursday and
        Friday are never counted, so on a Monday the three days behind it are the Wednesday, Saturday
        and Sunday. An early warning to check on someone, never a conclusion about them.
      </p>
    </div>
  );
}

/** Server component for that column. Suspended by the page, like the band was. */
export async function RetentionRiskColumnSection() {
  const view = await getRetentionRiskView();
  return <RetentionRiskColumn view={view} />;
}

export function RetentionRiskColumnSkeleton() {
  return (
    <div className="flex min-w-0 flex-col border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3">
        <span className="text-phx-sm font-black uppercase tracking-[0.16em] text-slate-300">
          Resignation risk
        </span>
      </div>
      <div className="space-y-2 px-4 py-5">
        <div className="h-4 w-1/3 bg-slate-100" />
        <div className="h-4 w-2/3 bg-slate-100" />
        <div className="h-4 w-1/2 bg-slate-100" />
      </div>
    </div>
  );
}

/** Server component: loads the cached view and renders the band. Suspended by both landing pages. */
export async function RetentionRiskBandSection() {
  const view = await getRetentionRiskView();
  return <RetentionRiskBand view={view} />;
}

export function RetentionRiskBandSkeleton() {
  return (
    <SectionShell description="Loading the retention-risk review." title="Retention risk">
      <div className="space-y-2 px-5 py-6">
        <div className="h-4 w-1/3 bg-slate-100" />
        <div className="h-4 w-2/3 bg-slate-100" />
        <div className="h-4 w-1/2 bg-slate-100" />
      </div>
    </SectionShell>
  );
}
