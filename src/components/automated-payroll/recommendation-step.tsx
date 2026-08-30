"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Info, Plus, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  enteredOnThisStepAmount,
  hasDoubleDeductionConflict,
} from "@/lib/automated-payroll/conflicts";
import { computeSettlementSummary } from "@/lib/automated-payroll/settlement-summary";
import { stepDefinition, stepFieldsTotal, stepWindowLabel } from "@/lib/automated-payroll/step-definitions";
import type {
  ManualRowCandidate,
  PayrollPeriod,
  StepDefinition,
  StepEditInput,
  StepFieldSpec,
  StepImportPreview,
  StepKey,
  StepRow,
} from "@/lib/automated-payroll/types";
import { downloadFromApiRoute } from "@/lib/navigation/browser-navigation";
import { cn } from "@/lib/utils";

type Props = {
  runId: string;
  stepKey: StepKey;
  confirmed: boolean;
  locked: boolean;
  onConfirmed: () => void;
  /** Lets the wizard warn before downloading a run-level sheet while this step has
   * unsaved edits — otherwise the export reads the last-saved draft row and silently
   * omits whatever is only sitting in this screen's local state. */
  onDirtyChange?: (dirty: boolean) => void;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** One line of the four-figure settlement block. */
function SettlementLine({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: number;
  tone?: "positive" | "negative";
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3",
        strong && "mt-0.5 border-t border-slate-300 pt-1.5",
      )}
    >
      {/* No truncate and no wrap anywhere in this block (owner's standing UI
          rule): a payroll figure whose label has been cut short, or whose
          amount has folded onto a second line, is a figure that gets misread. */}
      <span
        className={cn(
          "overflow-hidden whitespace-nowrap",
          strong ? "font-semibold text-slate-700" : "text-slate-500",
        )}
      >
        {label}
      </span>
      <span
        dir="ltr"
        className={cn(
          "shrink-0 overflow-hidden whitespace-nowrap tabular-nums",
          strong ? "text-base font-black text-slate-900" : "font-semibold",
          !strong && tone === "negative" && "text-rose-600",
          !strong && tone === "positive" && "text-emerald-700",
          !strong && !tone && "text-slate-700",
        )}
      >
        {/* A deduction reads as what it does to the pay. Without the sign,
            "Working Days Net 17,500 / Total Deductions 2,540 / Net Payable
            14,959" is three numbers the reader still has to work out the
            relationship between. */}
        {tone === "negative" && value !== 0 ? `− ${money(value)}` : money(value)}
      </span>
    </div>
  );
}

/**
 * THE FOUR FIGURES the owner asked to see on every screen of the sheet
 * (2026-08-30): what the month is worth, what the days actually worked are
 * worth, what is being taken off across all sixteen steps, and what the
 * employee ends up with — recomputed on every keystroke.
 *
 * Its own component purely so the summary is computed ONCE per row instead of
 * once per line rendered.
 *
 * Renders NOTHING when the row carries no settlement basis — a holds step, or a
 * manually-added employee with no draft row yet. On a payroll screen a missing
 * figure is safer than a confident zero: zero is a number HR can act on.
 */
function SettlementSummaryBlock({ definition, row }: { definition: StepDefinition; row: StepRow }) {
  const summary = computeSettlementSummary(row.settlement, definition, row.values);
  if (!summary) return null;
  return (
    <div className="mt-1 flex flex-col gap-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
      <SettlementLine label="Full Month Net" value={summary.monthNet} />
      <SettlementLine label="Working Days Net" value={summary.workedNet} />
      {/* Shown only when there IS one. Net Payable has to reconcile against the
          lines above it or the block reads as broken — but an "Additions 0.00"
          row on the thirteen screens that never carry one is just noise. */}
      {summary.additions !== 0 ? (
        <SettlementLine label="Additions" value={summary.additions} tone="positive" />
      ) : null}
      <SettlementLine label="Total Deductions" value={summary.deductions} tone="negative" />
      <SettlementLine label="Net Payable" value={summary.payable} strong />
    </div>
  );
}

/** Shared premium field recipe (see [[premium-design-language]]) — orange focus ring, dense height. */
const fieldClassName =
  "h-9 border-slate-300 bg-white text-sm transition focus-visible:border-orange-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/20";

/**
 * "Add employee" for a step that `allowsManualRows` — outstation expenses today
 * (owner request 2026-08-03): someone whose trip never reached the expense table
 * still has to be reimbursed, and until now there was no way to put them on the
 * sheet at all.
 *
 * Deliberately a PICKER over this run's payroll population, never a free-text
 * name: the amount is written to a real employee's draft row, so the person has
 * to be a real payroll employee. Someone with no employee record belongs in
 * Non-Employees Payroll instead, which is a separate list for exactly that.
 */
function AddEmployeePanel({
  candidates,
  moneyLabel,
  noteLabel,
  onAdd,
}: {
  candidates: ManualRowCandidate[];
  moneyLabel: string;
  noteLabel: string | null;
  onAdd: (candidate: ManualRowCandidate, amount: number, note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ManualRowCandidate | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  /** The suggestion list is absolutely positioned, so it only renders while the
   * field is actually in use — otherwise it sits on top of the amount input. */
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return candidates.slice(0, 8);
    return candidates
      .filter(
        (candidate) =>
          candidate.fullName.toLowerCase().includes(text) || candidate.hrId.toLowerCase().includes(text),
      )
      .slice(0, 8);
  }, [candidates, query]);

  const reset = () => {
    setQuery("");
    setPicked(null);
    setAmount("");
    setNote("");
  };

  const amountValue = Number(amount);
  const canAdd = picked !== null && Number.isFinite(amountValue) && amountValue > 0;

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} className="self-start gap-1.5">
        <Plus className="size-4" />
        Add employee
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3 border-l-4 border-amber-400 bg-amber-50/60 px-4 py-3">
      <div>
        <div className="text-sm font-black text-slate-900">Add an employee by hand</div>
        <p className="mt-0.5 text-xs text-slate-600">
          For someone whose trip never reached the expense table. Pick the employee, type what to reimburse, and say
          why — the amount is paid exactly like a system-recommended one, so the note is the only record of where it
          came from.
        </p>
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="relative flex flex-col gap-1 lg:w-80">
          <span className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">Employee</span>
          <Input
            value={picked ? `${picked.fullName} (${picked.hrId})` : query}
            placeholder="Search by name or HR_ID…"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(event) => {
              setPicked(null);
              setQuery(event.target.value);
            }}
            className={fieldClassName}
          />
          {!picked && focused ? (
            <div className="absolute left-0 right-0 top-full z-10 max-h-64 overflow-y-auto border border-slate-200 bg-white shadow-lg">
              {matches.length === 0 ? (
                <div className="px-3 py-2 text-xs text-slate-400">
                  {candidates.length === 0
                    ? "Every employee on payroll is already listed on this step."
                    : "No employee matches that."}
                </div>
              ) : (
                matches.map((candidate) => (
                  <button
                    key={candidate.hrId}
                    type="button"
                    // preventDefault on mousedown: a blur would unmount this
                    // list before the click could land on it.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setPicked(candidate)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-orange-50"
                  >
                    <span className="overflow-hidden whitespace-nowrap text-slate-800">{candidate.fullName}</span>
                    <span className="shrink-0 font-mono text-slate-500">{candidate.hrId}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        <label className="flex flex-col gap-1 lg:w-40">
          <span className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">{moneyLabel}</span>
          <Input
            type="number"
            value={amount}
            placeholder="0"
            onChange={(event) => setAmount(event.target.value)}
            className={cn(fieldClassName, "text-right")}
          />
        </label>

        {noteLabel ? (
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">{noteLabel}</span>
            <Input
              value={note}
              placeholder="Why is this being reimbursed?"
              onChange={(event) => setNote(event.target.value)}
              className={fieldClassName}
            />
          </label>
        ) : null}

        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!canAdd}
            onClick={() => {
              if (!picked) return;
              onAdd(picked, amountValue, note.trim());
              reset();
            }}
            className="h-9 border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
          >
            Add to step
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-9"
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Added rows are not saved until you press Save or Confirm below.
      </p>
    </div>
  );
}

/**
 * A step's spec for one field key — the auto-calc rules live on the field, not
 * at the call site.
 *
 * Module-level on purpose. As a closure over `definition` inside the component
 * it made the React Compiler treat `definition` as possibly-mutated, which
 * invalidated the existing useCallback/useMemo below it (`react-hooks/
 * preserve-manual-memoization`, an error in this repo).
 */
function fieldSpecOf(definition: StepDefinition, key: string): StepFieldSpec | undefined {
  return definition.fields.find((candidate) => candidate.key === key);
}

export function RecommendationStep({
  runId,
  stepKey,
  confirmed,
  locked,
  onConfirmed,
  onDirtyChange,
}: Props) {
  const definition = stepDefinition(stepKey);
  const [rows, setRows] = useState<StepRow[]>([]);
  const [period, setPeriod] = useState<PayrollPeriod | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<StepImportPreview | null>(null);
  const [search, setSearch] = useState("");
  /** hrIds whose per-line breakdown is open. Keyed by hrId, never by index — see setValue. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** Employees still addable by hand — empty unless the step allows manual rows. */
  const [candidates, setCandidates] = useState<ManualRowCandidate[]>([]);
  /**
   * Manual rows HR removed but hasn't saved yet. They must be REMEMBERED, not
   * just dropped from `rows`: their amount is already sitting in the employee's
   * draft row, so a save that simply omits them would leave the money on the
   * sheet with nothing on screen. `toEdits` turns each one into an explicit zero.
   */
  const [removedManual, setRemovedManual] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/steps/${stepKey}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load step.");
      setRows(data.rows as StepRow[]);
      setCandidates((data.candidates ?? []) as ManualRowCandidate[]);
      setRemovedManual([]);
      const run = data.run as { month?: number; year?: number } | undefined;
      setPeriod(
        run?.month && run?.year ? { month: Number(run.month), year: Number(run.year) } : null,
      );
      setDirty(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load step.");
    } finally {
      setLoading(false);
    }
  }, [runId, stepKey]);

  const toggleExpanded = (hrId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(hrId)) next.delete(hrId);
      else next.add(hrId);
      return next;
    });
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    // Unmounting (switching steps) discards this component's local edits, so the
    // wizard's dirty flag must clear with it — otherwise a stale warning survives
    // after the very edits it warned about are gone.
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const toEdits = useCallback((): StepEditInput[] => {
    const edits = rows
      // Informational rows (notice-period employees) are never saved. Their
      // settlement belongs to the month they actually leave; sending them here
      // could stamp this month's figures onto their draft row.
      .filter((row) => !row.readOnly)
      .map((row) => ({
        hrId: row.hrId,
        values: row.values,
        reasons: row.reasons,
        selects: row.selects,
        reason: row.reason,
        onHold: row.onHold,
      }));

    // Removed manual rows are sent as an explicit zero — see `removedManual`.
    const moneyFields = definition.fields.filter((field) => field.kind === "money" || field.kind === "days");
    const textFields = definition.fields.filter((field) => field.kind === "text");
    for (const hrId of removedManual) {
      edits.push({
        hrId,
        values: Object.fromEntries(moneyFields.map((field) => [field.key, 0])),
        reasons: Object.fromEntries(textFields.map((field) => [field.key, ""])),
        selects: {},
        reason: null,
        onHold: false,
      });
    }
    return edits;
  }, [rows, removedManual, definition.fields]);

  /**
   * Put an employee the feeder never produced onto the step (owner request
   * 2026-08-03). The row is a normal StepRow from here on — it edits, saves,
   * confirms and exports through exactly the same path as a recommended one —
   * with `recommended` left at 0, because the system recommended nothing.
   */
  const addManualRow = (candidate: ManualRowCandidate, amount: number, note: string) => {
    const moneyKey = definition.fields.find((field) => field.kind === "money")?.key;
    const noteKey = definition.fields.find((field) => field.kind === "text")?.key;
    setRows((prev) => [
      ...prev,
      {
        hrId: candidate.hrId,
        fullName: candidate.fullName,
        jobTitle: candidate.jobTitle,
        line: candidate.line,
        context: Object.fromEntries(definition.contextColumns.map((column) => [column.key, ""])),
        values: moneyKey ? { [moneyKey]: amount } : {},
        recommended: moneyKey ? { [moneyKey]: 0 } : {},
        reasons: noteKey ? { [noteKey]: note } : {},
        reason: null,
        onHold: false,
        manual: true,
      },
    ]);
    setCandidates((prev) => prev.filter((entry) => entry.hrId !== candidate.hrId));
    // Re-adding after a removal in the same session must not still send the zero.
    setRemovedManual((prev) => prev.filter((hrId) => hrId !== candidate.hrId));
    // An active search would otherwise hide the row that was just added.
    setSearch("");
    setDirty(true);
  };

  const removeManualRow = (row: StepRow) => {
    setRows((prev) => prev.filter((entry) => entry.hrId !== row.hrId));
    setRemovedManual((prev) => (prev.includes(row.hrId) ? prev : [...prev, row.hrId]));
    setCandidates((prev) =>
      prev.some((entry) => entry.hrId === row.hrId)
        ? prev
        : [...prev, { hrId: row.hrId, fullName: row.fullName, jobTitle: row.jobTitle, line: row.line }].sort(
            (left, right) => left.fullName.localeCompare(right.fullName),
          ),
    );
    setDirty(true);
  };

  // Every setter below keys off `hrId`, NOT array position — `rows` renders as
  // `filteredRows` once the search box (below) is active, so a positional index would
  // silently mutate the wrong employee (filteredRows[i] !== rows[i] whenever anything is
  // filtered out). hrId is stable and unique per row regardless of filtering.
  const setValue = (hrId: string, field: string, value: number) => {
    setRows((prev) =>
      prev.map((row) => (row.hrId === hrId ? { ...row, values: { ...row.values, [field]: value } } : row)),
    );
    setDirty(true);
  };

  /**
   * One "days" field can drive SEVERAL money fields, each a day-share of its own
   * monthly amount: `amount / divisor × days`.
   *
   *   amount  — the context column named by `autoCalcAmountContextKey`, default
   *             "Base Salary". The Resignations CRM tab names "Net Salary"
   *             (owner rule 2026-08-30: a no-activity day must cost exactly one
   *             day of the pay it cancels, and that pay is prorated off the net).
   *   divisor — the context column named by `autoCalcDivisorContextKey`, default
   *             30 (the owner's deduction day-rate). Resignation proration
   *             divides by the month's ACTUAL calendar days, so a 31-day month
   *             would otherwise settle the wrong amount.
   *
   * `autoCalcCompanionMoneyKeys` is what makes the Resignations step's Days
   * Worked move Extra Cost of Living and Fuel alongside Base. Before 2026-08-30
   * it moved Base alone, so correcting the days left the allowances on the old
   * count and quietly undid the "prorate the whole net" rule of the day before.
   *
   * Mirrors resolveLeaverBasis/prorateLeaverNet on the server. The server is
   * authoritative — this exists so the grid agrees with it while HR types.
   */
  const applyAutoCalc = (
    row: StepRow,
    values: Record<string, number>,
    spec: StepFieldSpec | undefined,
    days: number,
  ) => {
    if (!spec?.autoCalcMoneyKey) return;
    const divisorKey = spec.autoCalcDivisorContextKey;
    const divisor = divisorKey ? Number(row.context[divisorKey] ?? 0) || 30 : 30;
    const share = (amountContextKey: string) => {
      const amount = Number(row.context[amountContextKey] ?? 0);
      return Math.round(((amount / divisor) * days + Number.EPSILON) * 100) / 100;
    };
    values[spec.autoCalcMoneyKey] = share(spec.autoCalcAmountContextKey ?? "Base Salary");
    for (const companion of spec.autoCalcCompanionMoneyKeys ?? []) {
      values[companion.key] = share(companion.amountContextKey);
    }
  };

  const setDaysValue = (hrId: string, field: string, days: number) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.hrId !== hrId) return row;
        const values = { ...row.values, [field]: days };
        applyAutoCalc(row, values, fieldSpecOf(definition, field), days);
        return { ...row, values };
      }),
    );
    setDirty(true);
  };

  /**
   * For a pair of complementary "days" fields (e.g. Working Days / Non-Working
   * Days, owner request 2026-07-25) that must always sum to a fixed total:
   * editing either one clamps it to [0, total] and sets the OTHER to
   * (total - value). Whichever field separately declares `autoCalcMoneyKey`
   * then recomputes its money field(s) from its OWN (possibly just-derived) day
   * count, via applyAutoCalc above.
   *
   * `totalContextKey` is the CAP and is a THIRD, independent thing from the
   * amount and the divisor: on the Resignations CRM tab the cap is the leaver's
   * confirmed Days Worked, the divisor is the month's calendar days, and the
   * amount is his monthly net. Conflating any two of them silently changes the
   * deduction (see StepFieldSpec.complementTotalContextKey's doc comment).
   */
  const setComplementaryDaysValue = (
    hrId: string,
    field: string,
    complementField: string,
    totalContextKey: string | undefined,
    rawValue: number,
  ) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.hrId !== hrId) return row;
        const total = totalContextKey ? Number(row.context[totalContextKey] ?? 0) : 0;
        const clamped = Math.min(Math.max(0, rawValue), total);
        const complementValue = Math.max(0, total - clamped);
        const values = { ...row.values, [field]: clamped, [complementField]: complementValue };
        applyAutoCalc(row, values, fieldSpecOf(definition, field), clamped);
        applyAutoCalc(row, values, fieldSpecOf(definition, complementField), complementValue);
        return { ...row, values };
      }),
    );
    setDirty(true);
  };

  const setFieldReason = (hrId: string, field: string, value: string) => {
    setRows((prev) =>
      prev.map((row) => (row.hrId === hrId ? { ...row, reasons: { ...row.reasons, [field]: value } } : row)),
    );
    setDirty(true);
  };

  const setSelectValue = (hrId: string, field: string, value: string) => {
    setRows((prev) =>
      prev.map((row) => (row.hrId === hrId ? { ...row, selects: { ...row.selects, [field]: value } } : row)),
    );
    setDirty(true);
  };

  const setReason = (hrId: string, reason: string) => {
    setRows((prev) => prev.map((row) => (row.hrId === hrId ? { ...row, reason } : row)));
    setDirty(true);
  };

  const setHold = (hrId: string, onHold: boolean) => {
    setRows((prev) => prev.map((row) => (row.hrId === hrId ? { ...row, onHold } : row)));
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/steps/${stepKey}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits: toEdits(), inputMode: "inline" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      setDirty(false);
      // The zeros have landed; re-sending them on the next save is pointless.
      setRemovedManual([]);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save.");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dirty) await save();
      const res = await fetch(`/api/automated-payroll/runs/${runId}/steps/${stepKey}/confirm`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to confirm.");
      onConfirmed();
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "Failed to confirm.");
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async (file: File, commit: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(
        `/api/automated-payroll/runs/${runId}/steps/${stepKey}/import?commit=${commit}`,
        { method: "POST", body: form },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      if (commit) {
        setPreview(null);
        await load();
      } else {
        setPreview(data.result as StepImportPreview);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  // Double-deduction guard — rule lives in lib/automated-payroll/conflicts.ts so it is
  // unit-tested rather than only eyeballed here.
  const conflictKey = definition.conflictContextKey;
  const hasConflict = useCallback(
    (row: StepRow) => hasDoubleDeductionConflict(definition, row),
    [definition],
  );

  const conflictRows = useMemo(() => rows.filter(hasConflict), [rows, hasConflict]);

  const totalPrimary = useMemo(() => {
    const field = (definition.fields.find((f) => f.kind === "money") ?? definition.fields[0])?.key;
    if (!field) return null;
    return rows.reduce((sum, row) => sum + (row.values[field] ?? 0), 0);
  }, [rows, definition.fields]);

  const windowLabel = useMemo(
    () => (period ? stepWindowLabel(stepKey, period) : null),
    [period, stepKey],
  );

  /** Steps that carry a per-line breakdown get an expander control on the card. */
  const hasDetail = (definition.detailColumns?.length ?? 0) > 0;
  /**
   * The step's "Hire Date" context column (when it has one) reads as identity, not
   * a figure — owner request 2026-08-08: show it right under the name next to
   * HR_ID instead of buried in the same list as CRM/vacation numbers below.
   */
  const hireDateColumn = definition.contextColumns.find((column) => /hire date/i.test(column.label));
  const bodyContextColumns = hireDateColumn
    ? definition.contextColumns.filter((column) => column !== hireDateColumn)
    : definition.contextColumns;
  const detailNoun = definition.detailNoun ?? "line";
  const detailNounPlural = definition.detailNounPlural ?? `${detailNoun}s`;
  const detailCount = (row: StepRow) => row.details?.length ?? 0;
  const detailLabel = (row: StepRow) => {
    const count = detailCount(row);
    return `${count} ${count === 1 ? detailNoun : detailNounPlural}`;
  };

  /** Search/filter by HR_ID or name — client-side over the already-loaded rows, so it
   * never touches the server and works instantly even on a large population. */
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter(
      (row) => row.hrId.toLowerCase().includes(query) || row.fullName.toLowerCase().includes(query),
    );
  }, [rows, search]);

  /** Same precedence for the grid row tint and the mobile card border. */
  const rowTone = (row: StepRow): "hold" | "conflict" | "manual" | "leaver" | "notice" | null => {
    if (row.onHold) return "hold";
    if (hasConflict(row)) return "conflict";
    if (row.readOnly) return "notice";
    // Above "leaver": that a figure was typed by a person rather than derived
    // from data is the more important thing to see on a payroll screen.
    if (row.manual) return "manual";
    if (row.lifecycle === "leaver") return "leaver";
    return null;
  };

  /**
   * A row is uneditable either because the whole step is locked, or because the
   * row itself is informational (an employee serving notice into a future month:
   * shown so HR sees the resignation, but their settlement belongs to the month
   * they actually leave — editing it here would prorate this month's pay).
   */
  const isRowLocked = (row: StepRow) => locked || row.readOnly === true;

  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading {definition.title}…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black tracking-tight text-slate-900">{definition.title}</h3>
          <p className="mt-0.5 text-sm text-slate-500">{definition.subtitle}</p>
          {/* The three Part-2 feeder steps cover DIFFERENT date ranges and used to
              say nothing about it, which makes a correct figure look wrong. */}
          {windowLabel ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-slate-600">
              <Info className="mt-0.5 size-3.5 shrink-0 text-orange-500" />
              <span>{windowLabel}</span>
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {confirmed ? (
            <Badge variant="success" className="gap-1">
              <Check className="size-3" />
              Confirmed
            </Badge>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              if (dirty) await save();
              downloadFromApiRoute(`/api/automated-payroll/runs/${runId}/steps/${stepKey}/export`);
            }}
          >
            Download xlsx
          </Button>
          <Button variant="outline" size="sm" disabled={locked || busy} onClick={() => fileRef.current?.click()}>
            Upload edited xlsx
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onUpload(file, false);
              event.target.value = "";
            }}
          />
        </div>
      </div>

      {error ? (
        <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div>
      ) : null}

      {conflictRows.length > 0 && conflictKey ? (
        <div className="border-l-4 border-orange-400 bg-orange-50 px-4 py-3 text-sm text-orange-900">
          <div className="font-black">
            Careful — this would be deducted twice for{" "}
            {conflictRows.length === 1 ? "1 employee" : `${conflictRows.length} employees`}.
          </div>
          <p className="mt-1 text-xs">
            The amount below is <strong>already settled on the Resignations step</strong>. Anything entered
            here is deducted <strong>on top of it</strong>, not instead of it. Clear the value here unless you
            genuinely want both.
          </p>
          <ul className="mt-2 flex flex-col gap-0.5 text-xs">
            {conflictRows.map((row) => (
              <li key={row.hrId}>
                <span className="font-semibold">{row.fullName}</span> ({row.hrId}) — already settled{" "}
                {money(Number(row.context[conflictKey] ?? 0))}, entered here{" "}
                {money(enteredOnThisStepAmount(definition, row))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview ? (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <div className="font-semibold">
            Upload preview — {preview.changed} changed, {preview.invalid} invalid of {preview.totalRows} rows.
          </div>
          <div className="mt-1 max-h-40 overflow-auto text-xs">
            {preview.diffs.slice(0, 40).map((diff, index) => (
              <div key={`${diff.hrId}-${diff.field}-${index}`} className={diff.status === "invalid" ? "text-rose-700" : diff.status === "changed" ? "text-amber-800" : "text-slate-500"}>
                {diff.hrId} · {diff.field}: {String(diff.from)} → {String(diff.to)} ({diff.status})
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                const file = fileRef.current?.files?.[0];
                if (file) void onUpload(file, true);
              }}
            >
              Apply changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {/* Above the grid and above the empty state on purpose: a step with no rows
          at all is exactly when HR most needs to be able to add one. */}
      {definition.allowsManualRows && !locked ? (
        <AddEmployeePanel
          candidates={candidates}
          moneyLabel={definition.fields.find((field) => field.kind === "money")?.label ?? "Value"}
          noteLabel={definition.fields.find((field) => field.kind === "text")?.label ?? null}
          onAdd={addManualRow}
        />
      ) : null}

      {rows.length > 0 ? (
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by HR_ID or name…"
          className={cn(fieldClassName, "max-w-xs")}
        />
      ) : null}

      {rows.length === 0 ? (
        <div className="border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
          No employees for this step.
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
          No employees match &ldquo;{search}&rdquo;.
        </div>
      ) : (
        <>
          {/* One stacked card per employee at every screen size — no dense grid table,
              no horizontal scroll, ever (owner request 2026-08-08: "no horizontal
              scrolling, making cards instead of ugly table"). HR_ID and Hire Date sit
              right under the name as identity, not mixed in with the editable figures
              below (owner request: "pull hr id and hiring data under the name"). */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filteredRows.map((row) => {
              const tone = rowTone(row);
              const isExpanded = expanded.has(row.hrId);
              const lineCount = detailCount(row);
              return (
                <div
                  key={row.hrId}
                  className={cn(
                    "border border-slate-200 bg-white p-3",
                    tone === "hold" && "border-rose-200 bg-rose-50",
                    tone === "conflict" && "border-l-4 border-l-orange-400 bg-orange-50",
                    tone === "notice" && "border-l-4 border-l-sky-400 bg-sky-50/70",
                    tone === "manual" && "border-l-4 border-l-amber-400 bg-amber-50/60",
                    tone === "leaver" && "bg-red-50",
                  )}
                >
                  <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
                    <div className="min-w-0 overflow-hidden">
                      <div
                        className={cn(
                          "overflow-hidden whitespace-nowrap text-sm",
                          tone === "hold" ? "font-semibold text-rose-700" : "font-medium text-slate-800",
                        )}
                      >
                        {row.fullName}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-xs text-slate-500">
                        <span>{row.hrId}</span>
                        {hireDateColumn ? (
                          <span className="font-sans text-slate-400">
                            · Hired {String(row.context[hireDateColumn.key] ?? "—")}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {tone === "hold" ? <Badge variant="danger">HOLD</Badge> : null}
                      {tone === "conflict" ? <Badge variant="warning">Already settled</Badge> : null}
                      {row.readOnly ? <Badge variant="neutral">Notice period</Badge> : null}
                      {row.manual ? <Badge variant="warning">Added manually</Badge> : null}
                      {row.manual && !locked ? (
                        <button
                          type="button"
                          onClick={() => removeManualRow(row)}
                          aria-label={`Remove ${row.fullName} from this step`}
                          className="flex size-6 items-center justify-center text-slate-400 transition hover:text-rose-600"
                        >
                          <X className="size-4" />
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    {bodyContextColumns.map((column) => {
                      const contextValue = row.context[column.key];
                      return (
                        <div key={column.key} className="flex items-center justify-between gap-3 text-sm">
                          <span className="overflow-hidden whitespace-nowrap text-slate-500">{column.label}</span>
                          <span
                            dir={column.money ? "ltr" : "auto"}
                            className={cn(
                              "shrink-0 overflow-hidden whitespace-nowrap font-medium text-slate-700",
                              column.money && "tabular-nums",
                            )}
                          >
                            {/* A money column can still carry a non-numeric marker — an em dash
                                when HR has entered no salary figure at all — and running that
                                through money() would print "NaN" on a payroll screen. Only real
                                numbers get formatted; anything else renders as written. */}
                            {column.money && typeof contextValue === "number"
                              ? money(contextValue)
                              : String(contextValue ?? "")}
                          </span>
                        </div>
                      );
                    })}

                    {definition.isHoldStep ? (
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-slate-500">Hold</span>
                        {locked ? (
                          <span className={row.onHold ? "font-semibold text-rose-700" : "text-slate-400"}>
                            {row.onHold ? "Held" : "—"}
                          </span>
                        ) : (
                          <Switch checked={row.onHold} onChange={(value) => setHold(row.hrId, value)} />
                        )}
                      </div>
                    ) : null}

                    {definition.fields.map((field) => (
                      <label key={field.key} className="flex flex-col gap-1 text-sm">
                        <span className="text-slate-500">{field.label}</span>
                        {field.kind === "text" ? (
                          <Input
                            value={row.reasons?.[field.key] ?? ""}
                            disabled={isRowLocked(row)}
                            placeholder="Reason (optional)"
                            onChange={(event) => setFieldReason(row.hrId, field.key, event.target.value)}
                            className={fieldClassName}
                          />
                        ) : field.kind === "select" ? (
                          <select
                            value={row.selects?.[field.key] ?? field.options?.[0]?.value ?? ""}
                            disabled={isRowLocked(row)}
                            onChange={(event) => setSelectValue(row.hrId, field.key, event.target.value)}
                            className={cn(fieldClassName, "px-2")}
                          >
                            {field.options?.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            type="number"
                            value={String(row.values[field.key] ?? 0)}
                            disabled={isRowLocked(row)}
                            onChange={(event) => {
                              const raw = Number(event.target.value) || 0;
                              if (field.kind === "days" && field.complementFieldKey) {
                                setComplementaryDaysValue(row.hrId, field.key, field.complementFieldKey, field.complementTotalContextKey, raw);
                              } else if (field.kind === "days") {
                                setDaysValue(row.hrId, field.key, raw);
                              } else {
                                setValue(row.hrId, field.key, raw);
                              }
                              }}
                            className={fieldClassName}
                          />
                        )}
                      </label>
                    ))}

                    {/* Live total of the editable money fields above it (owner request
                        2026-08-29, New hires). Summed here from `row.values` rather than
                        read from `row.context` on purpose: context is computed once on
                        the server and never recomputed as HR types, so a context total
                        would freeze at the loaded figure and disagree with the boxes the
                        moment one is edited — exactly when the total is being read. */}
                    {definition.fieldsTotal ? (
                      <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-slate-200 pt-2 text-sm">
                        <span className="overflow-hidden whitespace-nowrap font-semibold text-slate-600">
                          {definition.fieldsTotal.label}
                        </span>
                        <span
                          dir="ltr"
                          className="shrink-0 overflow-hidden whitespace-nowrap font-black tabular-nums text-slate-900"
                        >
                          {money(stepFieldsTotal(definition, row.values))}
                        </span>
                      </div>
                    ) : null}

                    {/* THE FOUR FIGURES (owner request 2026-08-30): the whole
                        month, on every screen. "I must see everything to make
                        the things clear for me" — before this, each screen
                        showed its own slice and nothing showed what the
                        employee actually ends the month with, so checking a
                        figure meant adding up sixteen screens by hand on a
                        calculator.

                        Computed live from row.values overlaid on the server's
                        components, for the same reason the total above is:
                        anything read straight from row.context freezes at the
                        figure it loaded with and stops agreeing with the boxes
                        exactly when someone is revising them. */}
                    <SettlementSummaryBlock definition={definition} row={row} />

                    {definition.hasReason ? (
                      <label className="flex flex-col gap-1 text-sm">
                        <span className="text-slate-500">Reason</span>
                        <Input
                          value={row.reason ?? ""}
                          disabled={isRowLocked(row)}
                          placeholder="Reason"
                          onChange={(event) => setReason(row.hrId, event.target.value)}
                          className={fieldClassName}
                        />
                      </label>
                    ) : null}

                    {hasDetail && lineCount > 0 ? (
                      <>
                        <button
                          type="button"
                          onClick={() => toggleExpanded(row.hrId)}
                          aria-expanded={isExpanded}
                          className="flex items-center gap-1 self-start pt-1 text-sm font-medium text-orange-600"
                        >
                          {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          {isExpanded ? `Hide ${detailLabel(row)}` : `Show ${detailLabel(row)}`}
                        </button>
                        {/* One mini-card per line, label/value stacked — nothing here
                            is ever truncated or side-scrolled. */}
                        {isExpanded
                          ? (row.details ?? []).map((line, lineIndex) => (
                              <div
                                key={lineIndex}
                                className="flex flex-col gap-1 border border-slate-200 bg-slate-50 p-2 text-xs"
                              >
                                {(definition.detailColumns ?? []).map((column) => (
                                  <div key={column.key} className="flex items-start justify-between gap-3">
                                    <span className="shrink-0 text-slate-500">{column.label}</span>
                                    <span
                                      dir={column.money ? "ltr" : "auto"}
                                      className={cn(
                                        "text-right font-medium text-slate-700",
                                        column.money && "tabular-nums",
                                      )}
                                    >
                                      {column.money
                                        ? money(Number(line[column.key] ?? 0))
                                        : String(line[column.key] ?? "—")}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ))
                          : null}
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-500">
          {filteredRows.length === rows.length
            ? `${rows.length} employees`
            : `${filteredRows.length} of ${rows.length} employees shown`}
          {totalPrimary != null ? ` · total ${money(totalPrimary)}` : ""}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={locked || busy || !dirty} onClick={() => void save()}>
            Save
          </Button>
          <Button
            disabled={locked || busy}
            onClick={() => void confirm()}
            className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
          >
            {/* A greyed button with unchanged text reads as broken. Confirming
                the Vacation step also re-settles leave balances, so it can sit
                busy for a while — say so rather than look dead. */}
            {busy ? "Confirming…" : confirmed ? "Re-confirm & continue" : "Confirm & continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
