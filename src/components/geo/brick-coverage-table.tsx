"use client";

import type { GeoBrickRecord } from "@/lib/geo-intelligence/types";

import {
  AdminSectionHeader,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";

function tone(status: GeoBrickRecord["coverageStatus"]) {
  switch (status) {
    case "covered":
      return "bg-emerald-50 text-emerald-700 ring-emerald-100";
    case "vacant":
      return "bg-slate-100 text-slate-700 ring-slate-200";
    case "overlapping":
      return "bg-amber-50 text-amber-700 ring-amber-100";
    default:
      return "bg-orange-50 text-orange-700 ring-orange-100";
  }
}

export function BrickCoverageTable({
  bricks,
}: {
  bricks: GeoBrickRecord[];
}) {
  return (
    <Card className={`${adminPanelClassName} overflow-hidden p-0`}>
      <AdminSectionHeader
        description="Review brick assignment status by area, employee, and coverage quality."
        title="Brick registry"
      />
      <div className="overflow-x-auto pb-1">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[#F8FAFC] text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]">
            <tr>
              <th className="px-4 py-3">Brick</th>
              <th className="px-4 py-3">Line</th>
              <th className="px-4 py-3">Area</th>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {bricks.length === 0 ? (
              <tr>
                <td className="px-4 py-7 text-sm text-[#64748B]" colSpan={5}>
                  No brick data loaded yet.
                </td>
              </tr>
            ) : (
              bricks.map((brick) => (
                <tr className="border-b border-[#E2E8F0] transition hover:bg-[#FCFDFE]" key={brick.brickCode}>
                  <td className="px-4 py-3 font-semibold text-slate-900">{brick.brickName}</td>
                  <td className="px-4 py-3 text-slate-700">{brick.line ?? "N/A"}</td>
                  <td className="px-4 py-3 text-slate-700">{brick.area ?? "N/A"}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {brick.employeeName ?? brick.employeeHrId ?? "Unassigned"}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${tone(brick.coverageStatus)}`}>
                      {brick.coverageStatus}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
