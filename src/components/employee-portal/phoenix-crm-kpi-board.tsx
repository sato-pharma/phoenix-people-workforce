"use client";

import { PortalEmptyState, PortalRecordCard, PortalRecordFields, PortalSection } from "@/components/employee-portal/portal-primitives";
import type { PhoenixCrmKpiRow, PhoenixCrmKpiView } from "@/lib/crm/native-visits/phoenix-crm-types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * Phoenix CRM's KPIs (the owner, 2026-09-14): call rate AM · PM, coverage, frequency and plan achieved,
 * from what the pilot reps entered in Phoenix only. The call rate is AM against 2 and PM against 10,
 * side by side — never one averaged figure. The server computes every number; this only lays them out.
 */

const DAY_FORMAT = stableEnGbFormatter({ day: "numeric", month: "short", timeZone: "Africa/Cairo" });
const MONTH_FORMAT = stableEnGbFormatter({ month: "long", year: "numeric", timeZone: "Africa/Cairo" });

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

export function phoenixCrmMonthLabel(month: string) {
  return MONTH_FORMAT.format(new Date(`${month}-15T12:00:00Z`));
}

function pctText(value: number | null) {
  return value == null ? "—" : `${value}%`;
}

function callRateLines(row: PhoenixCrmKpiRow) {
  return (["AM", "PM"] as const).map((shift) => {
    const rate = row.callRate[shift];
    return `${shift}: ${rate.perDay == null ? "—" : rate.perDay.toFixed(1)} a day against ${rate.target} (${pctText(rate.attainmentPct)}, ${rate.calls} visits)`;
  });
}

function shareLines(share: PhoenixCrmKpiRow["coverage"], noun: string) {
  return (["AM", "PM"] as const).map((shift) => `${shift}: ${pctText(share[shift].pct)} (${share[shift].hit} of ${share[shift].of} ${noun})`);
}

function planText(row: PhoenixCrmKpiRow) {
  return row.planAchieved.of === 0
    ? "No planned visit due yet"
    : `${pctText(row.planAchieved.pct)} (${row.planAchieved.hit} of ${row.planAchieved.of} planned visits)`;
}

function windowText(row: PhoenixCrmKpiRow) {
  if (!row.window) return "No day counted this month";
  return `${dayLabel(row.window.from)} to ${dayLabel(row.window.to)} · ${row.workingDays} working ${row.workingDays === 1 ? "day" : "days"}`;
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <div className="grid gap-0.5">
      {lines.map((line) => (
        <p className="break-words" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}

export function PhoenixCrmKpiBoard({ view }: { view: PhoenixCrmKpiView }) {
  const title =
    view.audience === "self" ? "My KPIs" : view.audience === "team" ? "My pilot reps' KPIs" : "Every pilot rep's KPIs";
  return (
    <PortalSection
      description={
        <>
          From what the pilot reps entered in Phoenix CRM only, from the day each joined the pilot to today. Call rate is doctor
          visits per working day (Saturday to Wednesday, national holidays removed), AM against 2 and PM against 10. Coverage is
          the doctors on a list visited at least once; frequency is those visited as often as their grade asks; plan achieved is
          the doctors visited on the day a verified plan named.
          {view.holidaysComplete ? null : " The holiday calendar could not be read in full, so working days may count too many."}
        </>
      }
      eyebrow={phoenixCrmMonthLabel(view.month)}
      title={title}
    >
      {view.rows.length === 0 ? (
        <PortalEmptyState
          message={view.audience === "self" ? "You are not in the Phoenix CRM pilot." : "No pilot rep to show for this month."}
          title="No KPIs yet"
        />
      ) : (
        <>
          <div className="divide-y divide-slate-100 md:hidden">
            {view.rows.map((row) => (
              <PortalRecordCard key={row.hrId} meta={row.detail} title={row.name}>
                <p className="mb-2 text-xs font-semibold text-slate-500">{windowText(row)}</p>
                <PortalRecordFields
                  fields={[
                    { label: "Call rate", value: <Lines lines={callRateLines(row)} /> },
                    { label: "Coverage", value: <Lines lines={shareLines(row.coverage, "doctors")} /> },
                    { label: "Frequency", value: <Lines lines={shareLines(row.frequency, "doctors")} /> },
                    { label: "Plan achieved", value: planText(row) },
                  ]}
                />
              </PortalRecordCard>
            ))}
          </div>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[24%]" />
                <col className="w-[19%]" />
                <col className="w-[19%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead className="border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Rep · Days counted</th>
                  <th className="px-4 py-3">Call rate AM · PM</th>
                  <th className="px-4 py-3">Coverage</th>
                  <th className="px-4 py-3">Frequency</th>
                  <th className="px-4 py-3">Plan achieved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {view.rows.map((row) => (
                  <tr key={row.hrId}>
                    <td className="break-words px-4 py-3">
                      <p className="font-bold text-slate-900">{row.name}</p>
                      <p className="text-xs font-medium text-slate-500">{row.detail}</p>
                      <p className="mt-1 text-xs font-medium text-slate-500">{windowText(row)}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      <p className="font-bold text-slate-900">{row.callRateText}</p>
                      <div className="mt-1 text-xs font-medium text-slate-500">
                        <Lines lines={callRateLines(row)} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs font-medium text-slate-700">
                      <Lines lines={shareLines(row.coverage, "doctors")} />
                    </td>
                    <td className="px-4 py-3 text-xs font-medium text-slate-700">
                      <Lines lines={shareLines(row.frequency, "doctors")} />
                    </td>
                    <td className="break-words px-4 py-3 text-xs font-medium text-slate-700">{planText(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </PortalSection>
  );
}
