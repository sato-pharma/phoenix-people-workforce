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
import type { PopulationDiff } from "@/lib/automated-payroll/population-diff";
import { cn } from "@/lib/utils";

import { NonEmployeesPanel } from "./non-employees-panel";
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
  const [nonEmployeesOpen, setNonEmployeesOpen] = useState(false);
  const [nonEmployeeCount, setNonEmployeeCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recon, setRecon] = useState<ReconciliationTotals | null>(null);
  const [overpaidPrompt, setOverpaidPrompt] = useState<{ runId: string; message: string } | null>(null);
  const [populationDiff, setPopulationDiff] = useState<PopulationDiff | null>(null);

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
      setNonEmployeeCount(0);
      setPopulationDiff(null);

      // Load the population diff eagerly rather than behind a button: the bug
      // it guards against (someone silently vanishing from payroll) is invisible
      // by definition, so it has to be on screen without anyone thinking to ask.
      const runId = data.run?.id;
      if (runId) {
        void fetch(`/api/automated-payroll/runs/${runId}/population-diff`)
          .then((response) => response.json())
          .then((diffData) => {
            if (diffData?.success) setPopulationDiff(diffData.diff as PopulationDiff);
          })
          .catch(() => {
            /* diff is a safety net, never block the wizard on it */
          });
      }
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

  const post = async (url: string, okMessage?: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
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

  /**
   * Part 2 confirm can be blocked by the overpayment gate (run-service.ts):
   * money already paid out in Part 1 that this month's total can't absorb. The
   * server refuses the first attempt and returns `requiresOverpaidAcknowledgment`
   * with the who/how-much detail, so HR consciously accepts before the sheet
   * becomes payable truth. A split mismatch is NOT acknowledgeable — it means a
   * calculation bug and always hard-blocks via the normal error path.
   */
  const confirmPart2WithOverpaidGate = async (runId: string, acknowledgeOverpaid = false) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/part2/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acknowledgeOverpaid }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.requiresOverpaidAcknowledgment) {
          setOverpaidPrompt({ runId, message: String(data.error ?? "") });
          return;
        }
        throw new Error(data.error ?? "Action failed.");
      }
      setOverpaidPrompt(null);
      setNotice("Part 2 confirmed. Finance roles notified.");
      await loadRun(month, year);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
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
            onClick={() => {
              setActiveStep(key);
              setNonEmployeesOpen(false);
            }}
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

  /**
   * Non-Employees Payroll is NOT a StepKey — there is no population to
   * recommend against, just a free-form list HR authors directly (owner rule
   * 2026-07-25) — so it gets its own pill outside the confirm-tracked strip
   * rather than a fake entry in PART1_STEP_KEYS.
   */
  const renderNonEmployeesPill = () => (
    <button
      type="button"
      onClick={() => {
        setNonEmployeesOpen(true);
        setActiveStep(null);
      }}
      className={cn(
        "flex items-center gap-1.5 border px-2.5 py-1.5 text-xs transition-colors",
        nonEmployeesOpen
          ? "border-orange-500 bg-orange-50 text-slate-900"
          : "border-dashed border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
      )}
    >
      <span className="whitespace-nowrap">
        Non-Employees Payroll{nonEmployeeCount > 0 ? ` (${nonEmployeeCount})` : ""}
      </span>
    </button>
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

      {/* Unexplained disappearance — the loudest thing on this page by design.
          Someone was paid last month, is absent now, and has no resignation on
          file. That is the exact shape of the 2026-07-25 notice-period bug,
          which was invisible until the owner asked about one person by name. */}
      {populationDiff && populationDiff.disappeared.length > 0 ? (
        <div className="border-l-4 border-rose-600 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <div className="font-black">
            {populationDiff.disappeared.length === 1
              ? "1 employee disappeared from payroll with no resignation on file"
              : `${populationDiff.disappeared.length} employees disappeared from payroll with no resignation on file`}
          </div>
          <p className="mt-1 text-xs">
            They were paid last month and are missing from this run. This usually means a data problem, not a real
            departure — check each one before confirming anything.
          </p>
          <ul className="mt-2 flex flex-col gap-0.5 text-xs">
            {populationDiff.disappeared.map((person) => (
              <li key={person.hrId}>
                <span className="font-semibold">{person.fullName}</span> ({person.hrId})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Overpayment gate — real money already paid out that this month can't
          absorb. Deliberately NOT a browser confirm(): HR needs to read who and
          how much before accepting, and the acceptance is written to the audit log. */}
      {overpaidPrompt ? (
        <div className="border-l-4 border-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-black">Part 1 overpayment — your acknowledgment is required</div>
          <p className="mt-1 text-xs">{overpaidPrompt.message}</p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void confirmPart2WithOverpaidGate(overpaidPrompt.runId, true)}
              className="border border-amber-600 bg-amber-600 text-white hover:bg-amber-700"
            >
              Acknowledge &amp; confirm Part 2
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOverpaidPrompt(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

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
            <div className="flex flex-wrap items-center gap-2">
              {renderStepPills(PART1_STEP_KEYS)}
              {renderNonEmployeesPill()}
            </div>

            <div className="border-t border-slate-200 pt-3">
              {run.phase === "part1" ? (
                <div className="text-xs text-slate-400">Confirm Part 1 to unlock Part 2.</div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                      Part 2 — Full sheet
                    </div>
                    <div className="flex items-center gap-2">
                      {run.phase === "part2" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-red-300 text-red-700 hover:bg-red-50"
                          disabled={busy}
                          onClick={() => {
                            if (!window.confirm("Unconfirm Part 1? This clears every employee's frozen First Part so it can be recomputed from current data.")) return;
                            void post(`/api/automated-payroll/runs/${run.id}/part1/unconfirm`, "Part 1 unconfirmed. First Part values cleared for recompute.");
                          }}
                        >
                          Unconfirm Part 1
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                        disabled={busy || !part2AllConfirmed || run.phase !== "part2"}
                        onClick={() => void confirmPart2WithOverpaidGate(run.id)}
                      >
                        Confirm Part 2
                      </Button>
                    </div>
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

          {/* Roster movement vs last month — the calm version of the alarm above.
              Names people rather than counting them, because a joiner can mask a
              disappearance in a pure headcount comparison. */}
          {populationDiff && !populationDiff.noBaseline ? (
            <div className={cn(adminSoftPanelClassName, "flex flex-col gap-2 p-4")}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                  Roster vs last month
                </span>
                <AdminInsightChip tone="neutral">
                  {populationDiff.currentHeadcount} now · {populationDiff.previousHeadcount} last month
                </AdminInsightChip>
                {populationDiff.joined.length > 0 ? (
                  <AdminInsightChip tone="emerald">+{populationDiff.joined.length} joined</AdminInsightChip>
                ) : null}
                {populationDiff.left.length > 0 ? (
                  <AdminInsightChip tone="slate">−{populationDiff.left.length} left</AdminInsightChip>
                ) : null}
              </div>
              {populationDiff.joined.length > 0 || populationDiff.left.length > 0 ? (
                <div className="grid gap-3 text-xs sm:grid-cols-2">
                  {populationDiff.joined.length > 0 ? (
                    <div>
                      <div className="font-semibold text-emerald-700">Joined</div>
                      <ul className="mt-0.5 flex flex-col gap-0.5 text-slate-600">
                        {populationDiff.joined.map((person) => (
                          <li key={person.hrId}>
                            {person.fullName} ({person.hrId})
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {populationDiff.left.length > 0 ? (
                    <div>
                      <div className="font-semibold text-slate-700">Left</div>
                      <ul className="mt-0.5 flex flex-col gap-0.5 text-slate-600">
                        {populationDiff.left.map((person) => (
                          <li key={person.hrId}>
                            {person.fullName} ({person.hrId})
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="text-xs text-slate-500">No joiners or leavers vs last month.</div>
              )}
            </div>
          ) : null}

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
            {nonEmployeesOpen ? (
              <NonEmployeesPanel
                key={run.id}
                runId={run.id}
                locked={run.phase !== "part1"}
                onChange={setNonEmployeeCount}
              />
            ) : activeStep ? (
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
