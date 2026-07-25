"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  enteredOnThisStepAmount,
  hasDoubleDeductionConflict,
} from "@/lib/automated-payroll/conflicts";
import { stepDefinition } from "@/lib/automated-payroll/step-definitions";
import type {
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

export function RecommendationStep({ runId, stepKey, confirmed, locked, onConfirmed }: Props) {
  const definition = stepDefinition(stepKey);
  const [rows, setRows] = useState<StepRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<StepImportPreview | null>(null);
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/steps/${stepKey}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load step.");
      setRows(data.rows as StepRow[]);
      setDirty(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load step.");
    } finally {
      setLoading(false);
    }
  }, [runId, stepKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const toEdits = useCallback((): StepEditInput[] => {
    return rows.map((row) => ({
      hrId: row.hrId,
      values: row.values,
      reasons: row.reasons,
      selects: row.selects,
      reason: row.reason,
      onHold: row.onHold,
    }));
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

  /** Editing a "days" field auto-calculates its paired money field via Base Salary/30 × days. */
  const setDaysValue = (hrId: string, field: string, autoCalcMoneyKey: string | undefined, days: number) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.hrId !== hrId) return row;
        const values = { ...row.values, [field]: days };
        if (autoCalcMoneyKey) {
          const baseSalary = Number(row.context["Base Salary"] ?? 0);
          values[autoCalcMoneyKey] = Math.round(((baseSalary / 30) * days + Number.EPSILON) * 100) / 100;
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
  const rowTone = (row: StepRow): "hold" | "conflict" | "leaver" | null => {
    if (row.onHold) return "hold";
    if (hasConflict(row)) return "conflict";
    if (row.lifecycle === "leaver") return "leaver";
    return null;
  };

  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading {definition.title}…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black tracking-tight text-slate-900">{definition.title}</h3>
          <p className="mt-0.5 text-sm text-slate-500">{definition.subtitle}</p>
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
                return (
                  <div
                    key={row.hrId}
                    className={cn(
                      "grid items-center gap-x-3 border-b border-slate-200 px-3 py-2 transition-colors hover:bg-slate-100/70",
                      tone === "hold" && "bg-rose-50 hover:bg-rose-50",
                      tone === "conflict" && "border-l-4 border-l-orange-400 bg-orange-50 hover:bg-orange-50",
                      tone === "leaver" && "bg-red-50 hover:bg-red-50",
                      !tone && (index % 2 ? "bg-slate-50/60" : "bg-white"),
                    )}
                    style={{ gridTemplateColumns: template }}
                  >
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
                          disabled={locked}
                          placeholder="Reason (optional)"
                          onChange={(event) => setFieldReason(row.hrId, field.key, event.target.value)}
                          className={fieldClassName}
                        />
                      ) : field.kind === "select" ? (
                        <select
                          key={field.key}
                          value={row.selects?.[field.key] ?? field.options?.[0]?.value ?? ""}
                          disabled={locked}
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
                          disabled={locked}
                          onChange={(event) =>
                            field.kind === "days"
                              ? setDaysValue(row.hrId, field.key, field.autoCalcMoneyKey, Number(event.target.value) || 0)
                              : setValue(row.hrId, field.key, Number(event.target.value) || 0)
                          }
                          className={cn(fieldClassName, "text-right")}
                        />
                      ),
                    )}
                    {definition.hasReason ? (
                      <Input
                        value={row.reason ?? ""}
                        disabled={locked}
                        placeholder="Reason"
                        onChange={(event) => setReason(row.hrId, event.target.value)}
                        className={fieldClassName}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mobile: one stacked card per employee — never horizontal-scrolls a table. */}
          <div className="flex flex-col gap-2 md:hidden">
            {filteredRows.map((row) => {
              const tone = rowTone(row);
              return (
                <div
                  key={row.hrId}
                  className={cn(
                    "border border-slate-200 bg-white p-3",
                    tone === "hold" && "border-rose-200 bg-rose-50",
                    tone === "conflict" && "border-l-4 border-l-orange-400 bg-orange-50",
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
                            disabled={locked}
                            placeholder="Reason (optional)"
                            onChange={(event) => setFieldReason(row.hrId, field.key, event.target.value)}
                            className={fieldClassName}
                          />
                        ) : field.kind === "select" ? (
                          <select
                            value={row.selects?.[field.key] ?? field.options?.[0]?.value ?? ""}
                            disabled={locked}
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
                            disabled={locked}
                            onChange={(event) =>
                              field.kind === "days"
                                ? setDaysValue(row.hrId, field.key, field.autoCalcMoneyKey, Number(event.target.value) || 0)
                                : setValue(row.hrId, field.key, Number(event.target.value) || 0)
                            }
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
                          disabled={locked}
                          placeholder="Reason"
                          onChange={(event) => setReason(row.hrId, event.target.value)}
                          className={fieldClassName}
                        />
                      </label>
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
