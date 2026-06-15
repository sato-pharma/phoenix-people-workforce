"use client";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { egp } from "@/components/outstation/expense-shared/formatters";
import type { ExpenseSpenderRow } from "@/components/outstation/expense-shared/types";

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
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-[#0F172A] text-white">
              <th className="border border-[#1E293B] px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-[0.08em]">#</th>
              <th className="border border-[#1E293B] px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-[0.08em]">Employee</th>
              <th className="border border-[#1E293B] px-3 py-2.5 text-right text-[11px] font-black uppercase tracking-[0.08em]">Trips</th>
              <th className="border border-[#1E293B] px-3 py-2.5 text-right text-[11px] font-black uppercase tracking-[0.08em]">Total</th>
              <th className="border border-[#1E293B] px-3 py-2.5 text-left text-[11px] font-black uppercase tracking-[0.08em]">Share</th>
            </tr>
          </thead>
          <tbody>
            {topSpenders.length === 0 ? (
              <tr>
                <td className="border border-[#FCE7D2] px-3 py-8 text-center text-sm font-semibold text-slate-400" colSpan={5}>
                  No spenders for these filters.
                </td>
              </tr>
            ) : (
              topSpenders.map((row, index) => (
                <tr
                  key={row.hrId}
                  className="cursor-pointer bg-white hover:bg-[#FFF7ED]"
                  onClick={() => onSelectEmployee?.(row.hrId)}
                >
                  <td className="border border-[#FCE7D2] px-3 py-2 font-black text-slate-400">{index + 1}</td>
                  <td className="border border-[#FCE7D2] px-3 py-2 font-semibold text-slate-800">{row.name}</td>
                  <td className="border border-[#FCE7D2] px-3 py-2 text-right tabular-nums text-slate-700">{row.trips}</td>
                  <td className="border border-[#FCE7D2] px-3 py-2 text-right font-black tabular-nums text-slate-900">{egp(row.total)}</td>
                  <td className="border border-[#FCE7D2] px-3 py-2">
                    <span className="relative block h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-orange-400 to-orange-600"
                        style={{ width: `${Math.max(4, (row.total / maxSpend) * 100)}%` }}
                      />
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}
