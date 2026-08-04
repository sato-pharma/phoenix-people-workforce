"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { HeldDirectOrderRow } from "@/lib/direct-orders/service";

type Props = { rows: HeldDirectOrderRow[] };

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const cairoStamp = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : "—";

/**
 * The Held Desk (spec C3 — docs/specs/direct-orders-v2.md): every direct order parked outside
 * the approval flow, oldest first, with the one action the owner asked for — select requests,
 * press the button, and each requester gets ONE email by name (CC: SFE, direct manager, CEO)
 * saying the request is held until they bring a valid pharmacy code.
 */
export function HeldDesk({ rows }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const selectedCount = useMemo(() => rows.filter((row) => selected.has(row.id)).length, [rows, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)));
  }

  async function sendNotices() {
    setError(null);
    setOk(null);
    const requestIds = rows.filter((row) => selected.has(row.id)).map((row) => row.id);
    if (requestIds.length === 0) {
      setError("Select at least one held request first.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/direct-orders/held/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestIds }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        sent?: number;
        skipped?: Array<{ requestId: string; reason: string }>;
      };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not send the held notices.");
      const skippedNote = data.skipped?.length ? ` (${data.skipped.length} skipped — no longer held)` : "";
      setOk(`Sent ${data.sent ?? 0} notice${(data.sent ?? 0) === 1 ? "" : "s"}${skippedNote}. Each went as one email — requester in To, SFE + manager + CEO in CC.`);
      setSelected(new Set());
      router.refresh();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const urgency = (days: number) =>
    days <= 2 ? "bg-rose-100 text-rose-800" : days <= 6 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600";

  if (rows.length === 0) {
    return (
      <section className="border border-[#e4e9ec] bg-white px-4 py-8 text-center">
        <p className="text-sm font-bold text-slate-600">No held direct orders.</p>
        <p className="mt-1 text-[12px] text-slate-400">
          Every submitted request is on a pharmacy the master database recognises.
        </p>
      </section>
    );
  }

  return (
    <section className="border border-[#e4e9ec] bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
        <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">
          Held requests — {rows.length}
        </h3>
        <button
          type="button"
          disabled={busy || selectedCount === 0}
          onClick={sendNotices}
          className="bg-orange-500 px-3 py-1.5 text-[12px] font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-400"
        >
          {busy ? "Sending…" : `Notify requester${selectedCount === 1 ? "" : "s"} (${selectedCount})`}
        </button>
      </header>

      {error ? <p className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-700">{error}</p> : null}
      {ok ? <p className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700">{ok}</p> : null}

      {/* Desktop: the full table. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-[#e4e9ec] text-[11px] font-black uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all held requests" />
              </th>
              <th className="px-3 py-2">Requester</th>
              <th className="px-3 py-2">Pharmacy</th>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Held since</th>
              <th className="px-3 py-2">Expires in</th>
              <th className="px-3 py-2">Last notice</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-[#f1f4f6] align-top hover:bg-orange-50/40">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    aria-label={`Select ${row.requesterName}'s request`}
                  />
                </td>
                <td className="px-3 py-2">
                  <p className="font-bold text-slate-900">{row.requesterName}</p>
                  <p className="text-[11px] text-slate-500">{row.requesterRole}</p>
                </td>
                <td className="px-3 py-2">
                  <p className="font-semibold text-slate-800" dir="auto">{row.pharmacyName}</p>
                  <p className="text-[11px] text-slate-500">{row.phoenixPharmacyCode}</p>
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {row.productName} × {row.qty.toLocaleString("en-US")}
                </td>
                <td className="px-3 py-2 font-bold text-slate-900">{money(row.salesValue)}</td>
                <td className="px-3 py-2 text-slate-600">{cairoStamp(row.heldAt)}</td>
                <td className="px-3 py-2">
                  <span className={`px-1.5 py-0.5 text-[11px] font-black ${urgency(row.daysRemaining)}`}>
                    {row.daysRemaining} day{row.daysRemaining === 1 ? "" : "s"}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-600">{row.lastNoticeAt ? cairoStamp(row.lastNoticeAt) : "never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards, never a squeezed table. */}
      <div className="space-y-2 p-3 md:hidden">
        {rows.map((row) => (
          <label key={row.id} className="block border border-[#e4e9ec] p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-black text-slate-900">{row.requesterName}</p>
                <p className="text-[11px] text-slate-500">{row.requesterRole}</p>
              </div>
              <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} aria-label={`Select ${row.requesterName}'s request`} />
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-800" dir="auto">
              {row.pharmacyName} <span className="text-[11px] font-normal text-slate-500">({row.phoenixPharmacyCode})</span>
            </p>
            <p className="text-[12px] text-slate-600">
              {row.productName} × {row.qty.toLocaleString("en-US")} · {money(row.salesValue)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span>Held {cairoStamp(row.heldAt)}</span>
              <span className={`px-1.5 py-0.5 font-black ${urgency(row.daysRemaining)}`}>
                expires in {row.daysRemaining}d
              </span>
              <span>notice: {row.lastNoticeAt ? cairoStamp(row.lastNoticeAt) : "never"}</span>
            </div>
          </label>
        ))}
      </div>
    </section>
  );
}
