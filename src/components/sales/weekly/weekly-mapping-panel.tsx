"use client";

import { AlertTriangle, CheckCircle2, Download, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";

import type { WeeklyMappingAdmin, WeeklyMappingRow } from "@/lib/sales/weekly/mapping";
import { SearchableSelect } from "@/components/ui/searchable-select";


export function WeeklyMappingPanel({ initialData }: { initialData: WeeklyMappingAdmin }) {
  const [data, setData] = useState(initialData);
  const [distributorCode, setDistributorCode] = useState(initialData.distributorCode);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function loadDistributor(code: string) {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/sales/weekly/mapping?distributor=${encodeURIComponent(code)}`, { cache: "no-store" });
      const payload = (await res.json()) as { success?: boolean; data?: WeeklyMappingAdmin };
      if (payload.success && payload.data) {
        setData(payload.data);
        setDistributorCode(payload.data.distributorCode);
      }
    } catch {
      /* keep current data on load error */
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    try {
      const res = await fetch(`/api/sales/weekly/mapping?distributor=${encodeURIComponent(distributorCode)}`, { cache: "no-store" });
      const payload = (await res.json()) as { success?: boolean; data?: WeeklyMappingAdmin };
      if (payload.success && payload.data) setData(payload.data);
    } catch {
      /* keep current data on refresh error */
    }
  }

  function downloadMapping() {
    window.location.href = `/api/sales/weekly/mapping/export?distributor=${encodeURIComponent(distributorCode)}`;
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("distributor", distributorCode);
      form.append("file", file);
      const res = await fetch("/api/sales/weekly/mapping/import", { method: "POST", body: form });
      const payload = (await res.json()) as {
        success?: boolean;
        message?: string;
        error?: string;
        result?: { blockedRows?: { reason: string }[] };
      };
      if (!payload.success) {
        setMessage({ type: "err", text: payload.error ?? "Upload failed." });
      } else {
        const blocked = payload.result?.blockedRows ?? [];
        const detail = blocked.length > 0 ? ` First issue: ${blocked[0].reason}` : "";
        setMessage({ type: blocked.length > 0 ? "err" : "ok", text: `${payload.message ?? "Mapping saved."}${detail}` });
        await refresh();
      }
    } catch (caught) {
      setMessage({ type: "err", text: caught instanceof Error ? caught.message : "Upload failed." });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      {/* Distributor picker + actions */}
      <div className="rounded-[6px] border border-[#E2E8F0] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block w-72 max-w-full">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">Distributor</span>
            <SearchableSelect
              className="h-9 w-full rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-sm font-bold text-[#0F172A] shadow-sm outline-none transition focus:border-[#FDBA74] disabled:opacity-60"
              disabled={loading || uploading}
              onChange={(e) => loadDistributor(e.target.value)}
              value={distributorCode}
            >
              {data.distributors.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name}
                </option>
              ))}
            </SearchableSelect>
          </label>
          {loading && (
            <span className="inline-flex items-center gap-2 pb-2 text-xs font-semibold text-[#94A3B8]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[#F1F5F9] pt-4">
          <button
            className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-sm font-black text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] disabled:opacity-60"
            disabled={loading || uploading}
            onClick={downloadMapping}
            type="button"
          >
            <Download className="h-4 w-4" />
            Download Mapping
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-[6px] bg-[#F97316] px-4 text-sm font-black text-white shadow-sm transition hover:bg-[#EA6A0C] disabled:opacity-60"
            disabled={loading || uploading}
            onClick={() => fileRef.current?.click()}
            type="button"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload Mapping
          </button>
          <input
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
            ref={fileRef}
            type="file"
          />
          <span className="text-[11px] font-bold text-[#94A3B8]">
            {data.product.length} product · {data.region.length} region mapping{data.region.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* Feedback */}
      {message && (
        <div
          className={`flex items-start gap-2 rounded-[6px] p-3 text-sm font-semibold shadow-sm ${
            message.type === "ok"
              ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {message.type === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span>{message.text}</span>
        </div>
      )}

      {/* Current mappings */}
      <MappingTable title="Product mapping" emptyHint="No product mappings yet. Download, fill, and upload." rows={data.product} />
      <MappingTable title="Region mapping" emptyHint="No region mappings yet. Download, fill, and upload." rows={data.region} />
    </div>
  );
}

function MappingTable({ title, emptyHint, rows }: { title: string; emptyHint: string; rows: WeeklyMappingRow[] }) {
  return (
    <section className="overflow-hidden rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
        <span className="text-xs font-black uppercase tracking-wide text-[#64748B]">{title}</span>
        <span className="rounded-[4px] border border-[#E2E8F0] bg-white px-2 py-1 text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">
          {rows.length} rows
        </span>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-[#020617] text-left text-[10px] font-black uppercase text-white">
            <tr>
              <th className="px-3 py-2">Raw Value (from file)</th>
              <th className="px-3 py-2">Official Code</th>
              <th className="px-3 py-2">Official Name</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-5 text-center text-[#94A3B8]" colSpan={3}>
                  {emptyHint}
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr className="border-t border-[#F1F5F9] transition hover:bg-[#FFF7ED]" key={row.id}>
                <td className="px-3 py-2 text-xs text-[#0F172A]">{row.rawValue}</td>
                <td className="px-3 py-2 font-bold text-[#F97316]">{row.officialCode}</td>
                <td className="px-3 py-2 text-[#334155]">{row.officialName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
