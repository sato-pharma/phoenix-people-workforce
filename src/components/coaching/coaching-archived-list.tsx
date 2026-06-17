import { UserX } from "lucide-react";

import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CoachingArchivedEvaluationRow } from "@/lib/coaching/archived";

function scoreSum(scores: Record<string, number> | null | undefined) {
  if (!scores) return 0;
  return Object.values(scores).reduce((total, value) => total + (Number(value) || 0), 0);
}

export function CoachingArchivedList({ rows }: { rows: CoachingArchivedEvaluationRow[] }) {
  if (rows.length === 0) {
    return (
      <Card className={cn(adminPanelClassName, "flex flex-col items-center gap-3 p-10 text-center")}>
        <UserX className="h-8 w-8 text-[#94A3B8]" />
        <p className="text-sm font-bold text-[#0F172A]">No archived evaluations yet</p>
        <p className="max-w-md text-sm text-[#64748B]">
          When you import a coaching workbook, evaluations for reps who have resigned (no matching active
          employee) are preserved here so the coach&apos;s scoring and notes are never lost.
        </p>
      </Card>
    );
  }

  return (
    <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
      <div className="overflow-x-auto">
        <table className="min-w-[1040px] w-full border-collapse text-left">
          <thead className="bg-[#0F172A] text-[11px] font-black uppercase tracking-[0.12em] text-white">
            <tr>
              <th className="px-4 py-3">Rep</th>
              <th className="px-4 py-3">Territory</th>
              <th className="px-4 py-3">HR-ID</th>
              <th className="px-4 py-3">Coaching date</th>
              <th className="px-4 py-3">Overall</th>
              <th className="px-4 py-3">Coach notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t border-[#FCE7D2] align-top text-sm hover:bg-[#FFFBF7]" key={row.id}>
                <td className="px-4 py-3">
                  <p className="font-black text-[#0F172A]">{row.rep_name ?? row.source_name}</p>
                  {row.rep_code ? <p className="text-xs text-[#94A3B8]">Grade {row.rep_code}</p> : null}
                </td>
                <td className="px-4 py-3 text-[#475569]">{row.territory ?? "—"}</td>
                <td className="px-4 py-3 text-[#475569]">{row.claimed_hr_id ?? "—"}</td>
                <td className="px-4 py-3 text-[#475569]">
                  {row.coaching_date ?? "—"}
                  {row.coaching_year ? (
                    <span className="block text-xs text-[#94A3B8]">Q{row.coaching_quarter} {row.coaching_year}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3 font-black text-[#0F172A]">
                  {row.overall_score != null ? `${row.overall_score}/100` : `${scoreSum(row.scores)}/100`}
                </td>
                <td className="px-4 py-3 text-[#475569]">
                  <div className="max-w-xl space-y-1.5">
                    {row.area_of_development ? (
                      <p><span className="font-bold text-[#0F172A]">Develop:</span> {row.area_of_development}</p>
                    ) : null}
                    {row.strength_points ? (
                      <p><span className="font-bold text-[#0F172A]">Strengths:</span> {row.strength_points}</p>
                    ) : null}
                    {row.general_remarks ? (
                      <p><span className="font-bold text-[#0F172A]">Remarks:</span> {row.general_remarks}</p>
                    ) : null}
                    {!row.area_of_development && !row.strength_points && !row.general_remarks ? "—" : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
