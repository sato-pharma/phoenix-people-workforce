"use client";

import { AlertTriangle, Download, Loader2, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AdminCallout, AdminStatCard } from "@/components/admin/admin-design-system";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { SearchableSelect } from "@/components/ui/searchable-select";
// Value import, so it must come from the leaf: monthly-closing-details.ts reaches getSupabaseAdmin
// and this is a client component. See closing-headline.ts.
import { countsInClosingHeadline } from "@/lib/sales/closing-headline";
import type {
  ClosingDetailRow,
  ClosingDetailsResult,
  ClosingDetailsTotals,
} from "@/lib/sales/monthly-closing-details";

// The Details tab: every distributor invoice line behind the closing, with the Phoenix
// brick -> area roll-up applied and an explicit flag for whether the row is inside the
// published headline. The table shows the columns a reader checks on screen; the full
// ~29-column record is in the workbook export.
//
// Scope is enforced server-side — this component renders whatever the API returns and never
// decides what the viewer may see.

const PAGE_SIZE = 200;

type Props = {
  line: string | null;
  period: string | null;
  /** Portal mounts pass false — only CEO / Super Admin ever see the toggle. */
  showConfidentialToggle?: boolean;
};

const numberFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const valueFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

function fmtUnits(value: number) {
  return numberFmt.format(value);
}
function fmtValue(value: number) {
  return valueFmt.format(value);
}

const selectClassName =
  "h-10 w-full rounded-2xl border border-phx-line bg-phx-paper px-3 text-sm font-semibold text-phx-ink outline-none transition focus:border-phx-accent-line focus:ring-4 focus:ring-phx-accent/10 disabled:opacity-60";

export function ClosingDetailsPanel({ line, period, showConfidentialToggle = false }: Props) {
  const [data, setData] = useState<ClosingDetailsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [isExporting, setIsExporting] = useState(false);
  // Separate from `error`: a failed export must not blank out an already-loaded, filtered table
  // the user was browsing — that state is only reached once `error` (a load failure) is false.
  const [exportError, setExportError] = useState<string | null>(null);

  const [regionCode, setRegionCode] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [productCode, setProductCode] = useState("");
  const [distributorCode, setDistributorCode] = useState("");
  const [inclusion, setInclusion] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [includeConfidential, setIncludeConfidential] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Every request the panel could make, as one string. `isLoading` is derived by comparing it
  // to the key of the last completed load — so the effect below never has to setState before
  // its first await (which would trigger cascading renders; see react-hooks/set-state-in-effect).
  const requestKey = JSON.stringify({
    areaCode, debouncedSearch, distributorCode, inclusion, includeConfidential,
    line, page, period, productCode, regionCode,
  });
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const isLoading = Boolean(line) && Boolean(period) && loadedKey !== requestKey;

  useEffect(() => {
    if (!line || !period) return;
    let cancelled = false;
    void (async () => {
      try {
        const query = new URLSearchParams({
          line,
          period,
          page: String(page),
          pageSize: String(PAGE_SIZE),
        });
        if (regionCode) query.set("regionCodes", regionCode);
        if (areaCode) query.set("areaCodes", areaCode);
        if (productCode) query.set("productCodes", productCode);
        if (distributorCode) query.set("distributorCodes", distributorCode);
        if (inclusion) query.set("inclusion", inclusion);
        if (debouncedSearch) query.set("search", debouncedSearch);
        if (includeConfidential) query.set("includeConfidential", "true");

        const response = await fetch(`/api/sales/monthly-closing/details?${query.toString()}`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as {
          data?: ClosingDetailsResult;
          error?: string;
          success: boolean;
        };
        if (cancelled) return;
        if (payload.success && payload.data) {
          setData(payload.data);
          setError(null);
        } else {
          setError(payload.error ?? "Failed to load details.");
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load details.");
      } finally {
        if (!cancelled) setLoadedKey(requestKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    areaCode, debouncedSearch, distributorCode, inclusion, includeConfidential,
    line, page, period, productCode, regionCode, requestKey,
  ]);

  const areaOptions = useMemo(() => {
    const areas = data?.options.areas ?? [];
    return regionCode ? areas.filter((area) => area.regionCode === regionCode) : areas;
  }, [data, regionCode]);

  // Filter changes always return to page 1 — a narrow filter would otherwise land on an
  // empty page. Done in the handlers, not an effect, so there is no extra render pass.
  const onFilter = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  // Exports the same scoped rows this panel shows — the server re-derives them from the
  // caller's own access, not from anything sent here, so this can never widen visibility. A
  // Super Admin/system caller gets the full 6-sheet workbook (Matrix + Comparison + Data/Total);
  // every other role gets a Data + Total pair scoped to their line/region/product allowlist.
  async function handleExport() {
    if (!line || !period) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const response = await fetch("/api/sales/monthly-closing/export", {
        // Send the on-screen filter too. Without it the workbook was always the whole month while
        // the panel showed a narrowed slice, so "export what I am looking at" produced a different
        // set of numbers. These filters narrow only — the server still re-derives every row from
        // the caller's own access, so this can never widen what the export contains.
        //
        // The free text goes as `detailSearch`, not `search`: this box also matches customer and
        // product names, which the area x product Closing Matrix sheet cannot match at all.
        body: JSON.stringify({
          areaCodes: areaCode ? [areaCode] : [],
          detailSearch: debouncedSearch,
          distributorCodes: distributorCode ? [distributorCode] : [],
          inclusion,
          includeConfidential,
          line,
          period,
          productCodes: productCode ? [productCode] : [],
          regionCodes: regionCode ? [regionCode] : [],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new Error(payload?.error ?? payload?.message ?? "Export failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "phoenix-monthly-closing-details.xlsx";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setExportError(caught instanceof Error ? caught.message : "Export failed.");
    } finally {
      setIsExporting(false);
    }
  }

  if (!line || !period) {
    return (
      <div className="p-4 md:p-5">
        <AdminCallout tone="neutral">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <p>Pick a line and month to see the detailed sales rows behind the closing.</p>
        </AdminCallout>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 md:p-5">
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <p>{error}</p>
        </AdminCallout>
      </div>
    );
  }

  if (data?.outOfScope) {
    return (
      <div className="p-4 md:p-5">
        <AdminCallout tone="neutral">
          <ShieldAlert className="mt-0.5 h-4 w-4" />
          <p>
            This line is outside your scope, so no rows are shown. This is an access boundary, not an
            empty month.
          </p>
        </AdminCallout>
      </div>
    );
  }

  const recon = data?.reconciliation;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end px-4 pt-4 md:px-5">
        <button
          className="inline-flex h-10 shrink-0 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent disabled:opacity-50"
          disabled={isExporting || !data || data.filteredRowCount === 0}
          onClick={() => void handleExport()}
          type="button"
        >
          {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export XLSX
        </button>
      </div>

      {exportError ? (
        <div className="px-4 md:px-5">
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>{exportError}</p>
          </AdminCallout>
        </div>
      ) : null}

      {/* ── Reconciliation summary — what is and is not inside the headline ── */}
      {recon ? (
        <div className="grid grid-cols-1 gap-3 px-4 sm:grid-cols-2 xl:grid-cols-4 md:px-5">
          {/* The closing headline is BOTH channels added — distributor sell-out plus the direct
              orders Finance booked into the month. Showing the distributor half alone here read
              "In closing 0.00" for a month whose sales were all direct, while the Closing Matrix
              beside it showed the money. See countsInClosingHeadline. */}
          <AdminStatCard
            description={`${fmtUnits(recon.includedInClosing.rows)} distributor + ${fmtUnits(recon.excludedDirect.rows)} direct rows`}
            icon={<RefreshCw className="h-4 w-4" />}
            label="In closing"
            size="compact"
            tone="emerald"
            value={fmtValue(recon.closingHeadline.salesValue)}
          />
          <AdminStatCard
            description={
              recon.excludedDirect.rows > 0
                ? `${fmtUnits(recon.excludedDirect.rows)} booked Direct Orders rows, at their deal value`
                : "No direct orders booked into this month"
            }
            icon={<RefreshCw className="h-4 w-4" />}
            label="of which Direct"
            size="compact"
            tone="blue"
            value={fmtValue(recon.excludedDirect.salesValue)}
          />
          <AdminStatCard
            description={
              recon.missingClientCode.rows > 0
                ? `${fmtUnits(recon.missingClientCode.rows)} counted rows with no traceable outlet`
                : "Every row traces to a customer"
            }
            icon={<ShieldAlert className="h-4 w-4" />}
            label="No client code"
            size="compact"
            tone={recon.missingClientCode.rows > 0 ? "violet" : "emerald"}
            value={fmtUnits(recon.missingClientCode.units)}
          />
          <AdminStatCard
            description={`${fmtUnits(recon.unmappedBricks.rows)} unmapped bricks · ${fmtUnits(recon.areaMismatches.rows)} area mismatches`}
            icon={<AlertTriangle className="h-4 w-4" />}
            label="Data quality"
            size="compact"
            tone={recon.unmappedBricks.rows + recon.areaMismatches.rows > 0 ? "violet" : "emerald"}
            value={fmtUnits(recon.unmappedBricks.rows + recon.areaMismatches.rows)}
          />
        </div>
      ) : null}

      {recon && recon.missingClientCode.rows > 0 ? (
        <div className="px-4 md:px-5">
          <AdminCallout tone="neutral">
            <ShieldAlert className="mt-0.5 h-4 w-4" />
            <p>
              {fmtUnits(recon.missingClientCode.rows)} rows carrying{" "}
              {fmtUnits(recon.missingClientCode.units)} units have no client code. They <strong>are</strong>{" "}
              counted in the headline, but the sale cannot be traced back to an outlet — worth fixing
              at the distributor sheet, not a reason to doubt the total.
            </p>
          </AdminCallout>
        </div>
      ) : null}

      {/* ── Filters ──
          A dimension filter only renders when it has 2+ distinct values in the current scope —
          with 0 or 1, picking the one option changes nothing, so it's decorative, not usable.
          This is what makes a single-region viewer's toolbar shrink to exactly what applies to
          them (e.g. Region drops out for a one-region DM) without hiding a filter that has real
          choices behind it (Area/Product/Distributor commonly still do). */}
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-4 pb-4 md:px-5">
        <label className="flex w-full flex-col gap-1 sm:w-72">
          <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Search</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className={`${selectClassName} pl-9`}
              onChange={(event) => onFilter(setSearch)(event.target.value)}
              placeholder="Customer, brick, area, product…"
              value={search}
            />
          </div>
        </label>
        {(data?.options.regions.length ?? 0) > 1 ? (
          <label className="flex w-full flex-col gap-1 sm:w-40">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Region</span>
            <SearchableSelect
              className={selectClassName}
              onChange={(event) => {
                setAreaCode("");
                onFilter(setRegionCode)(event.target.value);
              }}
              value={regionCode}
            >
              <option value="">All regions</option>
              {(data?.options.regions ?? []).map((region) => (
                <option key={region.code} value={region.code}>{region.name}</option>
              ))}
            </SearchableSelect>
          </label>
        ) : null}
        {areaOptions.length > 1 ? (
          <label className="flex w-full flex-col gap-1 sm:w-44">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Area</span>
            <SearchableSelect
              className={selectClassName}
              onChange={(event) => onFilter(setAreaCode)(event.target.value)}
              value={areaCode}
            >
              <option value="">All areas</option>
              {areaOptions.map((area) => (
                <option key={area.code} value={area.code}>{area.name}</option>
              ))}
            </SearchableSelect>
          </label>
        ) : null}
        {(data?.options.products.length ?? 0) > 1 ? (
          <label className="flex w-full flex-col gap-1 sm:w-44">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Product</span>
            <SearchableSelect
              className={selectClassName}
              onChange={(event) => onFilter(setProductCode)(event.target.value)}
              value={productCode}
            >
              <option value="">All products</option>
              {(data?.options.products ?? []).map((product) => (
                <option key={product.code} value={product.code}>{product.name}</option>
              ))}
            </SearchableSelect>
          </label>
        ) : null}
        {(data?.options.distributors.length ?? 0) > 1 ? (
          <label className="flex w-full flex-col gap-1 sm:w-40">
            <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Distributor</span>
            <SearchableSelect
              className={selectClassName}
              onChange={(event) => onFilter(setDistributorCode)(event.target.value)}
              value={distributorCode}
            >
              <option value="">All distributors</option>
              {(data?.options.distributors ?? []).map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </SearchableSelect>
          </label>
        ) : null}
        <label className="flex w-full flex-col gap-1 sm:w-40">
          <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Rows</span>
          <SearchableSelect
            className={selectClassName}
            onChange={(event) => onFilter(setInclusion)(event.target.value)}
            value={inclusion}
          >
            <option value="">All rows</option>
            <option value="included">In the closing</option>
            <option value="excluded">Excluded from closing</option>
          </SearchableSelect>
        </label>
      </div>

      {showConfidentialToggle && data?.canRevealConfidential ? (
        <div className="px-4 md:px-5">
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
            <input
              checked={includeConfidential}
              className="h-4 w-4 accent-phx-accent"
              onChange={(event) => onFilter(setIncludeConfidential)(event.target.checked)}
              type="checkbox"
            />
            Include confidential products (LA003 / LA004 / SS001)
          </label>
        </div>
      ) : null}

      {/* ── Rows ── */}
      {isLoading ? (
        <div className="flex items-center gap-2 px-4 py-10 text-sm font-semibold text-slate-500 md:px-5">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading detailed rows…
        </div>
      ) : !data || data.rows.length === 0 ? (
        <div className="p-4 md:p-5">
          <AdminCallout tone="neutral">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>No rows match these filters.</p>
          </AdminCallout>
        </div>
      ) : (
        <>
          <DetailTable rows={data.rows} totals={data.totals} />
          <DetailCards rows={data.rows} />
          <PaginationControls
            onPageChange={(next) => setPage(next + 1)}
            page={page - 1}
            pageSize={data.pageSize}
            total={data.filteredRowCount}
          />
        </>
      )}
    </div>
  );
}

/** Desktop: a real table. Hidden on small screens — see DetailCards. */
function DetailTable({ rows, totals }: { rows: ClosingDetailRow[]; totals: ClosingDetailsTotals }) {
  return (
    <div className="hidden md:block">
      <table className="w-full table-fixed border-collapse text-left text-xs">
        <thead>
          <tr className="bg-[#0B0B0B] text-white">
            <th className="w-[7%] px-3 py-2 font-bold">Dist.</th>
            <th className="w-[10%] px-3 py-2 font-bold">Area</th>
            <th className="w-[12%] px-3 py-2 font-bold">Brick</th>
            <th className="w-[20%] px-3 py-2 font-bold">Customer</th>
            <th className="w-[14%] px-3 py-2 font-bold">Product</th>
            <th className="w-[8%] px-3 py-2 text-right font-bold">Qty</th>
            <th className="w-[9%] px-3 py-2 text-right font-bold">Eff. Units</th>
            <th className="w-[11%] px-3 py-2 text-right font-bold">Value</th>
            <th className="w-[9%] px-3 py-2 font-bold">In Closing</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className={`border-b border-slate-100 ${countsInClosingHeadline(row) ? "" : "bg-amber-50/70"}`}
              key={row.id}
            >
              <td className="truncate px-3 py-2 font-semibold text-slate-700">{row.distributorCode}</td>
              <td className="truncate px-3 py-2 text-slate-700" title={`${row.areaName} (${row.areaCode})`}>
                {row.areaName}
              </td>
              <td className="truncate px-3 py-2 text-slate-600" title={`${row.brickName} (${row.brickId})`}>
                {row.brickName || row.brickId}
                {row.brickUnmapped ? <span className="ml-1 text-rose-600">·unmapped</span> : null}
                {row.areaMismatch ? <span className="ml-1 text-violet-600">·area≠</span> : null}
              </td>
              <td className="truncate px-3 py-2 text-slate-600" title={row.clientName}>
                {row.clientName || <span className="text-slate-400">— no customer —</span>}
              </td>
              <td className="truncate px-3 py-2 text-slate-600">{row.productName}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtUnits(row.qty)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtValue(row.effectiveUnits)}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmtValue(row.salesValue)}</td>
              {/* "In Closing" answers whether this row's money is in the headline. A direct row is
                  in it — it reaches the grid from the Direct Orders module rather than as an
                  invoice line, which is what the "direct" label says. Only a confidential product
                  is genuinely out. */}
              <td className="px-3 py-2">
                {countsInClosingHeadline(row) ? (
                  <span className="font-bold text-emerald-700">
                    {row.isDirect ? "Yes · direct" : "Yes"}
                  </span>
                ) : (
                  <span className="font-semibold text-amber-700">{row.exclusions.join(", ")}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-[#FDE7C7] font-bold text-slate-900">
            <td className="px-3 py-2" colSpan={5}>
              Page + filter total ({fmtUnits(totals.rows)} rows)
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtUnits(totals.units)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtValue(totals.effectiveUnits)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtValue(totals.salesValue)}</td>
            <td className="px-3 py-2" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Mobile: cards, never a horizontally scrolling table. */
function DetailCards({ rows }: { rows: ClosingDetailRow[] }) {
  return (
    <div className="space-y-2 px-4 md:hidden">
      {rows.map((row) => (
        <div
          className={`rounded-2xl border p-3 ${countsInClosingHeadline(row) ? "border-slate-200 bg-white" : "border-amber-200 bg-amber-50/70"}`}
          key={row.id}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-bold text-slate-900">{row.clientName || "— no customer —"}</p>
            <span className="shrink-0 text-xs font-bold text-slate-500">{row.distributorCode}</span>
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            {row.areaName} · {row.brickName || row.brickId}
          </p>
          <p className="mt-1 text-xs font-semibold text-slate-700">{row.productName}</p>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-phx-2xs font-bold uppercase text-slate-400">Qty</dt>
              <dd className="font-bold tabular-nums text-slate-800">{fmtUnits(row.qty)}</dd>
            </div>
            <div>
              <dt className="text-phx-2xs font-bold uppercase text-slate-400">Eff.</dt>
              <dd className="font-bold tabular-nums text-slate-800">{fmtValue(row.effectiveUnits)}</dd>
            </div>
            <div>
              <dt className="text-phx-2xs font-bold uppercase text-slate-400">Value</dt>
              <dd className="font-bold tabular-nums text-slate-800">{fmtValue(row.salesValue)}</dd>
            </div>
          </dl>
          {countsInClosingHeadline(row) ? (
            row.isDirect ? (
              <p className="mt-2 text-xs font-semibold text-blue-700">In closing · direct order</p>
            ) : null
          ) : (
            <p className="mt-2 text-xs font-semibold text-amber-700">
              Excluded: {row.exclusions.join(", ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
