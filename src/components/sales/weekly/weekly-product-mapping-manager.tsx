"use client";

import { AlertTriangle, Download, Loader2, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { WeeklyAliasKind, WeeklyProductAliasAdmin } from "@/lib/sales/weekly/product-aliases";
import { SearchableSelect } from "@/components/ui/searchable-select";


type Draft = { alias: string; aliasKind: WeeklyAliasKind; productCode: string };

const EMPTY_DRAFT: Draft = { alias: "", aliasKind: "code", productCode: "" };

export function WeeklyProductMappingManager({
  initial,
  initialError,
}: {
  initial: WeeklyProductAliasAdmin | null;
  initialError: string | null;
}) {
  const [data, setData] = useState<WeeklyProductAliasAdmin | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [distributor, setDistributor] = useState<string>(initial?.distributors[0]?.code ?? "IS");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Defer the loading flag off the synchronous effect tick (avoids cascading-render lint).
      await Promise.resolve();
      if (cancelled) return;
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/sales/weekly/product-mapping?distributor=${encodeURIComponent(distributor)}`, { cache: "no-store" });
        const payload = (await response.json()) as { success?: boolean; data?: WeeklyProductAliasAdmin; error?: string };
        if (cancelled) return;
        if (payload?.success && payload.data) setData(payload.data);
        else setError(payload?.error ?? "Failed to load product mapping.");
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load product mapping.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [distributor]);

  async function mutate(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/sales/weekly/product-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ distributorCode: distributor, ...body }),
      });
      const payload = (await response.json()) as { success?: boolean; data?: WeeklyProductAliasAdmin; error?: string };
      if (payload?.success && payload.data) {
        setData(payload.data);
        return true;
      }
      setError(payload?.error ?? "Save failed.");
      return false;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addDraft() {
    if (!draft.alias.trim() || !draft.productCode) {
      setError("Enter the distributor alias and pick the master product.");
      return;
    }
    const ok = await mutate({ alias: draft.alias.trim(), aliasKind: draft.aliasKind, productCode: draft.productCode });
    if (ok) setDraft((prev) => ({ ...EMPTY_DRAFT, aliasKind: prev.aliasKind }));
  }

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("distributorCode", distributor);
      const response = await fetch("/api/sales/weekly/product-mapping", { method: "POST", body: form });
      const payload = (await response.json()) as {
        success?: boolean;
        data?: WeeklyProductAliasAdmin;
        error?: string;
        message?: string;
        result?: { blockedRows?: { rowNumber: number; reason: string }[] };
      };
      if (payload?.data) setData(payload.data);
      if (payload?.success) {
        setNotice(payload.message ?? "Mapping imported.");
      } else {
        const blocked = payload?.result?.blockedRows ?? [];
        setError(
          blocked.length
            ? `${payload?.error ?? "Import blocked."} First issue — row ${blocked[0].rowNumber}: ${blocked[0].reason}`
            : payload?.error ?? "Import failed.",
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const products = useMemo(() => data?.products ?? [], [data]);
  const aliases = data?.aliases ?? [];
  const templateHref = `/api/sales/weekly/product-mapping/template?distributor=${encodeURIComponent(distributor)}`;

  if (!data) {
    return (
      <div className="p-6">
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <span>{error ?? "Failed to load product mapping."}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-[#F97316]" aria-hidden />
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#F97316]">Weekly Sales</span>
        </div>
        <h1 className="mt-1 text-xl font-black text-[#0F172A]">Product Mapping</h1>
        <p className="mt-1 text-sm font-medium text-[#64748B]">
          Tell the system which master product each distributor code or name means. The weekly upload converts the
          distributor&apos;s own codes to your products using these aliases. Price and line come from the Source-of-Sales
          master — a product missing either will block an upload until it is fixed there.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && <div className="border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">{notice}</div>}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white p-3 shadow-sm">
        <span className="text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Distributor</span>
        <SearchableSelect
          className="h-9 min-w-[14rem] border border-[#E2E8F0] bg-white px-2 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
          disabled={busy}
          value={distributor}
          onChange={(event) => {
            setDistributor(event.target.value);
            setDraft(EMPTY_DRAFT);
          }}
        >
          {data.distributors.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name} ({option.code})
            </option>
          ))}
        </SearchableSelect>
        <div className="ml-auto flex items-center gap-2">
          <a
            className="inline-flex h-9 items-center gap-1 rounded-[6px] border border-[#E2E8F0] px-3 text-xs font-bold text-[#334155] transition hover:border-[#FDBA74]"
            href={templateHref}
          >
            <Download className="h-4 w-4" /> Template
          </a>
          <button
            className="inline-flex h-9 items-center gap-1 rounded-[6px] border border-[#E2E8F0] px-3 text-xs font-bold text-[#334155] transition hover:border-[#FDBA74] disabled:opacity-60"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            type="button"
          >
            <Upload className="h-4 w-4" /> Upload filled
          </button>
          <input ref={fileInput} className="hidden" type="file" accept=".xlsx" onChange={onUpload} />
        </div>
      </div>

      {/* Add row */}
      <div className="flex flex-wrap items-end gap-2 rounded-[6px] border border-[#E2E8F0] bg-white p-3 shadow-sm">
        <Field label="Distributor alias (code or name)">
          <input
            className="h-9 w-64 border border-[#E2E8F0] px-2 text-sm text-[#0F172A] outline-none focus:border-[#FDBA74]"
            disabled={busy}
            onChange={(event) => setDraft((prev) => ({ ...prev, alias: event.target.value }))}
            placeholder="e.g. 607294 or ROYAFLOXACIN 500 TAB"
            value={draft.alias}
          />
        </Field>
        <Field label="Kind">
          <SearchableSelect
            className="h-9 w-28 border border-[#E2E8F0] bg-white px-2 text-sm font-semibold text-[#0F172A] outline-none focus:border-[#FDBA74]"
            disabled={busy}
            onChange={(event) => setDraft((prev) => ({ ...prev, aliasKind: event.target.value === "name" ? "name" : "code" }))}
            value={draft.aliasKind}
          >
            <option value="code">Code</option>
            <option value="name">Name</option>
          </SearchableSelect>
        </Field>
        <Field label="Master product">
          <SearchableSelect
            className="h-9 w-72 border border-[#E2E8F0] bg-white px-2 text-sm font-semibold text-[#0F172A] outline-none focus:border-[#FDBA74]"
            disabled={busy}
            onChange={(event) => setDraft((prev) => ({ ...prev, productCode: event.target.value }))}
            value={draft.productCode}
          >
            <option value="">Select…</option>
            {products.map((product) => (
              <option key={product.code} value={product.code}>
                {product.name} ({product.code}){product.priced && product.lined ? "" : " ⚠"}
              </option>
            ))}
          </SearchableSelect>
        </Field>
        <button
          className="inline-flex h-9 items-center gap-1 rounded-[6px] bg-[#F97316] px-4 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:opacity-60"
          disabled={busy}
          onClick={addDraft}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add alias
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-[#020617] text-left text-[11px] font-black uppercase tracking-wide text-white">
            <tr>
              <th className="px-3 py-2">Distributor alias</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Master product</th>
              <th className="px-3 py-2 text-right" />
            </tr>
          </thead>
          <tbody>
            {aliases.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-center text-[#94A3B8]" colSpan={4}>
                  No aliases yet — add one above or upload the template.
                </td>
              </tr>
            )}
            {aliases.map((alias) => (
              <tr className="border-t border-[#FFE8D6] align-middle" key={alias.id}>
                <td className="px-3 py-2 font-semibold text-[#0F172A]">{alias.alias}</td>
                <td className="px-3 py-2 text-[#64748B]">{alias.aliasKind}</td>
                <td className="px-3 py-2">
                  <span className="font-semibold text-[#0F172A]">{alias.productName}</span>
                  <span className="ml-1 text-[11px] font-medium text-[#94A3B8]">{alias.productCode}</span>
                  {!alias.resolvable && (
                    <span className="ml-2 inline-flex items-center gap-1 bg-amber-100 px-2 py-0.5 text-[10px] font-black uppercase text-amber-700">
                      <AlertTriangle className="h-3 w-3" /> fix price/line in master
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    className="inline-flex items-center gap-1 border border-[#E2E8F0] px-2 py-1 text-xs font-bold text-[#B91C1C] transition hover:border-[#FCA5A5]"
                    disabled={busy}
                    onClick={() => void mutate({ action: "delete", id: alias.id })}
                    type="button"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">{label}</span>
      {children}
    </label>
  );
}
