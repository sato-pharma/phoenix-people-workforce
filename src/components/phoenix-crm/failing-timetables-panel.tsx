/**
 * Timetables that keep failing — the buildings whose timetable photo was refused at the door on two or
 * more different days (owner, 14 Nov 2026, "List + declare"; `failing-timetable-rules.ts`).
 *
 * It sits on the Polyclinics tab of the Super Admin's and the SFE Manager's Place checks, above the
 * buildings, and each row opens its own building in the list below. A district manager's board is never
 * handed it.
 *
 * 🔴 HOUSEKEEPING, NOT A FLAG: it says where reps are stuck, never who did something wrong. Nothing on a
 * row acts; the one decision it can lead to — declaring that a building has no timetable — is on the
 * building itself, and the Super Admin's alone.
 */

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmButton, CrmCardsOnPhone, CrmPill, CrmTable, crmTdClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import type { FailingTimetableRow, FailingTimetablesView } from "@/lib/phoenix-crm/view-types";

function Building({ row }: { row: FailingTimetableRow }) {
  return (
    <>
      <p className="break-words text-sm font-bold text-slate-900" dir="auto">
        {row.name}
      </p>
      <p className="break-words text-xs text-slate-500">
        {row.repName} · {row.territory}
      </p>
    </>
  );
}

/** What happened there and how the building stands, the same words in the table cell and on the phone card. */
function WhatHappened({ row }: { row: FailingTimetableRow }) {
  return (
    <>
      <p className="break-words text-sm text-slate-700">{row.sentence}</p>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
        {row.hasTimetable ? <CrmPill>A timetable is on file</CrmPill> : <CrmPill tone="warn">No timetable on file</CrmPill>}
        {row.held ? <CrmPill tone="warn">Waiting for a decision</CrmPill> : null}
        <CrmPill tone={row.seated === 0 ? "neutral" : "info"}>
          {row.seated === 0 ? "Nobody seated yet" : `${row.seated} ${row.seated === 1 ? "customer seated" : "customers seated"}`}
        </CrmPill>
      </div>
    </>
  );
}

export function FailingTimetablesPanel({ onOpen, opened, view }: { onOpen: (sharedPlaceId: string) => void; opened: string | null; view: FailingTimetablesView }) {
  if (view.total === 0) return null;
  const more = view.total - view.rows.length;
  return (
    <AdminTableShell
      title={`Timetables that keep failing (${view.total})`}
      description={`Buildings where a timetable photo was refused on two or more different days in the last ${view.lookbackDays} days, the most days first. A rep keeps coming back to these and leaving without a seating: the board may be hard to photograph, or the building may have no timetable at all. Open a building to look at it. Nobody is told anything by this list.${
        view.capped ? " The window holds more refusals than one read can carry, so this list is a floor." : ""
      }${more > 0 ? ` The first ${view.rows.length} are shown.` : ""}`}
    >
      {/* Desktop: the module's own table. Three columns — the last refusal sits under what happened — so the
          button's column is wide enough beside the sidebar. */}
      <CrmTable columns={["32%", "46%", "22%"]}>
        <thead>
          <tr>
            <th className={crmThClassName} scope="col">
              Building
            </th>
            <th className={crmThClassName} scope="col">
              What happened
            </th>
            <th className={crmThClassName} scope="col">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.sharedPlaceId}>
              <td className={crmTdClassName}>
                <Building row={row} />
              </td>
              <td className={crmTdClassName}>
                <WhatHappened row={row} />
                <p className="mt-1.5 break-words text-xs font-normal text-slate-500">Last refused {row.lastRefusedAtText}</p>
              </td>
              <td className={crmTdClassName}>
                <CrmButton disabled={opened === row.sharedPlaceId} onClick={() => onOpen(row.sharedPlaceId)} size="sm">
                  {opened === row.sharedPlaceId ? "Opened below" : "Open this building"}
                </CrmButton>
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>

      {/* Phone: the same buildings as cards. */}
      <CrmCardsOnPhone>
        {view.rows.map((row) => (
          <div key={row.sharedPlaceId} className="px-4 py-4">
            <Building row={row} />
            <div className="mt-2">
              <WhatHappened row={row} />
            </div>
            <p className="mt-2 break-words text-xs text-slate-500">Last refused {row.lastRefusedAtText}</p>
            <div className="mt-3">
              <CrmButton disabled={opened === row.sharedPlaceId} onClick={() => onOpen(row.sharedPlaceId)} size="sm">
                {opened === row.sharedPlaceId ? "Opened below" : "Open this building"}
              </CrmButton>
            </div>
          </div>
        ))}
      </CrmCardsOnPhone>
    </AdminTableShell>
  );
}
