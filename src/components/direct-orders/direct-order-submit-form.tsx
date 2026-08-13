"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  familyAllowsMultipleItems,
  familyKey,
  selectableFamilyMembers,
} from "@/lib/direct-orders/product-family";

import { DirectOrderStatusPill } from "@/components/direct-orders/direct-order-status-pill";
import { DistributorCustomerPicker } from "@/components/direct-orders/distributor-customer-picker";
import { InvoiceCapture } from "@/components/direct-orders/invoice-capture";
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
  /** The catalogue's grouping — the SAME field the server enforces the basket rule on. */
  familyCode: string;
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
  /**
   * The mounting shell's Direct Orders base.
   *
   * Was hardcoded to "/admin/direct-orders", which is the WRONG shell for almost everyone who uses
   * this form: portalNavigationRoles sends every District / Regional / National Sales Manager and
   * Product / Group Product Manager to the portal, and they are the people who raise direct orders.
   * The admin detail page redirects them back, so it worked — via a round trip to the wrong shell.
   */
  basePath: string;
};

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;
const bonusCell = (row: DirectOrderApprovalListItem) =>
  row.dealType === "discount" ? (row.discountPct == null ? "—" : `${row.discountPct}%`) : row.bonus.toLocaleString("en-US");

// The tone map moved to @/components/direct-orders/direct-order-status-pill. This page rendered the
// pill inline rather than through a component, which is why it was the easiest of the four to miss
// (spec C2).

function labelClass() {
  return "block text-[11px] font-black uppercase tracking-wider text-slate-500";
}
function inputClass() {
  return "mt-1 w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none";
}

export function DirectOrderSubmitForm({ products, areas, bricks, distributors, caps, myRequests, basePath }: Props) {
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

  // ── "Did you mean this pharmacy?" (owner, 2026-08-13) ───────────────────────────────────────
  //
  // A rep hand-typing a pharmacy has no duplicate check ahead of them — createDirectOrderPharmacy
  // inserts unconditionally, and the ONLY automated duplicate finder (groupDuplicatePharmacies)
  // matches on distributor codes, which a hand-typed entry very often has none of. Confirmed live:
  // "حضانه زمزم", area D15, registered twice the same day by the same rep, two different DOP codes,
  // neither ever caught by the cleanup queue because neither carried a code.
  //
  // This is the earlier, softer half of the fix: SUGGEST before the rep finishes typing a pharmacy
  // that might already exist, using the exact search the combo box already runs — filtered to
  // `source === "phoenix"` (Phoenix's own pharmacies, not the raw distributor directory) and the
  // SAME area the rep just picked, so "Al Nour Pharmacy" in one region does not get suggested
  // against an unrelated "Al Nour Pharmacy" three governorates away.
  //
  // NEVER A BLOCK. Picking a suggestion routes into the exact same reuse path a search-and-pick
  // would have (setPickedHit + pharmacyMode "picked"), so it costs no new server logic — the
  // creation-avoidance already exists, this only helps a rep reach it without retyping. Dismissing
  // it, or simply continuing to type, does nothing at all: the rep can still register a genuinely
  // new pharmacy exactly as before. That is the same design principle as the optional distributor
  // code (owner rule 2026-08-04) — never cost a rep the ability to keep working.
  const [nameMatches, setNameMatches] = useState<PharmacySearchHit[]>([]);
  const [nameMatchDismissed, setNameMatchDismissed] = useState(false);
  const nameMatchSeq = useRef(0);

  useEffect(() => {
    // Every setState lives inside the scheduled callback, matching the combo box's own debounced
    // effect (pharmacy-combo-box.tsx) — never a bare setState in the effect body.
    const name = newName.trim();
    const area = newAreaCode.trim();
    const mySeq = ++nameMatchSeq.current;
    if (pharmacyMode !== "new" || name.length < 2 || !area) {
      const timer = setTimeout(() => {
        if (nameMatchSeq.current !== mySeq) return;
        setNameMatches([]);
      }, 0);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(async () => {
      if (nameMatchSeq.current !== mySeq) return;
      // A fresh name or area deserves a fresh chance to suggest, even if an earlier suggestion
      // (for different text) was dismissed.
      setNameMatchDismissed(false);
      try {
        const res = await fetch(`/api/direct-orders/pharmacy-search?q=${encodeURIComponent(name)}`);
        const data = (await res.json().catch(() => ({}))) as { hits?: PharmacySearchHit[] };
        if (nameMatchSeq.current !== mySeq) return;
        const hits = Array.isArray(data.hits) ? data.hits : [];
        setNameMatches(hits.filter((hit) => hit.source === "phoenix" && hit.areaCode === area));
      } catch {
        if (nameMatchSeq.current === mySeq) setNameMatches([]);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [newName, newAreaCode, pharmacyMode]);

  // NOT a hook — named to avoid the "use…" prefix, which react-hooks/rules-of-hooks enforces by
  // naming convention alone and would (correctly) reject this being called from an onClick handler.
  function applySuggestedPharmacy(hit: PharmacySearchHit) {
    setPickedHit(hit);
    setPharmacyMode("picked");
    setNameMatches([]);
  }

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The success banner, carrying the ORDER IT CREATED.
   *
   * Used to be a bare string. The submit API has always returned the created request — the client
   * simply typed the response as `{success, message}` and threw the row away — so "it is now with
   * your first approver" was a sentence about an order the person then had to go and find in a
   * list. The id was right there in the response.
   */
  const [ok, setOk] = useState<{ message: string; orderId: string | null } | null>(null);

  const product = useMemo(() => products.find((p) => p.productCode === productCode) ?? null, [products, productCode]);

  // ── The family basket (owner, 2026-08-12) ──────────────────────────────────
  //
  // "make him able to choose lacto adv 1 and lacto adv 2 but this only with lacto". The rule is
  // NOT written here: familyAllowsMultipleItems and selectableFamilyMembers are the same functions
  // the server validates with, so the form can only ever offer what the server will accept. A
  // component with its own copy of the rule is a component that eventually offers a basket the
  // service refuses, and the requester is told no after filling the form in.
  //
  // selectableFamilyMembers also drops confidential products, so Lacto Basic 1/2 never appear.
  const siblings = useMemo(() => {
    if (!product || !familyAllowsMultipleItems(product.familyCode)) return [];
    return selectableFamilyMembers(products, product.familyCode).filter(
      (candidate) => candidate.productCode !== product.productCode,
    );
  }, [product, products]);

  // Which siblings are on the order, each with its own quantity and deal — two concentrations of
  // one product are still two different asks, and forcing them to share a quantity would be a
  // worse lie than not offering them at all.
  const [extraLines, setExtraLines] = useState<
    Record<string, { qty: string; dealType: DirectOrderDealType; bonus: string; discount: string }>
  >({});

  // Anything selected for a product that is no longer reachable — the requester changed the main
  // product, so its family changed — must go. Leaving it would submit a line the form no longer
  // shows, which is the worst kind of surprise on an order.
  const activeExtras = useMemo(
    () => Object.entries(extraLines).filter(([code]) => siblings.some((s) => s.productCode === code)),
    [extraLines, siblings],
  );
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
          // Only the lines still shown. Every rule about what may share a request is re-checked
          // server-side; this is the convenience, never the gate.
          items: activeExtras.map(([code, line]) => ({
            productCode: code,
            qty: Number(line.qty) || 0,
            dealType: line.dealType,
            bonus: line.dealType === "bonus" ? Number(line.bonus) || 0 : 0,
            discountPct: line.dealType === "discount" ? Number(line.discount) || 0 : null,
          })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        message?: string;
        result?: { id?: string };
      };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not submit the direct order.");
      setOk({
        message: overCap
          ? "Direct order submitted — flagged as over cap for your approvers, and on its way to the first of them."
          : "Direct order submitted — it is now with your first approver.",
        // Optional on purpose: a submit that succeeded but whose response shape surprises us still
        // shows the confirmation. Losing the link is a smaller failure than claiming the order did
        // not go through when it did.
        orderId: typeof data.result?.id === "string" ? data.result.id : null,
      });
      setProductCode("");
      setExtraLines({});
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
          {/* Invoice-photo prefill (spec B5). Above the fields because it fills them, and mounted
              on BOTH this form and its portal twin — a control that lives only here is a control no
              medical rep can reach, which this module already shipped once with the validation
              capture. It only ever proposes: nothing below moves until a line is accepted. */}
          <InvoiceCapture
            customerHint="Choose this pharmacy below to use it."
            onApply={(payload) => {
              setProductCode(payload.productCode);
              setQty(payload.qty);
              // A bonus quantity on the invoice IS a bonus deal; a discount is never legible from a
              // printed line, so it is left alone rather than guessed.
              if (payload.bonus) {
                setDealType("bonus");
                setBonus(payload.bonus);
              }
            }}
          />
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

          {/* ── The rest of this product's family ────────────────────────────
              Offered ONLY when the catalogue says this product's family may share a request —
              today Lacto alone. Every other product shows nothing here at all, so the form a
              requester already knows is unchanged for them.

              Each line carries its OWN quantity and deal. Two concentrations are two different
              asks: making them share one quantity would be a worse lie than not offering the
              second line. */}
          {siblings.length > 0 ? (
            <div className="border border-orange-200 bg-orange-50/40 p-3">
              <p className="text-[11px] font-black uppercase tracking-wider text-slate-600">
                Add another {product?.familyCode ? familyKey(product.familyCode) : ""} concentration
              </p>
              <p className="mt-0.5 text-[11px] leading-4 text-slate-500">
                These go on the SAME order. Only products from one family can share an order.
              </p>
              <div className="mt-2 space-y-2">
                {siblings.map((sibling) => {
                  const line = extraLines[sibling.productCode];
                  const on = Boolean(line);
                  return (
                    <div key={sibling.productCode} className="border border-slate-200 bg-white p-2">
                      <label className="flex items-center gap-2 text-sm font-bold text-slate-800">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(event) =>
                            setExtraLines((prev) => {
                              const next = { ...prev };
                              if (event.target.checked) {
                                // Starts on the SAME deal type as the main line — the common case is
                                // two concentrations on one arrangement — but each stays editable.
                                next[sibling.productCode] = { qty: "", dealType, bonus: "", discount: "" };
                              } else {
                                delete next[sibling.productCode];
                              }
                              return next;
                            })
                          }
                        />
                        {sibling.productName}
                      </label>

                      {on ? (
                        <div className="mt-2 grid gap-2 sm:grid-cols-3">
                          <label className="block">
                            <span className={labelClass()}>Quantity</span>
                            <input
                              type="number"
                              min="1"
                              inputMode="numeric"
                              className={inputClass()}
                              value={line.qty}
                              onChange={(event) =>
                                setExtraLines((prev) => ({
                                  ...prev,
                                  [sibling.productCode]: { ...prev[sibling.productCode], qty: event.target.value },
                                }))
                              }
                            />
                          </label>
                          <label className="block">
                            <span className={labelClass()}>Deal</span>
                            <select
                              className={inputClass()}
                              value={line.dealType}
                              onChange={(event) =>
                                setExtraLines((prev) => ({
                                  ...prev,
                                  [sibling.productCode]: {
                                    ...prev[sibling.productCode],
                                    dealType: event.target.value === "discount" ? "discount" : "bonus",
                                  },
                                }))
                              }
                            >
                              <option value="bonus">Bonus</option>
                              <option value="discount">Discount</option>
                            </select>
                          </label>
                          <label className="block">
                            <span className={labelClass()}>
                              {line.dealType === "discount" ? "Discount %" : "Bonus units"}
                            </span>
                            <input
                              type="number"
                              min="0"
                              inputMode="decimal"
                              className={inputClass()}
                              value={line.dealType === "discount" ? line.discount : line.bonus}
                              onChange={(event) =>
                                setExtraLines((prev) => ({
                                  ...prev,
                                  [sibling.productCode]:
                                    prev[sibling.productCode].dealType === "discount"
                                      ? { ...prev[sibling.productCode], discount: event.target.value }
                                      : { ...prev[sibling.productCode], bonus: event.target.value },
                                }))
                              }
                            />
                          </label>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {/* The cap is checked per PRODUCT server-side and flags rather than blocks, so no
                  number here is refused. Saying so stops a requester assuming a silent limit. */}
              <p className="mt-2 text-[11px] text-slate-500">
                Each line is priced and cap-checked on its own. Going over a cap flags the order for
                your approvers; it never blocks it.
              </p>
            </div>
          ) : null}

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

                {/* "Did you mean this pharmacy?" — never a block. Picking one switches straight into
                    the search-and-pick path; dismissing or ignoring it costs the rep nothing. */}
                {!nameMatchDismissed && nameMatches.length > 0 ? (
                  <div className="border border-sky-300 bg-sky-50 px-3 py-2">
                    <p className="text-[12px] font-bold text-sky-800">
                      Phoenix may already have this pharmacy in this area:
                    </p>
                    <div className="mt-1 space-y-1">
                      {nameMatches.map((hit) => (
                        <div
                          key={hit.phoenixPharmacyCode ?? `${hit.distributorCode}-${hit.customerCode}`}
                          className="flex items-center justify-between gap-2 border border-sky-200 bg-white px-2 py-1"
                        >
                          <span className="min-w-0 truncate text-[12px] text-slate-700" dir="auto">
                            {hit.customerName ?? hit.phoenixPharmacyCode}
                            {hit.phoenixPharmacyCode ? ` · ${hit.phoenixPharmacyCode}` : ""}
                          </span>
                          <button
                            type="button"
                            className="shrink-0 text-[12px] font-bold text-sky-700 hover:text-sky-900"
                            onClick={() => applySuggestedPharmacy(hit)}
                          >
                            Use this pharmacy
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="mt-1 text-[12px] font-semibold text-slate-500 hover:text-slate-700"
                      onClick={() => setNameMatchDismissed(true)}
                    >
                      No, this is a different pharmacy
                    </button>
                  </div>
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
          {/* The confirmation now offers the two things a person actually wants next: see the order
              they just raised, or raise the next one. Without them the only route onward was the
              browser's Back button, or hunting the order out of a list — and "Create another" is
              the honest name for what the form already did to itself (it clears the product fields
              and keeps the pharmacy, which is exactly the repeat-order case). */}
          {ok ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold text-emerald-600">{ok.message}</p>
              <div className="flex flex-wrap gap-2">
                {ok.orderId ? (
                  <Link
                    href={`${basePath}/${encodeURIComponent(ok.orderId)}`}
                    className="border border-emerald-600 px-3 py-1.5 text-[12px] font-black text-emerald-700 hover:bg-emerald-50"
                  >
                    View this order
                  </Link>
                ) : null}
                <Link
                  href={basePath}
                  className="border border-slate-300 px-3 py-1.5 text-[12px] font-black text-slate-600 hover:bg-slate-50"
                >
                  Back to Direct Orders
                </Link>
                <button
                  type="button"
                  onClick={() => setOk(null)}
                  className="border border-slate-300 px-3 py-1.5 text-[12px] font-black text-slate-600 hover:bg-slate-50"
                >
                  Create another
                </button>
              </div>
            </div>
          ) : null}

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
                      <DirectOrderStatusPill status={r.status} salesMonth={r.salesMonth} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                      {r.status === "pending_approval" ? r.activeStepLabel || "—" : "—"}
                    </td>
                    {/* The requester could see a summary row but never open it. Track leads to the
                        SAME detail the approvers read, so they can see exactly which rung holds it. */}
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <Link
                        href={`${basePath}/${encodeURIComponent(r.id)}`}
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
