"use client";

import { useMemo } from "react";

import { describeDirectOrderBasketUnits } from "@/lib/direct-orders/basket-label";
import type { ReturnedDirectOrderAgeingRow } from "@/lib/direct-orders/service";
import { type ReturnedAgeBand, returnedAgeBand } from "@/lib/direct-orders/returned-ageing";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { adminPanelClassName, adminPanelHeaderClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

type Props = { rows: ReturnedDirectOrderAgeingRow[] };

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const cairoStamp = (iso: string | null) =>
  iso
    ? stableEnGbFormatter({
        timeZone: "Africa/Cairo",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso))
    : "—";

/**
 * Paint for each band. The BANDING itself lives in the domain (`returnedAgeBand`) and is pinned by
 * a test — only the colours are decided here, so a restyle can never silently move the threshold.
 */
const BAND_TONE: Record<ReturnedAgeBand, string> = {
  critical: "bg-rose-100 text-rose-800",
  stale: "bg-amber-100 text-amber-800",
  fresh: "bg-slate-100 text-slate-600",
};

const ageTone = (days: number) => BAND_TONE[returnedAgeBand(days)];

/**
 * The Returned Ageing Desk: every direct order handed back to a rep and not yet answered.
 *
 * Read-only ON PURPOSE. Every action that could belong here — resubmit, cancel, change the
 * discount — is the rep's or the approver's and already exists on the order itself. A button here
 * would either duplicate one of those or invent an authority this desk does not have. What was
 * missing was never a button; it was that nobody could see the queue at all.
 */
export function ReturnedAgeingDesk({ rows }: Props) {
  const totals = useMemo(() => {
    const value = rows.reduce((sum, row) => sum + row.salesValue, 0);
    const oldest = rows.reduce((max, row) => Math.max(max, row.daysWaiting), 0);
    const stale = rows.filter((row) => row.daysWaiting >= 7).length;
    return { value, oldest, stale };
  }, [rows]);

  // Grouped by rep, because chasing is per PERSON — one conversation covers all of their orders.
  const byRep = useMemo(() => {
    const map = new Map<string, { name: string; hrId: string; rows: ReturnedDirectOrderAgeingRow[] }>();
    for (const row of rows) {
      const key = row.requesterHrId.toLowerCase();
      const existing = map.get(key);
      if (existing) existing.rows.push(row);
      else map.set(key, { name: row.requesterName, hrId: row.requesterHrId, rows: [row] });
    }
    return [...map.values()].sort(
      (a, b) =>
        Math.max(...b.rows.map((row) => row.daysWaiting)) - Math.max(...a.rows.map((row) => row.daysWaiting)),
    );
  }, [rows]);

  if (rows.length === 0) {
    return (
      <section className={`border border-phx-line bg-white px-4 py-8 text-center ${adminSoftDepthClassName}`}>
        <p className="text-sm font-bold text-slate-600">No returned orders waiting.</p>
        <p className="mt-1 text-phx-sm text-slate-400">
          Every order sent back to a rep has been answered, resubmitted or cancelled.
        </p>
      </section>
    );
  }

  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} flex flex-wrap items-center justify-between gap-3 px-4 py-2.5`}>
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">
          Returned, waiting on the rep — {rows.length}
        </h3>
        <div className="flex flex-wrap items-center gap-3 text-phx-xs font-black uppercase tracking-wider text-slate-300">
          <span>{money(totals.value)}</span>
          <span>oldest {totals.oldest}d</span>
          <span>{totals.stale} over a week</span>
        </div>
      </header>

      {/* Desktop: table-fixed with a colgroup, so it fits the screen at every width instead of
          scrolling sideways over a min-width floor. The reason column takes the slack and WRAPS —
          it is the approver's own sentence and must never be cut. */}
      <div className="hidden md:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[17%]" />
            <col className="w-[22%]" />
            <col className="w-[11%]" />
            <col className="w-[11%]" />
            <col className="w-[8%]" />
            <col className="w-[31%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-phx-line text-phx-xs font-black uppercase tracking-wider text-slate-500">
              <th className="px-3 py-2">Rep</th>
              <th className="px-3 py-2">Venue</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Returned</th>
              <th className="px-3 py-2">Waiting</th>
              <th className="px-3 py-2">What the approver asked</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-[#f1f4f6] align-top hover:bg-orange-50/40">
                <td className="px-3 py-2">
                  <p className="break-words font-bold text-slate-900">{row.requesterName}</p>
                </td>
                <td className="px-3 py-2">
                  <p className="break-words font-semibold text-slate-800" dir="auto">
                    {row.pharmacyName}
                  </p>
                  <p className="text-phx-xs text-slate-500">
                    {row.distributorCodes.length > 0 ? row.distributorCodes.join(", ") : "No distributor code"}
                  </p>
                </td>
                <td className="px-3 py-2 font-bold text-slate-900">{money(row.salesValue)}</td>
                <td className="px-3 py-2 text-slate-600">{cairoStamp(row.returnedAt)}</td>
                <td className="px-3 py-2">
                  <span className={`inline-block px-1.5 py-0.5 text-phx-xs font-black ${ageTone(row.daysWaiting)}`}>
                    {row.daysWaiting}d
                  </span>
                </td>
                <td className="px-3 py-2">
                  <p className="whitespace-pre-line break-words text-slate-700" dir="auto">
                    {row.returnReason || "No reason was recorded."}
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards, never a squeezed table. */}
      <div className="space-y-2 p-3 md:hidden">
        {rows.map((row) => (
          <article key={row.id} className="border border-phx-line p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-sm font-black text-slate-900">{row.requesterName}</p>
              </div>
              <span className={`shrink-0 px-1.5 py-0.5 text-phx-xs font-black ${ageTone(row.daysWaiting)}`}>
                {row.daysWaiting}d
              </span>
            </div>
            <p className="mt-2 break-words text-sm font-semibold text-slate-800" dir="auto">
              {row.pharmacyName}
            </p>
            <p className="text-phx-xs text-slate-500">
              {row.distributorCodes.length > 0 ? row.distributorCodes.join(", ") : "No distributor code"}
            </p>
            <p className="mt-1 text-phx-sm text-slate-600">
              {describeDirectOrderBasketUnits(row, row.items)} · {money(row.salesValue)}
            </p>
            <p className="mt-2 whitespace-pre-line break-words border-l-2 border-slate-300 pl-2 text-phx-sm text-slate-700" dir="auto">
              {row.returnReason || "No reason was recorded."}
            </p>
            <p className="mt-1 text-phx-xs text-slate-400">Returned {cairoStamp(row.returnedAt)}</p>
          </article>
        ))}
      </div>

      {/* Who to chase, and for how much. The per-person total is the number that actually starts
          a conversation — one rep with four small orders outranks another with one. */}
      <div className="border-t border-phx-line p-3">
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
          Who to chase — {byRep.length} rep{byRep.length === 1 ? "" : "s"}
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {byRep.map((rep) => {
            const oldest = Math.max(...rep.rows.map((row) => row.daysWaiting));
            const value = rep.rows.reduce((sum, row) => sum + row.salesValue, 0);
            return (
              <article key={rep.hrId.toLowerCase()} className="border border-phx-line p-2.5">
                <p className="break-words text-phx-sm font-black text-slate-900">{rep.name}</p>
                <p className="mt-1 text-phx-sm text-slate-700">
                  {rep.rows.length} order{rep.rows.length === 1 ? "" : "s"} · {money(value)}
                </p>
                <span className={`mt-1 inline-block px-1.5 py-0.5 text-phx-xs font-black ${ageTone(oldest)}`}>
                  oldest {oldest}d
                </span>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
