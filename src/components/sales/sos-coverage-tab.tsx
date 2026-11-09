"use client";

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { useEffect, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { Button } from "@/components/ui/button";
import { customerKey, savedCustomerKeys } from "@/lib/sales/customer-key";
import type { CoverageSummary, DistributorCoverageRow, PersistentUnmappedCustomer } from "@/lib/sales/import-coverage";
import { formatNumber } from "@/lib/sales/format";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SortableTh, TableNoResults, TableSearchInput, useSortableTable } from "@/components/ui/sortable-table";

type DriftAlert = CoverageSummary["driftAlerts"][number];


type BrickOption = { id: string; name: string };

type Props = { bricks: BrickOption[] };

type CoverageResponse = {
  data?: CoverageSummary;
  error?: string;
  success: boolean;
};

type AcceptResponse = {
  data?: { accepted: number; failed: number; results: { customerCode: string; distributorCode: string; error?: string; ok: boolean }[] };
  error?: string;
  message?: string;
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
  neutral: "text-phx-ink-soft",
  warn: "text-orange-600",
};

function PctBadge({ pct }: { pct: number }) {
  const tone = pctTone(pct);
  return (
    <span className={`font-black tabular-nums ${toneClass[tone]}`}>{pct.toFixed(1)}%</span>
  );
}

function TrendDots({ values }: { values: number[] }) {
  if (values.length === 0) return <span className="text-phx-ink-faint text-xs">–</span>;
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
    <div className="rounded-xl border border-phx-line bg-phx-paper px-4 py-3">
      <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">{label}</p>
      <p className="mt-1 text-2xl font-black tabular-nums text-slate-950">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-phx-ink-faint">{sub}</p> : null}
    </div>
  );
}

function DistributorCoverageTable({ rows }: { rows: DistributorCoverageRow[] }) {
  const table = useSortableTable(rows, {
    columns: [
      { key: "distributorCode", accessor: (row) => row.distributorCode, type: "string" },
      { key: "latestResolvedPct", accessor: (row) => row.latestResolvedPct, type: "number" },
      // null means this writer never measured new customers. Sort it below every real count rather
      // than as 0, which would rank "not measured" alongside "none found".
      { key: "latestNewCustomers", accessor: (row) => row.latestNewCustomers ?? -1, type: "number" },
      { key: "latestUnmappedProducts", accessor: (row) => row.latestUnmappedProducts, type: "number" },
      { key: "latestBrickDrift", accessor: (row) => row.latestBrickDrift, type: "number" },
      { key: "importCount", accessor: (row) => row.importCount, type: "number" },
      { key: "latestCommittedAt", accessor: (row) => row.latestCommittedAt, type: "date" },
    ],
    searchAccessors: [(row) => row.distributorCode],
    // Worst-first default (matches the panel description).
    initialSort: { key: "latestResolvedPct", dir: "asc" },
    secondarySort: { key: "distributorCode", accessor: (row) => row.distributorCode, type: "string" },
  });
  if (rows.length === 0) {
    return <p className="px-5 py-4 text-sm text-phx-ink-soft">No coverage data yet — data populates after the first confirmed import.</p>;
  }
  const thProps = { sort: table.sort, onSort: table.toggleSort, variant: "dark" as const, className: "px-4 py-3 text-phx-xs tracking-[0.14em]" };
  return (
    <div>
      <div className="flex justify-end border-b border-[#EEF2F7] px-4 py-2">
        <div className="w-48">
          <TableSearchInput value={table.query} onChange={table.setQuery} onClear={table.clearQuery} placeholder="Filter distributors…" />
        </div>
      </div>
      {/* Eight columns cannot be read at 375px and must not scroll sideways, so the five
          detail columns are MERGED into the Distributor cell below md and shown as their
          own columns from md up. Nothing is dropped at either width, and every sort
          control survives where the header row is visible. */}
      <div>
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[62%] md:w-[15%]" />
            <col className="w-[38%] md:w-[11%]" />
            <col className="hidden md:table-column md:w-[13%]" />
            <col className="hidden md:table-column md:w-[13%]" />
            <col className="hidden md:table-column md:w-[15%]" />
            <col className="hidden md:table-column md:w-[11%]" />
            <col className="hidden md:table-column md:w-[9%]" />
            <col className="hidden md:table-column md:w-[13%]" />
          </colgroup>
          <thead>
            <tr className="bg-[#020617] text-left text-white">
              <SortableTh label="Distributor" sortKey="distributorCode" {...thProps} />
              <SortableTh label="Resolved %" sortKey="latestResolvedPct" align="right" {...thProps} />
              <SortableTh className={`${thProps.className} hidden md:table-cell`} label="Trend (last 5)" sort={thProps.sort} onSort={thProps.onSort} variant={thProps.variant} />
              <SortableTh className={`${thProps.className} hidden md:table-cell`} label="New customers" sortKey="latestNewCustomers" align="right" sort={thProps.sort} onSort={thProps.onSort} variant={thProps.variant} />
              <SortableTh className={`${thProps.className} hidden md:table-cell`} label="Unmapped products" sortKey="latestUnmappedProducts" align="right" sort={thProps.sort} onSort={thProps.onSort} variant={thProps.variant} />
              <SortableTh className={`${thProps.className} hidden md:table-cell`} label="Brick drift" sortKey="latestBrickDrift" align="right" sort={thProps.sort} onSort={thProps.onSort} variant={thProps.variant} />
              <SortableTh className={`${thProps.className} hidden md:table-cell`} label="Imports" sortKey="importCount" align="right" sort={thProps.sort} onSort={thProps.onSort} variant={thProps.variant} />
              <SortableTh className={`${thProps.className} hidden md:table-cell`} label="Last import" sortKey="latestCommittedAt" align="right" sort={thProps.sort} onSort={thProps.onSort} variant={thProps.variant} />
            </tr>
          </thead>
          <tbody>
            {table.rows.length === 0 && <TableNoResults colSpan={8} filtered={table.isFiltered} label="distributors" />}
            {table.rows.map((row) => (
              <tr key={row.distributorCode} className="border-t border-[#EEF2F7] hover:bg-phx-paper">
                <td className="break-words px-4 py-2.5 align-top font-black text-phx-ink">
                  {row.distributorCode}
                  <span className="mt-1 block font-normal text-phx-sm text-phx-ink-soft md:hidden">
                    <span className="block">
                      {row.latestNewCustomers === null ? "new customers not measured" : `${formatNumber(row.latestNewCustomers)} new customers`}
                      {" · "}{formatNumber(row.latestUnmappedProducts)} unmapped
                    </span>
                    <span className="block">
                      {formatNumber(row.latestBrickDrift)} brick drift · {formatNumber(row.importCount)} imports
                    </span>
                    <span className="block">
                      last {new Date(row.latestCommittedAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}
                    </span>
                    <span className="mt-1 flex items-center gap-1.5">
                      trend <TrendDots values={row.trend} />
                    </span>
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right align-top"><PctBadge pct={row.latestResolvedPct} /></td>
                <td className="hidden px-4 py-2.5 align-top md:table-cell"><TrendDots values={row.trend} /></td>
                <td className="hidden px-4 py-2.5 text-right align-top tabular-nums text-phx-ink md:table-cell">
                  {row.latestNewCustomers === null ? <span className="text-phx-ink-subtle">not measured</span> : formatNumber(row.latestNewCustomers)}
                </td>
                <td className="hidden px-4 py-2.5 text-right align-top tabular-nums text-phx-ink md:table-cell">{formatNumber(row.latestUnmappedProducts)}</td>
                <td className="hidden px-4 py-2.5 text-right align-top md:table-cell">
                  {row.latestBrickDrift > 0
                    ? <span className="font-bold text-orange-600">{formatNumber(row.latestBrickDrift)}</span>
                    : <span className="text-phx-ink-faint">0</span>}
                </td>
                <td className="hidden px-4 py-2.5 text-right align-top tabular-nums text-phx-ink-soft md:table-cell">{formatNumber(row.importCount)}</td>
                <td className="hidden px-4 py-2.5 text-right align-top text-phx-ink-soft md:table-cell">
                  {new Date(row.latestCommittedAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DriftAlertsTable({ alerts }: { alerts: DriftAlert[] }) {
  const table = useSortableTable(alerts, {
    columns: [
      { key: "distributorCode", accessor: (row) => row.distributorCode, type: "string" },
      { key: "brickDriftCount", accessor: (row) => row.brickDriftCount, type: "number" },
      { key: "committedAt", accessor: (row) => row.committedAt, type: "date" },
    ],
    searchAccessors: [(row) => row.distributorCode],
    initialSort: { key: "committedAt", dir: "desc" },
  });
  const thProps = { sort: table.sort, onSort: table.toggleSort, variant: "dark" as const, className: "px-4 py-3 text-phx-xs tracking-[0.14em]" };
  return (
    <div>
      <CrmCardsOnPhone>
        {table.rows.map((alert) => (
          <CrmCard key={alert.batchId} title={alert.distributorCode}>
            <CrmFacts
              facts={[
                { label: "Drift count", value: formatNumber(alert.brickDriftCount) },
                { label: "Import date", value: new Date(alert.committedAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }) },
              ]}
            />
          </CrmCard>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["44%", "26%", "30%"]} className="text-sm">
        <thead>
          <tr className="bg-[#020617] text-left text-white">
            <SortableTh label="Distributor" sortKey="distributorCode" {...thProps} />
            <SortableTh label="Drift count" sortKey="brickDriftCount" align="right" {...thProps} />
            <SortableTh label="Import date" sortKey="committedAt" align="right" {...thProps} />
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 && <TableNoResults colSpan={3} filtered={table.isFiltered} label="drift alerts" />}
          {table.rows.map((alert) => (
            <tr key={alert.batchId} className="border-t border-[#EEF2F7]">
              <td className="break-words px-4 py-2.5 font-semibold text-phx-ink">{alert.distributorCode}</td>
              <td className="px-4 py-2.5 text-right font-bold text-orange-600">{formatNumber(alert.brickDriftCount)}</td>
              <td className="break-words px-4 py-2.5 text-right text-phx-ink-soft">
                {new Date(alert.committedAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </div>
  );
}

// Bulk-map the recurring offenders: assign each persistent-unmapped customer a brick and save them all
// to the mapping sheet in one shot (reuses the audited /accept-mappings endpoint from Step 3b).
function BulkMapTable({ bricks, onSaved, rows }: { bricks: BrickOption[]; onSaved: () => void; rows: PersistentUnmappedCustomer[] }) {
  const [picked, setPicked] = useState<Record<string, string>>({}); // key → brickId
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const keyOf = (r: PersistentUnmappedCustomer) => customerKey(r.distributorCode, r.customerCode);
  const pendingPicked = rows.filter((r) => picked[keyOf(r)] && !savedKeys.has(keyOf(r)));

  async function saveAll() {
    if (pendingPicked.length === 0) return;
    setSaving(true);
    setMessage(null);
    const mappings = pendingPicked.map((r) => ({
      address: r.address,
      brickId: picked[keyOf(r)],
      customerCode: r.customerCode,
      customerName: r.customerName,
      distributorCode: r.distributorCode,
    }));
    try {
      const response = await fetch("/api/sales/monthly-import/accept-mappings", {
        body: JSON.stringify({ mappings }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({ success: false }))) as AcceptResponse;
      // Reconcile by the composite (distributorCode|customerCode) the server echoes back, so a
      // customerCode shared across distributors never marks the wrong row as saved.
      const okKeys = savedCustomerKeys(payload.data?.results ?? []);
      if (okKeys.length > 0) {
        setSavedKeys((prev) => {
          const next = new Set(prev);
          for (const key of okKeys) next.add(key);
          return next;
        });
      }
      setMessage(payload.message ?? payload.error ?? "Done.");
      if (okKeys.length > 0) onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save mappings.");
    } finally {
      setSaving(false);
    }
  }

  const brickCell = (r: PersistentUnmappedCustomer) => {
    const key = keyOf(r);
    if (savedKeys.has(key)) {
      return <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> Mapped</span>;
    }
    return (
      <SearchableSelect
        className="h-9 w-full px-2"
        disabled={saving || bricks.length === 0}
        onChange={(e) => setPicked((prev) => ({ ...prev, [key]: e.target.value }))}
        value={picked[key] ?? ""}
      >
        <option value="">Select a brick…</option>
        {bricks.map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </SearchableSelect>
    );
  };

  return (
    <div className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-phx-ink-soft">
          Pick a brick for each recurring customer and save them all to the mapping sheet at once.
          {bricks.length === 0 ? " (Brick list unavailable.)" : ""}
        </p>
        <Button
          className="h-9 gap-1.5 rounded-lg bg-[#0B0B0B] text-xs font-black text-white hover:bg-phx-accent"
          disabled={saving || pendingPicked.length === 0}
          onClick={() => void saveAll()}
          type="button"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          Save all selected ({pendingPicked.length})
        </Button>
      </div>
      <div>
        <CrmCardsOnPhone>
          {rows.map((r) => (
            <CrmCard
              key={keyOf(r)}
              meta={r.customerName || "name not captured"}
              title={r.customerCode}
            >
              <CrmFacts
                facts={[
                  { label: "Distributor", value: r.distributorCode },
                  { label: "Imports", value: formatNumber(r.importCount) },
                ]}
              />
              <div className="mt-2">{brickCell(r)}</div>
            </CrmCard>
          ))}
        </CrmCardsOnPhone>
        <CrmTable className="text-sm" columns={["34%", "18%", "14%", "34%"]}>
          <thead>
            <tr className="bg-[#020617] text-left">
              {["Customer", "Distributor", "Imports", "Assign brick"].map((h) => (
                <th key={h} className="px-4 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft first:text-white">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={keyOf(r)} className="border-t border-[#EEF2F7]">
                <td className="break-words px-4 py-2 align-top">
                  <span className="font-semibold text-phx-ink">{r.customerCode}</span>
                  {/* The name used to be capped at 220px and ellipsised. The column owns
                      the width now, so it wraps and the whole name is readable. */}
                  {r.customerName ? <span className="block break-words text-xs text-phx-ink-soft">{r.customerName}</span> : <span className="block text-xs italic text-phx-ink-faint">name not captured</span>}
                </td>
                <td className="break-words px-4 py-2 align-top text-phx-ink-soft">{r.distributorCode}</td>
                <td className="break-words px-4 py-2 align-top tabular-nums text-phx-ink-soft">{formatNumber(r.importCount)}</td>
                <td className="px-4 py-2 align-top">{brickCell(r)}</td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
      </div>
      {message ? <p className="text-xs font-semibold text-emerald-700">{message}</p> : null}
    </div>
  );
}

export function SosCoverageTab({ bricks }: Props) {
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
      <div className="flex items-center gap-3 py-10 text-phx-ink-soft">
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
              <StatCard
                label="Imports tracked"
                value={formatNumber(summary!.totalImports)}
                sub={
                  summary!.totalImports >= summary!.snapshotWindow
                    ? `most recent ${formatNumber(summary!.snapshotWindow)} — older imports are not in this view`
                    : "every import whose batch still exists"
                }
              />
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
              description="Customers that appeared unmapped in 3 or more imports. Assign each a brick and save them all to the mapping sheet at once."
              title="Persistent unmapped customers — bulk map"
            >
              <BulkMapTable
                bricks={bricks}
                onSaved={() => setRefreshKey((k) => k + 1)}
                rows={summary!.persistentUnmapped}
              />
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
              <DriftAlertsTable alerts={summary!.driftAlerts} />
            </AdminTableShell>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
