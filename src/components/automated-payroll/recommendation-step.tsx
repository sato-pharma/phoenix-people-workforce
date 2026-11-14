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
import { calendarDaysInMonth } from "@/lib/payroll/copilot/proration";
import {
  dayDrivenMoney,
  monthNameAndYear,
  stepDefinition,
  stepFieldsTotal,
  stepWindowLabel,
} from "@/lib/automated-payroll/step-definitions";
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

import { AdminCallout } from "@/components/admin/admin-design-system";
import { CardSection, SectionHeading } from "./section-shell";
import { CellHistorySection } from "./cell-history";
import { formatPayrollDay, formatPayrollMoney, isPlaceholderReason, peopleCount } from "./format";
import { phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";

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
  /** Held Salary Release: a held month was recorded from Add employee — the wizard reloads this step and its panel. */
  onHeldEntered?: () => void;
};

const money = formatPayrollMoney;
const CAIRO_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });

/**
 * The quick filters over a step's cards. Search was the only way to narrow a hundred cards, and
 * the questions HR actually asks of a step are these: who carries a figure, whom did a person
 * change, who is held, where is a double charge, whom did somebody add by hand.
 */
type RowFilter = "all" | "figure" | "edited" | "held" | "conflict" | "manual";

const ROW_FILTER_LABELS: Record<RowFilter, string> = {
  all: "Everyone",
  figure: "Has a figure",
  edited: "Changed from the recommendation",
  held: "Held",
  conflict: "Already settled elsewhere",
  manual: "Added by hand",
};

/** A money or days box on this row differs from what the system recommended. */
function rowEdited(definition: StepDefinition, row: StepRow): boolean {
  return definition.fields.some(
    (field) =>
      (field.kind === "money" || field.kind === "days") &&
      Math.abs((row.values[field.key] ?? 0) - (row.recommended?.[field.key] ?? 0)) > 0.004,
  );
}

/** Any money or days box on this row is not zero. */
function rowHasFigure(definition: StepDefinition, row: StepRow): boolean {
  return definition.fields.some(
    (field) => (field.kind === "money" || field.kind === "days") && Math.abs(row.values[field.key] ?? 0) > 0.004,
  );
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
    <CardSection title="This month's settlement" tone="settlement">
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
    </CardSection>
  );
}

/**
 * The form kit's own field recipe, dense height. Text and number boxes wear the FIELD token; only a
 * real <select> wears the select token, whose pointer cursor on a text box read as a dropdown.
 */
const fieldClassName = cn(phxFieldClassName, "h-9");
const selectClassName = cn(phxSelectClassName, "h-9");

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
  heldMonths,
  heldBlocked,
  onAddHeld,
}: {
  candidates: ManualRowCandidate[];
  moneyLabel: string;
  noteLabel: string | null;
  onAdd: (candidate: ManualRowCandidate, amount: number, note: string) => void;
  /**
   * Held Salary Release only: the published months that kept a held COUNT and no names (July and August
   * 2026). Picking one records the amount HR types as held that month (held-entered route) instead of a
   * Part 1 Not Paid row — the only way a leaver held then can be listed at all (owner, 2026-11-09).
   */
  heldMonths?: { runId: string; label: string }[];
  /** Why recording a held month must wait (the step has unsaved edits), or null. */
  heldBlocked?: string | null;
  onAddHeld?: (candidate: ManualRowCandidate, heldRunId: string, amount: number, note: string) => Promise<void>;
}) {
  const heldMode = heldMonths !== undefined;
  const [heldRunId, setHeldRunId] = useState("");
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
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
    setHeldRunId("");
    setAddError(null);
  };

  const amountValue = Number(amount);
  const forHeldMonth = heldMode && heldRunId !== "";
  const canAdd =
    picked !== null &&
    Number.isFinite(amountValue) &&
    amountValue > 0 &&
    !saving &&
    (forHeldMonth
      ? note.trim() !== "" && !heldBlocked
      : !heldMode || picked === null || amountValue <= (picked.lastMonthPart1 ?? 0));
  // "Part 1 Not Paid" is only possible for someone last month's Part 1 actually paid (owner, 2026-11-09: it
  // refused a leaver who was not on that month, and the default sent him straight into the refusal).
  const part1Possible = (picked?.lastMonthPart1 ?? 0) > 0;
  const pickCandidate = (candidate: ManualRowCandidate) => {
    setPicked(candidate);
    setAddError(null);
    const months = heldMonths ?? [];
    if (heldMode && (candidate.lastMonthPart1 ?? 0) <= 0 && months.length > 0) {
      setHeldRunId((current) => current || months[months.length - 1].runId);
    }
  };
  const statusLabel = (candidate: ManualRowCandidate) =>
    candidate.status && !/^active$/i.test(candidate.status) ? ` (${candidate.status.replace(/_/g, " ")})` : "";

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
        {heldMode ? (
          <p className="mt-0.5 text-xs text-slate-600">
            Every employee is listed, including people who have resigned. For pay held in a month that did not record
            names (July or August 2026), choose that month and type the amount held — the person then appears below with
            it outstanding, ready to release. Otherwise the amount is last month&apos;s Part 1 that was not paid.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-slate-600">
            For someone whose trip never reached the expense table. Pick the employee, type what to reimburse, and say
            why — the amount is paid exactly like a system-recommended one, so the note is the only record of where it
            came from.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="relative flex flex-col gap-1 lg:w-80">
          <span className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">Employee</span>
          <Input
            value={picked ? `${picked.fullName}${statusLabel(picked)}` : query}
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
                    onClick={() => pickCandidate(candidate)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-orange-50"
                  >
                    <span className="min-w-0 whitespace-normal break-words text-slate-800">
                      {candidate.fullName}
                      {statusLabel(candidate)}
                    </span>
                    <span className="shrink-0 text-slate-500">{candidate.jobTitle ?? ""}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {heldMode ? (
          <label className="flex flex-col gap-1 lg:w-52">
            <span className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">For</span>
            <select
              value={heldRunId}
              onChange={(event) => setHeldRunId(event.target.value)}
              className={selectClassName}
            >
              {picked === null || part1Possible ? (
                <option value="">Last month&apos;s Part 1 not paid</option>
              ) : null}
              {(heldMonths ?? []).map((month) => (
                <option key={month.runId} value={month.runId}>
                  Held in {month.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="flex flex-col gap-1 lg:w-40">
          <span className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">
            {forHeldMonth ? "Amount held" : moneyLabel}
          </span>
          <Input
            type="number"
            value={amount}
            placeholder="0"
            onChange={(event) => setAmount(event.target.value)}
            className={cn(fieldClassName, "text-right")}
          />
        </label>

        {forHeldMonth ? (
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">Note (required)</span>
            <Input
              value={note}
              placeholder="Where the held amount comes from"
              onChange={(event) => setNote(event.target.value)}
              className={fieldClassName}
            />
          </label>
        ) : noteLabel ? (
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
              if (forHeldMonth && onAddHeld) {
                setSaving(true);
                setAddError(null);
                onAddHeld(picked, heldRunId, amountValue, note.trim())
                  .then(() => reset())
                  .catch((failure: unknown) =>
                    setAddError(failure instanceof Error ? failure.message : "Failed to record the held amount."),
                  )
                  .finally(() => setSaving(false));
                return;
              }
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

      {addError ? <p className="text-xs font-semibold text-rose-700">{addError}</p> : null}
      {forHeldMonth && heldBlocked ? <p className="text-xs font-semibold text-amber-800">{heldBlocked}</p> : null}
      {heldMode && picked !== null && !forHeldMonth && part1Possible && amountValue > (picked.lastMonthPart1 ?? 0) ? (
        <p className="text-xs font-semibold text-amber-800">
          Last month&apos;s Part 1 for {picked.fullName} was {formatPayrollMoney(picked.lastMonthPart1 ?? 0)} — more than
          that is held pay: set For to the month it was held.
        </p>
      ) : null}
      <p className="text-xs text-slate-500">
        {forHeldMonth
          ? "A held month is recorded as soon as you add it, and the step reloads with the person listed."
          : "Added rows are not saved until you press Save or Confirm below."}
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
  onHeldEntered,
}: Props) {
  const definition = stepDefinition(stepKey);
  const isHeldRelease = stepKey === "p1_held_release" || stepKey === "p2_held_release";
  /** Held Salary Release: the months that kept a held count and no names — see AddEmployeePanel. */
  const [heldMonths, setHeldMonths] = useState<{ runId: string; label: string }[]>([]);
  const [rows, setRows] = useState<StepRow[]>([]);
  const [period, setPeriod] = useState<PayrollPeriod | null>(null);
  const [loading, setLoading] = useState(true);
  /** The step could not be read at all — said as such, never shown as "no employees". */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Which action is busy, so the button that is working is the one that says so. */
  const [busyAction, setBusyAction] = useState<"save" | "confirm" | "upload" | null>(null);
  /** When the last save landed — the action bar's "Saved" note. */
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<RowFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<StepImportPreview | null>(null);
  /**
   * The workbook the preview describes (audit finding 27). It CANNOT be read back off the file
   * input at Apply time: the change handler clears `input.value` so re-picking the same file fires
   * `change` again, and that empties `input.files` with it. Apply therefore read `undefined`, hit
   * an `if (file)` guard, and did nothing at all — no request, no error, no clue on screen.
   */
  const [pendingUpload, setPendingUpload] = useState<File | null>(null);
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
    setLoadFailed(false);
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
      setLoadFailed(true);
      setError(loadError instanceof Error ? loadError.message : "Failed to load step.");
    } finally {
      setLoading(false);
    }
  }, [runId, stepKey]);

  useEffect(() => {
    if (!isHeldRelease) return;
    let cancelled = false;
    fetch(`/api/automated-payroll/runs/${runId}/held-entered`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { months?: { runId: string; label: string }[] } | null) => {
        if (!cancelled && data?.months) setHeldMonths(data.months.map((m) => ({ runId: m.runId, label: m.label })));
      })
      // The months only add a choice to the picker; without them it still records Part 1 Not Paid.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isHeldRelease, runId]);

  /** Record a held month's amount for someone (held-entered route); the wizard then reloads this step. */
  const addHeldMonth = async (candidate: ManualRowCandidate, heldRunId: string, amount: number, note: string) => {
    const res = await fetch(`/api/automated-payroll/runs/${runId}/held-entered`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ heldRunId, hrId: candidate.hrId, amount, note }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Failed to record the held amount.");
    if (onHeldEntered) onHeldEntered();
    else await load();
  };

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
    const edits: StepEditInput[] = rows
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
        // What this screen proposed, so the server writes only the figures somebody changed and
        // leaves the rest following the Deductions module (saved-figures.ts).
        recommended: row.recommended,
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
   *   divisor — the month's ACTUAL calendar days, for deductions exactly as for
   *             pay (owner ruling 2026-09-12, audit finding 37 — it retired the
   *             flat 30 the Part 1 deduction tabs used to divide by, which made
   *             a deducted day worth more than the day it cancelled in a 31-day
   *             month and less in February). A step may still name its own
   *             divisor column via `autoCalcDivisorContextKey`; today every one
   *             that does carries the same figure.
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
    // The arithmetic lives in step-definitions.ts so a re-uploaded sheet prices a corrected day
    // count exactly as this grid does (audit finding 32).
    //
    // `period` is loaded with the step and is null only before the first load lands, when there are
    // no rows to type into. If it somehow is null, dayDrivenMoney is handed 0 and prices nothing
    // rather than guessing a month length — a blank cell HR can see beats a silently wrong number.
    Object.assign(
      values,
      dayDrivenMoney(spec, row.context, days, period ? calendarDaysInMonth(period) : 0),
    );
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
    // Typing clears the carried-forward marker: the text is this month's
    // assertion from here on, and leaving the badge up would keep calling it
    // last month's after somebody rewrote it. The stored text keeps whatever
    // "Carried forward from ..." prefix the editor chose to leave in place.
    setRows((prev) =>
      prev.map((row) => (row.hrId === hrId ? { ...row, reason, reasonCarriedForward: false } : row)),
    );
    setDirty(true);
  };

  const setHold = (hrId: string, onHold: boolean) => {
    setRows((prev) => prev.map((row) => (row.hrId === hrId ? { ...row, onHold } : row)));
    setDirty(true);
  };

  /**
   * Resolves TRUE only when the edits landed. The answer matters to `confirm` below: it used to
   * call this, ignore a refused save (a hold with no reason answers 400) and confirm anyway — so
   * the step locked on the figures saved BEFORE the edits, the wizard moved to the next step, and
   * the edits on screen were thrown away with nothing saying so.
   */
  const save = async (): Promise<boolean> => {
    setBusy(true);
    setBusyAction("save");
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
      setSavedAt(Date.now());
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save.");
      return false;
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  const confirm = async () => {
    setError(null);
    // A refused save stops the confirm here, with its own error on screen and every edit still in
    // the boxes — never a confirm of the older saved figures.
    if (dirty && !(await save())) return;
    setBusy(true);
    setBusyAction("confirm");
    try {
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
      setBusyAction(null);
    }
  };

  const onUpload = async (file: File, commit: boolean) => {
    setBusy(true);
    setBusyAction("upload");
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
        setPendingUpload(null);
        await load();
      } else {
        setPreview(data.result as StepImportPreview);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed.");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  };

  // Ctrl/Cmd+S saves the open step — a hundred cards down, the Save button is a long scroll away.
  // Read through a ref so the listener is registered once and still calls today's `save`.
  const saveShortcutRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    saveShortcutRef.current = () => {
      if (!locked && !busy && dirty) void save();
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveShortcutRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Double-deduction guard — rule lives in lib/automated-payroll/conflicts.ts so it is
  // unit-tested rather than only eyeballed here.
  const conflictKey = definition.conflictContextKey;
  const hasConflict = useCallback(
    (row: StepRow) => hasDoubleDeductionConflict(definition, row),
    [definition],
  );

  const conflictRows = useMemo(() => rows.filter(hasConflict), [rows, hasConflict]);

  /** The step's headline column, summed — and NAMED, so the footer never shows a bare total. */
  const totalPrimary = useMemo(() => {
    const field = definition.fields.find((f) => f.kind === "money") ?? definition.fields[0];
    if (!field || field.kind === "text" || field.kind === "select") return null;
    return {
      label: field.label,
      isMoney: field.kind === "money",
      total: rows.reduce((sum, row) => sum + (row.values[field.key] ?? 0), 0),
    };
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
  const matchesFilter = useCallback(
    (row: StepRow, which: RowFilter): boolean => {
      switch (which) {
        case "figure":
          return rowHasFigure(definition, row);
        case "edited":
          return !row.readOnly && rowEdited(definition, row);
        case "held":
          return row.onHold;
        case "conflict":
          return hasConflict(row);
        case "manual":
          return row.manual === true;
        default:
          return true;
      }
    },
    [definition, hasConflict],
  );

  /** How many cards each quick filter would show — a filter that would show nobody is not offered. */
  const filterCounts = useMemo(() => {
    const counts = {} as Record<RowFilter, number>;
    for (const key of Object.keys(ROW_FILTER_LABELS) as RowFilter[]) {
      counts[key] = rows.filter((row) => matchesFilter(row, key)).length;
    }
    return counts;
  }, [rows, matchesFilter]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter(
      (row) =>
        matchesFilter(row, filter) &&
        (!query || row.hrId.toLowerCase().includes(query) || row.fullName.toLowerCase().includes(query)),
    );
  }, [rows, search, filter, matchesFilter]);

  /** What a confirm is about to freeze, said beside the button that freezes it. */
  const editedCount = useMemo(
    () => rows.filter((row) => !row.readOnly && rowEdited(definition, row)).length,
    [rows, definition],
  );

  /** Same precedence for the grid row tint and the mobile card border. */
  const rowTone = (row: StepRow): "hold" | "conflict" | "manual" | "leaver" | "notice" | null => {
    if (row.onHold) return "hold";
    if (hasConflict(row)) return "conflict";
    if (row.readOnly) return "notice";
    // Above "leaver": that a figure was typed by a person rather than derived
    // from data is the more important thing to see on a payroll screen.
    if (row.manual) return "manual";
    if (row.lifecycle === "leaver" || row.releaseOnly) return "leaver";
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
    return (
      <div role="status" className="border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
        Loading {definition.title} — reading this month&rsquo;s figures…
      </div>
    );
  }

  // A step that never loaded has nothing to edit: an empty grid under an error reads as
  // "nobody is owed anything this month", which is the one thing it must never say.
  if (loadFailed && rows.length === 0) {
    return (
      <AdminCallout tone="danger">
        <div className="flex flex-1 flex-col gap-2">
          <span className="font-semibold">{definition.title} could not be loaded.</span>
          <span className="break-words">{error ?? "The server did not answer."}</span>
          <div>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </div>
      </AdminCallout>
    );
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
              // The sheet is read from the SAVED figures. A refused save used to download anyway, so
              // HR edited a file that did not hold what was on screen; it stops here, its error shown.
              if (dirty && !(await save())) return;
              downloadFromApiRoute(`/api/automated-payroll/runs/${runId}/steps/${stepKey}/export`);
            }}
          >
            Download Excel
          </Button>
          <Button variant="outline" size="sm" disabled={locked || busy} onClick={() => fileRef.current?.click()}>
            Upload edited Excel
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Remember the File itself BEFORE the line below empties `input.files` (finding 27).
              if (file) {
                setPendingUpload(file);
                void onUpload(file, false);
              }
              event.target.value = "";
            }}
          />
        </div>
      </div>

      {error ? (
        <div role="alert" className="break-words border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div>
      ) : null}

      {conflictRows.length > 0 && conflictKey ? (
        <div className="border-l-4 border-orange-400 bg-orange-50 px-4 py-3 text-sm text-orange-900">
          <div className="font-black">
            Careful — this would be deducted twice for{" "}
            {peopleCount(conflictRows.length)}.
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
            Upload preview — {preview.changed} changed, {preview.invalid} not usable, of {preview.totalRows} rows
            in the file. Nothing is saved until you apply it.
          </div>
          {(() => {
            // Unchanged lines say nothing; the refused ones go first, then the ones that move money.
            const worth = preview.diffs
              .filter((diff) => diff.status !== "unchanged")
              .sort((a, b) => Number(b.status === "invalid") - Number(a.status === "invalid"));
            const shown = worth.slice(0, 40);
            const show = (value: number | string | null) =>
              typeof value === "number" ? money(value) : value === null || value === "" ? "—" : String(value);
            return (
              <ul className="mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto text-xs">
                {shown.map((diff, index) => (
                  <li
                    key={`${diff.hrId}-${diff.field}-${index}`}
                    className={cn("break-words", diff.status === "invalid" ? "text-rose-700" : "text-amber-900")}
                  >
                    <span className="font-semibold">{diff.fullName || diff.hrId}</span> ·{" "}
                    {fieldSpecOf(definition, diff.field)?.label ?? diff.field}:{" "}
                    <span className="tabular-nums">{show(diff.from)}</span> →{" "}
                    <span className="tabular-nums">{show(diff.to)}</span>
                    {diff.status === "invalid"
                      ? ` — not usable${diff.message ? `: ${diff.message}` : ""}`
                      : diff.status === "added"
                        ? " (new row)"
                        : ""}
                  </li>
                ))}
                {worth.length > shown.length ? (
                  <li className="text-amber-800">and {worth.length - shown.length} more</li>
                ) : null}
                {worth.length === 0 ? <li className="text-slate-600">The file changes nothing on this step.</li> : null}
              </ul>
            );
          })()}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={busy || !pendingUpload}
              onClick={() => {
                // Never silently no-op: a button that looks pressable and does nothing is the whole
                // of finding 27. If the file is somehow gone, say so and ask for it again.
                if (!pendingUpload) {
                  setError("The uploaded file is no longer available — upload the xlsx again to apply it.");
                  return;
                }
                void onUpload(pendingUpload, true);
              }}
            >
              Apply changes
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPreview(null);
                setPendingUpload(null);
              }}
            >
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
          {...(isHeldRelease
            ? {
                heldMonths,
                heldBlocked: dirty ? "Save the changes on this step first — recording a held month reloads it." : null,
                onAddHeld: addHeldMonth,
              }
            : {})}
        />
      ) : null}

      {rows.length > 0 ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by HR_ID or name…"
            aria-label="Search employees on this step"
            className={cn(fieldClassName, "w-full sm:max-w-xs")}
          />
          <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
            {(Object.keys(ROW_FILTER_LABELS) as RowFilter[])
              .filter((key) => key === "all" || filterCounts[key] > 0 || filter === key)
              .map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                  className={cn(
                    "border px-2.5 py-1 text-xs font-semibold transition-colors",
                    filter === key
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-400",
                  )}
                >
                  {ROW_FILTER_LABELS[key]} <span className="tabular-nums opacity-70">{filterCounts[key]}</span>
                </button>
              ))}
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
          No employees for this step.
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
          {search.trim() ? (
            <>No employees match &ldquo;{search}&rdquo;{filter !== "all" ? ` under “${ROW_FILTER_LABELS[filter]}”` : ""}.</>
          ) : (
            <>No employees under &ldquo;{ROW_FILTER_LABELS[filter]}&rdquo;.</>
          )}
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
                <article
                  key={row.hrId}
                  className={cn(
                    // Flat and square; the dark name band below separates one person from the next.
                    "border border-slate-200 bg-white transition-colors hover:border-slate-400",
                    tone === "hold" && "border-rose-300 bg-rose-50",
                    tone === "conflict" && "border-l-4 border-l-orange-400 bg-orange-50",
                    tone === "notice" && "border-l-4 border-l-sky-400 bg-sky-50/70",
                    tone === "manual" && "border-l-4 border-l-amber-400 bg-amber-50/60",
                    tone === "leaver" && "bg-red-50",
                  )}
                >
                  {/* Identity banner — the person, not their figures. Dark so each card
                      opens with a clear anchor and the blocks below it read as belonging
                      to somebody, which a plain underlined name never achieved. */}
                  <header
                    className={cn(
                      // Stacks below 640px so the name gets the card's full
                      // width instead of sharing the row with the badges: at
                      // 375px that is the difference between a legible name and
                      // a clipped one on a screen whose entire job is telling
                      // you WHO is being paid. Names are never wrapped or
                      // ellipsised (owner rule) — they clip, so every pixel of
                      // width recovered here is a character of a real person's
                      // name that stays readable.
                      "flex flex-col items-start gap-1.5 border-b border-slate-200 bg-slate-900 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2",
                      tone === "hold" && "bg-rose-900",
                    )}
                  >
                    <div className="w-full min-w-0 sm:w-auto sm:flex-1">
                      <div className="break-words text-[13px] font-black tracking-tight text-white sm:text-sm">
                        {row.fullName}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] text-slate-400">
                        <span>{row.hrId}</span>
                        {hireDateColumn ? (
                          <span className="font-sans">
                            · Hired {formatPayrollDay(row.context[hireDateColumn.key])}
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
                          className="flex size-6 items-center justify-center text-slate-400 transition hover:text-rose-400"
                        >
                          <X className="size-4" />
                        </button>
                      ) : null}
                    </div>
                  </header>

                  <div className="flex flex-col gap-2 p-2.5">
                    {bodyContextColumns.length > 0 ? (
                      <CardSection title="Details">
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
                      </CardSection>
                    ) : null}

                    {/* Everything HR actually changes on THIS screen, inside one border —
                        kept apart from the read-only Details above it and the whole-month
                        Settlement below it, so the three kinds of figure can no longer be
                        mistaken for one another. */}
                    <CardSection title="This step">
                      {definition.isHoldStep ? (
                        <>
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

                          {/* Whether this hold is a CONTINUATION or something new — the
                              question the run being reviewed cannot answer about itself.
                              August 2026 carried thirteen holds with no reason while two of
                              them were fully explained by July's rows; the explanation simply
                              never travelled, and the reviewer had no way to tell a settled
                              owner ruling from an open question. Shown for every row the
                              previous run held, including one it held with no reason, because
                              "held again, still unexplained" is itself worth reading. */}
                          {row.priorHold ? (
                            <div className="flex flex-col gap-1 border-l-4 border-amber-400 bg-amber-50/60 px-3 py-2 text-amber-900">
                              <span className="text-[11px] font-black uppercase tracking-wide">
                                Also held in {monthNameAndYear(row.priorHold.month, row.priorHold.year)}
                              </span>
                              <span className="break-words text-[12px]">
                                {row.priorHold.reason ??
                                  "No reason was recorded that month either — this hold has never been explained."}
                              </span>
                            </div>
                          ) : row.onHold ? (
                            <div className="border-l-4 border-slate-300 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
                              New this month — the previous run did not hold this employee.
                            </div>
                          ) : null}
                        </>
                      ) : null}

                      {definition.fields.map((field) => (
                        <label key={field.key} className="flex flex-col gap-1 text-sm">
                          {/* Micro-caps label, the module's premium field recipe. Literal
                              text-[11px]: a named text-phx-* size is silently stripped by
                              cn()/tailwind-merge and only a real browser can see it happen. */}
                          <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">
                            {field.label}
                          </span>
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
                              className={cn(selectClassName, "px-2")}
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
                              className={cn(fieldClassName, "text-right tabular-nums")}
                            />
                          )}
                        </label>
                      ))}

                      {definition.hasReason ? (
                        (() => {
                          // A hold with no reason cannot be saved (the service answers 400).
                          // Say so on the row rather than only in the error that comes back
                          // after pressing Save, so the requirement is visible while there is
                          // still something to type it into.
                          const reasonMissing =
                            definition.isHoldStep && row.onHold && !(row.reason ?? "").trim();
                          // "-" is accepted (the confirm gate allows it on purpose), but it tells
                          // nobody later why this person was not paid — flag it, never block it.
                          const reasonPlaceholder =
                            definition.isHoldStep && row.onHold && isPlaceholderReason(row.reason);
                          return (
                            <label className="flex flex-col gap-1 text-sm">
                              <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">
                                {definition.isHoldStep ? "Reason · required to hold" : "Reason"}
                              </span>
                              <Input
                                value={row.reason ?? ""}
                                disabled={isRowLocked(row)}
                                placeholder={
                                  definition.isHoldStep
                                    ? "Why is this person not being paid by this run?"
                                    : "Reason"
                                }
                                onChange={(event) => setReason(row.hrId, event.target.value)}
                                className={cn(
                                  fieldClassName,
                                  reasonMissing && "border-rose-400 bg-rose-50/60",
                                  reasonPlaceholder && "border-amber-400 bg-amber-50/60",
                                )}
                              />
                              {reasonPlaceholder ? (
                                <span className="break-words text-[11px] font-semibold text-amber-800">
                                  &ldquo;{(row.reason ?? "").trim()}&rdquo; is not a reason. Write why — it is the
                                  only record of why this person was not paid by this run.
                                </span>
                              ) : null}
                              {row.reasonCarriedForward ? (
                                <span className="break-words text-[11px] font-semibold text-amber-800">
                                  Carried over from the previous month, not written for this one — check it
                                  still applies, and rewrite it if it does not.
                                </span>
                              ) : null}
                              {reasonMissing ? (
                                <span className="break-words text-[11px] font-semibold text-rose-700">
                                  Required. A held row is dropped at publish — no payslip is written and
                                  nothing else records that this person was paid outside the system.
                                </span>
                              ) : null}
                            </label>
                          );
                        })()
                      ) : null}

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
                    </CardSection>

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

                    {/* The per-line breakdown is the card's fourth block, and it
                        carries the same border as the other three whether it is
                        open or shut. Collapsed, it is a bordered strip shaped
                        exactly like a CardSection header, so the card keeps its
                        rhythm instead of ending in a loose blue-ish link. */}
                    {hasDetail && lineCount > 0 ? (
                      isExpanded ? (
                        <CardSection
                          title={detailLabel(row)}
                          action={
                            <button
                              type="button"
                              onClick={() => toggleExpanded(row.hrId)}
                              aria-expanded
                              className="flex items-center gap-0.5 whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-orange-600 transition hover:text-orange-700"
                            >
                              Hide
                              <ChevronDown className="size-3.5" />
                            </button>
                          }
                        >
                          {/* One mini-card per line, label/value stacked — nothing
                              here is ever truncated or side-scrolled. */}
                          {(row.details ?? []).map((line, lineIndex) => (
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
                          ))}
                        </CardSection>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(row.hrId)}
                          aria-expanded={false}
                          className="flex items-center justify-between gap-2 border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-left transition hover:border-slate-300 hover:bg-slate-100"
                        >
                          <SectionHeading title={detailLabel(row)} className="min-w-0" />
                          <ChevronRight className="size-3.5 shrink-0 text-orange-600" />
                        </button>
                      )
                    ) : null}

                    {/* Who changed which figure, and why — the question the sheet's single
                        "last edited by" could never answer (owner, 2026-10-07). */}
                    <CellHistorySection runId={runId} hrId={row.hrId} />
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {/* Sticky so Save and Confirm never sit a hundred cards below the figure just typed. */}
      <div className="sticky bottom-0 z-20 flex flex-col gap-3 border-t border-slate-200 bg-white py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-0.5 text-sm text-slate-600">
          <span>
            {filteredRows.length === rows.length
              ? peopleCount(rows.length)
              : `${filteredRows.length} of ${peopleCount(rows.length)} shown`}
            {totalPrimary ? (
              <>
                {" · "}
                {totalPrimary.label}{" "}
                <span className="font-semibold tabular-nums text-slate-900">
                  {totalPrimary.isMoney ? `${money(totalPrimary.total)} EGP` : totalPrimary.total}
                </span>
              </>
            ) : null}
          </span>
          <span className="text-xs text-slate-500" aria-live="polite">
            {dirty
              ? "Unsaved changes — Ctrl+S saves."
              : savedAt
                ? `Saved at ${CAIRO_TIME.format(savedAt)}.`
                : null}
            {editedCount > 0 ? ` ${peopleCount(editedCount)} with a figure changed by hand.` : ""}
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={locked || busy || !dirty} onClick={() => void save()}>
            {busyAction === "save" ? "Saving…" : "Save"}
          </Button>
          <Button
            disabled={locked || busy}
            onClick={() => void confirm()}
            className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
          >
            {/* A greyed button with unchanged text reads as broken. Confirming
                the Vacation step also re-settles leave balances, so it can sit
                busy for a while — say so rather than look dead. */}
            {busyAction === "confirm"
              ? dirty
                ? "Saving, then confirming…"
                : "Confirming…"
              : confirmed
                ? "Re-confirm & continue"
                : "Confirm & continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
