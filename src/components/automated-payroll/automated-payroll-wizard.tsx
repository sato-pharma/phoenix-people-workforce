"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { stepDefinition } from "@/lib/automated-payroll/step-definitions";
import type {
  MonthlySalaryRun,
  ReconciliationTotals,
  StepKey,
  StepState,
} from "@/lib/automated-payroll/types";
import { PART1_STEP_KEYS, PART2_STEP_KEYS, stepPhase } from "@/lib/automated-payroll/types";

import { RecommendationStep } from "./recommendation-step";

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
  const part1AllConfirmed = PART1_STEP_KEYS.every((key) => confirmedSet.has(key));
  const part2AllConfirmed = PART2_STEP_KEYS.every((key) => confirmedSet.has(key));

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

  const renderStepList = (keys: readonly StepKey[]) => (
    <div className="flex flex-col gap-1">
      {keys.map((key, index) => {
        const definition = stepDefinition(key);
        const isConfirmed = confirmedSet.has(key);
        const isActive = activeStep === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setActiveStep(key)}
            className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
              isActive ? "border-orange-400 bg-orange-50" : "border-slate-200 bg-white hover:border-slate-300"
            }`}
          >
            <span className="flex items-center gap-2">
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${isConfirmed ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-600"}`}>
                {index + 1}
              </span>
              {definition.title}
            </span>
            {isConfirmed ? <Badge variant="success">Done</Badge> : null}
          </button>
        );
      })}
    </div>
  );

  const phaseLabel = run
    ? { part1: "Part 1 in progress", part2: "Part 2 in progress", ready: "Ready to publish", published: "Published", cancelled: "Cancelled" }[run.phase]
    : "";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6">
      <AdminPageHero
        eyebrow="Payroll"
        title="Automated Payroll"
        description="HR-owned monthly salary sheet — Part 1 & Part 2, step by step. The system recommends every number; you confirm or edit."
      />

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          Month
          <select
            value={month}
            onChange={(event) => setMonth(Number(event.target.value))}
            className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          >
            {MONTHS.map((label, index) => (
              <option key={label} value={index + 1}>{label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-semibold text-slate-500">
          Year
          <select
            value={year}
            onChange={(event) => setYear(Number(event.target.value))}
            className="mt-1 h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          >
            {[year - 1, year, year + 1].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <Button variant="outline" disabled={busy} onClick={() => void loadRun(month, year)}>Load</Button>
        {!run || run.phase === "published" || run.phase === "cancelled" ? (
          <Button disabled={busy} onClick={() => void onStartClick()}>Start / Resume run</Button>
        ) : (
          <Badge variant="neutral">{phaseLabel}</Badge>
        )}
      </Card>

      {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
      {notice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">{notice}</div> : null}

      {!run ? (
        <Card className="p-8 text-center text-sm text-slate-500">
          Choose a month and start a run to begin.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[260px_1fr]">
          <div className="flex flex-col gap-4">
            <Card className="p-3">
              <div className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">Part 1 — First installment</div>
              {renderStepList(PART1_STEP_KEYS)}
              <Button
                className="mt-3 w-full"
                disabled={busy || !part1AllConfirmed || run.phase !== "part1"}
                onClick={() => void post(`/api/automated-payroll/runs/${run.id}/part1/confirm`, "Part 1 confirmed. Finance roles notified.")}
              >
                Confirm Part 1
              </Button>
            </Card>

            <Card className={`p-3 ${run.phase === "part1" ? "opacity-50" : ""}`}>
              <div className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">Part 2 — Full sheet</div>
              {run.phase === "part1" ? (
                <div className="px-1 py-2 text-xs text-slate-400">Confirm Part 1 to unlock Part 2.</div>
              ) : (
                <>
                  {renderStepList(PART2_STEP_KEYS)}
                  <Button
                    className="mt-3 w-full"
                    disabled={busy || !part2AllConfirmed || run.phase !== "part2"}
                    onClick={() => void post(`/api/automated-payroll/runs/${run.id}/part2/confirm`, "Part 2 confirmed. Finance roles notified.")}
                  >
                    Confirm Part 2
                  </Button>
                </>
              )}
            </Card>

            <Card className="flex flex-col gap-2 p-3">
              <div className="text-xs font-black uppercase tracking-wide text-slate-500">Sheets</div>
              <Button variant="outline" size="sm" onClick={() => (window.location.href = `/api/automated-payroll/runs/${run.id}/sheet?variant=part1`)}>Part 1 sheet</Button>
              <Button variant="outline" size="sm" onClick={() => (window.location.href = `/api/automated-payroll/runs/${run.id}/sheet?variant=full`)}>Full sheet</Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void loadRecon()}>Reconcile</Button>
            </Card>

            {run.phase === "ready" ? (
              <Card className="border-emerald-200 bg-emerald-50/60 p-3">
                <div className="text-xs font-black uppercase tracking-wide text-emerald-700">Publish</div>
                <p className="mt-1 text-xs text-emerald-800">Part 2 confirmed. Publishing writes payslips.</p>
                {isPublisher ? (
                  <Button
                    className="mt-2 w-full"
                    disabled={busy}
                    onClick={() => void post(`/api/automated-payroll/runs/${run.id}/publish`, "Published to payslips.")}
                  >
                    Publish to payslips
                  </Button>
                ) : (
                  <p className="mt-2 text-xs text-slate-500">Only a System Admin can publish.</p>
                )}
              </Card>
            ) : null}

            {run.phase === "published" ? (
              <Card className="border-emerald-200 bg-emerald-50/60 p-3 text-sm text-emerald-800">
                Published to payslips.
              </Card>
            ) : null}
          </div>

          <div className="flex flex-col gap-4">
            {recon ? (
              <Card className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
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
              </Card>
            ) : null}

            <Card className="p-4">
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
                <div className="p-6 text-center text-sm text-slate-500">Select a step on the left to begin.</div>
              )}
            </Card>
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
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-lg font-black ${toneClass}`}>{value}</div>
    </div>
  );
}
