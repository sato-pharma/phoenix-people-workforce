"use client";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { egp } from "@/components/outstation/expense-shared/formatters";
import type { ExpenseSpenderRow } from "@/components/outstation/expense-shared/types";

const HEAD_CELL = "border border-[#1E293B] px-3 py-2.5 text-phx-xs font-black uppercase tracking-[0.08em]";
const BODY_CELL = "border border-[#FCE7D2] px-3 py-2";

/** The share bar is the one column that reads as well in a card as in a row, so both halves use it. */
function ShareBar({ share }: { share: number }) {
  return (
    <span className="relative block h-2 w-full overflow-hidden bg-slate-100">
      <span
        className="absolute inset-y-0 left-0 bg-orange-500"
        style={{ width: `${Math.max(4, share * 100)}%` }}
      />
    </span>
  );
}

export function ExpenseLeaderboards({
  topSpenders,
  onSelectEmployee,
}: {
  topSpenders: ExpenseSpenderRow[];
  onSelectEmployee?: (hrId: string) => void;
}) {
  const maxSpend = topSpenders.reduce((peak, row) => Math.max(peak, row.total), 0) || 1;

  return (
    <AdminTableShell title="Top spenders" description="Highest total outstation spend. Click a row to filter.">
      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-8 text-center text-sm font-semibold text-slate-400">
            No spenders for these filters.
          </p>
        }
        getKey={(row) => row.hrId}
        items={topSpenders}
        renderCard={(row, index) => (
          // The desktop row is clickable and that is the only way to filter by employee, so the
          // card has to carry it too — a card that merely displays the same numbers would quietly
          // remove a capability on the phone rather than restyle it.
          <button
            className="w-full text-left"
            onClick={() => onSelectEmployee?.(row.hrId)}
            type="button"
          >
            <PortalRecordCard
              accent="orange"
              meta={`#${index + 1} · ${row.trips} ${row.trips === 1 ? "trip" : "trips"}`}
              status={<span className="text-sm font-black tabular-nums text-slate-900">{egp(row.total)}</span>}
              title={row.name}
            >
              <ShareBar share={row.total / maxSpend} />
            </PortalRecordCard>
          </button>
        )}
        renderTable={() => (
          <PortalDesktopTable
            className="border-collapse"
            cols={
              <colgroup>
                <col className="w-[8%]" />
                <col className="w-[34%]" />
                <col className="w-[14%]" />
                <col className="w-[20%]" />
                <col className="w-[24%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="bg-phx-ink text-white">
                <th className={`${HEAD_CELL} text-left`}>#</th>
                <th className={`${HEAD_CELL} text-left`}>Employee</th>
                <th className={`${HEAD_CELL} text-right`}>Trips</th>
                <th className={`${HEAD_CELL} text-right`}>Total</th>
                <th className={`${HEAD_CELL} text-left`}>Share</th>
              </tr>
            </thead>
            <tbody>
              {topSpenders.map((row, index) => (
                <tr
                  key={row.hrId}
                  className="cursor-pointer bg-white hover:bg-phx-accent-soft"
                  onClick={() => onSelectEmployee?.(row.hrId)}
                >
                  <td className={`${BODY_CELL} font-black text-slate-400`}>{index + 1}</td>
                  <td className={`${BODY_CELL} font-semibold text-slate-800`}>{row.name}</td>
                  <td className={`${BODY_CELL} text-right tabular-nums text-slate-700`}>{row.trips}</td>
                  <td className={`${BODY_CELL} text-right font-black tabular-nums text-slate-900`}>{egp(row.total)}</td>
                  <td className={BODY_CELL}>
                    <ShareBar share={row.total / maxSpend} />
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </AdminTableShell>
  );
}
