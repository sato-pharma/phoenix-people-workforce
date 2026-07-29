"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";

import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalMetricCard,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalSection,
  PortalSegmentedTabs,
  portalInputClassName,
} from "@/components/employee-portal/portal-primitives";
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
const bonusCell = (row: DirectOrderApprovalListItem) =>
  row.dealType === "discount" ? (row.discountPct == null ? "-" : `${row.discountPct}%`) : row.bonus.toLocaleString("en-US");

const STATUS_TONE: Record<string, string> = {
  pending_approval: "bg-amber-50 text-amber-700 ring-amber-200",
  approved: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  rejected: "bg-rose-50 text-rose-700 ring-rose-200",
  returned: "bg-sky-50 text-sky-700 ring-sky-200",
  reversed: "bg-slate-100 text-slate-600 ring-slate-200",
  draft: "bg-slate-50 text-slate-500 ring-slate-200",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ring-1 ${STATUS_TONE[status] ?? "bg-slate-50 text-slate-500 ring-slate-200"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

const fieldLabelClassName = "mb-1.5 block text-[11px] font-black uppercase tracking-wide text-slate-500";

export function DirectOrderPortalSubmit({ products, bricks, distributors, caps, initialPharmacies, myRequests }: Props) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

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

  const readyToSubmit = !busy && !!product && qtyNum > 0 && /^\d{4}-\d{2}-\d{2}$/.test(collectionDate);

  function updateDistRow(index: number, patch: Partial<{ distributorCode: string; customerCode: string }>) {
    setDistRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function createPharmacyIfNeeded(): Promise<string> {
    if (pharmacyMode === "existing") {
      if (!pharmacyId) throw new Error("Choose a pharmacy or add a new one.");
      return pharmacyId;
    }
    if (!newName.trim()) throw new Error("New pharmacy name is required.");
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
        doctorName: newDoctor.trim() || null,
        pharmacyAddress: newAddress.trim() || null,
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
      setOk("Direct order submitted -- it is now with your first approver.");
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

  return (
    <div className="space-y-5 pb-24 md:pb-0">
      <PortalSection eyebrow="New Request" title="Submit a direct order" description="Company (direct) orders route to your first approver on submit -- up your management line to the CEO.">
        <div className="space-y-4 p-4 sm:p-5">
          <div>
            <label className={fieldLabelClassName}>Product</label>
            <select className={portalInputClassName} value={productCode} onChange={(e) => setProductCode(e.target.value)}>
              <option value="">Select a product...</option>
              {products.map((p) => (
                <option key={p.productCode} value={p.productCode}>
                  {p.productName} - {p.line} - factory {money(p.factoryPrice)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={fieldLabelClassName}>Deal type</label>
            <PortalSegmentedTabs>
              <button
                type="button"
                onClick={() => setDealType("bonus")}
                className={`flex-1 rounded px-3 py-2 text-sm font-bold transition ${dealType === "bonus" ? "bg-white text-orange-700 shadow-sm" : "text-slate-500"}`}
              >
                Bonus
              </button>
              <button
                type="button"
                onClick={() => setDealType("discount")}
                className={`flex-1 rounded px-3 py-2 text-sm font-bold transition ${dealType === "discount" ? "bg-white text-orange-700 shadow-sm" : "text-slate-500"}`}
              >
                Discount
              </button>
            </PortalSegmentedTabs>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={fieldLabelClassName}>Quantity (units)</label>
              <input className={portalInputClassName} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
            </div>
            {dealType === "bonus" ? (
              <div>
                <label className={fieldLabelClassName}>Bonus (units)</label>
                <input className={portalInputClassName} inputMode="numeric" value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="0" />
                {product ? (
                  <p className={`mt-1 text-[11px] ${overCap ? "font-bold text-rose-600" : "text-slate-500"}`}>
                    Max bonus: {maxBonus} ({bonusCapPct}% of qty){overCap ? " -- over cap" : ""}
                  </p>
                ) : null}
              </div>
            ) : (
              <div>
                <label className={fieldLabelClassName}>Discount %</label>
                <input className={portalInputClassName} inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" />
                <p className={`mt-1 text-[11px] ${overCap ? "font-bold text-rose-600" : "text-slate-500"}`}>
                  Cap: {discountCapPct}%{overCap ? " -- over cap" : ""}
                </p>
              </div>
            )}
          </div>

          {dealType === "discount" && product && !hasPublicPrice ? (
            <p className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
              No public price is set for {product.productName}. Ask an admin to set it, or use bonus mode.
            </p>
          ) : null}

          {overCap ? (
            <div>
              <label className={fieldLabelClassName}>CEO-override reason (required -- only the CEO can approve an over-cap {dealType})</label>
              <textarea className={portalInputClassName} rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
            </div>
          ) : null}

          <PortalMetricCard
            accent="orange"
            label={`Sales value (${dealType === "discount" ? "public x (1-disc%)" : "bonus excluded"})`}
            value={money(salesValue)}
            note={
              product
                ? dealType === "discount"
                  ? `${qtyNum.toLocaleString("en-US")} x ${money(product.publicPrice ?? 0)} x (1 - ${discountNum}%)`
                  : `${qtyNum.toLocaleString("en-US")} x ${money(product.factoryPrice)}`
                : undefined
            }
          />

          <div>
            <label className={fieldLabelClassName}>Money collection date *</label>
            <input type="date" className={portalInputClassName} value={collectionDate} onChange={(e) => setCollectionDate(e.target.value)} />
            <p className="mt-1 text-[11px] text-slate-400">When you expect this direct order to be collected / paid (تاريخ التحصيل).</p>
          </div>

          <div className="border-t border-slate-100 pt-4">
            <div className="mb-3 flex flex-wrap gap-4">
              <label className="flex min-h-[28px] items-center gap-2 text-sm font-bold text-slate-700">
                <input type="radio" className="h-4 w-4" checked={pharmacyMode === "existing"} onChange={() => setPharmacyMode("existing")} disabled={pharmacies.length === 0} />
                My pharmacies
              </label>
              <label className="flex min-h-[28px] items-center gap-2 text-sm font-bold text-slate-700">
                <input type="radio" className="h-4 w-4" checked={pharmacyMode === "new"} onChange={() => setPharmacyMode("new")} />
                Add a new pharmacy
              </label>
            </div>

            {pharmacyMode === "existing" ? (
              <select className={portalInputClassName} value={pharmacyId} onChange={(e) => setPharmacyId(e.target.value)}>
                <option value="">Select a pharmacy...</option>
                {pharmacies.map((ph) => (
                  <option key={ph.id} value={ph.id}>
                    {ph.pharmacyName} ({ph.phoenixPharmacyCode})
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2">
                <input className={portalInputClassName} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Pharmacy name *" />
                <select className={portalInputClassName} value={newBrickId} onChange={(e) => setNewBrickId(e.target.value)}>
                  <option value="">Select brick (sets area/region)...</option>
                  {bricks.map((b) => (
                    <option key={b.brickId} value={b.brickId}>
                      {b.brickName} -- {b.areaCode}
                    </option>
                  ))}
                </select>
                {selectedBrick ? (
                  <p className="text-[11px] text-slate-500">Area {selectedBrick.areaCode} - Region {selectedBrick.regionCode}</p>
                ) : null}
                <input className={portalInputClassName} value={newDoctor} onChange={(e) => setNewDoctor(e.target.value)} placeholder="Doctor name (optional)" />
                <input className={portalInputClassName} value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="Pharmacy address (optional)" />

                <div className="rounded border border-slate-100 bg-slate-50 p-3">
                  <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-500">Distributor customer codes *</p>
                  {distRows.map((row, index) => (
                    <div key={index} className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                      <select className={portalInputClassName} value={row.distributorCode} onChange={(e) => updateDistRow(index, { distributorCode: e.target.value })}>
                        <option value="">Distributor...</option>
                        {distributors.map((d) => (
                          <option key={d.distributorCode} value={d.distributorCode}>{d.distributorName}</option>
                        ))}
                      </select>
                      <input className={portalInputClassName} value={row.customerCode} onChange={(e) => updateDistRow(index, { customerCode: e.target.value })} placeholder="Customer code" />
                      {distRows.length > 1 ? (
                        <button type="button" className="h-10 rounded px-2 text-slate-400 hover:text-rose-600" onClick={() => setDistRows((prev) => prev.filter((_, i) => i !== index))}>
                          Remove
                        </button>
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
            disabled={!readyToSubmit}
            className="hidden h-11 w-full items-center justify-center rounded bg-orange-600 px-4 text-sm font-black uppercase tracking-wider text-white transition hover:bg-orange-700 disabled:opacity-50 md:flex"
          >
            {busy ? "Submitting..." : "Submit direct order"}
          </button>
        </div>
      </PortalSection>

      <PortalSection eyebrow="History" title="My direct orders">
        {myRequests.length === 0 ? (
          <PortalEmptyState title="No direct orders yet" message="Requests you submit will appear here with their live approval status." />
        ) : (
          <PortalResponsiveDataList
            items={myRequests}
            getKey={(r) => r.id}
            empty={<PortalEmptyState title="No direct orders yet" message="Requests you submit will appear here with their live approval status." />}
            renderCard={(r) => (
              <PortalRecordCard
                title={r.productName}
                meta={`${r.line} - ${r.pharmacyName}`}
                status={<StatusPill status={r.status} />}
                accent={r.status === "approved" ? "emerald" : r.status === "rejected" ? "rose" : "orange"}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Qty", value: r.qty.toLocaleString("en-US") },
                    { label: "Bonus", value: bonusCell(r) },
                    { label: "Value", value: money(r.salesValue) },
                    { label: "Waiting on", value: r.status === "pending_approval" ? r.activeStepLabel || "-" : "-" },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable minWidth="860px">
                <thead className="bg-slate-900 text-white">
                  <tr>
                    <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Product</th>
                    <th className="px-3 py-2 text-right text-[11px] font-black uppercase tracking-wider">Qty</th>
                    <th className="px-3 py-2 text-right text-[11px] font-black uppercase tracking-wider">Bonus</th>
                    <th className="px-3 py-2 text-right text-[11px] font-black uppercase tracking-wider">Value</th>
                    <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Pharmacy</th>
                    <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Status</th>
                    <th className="px-3 py-2 text-[11px] font-black uppercase tracking-wider">Waiting on</th>
                  </tr>
                </thead>
                <tbody>
                  {myRequests.map((r, index) => (
                    <tr key={r.id} className={index % 2 ? "bg-slate-50" : "bg-white"}>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-800">{r.productName}</div>
                        <div className="text-[11px] text-slate-500">{r.line}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.qty.toLocaleString("en-US")}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{bonusCell(r)}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums">{money(r.salesValue)}</td>
                      <td className="px-3 py-2">{r.pharmacyName}</td>
                      <td className="px-3 py-2"><StatusPill status={r.status} /></td>
                      <td className="px-3 py-2 text-slate-600">{r.status === "pending_approval" ? r.activeStepLabel || "-" : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        )}
      </PortalSection>

      {mounted
        ? createPortal(
            <div
              className="fixed inset-x-0 z-30 flex border-t border-slate-200 bg-white/95 px-4 pb-3 pt-3 backdrop-blur md:hidden"
              style={{ bottom: "calc(56px + env(safe-area-inset-bottom))" }}
            >
              <button
                type="button"
                onClick={submit}
                disabled={!readyToSubmit}
                className="flex h-12 flex-1 items-center justify-center gap-2 rounded bg-orange-600 text-sm font-black uppercase tracking-wider text-white transition disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {busy ? "Submitting..." : "Submit direct order"}
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
