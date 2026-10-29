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
        <UserX className="h-8 w-8 text-phx-ink-faint" />
        <p className="text-sm font-bold text-phx-ink">No archived evaluations yet</p>
        <p className="max-w-md text-sm text-phx-ink-soft">
          When you import a coaching workbook, evaluations for reps who have resigned (no matching active
          employee) are preserved here so the coach&apos;s scoring and notes are never lost.
        </p>
      </Card>
    );
  }

  return (
    <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
      {/*
        Fits-the-screen golden rule (AGENTS.md §4). This was `overflow-x-auto` over a
        `min-w-[1040px]` floor with NO mobile alternative anywhere in this file, so the coach
        notes — the whole point of an archived coaching record — sat off the right edge at every
        width, and on a 375px phone the table was nearly three screens wide.

        Merged, never shrunk, and nothing is dropped. Six columns become three:
          * Rep, Territory and HR-ID all identify one person -> one "Rep" cell.
          * Coaching date and Overall are the same visit -> one "Coaching" cell.
        That leaves 60% of the width for the notes, which is where it belongs.
      */}
      <div>
        <table className="w-full table-fixed border-collapse text-left">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[18%]" />
            <col className="w-[60%]" />
          </colgroup>
          <thead className="bg-phx-ink text-phx-xs font-black uppercase tracking-[0.12em] text-white">
            <tr>
              <th className="break-words px-4 py-3">Rep</th>
              <th className="break-words px-4 py-3">Coaching</th>
              <th className="break-words px-4 py-3">Coach notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-t border-[#FCE7D2] align-top text-sm hover:bg-[#FFFBF7]" key={row.id}>
                <td className="break-words px-4 py-3">
                  <p className="break-words font-black text-phx-ink">{row.rep_name ?? row.source_name}</p>
                  {row.rep_code ? <p className="break-words text-xs text-phx-ink-faint">Grade {row.rep_code}</p> : null}
                  <p className="break-words text-xs text-phx-ink-2">{row.territory ?? "—"}</p>
                </td>
                <td className="break-words px-4 py-3 text-phx-ink-2">
                  {row.coaching_date ?? "—"}
                  {row.coaching_year ? (
                    <span className="block text-xs text-phx-ink-faint">Q{row.coaching_quarter} {row.coaching_year}</span>
                  ) : null}
                  <span className="mt-1 block font-black text-phx-ink">
                    {row.overall_score != null ? `${row.overall_score}/100` : `${scoreSum(row.scores)}/100`}
                  </span>
                </td>
                <td className="break-words px-4 py-3 text-phx-ink-2">
                  <div className="space-y-1.5">
                    {row.area_of_development ? (
                      <p><span className="font-bold text-phx-ink">Develop:</span> {row.area_of_development}</p>
                    ) : null}
                    {row.strength_points ? (
                      <p><span className="font-bold text-phx-ink">Strengths:</span> {row.strength_points}</p>
                    ) : null}
                    {row.general_remarks ? (
                      <p><span className="font-bold text-phx-ink">Remarks:</span> {row.general_remarks}</p>
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
