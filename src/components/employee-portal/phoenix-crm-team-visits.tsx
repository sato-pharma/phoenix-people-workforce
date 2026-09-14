"use client";

import { PortalEmptyState, PortalRecordCard, PortalRecordFields, PortalSection } from "@/components/employee-portal/portal-primitives";
import type { NativeVisitAdminRow, NativeVisitAdminView } from "@/lib/crm/native-visits/types";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * Phoenix CRM, a manager's side (the owner, 2026-09-14): the saved visits of their own pilot reps, read
 * only. A visit that names them is answered on the confirmations list beside it.
 */

const DAY_FORMAT = stableEnGbFormatter({ day: "numeric", month: "short", timeZone: "Africa/Cairo", weekday: "short" });

function dayLabel(isoDay: string) {
  return DAY_FORMAT.format(new Date(`${isoDay}T12:00:00Z`));
}

function gpsLabel(status: NativeVisitAdminRow["gpsStatus"]) {
  if (status === "captured") return "Location captured";
  if (status === "out_of_bounds") return "Location outside Egypt";
  return "No location";
}

function visitText(row: NativeVisitAdminRow) {
  return [row.typeLabel, row.contactName ?? row.prospectName].filter(Boolean).join(" · ");
}

function partnersText(row: NativeVisitAdminRow) {
  return row.partners.length > 0 ? row.partners.map((partner) => partner.name).join(", ") : "Alone";
}

export function PhoenixCrmTeamVisits({ view }: { view: NativeVisitAdminView }) {
  return (
    <PortalSection
      description="What your pilot reps saved in Phoenix CRM over the last two weeks, newest first. A deleted visit stays listed, marked deleted."
      eyebrow="Your pilot reps"
      title="Team visits"
    >
      {view.rows.length === 0 ? (
        <PortalEmptyState
          message={view.reps.length === 0 ? "None of your reps is in the Phoenix CRM pilot." : "Your pilot reps have saved no visit in these days."}
          title="No visits"
        />
      ) : (
        <>
          <div className="divide-y divide-slate-100 md:hidden">
            {view.rows.map((row) => (
              <PortalRecordCard accent={row.deletedAt ? "rose" : "slate"} key={row.id} meta={row.repDetail} title={row.repName}>
                <PortalRecordFields
                  fields={[
                    { label: "Day", value: `${dayLabel(row.visitDate)} · ${row.shift}` },
                    { label: "Visit", value: visitText(row) },
                    { label: "With", value: partnersText(row) },
                    { label: "Location", value: row.deletedAt ? "Deleted" : gpsLabel(row.gpsStatus) },
                  ]}
                />
              </PortalRecordCard>
            ))}
          </div>
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[16%]" />
                <col className="w-[28%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead className="border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Rep</th>
                  <th className="px-4 py-3">Day</th>
                  <th className="px-4 py-3">Visit</th>
                  <th className="px-4 py-3">With</th>
                  <th className="px-4 py-3">Location</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 align-top">
                {view.rows.map((row) => (
                  <tr className={row.deletedAt ? "text-slate-400" : undefined} key={row.id}>
                    <td className="break-words px-4 py-3">
                      <p className="font-bold text-slate-900">{row.repName}</p>
                      <p className="text-xs font-medium text-slate-500">{row.repDetail}</p>
                    </td>
                    <td className="break-words px-4 py-3">{`${dayLabel(row.visitDate)} · ${row.shift}`}</td>
                    <td className="break-words px-4 py-3">{visitText(row)}</td>
                    <td className="break-words px-4 py-3">{partnersText(row)}</td>
                    <td className="break-words px-4 py-3">{row.deletedAt ? "Deleted" : gpsLabel(row.gpsStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.truncated ? (
            <p className="border-t border-slate-100 px-4 py-3 text-xs font-bold text-slate-500">More visits were saved than this list shows.</p>
          ) : null}
        </>
      )}
    </PortalSection>
  );
}
