"use client";

/**
 * Phoenix CRM — customers waiting to be captured again, on the Super Admin's Place checks page.
 *
 * A refused place sends its customer back to To validate, and until 2026-10-08 nothing anywhere said
 * how long he had been waiting there: measured that day, 0 of the 22 reopened customers had been
 * validated again, the average wait 40.8 hours and the oldest 76.7. This list carries the AGE and the
 * reason that was chosen — never a verdict and never an SLA, because the module publishes none.
 *
 * Read-only. Nothing here acts: the rep validates the customer again from his own list.
 *
 * Phone cards first, then the module's `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller). Square corners throughout.
 */

import { useState } from "react";

import { CrmCardsOnPhone, CrmPill, CrmShowMore, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import type { ReopenedCustomerRow } from "@/lib/phoenix-crm/view-types";

const PAGE = 25;

/** "3 days 4 hours", "17 hours" — the wait in words a reader takes in at a glance. */
function waitText(hours: number): string {
  if (hours < 1) return "Under an hour";
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  const dayText = days === 0 ? null : `${days} ${days === 1 ? "day" : "days"}`;
  const hourText = rest === 0 ? null : `${rest} ${rest === 1 ? "hour" : "hours"}`;
  return [dayText, hourText].filter(Boolean).join(" ");
}

function Who({ row }: { row: ReopenedCustomerRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {row.customerName}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">{row.listType}</p>
      <p className="break-words text-sm text-slate-700">{row.repName}</p>
      <p className="break-words text-xs text-slate-500">{row.territory}</p>
      {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
    </div>
  );
}

function Waiting({ row }: { row: ReopenedCustomerRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900">{waitText(row.waitingHours)}</p>
      <p className="break-words text-xs text-slate-500">Back under To validate since {row.reopenedAtText}</p>
    </div>
  );
}

function Reason({ row }: { row: ReopenedCustomerRow }) {
  return (
    <p className="break-words text-sm text-slate-700">
      {row.reasonLabel ?? "No reason was chosen — refused before the reason list existed."}
    </p>
  );
}

export function ReopenedCustomerList({ rows }: { rows: ReopenedCustomerRow[] }) {
  const [page, setPage] = useState(1);
  const shown = rows.slice(0, page * PAGE);
  return (
    <div className="min-w-0 space-y-3">
      <CrmCardsOnPhone>
        {shown.map((row) => (
          <div key={row.customerId} className="space-y-2 px-4 py-4">
            <Who row={row} />
            <Waiting row={row} />
            <Reason row={row} />
          </div>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["38%", "28%", "34%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Customer and rep</th>
            <th className={crmThClassName}>Waiting</th>
            <th className={crmThClassName}>What was wrong with the photo</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.customerId} className="even:bg-slate-50/60">
              <td className={crmTdClassName}>
                <Who row={row} />
              </td>
              <td className={crmTdClassName}>
                <Waiting row={row} />
              </td>
              <td className={crmTdClassName}>
                <Reason row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
      <div className="px-4 pb-4">
        <CrmShowMore left={rows.length - shown.length} onMore={() => setPage((current) => current + 1)} page={PAGE} />
      </div>
    </div>
  );
}
