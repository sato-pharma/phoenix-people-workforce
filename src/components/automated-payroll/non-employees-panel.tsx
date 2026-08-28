"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  NonEmployeePart,
  NonEmployeePayrollInput,
  NonEmployeePayrollRow,
} from "@/lib/automated-payroll/types";
import { cn } from "@/lib/utils";

type Props = {
  runId: string;
  /** Which installment's list this panel edits (owner request 2026-08-03). */
  part: NonEmployeePart;
  locked: boolean;
  /** Must be referentially stable — the loader below depends on it. */
  onChange?: (part: NonEmployeePart, count: number) => void;
};

const fieldClassName =
  "h-9 border-slate-300 bg-white text-sm transition focus-visible:border-orange-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/20";

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const emptyDraft: NonEmployeePayrollInput = {
  fullNameAr: "",
  fullNameEn: "",
  totalSalary: 0,
  bankName: "",
  bankAccount: "",
};

type NewRow = NonEmployeePayrollInput & { tempId: string };

/**
 * Non-Employees Payroll (owner rule 2026-07-25): people paid a monthly salary
 * with no employee/HR_ID record at all — a free-form, HR-authored list per run.
 * Deliberately NOT the generic RecommendationStep grid: there is no population
 * to recommend against, just direct add/edit/delete.
 *
 * One panel per installment (owner request 2026-08-03). Each list only ever
 * loads, adds to and edits its own `part`, and locks the same moment that part's
 * own wizard tabs lock — so the two can never overwrite each other and a Part 1
 * entry can't be edited after Part 1 has been executed.
 */
export function NonEmployeesPanel({ runId, part, locked, onChange }: Props) {
  const [rows, setRows] = useState<NonEmployeePayrollRow[]>([]);
  const [edits, setEdits] = useState<Record<string, NonEmployeePayrollInput>>({});
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/non-employees?part=${part}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load Non-Employees Payroll.");
      const loaded = data.rows as NonEmployeePayrollRow[];
      setRows(loaded);
      setEdits(
        Object.fromEntries(
          loaded.map((row) => [
            row.id,
            {
              fullNameAr: row.fullNameAr,
              fullNameEn: row.fullNameEn,
              totalSalary: row.totalSalary,
              bankName: row.bankName ?? "",
              bankAccount: row.bankAccount ?? "",
            },
          ]),
        ),
      );
      onChange?.(part, loaded.length);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load Non-Employees Payroll.");
    } finally {
      setLoading(false);
    }
  }, [runId, part, onChange]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const setEditField = (id: string, field: keyof NonEmployeePayrollInput, value: string | number) => {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const saveExisting = async (id: string) => {
    const draft = edits[id];
    if (!draft) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/non-employees/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, part }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save.");
    } finally {
      setBusyId(null);
    }
  };

  const deleteExisting = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/non-employees/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to delete.");
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete.");
    } finally {
      setBusyId(null);
    }
  };

  const addNewRowSlot = () => {
    setNewRows((prev) => [...prev, { ...emptyDraft, tempId: `new-${Date.now()}-${prev.length}` }]);
  };

  const setNewRowField = (tempId: string, field: keyof NonEmployeePayrollInput, value: string | number) => {
    setNewRows((prev) => prev.map((row) => (row.tempId === tempId ? { ...row, [field]: value } : row)));
  };

  const discardNewRow = (tempId: string) => {
    setNewRows((prev) => prev.filter((row) => row.tempId !== tempId));
  };

  const saveNewRow = async (tempId: string) => {
    const draft = newRows.find((row) => row.tempId === tempId);
    if (!draft) return;
    setBusyId(tempId);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/non-employees`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, part }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add.");
      setNewRows((prev) => prev.filter((row) => row.tempId !== tempId));
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add.");
    } finally {
      setBusyId(null);
    }
  };

  const total =
    rows.reduce((sum, row) => sum + row.totalSalary, 0) +
    newRows.reduce((sum, row) => sum + (Number(row.totalSalary) || 0), 0);

  const partLabel = part === "first" ? "Part 1" : "Part 2";

  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading {partLabel} Non-Employees Payroll…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-black tracking-tight text-slate-900">
          Non-Employees Payroll — {partLabel}
        </h3>
        <p className="mt-0.5 text-sm text-slate-500">
          People paid a monthly salary with no employee record in the system — entered fresh each run. Everyone listed
          here is paid with {partLabel}, counted into the {partLabel} sheet&apos;s total and its FAB/CIB bank file. No
          deductions or additions. {part === "first" ? "Part 2" : "Part 1"} has its own separate list.
        </p>
      </div>

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
      {locked ? (
        <div className="border-l-4 border-slate-300 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          Read-only — this can only be edited while {partLabel} is open.
        </div>
      ) : null}

      <div className="hidden overflow-x-auto border border-slate-200 md:block">
        <div>
          <div className="grid grid-cols-[1.3fr_1.3fr_1fr_1fr_0.9fr_auto] items-center gap-x-3 bg-slate-900 px-3 py-2.5">
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Full Name (EN)</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Full Name (AR)</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Bank Name</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Bank Account</div>
            <div className="text-right text-phx-xs font-bold uppercase tracking-wide text-slate-300">Total Salary</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Actions</div>
          </div>

          {rows.map((row, index) => {
            const draft = edits[row.id] ?? emptyDraft;
            return (
              <div
                key={row.id}
                className={cn(
                  "grid grid-cols-[1.3fr_1.3fr_1fr_1fr_0.9fr_auto] items-center gap-x-3 border-b border-slate-200 px-3 py-2",
                  index % 2 ? "bg-slate-50/60" : "bg-white",
                )}
              >
                <Input
                  value={draft.fullNameEn}
                  disabled={locked}
                  onChange={(event) => setEditField(row.id, "fullNameEn", event.target.value)}
                  className={fieldClassName}
                />
                <Input
                  value={draft.fullNameAr}
                  disabled={locked}
                  dir="rtl"
                  onChange={(event) => setEditField(row.id, "fullNameAr", event.target.value)}
                  className={fieldClassName}
                />
                <Input
                  value={draft.bankName ?? ""}
                  disabled={locked}
                  onChange={(event) => setEditField(row.id, "bankName", event.target.value)}
                  className={fieldClassName}
                />
                <Input
                  value={draft.bankAccount ?? ""}
                  disabled={locked}
                  onChange={(event) => setEditField(row.id, "bankAccount", event.target.value)}
                  className={fieldClassName}
                />
                <Input
                  type="number"
                  value={String(draft.totalSalary)}
                  disabled={locked}
                  onChange={(event) => setEditField(row.id, "totalSalary", Number(event.target.value) || 0)}
                  className={cn(fieldClassName, "text-right")}
                />
                <div className="flex gap-1.5">
                  {!locked ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => void saveExisting(row.id)}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === row.id}
                        onClick={() => void deleteExisting(row.id)}
                        className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}

          {newRows.map((row) => (
            <div
              key={row.tempId}
              className="grid grid-cols-[1.3fr_1.3fr_1fr_1fr_0.9fr_auto] items-center gap-x-3 border-b border-slate-200 bg-orange-50/40 px-3 py-2"
            >
              <Input
                value={row.fullNameEn}
                placeholder="Full name (English)"
                onChange={(event) => setNewRowField(row.tempId, "fullNameEn", event.target.value)}
                className={fieldClassName}
              />
              <Input
                value={row.fullNameAr}
                placeholder="الاسم بالعربية"
                dir="rtl"
                onChange={(event) => setNewRowField(row.tempId, "fullNameAr", event.target.value)}
                className={fieldClassName}
              />
              <Input
                value={row.bankName ?? ""}
                placeholder="Bank Name"
                onChange={(event) => setNewRowField(row.tempId, "bankName", event.target.value)}
                className={fieldClassName}
              />
              <Input
                value={row.bankAccount ?? ""}
                placeholder="Bank Account"
                onChange={(event) => setNewRowField(row.tempId, "bankAccount", event.target.value)}
                className={fieldClassName}
              />
              <Input
                type="number"
                value={String(row.totalSalary)}
                onChange={(event) => setNewRowField(row.tempId, "totalSalary", Number(event.target.value) || 0)}
                className={cn(fieldClassName, "text-right")}
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  disabled={busyId === row.tempId}
                  onClick={() => void saveNewRow(row.tempId)}
                  className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                >
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => discardNewRow(row.tempId)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}

          {rows.length === 0 && newRows.length === 0 ? (
            <div className="border-b border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
              No {partLabel} non-employees this month.
            </div>
          ) : null}
        </div>
      </div>

      {/* Mobile: the admin shell never shows a table on small screens — same rule
          RecommendationStep already follows for the 16 step grids. */}
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((row, index) => {
          const draft = edits[row.id] ?? emptyDraft;
          return (
            <div key={row.id} className="border border-slate-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
                <span className="text-xs font-semibold text-slate-500">Entry {index + 1}</span>
                {!locked ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === row.id}
                    onClick={() => void deleteExisting(row.id)}
                    className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Full Name (EN)</span>
                  <Input
                    value={draft.fullNameEn}
                    disabled={locked}
                    onChange={(event) => setEditField(row.id, "fullNameEn", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Full Name (AR)</span>
                  <Input
                    value={draft.fullNameAr}
                    disabled={locked}
                    dir="rtl"
                    onChange={(event) => setEditField(row.id, "fullNameAr", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Bank Name</span>
                  <Input
                    value={draft.bankName ?? ""}
                    disabled={locked}
                    onChange={(event) => setEditField(row.id, "bankName", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Bank Account</span>
                  <Input
                    value={draft.bankAccount ?? ""}
                    disabled={locked}
                    onChange={(event) => setEditField(row.id, "bankAccount", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Total Salary</span>
                  <Input
                    type="number"
                    value={String(draft.totalSalary)}
                    disabled={locked}
                    onChange={(event) => setEditField(row.id, "totalSalary", Number(event.target.value) || 0)}
                    className={fieldClassName}
                  />
                </label>
                {!locked ? (
                  <Button
                    size="sm"
                    disabled={busyId === row.id}
                    onClick={() => void saveExisting(row.id)}
                    className="self-start border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                  >
                    Save
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}

        {newRows.map((row) => (
          <div key={row.tempId} className="border border-orange-300 bg-orange-50/40 p-3">
            <div className="mb-2 flex items-center justify-between gap-2 border-b border-orange-200 pb-2">
              <span className="text-xs font-semibold text-orange-700">New entry</span>
              <Button size="sm" variant="ghost" onClick={() => discardNewRow(row.tempId)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">Full Name (EN)</span>
                <Input
                  value={row.fullNameEn}
                  placeholder="Full name (English)"
                  onChange={(event) => setNewRowField(row.tempId, "fullNameEn", event.target.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">Full Name (AR)</span>
                <Input
                  value={row.fullNameAr}
                  placeholder="الاسم بالعربية"
                  dir="rtl"
                  onChange={(event) => setNewRowField(row.tempId, "fullNameAr", event.target.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">Bank Name</span>
                <Input
                  value={row.bankName ?? ""}
                  placeholder="Bank Name"
                  onChange={(event) => setNewRowField(row.tempId, "bankName", event.target.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">Bank Account</span>
                <Input
                  value={row.bankAccount ?? ""}
                  placeholder="Bank Account"
                  onChange={(event) => setNewRowField(row.tempId, "bankAccount", event.target.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">Total Salary</span>
                <Input
                  type="number"
                  value={String(row.totalSalary)}
                  onChange={(event) => setNewRowField(row.tempId, "totalSalary", Number(event.target.value) || 0)}
                  className={fieldClassName}
                />
              </label>
              <Button
                size="sm"
                disabled={busyId === row.tempId}
                onClick={() => void saveNewRow(row.tempId)}
                className="self-start border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
              >
                Add
              </Button>
            </div>
          </div>
        ))}

        {rows.length === 0 && newRows.length === 0 ? (
          <div className="border border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
            No {partLabel} non-employees this month.
          </div>
        ) : null}
      </div>

      {!locked ? (
        <Button variant="outline" onClick={addNewRowSlot} className="self-start">
          + Add one more
        </Button>
      ) : null}

      <div className="text-sm text-slate-500">
        {rows.length + newRows.length} {rows.length + newRows.length === 1 ? "entry" : "entries"} · total{" "}
        {money(total)}
      </div>
    </div>
  );
}
