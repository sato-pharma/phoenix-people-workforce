"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  computeDirectOrderSalesValue,
  computeDiscountSalesValue,
  maxBonusUnits,
} from "@/lib/direct-orders/approval-flow";
import type {
  DirectOrderApprovalListItem,
  DirectOrderDealType,
  DirectOrderPharmacy,
} from "@/lib/direct-orders/types";

type ProductOption = { productCode: string; productName: string; line: string; factoryPrice: number; publicPrice: number | null };
type BrickOption = { brickId: string; brickName: string; areaCode: string; regionCode: string };
type DistributorOption = { distributorCode: string; distributorName: string };
export type SubmitFormCaps = {
  globalBonusCapPct: number;
  globalDiscountCapPct: number;
  byProduct: Record<string, { bonusCapPct: number | null; discountCapPct: number | null }>;
};

type Props = {
  products: ProductOption[];
  bricks: BrickOption[];
  distributors: DistributorOption[];
  caps: SubmitFormCaps;
  initialPharmacies: DirectOrderPharmacy[];
  myRequests: DirectOrderApprovalListItem[];
};

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

const STATUS_TONE: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
  returned: "bg-slate-200 text-slate-700",
  reversed: "bg-slate-200 text-slate-700",
  draft: "bg-slate-100 text-slate-600",
};

function labelClass() {
  return "block text-[11px] font-black uppercase tracking-wider text-slate-500";
}
function inputClass() {
  return "mt-1 w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none";
}

export function DirectOrderSubmitForm({ products, bricks, distributors, caps, initialPharmacies, myRequests }: Props) {
  const router = useRouter();
  const [pharmacies, setPharmacies] = useState<DirectOrderPharmacy[]>(initialPharmacies);

  const [productCode, setProductCode] = useState("");
  const [dealType, setDealType] = useState<DirectOrderDealType>("bonus");
  const [qty, setQty] = useState("");
  const [bonus, setBonus] = useState("");
  const [discount, setDiscount] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [collectionDate, setCollectionDate] = useState("");

  const [pharmacyMode, setPharmacyMode] = useState<"existing" | "new">(initialPharmacies.length ? "existing" : "new");
  const [pharmacyId, setPharmacyId] = useState(initialPharmacies[0]?.id ?? "");
  const [newName, setNewName] = useState("");
  const [newBrickId, setNewBrickId] = useState("");
  const [newDoctor, setNewDoctor] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [distRows, setDistRows] = useState<Array<{ distributorCode: string; customerCode: string }>>([
    { distributorCode: "", customerCode: "" },
  ]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const product = useMemo(() => products.find((p) => p.productCode === productCode) ?? null, [products, productCode]);
  const qtyNum = Math.max(0, Math.floor(Number(qty) || 0));
  const bonusNum = Math.max(0, Math.floor(Number(bonus) || 0));
  const discountNum = Math.max(0, Math.min(100, Number(discount) || 0));

  const bonusCapPct = product ? caps.byProduct[product.productCode]?.bonusCapPct ?? caps.globalBonusCapPct : caps.globalBonusCapPct;
  const discountCapPct = product ? caps.byProduct[product.productCode]?.discountCapPct ?? caps.globalDiscountCapPct : caps.globalDiscountCapPct;
  const maxBonus = product ? maxBonusUnits({ qty: qtyNum, capPct: bonusCapPct }) : 0;
  const hasPublicPrice = !!(product && product.publicPrice != null && product.publicPrice > 0);

  const overCap = dealType === "discount" ? discountNum > discountCapPct : bonusNum > maxBonus;
  const salesValue = !product
    ? 0
    : dealType === "discount"
      ? computeDiscountSalesValue({ qty: qtyNum, publicPrice: product.publicPrice ?? 0, discountPct: discountNum })
      : computeDirectOrderSalesValue({ qty: qtyNum, factoryPrice: product.factoryPrice });
  const selectedBrick = bricks.find((b) => b.brickId === newBrickId) ?? null;

  function updateDistRow(index: number, patch: Partial<{ distributorCode: string; customerCode: string }>) {
    setDistRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function createPharmacyIfNeeded(): Promise<string> {
    if (pharmacyMode === "existing") {
      if (!pharmacyId) throw new Error("Choose a pharmacy or add a new one.");
      return pharmacyId;
    }
    if (!newName.trim()) throw new Error("New pharmacy name is required.");
    if (!newDoctor.trim()) throw new Error("Doctor name is required.");
    if (!newAddress.trim()) throw new Error("Pharmacy address is required.");
    const pairs = distRows
      .map((row) => ({ distributorCode: row.distributorCode.trim(), customerCode: row.customerCode.trim() }))
      .filter((row) => row.distributorCode && row.customerCode);
    if (pairs.length === 0) throw new Error("Add at least one distributor and its customer code.");
    const res = await fetch("/api/direct-orders/pharmacies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pharmacyName: newName.trim(),
        brickId: newBrickId || null,
        areaCode: selectedBrick?.areaCode ?? null,
        regionCode: selectedBrick?.regionCode ?? null,
        doctorName: newDoctor.trim(),
        pharmacyAddress: newAddress.trim(),
        distributorCodes: pairs,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; pharmacy?: DirectOrderPharmacy };
    if (!res.ok || !data.success || !data.pharmacy) throw new Error(data.message || "Could not create the pharmacy.");
    setPharmacies((prev) => [...prev, data.pharmacy!]);
    return data.pharmacy.id;
  }

  async function submit() {
    setError(null);
    setOk(null);
    if (!product) return setError("Choose a product.");
    if (qtyNum <= 0) return setError("Quantity must be greater than zero.");
    if (dealType === "discount" && !hasPublicPrice) {
      return setError(`No public price is set for ${product.productName}. Ask an admin to set it, or use bonus mode.`);
    }
    if (overCap && !overrideReason.trim()) {
      return setError(
        dealType === "discount"
          ? `Discount ${discountNum}% exceeds the cap of ${discountCapPct}%. Provide a CEO-override reason, or lower it.`
          : `Bonus ${bonusNum} exceeds the cap of ${maxBonus}. Provide a CEO-override reason, or lower the bonus.`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(collectionDate)) return setError("Enter the money-collection date.");
    setBusy(true);
    try {
      const resolvedPharmacyId = await createPharmacyIfNeeded();
      const res = await fetch("/api/direct-orders/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productCode: product.productCode,
          pharmacyId: resolvedPharmacyId,
          qty: qtyNum,
          dealType,
          bonus: dealType === "bonus" ? bonusNum : 0,
          discountPct: dealType === "discount" ? discountNum : null,
          bonusOverrideReason: overCap ? overrideReason.trim() : null,
          collectionDate,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not submit the direct order.");
      setOk("Direct order submitted — it is now with your first approver.");
      setProductCode("");
      setQty("");
      setBonus("");
      setDiscount("");
      setOverrideReason("");
      setCollectionDate("");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const tabClass = (active: boolean) =>
    `flex-1 border px-3 py-1.5 text-sm font-bold ${active ? "border-orange-500 bg-orange-50 text-orange-700" : "border-slate-300 bg-white text-slate-500"}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
      {/* ── Form ── */}
      <section className="border border-[#e4e9ec] bg-white">
        <header className="border-b border-[#e4e9ec] bg-slate-900 px-4 py-2.5">
          <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-white">New direct order</h3>
        </header>
        <div className="space-y-4 px-4 py-4">
          <div>
            <label className={labelClass()}>Product</label>
            <select className={inputClass()} value={productCode} onChange={(e) => setProductCode(e.target.value)}>
              <option value="">Select a product…</option>
              {products.map((p) => (
                <option key={p.productCode} value={p.productCode}>
                  {p.productName} · {p.line} · factory {money(p.factoryPrice)}
                </option>
              ))}
            </select>
          </div>

          {/* Deal type */}
          <div>
            <label className={labelClass()}>Deal type</label>
            <div className="mt-1 flex gap-2">
              <button type="button" className={tabClass(dealType === "bonus")} onClick={() => setDealType("bonus")}>Bonus</button>
              <button type="button" className={tabClass(dealType === "discount")} onClick={() => setDealType("discount")}>Discount</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass()}>Quantity (units)</label>
              <input className={inputClass()} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
            </div>
            {dealType === "bonus" ? (
              <div>
                <label className={labelClass()}>Bonus (units)</label>
                <input className={inputClass()} inputMode="numeric" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="0" />
                {product ? (
                  <p className={`mt-1 text-[11px] ${overCap ? "font-bold text-rose-600" : "text-slate-500"}`}>
                    Max bonus: {maxBonus} ({bonusCapPct}% of qty){overCap ? " — over cap" : ""}
                  </p>
                ) : null}
              </div>
            ) : (
              <div>
                <label className={labelClass()}>Discount %</label>
                <input className={inputClass()} inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" />
                <p className={`mt-1 text-[11px] ${overCap ? "font-bold text-rose-600" : "text-slate-500"}`}>
                  Cap: {discountCapPct}%{overCap ? " — over cap" : ""}
                </p>
              </div>
            )}
          </div>

          {dealType === "discount" && product && !hasPublicPrice ? (
            <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
              No public price is set for {product.productName}. Ask an admin to set it, or use bonus mode.
            </p>
          ) : null}

          {overCap ? (
            <div>
              <label className={labelClass()}>CEO-override reason (required — only the CEO can approve an over-cap {dealType})</label>
              <textarea className={inputClass()} rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
            </div>
          ) : null}

          <div className="border border-orange-200 bg-orange-50 px-3 py-2 text-sm">
            <span className="font-black uppercase tracking-wider text-[11px] text-orange-700">Sales value ({dealType === "discount" ? "public × (1−disc%)" : "bonus excluded"})</span>
            <div className="text-lg font-black text-slate-900">{money(salesValue)}</div>
            {product ? (
              <div className="text-[11px] text-slate-500">
                {dealType === "discount"
                  ? `${qtyNum.toLocaleString("en-US")} × ${money(product.publicPrice ?? 0)} × (1 − ${discountNum}%)`
                  : `${qtyNum.toLocaleString("en-US")} × ${money(product.factoryPrice)}`}
              </div>
            ) : null}
          </div>

          <div>
            <label className={labelClass()}>Money collection date *</label>
            <input type="date" className={inputClass()} value={collectionDate} onChange={(e) => setCollectionDate(e.target.value)} />
            <p className="mt-1 text-[11px] text-slate-400">When you expect this direct order to be collected / paid (تاريخ التحصيل).</p>
          </div>

          {/* Pharmacy */}
          <div className="border-t border-[#eef1f3] pt-3">
            <div className="mb-2 flex gap-4">
              <label className="flex items-center gap-1.5 text-sm font-bold text-slate-700">
                <input type="radio" checked={pharmacyMode === "existing"} onChange={() => setPharmacyMode("existing")} disabled={pharmacies.length === 0} />
                My pharmacies
              </label>
              <label className="flex items-center gap-1.5 text-sm font-bold text-slate-700">
                <input type="radio" checked={pharmacyMode === "new"} onChange={() => setPharmacyMode("new")} />
                Add a new pharmacy
              </label>
            </div>

            {pharmacyMode === "existing" ? (
              <select className={inputClass()} value={pharmacyId} onChange={(e) => setPharmacyId(e.target.value)}>
                <option value="">Select a pharmacy…</option>
                {pharmacies.map((ph) => (
                  <option key={ph.id} value={ph.id}>
                    {ph.pharmacyName} ({ph.phoenixPharmacyCode})
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2">
                <input className={inputClass()} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Pharmacy name *" />
                <select className={inputClass()} value={newBrickId} onChange={(e) => setNewBrickId(e.target.value)}>
                  <option value="">Select brick (sets area/region)…</option>
                  {bricks.map((b) => (
                    <option key={b.brickId} value={b.brickId}>
                      {b.brickName} — {b.areaCode}
                    </option>
                  ))}
                </select>
                {selectedBrick ? (
                  <p className="text-[11px] text-slate-500">Area {selectedBrick.areaCode} · Region {selectedBrick.regionCode}</p>
                ) : null}
                <input className={inputClass()} value={newDoctor} onChange={(e) => setNewDoctor(e.target.value)} placeholder="Doctor name *" />
                <input className={inputClass()} value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="Pharmacy address *" />

                {/* Mandatory ≥1 distributor + customer code */}
                <div className="border border-[#eef1f3] p-2">
                  <p className="mb-1 text-[11px] font-black uppercase tracking-wider text-slate-500">Distributor customer codes *</p>
                  {distRows.map((row, index) => (
                    <div key={index} className="mb-1.5 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                      <select className={inputClass()} value={row.distributorCode} onChange={(e) => updateDistRow(index, { distributorCode: e.target.value })}>
                        <option value="">Distributor…</option>
                        {distributors.map((d) => (
                          <option key={d.distributorCode} value={d.distributorCode}>{d.distributorName}</option>
                        ))}
                      </select>
                      <input className={inputClass()} value={row.customerCode} onChange={(e) => updateDistRow(index, { customerCode: e.target.value })} placeholder="Customer code" />
                      {distRows.length > 1 ? (
                        <button type="button" className="mt-1 px-2 text-slate-400 hover:text-rose-600" onClick={() => setDistRows((prev) => prev.filter((_, i) => i !== index))}>✕</button>
                      ) : <span />}
                    </div>
                  ))}
                  <button type="button" className="text-[12px] font-bold text-orange-600 hover:text-orange-700" onClick={() => setDistRows((prev) => [...prev, { distributorCode: "", customerCode: "" }])}>
                    + Add distributor
                  </button>
                </div>
                <p className="text-[11px] text-slate-400">Phoenix auto-generates a stable code for this pharmacy so you can reuse it next time.</p>
              </div>
            )}
          </div>

          {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
          {ok ? <p className="text-sm font-semibold text-emerald-600">{ok}</p> : null}

          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="w-full bg-orange-500 px-4 py-2.5 text-sm font-black uppercase tracking-wider text-white hover:bg-orange-600 disabled:opacity-60"
          >
            {busy ? "Submitting…" : "Submit direct order"}
          </button>
        </div>
      </section>

      {/* ── My requests ── */}
      <section className="border border-[#e4e9ec] bg-white">
        <header className="border-b border-[#e4e9ec] bg-slate-100 px-4 py-2.5">
          <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-600">My direct orders</h3>
        </header>
        {myRequests.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">You have not submitted any direct orders yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#e4e9ec] bg-slate-50 text-left text-[11px] font-black uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Bonus</th>
                  <th className="px-3 py-2 text-right">Value</th>
                  <th className="px-3 py-2">Pharmacy</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Waiting on</th>
                </tr>
              </thead>
              <tbody>
                {myRequests.map((r) => (
                  <tr key={r.id} className="border-b border-[#eef1f3]">
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-800">{r.productName}</div>
                      <div className="text-[11px] text-slate-500">{r.line}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.qty.toLocaleString("en-US")}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.bonus.toLocaleString("en-US")}</td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{money(r.salesValue)}</td>
                    <td className="px-3 py-2">{r.pharmacyName}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${STATUS_TONE[r.status] ?? "bg-slate-100 text-slate-600"}`}>
                        {r.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{r.status === "pending_approval" ? r.activeStepLabel || "—" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
