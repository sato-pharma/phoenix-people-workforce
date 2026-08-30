"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  NonEmployeePart,
  RecurringNonEmployeeInput,
  RecurringNonEmployeeRow,
} from "@/lib/automated-payroll/types";
import { cn } from "@/lib/utils";

type Props = {
  /** Refreshed after a change so the caller can offer a re-sync. Must be referentially stable. */
  onChanged?: () => void;
};

const fieldClassName =
  "h-9 border-slate-300 bg-white text-sm transition focus-visible:border-orange-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/20";

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const emptyDraft: RecurringNonEmployeeInput = {
  fullNameAr: "",
  fullNameEn: "",
  totalSalary: 0,
  bankName: "",
  bankAccount: "",
  part: "first",
  active: true,
};

type NewRow = RecurringNonEmployeeInput & { tempId: string };

function partLabel(part: NonEmployeePart): string {
  return part === "first" ? "Part 1" : "Part 2";
}

/**
 * The STANDING Non-Employees Payroll roster (owner request 2026-08-30).
 *
 * Edited once, not every month: each new run copies the active entries into its
 * own list automatically. Deliberately NOT locked by run phase — the register
 * belongs to no run, and an edit here reaches only months seeded after it, never
 * one already built. That is the single thing this panel has to make obvious,
 * because "I changed the amount and last month didn't move" is otherwise read as
 * a bug rather than the safety property it is.
 */
export function RecurringNonEmployeesPanel({ onChanged }: Props) {
  const [rows, setRows] = useState<RecurringNonEmployeeRow[]>([]);
  const [edits, setEdits] = useState<Record<string, RecurringNonEmployeeInput>>({});
  const [newRows, setNewRows] = useState<NewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/automated-payroll/non-employee-recurring");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load the standing roster.");
      const loaded = data.rows as RecurringNonEmployeeRow[];
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
              part: row.part,
              active: row.active,
            },
          ]),
        ),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the standing roster.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const setEditField = (
    id: string,
    field: keyof RecurringNonEmployeeInput,
    value: string | number | boolean,
  ) => {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const afterWrite = async () => {
    await load();
    onChanged?.();
  };

  const saveExisting = async (id: string) => {
    const draft = edits[id];
    if (!draft) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/non-employee-recurring/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      await afterWrite();
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
      const res = await fetch(`/api/automated-payroll/non-employee-recurring/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to remove.");
      await afterWrite();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to remove.");
    } finally {
      setBusyId(null);
    }
  };

  const addNewRowSlot = () => {
    setNewRows((prev) => [...prev, { ...emptyDraft, tempId: `new-${Date.now()}-${prev.length}` }]);
  };

  const setNewRowField = (
    tempId: string,
    field: keyof RecurringNonEmployeeInput,
    value: string | number | boolean,
  ) => {
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
      const res = await fetch("/api/automated-payroll/non-employee-recurring", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add.");
      setNewRows((prev) => prev.filter((row) => row.tempId !== tempId));
      await afterWrite();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add.");
    } finally {
      setBusyId(null);
    }
  };

  const activeRows = rows.filter((row) => row.active);
  const monthlyTotal = activeRows.reduce((sum, row) => sum + row.totalSalary, 0);

  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading the standing roster…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-black tracking-tight text-slate-900">
          Standing list — added to every month automatically
        </h3>
        <p className="mt-0.5 text-sm text-slate-500">
          Everyone here is copied into each new payroll run on its own, with these amounts and bank details — no
          re-typing. Editing this list changes future months only: a month already open or published keeps whatever it
          was built with. Switch someone off instead of removing them to keep their history readable.
        </p>
      </div>

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}

      <div className="hidden overflow-x-auto border border-slate-200 md:block">
        <div>
          <div className="grid grid-cols-[1.3fr_1.3fr_1fr_1fr_0.8fr_0.7fr_0.6fr_auto] items-center gap-x-3 bg-slate-900 px-3 py-2.5">
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Full Name (EN)</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Full Name (AR)</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Bank Name</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Bank Account</div>
            <div className="text-right text-phx-xs font-bold uppercase tracking-wide text-slate-300">Total Salary</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Paid With</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Status</div>
            <div className="text-phx-xs font-bold uppercase tracking-wide text-slate-300">Actions</div>
          </div>

          {rows.map((row, index) => {
            const draft = edits[row.id] ?? emptyDraft;
            return (
              <div
                key={row.id}
                className={cn(
                  "grid grid-cols-[1.3fr_1.3fr_1fr_1fr_0.8fr_0.7fr_0.6fr_auto] items-center gap-x-3 border-b border-slate-200 px-3 py-2",
                  !row.active ? "bg-slate-100/80" : index % 2 ? "bg-slate-50/60" : "bg-white",
                )}
              >
                <Input
                  value={draft.fullNameEn}
                  onChange={(event) => setEditField(row.id, "fullNameEn", event.target.value)}
                  className={fieldClassName}
                />
                <Input
                  value={draft.fullNameAr}
                  dir="rtl"
                  onChange={(event) => setEditField(row.id, "fullNameAr", event.target.value)}
                  className={fieldClassName}
                />
                <Input
                  value={draft.bankName ?? ""}
                  onChange={(event) => setEditField(row.id, "bankName", event.target.value)}
                  className={fieldClassName}
                />
                <Input
                  value={draft.bankAccount ?? ""}
                  onChange={(event) => setEditField(row.id, "bankAccount", event.target.value)}
                  className={fieldClassName}
                />
                <Input
                  type="number"
                  value={String(draft.totalSalary)}
                  onChange={(event) => setEditField(row.id, "totalSalary", Number(event.target.value) || 0)}
                  className={cn(fieldClassName, "text-right")}
                />
                <select
                  value={draft.part ?? "first"}
                  onChange={(event) => setEditField(row.id, "part", event.target.value)}
                  className={cn(fieldClassName, "w-full px-2")}
                >
                  <option value="first">Part 1</option>
                  <option value="second">Part 2</option>
                </select>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={draft.active !== false}
                    onChange={(event) => setEditField(row.id, "active", event.target.checked)}
                    className="size-4 accent-orange-600"
                  />
                  <span className="whitespace-nowrap">{draft.active !== false ? "On" : "Off"}</span>
                </label>
                <div className="flex gap-1.5">
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
                </div>
              </div>
            );
          })}

          {newRows.map((row) => (
            <div
              key={row.tempId}
              className="grid grid-cols-[1.3fr_1.3fr_1fr_1fr_0.8fr_0.7fr_0.6fr_auto] items-center gap-x-3 border-b border-slate-200 bg-orange-50/40 px-3 py-2"
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
              <select
                value={row.part ?? "first"}
                onChange={(event) => setNewRowField(row.tempId, "part", event.target.value)}
                className={cn(fieldClassName, "w-full px-2")}
              >
                <option value="first">Part 1</option>
                <option value="second">Part 2</option>
              </select>
              <span className="whitespace-nowrap text-xs text-slate-500">On</span>
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
              Nobody on the standing list yet — anyone added here joins every future month automatically.
            </div>
          ) : null}
        </div>
      </div>

      {/* Mobile: the admin shell never shows a table on small screens. */}
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((row, index) => {
          const draft = edits[row.id] ?? emptyDraft;
          return (
            <div
              key={row.id}
              className={cn("border border-slate-200 p-3", row.active ? "bg-white" : "bg-slate-100/80")}
            >
              <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
                <span className="text-xs font-semibold text-slate-500">
                  Entry {index + 1} · {partLabel(draft.part ?? "first")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === row.id}
                  onClick={() => void deleteExisting(row.id)}
                  className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Full Name (EN)</span>
                  <Input
                    value={draft.fullNameEn}
                    onChange={(event) => setEditField(row.id, "fullNameEn", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Full Name (AR)</span>
                  <Input
                    value={draft.fullNameAr}
                    dir="rtl"
                    onChange={(event) => setEditField(row.id, "fullNameAr", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Bank Name</span>
                  <Input
                    value={draft.bankName ?? ""}
                    onChange={(event) => setEditField(row.id, "bankName", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Bank Account</span>
                  <Input
                    value={draft.bankAccount ?? ""}
                    onChange={(event) => setEditField(row.id, "bankAccount", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Total Salary</span>
                  <Input
                    type="number"
                    value={String(draft.totalSalary)}
                    onChange={(event) => setEditField(row.id, "totalSalary", Number(event.target.value) || 0)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-500">Paid With</span>
                  <select
                    value={draft.part ?? "first"}
                    onChange={(event) => setEditField(row.id, "part", event.target.value)}
                    className={cn(fieldClassName, "px-2")}
                  >
                    <option value="first">Part 1</option>
                    <option value="second">Part 2</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={draft.active !== false}
                    onChange={(event) => setEditField(row.id, "active", event.target.checked)}
                    className="size-4 accent-orange-600"
                  />
                  <span>Added to every new month</span>
                </label>
                <Button
                  size="sm"
                  disabled={busyId === row.id}
                  onClick={() => void saveExisting(row.id)}
                  className="self-start border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                >
                  Save
                </Button>
              </div>
            </div>
          );
        })}

        {newRows.map((row) => (
          <div key={row.tempId} className="border border-orange-300 bg-orange-50/40 p-3">
            <div className="mb-2 flex items-center justify-between gap-2 border-b border-orange-200 pb-2">
              <span className="text-xs font-semibold text-orange-700">New standing entry</span>
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
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-500">Paid With</span>
                <select
                  value={row.part ?? "first"}
                  onChange={(event) => setNewRowField(row.tempId, "part", event.target.value)}
                  className={cn(fieldClassName, "px-2")}
                >
                  <option value="first">Part 1</option>
                  <option value="second">Part 2</option>
                </select>
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
            Nobody on the standing list yet — anyone added here joins every future month automatically.
          </div>
        ) : null}
      </div>

      <Button variant="outline" onClick={addNewRowSlot} className="self-start">
        + Add someone to every month
      </Button>

      <div className="text-sm text-slate-500">
        {activeRows.length} active of {rows.length} · {money(monthlyTotal)} added to each month
      </div>
    </div>
  );
}
