"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { stepDefinition } from "@/lib/automated-payroll/step-definitions";
import type {
  MonthlySalaryRun,
  ReconciliationTotals,
  StepKey,
  StepState,
} from "@/lib/automated-payroll/types";
import { PART1_STEP_KEYS, PART2_STEP_KEYS, stepPhase } from "@/lib/automated-payroll/types";
import { cn } from "@/lib/utils";

import { RecommendationStep } from "./recommendation-step";
import { SelectField } from "./select-field";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Props = {
  initialMonth: number;
  initialYear: number;
  isPublisher: boolean;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function AutomatedPayrollWizard({ initialMonth, initialYear, isPublisher }: Props) {
  const [month, setMonth] = useState(initialMonth);
  const [year, setYear] = useState(initialYear);
  const [run, setRun] = useState<MonthlySalaryRun | null>(null);
  const [stepStates, setStepStates] = useState<StepState[]>([]);
  const [activeStep, setActiveStep] = useState<StepKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recon, setRecon] = useState<ReconciliationTotals | null>(null);

  const confirmedSet = useMemo(
    () => new Set(stepStates.filter((state) => state.status === "confirmed").map((state) => state.stepKey)),
    [stepStates],
  );
  const part1Confirmed = PART1_STEP_KEYS.filter((key) => confirmedSet.has(key)).length;
  const part2Confirmed = PART2_STEP_KEYS.filter((key) => confirmedSet.has(key)).length;
  const part1AllConfirmed = part1Confirmed === PART1_STEP_KEYS.length;
  const part2AllConfirmed = part2Confirmed === PART2_STEP_KEYS.length;

  const loadRun = useCallback(async (m: number, y: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs?month=${m}&year=${y}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load run.");
      setRun(data.run ?? null);
      setStepStates(data.view?.stepStates ?? []);
      setRecon(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load run.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRun(month, year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = async (url: string, okMessage?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Action failed.");
      if (okMessage) setNotice(okMessage);
      await loadRun(month, year);
      return data;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onStartClick = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ month, year }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start run.");
      await loadRun(month, year);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Failed to start run.");
    } finally {
      setBusy(false);
    }
  };

  const loadRecon = async () => {
    if (!run) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${run.id}/reconcile`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to reconcile.");
      setRecon(data.totals as ReconciliationTotals);
    } catch (reconError) {
      setError(reconError instanceof Error ? reconError.message : "Failed to reconcile.");
    } finally {
      setBusy(false);
    }
  };

  const stepLocked = (stepKey: StepKey): boolean => {
    if (!run) return true;
    return run.phase !== stepPhase(stepKey);
  };

  /**
   * Horizontal pill strip instead of a vertical stacked list — frees the 260px
   * sidebar column entirely so the step-nav sits ABOVE the recommendation grid and
   * the grid gets the page's full width (owner request 2026-07-25: the grid was
   * cramped fighting a fixed-width sidebar for space). Pills wrap onto a second
   * line on narrow viewports rather than the row ever h-scrolling.
   */
  const renderStepPills = (keys: readonly StepKey[]) => (
    <div className="flex flex-wrap gap-2">
      {keys.map((key, index) => {
        const definition = stepDefinition(key);
        const isConfirmed = confirmedSet.has(key);
        const isActive = activeStep === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setActiveStep(key)}
            className={cn(
              "flex items-center gap-1.5 border px-2.5 py-1.5 text-xs transition-colors",
              isActive
                ? "border-orange-500 bg-orange-50 text-slate-900"
                : isConfirmed
                  ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center text-[10px] font-bold",
                isConfirmed ? "bg-emerald-600 text-white" : "border border-slate-300 text-slate-500",
              )}
            >
              {isConfirmed ? <Check className="size-2.5" /> : index + 1}
            </span>
            <span className={cn("whitespace-nowrap", isActive && "font-semibold")}>{definition.title}</span>
          </button>
        );
      })}
    </div>
  );

  const phaseTone: Record<MonthlySalaryRun["phase"], "orange" | "emerald" | "neutral" | "slate"> = {
    part1: "orange",
    part2: "orange",
    ready: "emerald",
    published: "emerald",
    cancelled: "slate",
  };

  const phaseLabel = run
    ? { part1: "Part 1 in progress", part2: "Part 2 in progress", ready: "Ready to publish", published: "Published", cancelled: "Cancelled" }[run.phase]
    : "";

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-4 py-6">
      <AdminPageHero
        eyebrow="Payroll"
        title="Automated Payroll"
        description="HR-owned monthly salary sheet — Part 1 & Part 2, step by step. The system recommends every number; you confirm or edit."
        aside={
          run ? (
            <div className="flex flex-wrap gap-2 lg:justify-end">
              <AdminInsightChip tone={phaseTone[run.phase]}>{phaseLabel}</AdminInsightChip>
              <AdminInsightChip tone={part1AllConfirmed ? "emerald" : "neutral"}>
                Part 1 · {part1Confirmed}/{PART1_STEP_KEYS.length}
              </AdminInsightChip>
              {run.phase !== "part1" ? (
                <AdminInsightChip tone={part2AllConfirmed ? "emerald" : "neutral"}>
                  Part 2 · {part2Confirmed}/{PART2_STEP_KEYS.length}
                </AdminInsightChip>
              ) : null}
            </div>
          ) : undefined
        }
      />

      <div className={cn(adminPanelClassName, "flex flex-wrap items-end gap-3 p-4")}>
        <SelectField label="Month" value={month} onChange={setMonth}>
          {MONTHS.map((label, index) => (
            <option key={label} value={index + 1}>{label}</option>
          ))}
        </SelectField>
        <SelectField label="Year" value={year} onChange={setYear}>
          {[year - 1, year, year + 1].map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </SelectField>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void loadRun(month, year)}
          className="h-10 border-slate-300 font-bold text-slate-700 shadow-sm hover:bg-slate-100"
        >
          Load
        </Button>
        {!run || run.phase === "published" || run.phase === "cancelled" ? (
          <Button
            disabled={busy}
            onClick={() => void onStartClick()}
            className="h-10 border border-orange-600 bg-orange-600 text-white shadow-sm hover:bg-orange-700"
          >
            Start / Resume run
          </Button>
        ) : (
          <Badge variant="neutral">{phaseLabel}</Badge>
        )}
      </div>

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
      {notice ? <div className="border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">{notice}</div> : null}

      {!run ? (
        <div className={cn(adminPanelClassName, "p-8 text-center text-sm text-slate-500")}>
          Choose a month and start a run to begin.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Horizontal step-nav + actions — sits above the grid instead of beside it,
              so the grid below gets the full page width (was squeezed into a 1fr column
              fighting a fixed 260px sidebar for space). */}
          <div className={cn(adminSoftPanelClassName, "flex flex-col gap-3 p-4")}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                Part 1 — First installment
              </div>
              <Button
                size="sm"
                className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                disabled={busy || !part1AllConfirmed || run.phase !== "part1"}
                onClick={() => void post(`/api/automated-payroll/runs/${run.id}/part1/confirm`, "Part 1 confirmed. Finance roles notified.")}
              >
                Confirm Part 1
              </Button>
            </div>
            {renderStepPills(PART1_STEP_KEYS)}

            <div className="border-t border-slate-200 pt-3">
              {run.phase === "part1" ? (
                <div className="text-xs text-slate-400">Confirm Part 1 to unlock Part 2.</div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                      Part 2 — Full sheet
                    </div>
                    <Button
                      size="sm"
                      className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                      disabled={busy || !part2AllConfirmed || run.phase !== "part2"}
                      onClick={() => void post(`/api/automated-payroll/runs/${run.id}/part2/confirm`, "Part 2 confirmed. Finance roles notified.")}
                    >
                      Confirm Part 2
                    </Button>
                  </div>
                  {renderStepPills(PART2_STEP_KEYS)}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
              <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">Sheets</span>
              <Button variant="outline" size="sm" onClick={() => (window.location.href = `/api/automated-payroll/runs/${run.id}/sheet?variant=part1`)}>Part 1 sheet</Button>
              <Button variant="outline" size="sm" onClick={() => (window.location.href = `/api/automated-payroll/runs/${run.id}/sheet?variant=full`)}>Full sheet</Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadRecon()}>Reconcile</Button>
              {run.phase === "ready" && isPublisher ? (
                <Button
                  size="sm"
                  className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                  disabled={busy}
                  onClick={() => void post(`/api/automated-payroll/runs/${run.id}/publish`, "Published to payslips.")}
                >
                  Publish to payslips
                </Button>
              ) : null}
              {run.phase === "ready" && !isPublisher ? (
                <span className="text-xs text-slate-500">Part 2 confirmed — only a System Admin can publish.</span>
              ) : null}
              {run.phase === "published" ? (
                <Badge variant="success">Published to payslips</Badge>
              ) : null}
            </div>
          </div>

          {recon ? (
            <div className={cn(adminPanelClassName, "grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 lg:grid-cols-8")}>
              <Stat label="Employees" value={String(recon.headcount)} />
              <Stat label="Held" value={String(recon.held)} tone={recon.held ? "rose" : "slate"} />
              <Stat label="Σ First Part" value={money(recon.totalFirstPart)} />
              <Stat label="Σ Second Part" value={money(recon.totalSecondPart)} />
              <Stat label="Σ Month Salary" value={money(recon.totalMonthSalary)} />
              <Stat label="New hires" value={String(recon.joiners)} />
              <Stat label="Resignations" value={String(recon.leavers)} />
              <Stat
                label="Split OK"
                value={recon.splitMismatches.length === 0 ? "✓ balanced" : `${recon.splitMismatches.length} off`}
                tone={recon.splitMismatches.length === 0 ? "emerald" : "rose"}
              />
            </div>
          ) : null}

          <div className={cn(adminPanelClassName, "p-4")}>
            {activeStep ? (
              <RecommendationStep
                key={`${run.id}-${activeStep}`}
                runId={run.id}
                stepKey={activeStep}
                confirmed={confirmedSet.has(activeStep)}
                locked={stepLocked(activeStep)}
                onConfirmed={() => void loadRun(month, year)}
              />
            ) : (
              <div className="p-6 text-center text-sm text-slate-500">Select a step above to begin.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "slate" }: { label: string; value: string; tone?: "slate" | "rose" | "emerald" }) {
  const toneClass =
    tone === "rose" ? "text-rose-700" : tone === "emerald" ? "text-emerald-700" : "text-slate-900";
  return (
    <div className="border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={cn("text-lg font-black", toneClass)}>{value}</div>
    </div>
  );
}
