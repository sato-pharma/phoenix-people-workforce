"use client";

import { useState } from "react";
import { History } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  PreviousNonEmployeeCandidate,
  PreviousRunCopyResult,
} from "@/lib/automated-payroll/types";
import { cn } from "@/lib/utils";

import { formatPayrollMoney, formatPayrollMoneyEgp } from "./format";

type Props = {
  runId: string;
  /** Called once people were copied, so the list underneath reloads. */
  onCopied: () => Promise<void> | void;
};

/** "2026-10" → "October 2026". */
function monthName(monthKey: string | null): string {
  if (!monthKey) return "last month";
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function copyable(candidate: PreviousNonEmployeeCandidate): boolean {
  return !candidate.blockedReason && !candidate.alreadyOnThisRun;
}

/**
 * COPY LAST MONTH'S LIST (owner, 2026-11-24, after November's Part 1 opened with no non-employees). The
 * first press only READS: it shows the latest published month's people, amounts and banks, each ticked
 * when it can be copied. Nothing is written until the second press, and only for the people ticked —
 * the decision is made here, on the screen, by whoever is running payroll.
 */
export function PreviousMonthNonEmployees({ runId, onCopied }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fromMonthKey, setFromMonthKey] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<PreviousNonEmployeeCandidate[]>([]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/non-employees/previous`);
      const data = await res.json().catch(() => {
        throw new Error(`The server did not answer properly (${res.status}). Reload the page.`);
      });
      if (!res.ok) throw new Error(data.error ?? "Failed to load last month's list.");
      const rows = (data.candidates ?? []) as PreviousNonEmployeeCandidate[];
      setFromMonthKey((data.fromMonthKey as string | null) ?? null);
      setCandidates(rows);
      setTicked(new Set(rows.filter(copyable).map((row) => row.id)));
      setOpen(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load last month's list.");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id: string, on: boolean) => {
    setTicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const chosen = candidates.filter((row) => ticked.has(row.id) && copyable(row));
  const chosenTotal = chosen.reduce((sum, row) => sum + row.totalSalary, 0);

  const copy = async () => {
    if (chosen.length === 0) return;
    setCopying(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/non-employees/previous`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chosen.map((row) => row.id) }),
      });
      const data = (await res.json().catch(() => {
        throw new Error(`The server did not answer properly (${res.status}). Reload to see what was saved.`);
      })) as Partial<PreviousRunCopyResult> & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to copy last month's list.");
      const copied = data.copied ?? [];
      const added = data.addedToStandingList ?? [];
      const left = data.notCopied ?? [];
      setNote(
        [
          copied.length > 0
            ? `Copied ${copied.length} ${copied.length === 1 ? "person" : "people"} from ${monthName(fromMonthKey)}: ${copied.join(", ")}.`
            : "Nobody was copied.",
          added.length > 0 ? `Put back on the standing list, so next month fills itself: ${added.join(", ")}.` : "",
          ...left.map((row) => `Not copied — ${row.name}: ${row.reason}`),
        ]
          .filter(Boolean)
          .join(" "),
      );
      setOpen(false);
      await onCopied();
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Failed to copy last month's list.");
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {!open ? (
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void load()}
          className="self-start whitespace-nowrap"
        >
          <History className="mr-1.5 size-4" />
          {loading ? "Loading…" : "Copy last month's list"}
        </Button>
      ) : null}

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
      {note ? (
        <div className="border-l-4 border-emerald-400 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">{note}</div>
      ) : null}

      {open ? (
        <div className="border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-bold text-slate-900">Non-employees paid in {monthName(fromMonthKey)}</p>
            <p className="mt-0.5 text-sm text-slate-500">
              Tick who is paid again this month. Each person comes back at the amount shown, and goes back on the
              standing list if they are not on it. Nothing is copied until you press Copy.
            </p>
          </div>
          {candidates.length === 0 ? (
            <p className="px-4 py-3 text-sm text-slate-500">
              {fromMonthKey ? `${monthName(fromMonthKey)} paid no non-employees.` : "There is no earlier published month."}
            </p>
          ) : (
            <ul>
              {candidates.map((row) => {
                const can = copyable(row);
                const reason = row.blockedReason
                  ? row.blockedReason
                  : row.alreadyOnThisRun
                    ? "Already on this month's list."
                    : null;
                return (
                  <li key={row.id} className="border-b border-slate-100 last:border-b-0">
                    <label
                      className={cn(
                        "flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5",
                        can ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={can && ticked.has(row.id)}
                        disabled={!can || copying}
                        onChange={(event) => toggle(row.id, event.target.checked)}
                        className="mt-0.5 size-4 accent-orange-600"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-semibold text-slate-900">
                          {row.fullNameEn || row.fullNameAr}
                        </span>
                        <span className="block break-words text-xs text-slate-500" dir="rtl">
                          {row.fullNameAr}
                        </span>
                        <span className="block break-words text-xs text-slate-500">
                          {row.part === "first" ? "Part 1" : "Part 2"} · {row.bankName || "No bank"}
                        </span>
                        {reason ? <span className="block break-words text-xs text-rose-700">{reason}</span> : null}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">
                        {formatPayrollMoney(row.totalSalary)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
            <span className="text-sm text-slate-600">
              {chosen.length} ticked · {formatPayrollMoneyEgp(chosenTotal)}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={copying} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={copying || chosen.length === 0} onClick={() => void copy()}>
                {copying
                  ? "Copying…"
                  : `Copy ${chosen.length} ${chosen.length === 1 ? "person" : "people"}`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
