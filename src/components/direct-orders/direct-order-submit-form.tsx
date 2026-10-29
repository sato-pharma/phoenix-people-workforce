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
import { CrmContactPicker } from "@/components/direct-orders/crm-contact-picker";
import type { VenueContactOption } from "@/lib/direct-orders/venue-contact-options";
import { DistributorCustomerPicker } from "@/components/direct-orders/distributor-customer-picker";
import { InvoiceCapture } from "@/components/direct-orders/invoice-capture";
import { prepareDirectOrderInvoiceFile, type PreparedDirectOrderInvoice } from "@/components/direct-orders/invoice-file";
import { PharmacyComboBox, type PharmacySearchHit } from "@/components/direct-orders/pharmacy-combo-box";
import { humanizeCode } from "@/lib/format/code-label";
import { cn } from "@/lib/utils";
import { phxButtonApproveDenseClassName } from "@/components/ui/form-tokens";

import { maxBonusUnits } from "@/lib/direct-orders/approval-flow";
import { describeDirectOrderBasketQuantities } from "@/lib/direct-orders/basket-label";
import { previewBasketValue } from "@/lib/direct-orders/basket-value";
import type {
  DirectOrderApprovalListItem,
  DirectOrderDealType,
  DirectOrderPharmacy,
  DirectOrderPharmacyPreflight,
} from "@/lib/direct-orders/types";
import {
  choiceRequiresDistributorCode,
  VENUE_TYPE_UNANSWERED_MESSAGE,
  VENUE_TYPES,
  // Both predicates are used here on purpose: the `choice*` form where the type may still be
  // unanswered, the plain one after `venueTypeIsAnswered` has narrowed it to a real venue.
  venueRequiresDistributorCode,
  venueTypeChoiceLabel,
  venueTypeIsAnswered,
  venueTypeLabel,
  type VenueTypeChoice,
} from "@/lib/venues/venue-type";
import { adminControlDepthClassName, adminPanelClassName, adminPanelHeaderClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

type ProductOption = {
  productCode: string;
  productName: string;
  /** The catalogue's grouping — the SAME field the server enforces the basket rule on. */
  familyCode: string;
  line: string;
  publicPrice: number | null;
  pharmacyPrice: number | null;
};
/** A campaign the requester may attach this order to. Labels only — the API returns no money. */
type CampaignOption = {
  id: string;
  requestCode: string;
  customerName: string | null;
  areaName: string | null;
  /** The campaign’s own line. Read back so the offer can be filtered to the product’s line. */
  lineName: string | null;
  status: string;
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
   * this form: portalShellRoles sends every District / Regional / National Sales Manager and
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
  return "block text-phx-xs font-black uppercase tracking-wider text-slate-500";
}
function inputClass() {
  return "mt-1 w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none";
}

export function DirectOrderSubmitForm({ products, areas, bricks, distributors, caps, myRequests, basePath }: Props) {
  const router = useRouter();

  // The CRM contact the submitter declares this venue to be. Optional: null is the normal case and
  // registers the venue exactly as before. See crm-contact-picker.tsx for why it is asked at all.
  const [crmContact, setCrmContact] = useState<VenueContactOption | null>(null);
  const [productCode, setProductCode] = useState("");
  const [dealType, setDealType] = useState<DirectOrderDealType>("bonus");
  const [qty, setQty] = useState("");
  const [bonus, setBonus] = useState("");
  const [discount, setDiscount] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [collectionDate, setCollectionDate] = useState("");
  // The campaign this order came from, declared by the requester (owner rule). Optional: most
  // direct orders are not campaign-driven, so "" is both the default and a valid answer.
  const [marketingRequestId, setMarketingRequestId] = useState("");
  const [campaignOptions, setCampaignOptions] = useState<CampaignOption[]>([]);

  // "mine" = the rep's own already-approved pharmacies (owner, 2026-08-13) — the fastest correct
  // answer, and the one that removes the reason duplicates get typed at all; "picked" = chosen from
  // the combo box (the normal path — spec B1); "new" = the explicit "not in the database" fallback,
  // which will wait for pharmacy validation.
  const [pharmacyMode, setPharmacyMode] = useState<"mine" | "picked" | "new">("picked");
  const [myPharmacies, setMyPharmacies] = useState<DirectOrderPharmacy[] | null>(null);
  const [myPharmaciesError, setMyPharmaciesError] = useState(false);
  const [pickedMine, setPickedMine] = useState<DirectOrderPharmacy | null>(null);
  const [pickedHit, setPickedHit] = useState<PharmacySearchHit | null>(null);
  const [newName, setNewName] = useState("");
  const [newAreaCode, setNewAreaCode] = useState("");
  const [newBrickId, setNewBrickId] = useState("");
  const [newDoctor, setNewDoctor] = useState("");
  const [newAddress, setNewAddress] = useState("");
  /**
   * What is actually being registered. A nursery has no distributor account, so it has no customer
   * code to give. Leaving the codes empty has been allowed here since 2026-08-04 — what was missing
   * is any way to say WHY they are empty, which is the difference between a venue that has no code
   * and one whose code nobody has typed yet.
   */
  // Starts UNANSWERED, not "pharmacy". A pre-selected answer is not a question — see
  // VenueTypeChoice for the venue this cost.
  const [newVenueType, setNewVenueType] = useState<VenueTypeChoice>(null);
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
  // 2026-08-13, second pass. The first version of this asked the SERVER nothing and looked only at
  // Phoenix's own pharmacies in the SAME AREA. Both limits hid the case that started this:
  //
  //   · The directory was excluded, yet the real "ابراهيم احمد الجديدة" was sitting in it the whole
  //     time as PS/0001544640 in the rep's own area. She could not see it, so she typed a code by
  //     hand — and that invented code is what collided.
  //   · A name alone does not identify a pharmacy. The owner's instruction is to show the
  //     distributor and its customer code beside every candidate, so the answer is decidable.
  //   · Area was too narrow; the scope is now the submitter's REGION.
  //
  // And the question it could never ask at all: is the CODE already taken? That one used to surface
  // as "Could not create the venue." AFTER a codeless duplicate had already been committed.
  const [preflight, setPreflight] = useState<DirectOrderPharmacyPreflight>({ codeConflicts: [], nameMatches: [] });
  const [nameMatchDismissed, setNameMatchDismissed] = useState(false);
  /**
   * The submitter answered "no, mine is a different pharmacy" to a code collision.
   *
   * Sent to the server, which re-checks the collision itself and records the contested claim rather
   * than trusting this flag. It can only ever ADD the dispute — it can never skip the check.
   */
  const [acknowledgedCodeConflict, setAcknowledgedCodeConflict] = useState(false);
  const preflightSeq = useRef(0);

  const distRowsKey = distRows.map((row) => `${row.distributorCode}:${row.customerCode}`).join("|");

  useEffect(() => {
    // Every setState lives inside the scheduled callback, matching the combo box's own debounced
    // effect (pharmacy-combo-box.tsx) — never a bare setState in the effect body.
    const name = newName.trim();
    const mySeq = ++preflightSeq.current;
    if (pharmacyMode !== "new" || name.length < 2) {
      const timer = setTimeout(() => {
        if (preflightSeq.current !== mySeq) return;
        setPreflight({ codeConflicts: [], nameMatches: [] });
      }, 0);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(async () => {
      if (preflightSeq.current !== mySeq) return;
      // A fresh name, area or code deserves a fresh chance to ask, even if an earlier suggestion
      // (for different text) was dismissed. The same applies to the conflict acknowledgement: it
      // answers ONE specific collision, so changing the codes must retract it.
      setNameMatchDismissed(false);
      setAcknowledgedCodeConflict(false);
      try {
        const res = await fetch("/api/direct-orders/pharmacies/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pharmacyName: name,
            areaCode: newAreaCode || null,
            // Read off `bricks` (a prop) rather than the `selectedBrick` memo below: this effect is
            // declared above it, so naming it in the dependency array would be a TDZ error at
            // render. The server falls back to the area's own region when this is null anyway.
            regionCode: bricks.find((brick) => brick.brickId === newBrickId)?.regionCode ?? null,
            // Never for a codeless venue: a stale row would raise a collision against a code this
            // venue is not going to claim, and the answer to it ("no, mine is different") would be
            // recorded as a contested claim on someone else's code.
            distributorCodes: choiceRequiresDistributorCode(newVenueType)
              ? distRows
                .map((row) => ({ distributorCode: row.distributorCode.trim(), customerCode: row.customerCode.trim() }))
                .filter((row) => row.distributorCode && row.customerCode)
              : [],
          }),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<DirectOrderPharmacyPreflight>;
        if (preflightSeq.current !== mySeq) return;
        setPreflight({
          codeConflicts: Array.isArray(data.codeConflicts) ? data.codeConflicts : [],
          nameMatches: Array.isArray(data.nameMatches) ? data.nameMatches : [],
        });
      } catch {
        // A failed check must never stop a rep working. It only ever ADDS a question, and the
        // server re-checks the collision at create time regardless.
        if (preflightSeq.current === mySeq) setPreflight({ codeConflicts: [], nameMatches: [] });
      }
    }, 400);
    return () => clearTimeout(timer);
    // distRowsKey is a content-derived proxy for distRows, kept out of the array on purpose so a
    // re-render that doesn't actually change any row doesn't reset the debounce timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newName, newAreaCode, newBrickId, bricks, pharmacyMode, newVenueType, distRowsKey]);

  // "My pharmacies" is fetched once, the first time the tab is opened. It is a short, personal list
  // that only changes when one of this rep's own orders is approved, so re-fetching on every visit
  // would buy nothing across the Atlantic round trip this costs.
  useEffect(() => {
    if (pharmacyMode !== "mine" || myPharmacies !== null) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/direct-orders/pharmacies/mine");
        const data = (await res.json().catch(() => ({}))) as { pharmacies?: DirectOrderPharmacy[]; success?: boolean };
        if (cancelled) return;
        if (!res.ok || !data.success || !Array.isArray(data.pharmacies)) {
          // An empty list and a failed load mean different things to a rep about to type a
          // pharmacy in by hand, so they must never render the same sentence.
          setMyPharmaciesError(true);
          setMyPharmacies([]);
          return;
        }
        setMyPharmaciesError(false);
        setMyPharmacies(data.pharmacies);
      } catch {
        if (cancelled) return;
        setMyPharmaciesError(true);
        setMyPharmacies([]);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pharmacyMode, myPharmacies]);

  // NOT a hook — named to avoid the "use…" prefix, which react-hooks/rules-of-hooks enforces by
  // naming convention alone and would (correctly) reject this being called from an onClick handler.
  //
  // Every "yes, that is the one" answer lands here — a name suggestion AND a code collision — and
  // all of them leave the rep on the ordinary search-and-pick path. That matters: the server then
  // resolves the pharmacy from the catalogue by pointer alone, so nothing typed on this form
  // describes the pharmacy that gets used (spec A1/B3), and no new server path had to exist for
  // either question to be answerable.
  function applySuggestedPharmacy(hit: {
    source: "phoenix" | "directory";
    pharmacyName: string;
    distributorCode: string | null;
    customerCode: string | null;
    phoenixPharmacyCode: string | null;
    areaCode: string | null;
    areaName: string;
    regionCode: string | null;
    regionName: string;
    pharmacyAddress: string | null;
  }) {
    setPickedHit({
      source: hit.source,
      distributorCode: hit.distributorCode,
      customerCode: hit.customerCode,
      customerName: hit.pharmacyName,
      address: hit.pharmacyAddress,
      // Deliberately not carried across. The catalogue row is re-read server-side, and guessing a
      // brick off a half-typed form is exactly the kind of made-up geography this whole change
      // exists to stop.
      brickId: null,
      areaCode: hit.areaCode,
      areaName: hit.areaName,
      regionCode: hit.regionCode,
      regionName: hit.regionName,
      phoenixPharmacyCode: hit.phoenixPharmacyCode,
      verificationStatus: null,
      // Empty rather than looked up: this path is the "did you mean this pharmacy?" suggestion
      // built from what the submitter has typed so far, not a row the picker returned, so there
      // is no confirmed link behind it to report — and the server re-reads the catalogue row.
      alsoKnownAs: [],
    });
    setPharmacyMode("picked");
    setPreflight({ codeConflicts: [], nameMatches: [] });
    setAcknowledgedCodeConflict(false);
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
  // The invoice photo read above, sent WITH the order so the approvers see the invoice that was used
  // (owner, 2026-09-14). The rep can drop it; nothing requires one.
  const [invoicePhoto, setInvoicePhoto] = useState<PreparedDirectOrderInvoice | null>(null);
  const [invoicePhotoError, setInvoicePhotoError] = useState<string | null>(null);

  const product = useMemo(() => products.find((p) => p.productCode === productCode) ?? null, [products, productCode]);

  // Campaigns for the chosen product's line. Re-fetched whenever the line changes, because a
  // campaign is only offerable against its own line — and the selection is cleared when the new
  // list no longer contains it, so changing product can never leave a stale campaign attached.
  // The server re-validates on submit regardless; this keeps the form honest, it does not gate.
  const productLine = product?.line ?? "";
  useEffect(() => {
    // No synchronous setState here: eslint forbids it (react-hooks/set-state-in-effect), and it is
    // not needed. Nothing is CLEARED on a line change — campaignOptionsForLine below derives the
    // offer from the line, so the previous line's campaigns stop being offered the instant the
    // product changes, without waiting for the new fetch and without a second render.
    if (!productLine) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/direct-orders/campaign-options?line=${encodeURIComponent(productLine)}`);
        const data = (await res.json().catch(() => ({}))) as { options?: CampaignOption[] };
        if (cancelled) return;
        setCampaignOptions(Array.isArray(data.options) ? data.options : []);
      } catch {
        // A campaign is optional, so a failed lookup must degrade to "no campaigns offered" rather
        // than showing an error the requester cannot act on or blocking a submission that is valid.
        if (!cancelled) setCampaignOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productLine]);

  // What may actually be offered, and what is actually selected — both DERIVED, never stored.
  // A campaign only belongs to this order if it sits on the product's own line, so filtering by
  // line here means a stale response (or an in-flight one for the previous product) can never put
  // another line's campaign in the list. The selection is read back through the same filter, so a
  // choice that stops being offered simply stops being submitted — the server re-validates anyway.
  const campaignOptionsForLine = useMemo(() => {
    const key = productLine.trim().toLowerCase();
    if (!key) return [] as CampaignOption[];
    return campaignOptions.filter((option) => (option.lineName ?? "").trim().toLowerCase() === key);
  }, [campaignOptions, productLine]);
  const selectedCampaignId = campaignOptionsForLine.some((option) => option.id === marketingRequestId)
    ? marketingRequestId
    : "";

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
  // The value shown is the WHOLE order: the main line plus every extra concentration still on it,
  // each priced by the same functions the server uses (basket-value.ts). It used to price the main
  // line alone, so adding Lacto Advanced 2 left the number exactly where it was.
  const basket = useMemo<ReturnType<typeof previewBasketValue>>(() => {
    if (!product) return { lines: [], total: 0 };
    return previewBasketValue([
      {
        productCode: product.productCode,
        productName: product.productName,
        dealType,
        qty: qtyNum,
        discountPct: discountNum,
        publicPrice: product.publicPrice,
        pharmacyPrice: product.pharmacyPrice,
      },
      ...activeExtras.map(([code, line]) => {
        const member = products.find((candidate) => candidate.productCode === code);
        return {
          productCode: code,
          productName: member?.productName ?? code,
          dealType: line.dealType,
          qty: Number(line.qty) || 0,
          discountPct: Number(line.discount) || 0,
          publicPrice: member?.publicPrice ?? null,
          pharmacyPrice: member?.pharmacyPrice ?? null,
        };
      }),
    ]);
  }, [product, products, dealType, qtyNum, discountNum, activeExtras]);
  const salesValue = basket.total;
  const isBasketOrder = basket.lines.length > 1;
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
    // A codeless venue does not render these rows at all, so a leftover half-typed row from before
    // the type was switched must not silently disable the submit button with nothing to point at.
    // An UNANSWERED type renders none of them either, and is refused on its own below.
    choiceRequiresDistributorCode(newVenueType) &&
    distRows.some((row) => Boolean(row.distributorCode.trim()) !== Boolean(row.customerCode.trim()));

  // A bonus deal is valued on the pharmacy price alone. Without one the server refuses the
  // submission (owner ruling, 2026-08-04), so the button must refuse it too rather than letting
  // the request round-trip into an error. This mirrors the discount branch's public-price rule.
  const missingBonusBasis = dealType === "bonus" && !!product && !hasPharmacyPrice;

  /**
   * A code collision the submitter has not answered yet.
   *
   * This is a QUESTION, not a refusal: both answers keep her moving. "Yes, that is the pharmacy"
   * uses the existing record; "No, mine is different" registers hers without the code and sends the
   * dispute to a reviewer. What it prevents is the third outcome, which is the one that actually
   * happened — a silent second pharmacy carrying a code that belongs to somebody else, or (once the
   * rep works around the refusal) carrying an invented one like "000000".
   *
   * The server refuses an unacknowledged collision by name regardless, so this only decides whether
   * she is asked here or told after a round trip.
   */
  const unansweredCodeConflict =
    pharmacyMode === "new" && preflight.codeConflicts.length > 0 && !acknowledgedCodeConflict;

  /**
   * A new venue whose type nobody has said yet.
   *
   * The picker has been on this form since 2026-08-23 and it changed nothing on its own, because it
   * arrived pre-answered: a rep standing at a nursery types the name and moves on, and the venue is
   * filed as a pharmacy. Blocking here is what turns it back into a question.
   */
  const unansweredVenueType = pharmacyMode === "new" && !venueTypeIsAnswered(newVenueType);

  // Mirrors submit()'s hard preconditions only. An over-cap deal is still NOT gated here —
  // over cap is flagged and submitted (owner rule, 2026-08-03).
  const readyToSubmit =
    !busy &&
    !!product &&
    qtyNum > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(collectionDate) &&
    !halfFilledDistRow &&
    !missingBonusBasis &&
    !unansweredCodeConflict &&
    !unansweredVenueType &&
    (pharmacyMode !== "mine" || !!pickedMine);

  function updateDistRow(index: number, patch: Partial<{ distributorCode: string; customerCode: string }>) {
    setDistRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function createPharmacyIfNeeded(): Promise<string> {
    // Already one of the rep's own approved pharmacies — there is nothing to create or resolve, and
    // deliberately no server round trip: the id came from a list the server itself just scoped to
    // this person. This is the path the other two exist to funnel people into.
    if (pharmacyMode === "mine") {
      if (!pickedMine) throw new Error("Pick one of your venues, or search the full database.");
      return pickedMine.id;
    }
    if (pharmacyMode === "picked") {
      if (!pickedHit) throw new Error("Search for the venue and pick it from the list.");
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
      if (!res.ok || !data.success || !data.pharmacy) throw new Error(data.message || "Could not resolve the selected venue.");
      return data.pharmacy.id;
    }
    if (!newName.trim()) throw new Error(`${venueTypeChoiceLabel(newVenueType)} name is required.`);
    if (!newDoctor.trim()) throw new Error("Doctor name is required.");
    if (!newAddress.trim()) throw new Error(`${venueTypeChoiceLabel(newVenueType)} address is required.`);
    // readyToSubmit blocks this first. Repeated here for the same reason as the half-filled row
    // above — so the client cannot send a venue with no stated type if that gate is ever bypassed,
    // and so the type below narrows without an assertion.
    if (!venueTypeIsAnswered(newVenueType)) throw new Error(VENUE_TYPE_UNANSWERED_MESSAGE);
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
        // The server refuses a code on a venue that cannot hold one, so the rows left behind by a
        // type switch would 400 the whole registration rather than being quietly ignored.
        distributorCodes: venueRequiresDistributorCode(newVenueType) ? pairs : [],
        venueType: newVenueType,
        // The declared CRM contact, or null. The server re-resolves the submitter's own scope and
        // refuses an id outside it, so this is a convenience for the form, never the authority.
        crmContactId: crmContact?.contactCrmId ?? null,
        // "No, mine is a different venue." The server re-checks the collision and records the
        // contested claim; it never takes this flag as permission to claim the code.
        acknowledgedCodeConflict,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; pharmacy?: DirectOrderPharmacy };
    if (!res.ok || !data.success || !data.pharmacy) throw new Error(data.message || "Could not create the venue.");
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
          marketingRequestId: selectedCampaignId || null,
          invoiceDataUrl: invoicePhoto?.dataUrl ?? null,
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
        result?: { id?: string; invoiceNote?: string | null };
      };
      if (!res.ok || !data.success) throw new Error(data.message || "Could not submit the direct order.");
      const invoiceNote = typeof data.result?.invoiceNote === "string" ? ` ${data.result.invoiceNote}` : "";
      setOk({
        message: `${
          overCap
            ? "Direct order submitted — flagged as over cap for your approvers, and on its way to the first of them."
            : "Direct order submitted — it is now with your first approver."
        }${invoiceNote}`,
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
      setInvoicePhoto(null);
      setInvoicePhotoError(null);
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
      <section className={adminPanelClassName}>
        <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
          <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">New direct order</h3>
        </header>
        <div className="space-y-4 px-4 py-4">
          {/* Invoice-photo prefill (spec B5). Above the fields because it fills them, and mounted
              on BOTH this form and its portal twin — a control that lives only here is a control no
              medical rep can reach, which this module already shipped once with the validation
              capture. It only ever proposes: nothing below moves until a line is accepted. */}
          <InvoiceCapture
            customerHint="Using a line also picks this pharmacy below."
            onApply={(payload) => {
              setProductCode(payload.productCode);
              setQty(payload.qty);
              // A bonus quantity on the invoice IS a bonus deal; a discount is never legible from a
              // printed line, so it is left alone rather than guessed.
              if (payload.bonus) {
                setDealType("bonus");
                setBonus(payload.bonus);
              }
              // The pharmacy the invoice names, when the master database confirmed it (owner,
              // 2026-09-14). This used to be shown and then dropped: Weaam's invoice matched
              // PharmaOverseas 1533756 four times, she registered the pharmacy by hand, and it was
              // saved with no code at all. Routing it through the ordinary pick means the server
              // re-reads the customer map by the pair and reuses a Phoenix pharmacy already holding
              // it; "Change" still lets the rep pick another.
              const customer = payload.customer;
              if (customer?.distributorCode && customer.customerCode) {
                applySuggestedPharmacy({
                  source: "directory",
                  pharmacyName: customer.customerName ?? customer.customerCode,
                  distributorCode: customer.distributorCode,
                  customerCode: customer.customerCode,
                  phoenixPharmacyCode: null,
                  areaCode: customer.areaCode,
                  areaName: customer.areaName,
                  regionCode: null,
                  regionName: "",
                  pharmacyAddress: null,
                });
              }
            }}
            onInvoicePhoto={(file) => {
              setInvoicePhotoError(null);
              prepareDirectOrderInvoiceFile(file)
                .then(setInvoicePhoto)
                .catch((prepareError: unknown) => {
                  setInvoicePhoto(null);
                  setInvoicePhotoError(
                    prepareError instanceof Error ? prepareError.message : "That invoice photo could not be kept with the order.",
                  );
                });
            }}
          />
          {invoicePhoto ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border border-emerald-300 bg-emerald-50 px-3 py-2">
              <p className="text-phx-sm font-semibold text-emerald-900">
                This invoice is sent with the order, so your approvers see the invoice you used.
              </p>
              <button
                type="button"
                onClick={() => setInvoicePhoto(null)}
                className="text-phx-xs font-bold text-orange-600"
              >
                Don&apos;t attach it
              </button>
            </div>
          ) : invoicePhotoError ? (
            <p className="text-phx-sm font-semibold text-rose-700">{invoicePhotoError}</p>
          ) : null}
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
              <p className="text-phx-xs font-black uppercase tracking-wider text-slate-600">
                Add another {product?.familyCode ? familyKey(product.familyCode) : ""} concentration
              </p>
              <p className="mt-0.5 text-phx-xs leading-4 text-slate-500">
                These go on the SAME order. Only products from one family can share an order.
              </p>
              <div className="mt-2 space-y-2">
                {siblings.map((sibling) => {
                  const line = extraLines[sibling.productCode];
                  const on = Boolean(line);
                  return (
                    <div key={sibling.productCode} className={`border border-slate-200 bg-white p-2 ${adminSoftDepthClassName}`}>
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
              <p className="mt-2 text-phx-xs text-slate-500">
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
                  <p className={`mt-1 text-phx-xs ${overCap ? "font-bold text-rose-600" : "text-slate-500"}`}>
                    {bonusNum.toLocaleString("en-US")} free units = {((bonusNum / qtyNum) * 100).toFixed(1)}% of
                    {" "}{qtyNum.toLocaleString("en-US")}. Max {maxBonus} ({bonusCapPct}%)
                    {overCap ? " — over cap" : ""}
                  </p>
                ) : product ? (
                  <p className="mt-1 text-phx-xs text-slate-500">
                    Free UNITS, not a percentage. Enter a quantity to see what it works out as.
                  </p>
                ) : null}
              </div>
            ) : (
              <div>
                <label className={labelClass()}>Discount %</label>
                <input className={inputClass()} inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" />
                <p className={`mt-1 text-phx-xs ${overCap ? "font-bold text-rose-600" : "text-slate-500"}`}>
                  Cap: {discountCapPct}%{overCap ? " — over cap" : ""}
                </p>
              </div>
            )}
          </div>

          {dealType === "discount" && product && !hasPublicPrice ? (
            <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-phx-sm font-semibold text-rose-700">
              No public price is set for {product.productName}. Ask an admin to set it, or use bonus mode.
            </p>
          ) : null}

          {/* This note used to say the order "will be valued at the factory price". There is no
              factory-price fallback any more — a bonus deal is priced on the pharmacy price or it
              is refused, so the message now states the refusal rather than promising a basis. */}
          {missingBonusBasis ? (
            <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-phx-sm font-semibold text-rose-700">
              No pharmacy price is set for {product?.productName}. A bonus deal is valued on the pharmacy
              price, so this order cannot be submitted until an admin sets it.
            </p>
          ) : null}

          {overCap ? (
            <div className="space-y-2 border border-amber-300 bg-amber-50 px-3 py-2.5">
              <p className="text-phx-sm font-bold text-amber-800">
                Over cap — this request still submits and goes through the normal approval chain. It is flagged for every approver, not blocked.
              </p>
              <div>
                <label className={labelClass()}>Note for the approvers (optional)</label>
                <textarea className={inputClass()} rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Why this exceeds the cap…" />
              </div>
            </div>
          ) : null}

          <div className="border border-orange-200 bg-orange-50 px-3 py-2 text-sm">
            <span className="font-black uppercase tracking-wider text-phx-xs text-orange-700">
              {isBasketOrder
                ? "Sales value (total)"
                : `Sales value (${dealType === "discount" ? "public × (1−disc%)" : "bonus excluded"})`}
            </span>
            <div className="text-lg font-black text-slate-900">{money(salesValue)}</div>
            {isBasketOrder ? (
              // One row per line, so the requester can see each concentration was counted and what
              // it contributed. A line the server would refuse for a missing price says so here
              // rather than quietly adding nothing.
              <ul className="mt-1 space-y-1">
                {basket.lines.map((line) => (
                  <li key={line.productCode} className="break-words text-phx-xs text-slate-500">
                    <span className="font-bold text-slate-700">{line.productName}</span>
                    {" — "}
                    {line.dealType === "discount"
                      ? `${line.qty.toLocaleString("en-US")} × ${money(line.basisPrice ?? 0)} × (1 − ${line.discountPct}%)`
                      : `${line.qty.toLocaleString("en-US")} × ${money(line.basisPrice ?? 0)} pharmacy price`}
                    {" = "}
                    <span className="font-bold text-slate-700">{money(line.salesValue)}</span>
                    {line.basisPrice == null ? (
                      <span className="block font-bold text-rose-600">
                        No {line.dealType === "discount" ? "public" : "pharmacy"} price is set for this product, so
                        this line cannot be submitted.
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : product ? (
              <div className="text-phx-xs text-slate-500">
                {dealType === "discount"
                  ? `${qtyNum.toLocaleString("en-US")} × ${money(product.publicPrice ?? 0)} × (1 − ${discountNum}%)`
                  : `${qtyNum.toLocaleString("en-US")} × ${money(bonusBasis)} pharmacy price`}
              </div>
            ) : null}
          </div>

          <div>
            <label className={labelClass()}>Money collection date *</label>
            <input type="date" className={inputClass()} value={collectionDate} onChange={(e) => setCollectionDate(e.target.value)} />
            <p className="mt-1 text-phx-xs text-slate-400">When you expect this direct order to be collected / paid (تاريخ التحصيل).</p>
          </div>

          {/* The campaign this order came from. Shown only once a product is chosen, because the
              list is scoped to that product's line — offering it earlier would show an empty box
              for a reason the requester cannot see. Optional by design: leaving it as "No campaign"
              is the ordinary answer for most orders. */}
          {product ? (
            <div>
              <label className={labelClass()}>Came from a campaign</label>
              <select
                className={inputClass()}
                value={selectedCampaignId}
                onChange={(e) => setMarketingRequestId(e.target.value)}
              >
                <option value="">No campaign</option>
                {campaignOptionsForLine.map((option) => (
                  <option key={option.id} value={option.id}>
                    {[
                      option.customerName,
                      option.areaName,
                      option.status === "active" ? null : humanizeCode(option.status),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-phx-xs text-slate-400">
                {campaignOptionsForLine.length === 0
                  ? `You have no open approved ${product.line} campaign of your own, so this order is recorded without one.`
                  : "Pick it only if this order came out of that campaign — it credits the campaign’s ROI with this sale."}
              </p>
            </div>
          ) : null}

          {/* Pharmacy — combo box over the master database (spec B1/B2/B3), now behind three tabs. */}
          <div className="border-t border-[#eef1f3] pt-3">
            <label className={labelClass()}>Venue *</label>

            {/* Three ways in, ordered by what each one costs the rep AND what it costs the data.
                "My pharmacies" is first because it is the only one that cannot create anything:
                every duplicate cluster in production was a rep re-entering a pharmacy she had
                already used successfully — twice on the same day, in the worst case — and until
                today her own history was the one list the form never showed her. */}
            <div className="mt-1 flex flex-wrap border border-[#eef1f3]">
              {(
                [
                  { mode: "mine", label: "My venues" },
                  { mode: "picked", label: "Search" },
                  { mode: "new", label: "New venue" },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.mode}
                  type="button"
                  onClick={() => setPharmacyMode(tab.mode)}
                  className={`px-3 py-1.5 text-phx-xs font-black uppercase tracking-wider ${
                    pharmacyMode === tab.mode ? "bg-orange-500 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {pharmacyMode === "mine" ? (
              <div className="mt-1.5">
                {myPharmacies === null ? (
                  <p className="text-phx-sm font-semibold text-slate-500">Loading your venues…</p>
                ) : myPharmaciesError ? (
                  // An empty list and a failed load must never read the same. One says "you have
                  // none yet"; the other says "we do not know", and only the second is a reason to
                  // go and search rather than trust the emptiness.
                  <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-phx-sm font-bold text-amber-800">
                    Your venues could not be loaded. Use Search before adding a new venue — do
                    not retype one you have ordered on before.
                  </p>
                ) : myPharmacies.length === 0 ? (
                  <p className="border border-[#eef1f3] px-3 py-2 text-phx-sm font-semibold text-slate-500">
                    No approved venues yet. A venue lands here once one of your orders on it is
                    approved, or once you validate a customer at it for marketing requests — and
                    from then on it is one click.
                  </p>
                ) : (
                  <div className="max-h-64 space-y-1 overflow-y-auto">
                    {myPharmacies.map((pharmacy) => {
                      const chosen = pickedMine?.id === pharmacy.id;
                      const codeLine = pharmacy.distributorCodes
                        .map((code) => `${code.distributorName || code.distributorCode} ${code.customerCode}`)
                        .join(" · ");
                      return (
                        <button
                          key={pharmacy.id}
                          type="button"
                          onClick={() => setPickedMine(pharmacy)}
                          className={`block w-full min-w-0 break-words border px-2.5 py-1.5 text-left ${
                            chosen ? "border-emerald-400 bg-emerald-50" : "border-[#eef1f3] bg-white hover:bg-slate-50"
                          }`}
                        >
                          <span className="block break-words text-phx-md font-black text-slate-900" dir="auto">
                            {pharmacy.pharmacyName}
                          </span>
                          <span className="block break-words text-phx-xs font-semibold text-slate-600">
                            {codeLine || "No distributor code"}
                          </span>
                          <span className="block break-words text-phx-xs text-slate-500" dir="auto">
                            {areas.find((area) => area.areaCode === pharmacy.areaCode)?.areaName ||
                              pharmacy.areaCode ||
                              "No area on file"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : pharmacyMode === "picked" ? (
              pickedHit ? (
                <div className="mt-1 border border-emerald-300 bg-emerald-50 px-3 py-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-phx-md font-black text-slate-900" dir="auto">
                        {pickedHit.customerName ?? `${pickedHit.customerCode} — (no name on file)`}
                      </p>
                      <p className="mt-0.5 text-phx-xs font-semibold text-slate-600">
                        {pickedHit.phoenixPharmacyCode ? `${pickedHit.phoenixPharmacyCode} · ` : ""}
                        {pickedHit.distributorCode ? `${pickedHit.distributorCode} · ${pickedHit.customerCode}` : ""}
                      </p>
                      {pickedHit.address ? (
                        <p className="mt-0.5 text-phx-xs text-slate-500" dir="auto">{pickedHit.address}</p>
                      ) : null}
                      {/* Geography comes WITH the customer and cannot be edited (spec B3). */}
                      <p className="mt-1 text-phx-xs font-bold text-emerald-700">
                        Area: {pickedHit.areaName || pickedHit.areaCode || "—"} · Region: {pickedHit.regionName || pickedHit.regionCode || "—"}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 text-phx-sm font-bold text-orange-600 hover:text-orange-700"
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
                    className="text-phx-sm font-semibold text-slate-500 underline hover:text-slate-700"
                    onClick={() => setPharmacyMode("new")}
                  >
                    My venue is not in the database…
                  </button>
                </div>
              )
            ) : (
              <div className="mt-1 space-y-2">
                <div className="border border-amber-300 bg-amber-50 px-3 py-2">
                  <p className="text-phx-sm font-bold text-amber-800">
                    This venue is not in the master database, so the request will NOT enter the
                    approval flow until the venue is validated. Search first — most venues
                    are already there under a slightly different spelling.
                  </p>
                  <button
                    type="button"
                    className="mt-1 text-phx-sm font-bold text-orange-600 hover:text-orange-700"
                    onClick={() => setPharmacyMode("picked")}
                  >
                    ← Back to search
                  </button>
                </div>
                <div
                  className={
                    unansweredVenueType ? "border border-orange-300 bg-orange-50/60 p-2" : "border border-[#eef1f3] p-2"
                  }
                >
                  <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">What is this? *</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    {VENUE_TYPES.map((venueType) => (
                      <button
                        className={
                          newVenueType === venueType
                            ? "border border-orange-300 bg-orange-50 px-2.5 py-1 text-phx-sm font-black text-orange-700"
                            : `border border-[#eef1f3] bg-white px-2.5 py-1 text-phx-sm font-bold text-slate-600 hover:bg-slate-50 ${adminControlDepthClassName}`
                        }
                        key={venueType}
                        onClick={() => setNewVenueType(venueType)}
                        type="button"
                      >
                        {venueTypeLabel(venueType)}
                      </button>
                    ))}
                  </div>
                  {/* Three states, never two: unanswered says so, nursery explains itself, pharmacy is silent. */}
                  {!venueTypeIsAnswered(newVenueType) ? (
                    <p className="mt-1 text-phx-xs font-bold text-orange-700">{VENUE_TYPE_UNANSWERED_MESSAGE}</p>
                  ) : venueRequiresDistributorCode(newVenueType) ? null : (
                    <p className="mt-1 text-phx-xs font-semibold text-slate-500">
                      A {venueTypeLabel(newVenueType).toLowerCase()} has no distributor account, so it has no
                      customer code. Register it as one — never as a pharmacy with a made-up code.
                    </p>
                  )}
                </div>
                <input
                  className={inputClass()}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={`${venueTypeChoiceLabel(newVenueType)} name *`}
                  value={newName}
                />
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
                  <p className="text-phx-xs text-slate-500">
                    Area {selectedBrick.areaName || selectedBrick.areaCode} · Region {selectedBrick.regionName || selectedBrick.regionCode}
                  </p>
                ) : null}

                {/* "Did you mean this pharmacy?" — never a block. Picking one switches straight into
                    the search-and-pick path; dismissing or ignoring it costs the rep nothing.
                    Every candidate carries its distributor AND that distributor's customer code
                    (owner, 2026-08-13), because a name on its own does not identify a pharmacy —
                    that is precisely how two "حضانه زمزم" records ended up in D15. */}
                {!nameMatchDismissed && preflight.nameMatches.length > 0 ? (
                  <div className="border border-sky-300 bg-sky-50 px-3 py-2">
                    <p className="text-phx-sm font-bold text-sky-800">
                      Did you mean one of these? A venue with this name is already registered in
                      your region.
                    </p>
                    <div className="mt-1 space-y-1">
                      {preflight.nameMatches.map((hit) => (
                        <div
                          key={`${hit.source}-${hit.phoenixPharmacyCode ?? ""}-${hit.distributorCode ?? ""}-${hit.customerCode ?? ""}`}
                          className="flex items-start justify-between gap-2 border border-sky-200 bg-white px-2 py-1.5"
                        >
                          <div className="min-w-0">
                            <span className="block break-words text-phx-sm font-bold text-slate-800" dir="auto">
                              {hit.pharmacyName}
                            </span>
                            <span className="block break-words text-phx-xs font-semibold text-slate-600">
                              {hit.distributorCode
                                ? `${hit.distributorName || hit.distributorCode} · code ${hit.customerCode}`
                                : "No distributor code on file"}
                            </span>
                            <span className="block break-words text-phx-xs text-slate-500" dir="auto">
                              {hit.areaName || hit.areaCode || "No area"} · {hit.regionName || hit.regionCode || "No region"}
                              {hit.pharmacyAddress ? ` · ${hit.pharmacyAddress}` : ""}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="shrink-0 border border-sky-600 px-2 py-1 text-phx-sm font-black text-sky-700 hover:bg-sky-100"
                            onClick={() => applySuggestedPharmacy(hit)}
                          >
                            Yes, this one
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="mt-1 text-phx-sm font-semibold text-slate-500 hover:text-slate-700"
                      onClick={() => setNameMatchDismissed(true)}
                    >
                      No, mine is a different venue
                    </button>
                  </div>
                ) : null}
                <input className={inputClass()} value={newDoctor} onChange={(e) => setNewDoctor(e.target.value)} placeholder="Doctor name *" />
                <input
                  className={inputClass()}
                  onChange={(e) => setNewAddress(e.target.value)}
                  placeholder={`${venueTypeChoiceLabel(newVenueType)} address *`}
                  value={newAddress}
                />

                {/* The one thing that lets this order ever reach the rep's CRM contact list.
                    Optional by design — see the component header. */}
                <CrmContactPicker onChange={setCrmContact} picked={crmContact} />

                {/* Optional since 2026-08-04 — the note explains what leaving it empty costs. */}
                {/* Hidden until the type is known: asking a venue for a code before it has said it
                    is a pharmacy is exactly how the invented codes got made. */}
                <div className={choiceRequiresDistributorCode(newVenueType) ? "border border-[#eef1f3] p-2" : "hidden"}>
                  <p className="text-phx-xs font-black uppercase tracking-wider text-slate-500">Distributor customer codes</p>
                  <p className="mb-1 text-phx-xs font-semibold text-slate-500">
                    Optional. Leave it empty if you do not know them — but the order cannot be
                    finalized until the venue passes validation.
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
                  <button type="button" className="text-phx-sm font-bold text-orange-600 hover:text-orange-700" onClick={() => setDistRows((prev) => [...prev, { distributorCode: "", customerCode: "" }])}>
                    + Add distributor
                  </button>
                </div>

                {/* The code is already taken (owner, 2026-08-13).
                    This is the question that used to be a dead end. The code went to the server, the
                    unique index refused it, and the rep read "Could not create the venue." — after
                    a codeless duplicate of her pharmacy had ALREADY been committed by the untransacted
                    half of the insert. She then either re-typed the pharmacy again or invented a code
                    ("000000" is in production twice) to get past it.

                    So it is asked here, with the pharmacy that holds the code named on screen, and
                    BOTH answers move her forward. There is no third outcome where she is simply
                    stuck. */}
                {preflight.codeConflicts.length > 0 ? (
                  <div className="border-2 border-rose-400 bg-rose-50 px-3 py-2.5">
                    <p className="text-phx-sm font-black text-rose-800">
                      This distributor code already belongs to a registered pharmacy. Did you mean this
                      one?
                    </p>
                    <div className="mt-1.5 space-y-1.5">
                      {preflight.codeConflicts.map((conflict) => (
                        <div
                          key={`${conflict.distributorCode}-${conflict.customerCode}`}
                          className="border border-rose-200 bg-white px-2 py-1.5"
                        >
                          <div className="min-w-0">
                            <span className="block break-words text-phx-md font-black text-slate-900" dir="auto">
                              {conflict.heldBy.pharmacyName}
                            </span>
                            <span className="block break-words text-phx-xs font-semibold text-slate-600">
                              {conflict.distributorName || conflict.distributorCode} · code{" "}
                              {conflict.customerCode}
                            </span>
                            <span className="block break-words text-phx-xs text-slate-500" dir="auto">
                              {conflict.heldBy.areaName || conflict.heldBy.areaCode || "No area"} ·{" "}
                              {conflict.heldBy.regionName || conflict.heldBy.regionCode || "No region"}
                              {conflict.heldBy.pharmacyAddress ? ` · ${conflict.heldBy.pharmacyAddress}` : ""}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={cn(
                              phxButtonApproveDenseClassName,
                              "mt-1.5 w-full px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider",
                            )}
                            onClick={() =>
                              applySuggestedPharmacy({
                                source: "phoenix",
                                pharmacyName: conflict.heldBy.pharmacyName,
                                distributorCode: conflict.distributorCode,
                                customerCode: conflict.customerCode,
                                phoenixPharmacyCode: conflict.heldBy.phoenixPharmacyCode,
                                areaCode: conflict.heldBy.areaCode,
                                areaName: conflict.heldBy.areaName,
                                regionCode: conflict.heldBy.regionCode,
                                regionName: conflict.heldBy.regionName,
                                pharmacyAddress: conflict.heldBy.pharmacyAddress,
                              })
                            }
                          >
                            Yes — use this pharmacy
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* "No" is the answer the owner asked about, and it is the one that had no
                        design. It cannot hand her the code — it belongs to the pharmacy above, and
                        two pharmacies sharing one distributor code is exactly how one pharmacy's
                        retail sales get attributed to another. So her pharmacy is registered WITHOUT
                        the contested code, and the claim is recorded on the record for a System Admin
                        to settle. She is not blocked, and nothing is silently overwritten. */}
                    {acknowledgedCodeConflict ? (
                      <p className="mt-1.5 border border-amber-300 bg-amber-50 px-2 py-1.5 text-phx-xs font-bold text-amber-800">
                        Understood — your pharmacy will be registered WITHOUT this distributor code,
                        and the code dispute goes to a System Admin to settle. The order still submits
                        and still goes through the normal approval chain.
                      </p>
                    ) : (
                      <button
                        type="button"
                        className={`mt-1.5 w-full border border-slate-400 bg-white px-3 py-1.5 text-phx-sm font-black uppercase tracking-wider text-slate-600 hover:bg-slate-50 ${adminControlDepthClassName}`}
                        onClick={() => setAcknowledgedCodeConflict(true)}
                      >
                        No — mine is a different pharmacy
                      </button>
                    )}
                  </div>
                ) : null}

                <p className="text-phx-xs text-slate-400">Phoenix auto-generates a stable code for this venue so you can reuse it next time.</p>
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
                    className="border border-emerald-600 px-3 py-1.5 text-phx-sm font-black text-emerald-700 hover:bg-emerald-50"
                  >
                    View this order
                  </Link>
                ) : null}
                <Link
                  href={basePath}
                  className="border border-slate-300 px-3 py-1.5 text-phx-sm font-black text-slate-600 hover:bg-slate-50"
                >
                  Back to Direct Orders
                </Link>
                <button
                  type="button"
                  onClick={() => setOk(null)}
                  className="border border-slate-300 px-3 py-1.5 text-phx-sm font-black text-slate-600 hover:bg-slate-50"
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
      <section className={adminPanelClassName}>
        <header className="border-b border-phx-line bg-slate-100 px-4 py-2.5">
          <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-600">My direct orders</h3>
        </header>
        {myRequests.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500">You have not submitted any direct orders yet.</p>
        ) : (
          <>
            {/* Desktop only (fits-the-screen golden rule): `table-fixed` + a `<colgroup>` so the table
                always exactly fills its container, text WRAPS, and two related pairs merge into one
                column each (Qty+bonus, Status+waiting-on). Mobile gets the card list below. */}
            <div className="hidden md:block">
              <table className="w-full table-fixed border-collapse text-sm">
                <colgroup>
                  <col className="w-[24%]" />
                  <col className="w-[13%]" />
                  <col className="w-[12%]" />
                  <col className="w-[19%]" />
                  <col className="w-[25%]" />
                  <col className="w-[7%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-phx-line bg-slate-50 text-left text-phx-xs font-black uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2 text-right">Qty / bonus</th>
                    <th className="px-3 py-2 text-right">Value</th>
                    <th className="px-3 py-2">Venue</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {myRequests.map((r) => (
                    <tr key={r.id} className="border-b border-[#eef1f3] align-top">
                      <td className="break-words px-3 py-2">
                        <div className="font-semibold text-slate-800">{r.productName}</div>
                        <div className="text-phx-xs text-slate-500">{r.line}</div>
                      </td>
                      <td className="break-words px-3 py-2 text-right tabular-nums">
                        {/* Per product, in the order the Product cell names them — "72 + 24" —
                            never a sum: a basket has no single quantity. */}
                        <div>{describeDirectOrderBasketQuantities(r, r.items)}</div>
                        <div className="mt-0.5 text-phx-xs text-slate-500">
                          {bonusCell(r)}
                          {r.bonusOverCap ? (
                            <span className="ml-1 inline-block bg-phx-danger-bg px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-wide text-phx-danger">
                              over cap
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="break-words px-3 py-2 text-right font-bold tabular-nums">{money(r.salesValue)}</td>
                      <td className="break-words px-3 py-2">{r.pharmacyName}</td>
                      <td className="break-words px-3 py-2">
                        {/* `wrap` (see direct-order-status-pill.tsx) — this column is too narrow for
                            the longest label ("Customer Verification Required", 206px unwrapped) on
                            every row just for the rare one that needs it, and shrinking the label's
                            type is the one fix the FITS-THE-SCREEN GOLDEN RULE forbids. */}
                        <DirectOrderStatusPill status={r.status} salesMonth={r.salesMonth} wrap viewerIsRequester />
                        <div className="mt-1 text-phx-xs text-slate-600">
                          Waiting on: {r.status === "pending_approval" ? r.activeStepLabel || "—" : "—"}
                        </div>
                      </td>
                      {/* The requester could see a summary row but never open it. Track leads to the
                          SAME detail the approvers read, so they can see exactly which rung holds it. */}
                      <td className="break-words px-3 py-2 text-right">
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

            {/* Mobile — cards, not a shrunk table (admin-shell convention). Same fields as the
                desktop table, none dropped, laid out for a phone-width column instead of a
                7-column row. */}
            <div className="space-y-3 p-4 md:hidden">
              {myRequests.map((r) => (
                <div
                  key={`${r.id}-mobile`}
                  className="border border-[#eef1f3] bg-white p-3 shadow-[0_12px_28px_rgba(15,23,42,0.06)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-black text-slate-900">{r.productName}</p>
                      <p className="text-phx-xs text-slate-500">{r.line}</p>
                    </div>
                    {/* `wrap` — see the desktop cell above for why. */}
                    <div className="shrink-0 text-right">
                      <DirectOrderStatusPill status={r.status} salesMonth={r.salesMonth} wrap viewerIsRequester />
                    </div>
                  </div>
                  <p className="mt-2 text-sm font-semibold text-slate-700">{r.pharmacyName}</p>
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                    <p className="text-slate-600">
                      Qty: <span className="font-bold text-slate-900">{describeDirectOrderBasketQuantities(r, r.items)}</span>
                    </p>
                    <p className="text-slate-600">
                      Bonus: <span className="font-bold text-slate-900">{bonusCell(r)}</span>
                      {r.bonusOverCap ? (
                        <span className="ml-1 inline-block bg-phx-danger-bg px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-wide text-phx-danger">
                          over cap
                        </span>
                      ) : null}
                    </p>
                    <p className="col-span-2 text-slate-600">
                      Value: <span className="font-bold text-slate-900">{money(r.salesValue)}</span>
                    </p>
                  </div>
                  <p className="mt-2 text-phx-xs text-slate-600">
                    Waiting on: {r.status === "pending_approval" ? r.activeStepLabel || "—" : "—"}
                  </p>
                  <Link
                    href={`${basePath}/${encodeURIComponent(r.id)}`}
                    className="mt-2 inline-block text-phx-sm font-bold text-orange-600 hover:text-orange-700"
                  >
                    Track →
                  </Link>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
