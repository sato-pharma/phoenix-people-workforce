"use client";

import { AlertTriangle, CheckCircle2, Download, Loader2, UploadCloud, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { HeaderGrid } from "@/lib/sales/normalizer/profile-grid";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type CustomerRow = {
  address: string;
  areaCode: string;
  brickId: string;
  customerCode: string;
  customerName: string;
  distributorCode: string;
  regionCode: string;
};

type ImportBlockedRow = { key: string; reason: string; row: number };
type ImportResult = { blockedRows: ImportBlockedRow[]; inserted: number; skipped: number; totalRead: number; updated: number };

const filterSelect = "h-9 rounded-lg border border-[#D8E0EA] bg-white px-2 text-xs font-semibold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";
const PAGE = 100;

export function DatabaseValidationTab({ headerGrid }: { headerGrid: HeaderGrid }) {
  const distributors = headerGrid.rows.map((r) => ({ code: r.distributorCode, name: r.distributorName }));
  const [headerFilter, setHeaderFilter] = useState("ALL");
  const [custFilter, setCustFilter] = useState(distributors[0]?.code ?? "ALL");
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loadingCust, setLoadingCust] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [custError, setCustError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingCust(true); setCustError(null); setPage(0);
      try {
        const url = custFilter === "ALL"
          ? "/api/sales/database-mapping/validation/customer-map"
          : `/api/sales/database-mapping/validation/customer-map?distributor=${encodeURIComponent(custFilter)}`;
        const res = await fetch(url);
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setCustomers(json.data as CustomerRow[]);
        else { setCustError(json.error ?? "Failed to load customers."); setCustomers([]); }
      } catch (e) {
        if (!cancelled) { setCustError(e instanceof Error ? e.message : "Failed to load customers."); setCustomers([]); }
      } finally {
        if (!cancelled) setLoadingCust(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [custFilter, refreshTick]);

  async function exportCustomers() {
    setExporting(true);
    try {
      const url = custFilter === "ALL"
        ? "/api/sales/database-mapping/validation/customer-map/export"
        : `/api/sales/database-mapping/validation/customer-map/export?distributor=${encodeURIComponent(custFilter)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `phoenix-customer-map-${custFilter}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    } catch { /* surfaced by the disabled state; non-fatal */ } finally { setExporting(false); }
  }

  async function importCustomers(file: File) {
    setImporting(true); setImportMsg(null); setImportResult(null); setCustError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/sales/database-mapping/validation/customer-map/import", { body: form, method: "POST" });
      const json = await res.json();
      if (json.success) {
        setImportResult(json.data as ImportResult);
        setImportMsg(json.message ?? "Import complete.");
        setRefreshTick((tick) => tick + 1);
      } else {
        setCustError(json.error ?? "Import failed.");
      }
    } catch (e) {
      setCustError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const headerRows = headerFilter === "ALL" ? headerGrid.rows : headerGrid.rows.filter((r) => r.distributorCode === headerFilter);
  const pages = Math.max(1, Math.ceil(customers.length / PAGE));
  const pageRows = customers.slice(page * PAGE, page * PAGE + PAGE);

  return (
    <div className="space-y-6">
      <AdminTableShell
        action={(
          <SearchableSelect className={filterSelect} onChange={(e) => setHeaderFilter(e.target.value)} value={headerFilter}>
            <option value="ALL">All distributors</option>
            {distributors.map((d) => <option key={d.code} value={d.code}>{d.name} / {d.code}</option>)}
          </SearchableSelect>
        )}
        description="For each distributor, which raw column in their sheet feeds each Phoenix header. Area & Region are derived from the Brick; Distrub ID is the distributor's own code."
        title="Distributor → Phoenix header mapping"
      >
        <div className="overflow-x-auto p-4 md:p-5">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-[#0B0B0B] text-[#F1F5F9]">
                <th className="whitespace-nowrap px-3 py-2 text-left">Distributor</th>
                {headerGrid.columns.map((c) => <th className="whitespace-nowrap border-l border-[#F97316]/25 px-3 py-2 text-left" key={c.key}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {headerRows.map((r) => (
                <tr className="border-b border-[#F1D9C0]/50" key={r.distributorCode}>
                  <td className="whitespace-nowrap px-3 py-2 font-bold text-[#0B0B0B]">{r.distributorName} <span className="font-normal text-slate-400">/ {r.distributorCode}</span></td>
                  {headerGrid.columns.map((c) => {
                    const v = r.cells[c.key] ?? "—";
                    const muted = v === "—" || v.startsWith("auto") || v === "via Customer map" || v === "from sheet";
                    return <td className={cn("whitespace-nowrap border-l border-[#F1D9C0]/40 px-3 py-2", muted ? "italic text-slate-400" : "text-slate-700")} key={c.key}>{v}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      <AdminTableShell
        action={(
          <div className="flex items-center gap-2">
            <SearchableSelect className={filterSelect} onChange={(e) => setCustFilter(e.target.value)} value={custFilter}>
              <option value="ALL">All distributors</option>
              {distributors.map((d) => <option key={d.code} value={d.code}>{d.name} / {d.code}</option>)}
            </SearchableSelect>
            <Button className="gap-2" disabled={exporting || loadingCust || customers.length === 0} onClick={() => void exportCustomers()} variant="secondary">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export
            </Button>
            <input accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCustomers(f); }} ref={fileInputRef} type="file" />
            <Button className="gap-2" disabled={importing} onClick={() => fileInputRef.current?.click()}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />} Import
            </Button>
          </div>
        )}
        description="The customer → brick crosswalk: each distributor's customer code, name and address mapped to a Phoenix brick (used when the sheet's area text is unreliable)."
        title="Customer map (code / name / address → brick)"
      >
        <div className="p-4 md:p-5">
          {custError ? <AdminCallout tone="danger"><Users className="mt-0.5 h-4 w-4" /><p>{custError}</p></AdminCallout> : null}
          {importMsg ? (
            <div className="mb-4 space-y-3">
              <AdminCallout tone={importResult && importResult.blockedRows.length > 0 ? "warning" : "success"}>
                {importResult && importResult.blockedRows.length > 0 ? <AlertTriangle className="mt-0.5 h-4 w-4" /> : <CheckCircle2 className="mt-0.5 h-4 w-4" />}
                <p>{importMsg}</p>
              </AdminCallout>
              {importResult && importResult.blockedRows.length > 0 ? (
                <div className="overflow-x-auto border border-[#F0C9C9]">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-[#7F1D1D] text-[#FEE2E2]">
                        {["Row", "Key", "Reason"].map((h) => <th className="whitespace-nowrap border-l border-white/20 px-3 py-2 text-left" key={h}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {importResult.blockedRows.slice(0, 200).map((b, i) => (
                        <tr className="border-b border-[#F1D9C0]/50" key={`${b.row}:${i}`}>
                          <td className="border-l border-[#F1D9C0]/40 px-3 py-2 text-slate-500">{b.row}</td>
                          <td className="border-l border-[#F1D9C0]/40 px-3 py-2 font-semibold text-[#0B0B0B]">{b.key}</td>
                          <td className="border-l border-[#F1D9C0]/40 px-3 py-2 text-[#991B1B]">{b.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {importResult.blockedRows.length > 200 ? <p className="px-3 py-2 text-xs text-slate-500">Showing first 200 of {importResult.blockedRows.length} blocked rows.</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {loadingCust ? (
            <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading customers…</div>
          ) : customers.length === 0 && !custError ? (
            <p className="text-sm text-slate-400">No customers mapped for this distributor yet.</p>
          ) : customers.length > 0 ? (
            <>
              <div className="overflow-x-auto border border-[#E2E8F0]">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-[#0B0B0B] text-[#F1F5F9]">
                      {["Distributor", "Customer code", "Customer name", "Address", "Brick ID", "Area", "Region"].map((h) => <th className="whitespace-nowrap border-l border-[#F97316]/25 px-3 py-2 text-left" key={h}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((c, i) => (
                      <tr className="border-b border-[#F1D9C0]/50" key={`${c.distributorCode}:${c.customerCode}:${i}`}>
                        <td className="border-l border-[#F1D9C0]/40 px-3 py-2 text-slate-500">{c.distributorCode}</td>
                        <td className="border-l border-[#F1D9C0]/40 px-3 py-2 font-semibold text-[#0B0B0B]">{c.customerCode}</td>
                        <td className="border-l border-[#F1D9C0]/40 px-3 py-2">{c.customerName || "—"}</td>
                        <td className="max-w-[280px] truncate border-l border-[#F1D9C0]/40 px-3 py-2" title={c.address}>{c.address || "—"}</td>
                        <td className="border-l border-[#F1D9C0]/40 px-3 py-2 font-semibold text-[#1D4ED8]">{c.brickId || "—"}</td>
                        <td className="border-l border-[#F1D9C0]/40 px-3 py-2 text-slate-500">{c.areaCode || "—"}</td>
                        <td className="border-l border-[#F1D9C0]/40 px-3 py-2 text-slate-500">{c.regionCode || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span>{customers.length.toLocaleString()} customer{customers.length === 1 ? "" : "s"}</span>
                {pages > 1 ? (
                  <div className="flex items-center gap-2">
                    <button className="border border-[#D8E0EA] px-2 py-1 font-semibold disabled:opacity-40" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} type="button">Prev</button>
                    <span>Page {page + 1} / {pages}</span>
                    <button className="border border-[#D8E0EA] px-2 py-1 font-semibold disabled:opacity-40" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} type="button">Next</button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </AdminTableShell>
    </div>
  );
}
