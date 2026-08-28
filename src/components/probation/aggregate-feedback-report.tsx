"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date-only";
import type {
  AggregateFeedbackRow,
  FeedbackRecommendation,
  FeedbackSubmitterRole,
} from "@/lib/probation/feedback-service";

const RECOMMENDATION_LABELS: Record<FeedbackRecommendation, string> = {
  recommend_pass: "Pass",
  recommend_dismissal: "Dismiss",
  not_sure_yet: "Not Sure",
};

const RECOMMENDATION_COLORS: Record<FeedbackRecommendation, string> = {
  recommend_pass: "bg-emerald-50 text-emerald-700 border-emerald-200",
  recommend_dismissal: "bg-rose-50 text-rose-700 border-rose-200",
  not_sure_yet: "bg-amber-50 text-amber-700 border-amber-200",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

function RecommendationChip({ recommendation }: { recommendation: FeedbackRecommendation }) {
  return (
    <span
      className={cn(
        "inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold",
        RECOMMENDATION_COLORS[recommendation],
      )}
    >
      {RECOMMENDATION_LABELS[recommendation]}
    </span>
  );
}

function RoleCell({
  role,
  submissions,
}: {
  role: FeedbackSubmitterRole;
  submissions: AggregateFeedbackRow["submissions"];
}) {
  const matching = submissions.filter((s) => s.submitterRole === role);
  if (matching.length === 0) return <span className="text-[11px] text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {matching.map((s, i) => (
        <RecommendationChip key={i} recommendation={s.recommendation} />
      ))}
    </div>
  );
}

export function AggregateFeedbackReport() {
  const [rows, setRows] = useState<AggregateFeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lineFilter, setLineFilter] = useState("__all__");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/probation/feedback/aggregate")
      .then((r) => r.json())
      .then((data: { rows?: AggregateFeedbackRow[] }) => {
        if (!cancelled) {
          setRows(data.rows ?? []);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const lines = Array.from(new Set(rows.map((r) => r.lineName).filter(Boolean))).sort() as string[];
  const filtered =
    lineFilter === "__all__" ? rows : rows.filter((r) => r.lineName === lineFilter);

  if (loading) {
    return (
      <p className="px-4 py-8 text-center text-xs text-slate-400">Loading feedback report…</p>
    );
  }
  if (error) {
    return (
      <p className="px-4 py-8 text-center text-xs text-rose-500">Failed to load: {error}</p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3">
        <select
          className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 shadow-sm"
          onChange={(e) => setLineFilter(e.target.value)}
          value={lineFilter}
        >
          <option value="__all__">All lines</option>
          {lines.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-slate-500">{filtered.length} employees</span>
        <a
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 shadow-sm hover:border-slate-300 hover:bg-slate-50"
          href="/api/exports?report=probation-feedback&format=xlsx"
        >
          <Download className="h-3.5 w-3.5" />
          Export
        </a>
      </div>

      <div className="overflow-x-auto bg-white/80">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead className="bg-slate-50/90">
            <tr className="border-b border-slate-200 text-xs uppercase tracking-[0.12em] text-slate-500">
              {[
                "Employee",
                "Line",
                "Hire Date",
                "End Date",
                "DV Status",
                "DM",
                "NSM",
                "PM / GPM",
                "TM",
                "TA",
              ].map((col) => (
                <th
                  className="px-2.5 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-phx-ink-soft"
                  key={col}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-phx-line">
            {filtered.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-8 text-center text-xs text-slate-400"
                  colSpan={9}
                >
                  No feedback data yet for the current scope.
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr
                  className="align-top transition-colors hover:bg-slate-50/65"
                  key={row.employeeHrId}
                >
                  <td className="px-2.5 py-2">
                    <p className="font-semibold text-slate-800">{row.employeeName}</p>
                    <p className="font-mono text-[10px] text-slate-400">{row.employeeHrId}</p>
                  </td>
                  <td className="px-2.5 py-2 text-slate-600">{row.lineName ?? "—"}</td>
                  <td className="px-2.5 py-2 text-slate-600">{formatDate(row.hireDate)}</td>
                  <td className="px-2.5 py-2 text-slate-600">{formatDate(row.probationEndDate)}</td>
                  <td className="px-2.5 py-2">
                    <span
                      className={cn(
                        "inline-block rounded border px-1.5 py-0.5 text-[10px] font-semibold",
                        row.dvTotalApplicable === 0
                          ? "border-slate-200 bg-slate-50 text-slate-400"
                          : row.dvDoneCount === row.dvTotalApplicable
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : row.dvDoneCount > 0
                              ? "border-amber-200 bg-amber-50 text-amber-700"
                              : "border-slate-200 bg-slate-50 text-slate-500",
                      )}
                    >
                      {row.dvDoneCount}/{row.dvTotalApplicable} DV
                    </span>
                  </td>
                  <td className="px-2.5 py-2">
                    <RoleCell role="dm" submissions={row.submissions} />
                  </td>
                  <td className="px-2.5 py-2">
                    <RoleCell role="nsm" submissions={row.submissions} />
                  </td>
                  <td className="px-2.5 py-2">
                    <RoleCell role="pm_gpm" submissions={row.submissions} />
                  </td>
                  <td className="px-2.5 py-2">
                    <RoleCell role="tm" submissions={row.submissions} />
                  </td>
                  <td className="px-2.5 py-2">
                    <RoleCell role="ta" submissions={row.submissions} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
