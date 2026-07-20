"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { stepDefinition } from "@/lib/automated-payroll/step-definitions";
import type {
  StepEditInput,
  StepImportPreview,
  StepKey,
  StepRow,
} from "@/lib/automated-payroll/types";

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

export function RecommendationStep({ runId, stepKey, confirmed, locked, onConfirmed }: Props) {
  const definition = stepDefinition(stepKey);
  const [rows, setRows] = useState<StepRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<StepImportPreview | null>(null);
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
      reason: row.reason,
      onHold: row.onHold,
    }));
  }, [rows]);

  const setValue = (index: number, field: string, value: number) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], values: { ...next[index].values, [field]: value } };
      return next;
    });
    setDirty(true);
  };

  const setReason = (index: number, reason: string) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], reason };
      return next;
    });
    setDirty(true);
  };

  const setHold = (index: number, onHold: boolean) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], onHold };
      return next;
    });
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

  const totalPrimary = useMemo(() => {
    const field = definition.fields[0]?.key;
    if (!field) return null;
    return rows.reduce((sum, row) => sum + (row.values[field] ?? 0), 0);
  }, [rows, definition.fields]);

  if (loading) return <div className="p-6 text-sm text-slate-500">Loading {definition.title}…</div>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-black text-slate-900">{definition.title}</h3>
          <p className="text-sm text-slate-500">{definition.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {confirmed ? <Badge variant="success">Confirmed</Badge> : null}
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
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div>
      ) : null}

      {preview ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
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

      <div className="overflow-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <thead>
            <tr className="bg-slate-900 text-left text-xs font-semibold uppercase tracking-wide text-white">
              <th className="px-3 py-2">HR_ID</th>
              <th className="px-3 py-2">Employee</th>
              {definition.contextColumns.map((column) => (
                <th key={column.key} className="px-3 py-2 text-right">{column.label}</th>
              ))}
              {definition.isHoldStep ? <th className="px-3 py-2 text-center">Hold</th> : null}
              {definition.fields.map((field) => (
                <th key={field.key} className="px-3 py-2 text-right">{field.label}</th>
              ))}
              {definition.hasReason ? <th className="px-3 py-2">Reason</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-400">No employees for this step.</td>
              </tr>
            ) : null}
            {rows.map((row, index) => (
              <tr key={row.hrId} className={row.onHold ? "bg-rose-50" : index % 2 ? "bg-slate-50/60" : "bg-white"}>
                <td className="px-3 py-1.5 font-mono text-xs text-slate-600">{row.hrId}</td>
                <td className="px-3 py-1.5">
                  <span className={row.onHold ? "font-semibold text-rose-700" : "text-slate-800"}>{row.fullName}</span>
                  {row.onHold ? <Badge variant="danger" className="ml-2">HOLD</Badge> : null}
                </td>
                {definition.contextColumns.map((column) => (
                  <td key={column.key} className="px-3 py-1.5 text-right text-slate-600">
                    {String(row.context[column.key] ?? "")}
                  </td>
                ))}
                {definition.isHoldStep ? (
                  <td className="px-3 py-1.5 text-center">
                    {locked ? (
                      <span className={row.onHold ? "font-semibold text-rose-700" : "text-slate-400"}>
                        {row.onHold ? "Held" : "—"}
                      </span>
                    ) : (
                      <Switch checked={row.onHold} onChange={(value) => setHold(index, value)} />
                    )}
                  </td>
                ) : null}
                {definition.fields.map((field) => (
                  <td key={field.key} className="px-3 py-1.5 text-right">
                    <Input
                      type="number"
                      value={String(row.values[field.key] ?? 0)}
                      disabled={locked}
                      onChange={(event) => setValue(index, field.key, Number(event.target.value) || 0)}
                      className="h-8 w-28 text-right"
                    />
                  </td>
                ))}
                {definition.hasReason ? (
                  <td className="px-3 py-1.5">
                    <Input
                      value={row.reason ?? ""}
                      disabled={locked}
                      placeholder="Reason"
                      onChange={(event) => setReason(index, event.target.value)}
                      className="h-8 w-48"
                    />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-500">
          {rows.length} employees{totalPrimary != null ? ` · total ${money(totalPrimary)}` : ""}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={locked || busy || !dirty} onClick={() => void save()}>
            Save
          </Button>
          <Button disabled={locked || busy} onClick={() => void confirm()}>
            {confirmed ? "Re-confirm & continue" : "Confirm & continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
