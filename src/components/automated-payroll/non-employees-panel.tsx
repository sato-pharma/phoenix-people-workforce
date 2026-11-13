"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Repeat, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  NonEmployeePart,
  NonEmployeePayrollInput,
  NonEmployeePayrollRow,
} from "@/lib/automated-payroll/types";
import { cn } from "@/lib/utils";

import { RecurringNonEmployeesPanel } from "./recurring-non-employees-panel";

type Props = {
  runId: string;
  /** Which installment's list this panel edits (owner request 2026-08-03). */
  part: NonEmployeePart;
  locked: boolean;
  /** Must be referentially stable — the loader below depends on it. */
  onChange?: (part: NonEmployeePart, count: number) => void;
};

const fieldClassName = "h-9";

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
  const [showStanding, setShowStanding] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

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

  /**
   * Pull the standing roster into this run. A new run already seeds itself at
   * creation, so this covers the two cases that misses: a month opened before
   * the roster existed, and someone added to the roster mid-month.
   *
   * It never overwrites an amount already on the run — an entry copied earlier
   * is left alone, so a figure adjusted for this month specifically survives.
   */
  const syncStandingList = async () => {
    setSyncing(true);
    setError(null);
    setSyncNote(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/non-employees/sync`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to sync the standing list.");
      const inserted = Number(data.inserted ?? 0);
      const skipped = Number(data.skipped ?? 0);
      setSyncNote(
        inserted === 0
          ? `Already up to date — all ${skipped} standing entries are on this run.`
          : `Added ${inserted} ${inserted === 1 ? "person" : "people"} from the standing list${skipped > 0 ? `, ${skipped} already here` : ""}.`,
      );
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Failed to sync the standing list.");
    } finally {
      setSyncing(false);
    }
  };

  const total =
    rows.reduce((sum, row) => sum + row.totalSalary, 0) +
    newRows.reduce((sum, row) => sum + (Number(row.totalSalary) || 0), 0);

  const partLabel = part === "first" ? "Part 1" : "Part 2";
  const fromStandingCount = rows.filter((row) => row.recurringId).length;

  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading {partLabel} Non-Employees Payroll…</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-black tracking-tight text-slate-900">
            Non-Employees Payroll — {partLabel}
          </h3>
          <p className="mt-0.5 text-sm text-slate-500">
            People paid a monthly salary with no employee record in the system. Everyone on the standing list is added
            here automatically when the month opens; anything extra you type in applies to this month only. Everyone
            listed is paid with {partLabel}, counted into the {partLabel} sheet&apos;s total and its FAB/CIB bank file.
            No deductions or additions. {part === "first" ? "Part 2" : "Part 1"} has its own separate list.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowStanding((open) => !open)}
            className="whitespace-nowrap"
          >
            <Repeat className="mr-1.5 size-4" />
            {showStanding ? "Hide standing list" : "Standing list"}
          </Button>
          {!locked ? (
            <Button
              size="sm"
              variant="outline"
              disabled={syncing}
              onClick={() => void syncStandingList()}
              className="whitespace-nowrap"
            >
              <RefreshCw className={cn("mr-1.5 size-4", syncing && "animate-spin")} />
              {syncing ? "Syncing…" : "Sync standing list"}
            </Button>
          ) : null}
        </div>
      </div>

      {showStanding ? (
        <div className="border border-slate-200 bg-slate-50/60 p-4">
          <RecurringNonEmployeesPanel />
        </div>
      ) : null}

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
      {syncNote ? (
        <div className="border-l-4 border-emerald-400 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          {syncNote}
        </div>
      ) : null}
      {locked ? (
        <div className="border-l-4 border-slate-300 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          Read-only — this can only be edited while {partLabel} is open.
        </div>
      ) : null}

      {/* Desktop: a real table, so the admin shell's own black header and orange grid draw it (it was a grid of
          divs with a hand-painted header). Fits by MERGING — the English name over the Arabic, the bank over the
          account — never by a sideways scroll. */}
      <div className="hidden border border-slate-200 md:block">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[30%]" />
            <col className="w-[16%]" />
            <col className="w-[20%]" />
          </colgroup>
          <thead>
            <tr className="text-phx-xs font-bold uppercase tracking-wide">
              <th className="px-3 py-2.5" scope="col">Full Name (EN · AR)</th>
              <th className="px-3 py-2.5" scope="col">Bank Name · Account</th>
              <th className="px-3 py-2.5 text-right" scope="col">Total Salary</th>
              <th className="px-3 py-2.5" scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const draft = edits[row.id] ?? emptyDraft;
              return (
                <tr key={row.id} className={cn("align-top", index % 2 ? "bg-slate-50/60" : "bg-white")}>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1.5">
                      <Input
                        aria-label="Full name (English)"
                        value={draft.fullNameEn}
                        disabled={locked}
                        onChange={(event) => setEditField(row.id, "fullNameEn", event.target.value)}
                        className={fieldClassName}
                      />
                      <Input
                        aria-label="Full name (Arabic)"
                        value={draft.fullNameAr}
                        disabled={locked}
                        dir="rtl"
                        onChange={(event) => setEditField(row.id, "fullNameAr", event.target.value)}
                        className={fieldClassName}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1.5">
                      <Input
                        aria-label="Bank name"
                        value={draft.bankName ?? ""}
                        disabled={locked}
                        onChange={(event) => setEditField(row.id, "bankName", event.target.value)}
                        className={fieldClassName}
                      />
                      <Input
                        aria-label="Bank account"
                        value={draft.bankAccount ?? ""}
                        disabled={locked}
                        onChange={(event) => setEditField(row.id, "bankAccount", event.target.value)}
                        className={fieldClassName}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label="Total salary"
                      type="number"
                      value={String(draft.totalSalary)}
                      disabled={locked}
                      onChange={(event) => setEditField(row.id, "totalSalary", Number(event.target.value) || 0)}
                      className={cn(fieldClassName, "text-right")}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {row.recurringId ? (
                        <span
                          title="From the standing list — added automatically every month"
                          className="flex items-center gap-1 border border-slate-300 bg-white px-1.5 py-0.5 text-phx-xs font-semibold text-slate-600"
                        >
                          <Repeat className="size-3" />
                          Monthly
                        </span>
                      ) : null}
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
                            aria-label="Delete this entry"
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
                  </td>
                </tr>
              );
            })}

            {newRows.map((row) => (
              <tr key={row.tempId} className="bg-orange-50/40 align-top">
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1.5">
                    <Input
                      aria-label="Full name (English)"
                      value={row.fullNameEn}
                      placeholder="Full name (English)"
                      onChange={(event) => setNewRowField(row.tempId, "fullNameEn", event.target.value)}
                      className={fieldClassName}
                    />
                    <Input
                      aria-label="Full name (Arabic)"
                      value={row.fullNameAr}
                      placeholder="الاسم بالعربية"
                      dir="rtl"
                      onChange={(event) => setNewRowField(row.tempId, "fullNameAr", event.target.value)}
                      className={fieldClassName}
                    />
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-1.5">
                    <Input
                      aria-label="Bank name"
                      value={row.bankName ?? ""}
                      placeholder="Bank Name"
                      onChange={(event) => setNewRowField(row.tempId, "bankName", event.target.value)}
                      className={fieldClassName}
                    />
                    <Input
                      aria-label="Bank account"
                      value={row.bankAccount ?? ""}
                      placeholder="Bank Account"
                      onChange={(event) => setNewRowField(row.tempId, "bankAccount", event.target.value)}
                      className={fieldClassName}
                    />
                  </div>
                </td>
                <td className="px-3 py-2">
                  <Input
                    aria-label="Total salary"
                    type="number"
                    value={String(row.totalSalary)}
                    onChange={(event) => setNewRowField(row.tempId, "totalSalary", Number(event.target.value) || 0)}
                    className={cn(fieldClassName, "text-right")}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      disabled={busyId === row.tempId}
                      onClick={() => void saveNewRow(row.tempId)}
                      className="border border-orange-600 bg-orange-600 text-white hover:bg-orange-700"
                    >
                      Add
                    </Button>
                    <Button aria-label="Discard this entry" size="sm" variant="ghost" onClick={() => discardNewRow(row.tempId)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}

          </tbody>
        </table>
        {rows.length === 0 && newRows.length === 0 ? (
          <p className="border-t border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-400">
            No {partLabel} non-employees this month.
          </p>
        ) : null}
      </div>

      {/* Mobile: the admin shell never shows a table on small screens — same rule
          RecommendationStep already follows for the 16 step grids. */}
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((row, index) => {
          const draft = edits[row.id] ?? emptyDraft;
          return (
            <div
              key={row.id}
              className="border border-slate-200 bg-white shadow-sm transition hover:border-slate-300 hover:shadow-md"
            >
              {/* Same dark identity header the per-employee recommendation cards
                  carry, so a non-employee entry reads as the same kind of object
                  rather than a different-looking stray. */}
              <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-900 px-3 py-2">
                <span className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-sm font-black tracking-tight text-white">
                  Entry {index + 1}
                  {row.recurringId ? (
                    <span className="flex items-center gap-1 whitespace-nowrap border border-white/30 bg-white/10 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                      <Repeat className="size-3" />
                      Monthly
                    </span>
                  ) : null}
                </span>
                {!locked ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === row.id}
                    onClick={() => void deleteExisting(row.id)}
                    className="shrink-0 text-slate-400 hover:bg-white/10 hover:text-rose-400"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-col gap-2 p-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Full Name (EN)</span>
                  <Input
                    value={draft.fullNameEn}
                    disabled={locked}
                    onChange={(event) => setEditField(row.id, "fullNameEn", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Full Name (AR)</span>
                  <Input
                    value={draft.fullNameAr}
                    disabled={locked}
                    dir="rtl"
                    onChange={(event) => setEditField(row.id, "fullNameAr", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Bank Name</span>
                  <Input
                    value={draft.bankName ?? ""}
                    disabled={locked}
                    onChange={(event) => setEditField(row.id, "bankName", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Bank Account</span>
                  <Input
                    value={draft.bankAccount ?? ""}
                    disabled={locked}
                    onChange={(event) => setEditField(row.id, "bankAccount", event.target.value)}
                    className={fieldClassName}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Total Salary</span>
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
          <div key={row.tempId} className="border border-orange-300 bg-orange-50/40 shadow-sm">
            {/* An unsaved entry keeps the orange draft tone rather than the dark
                header — it is deliberately not yet one of the saved objects. */}
            <div className="flex items-center justify-between gap-2 border-b border-orange-200 bg-orange-100/70 px-3 py-2">
              <span className="overflow-hidden whitespace-nowrap text-sm font-black tracking-tight text-orange-800">
                New entry
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => discardNewRow(row.tempId)}
                className="shrink-0 text-orange-700 hover:bg-orange-200/60 hover:text-rose-700"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
            <div className="flex flex-col gap-2 p-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Full Name (EN)</span>
                <Input
                  value={row.fullNameEn}
                  placeholder="Full name (English)"
                  onChange={(event) => setNewRowField(row.tempId, "fullNameEn", event.target.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Full Name (AR)</span>
                <Input
                  value={row.fullNameAr}
                  placeholder="الاسم بالعربية"
                  dir="rtl"
                  onChange={(event) => setNewRowField(row.tempId, "fullNameAr", event.target.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Bank Name</span>
                <Input
                  value={row.bankName ?? ""}
                  placeholder="Bank Name"
                  onChange={(event) => setNewRowField(row.tempId, "bankName", event.target.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Bank Account</span>
                <Input
                  value={row.bankAccount ?? ""}
                  placeholder="Bank Account"
                  onChange={(event) => setNewRowField(row.tempId, "bankAccount", event.target.value)}
                  className={fieldClassName}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">Total Salary</span>
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
        {fromStandingCount > 0 ? ` · ${fromStandingCount} from the standing list` : ""}
      </div>
    </div>
  );
}
