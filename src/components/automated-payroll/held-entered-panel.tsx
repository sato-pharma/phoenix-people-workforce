"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-kit";
import { phxButtonAccentClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cairoTimeLabel } from "@/lib/automated-payroll/cell-history-labels";
import type {
  EnteredHeldListed,
  HeldEntryEmployee,
  HeldMonthWithoutRoster,
} from "@/lib/automated-payroll/held-settlements";
import { cn } from "@/lib/utils";

type Props = {
  runId: string;
  /** The step is locked (its part is not open): the list shows, nothing can be added or removed. */
  locked: boolean;
  /**
   * The step below has unsaved edits. Adding or removing reloads the step, which would drop them,
   * so both wait until the step is saved.
   */
  stepDirty: boolean;
  /** Called after an add or a remove, so the wizard reloads the step and the person shows there. */
  onChanged: () => void;
};

function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Held in a month that did not record names (owner decision, 2026-11-09: HR types the held amount).
 *
 * July and August 2026 were published before the payroll kept each held person's amount, so the Held
 * Salary Release step below had nobody to release from those months. HR adds the person, the month and
 * the amount here; the step then lists them with that amount outstanding. The rule that the amount only
 * counts for a month that kept the count alone lives in `heldBalancesForRun`, never here.
 */
export function HeldEnteredPanel({ runId, locked, stepDirty, onChanged }: Props) {
  const [months, setMonths] = useState<HeldMonthWithoutRoster[]>([]);
  const [entries, setEntries] = useState<EnteredHeldListed[]>([]);
  const [employees, setEmployees] = useState<HeldEntryEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hrId, setHrId] = useState("");
  const [heldRunId, setHeldRunId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/held-entered`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load the held amounts entered.");
      const loadedMonths = (data.months ?? []) as HeldMonthWithoutRoster[];
      setMonths(loadedMonths);
      setEntries((data.entries ?? []) as EnteredHeldListed[]);
      setEmployees((data.employees ?? []) as HeldEntryEmployee[]);
      setHeldRunId((current) =>
        loadedMonths.some((month) => month.runId === current) ? current : (loadedMonths[0]?.runId ?? ""),
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the held amounts entered.");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const editable = !locked && !stepDirty;
  const amountNumber = Number(amount);
  const canAdd =
    editable && Boolean(hrId) && Boolean(heldRunId) && Number.isFinite(amountNumber) && amountNumber > 0 && note.trim().length > 0;

  const add = async () => {
    if (!canAdd) return;
    setBusy("add");
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/held-entered`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ heldRunId, hrId, amount: amountNumber, note: note.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to record the held amount.");
      setHrId("");
      setAmount("");
      setNote("");
      await load();
      onChanged();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to record the held amount.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: EnteredHeldListed) => {
    const key = `${entry.heldRunId}|${entry.compact}`;
    setBusy(key);
    setError(null);
    try {
      const query = new URLSearchParams({ heldRunId: entry.heldRunId, hrId: entry.hrId });
      const res = await fetch(`/api/automated-payroll/runs/${runId}/held-entered?${query.toString()}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to remove the held amount.");
      await load();
      onChanged();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Failed to remove the held amount.");
    } finally {
      setBusy(null);
    }
  };

  // Nothing to enter against and nothing entered: the panel has no job this month.
  if (!loading && !error && months.length === 0 && entries.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 border border-slate-200 bg-white p-4">
      <div className="min-w-0">
        <h3 className="text-base font-black tracking-tight text-slate-900">Held in a month that did not record names</h3>
        <p className="mt-0.5 text-sm text-slate-500">
          July and August 2026 were published before the payroll kept each held person&apos;s amount. Add the person, the
          month and the amount held, and they appear below to release.
        </p>
      </div>

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
      {locked ? (
        <div className="border-l-4 border-slate-300 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          Read-only — this step is not open.
        </div>
      ) : stepDirty ? (
        <div className="border-l-4 border-amber-400 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          Save the changes on the step below first — adding or removing a held amount reloads it.
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-slate-500">Loading held amounts…</div>
      ) : (
        <>
          {!locked && months.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] md:items-end">
              <FormField label="Employee" required>
                <SearchableSelect
                  value={hrId}
                  onValueChange={setHrId}
                  disabled={!editable}
                  placeholder="Search by name"
                  noResultsText="No employee matches"
                  aria-label="Employee"
                >
                  <option value="">Choose the employee</option>
                  {employees.map((employee) => (
                    <option key={employee.compact} value={employee.hrId}>
                      {employee.status && !/^active$/i.test(employee.status)
                        ? `${employee.name} (${employee.status.replace(/_/g, " ")})`
                        : employee.name}
                    </option>
                  ))}
                </SearchableSelect>
              </FormField>
              <FormField label="Month held" required>
                <select
                  value={heldRunId}
                  disabled={!editable}
                  onChange={(event) => setHeldRunId(event.target.value)}
                  className={phxSelectClassName}
                  aria-label="Month held"
                >
                  {months.map((month) => (
                    <option key={month.runId} value={month.runId}>
                      {month.label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Amount held" required>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={amount}
                  disabled={!editable}
                  onChange={(event) => setAmount(event.target.value)}
                  className="text-right"
                  aria-label="Amount held"
                />
              </FormField>
              <FormField label="Note" required>
                <Input
                  value={note}
                  disabled={!editable}
                  placeholder="Where the amount comes from"
                  onChange={(event) => setNote(event.target.value)}
                  aria-label="Note"
                />
              </FormField>
              <button
                type="button"
                disabled={!canAdd || busy !== null}
                onClick={() => void add()}
                className={cn(phxButtonAccentClassName, "justify-center")}
              >
                {busy === "add" ? "Adding…" : "Add"}
              </button>
            </div>
          ) : null}

          {entries.length > 0 ? (
            <>
              {/* Desktop: a fixed table that fits its width — long names and notes wrap, never scroll. */}
              <table className="hidden w-full table-fixed border border-slate-200 text-sm md:table">
                <colgroup>
                  <col className="w-[26%]" />
                  <col className="w-[14%]" />
                  <col className="w-[13%]" />
                  <col />
                  <col className="w-[20%]" />
                  <col className="w-12" />
                </colgroup>
                <thead className="bg-slate-900">
                  <tr>
                    {["Employee", "Month held", "Amount held", "Note", "Entered by"].map((label) => (
                      <th
                        key={label}
                        className={cn(
                          "px-3 py-2 text-left text-phx-xs font-bold uppercase tracking-wide text-slate-300",
                          label === "Amount held" && "text-right",
                        )}
                      >
                        {label}
                      </th>
                    ))}
                    <th className="px-3 py-2">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => {
                    const key = `${entry.heldRunId}|${entry.compact}`;
                    return (
                      <tr key={key} className={cn("border-b border-slate-200 align-top", index % 2 ? "bg-slate-50/60" : "bg-white")}>
                        <td className="break-words px-3 py-2 font-semibold text-slate-900">{entry.name}</td>
                        <td className="break-words px-3 py-2 text-slate-700">{entry.monthLabel}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900">{money(entry.amount)}</td>
                        <td className="break-words px-3 py-2 text-slate-700">{entry.note}</td>
                        <td className="break-words px-3 py-2 text-slate-500">
                          {entry.recordedByName}
                          <span className="block text-phx-xs">{cairoTimeLabel(entry.updatedAt)}</span>
                        </td>
                        <td className="px-1 py-1.5 text-right">
                          {!locked ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={!editable || busy !== null}
                              onClick={() => void remove(entry)}
                              aria-label={`Remove ${entry.name}'s ${entry.monthLabel} held amount`}
                              className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Mobile: cards, as every admin table does on a phone. */}
              <div className="flex flex-col gap-2 md:hidden">
                {entries.map((entry) => {
                  const key = `${entry.heldRunId}|${entry.compact}`;
                  return (
                    <div key={key} className="border border-slate-200 bg-white">
                      <div className="flex items-start justify-between gap-2 border-b border-slate-200 bg-slate-900 px-3 py-2">
                        <span className="min-w-0 break-words text-sm font-black tracking-tight text-white">{entry.name}</span>
                        {!locked ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!editable || busy !== null}
                            onClick={() => void remove(entry)}
                            aria-label={`Remove ${entry.name}'s ${entry.monthLabel} held amount`}
                            className="shrink-0 text-slate-400 hover:bg-white/10 hover:text-rose-400"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                      </div>
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 text-sm">
                        <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Month held</dt>
                        <dd className="break-words text-slate-800">{entry.monthLabel}</dd>
                        <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Amount held</dt>
                        <dd className="font-semibold tabular-nums text-slate-900">{money(entry.amount)}</dd>
                        <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Note</dt>
                        <dd className="break-words text-slate-800">{entry.note}</dd>
                        <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Entered by</dt>
                        <dd className="break-words text-slate-600">
                          {entry.recordedByName} · {cairoTimeLabel(entry.updatedAt)}
                        </dd>
                      </dl>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-400">No held amounts entered yet.</div>
          )}
        </>
      )}
    </div>
  );
}
