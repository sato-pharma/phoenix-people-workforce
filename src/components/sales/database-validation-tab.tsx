"use client";

import { AlertTriangle, CheckCircle2, Download, Loader2, UploadCloud, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { customerMapNames, type CustomerMapNameIndex, type CustomerMapNames, type ResolvedName } from "@/lib/sales/master-data/customer-map-names";
import type { HeaderGrid } from "@/lib/sales/normalizer/profile-grid";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxSelectClassName } from "@/components/ui/form-tokens";


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

const filterSelect = phxSelectClassName;
const PAGE = 100;

// The header grid fits by MERGING columns (fits-the-screen rule): thirteen nowrap columns ran far
// past a 669px content box, so the twelve Phoenix headers ride in five labelled groups beside the
// Distributor cell, which also carries Distrub ID (always the distributor's own code). A column
// added to HEADER_GRID_COLUMNS and missing here still shows, in the last group.
const HEADER_GRID_GROUPS: { keys: string[]; title: string }[] = [
  { keys: ["brick", "region", "area"], title: "Territory" },
  { keys: ["product"], title: "Product" },
  { keys: ["qty", "bonus"], title: "Quantity" },
  { keys: ["value", "discount", "date"], title: "Value & date" },
  { keys: ["customer", "customerName"], title: "Customer" },
];

type HeaderPair = { label: string; value: string };

const isDerivedHeaderValue = (v: string) => v === "—" || v.startsWith("auto") || v === "via Customer map" || v === "from sheet";

// Neighbours in one group that read the same value share a line: Region ID and Area ID are both
// "auto (from Brick)" for every distributor, so merging them costs no height. Both labels stay.
function headerPairs(keys: string[], cells: Record<string, string>, labelOf: Map<string, string>): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (const key of keys) {
    const label = labelOf.get(key);
    if (!label) continue;
    const value = cells[key] ?? "—";
    const last = pairs[pairs.length - 1];
    if (last && last.value === value && value !== "—") last.label = `${last.label} · ${label}`;
    else pairs.push({ label, value });
  }
  return pairs;
}

function HeaderPairs({ pairs }: { pairs: HeaderPair[] }) {
  return (
    <div className="space-y-1.5">
      {pairs.map((p) => (
        <div key={p.label}>
          <div className="break-words text-phx-sm font-semibold leading-snug text-slate-400">{p.label}</div>
          <div className={isDerivedHeaderValue(p.value) ? "break-words italic text-slate-400" : "break-words text-slate-700"}>{p.value}</div>
        </div>
      ))}
    </div>
  );
}

// Brick, area, region and distributor read as NAMES (customer-map-names.ts). A code the master does
// not know still shows, flagged, so a broken mapping is visible rather than blank. The customer code
// stays: it is the distributor's own account number, which the import matches on, with no name of
// its own beyond the customer name above it.
function MasterName({ value }: { value: ResolvedName }) {
  return (
    <>
      {value.name}
      {value.resolved ? null : <span className="text-phx-sm font-semibold text-[#991B1B]"> · not in the master</span>}
    </>
  );
}

function CustomerCell({ customer, names }: { customer: CustomerRow; names: CustomerMapNames }) {
  return (
    <>
      <p className="break-words font-semibold text-[#0B0B0B]">{customer.customerName || "—"}</p>
      <p className="mt-1 break-words text-slate-500"><span className="text-phx-sm font-semibold text-slate-400">Code</span> {customer.customerCode}</p>
      <p className="break-words text-slate-500"><span className="text-phx-sm font-semibold text-slate-400">Distributor</span> <MasterName value={names.distributor} /></p>
    </>
  );
}

function TerritoryCell({ names }: { names: CustomerMapNames }) {
  return (
    <>
      <p className="break-words font-semibold text-[#1D4ED8]"><MasterName value={names.brick} /></p>
      <p className="mt-1 break-words text-slate-500"><span className="text-phx-sm font-semibold text-slate-400">Area</span> <MasterName value={names.area} /></p>
      <p className="break-words text-slate-500"><span className="text-phx-sm font-semibold text-slate-400">Region</span> <MasterName value={names.region} /></p>
    </>
  );
}

export function DatabaseValidationTab({
  headerGrid,
  nameIndex,
  openingDistributor,
}: {
  headerGrid: HeaderGrid;
  nameIndex: CustomerMapNameIndex;
  openingDistributor: string;
}) {
  const distributors = headerGrid.rows.map((r) => ({ code: r.distributorCode, name: r.distributorName }));
  const [headerFilter, setHeaderFilter] = useState("ALL");
  // Opens on the first distributor with customers (pickOpeningCustomerDistributor), not an empty one.
  const [custFilter, setCustFilter] = useState(openingDistributor);
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
  const headerLabelOf = new Map(headerGrid.columns.map((c) => [c.key, c.label] as const));
  const groupedHeaderKeys = new Set(["distrub", ...HEADER_GRID_GROUPS.flatMap((g) => g.keys)]);
  const ungroupedHeaderKeys = headerGrid.columns.map((c) => c.key).filter((key) => !groupedHeaderKeys.has(key));
  const headerGroups = HEADER_GRID_GROUPS.map((g, i) => (i === HEADER_GRID_GROUPS.length - 1 ? { ...g, keys: [...g.keys, ...ungroupedHeaderKeys] } : g));
  const distrubLabel = headerLabelOf.get("distrub") ?? "Distrub ID";
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
        description="For each distributor, which raw column in their sheet feeds each Phoenix header. Area & Region are derived from the Brick; Distrub ID is the distributor's own code. Free-goods flag feeds no quantity: a row it marks is skipped whole, so a bonus count is never mapped there."
        title="Distributor → Phoenix header mapping"
      >
        <div className="p-4 md:p-5">
          {/* Desktop: six fitted columns, no horizontal scroller. */}
          <div className="hidden border border-phx-line md:block">
            <table className="w-full table-fixed border-collapse text-xs">
              <colgroup>
                <col className="w-[17%]" />
                <col className="w-[17%]" />
                <col className="w-[17%]" />
                <col className="w-[15%]" />
                <col className="w-[16%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead>
                <tr className="bg-[#0B0B0B] text-phx-paper-2">
                  <th className="break-words px-3 py-2 text-left align-bottom">Distributor</th>
                  {headerGroups.map((g) => <th className="break-words border-l border-phx-accent/25 px-3 py-2 text-left align-bottom" key={g.title}>{g.title}</th>)}
                </tr>
              </thead>
              <tbody>
                {headerRows.map((r) => (
                  <tr className="border-b border-[#F1D9C0]/50" key={r.distributorCode}>
                    <td className="break-words px-3 py-2 align-top">
                      <div className="font-bold text-[#0B0B0B]">{r.distributorName}</div>
                      <div className="mt-1.5 text-phx-sm font-semibold leading-snug text-slate-400">{distrubLabel}</div>
                      <div className="break-words text-slate-700">{r.cells.distrub ?? r.distributorCode}</div>
                    </td>
                    {headerGroups.map((g) => (
                      <td className="border-l border-[#F1D9C0]/40 px-3 py-2 align-top" key={g.title}>
                        <HeaderPairs pairs={headerPairs(g.keys, r.cells, headerLabelOf)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: one card per distributor, never the table. */}
          <div className="space-y-2 text-xs md:hidden">
            {headerRows.map((r) => (
              <div className="border border-phx-line bg-white p-3" key={r.distributorCode}>
                <p className="break-words text-sm font-bold text-[#0B0B0B]">{r.distributorName}</p>
                <p className="break-words text-phx-sm font-semibold text-slate-400">{distrubLabel} {r.cells.distrub ?? r.distributorCode}</p>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
                  {headerGroups.map((g) => (
                    <div className="min-w-0" key={g.title}>
                      <p className="mb-1 break-words text-phx-sm font-bold uppercase tracking-[0.12em] text-slate-500">{g.title}</p>
                      <HeaderPairs pairs={headerPairs(g.keys, r.cells, headerLabelOf)} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell
        action={(
          <div className="flex flex-wrap items-center gap-2">
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
                <div className="border border-[#F0C9C9]">
                  {/* Desktop: three fitted columns. Mobile: one card per blocked row, never the table. */}
                  <table className="hidden w-full table-fixed text-xs md:table">
                    <colgroup>
                      <col className="w-[12%]" />
                      <col className="w-[28%]" />
                      <col className="w-[60%]" />
                    </colgroup>
                    <thead>
                      <tr className="bg-[#7F1D1D] text-[#FEE2E2]">
                        {["Row", "Key", "Reason"].map((h) => <th className="break-words border-l border-white/20 px-3 py-2 text-left" key={h}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {importResult.blockedRows.slice(0, 200).map((b, i) => (
                        <tr className="border-b border-[#F1D9C0]/50" key={`${b.row}:${i}`}>
                          <td className="break-words border-l border-[#F1D9C0]/40 px-3 py-2 align-top text-slate-500">{b.row}</td>
                          <td className="break-words border-l border-[#F1D9C0]/40 px-3 py-2 align-top font-semibold text-[#0B0B0B]">{b.key}</td>
                          <td className="break-words border-l border-[#F1D9C0]/40 px-3 py-2 align-top text-[#991B1B]">{b.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="divide-y divide-[#F1D9C0]/60 text-xs md:hidden">
                    {importResult.blockedRows.slice(0, 200).map((b, i) => (
                      <div className="px-3 py-2" key={`${b.row}:${i}`}>
                        <p className="break-words font-semibold text-[#0B0B0B]"><span className="font-normal text-slate-500">Row {b.row} ·</span> {b.key}</p>
                        <p className="mt-1 break-words text-[#991B1B]">{b.reason}</p>
                      </div>
                    ))}
                  </div>
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
              {/* Desktop: seven columns merged into three, and the address wraps in full rather than
                  being cut short. Mobile: one card per customer, never the table. */}
              <div className="hidden border border-phx-line md:block">
                <table className="w-full table-fixed text-xs">
                  <colgroup>
                    <col className="w-[32%]" />
                    <col className="w-[43%]" />
                    <col className="w-[25%]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-[#0B0B0B] text-phx-paper-2">
                      {["Customer", "Address", "Brick · Area · Region"].map((h) => <th className="break-words border-l border-phx-accent/25 px-3 py-2 text-left" key={h}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((c, i) => {
                      const names = customerMapNames(nameIndex, c);
                      return (
                        <tr className="border-b border-[#F1D9C0]/50" key={`${c.distributorCode}:${c.customerCode}:${i}`}>
                          <td className="break-words border-l border-[#F1D9C0]/40 px-3 py-2 align-top"><CustomerCell customer={c} names={names} /></td>
                          <td className="break-words border-l border-[#F1D9C0]/40 px-3 py-2 align-top">{c.address || "—"}</td>
                          <td className="break-words border-l border-[#F1D9C0]/40 px-3 py-2 align-top"><TerritoryCell names={names} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2 text-xs md:hidden">
                {pageRows.map((c, i) => {
                  const names = customerMapNames(nameIndex, c);
                  return (
                    <div className="border border-phx-line bg-white p-3" key={`${c.distributorCode}:${c.customerCode}:${i}`}>
                      <CustomerCell customer={c} names={names} />
                      <p className="mt-2 break-words text-slate-700">{c.address || "—"}</p>
                      <div className="mt-2"><TerritoryCell names={names} /></div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span>{customers.length.toLocaleString()} customer{customers.length === 1 ? "" : "s"}</span>
                {pages > 1 ? (
                  <div className="flex items-center gap-2">
                    <button className="border border-phx-line px-2 py-1 font-semibold disabled:opacity-40" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} type="button">Prev</button>
                    <span>Page {page + 1} / {pages}</span>
                    <button className="border border-phx-line px-2 py-1 font-semibold disabled:opacity-40" disabled={page >= pages - 1} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} type="button">Next</button>
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
