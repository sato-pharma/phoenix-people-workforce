"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

// "Score a probationer" — the companion to the "My feedback tasks" inbox above it.
//
// The inbox can only ever offer the DV-Days the CRM produced for this evaluator, so a manager whose
// double visits with a rep were never captured had no way to file that rep's score at all (owner
// report 2026-08-20). This panel lists every probationer in the caller's scope that the inbox
// CANNOT reach and opens a scorecard for them on demand, landing on the same structured DV-Day
// feedback form.
//
// Deliberately DISJOINT from the inbox: the page hands this panel only probationers with no open
// DV-Day of the caller's, so the same rep never appears in both lists. Same owner UX rule that
// shaped the inbox — one row per probationer, never a repeat of the same names.
//
// Grouped by product line because a National Sales Manager's list now spans all of them (owner
// instruction 2026-08-20): a bare list of fifteen names gives no clue which team each one is on.

export type ScorableProbationerView = {
  employeeHrId: string;
  employeeName: string;
  evaluatorRoleLabel: string;
  probationEndLabel: string;
  lineLabel: string;
  submittedCount: number;
  requiredCount: number;
};

/** One group per line, lines in first-appearance order (the server already sorted by end date). */
function groupByLine(probationers: ScorableProbationerView[]) {
  const groups = new Map<string, ScorableProbationerView[]>();
  for (const probationer of probationers) {
    const key = probationer.lineLabel;
    const existing = groups.get(key);
    if (existing) existing.push(probationer);
    else groups.set(key, [probationer]);
  }
  return Array.from(groups, ([lineLabel, members]) => ({ lineLabel, members }));
}

export function ProbationScorecardLauncher({
  probationers,
}: {
  probationers: ScorableProbationerView[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [busyHrId, setBusyHrId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (probationers.length === 0) return null;

  async function openScorecard(employeeHrId: string) {
    setBusyHrId(employeeHrId);
    setError(null);
    try {
      const response = await fetch("/api/probation/scorecards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeHrId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { dvDayId?: string; error?: string };
      if (!response.ok || !payload.dvDayId) {
        setError(payload.error ?? "The scorecard could not be opened.");
        setBusyHrId(null);
        return;
      }
      router.push(`/employee-portals/probation/feedback/${encodeURIComponent(payload.dvDayId)}`);
    } catch {
      setError("The scorecard could not be opened. Check your connection and try again.");
      setBusyHrId(null);
    }
  }

  return (
    <section className={`rounded-lg border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          Score a probationer
          <span className="rounded-full bg-phx-ink px-2 py-0.5 text-xs font-medium text-white">
            {probationers.length} {probationers.length === 1 ? "rep" : "reps"}
          </span>
        </span>
        <span className="text-xs text-slate-400">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-100">
          <p className="px-4 pt-3 text-xs text-slate-500">
            Everyone in your probation scope you have no open Double-Visit feedback for. Opening a
            scorecard records your assessment against today&apos;s date — no field visits are claimed.
          </p>
          {error && (
            <p className="mx-4 mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </p>
          )}
          <div className="mt-2">
            {groupByLine(probationers).map((group) => (
              <div key={group.lineLabel}>
                <div className="whitespace-nowrap border-y border-slate-100 bg-slate-50 px-4 py-1.5 text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
                  {group.lineLabel}
                </div>
                <ul className="divide-y divide-slate-100">
                  {group.members.map((probationer) => {
                    const busy = busyHrId === probationer.employeeHrId;
                    return (
                      <li
                        key={probationer.employeeHrId}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                      >
                        <div className="min-w-0">
                          <div className="whitespace-nowrap text-sm font-semibold text-slate-800">
                            {probationer.employeeName}
                          </div>
                          <div className="whitespace-nowrap text-xs text-slate-500">
                            Scoring as {probationer.evaluatorRoleLabel} · Probation ends{" "}
                            {probationer.probationEndLabel}
                          </div>
                        </div>
                        <span className="flex items-center gap-2">
                          {probationer.submittedCount > 0 && (
                            <span className="whitespace-nowrap rounded-full border border-phx-ok-line bg-phx-ok-bg px-2 py-0.5 text-phx-sm font-medium text-phx-ok">
                              {probationer.submittedCount} of {Math.max(probationer.requiredCount, probationer.submittedCount)} submitted
                            </span>
                          )}
                          <button
                            disabled={busy}
                            onClick={() => openScorecard(probationer.employeeHrId)}
                            className="whitespace-nowrap rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                          >
                            {busy ? "Opening" : probationer.submittedCount > 0 ? "Score again" : "Score now"}
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
