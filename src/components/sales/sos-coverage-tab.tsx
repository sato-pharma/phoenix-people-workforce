"use client";

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { CoverageSummary, DistributorCoverageRow } from "@/lib/sales/import-coverage";
import { formatNumber } from "@/lib/sales/format";

type CoverageResponse = {
  data?: CoverageSummary;
  error?: string;
  success: boolean;
};

function pctTone(pct: number): "good" | "warn" | "bad" | "neutral" {
  if (pct >= 90) return "good";
  if (pct >= 60) return "warn";
  if (pct > 0) return "bad";
  return "neutral";
}

const toneClass: Record<"good" | "warn" | "bad" | "neutral", string> = {
  bad: "text-red-600",
  good: "text-emerald-600",
  neutral: "text-[#64748B]",
  warn: "text-orange-600",
};

function PctBadge({ pct }: { pct: number }) {
  const tone = pctTone(pct);
  return (
    <span className={`font-black tabular-nums ${toneClass[tone]}`}>{pct.toFixed(1)}%</span>
  );
}

function TrendDots({ values }: { values: number[] }) {
  if (values.length === 0) return <span className="text-[#94A3B8] text-xs">–</span>;
  return (
    <div className="flex items-center gap-1">
      {values.map((v, i) => {
        const tone = pctTone(v);
        const dotClass =
          tone === "good" ? "bg-emerald-500" : tone === "warn" ? "bg-orange-500" : "bg-red-500";
        return (
          <span
            key={i}
            className={`inline-block h-2.5 w-2.5 rounded-full ${dotClass}`}
            title={`${v.toFixed(1)}%`}
          />
        );
      })}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; sub?: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
      <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">{label}</p>
      <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-[#94A3B8]">{sub}</p> : null}
    </div>
  );
}

function DistributorCoverageTable({ rows }: { rows: DistributorCoverageRow[] }) {
  if (rows.length === 0) {
    return <p className="px-5 py-4 text-sm text-[#64748B]">No coverage data yet — data populates after the first confirmed import.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-[#020617] text-left">
            {["Distributor", "Resolved %", "Trend (last 5)", "New customers", "Unmapped products", "Brick drift", "Imports", "Last import"].map((h) => (
              <th key={h} className="px-4 py-3 text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B] first:text-white">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.distributorCode} className="border-t border-[#EEF2F7] hover:bg-[#F8FAFC]">
              <td className="px-4 py-2.5 font-black text-[#0F172A]">{row.distributorCode}</td>
              <td className="px-4 py-2.5"><PctBadge pct={row.latestResolvedPct} /></td>
              <td className="px-4 py-2.5"><TrendDots values={row.trend} /></td>
              <td className="px-4 py-2.5 tabular-nums text-[#0F172A]">{formatNumber(row.latestNewCustomers)}</td>
              <td className="px-4 py-2.5 tabular-nums text-[#0F172A]">{formatNumber(row.latestUnmappedProducts)}</td>
              <td className="px-4 py-2.5">
                {row.latestBrickDrift > 0
                  ? <span className="font-bold text-orange-600">{formatNumber(row.latestBrickDrift)}</span>
                  : <span className="text-[#94A3B8]">0</span>}
              </td>
              <td className="px-4 py-2.5 tabular-nums text-[#64748B]">{formatNumber(row.importCount)}</td>
              <td className="px-4 py-2.5 text-[#64748B]">
                {new Date(row.latestCommittedAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SosCoverageTab() {
  const [summary, setSummary] = useState<CoverageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let alive = true;

    const doFetch = async () => {
      setSummary(null);
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/sales/monthly-import/import-coverage", { cache: "no-store" });
        const payload = (await res.json().catch(() => ({ success: false }))) as CoverageResponse;
        if (!alive) return;
        if (payload.success && payload.data) {
          setSummary(payload.data);
        } else {
          setError(payload.error ?? "Failed to load coverage data.");
        }
      } catch (caught) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : "Failed to load coverage data.");
      } finally {
        if (alive) setLoading(false);
      }
    };

    void doFetch();
    return () => { alive = false; };
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="flex items-center gap-3 py-10 text-[#64748B]">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading coverage data…</span>
      </div>
    );
  }

  if (error) {
    return (
      <AdminCallout tone="danger">
        <AlertTriangle className="mt-0.5 h-4 w-4" />
        <p>{error}</p>
      </AdminCallout>
    );
  }

  const noData = !summary || summary.totalImports === 0;

  return (
    <div className="space-y-5">
      <AdminTableShell
        action={(
          <Button className="gap-2" disabled={loading} onClick={() => setRefreshKey((k) => k + 1)} variant="secondary">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        )}
        description="Mapping coverage across all committed distributor imports. Populates after each confirmed upload."
        title="Import Coverage"
      >
        {noData ? (
          <div className="px-5 py-6">
            <AdminCallout tone="neutral">
              <TrendingUp className="mt-0.5 h-4 w-4" />
              <p>No coverage data yet. Coverage snapshots are recorded with each confirmed import.</p>
            </AdminCallout>
          </div>
        ) : (
          <div className="space-y-5 p-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard label="Total imports tracked" value={formatNumber(summary!.totalImports)} />
              <StatCard label="Avg resolved %" value={`${summary!.avgResolvedPct.toFixed(1)}%`} sub="across all tracked uploads" />
              <StatCard label="Distributors tracked" value={formatNumber(summary!.byDistributor.length)} />
            </div>
          </div>
        )}
      </AdminTableShell>

      {!noData ? (
        <>
          <AdminTableShell
            description="Latest resolved %, trend (last 5 imports, oldest → newest), and issue counts per distributor. Sorted worst-first."
            title="Per-distributor coverage"
          >
            <DistributorCoverageTable rows={summary!.byDistributor} />
          </AdminTableShell>

          {summary!.persistentUnmapped.length > 0 ? (
            <AdminTableShell
              description="Customer codes that appeared as unmapped in 3 or more imports. Map these in the Mapping tab to improve coverage."
              title="Persistent unmapped customers"
            >
              <div className="flex flex-wrap gap-1.5 p-5">
                {summary!.persistentUnmapped.map((code) => (
                  <span
                    key={code}
                    className="rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-800"
                  >
                    {code}
                  </span>
                ))}
              </div>
            </AdminTableShell>
          ) : (
            <AdminTableShell description="No customer code has appeared as unmapped in 3+ imports." title="Persistent unmapped customers">
              <div className="flex items-center gap-2 px-5 py-4 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                <span>No persistent unmapped customers.</span>
              </div>
            </AdminTableShell>
          )}

          {summary!.driftAlerts.length > 0 ? (
            <AdminTableShell
              description="Recent imports where at least one customer's resolved brick differed from its stored mapping."
              title="Brick drift alerts"
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#020617] text-left">
                      {["Distributor", "Drift count", "Import date"].map((h) => (
                        <th key={h} className="px-4 py-3 text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B] first:text-white">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {summary!.driftAlerts.map((alert) => (
                      <tr key={alert.batchId} className="border-t border-[#EEF2F7]">
                        <td className="px-4 py-2.5 font-semibold text-[#0F172A]">{alert.distributorCode}</td>
                        <td className="px-4 py-2.5 font-bold text-orange-600">{formatNumber(alert.brickDriftCount)}</td>
                        <td className="px-4 py-2.5 text-[#64748B]">
                          {new Date(alert.committedAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminTableShell>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
