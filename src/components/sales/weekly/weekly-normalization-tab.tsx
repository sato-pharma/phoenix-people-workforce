"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Save, Sparkles } from "lucide-react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { MappingCombobox } from "@/components/sales/source-of-sales-mapping-tab";
import { Button } from "@/components/ui/button";

type MissingProduct = { distributorCode: string; distributorName: string; itemCode: string; itemName: string; rowCount: number };
const keyOf = (r: { distributorCode: string; itemCode: string }) => `${r.distributorCode}||${r.itemCode}`;
const headRow = "sticky top-0 bg-[#020617] text-left text-[11px] font-black uppercase tracking-[0.12em] text-white";

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { return { success: false, error: text } as unknown as T; }
}

// Weekly counterpart of the monthly Normalizer: surfaces the weekly item codes that don't resolve to
// a Phoenix product, AI-suggests matches, and saves them to the SAME weekly mapping dictionary uploads
// read — so once mapped, future weekly uploads auto-code.
export function WeeklyNormalizationTab({ products, aiEnabled }: { products: { code: string; name: string }[]; aiEnabled: boolean }) {
  const [rows, setRows] = useState<MissingProduct[]>([]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busyAi, setBusyAi] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/sales/weekly/missing-products");
      const payload = await readJson<{ success: boolean; data?: MissingProduct[]; error?: string }>(res);
      if (!payload.success) { setError(payload.error ?? "Failed to load."); return; }
      setRows(payload.data ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load."); }
    finally { setLoading(false); }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  async function aiSuggestAll() {
    setBusyAi(true); setError(null); setMessage(null);
    try {
      const unknowns = rows.map((r) => ({ raw: r.itemCode, rawName: r.itemName }));
      const res = await fetch("/api/sales/weekly/ai-suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unknowns }) });
      const payload = await readJson<{ success: boolean; data?: { suggestions: { raw: string; code: string }[] }; error?: string }>(res);
      if (!payload.success || !payload.data) { setError(payload.error ?? "AI suggestion failed."); return; }
      const byRaw = new Map(payload.data.suggestions.map((s) => [s.raw, s.code]));
      setCodes((prev) => {
        const next = { ...prev };
        for (const r of rows) { const c = byRaw.get(r.itemCode); if (c) next[keyOf(r)] = c; }
        return next;
      });
      setMessage(`AI suggested ${payload.data.suggestions.length} match(es).`);
    } catch (e) { setError(e instanceof Error ? e.message : "AI suggestion failed."); }
    finally { setBusyAi(false); }
  }

  async function save() {
    const toSave = rows.filter((r) => (codes[keyOf(r)] ?? "").trim());
    if (toSave.length === 0) { setError("Fill at least one product before saving."); return; }
    setSaving(true); setError(null); setMessage(null);
    try {
      let ok = 0;
      for (const r of toSave) {
        const res = await fetch("/api/sales/weekly/product-mapping", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "upsert", distributorCode: r.distributorCode, alias: r.itemCode, aliasKind: "code", productCode: codes[keyOf(r)] }),
        });
        const payload = await readJson<{ success: boolean; error?: string }>(res);
        if (payload.success) ok += 1; else setError(payload.error ?? "Some mappings failed to save.");
      }
      setMessage(`${ok} weekly mapping(s) saved.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); }
    finally { setSaving(false); }
  }

  const filled = rows.filter((r) => (codes[keyOf(r)] ?? "").trim()).length;

  return (
    <div className="space-y-4">
      <AdminCallout tone="neutral">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
        <span>Weekly items that don&apos;t resolve to a Phoenix product. Let AI suggest matches (or pick manually), then save — they&apos;re remembered for every future weekly upload.</span>
      </AdminCallout>

      <div className="flex flex-wrap items-center gap-2">
        <Button className="h-9 gap-2" disabled={loading} onClick={() => void load()} type="button" variant="secondary">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Refresh</Button>
        {aiEnabled ? (
          <Button className="h-9 gap-2" disabled={busyAi || rows.length === 0} onClick={() => void aiSuggestAll()} type="button" variant="secondary">{busyAi ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}AI suggest all</Button>
        ) : null}
        <Button className="h-9 gap-2 bg-[#F97316] font-black text-white hover:bg-[#EA6A0C]" disabled={saving || filled === 0} onClick={() => void save()} type="button">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save {filled || ""} mapping{filled === 1 ? "" : "s"}</Button>
        <span className="text-xs text-[#64748B]">{rows.length} unmapped</span>
      </div>

      {error ? <AdminCallout tone="danger"><span>{error}</span></AdminCallout> : null}
      {message ? <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{message}</span></AdminCallout> : null}

      {rows.length === 0 && !loading ? (
        <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>No unmapped weekly products — everything resolves to a master product.</span></AdminCallout>
      ) : (
        <div className="overflow-auto rounded-2xl border border-[#E2E8F0]">
          <table className="w-full text-sm">
            <thead className={headRow}><tr><th className="px-4 py-2">Item</th><th className="px-4 py-2">Distributor</th><th className="px-4 py-2 text-right">Rows</th><th className="px-4 py-2">Phoenix Product</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr className="border-b border-[#FFE8D6]" key={keyOf(r)}>
                  <td className="px-4 py-2"><span className="block font-semibold text-[#0F172A]">{r.itemName || r.itemCode}</span><span className="block font-mono text-xs text-[#64748B]">{r.itemCode}</span></td>
                  <td className="px-4 py-2 text-[#64748B]">{r.distributorName} ({r.distributorCode})</td>
                  <td className="px-4 py-2 text-right tabular-nums text-[#64748B]">{r.rowCount}</td>
                  <td className="px-4 py-2"><div className="w-64"><MappingCombobox onChange={(c) => setCodes((p) => ({ ...p, [keyOf(r)]: c }))} options={products.map((p) => ({ code: p.code, name: p.name }))} placeholder="e.g. TE001" value={codes[keyOf(r)] ?? ""} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
