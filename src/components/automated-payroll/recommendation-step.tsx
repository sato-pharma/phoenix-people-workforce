"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  enteredOnThisStepAmount,
  hasDoubleDeductionConflict,
} from "@/lib/automated-payroll/conflicts";
import { stepDefinition, stepWindowLabel } from "@/lib/automated-payroll/step-definitions";
import type {
  PayrollPeriod,
  StepDefinition,
  StepEditInput,
  StepImportPreview,
  StepKey,
  StepRow,
} from "@/lib/automated-payroll/types";
import { cn } from "@/lib/utils";

type Props = {
  runId: string;
  stepKey: StepKey;
  confirmed: boolean;
  locked: boolean;
  onConfirmed: () => void;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Shared premium field recipe (see [[premium-design-language]]) — orange focus ring, dense height. */
const fieldClassName =
  "h-9 border-slate-300 bg-white text-sm transition focus-visible:border-orange-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/20";

/**
 * One CSS-grid column template shared by the header and every row, computed once per
 * step definition. Deliberately NOT a native <table> — the shared `.admin-shell`
 * stylesheet forces every <table>/th/td into a flat-black header + an orange hairline
 * on every single cell (rows AND columns), which is the dense "spreadsheet grid" look
 * this restyle is replacing. A grid of divs sidesteps that tag selector entirely while
 * still laying out a variable, per-step column set.
 */
function gridTemplate(definition: StepDefinition): string {
  const columns = [
    // Row expander (chevron) — only on steps that carry a per-line breakdown.
    ...(definition.detailColumns?.length ? ["26px"] : []),
    "92px", // HR_ID
    "minmax(200px,1.4fr)", // Employee
    ...definition.contextColumns.map(() => "minmax(112px,1fr)"),
  ];
  if (definition.isHoldStep) columns.push("84px");
  for (const field of definition.fields) {
    columns.push(
      field.kind === "text" || field.kind === "select" ? "minmax(170px,1.3fr)" : "minmax(108px,0.85fr)",
    );
  }
  if (definition.hasReason) columns.push("minmax(180px,1.4fr)");
  return columns.join(" ");
}

/**
 * The read-only per-line breakdown behind one row's figure — the trips behind an
 * expense total, the days behind a deduction (owner request 2026-08-01).
 *
 * Scrolls horizontally inside its own container rather than truncating: locations
 * are Arabic free text and routinely long, and this repo's standing rule is that
 * data is never clipped or wrapped away. `dir="auto"` so Arabic renders RTL in an
 * otherwise LTR grid.
 */
function DetailPanel({ definition, row }: { definition: StepDefinition; row: StepRow }) {
  const columns = definition.detailColumns ?? [];
  const lines = row.details ?? [];
  if (columns.length === 0 || lines.length === 0) return null;
  const template = columns
    .map((column) => (column.money ? "minmax(96px,0.7fr)" : "minmax(120px,1fr)"))
    .join(" ");
  return (
    <div className="overflow-x-auto border-t border-slate-200 bg-slate-50/80 px-3 py-2">
      <div className="min-w-max">
        <div className="grid gap-x-4 border-b border-slate-300 pb-1.5" style={{ gridTemplateColumns: template }}>
          {columns.map((column) => (
            <div
              key={column.key}
              className={cn(
                "whitespace-nowrap text-[10px] font-bold uppercase tracking-wide text-slate-500",
                column.money && "text-right",
              )}
            >
              {column.label}
            </div>
          ))}
        </div>
        {lines.map((line, index) => (
          <div
            key={index}
            className="grid gap-x-4 border-b border-slate-200/70 py-1.5 last:border-b-0"
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((column) => {
              const value = line[column.key];
              return (
                <div
                  key={column.key}
                  dir={column.money ? "ltr" : "auto"}
                  className={cn(
                    "whitespace-nowrap text-xs text-slate-700",
                    column.money && "text-right tabular-nums",
                  )}
                >
                  {column.money ? money(Number(value ?? 0)) : String(value ?? "—")}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function RecommendationStep({ runId, stepKey, confirmed, locked, onConfirmed }: Props) {
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
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/steps/${stepKey}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load step.");
      setRows(data.rows as StepRow[]);
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

  const toEdits = useCallback((): StepEditInput[] => {
    return (
      rows
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
        }))
    );
  }, [rows]);

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
   * Editing a "days" field auto-calculates its paired money field via
   * Base Salary / divisor × days.
   *
   * The divisor defaults to 30 (the owner's day-rate rule for deductions) but a
   * field can name a context column to read instead — resignation proration
   * divides by the month's ACTUAL calendar days, so a 31-day month would
   * otherwise compute the wrong settlement.
   */
  const setDaysValue = (
    hrId: string,
    field: string,
    autoCalcMoneyKey: string | undefined,
    days: number,
    divisorContextKey?: string,
  ) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.hrId !== hrId) return row;
        const values = { ...row.values, [field]: days };
        if (autoCalcMoneyKey) {
          const baseSalary = Number(row.context["Base Salary"] ?? 0);
          const divisor = divisorContextKey ? Number(row.context[divisorContextKey] ?? 0) || 30 : 30;
          values[autoCalcMoneyKey] = Math.round(((baseSalary / divisor) * days + Number.EPSILON) * 100) / 100;
        }
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
   * then recomputes its money field from its OWN (possibly just-derived) day
   * count.
   *
   * The money divisor is per-field: DEFAULT /30 (the deduction day-rate), unless
   * the field names an `autoCalcDivisorContextKey` — the Resignations CRM tab
   * (owner rule 2026-07-26) reads the month's ACTUAL calendar days there to
   * unify with the settlement rate. This is a DIFFERENT context key from
   * `totalContextKey` (the complement CAP): the cap bounds the day count, the
   * divisor sets money-per-day. Conflating them would silently change the
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

        const spec = definition.fields.find((candidate) => candidate.key === field);
        const complementSpec = definition.fields.find((candidate) => candidate.key === complementField);
        const baseSalary = Number(row.context["Base Salary"] ?? 0);
        const divisorFor = (candidate: typeof spec) => {
          const key = candidate?.autoCalcDivisorContextKey;
          return key ? Number(row.context[key] ?? 0) || 30 : 30;
        };
        if (spec?.autoCalcMoneyKey) {
          values[spec.autoCalcMoneyKey] =
            Math.round(((baseSalary / divisorFor(spec)) * clamped + Number.EPSILON) * 100) / 100;
        }
        if (complementSpec?.autoCalcMoneyKey) {
          values[complementSpec.autoCalcMoneyKey] =
            Math.round(((baseSalary / divisorFor(complementSpec)) * complementValue + Number.EPSILON) * 100) / 100;
        }
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

  const template = useMemo(() => gridTemplate(definition), [definition]);

  const windowLabel = useMemo(
    () => (period ? stepWindowLabel(stepKey, period) : null),
    [period, stepKey],
  );

  /** Steps that carry a per-line breakdown get an expander column in front of HR_ID. */
  const hasDetail = (definition.detailColumns?.length ?? 0) > 0;
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
  const rowTone = (row: StepRow): "hold" | "conflict" | "leaver" | "notice" | null => {
    if (row.onHold) return "hold";
    if (hasConflict(row)) return "conflict";
    if (row.readOnly) return "notice";
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
            onClick={() =>
              (window.location.href = `/api/automated-payroll/runs/${runId}/steps/${stepKey}/export`)
            }
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
          {/* Desktop / tablet: a dense CSS-grid table. Never rendered below md — see the
              stacked-card list further down for that breakpoint (no horizontal scroll). */}
          <div className="hidden overflow-x-auto border border-slate-200 md:block">
            <div>
              <div
                className="grid items-center gap-x-3 bg-slate-900 px-3 py-2.5"
                style={{ gridTemplateColumns: template }}
              >
                {hasDetail ? <div aria-hidden /> : null}
                <div className="overflow-hidden text-[11px] font-bold uppercase tracking-wide text-slate-300">HR_ID</div>
                <div className="overflow-hidden text-[11px] font-bold uppercase tracking-wide text-slate-300">Employee</div>
                {definition.contextColumns.map((column) => (
                  <div
                    key={column.key}
                    className="overflow-hidden text-right text-[11px] font-bold uppercase tracking-wide text-slate-300"
                  >
                    <span className="whitespace-nowrap">{column.label}</span>
                  </div>
                ))}
                {definition.isHoldStep ? (
                  <div className="overflow-hidden text-center text-[11px] font-bold uppercase tracking-wide text-slate-300">Hold</div>
                ) : null}
                {definition.fields.map((field) => (
                  <div
                    key={field.key}
                    className={cn(
                      "overflow-hidden text-[11px] font-bold uppercase tracking-wide text-slate-300",
                      field.kind === "text" || field.kind === "select" ? "text-left" : "text-right",
                    )}
                  >
                    <span className="whitespace-nowrap">{field.label}</span>
                  </div>
                ))}
                {definition.hasReason ? (
                  <div className="overflow-hidden text-[11px] font-bold uppercase tracking-wide text-slate-300">Reason</div>
                ) : null}
              </div>

              {filteredRows.map((row, index) => {
                const tone = rowTone(row);
                const isExpanded = expanded.has(row.hrId);
                const lineCount = detailCount(row);
                return (
                  <div key={row.hrId}>
                  <div
                    className={cn(
                      "grid items-center gap-x-3 border-b border-slate-200 px-3 py-2 transition-colors hover:bg-slate-100/70",
                      tone === "hold" && "bg-rose-50 hover:bg-rose-50",
                      tone === "conflict" && "border-l-4 border-l-orange-400 bg-orange-50 hover:bg-orange-50",
                      tone === "notice" && "border-l-4 border-l-sky-400 bg-sky-50/70 hover:bg-sky-50",
                      tone === "leaver" && "bg-red-50 hover:bg-red-50",
                      !tone && (index % 2 ? "bg-slate-50/60" : "bg-white"),
                    )}
                    style={{ gridTemplateColumns: template }}
                  >
                    {hasDetail ? (
                      lineCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(row.hrId)}
                          aria-expanded={isExpanded}
                          aria-label={`${isExpanded ? "Hide" : "Show"} the ${detailLabel(row)} behind ${row.fullName}'s figure`}
                          className="flex size-5 items-center justify-center text-slate-400 transition hover:text-orange-600"
                        >
                          {isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      ) : (
                        <div aria-hidden />
                      )
                    ) : null}
                    <div className="overflow-hidden font-mono text-xs text-slate-500">
                      <span className="whitespace-nowrap">{row.hrId}</span>
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                      <span
                        className={cn(
                          "overflow-hidden whitespace-nowrap",
                          tone === "hold" ? "font-semibold text-rose-700" : "text-slate-800",
                        )}
                      >
                        {row.fullName}
                      </span>
                      {tone === "hold" ? <Badge variant="danger" className="shrink-0">HOLD</Badge> : null}
                      {tone === "conflict" ? <Badge variant="warning" className="shrink-0">Already settled</Badge> : null}
                      {row.readOnly ? (
                        <Badge variant="neutral" className="shrink-0" title={row.readOnlyNote}>
                          Notice period
                        </Badge>
                      ) : null}
                      {hasDetail && lineCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(row.hrId)}
                          className="shrink-0 whitespace-nowrap text-xs font-medium text-orange-600 underline-offset-2 hover:underline"
                        >
                          {detailLabel(row)}
                        </button>
                      ) : null}
                    </div>
                    {definition.contextColumns.map((column) => (
                      <div key={column.key} className="overflow-hidden text-right text-slate-600">
                        <span className="whitespace-nowrap">{String(row.context[column.key] ?? "")}</span>
                      </div>
                    ))}
                    {definition.isHoldStep ? (
                      <div className="flex justify-center">
                        {locked ? (
                          <span className={row.onHold ? "font-semibold text-rose-700" : "text-slate-400"}>
                            {row.onHold ? "Held" : "—"}
                          </span>
                        ) : (
                          <Switch checked={row.onHold} onChange={(value) => setHold(row.hrId, value)} />
                        )}
                      </div>
                    ) : null}
                    {definition.fields.map((field) =>
                      field.kind === "text" ? (
                        <Input
                          key={field.key}
                          value={row.reasons?.[field.key] ?? ""}
                          disabled={isRowLocked(row)}
                          placeholder="Reason (optional)"
                          onChange={(event) => setFieldReason(row.hrId, field.key, event.target.value)}
                          className={fieldClassName}
                        />
                      ) : field.kind === "select" ? (
                        <select
                          key={field.key}
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
                          key={field.key}
                          type="number"
                          value={String(row.values[field.key] ?? 0)}
                          disabled={isRowLocked(row)}
                          onChange={(event) => {
                            const raw = Number(event.target.value) || 0;
                            if (field.kind === "days" && field.complementFieldKey) {
                              setComplementaryDaysValue(row.hrId, field.key, field.complementFieldKey, field.complementTotalContextKey, raw);
                            } else if (field.kind === "days") {
                              setDaysValue(row.hrId, field.key, field.autoCalcMoneyKey, raw, field.autoCalcDivisorContextKey);
                            } else {
                              setValue(row.hrId, field.key, raw);
                            }
                            }}
                          className={cn(fieldClassName, "text-right")}
                        />
                      ),
                    )}
                    {definition.hasReason ? (
                      <Input
                        value={row.reason ?? ""}
                        disabled={isRowLocked(row)}
                        placeholder="Reason"
                        onChange={(event) => setReason(row.hrId, event.target.value)}
                        className={fieldClassName}
                      />
                    ) : null}
                  </div>
                  {isExpanded ? <DetailPanel definition={definition} row={row} /> : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mobile: one stacked card per employee — never horizontal-scrolls a table. */}
          <div className="flex flex-col gap-2 md:hidden">
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
                      <div className="font-mono text-xs text-slate-500">{row.hrId}</div>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      {tone === "hold" ? <Badge variant="danger">HOLD</Badge> : null}
                      {tone === "conflict" ? <Badge variant="warning">Already settled</Badge> : null}
                      {row.readOnly ? <Badge variant="neutral">Notice period</Badge> : null}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    {definition.contextColumns.map((column) => (
                      <div key={column.key} className="flex items-center justify-between gap-3 text-sm">
                        <span className="overflow-hidden whitespace-nowrap text-slate-500">{column.label}</span>
                        <span className="shrink-0 overflow-hidden whitespace-nowrap font-medium text-slate-700">
                          {String(row.context[column.key] ?? "")}
                        </span>
                      </div>
                    ))}

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
                                setDaysValue(row.hrId, field.key, field.autoCalcMoneyKey, raw, field.autoCalcDivisorContextKey);
                              } else {
                                setValue(row.hrId, field.key, raw);
                              }
                              }}
                            className={fieldClassName}
                          />
                        )}
                      </label>
                    ))}

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
                        {/* Mobile keeps the repo's card idiom rather than shrinking the
                            desktop table: one mini-card per line, label/value stacked,
                            so nothing has to be truncated or side-scrolled. */}
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
            {confirmed ? "Re-confirm & continue" : "Confirm & continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
