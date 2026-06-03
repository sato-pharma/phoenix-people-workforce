"use client";

import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Database,
  Download,
  LayoutGrid,
  Loader2,
  Map as MapIcon,
  MapPin,
  Package,
  RefreshCw,
  Truck,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminTableShell } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import {
  MASTER_DEFINITIONS,
  MASTER_ORDER,
  normalizeCode,
  normalizeDisplay,
  type MasterColumnType,
  type MasterDefinition,
  type MasterKey,
  type MasterRowRecord,
} from "@/lib/sales/master-data/definitions";
import type { MasterImportResult } from "@/lib/sales/master-data/import-service";
import { cn } from "@/lib/utils";

const MASTER_ICONS: Record<MasterKey, LucideIcon> = {
  areas: MapPin,
  blocks: LayoutGrid,
  bricks: Boxes,
  distributors: Truck,
  products: Package,
  regions: MapIcon,
};

type Props = {
  initialError: string | null;
  initialRows: Record<MasterKey, MasterRowRecord[]>;
};

type ImportResponse = { data?: MasterImportResult; error?: string; message?: string; success: boolean };
type ListResponse = { data?: MasterRowRecord[]; error?: string; success: boolean };

const tableHeaderClassName = "px-4 py-3 text-xs font-black uppercase tracking-[0.14em]";

async function readJson<T extends { error?: string; success: boolean }>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return { success: response.ok, error: response.ok ? undefined : response.statusText } as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { success: false, error: text } as T;
  }
}

function displayCell(column: { key: string; type: MasterColumnType }, row: MasterRowRecord) {
  const value = row[column.key];
  if (value === null || value === undefined || value === "") return "-";
  if (column.type === "number") return formatCurrency(Number(value));
  return String(value);
}

function MasterTab({
  allRows,
  def,
  onRowsChange,
  rows,
}: {
  allRows: Record<MasterKey, MasterRowRecord[]>;
  def: MasterDefinition;
  onRowsChange: (rows: MasterRowRecord[]) => void;
  rows: MasterRowRecord[];
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<MasterImportResult | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);

  const editableLabels = def.columns.filter((column) => !column.locked).map((column) => column.label);
  const showHierarchyHint = def.parents.length > 0;
  const lookups = def.displayLookups;

  // Build code -> row maps for each referenced parent master so parent NAMES
  // can be resolved for display (the rows store only codes, not names).
  const referenceMaps = useMemo(() => {
    const maps = new Map<MasterKey, Map<string, MasterRowRecord>>();
    for (const lookup of lookups) {
      if (maps.has(lookup.lookupMaster)) continue;
      const parentDef = MASTER_DEFINITIONS[lookup.lookupMaster];
      const byCode = new Map<string, MasterRowRecord>();
      for (const parentRow of allRows[lookup.lookupMaster] ?? []) {
        byCode.set(normalizeCode(parentRow[parentDef.keyColumn]), parentRow);
      }
      maps.set(lookup.lookupMaster, byCode);
    }
    return maps;
  }, [allRows, lookups]);

  function resolveLookup(row: MasterRowRecord, lookup: (typeof lookups)[number]) {
    const parentRow = referenceMaps.get(lookup.lookupMaster)?.get(normalizeCode(row[lookup.viaCodeColumn]));
    const value = parentRow ? normalizeDisplay(parentRow[lookup.lookupColumn]) : "";
    return value || "-";
  }

  async function handleExport() {
    setExporting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/sales/database-mapping/${def.master}/export`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await readJson<ListResponse>(response);
        setMessage({ type: "error", text: payload.error ?? "Export failed." });
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `phoenix-${def.master}-master.xlsx`;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Export failed." });
    } finally {
      setExporting(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/sales/database-mapping/${def.master}`, { cache: "no-store" });
      const payload = await readJson<ListResponse>(response);
      if (payload.success) onRowsChange(payload.data ?? []);
      else setMessage({ type: "error", text: payload.error ?? "Failed to refresh rows." });
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Failed to refresh rows." });
    } finally {
      setRefreshing(false);
    }
  }

  async function handleImport(file: File) {
    setImporting(true);
    setMessage(null);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`/api/sales/database-mapping/${def.master}/import`, {
        body: formData,
        method: "POST",
      });
      const payload = await readJson<ImportResponse>(response);
      if (payload.success && payload.data) {
        setResult(payload.data);
        setMessage({ type: "success", text: payload.message ?? "Import complete." });
        await refresh();
      } else {
        setMessage({ type: "error", text: payload.error ?? "Import failed." });
      }
    } catch (caught) {
      setMessage({ type: "error", text: caught instanceof Error ? caught.message : "Import failed." });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-5">
      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button className="gap-2" disabled={refreshing} onClick={() => void refresh()} variant="secondary">
              {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
            <Button className="gap-2" disabled={exporting} onClick={() => void handleExport()} variant="secondary">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export XLSX
            </Button>
            <Button
              className="gap-2 bg-[#0B0B0B] text-white hover:bg-[#F97316]"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Import XLSX
            </Button>
            <input
              accept=".xlsx"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleImport(file);
              }}
              ref={fileInputRef}
              type="file"
            />
          </div>
        )}
        description={def.description}
        title={def.label}
      >
        <div className="space-y-4 p-4 md:p-5">
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Rows: {formatNumber(rows.length)}</AdminInsightChip>
            <AdminInsightChip tone="orange">
              Editable: {editableLabels.length > 0 ? editableLabels.join(", ") : "none (add-only)"}
            </AdminInsightChip>
          </div>

          {showHierarchyHint ? (
            <AdminCallout tone="neutral">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              <p>Import the masters top-down so parents exist first: Region → Area → Block → Brick.</p>
            </AdminCallout>
          ) : null}

          {message ? (
            <AdminCallout tone={message.type === "success" ? "success" : "danger"}>
              {message.type === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4" />
              )}
              <p>{message.text}</p>
            </AdminCallout>
          ) : null}

          {result ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ResultStat label="Rows Read" value={formatNumber(result.totalRead)} />
              <ResultStat label="Added" tone="good" value={formatNumber(result.inserted)} />
              <ResultStat label="Updated" tone="good" value={formatNumber(result.updated)} />
              <ResultStat label="Unchanged" value={formatNumber(result.skipped)} />
              <ResultStat
                label="Blocked"
                tone={result.blockedRows.length > 0 ? "bad" : "good"}
                value={formatNumber(result.blockedRows.length)}
              />
            </div>
          ) : null}
        </div>
      </AdminTableShell>

      {result && result.blockedRows.length > 0 ? (
        <AdminTableShell description="Fix these rows in the workbook and re-import." title="Blocked Rows">
          <div className="overflow-x-auto p-4 md:p-5">
            <div className="overflow-hidden rounded-[16px] border border-[#E2E8F0]">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr>
                    <th className={tableHeaderClassName}>Row</th>
                    <th className={tableHeaderClassName}>Key</th>
                    <th className={tableHeaderClassName}>Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2E8F0]">
                  {result.blockedRows.slice(0, 200).map((blocked, index) => (
                    <tr className="text-[#64748B]" key={`${blocked.row}:${blocked.key}:${index}`}>
                      <td className="px-4 py-3 font-semibold text-[#0F172A]">{blocked.row}</td>
                      <td className="px-4 py-3">{blocked.key || "-"}</td>
                      <td className="px-4 py-3">{blocked.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </AdminTableShell>
      ) : null}

      <AdminTableShell description={`Live rows currently stored in ${def.table}.`} title={`${def.label} Rows`}>
        <div className="overflow-x-auto p-4 md:p-5">
          <div className="overflow-hidden rounded-[16px] border border-[#E2E8F0]">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr>
                  {def.columns.map((column) => (
                    <th className={tableHeaderClassName} key={column.key}>
                      {column.label}
                      {column.locked ? " 🔒" : ""}
                    </th>
                  ))}
                  {lookups.map((column) => (
                    <th className={tableHeaderClassName} key={column.key}>
                      {column.label}
                    </th>
                  ))}
                  <th className={tableHeaderClassName}>Active</th>
                  <th className={tableHeaderClassName}>Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {rows.map((row) => (
                  <tr className="text-[#64748B]" key={String(row[def.keyColumn])}>
                    {def.columns.map((column, columnIndex) => (
                      <td
                        className={cn("px-4 py-2.5 align-top", columnIndex === 0 ? "font-semibold text-[#0F172A]" : "")}
                        key={column.key}
                      >
                        {displayCell(column, row)}
                      </td>
                    ))}
                    {lookups.map((column) => (
                      <td className="px-4 py-2.5 align-top text-[#475569]" key={column.key}>
                        {resolveLookup(row, column)}
                      </td>
                    ))}
                    <td className="px-4 py-2.5">
                      <Badge variant={row.active === false ? "neutral" : "success"}>
                        {row.active === false ? "Inactive" : "Active"}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {row.updated_at ? new Date(String(row.updated_at)).toLocaleString() : "-"}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-sm font-semibold text-[#64748B]" colSpan={def.columns.length + lookups.length + 2}>
                      No rows yet. Export the template, fill it in, then import.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </AdminTableShell>
    </div>
  );
}

function ResultStat({ label, tone = "neutral", value }: { label: string; tone?: "neutral" | "good" | "bad"; value: string }) {
  const tones = {
    bad: "border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]",
    good: "border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]",
    neutral: "border-[#E2E8F0] bg-[#FCFDFE] text-[#0F172A]",
  };
  return (
    <div className={cn("rounded-2xl border p-4", tones[tone])}>
      <p className="text-[10px] font-black uppercase tracking-[0.18em] opacity-70">{label}</p>
      <p className="mt-2 text-2xl font-black tracking-tight">{value}</p>
    </div>
  );
}

export function DatabaseMappingWorkspace({ initialError, initialRows }: Props) {
  const [rowsByMaster, setRowsByMaster] = useState(initialRows);
  const [activeTab, setActiveTab] = useState<MasterKey>(MASTER_ORDER[0]);

  if (initialError) {
    return (
      <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[#F8FAFC] p-5 sm:p-6 xl:p-8">
        <AdminCallout tone="danger">
          <AlertTriangle className="h-4 w-4" />
          <p>{initialError}</p>
        </AdminCallout>
      </div>
    );
  }

  const activeDef = MASTER_DEFINITIONS[activeTab];

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <div className="relative overflow-hidden rounded-3xl border border-[#D8E0EA] bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
          <div className="relative flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
                <Database className="h-3.5 w-3.5 text-orange-600" />
                <span className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Source of Sales</span>
              </div>
              <h1 className="text-3xl font-black tracking-tight text-slate-950">Database Mapping</h1>
              <p className="mt-1 max-w-3xl text-sm text-slate-500">
                Export, edit and import the master tables that drive all Source of Sales mapping. Key and name columns are
                locked; import adds and updates rows but never deletes.
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Link href="/sales/import">
                <Button className="gap-2" variant="secondary">
                  <Database className="h-4 w-4" />
                  Source of Sales
                </Button>
              </Link>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 rounded-2xl border border-[#D8E0EA] bg-white/90 p-2 shadow-[0_14px_32px_rgba(15,23,42,0.06)]">
          {MASTER_ORDER.map((master) => {
            const Icon = MASTER_ICONS[master];
            return (
              <Button
                className={cn(
                  "gap-2 rounded-xl font-black",
                  activeTab === master ? "bg-[#0B0B0B] text-white hover:bg-[#F97316]" : "",
                )}
                key={master}
                onClick={() => setActiveTab(master)}
                variant="secondary"
              >
                <Icon className="h-4 w-4" />
                {MASTER_DEFINITIONS[master].label}
              </Button>
            );
          })}
        </div>

        <MasterTab
          allRows={rowsByMaster}
          def={activeDef}
          onRowsChange={(rows) => setRowsByMaster((current) => ({ ...current, [activeTab]: rows }))}
          rows={rowsByMaster[activeTab]}
        />
      </div>
    </div>
  );
}
