"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { DirectOrderCapRow } from "@/lib/direct-orders/caps";

type ProductOption = { productCode: string; productName: string; publicPrice: number | null };

const GLOBAL = "__GLOBAL__";

async function postCaps(body: unknown): Promise<void> {
  const res = await fetch("/api/direct-orders/caps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
  if (!res.ok || !data.success) throw new Error(data.message || "Update failed.");
}

export function DirectOrderCapsManager({
  rows,
  canEdit,
  products,
}: {
  rows: DirectOrderCapRow[];
  canEdit: boolean;
  products: ProductOption[];
}) {
  const router = useRouter();
  const global = rows.find((r) => r.productCode === GLOBAL);
  const overrides = rows.filter((r) => r.productCode !== GLOBAL);

  const [gBonus, setGBonus] = useState(String(global?.bonusCapPct ?? 25));
  const [gDiscount, setGDiscount] = useState(String(global?.discountCapPct ?? 25));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // add-override state
  const [ovProduct, setOvProduct] = useState("");
  const [ovBonus, setOvBonus] = useState("");
  const [ovDiscount, setOvDiscount] = useState("");

  // public-price state
  const [ppProduct, setPpProduct] = useState("");
  const [ppValue, setPpValue] = useState("");

  async function run(fn: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(message);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "w-24 border border-slate-300 px-2 py-1 text-sm";
  const productName = (code: string) => products.find((p) => p.productCode === code)?.productName ?? code;

  return (
    <div className="space-y-6">
      {!canEdit ? (
        <p className="border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
          View-only. Only a System Admin can change these caps.
        </p>
      ) : null}
      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
      {ok ? <p className="text-sm font-semibold text-emerald-600">{ok}</p> : null}

      {/* Global caps */}
      <section className="border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-[11px] font-black uppercase tracking-wider text-slate-500">Global caps (default for every product)</h3>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="block text-[11px] font-bold text-slate-500">Bonus cap %</span>
            <input className={inputClass} value={gBonus} onChange={(e) => setGBonus(e.target.value)} disabled={!canEdit} />
          </label>
          <label className="text-sm">
            <span className="block text-[11px] font-bold text-slate-500">Discount cap %</span>
            <input className={inputClass} value={gDiscount} onChange={(e) => setGDiscount(e.target.value)} disabled={!canEdit} />
          </label>
          {canEdit ? (
            <button
              type="button"
              disabled={busy}
              className="bg-orange-500 px-3 py-1.5 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-50"
              onClick={() => run(() => postCaps({ action: "upsert", productCode: GLOBAL, bonusCapPct: Number(gBonus), discountCapPct: Number(gDiscount) }), "Global caps saved.")}
            >
              Save global caps
            </button>
          ) : null}
        </div>
      </section>

      {/* Per-product overrides */}
      <section className="border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-[11px] font-black uppercase tracking-wider text-slate-500">Per-product cap overrides</h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-[11px] font-black uppercase text-slate-500">
              <th className="px-2 py-1">Product</th>
              <th className="px-2 py-1">Bonus cap %</th>
              <th className="px-2 py-1">Discount cap %</th>
              {canEdit ? <th className="px-2 py-1"></th> : null}
            </tr>
          </thead>
          <tbody>
            {overrides.length === 0 ? (
              <tr><td className="px-2 py-3 text-slate-400" colSpan={4}>No per-product overrides — every product uses the global caps.</td></tr>
            ) : overrides.map((r) => (
              <tr key={r.productCode} className="border-b border-slate-100">
                <td className="px-2 py-1.5">{productName(r.productCode)} <span className="text-slate-400">({r.productCode})</span></td>
                <td className="px-2 py-1.5">{r.bonusCapPct ?? "—"}</td>
                <td className="px-2 py-1.5">{r.discountCapPct ?? "—"}</td>
                {canEdit ? (
                  <td className="px-2 py-1.5">
                    <button type="button" className="text-rose-600 hover:text-rose-700" disabled={busy}
                      onClick={() => run(() => postCaps({ action: "delete", productCode: r.productCode }), "Override removed.")}>Remove</button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {canEdit ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
            <label className="text-sm">
              <span className="block text-[11px] font-bold text-slate-500">Product</span>
              <select className="border border-slate-300 px-2 py-1 text-sm" value={ovProduct} onChange={(e) => setOvProduct(e.target.value)}>
                <option value="">Select…</option>
                {products.map((p) => <option key={p.productCode} value={p.productCode}>{p.productName}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className="block text-[11px] font-bold text-slate-500">Bonus cap %</span>
              <input className={inputClass} value={ovBonus} onChange={(e) => setOvBonus(e.target.value)} placeholder="(global)" /></label>
            <label className="text-sm"><span className="block text-[11px] font-bold text-slate-500">Discount cap %</span>
              <input className={inputClass} value={ovDiscount} onChange={(e) => setOvDiscount(e.target.value)} placeholder="(global)" /></label>
            <button type="button" disabled={busy || !ovProduct} className="bg-slate-800 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
              onClick={() => run(() => postCaps({ action: "upsert", productCode: ovProduct, bonusCapPct: ovBonus === "" ? null : Number(ovBonus), discountCapPct: ovDiscount === "" ? null : Number(ovDiscount) }), "Override saved.")}>
              Add / update override
            </button>
          </div>
        ) : null}
      </section>

      {/* Public prices (for discount mode) */}
      <section className="border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-[11px] font-black uppercase tracking-wider text-slate-500">Public prices (used by discount deals)</h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-[11px] font-black uppercase text-slate-500">
              <th className="px-2 py-1">Product</th>
              <th className="px-2 py-1">Public price</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.productCode} className="border-b border-slate-100">
                <td className="px-2 py-1.5">{p.productName} <span className="text-slate-400">({p.productCode})</span></td>
                <td className="px-2 py-1.5">{p.publicPrice == null ? <span className="text-rose-500">not set</span> : `${p.publicPrice} EGP`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {canEdit ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
            <label className="text-sm">
              <span className="block text-[11px] font-bold text-slate-500">Product</span>
              <select className="border border-slate-300 px-2 py-1 text-sm" value={ppProduct} onChange={(e) => setPpProduct(e.target.value)}>
                <option value="">Select…</option>
                {products.map((p) => <option key={p.productCode} value={p.productCode}>{p.productName}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className="block text-[11px] font-bold text-slate-500">Public price (EGP)</span>
              <input className={inputClass} value={ppValue} onChange={(e) => setPpValue(e.target.value)} placeholder="0" /></label>
            <button type="button" disabled={busy || !ppProduct} className="bg-slate-800 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
              onClick={() => run(() => postCaps({ action: "publicPrice", productCode: ppProduct, publicPrice: ppValue === "" ? null : Number(ppValue) }), "Public price saved.")}>
              Set public price
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
