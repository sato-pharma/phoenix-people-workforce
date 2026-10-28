"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { DirectOrderCapRow } from "@/lib/direct-orders/caps";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

type ProductOption = {
  productCode: string;
  productName: string;
  /** Values DISCOUNT deals. */
  publicPrice: number | null;
  /** Values BONUS deals. null = not set; a bonus order is then refused at submit. */
  pharmacyPrice: number | null;
};

/** Per-row draft edits, keyed by product code. Absent = the row is showing its saved value. */
type PriceEdits = Record<string, { publicPrice: string; pharmacyPrice: string }>;

const priceText = (value: number | null): string => (value == null ? "" : String(value));

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

  // Per-row price edits. A row's input shows its draft if one exists, otherwise its saved value.
  const [edits, setEdits] = useState<PriceEdits>({});
  const [productFilter, setProductFilter] = useState("");

  function draftFor(product: ProductOption) {
    return (
      edits[product.productCode] ?? {
        publicPrice: priceText(product.publicPrice),
        pharmacyPrice: priceText(product.pharmacyPrice),
      }
    );
  }
  function editRow(product: ProductOption, patch: Partial<{ publicPrice: string; pharmacyPrice: string }>) {
    setEdits((prev) => ({ ...prev, [product.productCode]: { ...draftFor(product), ...patch } }));
  }

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

  const inputClass = cn(phxFieldClassName, "w-24");
  const removeButton = (r: DirectOrderCapRow) => (
    <button type="button" className="text-rose-600 hover:text-rose-700" disabled={busy}
      onClick={() => run(() => postCaps({ action: "delete", productCode: r.productCode }), "Override removed.")}>Remove</button>
  );
  const priceInput = (p: ProductOption, field: "publicPrice" | "pharmacyPrice") =>
    canEdit ? (
      <input
        className={`${inputClass} text-right`}
        value={draftFor(p)[field]}
        onChange={(e) => editRow(p, { [field]: e.target.value })}
        placeholder="not set"
        inputMode="decimal"
      />
    ) : p[field] == null ? (
      <span className="text-rose-500">not set</span>
    ) : (
      `${(p[field] as number).toLocaleString("en-US")} EGP`
    );
  const savePricesButton = (p: ProductOption) => {
    const draft = draftFor(p);
    return (
      <button
        type="button"
        disabled={busy}
        className="bg-slate-800 px-3 py-1 text-xs font-bold text-white hover:bg-slate-900 disabled:opacity-50"
        onClick={() =>
          run(
            () =>
              postCaps({
                action: "productPrices",
                productCode: p.productCode,
                publicPrice: draft.publicPrice.trim() === "" ? null : Number(draft.publicPrice),
                pharmacyPrice: draft.pharmacyPrice.trim() === "" ? null : Number(draft.pharmacyPrice),
              }),
            `Prices saved for ${p.productName}.`,
          )
        }
      >
        Save
      </button>
    );
  };
  const productName = (code: string) => products.find((p) => p.productCode === code)?.productName ?? code;
  const filter = productFilter.trim().toLowerCase();
  const visibleProducts = filter
    ? products.filter(
        (p) => p.productName.toLowerCase().includes(filter) || p.productCode.toLowerCase().includes(filter),
      )
    : products;

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
      <section className={`border border-slate-200 bg-white p-4 ${adminSoftDepthClassName}`}>
        <h3 className="mb-3 text-phx-xs font-black uppercase tracking-wider text-slate-500">Global caps (default for every product)</h3>
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="block text-phx-xs font-bold text-slate-500">Bonus cap %</span>
            <input className={inputClass} value={gBonus} onChange={(e) => setGBonus(e.target.value)} disabled={!canEdit} />
          </label>
          <label className="text-sm">
            <span className="block text-phx-xs font-bold text-slate-500">Discount cap %</span>
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
      <section className={`border border-slate-200 bg-white p-4 ${adminSoftDepthClassName}`}>
        <h3 className="mb-3 text-phx-xs font-black uppercase tracking-wider text-slate-500">Per-product cap overrides</h3>
        <PortalResponsiveDataList
          empty={<p className="px-2 py-3 text-sm text-slate-400">No per-product overrides — every product uses the global caps.</p>}
          getKey={(r) => r.productCode}
          items={overrides}
          renderCard={(r) => (
            <PortalRecordCard
              actions={canEdit ? removeButton(r) : undefined}
              title={productName(r.productCode)}
            >
              <PortalRecordFields
                fields={[
                  { label: "Bonus cap %", value: r.bonusCapPct ?? "—" },
                  { label: "Discount cap %", value: r.discountCapPct ?? "—" },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                canEdit ? (
                  <colgroup>
                    <col className="w-[50%]" />
                    <col className="w-[20%]" />
                    <col className="w-[20%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                ) : (
                  <colgroup>
                    <col className="w-[60%]" />
                    <col className="w-[20%]" />
                    <col className="w-[20%]" />
                  </colgroup>
                )
              }
            >
              <thead>
                <tr className="border-b border-slate-200 text-left text-phx-xs font-black uppercase text-slate-500">
                  <th className="px-2 py-1">Product</th>
                  <th className="px-2 py-1">Bonus cap %</th>
                  <th className="px-2 py-1">Discount cap %</th>
                  {canEdit ? <th className="px-2 py-1"></th> : null}
                </tr>
              </thead>
              <tbody>
                {overrides.map((r) => (
                  <tr key={r.productCode} className="border-b border-slate-100">
                    <td className="break-words px-2 py-1.5">{productName(r.productCode)}</td>
                    <td className="px-2 py-1.5">{r.bonusCapPct ?? "—"}</td>
                    <td className="px-2 py-1.5">{r.discountCapPct ?? "—"}</td>
                    {canEdit ? <td className="px-2 py-1.5">{removeButton(r)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
        {canEdit ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
            <label className="text-sm">
              <span className="block text-phx-xs font-bold text-slate-500">Product</span>
              <select className={phxSelectClassName} value={ovProduct} onChange={(e) => setOvProduct(e.target.value)}>
                <option value="">Select…</option>
                {products.map((p) => <option key={p.productCode} value={p.productCode}>{p.productName}</option>)}
              </select>
            </label>
            <label className="text-sm"><span className="block text-phx-xs font-bold text-slate-500">Bonus cap %</span>
              <input className={inputClass} value={ovBonus} onChange={(e) => setOvBonus(e.target.value)} placeholder="(global)" /></label>
            <label className="text-sm"><span className="block text-phx-xs font-bold text-slate-500">Discount cap %</span>
              <input className={inputClass} value={ovDiscount} onChange={(e) => setOvDiscount(e.target.value)} placeholder="(global)" /></label>
            <button type="button" disabled={busy || !ovProduct} className="bg-slate-800 px-3 py-1.5 text-sm font-bold text-white hover:bg-slate-900 disabled:opacity-50"
              onClick={() => run(() => postCaps({ action: "upsert", productCode: ovProduct, bonusCapPct: ovBonus === "" ? null : Number(ovBonus), discountCapPct: ovDiscount === "" ? null : Number(ovDiscount) }), "Override saved.")}>
              Add / update override
            </button>
          </div>
        ) : null}
      </section>

      {/* Product prices — the one place both deal types get their price basis. */}
      <section className={`border border-slate-200 bg-white p-4 ${adminSoftDepthClassName}`}>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Product prices</h3>
            <p className="mt-1 text-phx-xs text-slate-500">
              A BONUS direct order is valued at qty × pharmacy price. A DISCOUNT order is valued at
              qty × public price × (1 − discount %). Those two prices are the only bases a direct
              order uses, so a product with no pharmacy price cannot be submitted as a bonus deal.
            </p>
          </div>
          <label className="text-sm">
            <span className="block text-phx-xs font-bold text-slate-500">Find a product</span>
            <input
              className={cn(phxFieldClassName, "w-56")}
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              placeholder="Product name…"
            />
          </label>
        </div>

        <PortalResponsiveDataList
          empty={<p className="px-2 py-3 text-sm text-slate-400">No product matches “{productFilter}”.</p>}
          getKey={(p) => p.productCode}
          items={visibleProducts}
          renderCard={(p) => (
            <PortalRecordCard actions={canEdit ? savePricesButton(p) : undefined} title={p.productName}>
              <PortalRecordFields
                fields={[
                  { label: "Public price (discount)", value: priceInput(p, "publicPrice") },
                  { label: "Pharmacy price (bonus)", value: priceInput(p, "pharmacyPrice") },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                canEdit ? (
                  <colgroup>
                    <col className="w-[34%]" />
                    <col className="w-[28%]" />
                    <col className="w-[28%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                ) : (
                  <colgroup>
                    <col className="w-[44%]" />
                    <col className="w-[28%]" />
                    <col className="w-[28%]" />
                  </colgroup>
                )
              }
            >
              <thead>
                <tr className="border-b border-slate-200 text-left text-phx-xs font-black uppercase text-slate-500">
                  <th className="px-2 py-1">Product</th>
                  <th className="px-2 py-1 text-right">Public price (discount)</th>
                  <th className="px-2 py-1 text-right">Pharmacy price (bonus)</th>
                  {canEdit ? <th className="px-2 py-1" /> : null}
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((p) => (
                  <tr key={p.productCode} className="border-b border-slate-100">
                    <td className="break-words px-2 py-1.5">{p.productName}</td>
                    <td className="px-2 py-1.5 text-right">{priceInput(p, "publicPrice")}</td>
                    <td className="px-2 py-1.5 text-right">{priceInput(p, "pharmacyPrice")}</td>
                    {canEdit ? <td className="px-2 py-1.5 text-right">{savePricesButton(p)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
        {canEdit ? (
          <p className="mt-3 border-t border-slate-100 pt-3 text-phx-xs text-slate-500">
            Every active product already has a row — adding a price means typing into a row that reads
            “not set”. Leave a field blank (or 0) to clear it back to unset.
          </p>
        ) : null}
      </section>
    </div>
  );
}
