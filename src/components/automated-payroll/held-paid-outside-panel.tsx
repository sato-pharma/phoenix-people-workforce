"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-kit";
import { phxButtonAccentClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { Input } from "@/components/ui/input";
import type { HeldBalance } from "@/lib/automated-payroll/held-settlements";
import { monthNameAndYear } from "@/lib/automated-payroll/step-definitions";
import { cn } from "@/lib/utils";

import { formatPayrollMoney } from "./format";

type Props = {
  runId: string;
  /** The step is locked (its part is not open): the list shows, nothing can be recorded or withdrawn. */
  locked: boolean;
  /** The step below has unsaved edits; recording reloads it, which would drop them. */
  stepDirty: boolean;
  /** Called after a record or a withdrawal, so the wizard reloads the step with the new balance. */
  onChanged: () => void;
};

const money = formatPayrollMoney;
const keyOf = (balance: Pick<HeldBalance, "runId" | "compact">) => `${balance.runId}|${balance.compact}`;

/** One held balance as the picker names it: the person, the month held, what is still owed. */
const choiceLabel = (balance: HeldBalance) =>
  `${balance.name} · ${monthNameAndYear(balance.month, balance.year)} · owed ${money(balance.outstanding)}${
    balance.settled ? " · recorded already" : ""
  }`;

/** What a transfer may say was paid: what is still owed plus what an earlier record already says. Mirrors settlementCeiling. */
const ceilingOf = (balance: HeldBalance) => Math.round((balance.outstanding + (balance.settled?.amount ?? 0)) * 100) / 100;

const todayInCairo = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());

/**
 * "This held salary was already transferred outside payroll" (owner rule 2026-09-10; screen added on the
 * payroll audit of 2026-11-14, finding 9 — the server had recorded it since September with no screen).
 *
 * A held person is sometimes paid by hand during the month. Recording it here takes the amount off what
 * is still owed, so the Held Salary Release step below never pays it a second time. The server refuses an
 * amount above what that month withheld less what payroll already released.
 */
export function HeldPaidOutsidePanel({ runId, locked, stepDirty, onChanged }: Props) {
  const [balances, setBalances] = useState<HeldBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${runId}/held-settlements`);
      const data = await res.json().catch(() => {
        throw new Error(`The server did not answer properly (${res.status}). Reload to see what was saved.`);
      });
      if (!res.ok) throw new Error(data.error ?? "Failed to load the held salary still owed.");
      setBalances((data.balances ?? []) as HeldBalance[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the held salary still owed.");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Who a transfer can be recorded against: anyone still owed, or already recorded (to correct it).
  const open = useMemo(() => balances.filter((balance) => ceilingOf(balance) > 0), [balances]);
  const recorded = useMemo(() => balances.filter((balance) => balance.settled), [balances]);
  const chosen = open.find((balance) => keyOf(balance) === target) ?? null;

  const editable = !locked && !stepDirty;
  const amountNumber = Number(amount);
  const ceiling = chosen ? ceilingOf(chosen) : 0;
  const amountTooHigh = Boolean(chosen) && Number.isFinite(amountNumber) && amountNumber > ceiling;
  const canRecord =
    editable &&
    Boolean(chosen) &&
    Number.isFinite(amountNumber) &&
    amountNumber > 0 &&
    !amountTooHigh &&
    /^\d{4}-\d{2}-\d{2}$/.test(paidOn);

  const choose = (value: string) => {
    setTarget(value);
    const balance = open.find((entry) => keyOf(entry) === value);
    // A correction starts from what was recorded; a new record leaves the amount for HR to type.
    setAmount(balance?.settled ? String(balance.settled.amount) : "");
    setPaidOn(balance?.settled?.paidOn ?? "");
    setMethod(balance?.settled?.method ?? "");
    setReference(balance?.settled?.reference ?? "");
    setNote(balance?.settled?.note ?? "");
  };

  const record = async () => {
    if (!canRecord || !chosen) return;
    setBusy("record");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/automated-payroll/runs/${chosen.runId}/held-settlements`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hrId: chosen.hrId,
          amount: amountNumber,
          paidOn,
          method: method.trim() || null,
          reference: reference.trim() || null,
          note: note.trim() || null,
        }),
      });
      const data = await res.json().catch(() => {
        throw new Error(`The server did not answer properly (${res.status}). Reload to see what was saved.`);
      });
      if (!res.ok) throw new Error(data.error ?? "Failed to record the transfer.");
      setNotice(
        `Recorded ${money(amountNumber)} paid to ${chosen.name} outside payroll for ${monthNameAndYear(chosen.month, chosen.year)}.`,
      );
      choose("");
      await load();
      onChanged();
    } catch (recordError) {
      setError(recordError instanceof Error ? recordError.message : "Failed to record the transfer.");
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async (balance: HeldBalance) => {
    setBusy(keyOf(balance));
    setError(null);
    setNotice(null);
    try {
      const query = new URLSearchParams({ hrId: balance.hrId });
      const res = await fetch(`/api/automated-payroll/runs/${balance.runId}/held-settlements?${query.toString()}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => {
        throw new Error(`The server did not answer properly (${res.status}). Reload to see what was saved.`);
      });
      if (!res.ok) throw new Error(data.error ?? "Failed to withdraw the transfer.");
      setNotice(`Withdrawn: ${balance.name}'s ${monthNameAndYear(balance.month, balance.year)} amount is owed again.`);
      await load();
      onChanged();
    } catch (withdrawError) {
      setError(withdrawError instanceof Error ? withdrawError.message : "Failed to withdraw the transfer.");
    } finally {
      setBusy(null);
    }
  };

  // Nobody owed and nothing recorded: the panel has no job this month.
  if (!loading && !error && open.length === 0 && recorded.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 border border-slate-200 bg-white p-4">
      <div className="min-w-0">
        <h3 className="text-base font-black tracking-tight text-slate-900">Paid outside payroll</h3>
        <p className="mt-0.5 text-sm text-slate-500">
          A held salary transferred by hand. Recording it takes the amount off what is still owed, so the step below never
          pays it again.
        </p>
      </div>

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
      {notice ? <div className="border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">{notice}</div> : null}
      {locked ? (
        <div className="border-l-4 border-slate-300 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          Read-only — this step is not open.
        </div>
      ) : stepDirty ? (
        <div className="border-l-4 border-amber-400 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          Save the changes on the step below first — recording a transfer reloads it.
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-slate-500">Loading the held salary still owed…</div>
      ) : (
        <>
          {!locked && open.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-start">
                {/* A closed native select cannot wrap, so on a phone the chosen line was cut mid-word. The
                    placeholder is short enough to fit at 375px, and the full choice is repeated below the
                    select on a phone, where it wraps (the no-ellipsis rule: wrapping wins). */}
                <FormField
                  label="Who, and which month"
                  required
                  hint={chosen ? <span className="md:hidden">{choiceLabel(chosen)}</span> : undefined}
                >
                  <select
                    value={target}
                    disabled={!editable}
                    onChange={(event) => choose(event.target.value)}
                    className={phxSelectClassName}
                    aria-label="Who, and which month"
                  >
                    <option value="">Choose a person</option>
                    {open.map((balance) => (
                      <option key={keyOf(balance)} value={keyOf(balance)}>
                        {choiceLabel(balance)}
                      </option>
                    ))}
                  </select>
                </FormField>
                <FormField
                  label="Amount transferred"
                  required
                  hint={chosen ? `At most ${money(ceiling)}` : undefined}
                  error={amountTooHigh ? `More than the ${money(ceiling)} still owed` : undefined}
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={amount}
                    disabled={!editable || !chosen}
                    onChange={(event) => setAmount(event.target.value)}
                    className="text-right"
                    aria-label="Amount transferred"
                  />
                </FormField>
                <FormField label="Transfer date" required>
                  <Input
                    type="date"
                    value={paidOn}
                    max={todayInCairo()}
                    disabled={!editable || !chosen}
                    onChange={(event) => setPaidOn(event.target.value)}
                    aria-label="Transfer date"
                  />
                </FormField>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] md:items-end">
                <FormField label="How it was paid">
                  <Input
                    value={method}
                    disabled={!editable || !chosen}
                    placeholder="e.g. bank transfer, cash"
                    onChange={(event) => setMethod(event.target.value)}
                    aria-label="How it was paid"
                  />
                </FormField>
                <FormField label="Reference">
                  <Input
                    value={reference}
                    disabled={!editable || !chosen}
                    placeholder="Bank reference, if any"
                    onChange={(event) => setReference(event.target.value)}
                    aria-label="Reference"
                  />
                </FormField>
                <FormField label="Note">
                  <Input
                    value={note}
                    disabled={!editable || !chosen}
                    placeholder="Anything payroll should know"
                    onChange={(event) => setNote(event.target.value)}
                    aria-label="Note"
                  />
                </FormField>
                <button
                  type="button"
                  disabled={!canRecord || busy !== null}
                  onClick={() => void record()}
                  className={cn(phxButtonAccentClassName, "justify-center")}
                >
                  {busy === "record" ? "Recording…" : chosen?.settled ? "Correct the record" : "Record transfer"}
                </button>
              </div>
            </div>
          ) : null}

          {recorded.length > 0 ? (
            <>
              {/* Desktop: a fixed table that fits its width — long names and notes wrap, never scroll. */}
              <table className="hidden w-full table-fixed border border-slate-200 text-sm md:table">
                <colgroup>
                  <col className="w-[24%]" />
                  <col className="w-[14%]" />
                  <col className="w-[13%]" />
                  <col className="w-[13%]" />
                  <col />
                  <col className="w-12" />
                </colgroup>
                <thead className="bg-slate-900">
                  <tr>
                    {["Employee", "Month held", "Paid by hand", "Still owed", "Paid on · how · note"].map((label) => (
                      <th
                        key={label}
                        className={cn(
                          "px-3 py-2 text-left text-phx-xs font-bold uppercase tracking-wide text-slate-300",
                          (label === "Paid by hand" || label === "Still owed") && "text-right",
                        )}
                      >
                        {label}
                      </th>
                    ))}
                    <th className="px-3 py-2">
                      <span className="sr-only">Withdraw</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recorded.map((balance, index) => (
                    <tr
                      key={keyOf(balance)}
                      className={cn("border-b border-slate-200 align-top", index % 2 ? "bg-slate-50/60" : "bg-white")}
                    >
                      <td className="break-words px-3 py-2 font-semibold text-slate-900">{balance.name}</td>
                      <td className="break-words px-3 py-2 text-slate-700">{monthNameAndYear(balance.month, balance.year)}</td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900">
                        {money(balance.settled?.amount ?? 0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">{money(balance.outstanding)}</td>
                      <td className="break-words px-3 py-2 text-slate-700">
                        {[balance.settled?.paidOn, balance.settled?.method, balance.settled?.reference, balance.settled?.note]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                      <td className="px-1 py-1.5 text-right">
                        {!locked ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!editable || busy !== null}
                            onClick={() => void withdraw(balance)}
                            aria-label={`Withdraw the transfer recorded for ${balance.name}`}
                            className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Mobile: cards, as every admin table does on a phone. */}
              <div className="flex flex-col gap-2 md:hidden">
                {recorded.map((balance) => (
                  <div key={keyOf(balance)} className="border border-slate-200 bg-white">
                    <div className="flex items-start justify-between gap-2 border-b border-slate-200 bg-slate-900 px-3 py-2">
                      <span className="min-w-0 break-words text-sm font-black tracking-tight text-white">{balance.name}</span>
                      {!locked ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!editable || busy !== null}
                          onClick={() => void withdraw(balance)}
                          aria-label={`Withdraw the transfer recorded for ${balance.name}`}
                          className="shrink-0 text-slate-400 hover:bg-white/10 hover:text-rose-400"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 text-sm">
                      <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Month held</dt>
                      <dd className="break-words text-slate-800">{monthNameAndYear(balance.month, balance.year)}</dd>
                      <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Paid by hand</dt>
                      <dd className="font-semibold tabular-nums text-slate-900">{money(balance.settled?.amount ?? 0)}</dd>
                      <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Still owed</dt>
                      <dd className="tabular-nums text-slate-800">{money(balance.outstanding)}</dd>
                      <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Paid on</dt>
                      <dd className="break-words text-slate-800">
                        {[balance.settled?.paidOn, balance.settled?.method, balance.settled?.reference, balance.settled?.note]
                          .filter(Boolean)
                          .join(" · ")}
                      </dd>
                    </dl>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3 border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                  Total paid by hand · {recorded.length} {recorded.length === 1 ? "person" : "people"}
                </span>
                <span className="font-black tabular-nums text-slate-900">
                  {money(recorded.reduce((sum, balance) => sum + (balance.settled?.amount ?? 0), 0))}
                </span>
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-400">No transfer outside payroll recorded yet.</div>
          )}
        </>
      )}
    </div>
  );
}
