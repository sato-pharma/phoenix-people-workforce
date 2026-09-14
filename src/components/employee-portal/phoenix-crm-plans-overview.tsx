"use client";

import { PortalEmptyState, PortalRecordCard, PortalRecordFields, PortalSection } from "@/components/employee-portal/portal-primitives";
import type { PhoenixCrmPlanOverview, PhoenixCrmPlanOverviewRow } from "@/lib/crm/native-visits/phoenix-crm-types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * Phoenix CRM planning at a glance (the owner, 2026-09-14): each pilot rep's week plan for this week and
 * the next — its status, how many visits it plans and the manager it went to. Read only: the rep plans,
 * and only the manager the plan was sent to verifies or returns it. The system never approves a plan.
 */

const DAY_FORMAT = stableEnGbFormatter({ day: "numeric", month: "short", timeZone: "Africa/Cairo" });

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

function accent(row: PhoenixCrmPlanOverviewRow): "emerald" | "amber" | "rose" | "slate" {
  if (row.status === "verified") return "emerald";
  if (row.status === "submitted") return "amber";
  if (row.status === "returned") return "rose";
  return "slate";
}

export function PhoenixCrmPlansOverview({ description, overview, title }: { description: string; overview: PhoenixCrmPlanOverview; title: string }) {
  return (
    <PortalSection description={description} eyebrow="Week plans" title={title}>
      {overview.rows.length === 0 ? (
        <PortalEmptyState message="No rep in the Phoenix CRM pilot to show." title="No plans" />
      ) : (
        <>
          <div className="divide-y divide-slate-100 md:hidden">
            {overview.rows.map((row) => (
              <PortalRecordCard accent={accent(row)} key={row.key} meta={row.repDetail} title={row.repName}>
                <PortalRecordFields
                  fields={[
                    { label: "Week", value: `From ${dayLabel(row.weekStart)}` },
                    { label: "Status", value: row.statusLabel },
                    { label: "Planned visits", value: String(row.plannedCalls) },
                    { label: "Sent to", value: row.managerName ?? "Not sent" },
                  ]}
                />
              </PortalRecordCard>
            ))}
          </div>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <colgroup>
                <col className="w-[30%]" />
                <col className="w-[14%]" />
                <col className="w-[20%]" />
                <col className="w-[14%]" />
                <col className="w-[22%]" />
              </colgroup>
              <thead className="border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Rep</th>
                  <th className="px-4 py-3">Week from</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Planned visits</th>
                  <th className="px-4 py-3">Sent to</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {overview.rows.map((row) => (
                  <tr key={row.key}>
                    <td className="break-words px-4 py-3">
                      <p className="font-bold text-slate-900">{row.repName}</p>
                      <p className="text-xs font-medium text-slate-500">{row.repDetail}</p>
                    </td>
                    <td className="break-words px-4 py-3 text-slate-700">{dayLabel(row.weekStart)}</td>
                    <td className="break-words px-4 py-3 font-bold text-slate-800">{row.statusLabel}</td>
                    <td className="px-4 py-3 text-slate-700">{row.plannedCalls}</td>
                    <td className="break-words px-4 py-3 text-slate-700">{row.managerName ?? "Not sent"}</td>
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
