"use client";

import { useMemo, useState } from "react";

import type { DirectSalesReconciliationResult } from "@/lib/direct-orders/types";

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");
const units = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US");

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "danger" | "ok" | "neutral" }) {
  const ring =
    tone === "danger"
      ? "ring-rose-200 bg-rose-50"
      : tone === "ok"
        ? "ring-emerald-200 bg-emerald-50"
        : "ring-slate-200 bg-white";
  return (
    <div className={`rounded-2xl border border-transparent p-4 ring-1 ${ring}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-slate-800">{value}</div>
    </div>
  );
}

export function DirectOrderReconciliationWorkspace({ result }: { result: DirectSalesReconciliationResult }) {
  const periods = useMemo(
    () => Array.from(new Set(result.overlaps.map((o) => o.period))).sort().reverse(),
    [result.overlaps],
  );
  const [period, setPeriod] = useState<string>("all");

  const rows = useMemo(
    () => (period === "all" ? result.overlaps : result.overlaps.filter((o) => o.period === period)),
    [result.overlaps, period],
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Manual DIRECT total" value={money(result.totalManualDirect)} />
        <Kpi label="Module DirectReq total" value={money(result.totalModuleDirect)} />
        <Kpi
          label="Overlap exposure"
          value={money(result.overlapExposure)}
          tone={result.overlapExposure > 0 ? "danger" : "ok"}
        />
        <Kpi
          label="Overlapping buckets"
          value={units(result.overlapRows)}
          tone={result.pass ? "ok" : "danger"}
        />
      </div>

      {result.pass ? (
        <div className="rounded-2xl bg-emerald-50 p-4 text-sm font-medium text-emerald-800 ring-1 ring-emerald-200">
          ✓ No double-count detected — no (period · line · region · product) bucket carries direct sales from
          <span className="font-semibold"> both</span> the manual <code>DIRECT</code> upload and the module{" "}
          <code>DirectReq</code> injection.
        </div>
      ) : (
        <div className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 ring-1 ring-rose-200">
          <span className="font-semibold">
            {units(result.overlapRows)} bucket{result.overlapRows === 1 ? "" : "s"} appear in both direct sources
          </span>{" "}
          — up to <span className="font-semibold tabular-nums">{money(result.overlapExposure)}</span> EGP may be
          counted twice in company/region direct totals. Review whether these were entered manually{" "}
          <span className="font-semibold">and</span> via the module for the same deal, and retire one source per row.
          <div className="mt-1 text-xs text-rose-600">
            (Rep achievement is unaffected — manual <code>DIRECT</code> is region-only and excluded from the rep grid.)
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Period</label>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm"
        >
          <option value="all">All periods</option>
          {periods.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-400">
          {rows.length} overlap row{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-semibold">Period</th>
              <th className="px-3 py-2 font-semibold">Line</th>
              <th className="px-3 py-2 font-semibold">Region</th>
              <th className="px-3 py-2 font-semibold">Product</th>
              <th className="px-3 py-2 text-right font-semibold">Manual value</th>
              <th className="px-3 py-2 text-right font-semibold">Module value</th>
              <th className="px-3 py-2 text-right font-semibold">Overlap exposure</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-slate-400">
                  No overlapping direct-sales buckets.
                </td>
              </tr>
            ) : (
              rows.map((o, i) => (
                <tr key={`${o.period}-${o.line}-${o.regionCode}-${o.productCode}-${i}`} className="border-t border-slate-100">
                  <td className="px-3 py-2 tabular-nums">{o.period}</td>
                  <td className="px-3 py-2">{o.line}</td>
                  <td className="px-3 py-2">{o.regionCode}</td>
                  <td className="px-3 py-2">{o.productCode}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(o.manualValue)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(o.moduleValue)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-rose-700">
                    {money(o.overlapExposure)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
