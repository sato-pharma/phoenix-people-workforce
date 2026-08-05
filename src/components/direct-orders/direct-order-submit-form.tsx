"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { DistributorCustomerPicker } from "@/components/direct-orders/distributor-customer-picker";
import { PharmacyComboBox, type PharmacySearchHit } from "@/components/direct-orders/pharmacy-combo-box";

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

type ProductOption = {
  productCode: string;
  productName: string;
  line: string;
  publicPrice: number | null;
  pharmacyPrice: number | null;
};
type AreaOption = { areaCode: string; areaName: string; regionCode: string; regionName: string };
type BrickOption = {
  brickId: string;
  brickName: string;
  areaCode: string;
  areaName: string;
  regionCode: string;
  regionName: string;
};
type DistributorOption = { distributorCode: string; distributorName: string };
export type SubmitFormCaps = {
  globalBonusCapPct: number;
  globalDiscountCapPct: number;
  byProduct: Record<string, { bonusCapPct: number | null; discountCapPct: number | null }>;
};

type Props = {
  products: ProductOption[];
  areas: AreaOption[];
  bricks: BrickOption[];
  distributors: DistributorOption[];
  caps: SubmitFormCaps;
  initialPharmacies: DirectOrderPharmacy[];
  myRequests: DirectOrderApprovalListItem[];
};

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const bonusCell = (row: DirectOrderApprovalListItem) =>
  row.dealType === "discount" ? (row.discountPct == null ? "—" : `${row.discountPct}%`) : row.bonus.toLocaleString("en-US");

const STATUS_TONE: Record<string, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
  returned: "bg-slate-200 text-slate-700",
  reversed: "bg-slate-200 text-slate-700",
  draft: "bg-slate-100 text-slate-600",
  // Held = parked outside the approval flow until the pharmacy passes validation (spec B6).
  held: "bg-orange-100 text-orange-800",
  expired: "bg-slate-300 text-slate-600",
  // Cancelled = withdrawn by its requester while held (audit F3).
  cancelled: "bg-zinc-200 text-zinc-700",
};

function labelClass() {
  return "block text-[11px] font-black uppercase tracking-wider text-slate-500";
}
function inputClass() {
  return "mt-1 w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none";
}

export function DirectOrderSubmitForm({ products, areas, bricks, distributors, caps, myRequests }: Props) {
  const router = useRouter();

  const [productCode, setProductCode] = useState("");
  const [dealType, setDealType] = useState<DirectOrderDealType>("bonus");
  const [qty, setQty] = useState("");
  const [bonus, setBonus] = useState("");
  const [discount, setDiscount] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [collectionDate, setCollectionDate] = useState("");

  // "picked" = chosen from the combo box (the normal path — spec B1); "new" = the explicit
  // "not in the database" fallback, which will wait for pharmacy validation.
  const [pharmacyMode, setPharmacyMode] = useState<"picked" | "new">("picked");
  const [pickedHit, setPickedHit] = useState<PharmacySearchHit | null>(null);
  const [newName, setNewName] = useState("");
  const [newAreaCode, setNewAreaCode] = useState("");
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
  const hasPharmacyPrice = !!(product && product.pharmacyPrice != null && product.pharmacyPrice > 0);
  // The basis this preview uses must reproduce the SERVER exactly, or the number the requester
  // approved on screen would change the moment they hit submit. There is no factory-price
  // fallback any more (owner ruling, 2026-08-04) — a bonus deal is valued on the pharmacy price
  // or it is refused, so a product without one previews 0 and cannot be submitted.
  const bonusBasis = product && hasPharmacyPrice ? product.pharmacyPrice! : 0;

  const overCap = dealType === "discount" ? discountNum > discountCapPct : bonusNum > maxBonus;
  const salesValue = !product
    ? 0
    : dealType === "discount"
      ? computeDiscountSalesValue({ qty: qtyNum, publicPrice: product.publicPrice ?? 0, discountPct: discountNum })
      : computeDirectOrderSalesValue({ qty: qtyNum, pharmacyPrice: bonusBasis });
  const visibleBricks = useMemo(
    () => (newAreaCode ? bricks.filter((b) => b.areaCode === newAreaCode) : []),
    [bricks, newAreaCode],
  );
  const selectedBrick = bricks.find((b) => b.brickId === newBrickId) ?? null;

  // A row with a distributor but no customer code (or the reverse). The picker already tells the
  // submitter "a half-filled row cannot be saved" — but createPharmacyIfNeeded then FILTERED such
  // rows out, so the row was silently discarded, the pharmacy was registered with no code at all,
  // and the sentence on screen was simply untrue. The server refuses these pairs; the client just
  // never sent them, so the refusal could not fire. Blocking here is what the warning promises.
  const halfFilledDistRow =
    pharmacyMode === "new" &&
    distRows.some((row) => Boolean(row.distributorCode.trim()) !== Boolean(row.customerCode.trim()));

  // A bonus deal is valued on the pharmacy price alone. Without one the server refuses the
  // submission (owner ruling, 2026-08-04), so the button must refuse it too rather than letting
  // the request round-trip into an error. This mirrors the discount branch's public-price rule.
  const missingBonusBasis = dealType === "bonus" && !!product && !hasPharmacyPrice;

  // Mirrors submit()'s hard preconditions only. An over-cap deal is still NOT gated here —
  // over cap is flagged and submitted (owner rule, 2026-08-03).
  const readyToSubmit =
    !busy &&
    !!product &&
    qtyNum > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(collectionDate) &&
    !halfFilledDistRow &&
    !missingBonusBasis;

  function updateDistRow(index: number, patch: Partial<{ distributorCode: string; customerCode: string }>) {
    setDistRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function createPharmacyIfNeeded(): Promise<string> {
    if (pharmacyMode === "picked") {
      if (!pickedHit) throw new Error("Search for the pharmacy and pick it from the list.");
      // The body carries only POINTERS at the trusted row — the server copies every stored
      // field from the catalogue, nothing from this form (spec A1/B3).
      const res = await fetch("/api/direct-orders/pharmacies/from-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoenixPharmacyCode: pickedHit.phoenixPharmacyCode,
          distributorCode: pickedHit.distributorCode,
          customerCode: pickedHit.customerCode,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; pharmacy?: DirectOrderPharmacy };
      if (!res.ok || !data.success || !data.pharmacy) throw new Error(data.message || "Could not resolve the selected pharmacy.");
      return data.pharmacy.id;
    }
    if (!newName.trim()) throw new Error("New pharmacy name is required.");
    if (!newDoctor.trim()) throw new Error("Doctor name is required.");
    if (!newAddress.trim()) throw new Error("Pharmacy address is required.");
    // Drop only rows that are entirely blank (the default empty row). A HALF-filled row is passed
    // through on purpose so the server's own refusal can fire: filtering on `code && customer`
    // discarded the submitter's distributor choice in silence, which is the very failure the
    // server-side normalizer was fixed to stop. readyToSubmit blocks this case first; this keeps
    // the client from lying if that gate is ever bypassed.
    const pairs = distRows
      .map((row) => ({ distributorCode: row.distributorCode.trim(), customerCode: row.customerCode.trim() }))
      .filter((row) => row.distributorCode || row.customerCode);
    // No refusal on an empty list (owner rule, 2026-08-04). Not knowing the code is a real
    // situation; blocking on it only ever produced an invented code. The cost is the extra
    // System Admin rung, which the note beside the field states before they submit.
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
          bonusOverrideReason: overCap ? overrideReason.trim() || null : null,
          collectionDate,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not submit the direct order.");
      setOk(
        overCap
          ? "Direct order submitted — flagged as over cap for your approvers, and on its way to the first of them."
          : "Direct order submitted — it is now with your first approver.",
      );
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
                  {/* The factory price used to be shown here — the one price a direct order is never
                      valued on. The dropdown now names the basis this deal will actually use. */}
                  {p.productName} · {p.line} ·{" "}
                  {dealType === "discount"
                    ? p.publicPrice != null && p.publicPrice > 0
                      ? `public ${money(p.publicPrice)}`
                      : "no public price set"
                    : p.pharmacyPrice != null && p.pharmacyPrice > 0
                      ? `pharmacy ${money(p.pharmacyPrice)}`
                      : "no pharmacy price set"}
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
                {/* Echo what the typed number MEANS. The hint used to read "Max bonus: 60 (25% of
                    qty)" beside a numeric box, and a real submitter typed 25 intending 25% — it was
                    stored as 25 bonus UNITS, sat under the 60-unit cap so nothing flagged it, and the
                    order was valued as a bonus deal instead of a 25% discount. Showing the resulting
                    percentage as they type makes that mistake visible before it is submitted. */}
                {product && qtyNum > 0 ? (
                  <p className={`mt-1 text-[11px] ${overCap ? "font-bold text-rose-600" : "text-slate-500"}`}>
                    {bonusNum.toLocaleString("en-US")} free units = {((bonusNum / qtyNum) * 100).toFixed(1)}% of
                    {" "}{qtyNum.toLocaleString("en-US")}. Max {maxBonus} ({bonusCapPct}%)
                    {overCap ? " — over cap" : ""}
                  </p>
                ) : product ? (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Free UNITS, not a percentage. Enter a quantity to see what it works out as.
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

          {/* This note used to say the order "will be valued at the factory price". There is no
              factory-price fallback any more — a bonus deal is priced on the pharmacy price or it
              is refused, so the message now states the refusal rather than promising a basis. */}
          {missingBonusBasis ? (
            <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
              No pharmacy price is set for {product?.productName}. A bonus deal is valued on the pharmacy
              price, so this order cannot be submitted until an admin sets it.
            </p>
          ) : null}

          {overCap ? (
            <div className="space-y-2 border border-amber-300 bg-amber-50 px-3 py-2.5">
              <p className="text-[12px] font-bold text-amber-800">
                Over cap — this request still submits and goes through the normal approval chain. It is flagged for every approver, not blocked.
              </p>
              <div>
                <label className={labelClass()}>Note for the approvers (optional)</label>
                <textarea className={inputClass()} rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why this exceeds the cap…" />
              </div>
            </div>
          ) : null}

          <div className="border border-orange-200 bg-orange-50 px-3 py-2 text-sm">
            <span className="font-black uppercase tracking-wider text-[11px] text-orange-700">Sales value ({dealType === "discount" ? "public × (1−disc%)" : "bonus excluded"})</span>
            <div className="text-lg font-black text-slate-900">{money(salesValue)}</div>
            {product ? (
              <div className="text-[11px] text-slate-500">
                {dealType === "discount"
                  ? `${qtyNum.toLocaleString("en-US")} × ${money(product.publicPrice ?? 0)} × (1 − ${discountNum}%)`
                  : `${qtyNum.toLocaleString("en-US")} × ${money(bonusBasis)} pharmacy price`}
              </div>
            ) : null}
          </div>

          <div>
            <label className={labelClass()}>Money collection date *</label>
            <input type="date" className={inputClass()} value={collectionDate} onChange={(e) => setCollectionDate(e.target.value)} />
            <p className="mt-1 text-[11px] text-slate-400">When you expect this direct order to be collected / paid (تاريخ التحصيل).</p>
          </div>

          {/* Pharmacy — combo box over the master database (spec B1/B2/B3) */}
          <div className="border-t border-[#eef1f3] pt-3">
            <label className={labelClass()}>Pharmacy *</label>

            {pharmacyMode === "picked" ? (
              pickedHit ? (
                <div className="mt-1 border border-emerald-300 bg-emerald-50 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[13px] font-black text-slate-900" dir="auto">
                        {pickedHit.customerName ?? `${pickedHit.customerCode} — (no name on file)`}
                      </p>
                      <p className="mt-0.5 text-[11px] font-semibold text-slate-600">
                        {pickedHit.phoenixPharmacyCode ? `${pickedHit.phoenixPharmacyCode} · ` : ""}
                        {pickedHit.distributorCode ? `${pickedHit.distributorCode} · ${pickedHit.customerCode}` : ""}
                      </p>
                      {pickedHit.address ? (
                        <p className="mt-0.5 text-[11px] text-slate-500" dir="auto">{pickedHit.address}</p>
                      ) : null}
                      {/* Geography comes WITH the customer and cannot be edited (spec B3). */}
                      <p className="mt-1 text-[11px] font-bold text-emerald-700">
                        Area: {pickedHit.areaName || pickedHit.areaCode || "—"} · Region: {pickedHit.regionName || pickedHit.regionCode || "—"}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-[12px] font-bold text-orange-600 hover:text-orange-700"
                      onClick={() => setPickedHit(null)}
                    >
                      Change
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-1 space-y-1.5">
                  <PharmacyComboBox inputClassName={inputClass()} onSelect={(hit) => setPickedHit(hit)} />
                  <button
                    type="button"
                    className="text-[12px] font-semibold text-slate-500 underline hover:text-slate-700"
                    onClick={() => setPharmacyMode("new")}
                  >
                    My pharmacy is not in the database…
                  </button>
                </div>
              )
            ) : (
              <div className="mt-1 space-y-2">
                <div className="border border-amber-300 bg-amber-50 px-3 py-2">
                  <p className="text-[12px] font-bold text-amber-800">
                    This pharmacy is not in the master database, so the request will NOT enter the
                    approval flow until the pharmacy is validated. Search first — most pharmacies
                    are already there under a slightly different spelling.
                  </p>
                  <button
                    type="button"
                    className="mt-1 text-[12px] font-bold text-orange-600 hover:text-orange-700"
                    onClick={() => setPharmacyMode("picked")}
                  >
                    ← Back to search
                  </button>
                </div>
                <input className={inputClass()} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Pharmacy name *" />
                <select
                  className={inputClass()}
                  value={newAreaCode}
                  onChange={(e) => {
                    setNewAreaCode(e.target.value);
                    setNewBrickId("");
                  }}
                >
                  <option value="">Select area…</option>
                  {areas.map((a) => (
                    <option key={a.areaCode} value={a.areaCode}>
                      {a.areaName} — {a.areaCode}
                    </option>
                  ))}
                </select>
                <select
                  className={inputClass()}
                  value={newBrickId}
                  onChange={(e) => setNewBrickId(e.target.value)}
                  disabled={!newAreaCode}
                >
                  <option value="">{newAreaCode ? "Select brick…" : "Select an area first…"}</option>
                  {visibleBricks.map((b) => (
                    <option key={b.brickId} value={b.brickId}>
                      {b.brickName}
                    </option>
                  ))}
                </select>
                {selectedBrick ? (
                  <p className="text-[11px] text-slate-500">
                    Area {selectedBrick.areaName || selectedBrick.areaCode} · Region {selectedBrick.regionName || selectedBrick.regionCode}
                  </p>
                ) : null}
                <input className={inputClass()} value={newDoctor} onChange={(e) => setNewDoctor(e.target.value)} placeholder="Doctor name *" />
                <input className={inputClass()} value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="Pharmacy address *" />

                {/* Optional since 2026-08-04 — the note explains what leaving it empty costs. */}
                <div className="border border-[#eef1f3] p-2">
                  <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">Distributor customer codes</p>
                  <p className="mb-1 text-[11px] font-semibold text-slate-500">
                    Optional. Leave it empty if you do not know them — but the order cannot be
                    finalized until the pharmacy passes validation.
                  </p>
                  {distRows.map((row, index) => (
                    <DistributorCustomerPicker
                      key={index}
                      row={row}
                      distributors={distributors}
                      areas={areas}
                      inputClassName={inputClass()}
                      onChange={(patch) => updateDistRow(index, patch)}
                      onRemove={
                        distRows.length > 1
                          ? () => setDistRows((prev) => prev.filter((_, i) => i !== index))
                          : undefined
                      }
                    />
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
            disabled={!readyToSubmit}
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
                  <th className="px-3 py-2" />
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
                    <td className="px-3 py-2 text-right tabular-nums">
                      {bonusCell(r)}
                      {r.bonusOverCap ? (
                        <span className="ml-1.5 inline-block rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-rose-700">
                          over cap
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{money(r.salesValue)}</td>
                    <td className="px-3 py-2">{r.pharmacyName}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${STATUS_TONE[r.status] ?? "bg-slate-100 text-slate-600"}`}>
                        {r.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {r.status === "pending_approval" ? r.activeStepLabel || "—" : "—"}
                    </td>
                    {/* The requester could see a summary row but never open it. Track leads to the
                        SAME detail the approvers read, so they can see exactly which rung holds it. */}
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <Link
                        href={`/admin/direct-orders/${encodeURIComponent(r.id)}`}
                        className="font-bold text-orange-600 hover:text-orange-700"
                      >
                        Track →
                      </Link>
                    </td>
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
