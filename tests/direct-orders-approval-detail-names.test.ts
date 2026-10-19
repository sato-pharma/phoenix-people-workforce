import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECT_ORDER_CORE_FIELD_LABELS,
  DIRECT_ORDER_NOTIFICATION_MAX_CHARS,
  buildDirectOrderApprovalNarrative,
  buildDirectOrderDetailFields,
  buildDirectOrderNotificationLine,
  buildDirectOrderNotificationMetrics,
  computeDirectOrderPricingBreakdown,
  describeDirectOrderBasketLines,
  describeDirectOrderProducts,
  formatMedicalRep,
  type DirectOrderPricingItem,
} from "../src/lib/direct-orders/approval-fields.ts";
import {
  codeNameLabel,
  formatDistributorCodesText,
  formatDistributorNames,
  toDistributorRows,
} from "../src/lib/direct-orders/geo-names.ts";
import { describeReturnedDirectOrderWait } from "../src/lib/direct-orders/status-labels.ts";
import {
  areaRepKey,
  normalizeLineKey,
  selectAreaRepsFromSeats,
  type AreaRepSeatRow,
} from "../src/lib/employees/area-rep-resolver.ts";
import type { DirectOrderApprovalDetail, DirectOrderRequest } from "../src/lib/direct-orders/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Slice a top-level declaration out of a source file by its REAL end — the next top-level
 * declaration — instead of a fixed byte count. A magic window measures source LENGTH, not the
 * invariant it claims to guard: it false-FAILS the moment the pinned function grows past the
 * window (the regression fixed in PR #2288), and it false-PASSES when a function that genuinely
 * lost its marker spills into the next function's copy of it.
 */
function topLevelBlock(source: string, start: number): string {
  if (start < 0) return "";
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
  return source.slice(start, next >= 0 ? start + 1 + next : source.length);
}

function request(overrides: Partial<DirectOrderRequest> = {}): DirectOrderRequest {
  return {
    id: "req-1",
    requesterHrId: "HR-100",
    requesterRole: "District Manager",
    status: "pending_approval",
    line: "CNS",
    productCode: "CN001",
    productName: "Roya",
    familyCode: "RO",
    pharmacyPriceSnapshot: 111.15,
    qty: 100,
    bonus: 25,
    bonusOverrideReason: null,
    dealType: "bonus",
    discountPct: null,
    publicPriceSnapshot: null,
    salesValue: 11115,
    pharmacyId: "ph-1",
    salesMonth: null,
    collectionDate: "2026-09-15",
    heldAt: null,
    marketingRequestId: null,
    paymentDate: null,
    paidAmount: null,
    remainingAmount: null,
    sosBatchId: null,
    reversalOfRequestId: null,
    reversedByRequestId: null,
    createdAt: "2026-08-03T09:00:00.000Z",
    decidedAt: null,
    ...overrides,
  };
}

/** One line matching the single-product request fixture — what the backfill gives every old order. */
function singleItem(): DirectOrderApprovalDetail["items"] {
  return [
    {
      lineNo: 1,
      productCode: "CN001",
      productName: "Roya",
      familyCode: "CN",
      dealType: "bonus",
      qty: 100,
      bonus: 25,
      discountPct: null,
      publicPriceSnapshot: null,
      pharmacyPriceSnapshot: 111.15,
      salesValue: 11115,
      overCap: false,
    },
  ];
}

function detail(overrides: Partial<DirectOrderApprovalDetail> = {}): DirectOrderApprovalDetail {
  return {
    request: request(),
    // A request ALWAYS has at least one line. The fixture omitted this at first and TypeScript did
    // not object — spreading a Partial<T> into a literal annotated T does not flag a property the
    // spread might supply — so `items` was undefined in every assertion and a basket was never
    // exercised. A fixture that cannot represent the shape under test is a fixture that agrees
    // with whatever the code does.
    items: singleItem(),
    requesterName: "Mahmoud Adel",
    pharmacyRegisteredByName: "Mahmoud Adel",
    pharmacy: {
      id: "ph-1",
      phoenixPharmacyCode: "DOP-000123",
      pharmacyName: "El Ezaby",
      brickId: "BR-01",
      areaCode: "CA-07",
      regionCode: "RG-1",
      doctorName: "Dr Nour",
      pharmacyAddress: "12 El Merghany Street, Heliopolis, Cairo",
      venueType: "pharmacy",
      distributorCodes: [],
      contestedCodeClaims: [],
      geoVarianceResolved: false,
      verificationStatus: "verified",
      entrySource: "catalogue",
      verifiedByHrId: null,
      verifiedAt: null,
      createdByHrId: "HR-100",
      active: true,
      trustState: "trusted",
      probationStartedAt: null,
      // No System Admin has ruled on this pharmacy's hold — which is distinct from either ruling.
      holdReleaseGround: null,
      holdReleaseReason: null,
      holdReleaseDecidedByHrId: null,
      holdReleaseDecidedAt: null,
      // Declared at registration, and REQUIRED on the type rather than optional: mapPharmacyRow
      // always supplies all three, and the point of a fixture is to be able to represent the whole
      // shape. Making them optional to spare this literal would let a real caller drop the link
      // silently, which is the failure mode the column exists to end.
      crmContactId: null,
      crmContactLinkedByHrId: null,
      crmContactLinkedAt: null,
    },
    productPharmacyPrice: null,
    productPublicPrice: null,
    geo: {
      brick: { code: "BR-01", name: "Heliopolis" },
      area: { code: "CA-07", name: "Cairo East" },
      region: { code: "RG-1", name: "Greater Cairo" },
    },
    medicalRep: { resolved: true, isVacant: false, repHrId: "HR-900", repName: "Sara Hassan", repNames: ["Sara Hassan"] },
    distributorCodesText: "Ibn Sina: 1234567; Overseas: 7654321",
    distributors: [],
    pharmacyHistory: [],
    retailHistory: [],
    retailUnmatchable: false,
    // This fixture's pharmacy is trusted, so its standing is not what these tests are about —
    // `tests/direct-orders-pharmacy-standing.test.ts` owns spec D2's wording.
    pharmacyStanding: null,
    canSetSalesMonth: false,
    canRecordCollection: false,
    canSettleServiceFee: false,
    serviceFeeDefaults: null,
    canCorrectAndResubmit: false,
    returnComment: null,
    steps: [],
    availableActions: { approve: true, reject: true, return: true },
    bonusOverCap: false,
    missingManagementLine: false,
    // The common case (2026-08-08): most orders never touch the held/validation lane at all.
    pharmacyEvidence: null,
    // No already-validated stamp for this fixture's pharmacy — the badge is resolved separately and
    // its own resolver is unit-tested in validated-evidence-badge.test.ts. Required (not optional)
    // so the spread of Partial<DirectOrderApprovalDetail> above cannot silently drop it.
    pharmacyValidation: null,
    possibleDistributorMatches: [],
    // No candidates, so nothing was refused — auto-link had nothing to decide about.
    autoLinkRefusal: null,
    retailLoadFailed: false,
    directLoadFailed: false,
    hiddenConfidentialCount: 0,
    retailMatchedPairs: 0,
    geographyCheck: null,
    ...overrides,
  };
}

function seat(overrides: Partial<AreaRepSeatRow> = {}): AreaRepSeatRow {
  return {
    seat_id: "SEAT-1",
    seat_tier: "REP",
    line_code: "cns",
    line_name: "CNS",
    area_code: "CA-07",
    is_other_pseudo_dm: false,
    occupant_hr_id: "HR-900",
    is_vacant: false,
    ...overrides,
  };
}

// The resolver hands `nameOf` a NORMALIZED hr id (lower-cased), and the real lookup it is given
// in production (service.ts `nameLookup()`) canonicalizes its keys, so it matches regardless of
// casing. This stub does the same rather than comparing raw strings.
const nameOf = (hrId: string | null) => {
  const key = String(hrId ?? "").trim().toLowerCase();
  if (key === "hr-900") return "Sara Hassan";
  if (key === "hr-901") return "Omar Fathy";
  return null;
};

export function runDirectOrdersApprovalDetailNamesTests() {
  // ── Line-key normalization ──────────────────────────────────────────────────
  // This is the single highest-value assertion in the file. au.lines seeds the Anti Infective
  // line as 'Anti infective' (lower-case i) while the app's canonical name is "Anti Infective";
  // a case-sensitive match would silently drop that entire line's reps from every approval
  // window, with no error anywhere.
  assert.equal(normalizeLineKey("CNS"), "cns");
  assert.equal(normalizeLineKey("cns"), "cns");
  for (const spelling of ["Anti Infective", "Anti infective", "anti_infective", "Anti-Infective"]) {
    assert.equal(normalizeLineKey(spelling), "antiinfective", `"${spelling}" must collapse to one key`);
  }
  assert.equal(normalizeLineKey(null), "");

  // areaRepKey is case-insensitive on the area code, and never matches on a missing half.
  assert.equal(areaRepKey("CNS", "ca-07"), "cns|CA-07");
  assert.equal(areaRepKey("CNS", "CA-07"), "cns|CA-07");
  assert.equal(areaRepKey("", "CA-07"), "");
  assert.equal(areaRepKey("CNS", null), "");

  // ── Seat selection ──────────────────────────────────────────────────────────
  {
    const map = selectAreaRepsFromSeats([seat()], nameOf);
    const hit = map.get("cns|CA-07");
    assert.equal(hit?.repName, "Sara Hassan");
    assert.equal(hit?.isVacant, false);
    // Indexed under the line CODE too, so either spelling in the request resolves.
    assert.ok(map.has("cns|CA-07"));
  }
  {
    // An occupied seat wins over a vacant one on the same (line, area).
    const map = selectAreaRepsFromSeats(
      [seat({ seat_id: "SEAT-1", is_vacant: true, occupant_hr_id: null }), seat({ seat_id: "SEAT-2" })],
      nameOf,
    );
    assert.equal(map.get("cns|CA-07")?.isVacant, false);
    assert.equal(map.get("cns|CA-07")?.repName, "Sara Hassan");
  }
  {
    // A genuinely vacant area resolves, but with no rep — different from "unresolved".
    const map = selectAreaRepsFromSeats([seat({ is_vacant: true, occupant_hr_id: null })], nameOf);
    assert.equal(map.get("cns|CA-07")?.isVacant, true);
    assert.equal(map.get("cns|CA-07")?.repName, null);
  }
  {
    // The per-line "Others" bucket holds no real people and must be ignored entirely.
    const map = selectAreaRepsFromSeats([seat({ is_other_pseudo_dm: true })], nameOf);
    assert.equal(map.size, 0);
  }
  {
    // Non-REP tiers never answer "who is the medical rep".
    const map = selectAreaRepsFromSeats([seat({ seat_tier: "DM" })], nameOf);
    assert.equal(map.size, 0);
  }
  {
    // Two reps on one split area: BOTH names, never truncated.
    const map = selectAreaRepsFromSeats(
      [seat({ seat_id: "SEAT-1" }), seat({ seat_id: "SEAT-2", occupant_hr_id: "HR-901" })],
      nameOf,
    );
    const hit = map.get("cns|CA-07");
    assert.equal(hit?.repNames.length, 2);
    assert.match(hit?.repName ?? "", /Sara Hassan/);
    assert.match(hit?.repName ?? "", /Omar Fathy/);
    assert.doesNotMatch(hit?.repName ?? "", /…|\.\.\./, "rep names must never be truncated");
  }
  {
    // A seat whose line_name is null still matches via line_code.
    const map = selectAreaRepsFromSeats([seat({ line_name: null })], nameOf);
    assert.equal(map.get("cns|CA-07")?.repName, "Sara Hassan");
  }
  {
    // An unknown (line, area) is ABSENT, which the UI renders "—". It must not read "Vacant",
    // which would be a false statement about the org.
    const map = selectAreaRepsFromSeats([seat()], nameOf);
    assert.equal(map.get("pedia|CA-07"), undefined);
  }

  // ── Medical-rep display ─────────────────────────────────────────────────────
  assert.equal(formatMedicalRep({ resolved: false, isVacant: false, repHrId: null, repName: null, repNames: [] }), "—");
  assert.equal(formatMedicalRep({ resolved: true, isVacant: true, repHrId: null, repName: null, repNames: [] }), "Vacant");
  assert.equal(
    formatMedicalRep({ resolved: true, isVacant: false, repHrId: "HR-900", repName: "Sara Hassan", repNames: ["Sara Hassan"] }),
    "Sara Hassan",
  );

  // ── codeNameLabel puts the NAME first ───────────────────────────────────────
  assert.equal(codeNameLabel("Heliopolis", "BR-01"), "Heliopolis (BR-01)");
  assert.equal(codeNameLabel("", "BR-01"), "BR-01", "an unnamed brick falls back to its code, never to blank");
  assert.equal(codeNameLabel("Heliopolis", ""), "Heliopolis");
  assert.equal(codeNameLabel(null, null), "—");

  // ── Distributor projections ─────────────────────────────────────────────────
  assert.equal(formatDistributorCodesText([]), "");
  assert.equal(
    formatDistributorCodesText([
      { distributorCode: "IBN", distributorName: "Ibn Sina", customerCode: "111", mappedBrickId: null, mappedAreaCode: null, mappedRegionCode: null },
      { distributorCode: "OVS", distributorName: "Overseas", customerCode: "222", mappedBrickId: null, mappedAreaCode: null, mappedRegionCode: null },
    ]),
    "Ibn Sina: 111; Overseas: 222",
  );
  assert.equal(
    formatDistributorNames([
      { distributorCode: "IBN", distributorName: "Ibn Sina", customerCode: "111", mappedBrickId: null, mappedAreaCode: null, mappedRegionCode: null },
      { distributorCode: "OVS", distributorName: "Overseas", customerCode: "222", mappedBrickId: null, mappedAreaCode: null, mappedRegionCode: null },
    ]),
    "Ibn Sina · Overseas",
  );

  // ── The approval window's field list ────────────────────────────────────────
  {
    const fields = buildDirectOrderDetailFields(detail());
    const labels = fields.map((field) => field.label);
    const valueOf = (label: string) => fields.find((field) => field.label === label)?.value ?? "";

  // ── A FAMILY BASKET: every line visible, every core label still present ─────
  //
  // An approver decides a number, so they must see every line that adds up to it. Before this
  // existed the singular request fields WERE the order; on a basket they describe line 1 only, and
  // an approver reading them alone would be approving money they cannot see.
  //
  // The completeness bar is re-asserted HERE and not only on the single-line path, because the
  // first cut of the basket branch swapped "Product", "Sato product code" and "Deal type" out for a
  // per-line block — and the suite passed, because no fixture built a basket.
  {
    const basketItems: DirectOrderApprovalDetail["items"] = [
      {
        lineNo: 1,
        productCode: "LA001",
        productName: "Lacto Advanced 1",
        familyCode: "LA",
        dealType: "bonus",
        qty: 100,
        bonus: 5,
        discountPct: null,
        publicPriceSnapshot: null,
        pharmacyPriceSnapshot: 10,
        salesValue: 1000,
        overCap: false,
      },
      {
        lineNo: 2,
        productCode: "LA002",
        productName: "Lacto Advanced 2",
        familyCode: "LA",
        dealType: "bonus",
        qty: 100,
        bonus: 40,
        discountPct: null,
        publicPriceSnapshot: null,
        pharmacyPriceSnapshot: 20,
        salesValue: 2000,
        overCap: true,
      },
    ];
    const basket = buildDirectOrderDetailFields(
      detail({ items: basketItems, request: { ...request(), salesValue: 3000 } }),
    );
    const basketLabels = basket.map((field) => field.label);
    const basketValue = (label: string) => basket.find((field) => field.label === label)?.value ?? "";

    for (const label of DIRECT_ORDER_CORE_FIELD_LABELS) {
      assert.ok(
        basketLabels.includes(label),
        `a BASKET must still show "${label}" — the completeness bar is not waived by having more lines`,
      );
    }

    assert.ok(basketLabels.includes("Products (2)"), "the line block names how many lines there are");
    const lines = basketValue("Products (2)");
    assert.match(lines, /Lacto Advanced 1/, "line 1 must be listed");
    assert.match(lines, /Lacto Advanced 2/, "line 2 must be listed — the one the old fields hid");
    assert.match(lines, /1,000 EGP/, "each line carries its OWN money, not the basket total");
    assert.match(lines, /2,000 EGP/, "…including the second line's");
    assert.match(lines, /over cap/, "an over-cap LINE says so, so an approver knows WHICH one");

    // The total is labelled as a total. On one line "Sales value" is unambiguous; on a basket it is
    // the only figure that is not per-line.
    assert.equal(basketValue("Sales value (total)"), "3,000 EGP", "the basket total is the request's value");
    assert.equal(
      basketValue("Product"),
      "Lacto Advanced 1 + Lacto Advanced 2",
      "the Product field summarises the basket rather than naming only line 1",
    );
    assert.equal(basketValue("Sato product code"), "LA001 + LA002", "…and so does the code field");

    // Quantity is deliberately ABSENT on a basket: one number cannot stand for lines that each
    // carry their own, and a single figure there would be read as the order's quantity.
    assert.ok(!basketLabels.includes("Quantity"), "a basket must not show one Quantity for many lines");

    // ── The WINDOW's header, tiles and price rows speak per line (code review, 19 Oct 2026) ──
    // The approval window read the request row, which on a basket is line 1 only, for its header,
    // its Quantity and Deal tiles and both price rows: a Lacto Advanced 1 + 2 order was headed
    // "Lacto Advanced 1 × 100" and priced at line 1's prices, so the approver saw half the order as
    // the whole. Units of different products are never summed into one figure (owner rule).
    {
      const mixed: DirectOrderApprovalDetail["items"] = [
        basketItems[0],
        {
          ...basketItems[1],
          qty: 240,
          dealType: "discount",
          bonus: 0,
          discountPct: 20,
          publicPriceSnapshot: 30,
          pharmacyPriceSnapshot: null,
        },
      ];
      const basketDetail = detail({
        items: mixed,
        request: { ...request(), productCode: "LA001", productName: "Lacto Advanced 1", qty: 100, salesValue: 3000 },
        productPharmacyPrice: 10,
        productPublicPrice: 14,
      });
      const header = describeDirectOrderProducts(basketDetail.request, basketDetail.items);
      assert.equal(header, "Lacto Advanced 1 × 100 + Lacto Advanced 2 × 240", "the header names every product with its own units");
      assert.doesNotMatch(header, /340/, "units of different products are never added into one figure");
      assert.equal(describeDirectOrderProducts(request(), singleItem()), "Roya × 100", "a one-product order keeps its header");

      const views = describeDirectOrderBasketLines(basketDetail);
      assert.ok(views, "a basket gets one view per line");
      assert.deepEqual(
        views.map((view) => [view.productName, view.qty, view.deal, view.overCap]),
        [
          ["Lacto Advanced 1", 100, "5 bonus", false],
          ["Lacto Advanced 2", 240, "20% discount", true],
        ],
        "the Quantity and Deal tiles carry each line's own figure, and the over-cap mark sits on the line that is over",
      );
      assert.deepEqual(views[0].pharmacyPrice, { value: 10, used: true }, "line 1 is priced at its own pharmacy price");
      assert.deepEqual(
        views[0].publicPrice,
        { value: 14, used: false },
        "line 1's unused public price falls back to its product's current price, as a one-product order does",
      );
      assert.deepEqual(
        views[1].pharmacyPrice,
        { value: null, used: false },
        "a discount line stores no pharmacy price: it reads Not used, and never borrows line 1's price",
      );
      assert.deepEqual(views[1].publicPrice, { value: 30, used: true }, "line 2 is priced at its own public price");
      assert.equal(describeDirectOrderBasketLines(detail()), null, "a one-product order keeps the request-level tiles");

      const windowSource = stripComments(
        readFileSync(new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url), "utf8"),
      );
      assert.match(windowSource, /describeDirectOrderProducts\(request, detail\.items\)/, "the window's header names every product");
      assert.doesNotMatch(windowSource, /\{request\.productName\} × \{request\.qty/, "the window's header must not read line 1 alone");
      assert.match(windowSource, /describeDirectOrderBasketLines\(detail\)/, "the window's tiles and price rows read the basket's lines");
      assert.match(
        windowSource,
        /GRID_HIDDEN_LABELS = new Set\(\[[^\]]*"Sales value \(total\)"/,
        "a basket's total sits in its hero tile and must not print a second time in the grid",
      );
      assert.match(
        windowSource,
        /<dd className="[^"]*whitespace-pre-line[^"]*">\{field\.value\}<\/dd>/,
        "the Products (n) block keeps one product per line instead of collapsing into one sentence",
      );
    }
  }

    // Completeness bar: everything the approved-order email has always shown must also appear
    // on the screen where the decision is actually made.
    for (const label of DIRECT_ORDER_CORE_FIELD_LABELS) {
      assert.ok(labels.includes(label), `the approval window must show "${label}"`);
    }

    // Names, never codes — and name FIRST, not code first.
    assert.equal(valueOf("Brick"), "Heliopolis (BR-01)");
    assert.doesNotMatch(valueOf("Brick"), /^BR-01/, "the brick must read name-first, not code-first");
    assert.equal(valueOf("Area"), "Cairo East (CA-07)");
    assert.equal(valueOf("Region"), "Greater Cairo (RG-1)");
    // The old combined "Brick / Area" cell is what forced the bare-code format; it must be gone.
    assert.ok(!labels.includes("Brick / Area"), "brick and area must be separate fields");

    assert.equal(valueOf("Venue"), "El Ezaby (DOP-000123)");
    assert.equal(valueOf("Doctor"), "Dr Nour");
    assert.equal(valueOf("Medical rep"), "Sara Hassan");

    // Owner rule: never skip a detail. The company's own codes get their OWN labelled fields
    // rather than living only inside a parenthesis on another field's value.
    assert.equal(valueOf("Sato venue code"), "DOP-000123");
    assert.equal(valueOf("Sato product code"), "CN001");
    assert.equal(valueOf("Deal type"), "Bonus");
    // A NAME, not the bare HR-ID (owner rule, 2026-08-08 — "show human-readable names, never raw
    // codes"). This asserted "HR-100" until then, which is exactly what the owner objected to on
    // screen. The id remains the fallback when the directory has no name for it, checked below.
    assert.equal(valueOf("Venue registered by"), "Mahmoud Adel");
    assert.equal(
      buildDirectOrderDetailFields(detail({ pharmacyRegisteredByName: null })).find(
        (field) => field.label === "Venue registered by",
      )?.value,
      "HR-100",
      "with no resolved name the HR_ID must still show — a blank would hide who registered the pharmacy",
    );
    assert.equal(valueOf("Venue status"), "Active");

    // BOTH prices are always present, each stating whether it priced THIS deal — an approver
    // should never have to infer the basis from which field happens to be missing.
    assert.match(valueOf("Pharmacy price"), /used for this deal/);
    assert.match(valueOf("Public price"), /not used — bonus deal/);

    // "not set" must never render as "0 EGP". `Number(null)` is 0 and passes Number.isFinite,
    // so the obvious formatter prints an unset price as zero — which shipped once and, on the
    // screen where money is approved, states that the product is free rather than unpriced.
    // This detail fixture has NO public price, so that is exactly the case under test.
    assert.doesNotMatch(
      valueOf("Public price"),
      /\b0 EGP\b/,
      "an unset price must read as a dash, never as 0 EGP — those mean different things",
    );
    assert.match(valueOf("Public price"), /not set/, "an unset price must say so");
    // Any letters-dash-digits HR_ID shape, not just "HR-####". The narrow pattern this replaces
    // missed a REAL leak: a sent notification read "Medical rep pd-0005", because HR IDs in this
    // system take forms like pd-0005, ai-0007, B-185 and AA — nothing resembling "HR-".
    assert.doesNotMatch(
      valueOf("Medical rep"),
      /\b[A-Za-z]{1,3}-\d{2,}\b/,
      "a rep's HR_ID must never leak to the approver — show the name",
    );

    // A price of ZERO is a real value and must still render as a number, not collapse to the
    // same "not set" text — the two are only distinguishable if zero survives.
    const zeroPriced = buildDirectOrderDetailFields(
      detail({ request: request({ dealType: "discount", publicPriceSnapshot: 0, discountPct: 0 }) }),
    );
    const zeroPublic = zeroPriced.find((field) => field.label === "Public price")?.value ?? "";
    assert.match(zeroPublic, /\b0 EGP\b/, "a genuine zero price must still print as 0 EGP");
    assert.doesNotMatch(zeroPublic, /not set/, "a genuine zero is not the same as unset");

    // The sales month is Finance's to book — the old "(set on final approval)" copy is stale.
    assert.match(valueOf("Sales month"), /not booked into a month yet/);
    assert.doesNotMatch(valueOf("Sales month"), /set on final approval/);

    // Never truncate (owner rule).
    for (const field of fields) {
      assert.doesNotMatch(field.value, /…|\.\.\./, `"${field.label}" must not be truncated`);
      assert.doesNotMatch(field.value, /undefined|null/, `"${field.label}" must not leak a JS placeholder`);
    }

    // Long free text is marked full-width so it never has to squeeze into the grid.
    assert.equal(fields.find((field) => field.label === "Venue address")?.layout, "full");
  }
  {
    // Unmapped geography degrades to the bare code, never to "undefined".
    const fields = buildDirectOrderDetailFields(
      detail({ geo: { brick: { code: "BR-99", name: "" }, area: null, region: null } }),
    );
    const valueOf = (label: string) => fields.find((field) => field.label === label)?.value ?? "";
    assert.equal(valueOf("Brick"), "BR-99");
    assert.equal(valueOf("Area"), "—");
  }
  {
    // A bonus deal can no longer be valued without a pharmacy price — submit refuses it, and
    // there is no factory-price fallback (owner instruction, 2026-08-04). A legacy row that
    // still carries no snapshot must therefore read "not set", never a substituted price.
    const fields = buildDirectOrderDetailFields(
      detail({ request: request({ pharmacyPriceSnapshot: null }) }),
    );
    const value = fields.find((field) => field.label === "Pharmacy price")?.value ?? "";
    assert.match(value, /not set/i, "a bonus order with no pharmacy price must say so, not show another price");
    assert.doesNotMatch(value, /factory/i, "the approval window must never mention a factory price");
  }
  {
    // A discount deal shows BOTH prices too (owner rule: never skip a detail), each stating
    // whether it priced this deal, plus the discount percentage.
    const fields = buildDirectOrderDetailFields(
      detail({ request: request({ dealType: "discount", discountPct: 25, publicPriceSnapshot: 92, pharmacyPriceSnapshot: null }) }),
    );
    const labels = fields.map((field) => field.label);
    const valueOf = (label: string) => fields.find((field) => field.label === label)?.value ?? "";
    assert.ok(labels.includes("Public price"));
    assert.ok(labels.includes("Pharmacy price"), "every price is shown; which one applied is stated, not implied");
    assert.match(valueOf("Public price"), /used for this deal/);
    assert.match(valueOf("Pharmacy price"), /not used — discount deal/);
    assert.equal(valueOf("Deal type"), "Discount");
    assert.equal(valueOf("Discount %"), "25%");
  }
  {
    // Finance fields stay hidden until they hold a value — an approver should not read three
    // empty rows on an order that has not been collected yet.
    const emptyLabels = buildDirectOrderDetailFields(detail()).map((field) => field.label);
    assert.ok(!emptyLabels.includes("Paid"));
    const paidLabels = buildDirectOrderDetailFields(
      detail({ request: request({ paidAmount: 5000, paymentDate: "2026-09-20" }) }),
    ).map((field) => field.label);
    assert.ok(paidLabels.includes("Paid"));
    assert.ok(paidLabels.includes("Payment date"));
  }

  // ── Distributor rows keep the CODE as well as the name ─────────────────────
  {
    const maps = {
      brickNameById: new Map([["BR-01", "Heliopolis"]]),
      areaNameByCode: new Map([["CA-07", "Cairo East"]]),
      regionNameByCode: new Map([["RG-1", "Greater Cairo"]]),
    };
    const rows = toDistributorRows(
      [
        { distributorCode: "IbnSina", distributorName: "Ibn Sina", customerCode: "1234567", mappedBrickId: "BR-01", mappedAreaCode: "CA-07", mappedRegionCode: "RG-1" },
        { distributorCode: "OVS", distributorName: "Overseas", customerCode: "7654321", mappedBrickId: null, mappedAreaCode: null, mappedRegionCode: null },
      ],
      maps,
    );
    assert.equal(rows[0].distributorName, "Ibn Sina");
    assert.equal(rows[0].distributorCode, "IbnSina", "the distributor CODE must survive, not just its name");
    assert.equal(rows[0].customerCode, "1234567");
    // Mapped geography resolves to names, never bare codes.
    assert.equal(rows[0].mappedBrickName, "Heliopolis");
    assert.equal(rows[0].mappedAreaName, "Cairo East");
    assert.equal(rows[0].mappedRegionName, "Greater Cairo");
    // An unmapped code stays null so the UI can say "not mapped" rather than printing nothing.
    assert.equal(rows[1].mappedBrickName, null);
    assert.equal(rows[1].mappedAreaName, null);
    // A code with no master-data name falls back to the code, never to blank.
    const unnamed = toDistributorRows(
      [{ distributorCode: "X", distributorName: "X Dist", customerCode: "9", mappedBrickId: "BR-99", mappedAreaCode: null, mappedRegionCode: null }],
      maps,
    );
    assert.equal(unnamed[0].mappedBrickName, "BR-99");
  }

  // ── Both approval surfaces must render the distributor code ────────────────
  {
    for (const path of [
      "../src/components/approvals-hub/direct-order-request-detail.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, /row\.distributorCode/, `${path} must show the distributor code`);
      assert.match(source, /row\.mappedAreaName/, `${path} must show the mapped area`);
      assert.match(source, /pharmacyHistory/, `${path} must render the pharmacy history`);
    }
  }

  // ── The pharmacy picker must not offer the company's own direct channel ────
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    assert.match(
      serviceSource,
      /DIRECT_ORDER_EXCLUDED_DISTRIBUTOR_CODES/,
      "the distributor picker must exclude the company's own direct channel",
    );
    const excludedBlock = serviceSource.slice(
      serviceSource.indexOf("const DIRECT_ORDER_EXCLUDED_DISTRIBUTOR_CODES"),
      serviceSource.indexOf("export async function listDirectOrderDistributorOptions"),
    );
    assert.match(excludedBlock, /"direct"/, "Direct (Company) must be excluded from the picker");
    assert.match(excludedBlock, /"directreq"/, "the reserved SoS pseudo-distributor must be excluded too");
    // The exclusion is a PICKER filter only — it must never touch stored pairs.
    const optionsBlock = serviceSource.slice(
      serviceSource.indexOf("export async function listDirectOrderDistributorOptions"),
      serviceSource.indexOf("// ── Submit"),
    );
    assert.doesNotMatch(optionsBlock, /delete|update\(/, "removing an option must never rewrite stored data");
  }

  // ── Pharmacy history excludes the request being decided ────────────────────
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const historyIdx = serviceSource.indexOf("async function loadPharmacyOrderHistory(");
    assert.ok(historyIdx > -1, "the pharmacy history loader must exist");
    const historyBody = serviceSource.slice(historyIdx, serviceSource.indexOf("export async function getDirectOrderApprovalDetail(", historyIdx));
    assert.match(
      historyBody,
      /=== excludeRequestId\) continue/,
      "the order under judgement must be excluded from its own baseline",
    );
    assert.match(historyBody, /is\("reversal_of_request_id", null\)/, "reversals would double the picture");
    assert.match(historyBody, /neq\("status", "rejected"\)/, "a rejected order was never supplied");
    assert.match(historyBody, /sales_month/, "the month must prefer the real sales month");
    assert.match(historyBody, /monthIsProvisional/, "a not-yet-final month must be marked, not silently mixed in");
  }

  // ── Finance owns the sales month; the CEO does not ─────────────────────────
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");

    // The month must NO LONGER be derived from the approval clock.
    assert.doesNotMatch(
      serviceSource,
      /const salesMonth = input\.decision === "approve" && evaluation\.isFinal/,
      "the sales month must not be derived from the approval date any more",
    );
    assert.match(serviceSource, /export async function setDirectOrderSalesMonth\(/, "Finance needs an explicit setter");

    // The HR_ID literal moved to collection-rules.ts on 2026-08-10 so the collections work could
    // reuse it from a module with no Supabase import (and therefore be unit-testable), and again to
    // finance-authority.ts on 2026-08-11 (second-review finding 6) so that EVERY "may this person do
    // Finance's job" question resolves in one module and the duty can later be reassigned by
    // changing one function. The property this guards is unchanged, so it is still checked in two
    // halves: the literal is an HR_ID, and the sales-month setter derives from it rather than a role.
    const rulesSource = readFileSync(new URL("../src/lib/direct-orders/finance-authority.ts", import.meta.url), "utf8");
    assert.match(
      rulesSource,
      /DIRECT_ORDER_FINANCE_HR_ID = "B-185"/,
      "Finance's direct-order duties are pinned to Ahmed El Maraghy by HR_ID — not to the Finance Manager ROLE, so a future second holder cannot inherit them silently",
    );
    assert.match(
      serviceSource,
      /DIRECT_ORDER_SALES_MONTH_SETTER_HR_ID = DIRECT_ORDER_FINANCE_HR_ID/,
      "the sales-month setter must derive from that one HR_ID constant, never from a role or a second literal",
    );

    // Changing the month must rebuild BOTH periods, or the sales double or vanish. The inline
    // [previousMonth, nextMonth] literal this used to pin moved into periodsTouchedBySalesMonthChange
    // on 2026-09-05, so that the frozen-closing rule and the rebuild loop ask ONE function which
    // months a move touches and can never disagree. The property is unchanged and still pinned here:
    // the setter must hand that function BOTH months. That the function returns both — deduped, and
    // with a null end dropped — is proved directly in tests/direct-order-sales-month-lock-guard.test.ts.
    //
    // The second month is `bookedMonth`, not `nextMonth`, since 2026-09-07: a booking aimed at a
    // PUBLISHED closing is carried forward to the first open month, and the rebuild has to run for
    // the month the order actually landed in. Rebuilding the REQUESTED month here would rebuild a
    // period the order was never written to and leave the one it was written to stale — which is
    // the same "the month and its sales part ways" failure this assertion has always guarded.
    const setterIdx = serviceSource.indexOf("export async function setDirectOrderSalesMonth(");
    const setterBody = topLevelBlock(serviceSource, setterIdx);
    assert.match(
      setterBody,
      /periodsTouchedBySalesMonthChange\(previousMonth, bookedMonth\)/,
      "a month change must rebuild the OLD period as well as the one the order was BOOKED into",
    );
    assert.match(setterBody, /phx_rebuild_direct_order_sos_batch/, "the rebuild must actually run");

    // The migration must preserve a month Finance set, rather than blanking it on approval.
    const migration = readFileSync(
      new URL("../supabase/migrations/20260803160000_direct_orders_finance_sales_month.sql", import.meta.url),
      "utf8",
    );
    assert.match(
      migration,
      /coalesce\(p_sales_month, sales_month\)/,
      "approving with no month supplied must LEAVE Finance's month, never clear it",
    );
    assert.match(
      migration,
      /v_row\.sales_month is not null/,
      "an order with no month must inject into no period at all",
    );
  }

  // ── Retail and direct sales are separate, and matched safely ───────────────
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const retailIdx = serviceSource.indexOf("async function loadPharmacyRetailHistory(");
    assert.ok(retailIdx > -1, "retail history must have its own loader, separate from direct orders");
    const retailBody = serviceSource.slice(retailIdx, serviceSource.indexOf("export async function getDirectOrderApprovalDetail(", retailIdx));

    // THE correctness point: a customer code alone is not unique across distributors. In live
    // data code "124" is one pharmacy at distributor EG and a different one in the direct-order
    // registry — matching on the code alone would show a stranger's sales on this screen.
    assert.match(
      retailBody,
      /\$\{pair\.distributorCode\.toLowerCase\(\)\}\|\$\{pair\.customerCode\}/,
      "retail sales must be matched on (distributor code + customer code) TOGETHER",
    );
    assert.match(retailBody, /allowed\.has\(/, "rows outside the pharmacy's own pairs must be dropped");
    // A pharmacy with no usable pair is reported, not shown as a misleading zero.
    assert.match(retailBody, /unmatchable: true/, "an unmatchable pharmacy must say so rather than show zero");

    // The two channels must never be merged into one figure.
    //
    // Sliced to the function's actual END, not a fixed character count. It was `+ 3000`, then
    // `+ 4200`, and broke BOTH times something was added to the function — twice in one day. A
    // magic width silently turns into either a false pass (window runs past the function into the
    // next one) or a false failure (window stops short), and it had already done the first: the
    // 3000 window once matched a `<tfoot>` "Total" belonging to the following function entirely.
    const detailIdx = serviceSource.indexOf("export async function getDirectOrderApprovalDetail(");
    assert.ok(detailIdx > -1, "getDirectOrderApprovalDetail must exist");
    const detailEnd = serviceSource.indexOf("\nexport ", detailIdx + 1);
    const detailBody = serviceSource.slice(detailIdx, detailEnd === -1 ? undefined : detailEnd);
    assert.match(detailBody, /retailHistory: retail\.rows/, "retail rides its own field");
    assert.match(
      detailBody,
      /pharmacyHistory: pharmacyHistory\.rows/,
      "direct-order history keeps its own field (it now arrives as {rows, hiddenConfidentialCount, loadFailed})",
    );
  }

  // ── The pharmacy-price recompute script ────────────────────────────────────
  // This restates reported sales and therefore achievement, so its guard rails are asserted
  // rather than trusted to review.
  {
    const script = readFileSync(
      new URL("../scripts/direct-orders-pharmacy-price-backfill.ts", import.meta.url),
      "utf8",
    );

    // Truth set. The reversal clause is the non-obvious one: reverseDirectOrder does not copy
    // deal_type, so EVERY reversal row reads 'bonus' by default even when it reverses a
    // discount order. Without this filter the script would destroy their mirror-of-original value.
    assert.match(script, /\.eq\("deal_type", "bonus"\)/, "discount orders price on the public price and must not be touched");
    assert.match(
      script,
      /\.is\("reversal_of_request_id", null\)/,
      "reversals read deal_type 'bonus' regardless of what they reverse — they must be excluded",
    );
    assert.doesNotMatch(
      script,
      /"rejected"|"reversed"/,
      "rejected and reversed orders record a decision against the old number and must not be rewritten",
    );

    // The value must come from the domain function, not a formula copied into a script that
    // then drifts from the rule it is meant to apply.
    assert.match(
      script,
      /computeDirectOrderSalesValue\(\{ qty, pharmacyPrice \}\)/,
      "the recompute must call the domain function, never re-derive qty × price",
    );

    // Two independent flags, and a production ref check on top.
    assert.match(
      script,
      /options\.apply !== true \|\| options\["confirm-restates-achievement"\] !== true/,
      "writing must require BOTH flags",
    );
    assert.match(script, /Refusing to write to PRODUCTION without --project-ref/, "production needs an explicit ref");

    // A missing price must be reported, never silently left on the old basis — that is how a
    // restatement half-happens and nobody notices.
    assert.match(script, /no pharmacy price set for this product/, "unpriced products must be reported as skips");

    // The pre-image must be written BEFORE any update, and must capture sos_batch_id, because
    // the rebuild re-stamps it and no other record of the old batch survives.
    const preImageIdx = script.indexOf("Pre-image written");
    const firstUpdateIdx = script.indexOf('.from("direct_order_requests")\n      .update(');
    assert.ok(preImageIdx > -1 && firstUpdateIdx > -1, "the script must both back up and update");
    assert.ok(preImageIdx < firstUpdateIdx, "the pre-image must be written BEFORE the first write");
    assert.match(script, /sos_batch_id/, "the pre-image must capture sos_batch_id — the rebuild re-stamps it");

    // Only approved orders sit in a Source-of-Sales batch, so only those drive a rebuild.
    assert.match(
      script,
      /approvedChanges\.map\(\(change\) => change\.salesMonth\)/,
      "re-injection must be driven by APPROVED orders' booked months only",
    );
  }

  // The backup snapshot must not live in `public` — a backup table there is anon-reachable.
  {
    const backup = readFileSync(
      new URL("../supabase/direct-orders-pharmacy-price-backfill-backup.sql", import.meta.url),
      "utf8",
    );
    assert.match(backup, /create schema if not exists direct_orders_backup_/, "the snapshot must live in a dated schema");
    assert.doesNotMatch(backup, /create table if not exists public\./, "never snapshot into public");
    assert.match(backup, /revoke all on schema[\s\S]*from public/, "revoke from PUBLIC, not just anon/authenticated");
  }

  // ── One code per field; an unverified pharmacy cannot be finalized ─────────
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");

    // A live pharmacy was registered as "829575 \ 1533576" — two codes in a box built for one.
    // That whole string is matched against the catalogue, so it equals NEITHER code and the
    // pharmacy silently matches nothing.
    // Plain substring, not a regex literal: the pattern itself contains a slash, and escaping it
    // inside a regex here is how this assertion first failed to parse at all.
    assert.ok(
      serviceSource.includes("const CUSTOMER_CODE_SEPARATORS ="),
      "there must be an explicit separator set for customer codes",
    );
    assert.match(serviceSource, /function assertSingleCustomerCode\(/, "there must be a single-code guard");
    assert.match(
      serviceSource,
      /assertSingleCustomerCode\(customerCode\);/,
      "pharmacy creation must run the single-code guard on every pair",
    );
    // The same distributor twice is refused in words, not as an opaque unique-violation.
    assert.match(serviceSource, /appears twice\. A pharmacy holds ONE customer code per distributor/);

    // THE one deliberate block in the module: an unverified pharmacy cannot reach FINAL approval.
    const decideIdx = serviceSource.indexOf("export async function decideDirectOrder(");
    const decideBody = serviceSource.slice(decideIdx, serviceSource.indexOf("// ── Reversal", decideIdx));
    assert.match(
      decideBody,
      /input\.decision === "approve" && evaluation\.isFinal/,
      "the pharmacy gate must apply to the FINAL approval only",
    );
    assert.match(decideBody, /verificationStatus === "pending_review"/, "an unverified pharmacy must block finalization");
    assert.match(
      decideBody,
      /The SFE Manager has to check it first/,
      "the refusal must name who clears it — SFE, since the Super Admin rung is retired",
    );
    // Plain English, checked as a rule rather than a one-off: "catalogue" is the word the owner
    // said he could not understand ("i donot under4stand"), and it had leaked into three surfaces.
    //
    // The approval-window banner text moved to resolveDirectOrderStatusBanner in approval-fields.ts
    // on 2026-08-08 (both the admin AND portal screens call it now, instead of each hand-writing the
    // sentence) — so that is the one place left that could leak "catalogue" back in. Reading the
    // component file for the literal condition would now silently split on nothing and check an
    // empty string forever; that exact failure mode is why this reads the new location by name, and
    // asserts the slice is non-empty rather than trusting the split succeeded.
    const approvalFieldsSourceForBannerCheck = readFileSync(
      new URL("../src/lib/direct-orders/approval-fields.ts", import.meta.url),
      "utf8",
    );
    // Bound the banner branch by the close of its own `if` block — a real end — rather than by a
    // fixed 700 bytes. That window measured how long the sentence happened to be: lengthen the
    // message and the check silently stops reading before the end of the thing it is checking.
    const bannerAnchor = approvalFieldsSourceForBannerCheck.indexOf('pharmacy?.verificationStatus === "pending_review"');
    const bannerRest = bannerAnchor < 0 ? "" : approvalFieldsSourceForBannerCheck.slice(bannerAnchor);
    const bannerBranchEnd = bannerRest.search(/^  \}$/m);
    const bannerBranch = bannerBranchEnd >= 0 ? bannerRest.slice(0, bannerBranchEnd) : bannerRest;
    for (const [label, source] of [
      ["the refusal message", decideBody],
      ["the approval-window banner", bannerBranch],
    ] as const) {
      assert.notEqual(source, "", `${label} source slice must not be empty — the anchor text must still exist to check`);
      assert.doesNotMatch(source, /catalogue/i, `${label} must not use the word "catalogue"`);
    }
    // Earlier rungs must NOT be blocked — SFE and the sales line still review normally.
    const gateIdx = decideBody.indexOf('verificationStatus === "pending_review"');
    const beforeGate = decideBody.slice(0, gateIdx);
    assert.doesNotMatch(
      beforeGate,
      /pending_review[\s\S]*badRequest/,
      "only the final rung may refuse — earlier approvals must still pass",
    );

    // A price that did not price THIS deal is not the same as a price that does not exist.
    const fieldsSource = readFileSync(new URL("../src/lib/direct-orders/approval-fields.ts", import.meta.url), "utf8");
    assert.match(fieldsSource, /const unusedPrice = \(snapshot: number \| null, current: number \| null/);
    assert.match(fieldsSource, /const value = snapshot \?\? current;/, "fall back to the product's CURRENT price");

    // Pinned end to end: a DISCOUNT deal whose product HAS a pharmacy price must not read "not set".
    const discountFields = buildDirectOrderDetailFields(
      detail({
        request: request({ dealType: "discount", discountPct: 20, publicPriceSnapshot: 330, pharmacyPriceSnapshot: null }),
        productPharmacyPrice: 281.688,
        productPublicPrice: 330,
      }),
    );
    const pharmacyPriceValue = discountFields.find((field) => field.label === "Pharmacy price")?.value ?? "";
    assert.doesNotMatch(
      pharmacyPriceValue,
      /not set/,
      "a saved pharmacy price must never read 'not set' just because this deal did not use it",
    );
    // 281.69, not 281.688: money() renders 2dp. The STORED value stays exact (281.688) and is
    // what the sales-value calculation uses — only the display rounds.
    assert.match(pharmacyPriceValue, /281\.69/, "the saved price must be visible on the approval window");
    assert.match(pharmacyPriceValue, /not used — discount deal/, "…and still say it was not the basis");

    // …but a product that genuinely has none still says so.
    const trulyUnset = buildDirectOrderDetailFields(
      detail({
        request: request({ dealType: "discount", discountPct: 20, publicPriceSnapshot: 330, pharmacyPriceSnapshot: null }),
        productPharmacyPrice: null,
      }),
    );
    assert.match(
      trulyUnset.find((field) => field.label === "Pharmacy price")?.value ?? "",
      /not set/,
      "a product with no pharmacy price at all must still read 'not set'",
    );
  }

  // ── Picking the pharmacy from the distributor's own customer list ──────────
  // Replaces typing a code from memory. A wrong code is not a typo: retail sales match on
  // (distributor, customer code), so it silently attributes another pharmacy's sales here.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const idx = serviceSource.indexOf("export async function searchDistributorCustomers(");
    assert.ok(idx > -1, "the customer search must exist");
    const body = serviceSource.slice(idx, serviceSource.indexOf("export async function listDirectOrderDistributorOptions(", idx));

    // SCOPE IS A SECURITY BOUNDARY. Without it a District Manager could enumerate another
    // region's entire customer list by crafting a query string.
    assert.match(body, /listDirectOrderAreaAndBrickOptions\(access\)/, "the search must derive the caller's own areas");
    assert.match(
      body,
      /if \(!unrestricted && !allowedAreaCodes\.has\(wantedArea\.toUpperCase\(\)\)\) return \[\];/,
      "an area outside the caller's scope must return nothing, never be honoured",
    );
    assert.match(
      body,
      /unrestricted \|\| !option\.areaCode \|\| allowedAreaCodes\.has\(option\.areaCode\.toUpperCase\(\)\)/,
      "results must be re-checked against the caller's areas, not trusted from the query",
    );
    // The reserved pseudo-distributors must not be searchable either.
    assert.match(body, /DIRECT_ORDER_EXCLUDED_DISTRIBUTOR_CODES\.has\(distributorCode\.toLowerCase\(\)\)/);
    // A pattern metacharacter in the query must not widen the match.
    assert.match(body, /replace\(\/\[%_,\(\)\]\/g, " "\)/, "search input must be escaped before ilike");

    // Verification is DERIVED from the catalogue, never taken from the client — a client flag
    // could be wrong or forged, and the catalogue is the only thing that knows.
    const createIdx = serviceSource.indexOf("export async function createDirectOrderPharmacy(");
    const createBody = serviceSource.slice(createIdx, serviceSource.indexOf("export async function acknowledgeDirectOrderPharmacy(", createIdx));
    assert.match(
      createBody,
      /const unresolved = Array\.from\(claimablePairs\.entries\(\)\)\.filter\(/,
      "the review REASON must still be derived by checking each code against the customer map",
    );
    // pending_review/entry_source used to be set in a client-side INSERT here; the code-collision
    // fix (3ec5c640) moved pharmacy creation onto the atomic phx_create_direct_order_pharmacy RPC,
    // which pins both values itself so no caller can supply anything else (asserted against the
    // migration SQL by direct-orders-pharmacy-code-collision.test.ts). What this test can still
    // check from the TS side is that creation actually goes through that RPC.
    assert.match(
      createBody,
      /supabase\.rpc\("phx_create_direct_order_pharmacy"/,
      "a hand-registered pharmacy must be created through the atomic RPC, which pins pending_review/manual itself",
    );
    assert.doesNotMatch(
      createBody,
      /\.from\("direct_order_pharmacies"\)\s*\.insert\(/,
      "pharmacy creation must not go through a direct client-side insert — that is what produced the orphan row",
    );
    // …and must NEVER block the submission.
    assert.doesNotMatch(
      createBody,
      /unresolved[\s\S]{0,200}badRequest/,
      "an unrecognised code must flag the pharmacy, never block the request",
    );

    // Situation 3 — no distributor and no code at all — must be accepted. This is the refusal
    // the owner had removed; if it comes back, a submitter who does not know the code is stuck
    // and invents one, which is exactly how "829575 \ 1533576" reached production.
    assert.doesNotMatch(
      createBody,
      /Add at least one distributor/,
      "distributor + customer code are OPTIONAL — the request takes an extra rung instead",
    );
    assert.doesNotMatch(
      createBody,
      /byDistributor\.size === 0[\s\S]{0,120}badRequest/,
      "an empty distributor list must never refuse the registration",
    );
    // With no codes there is nothing to look up, and `.in(col, [])` is not a safe no-op. This guard
    // used to sit at the createDirectOrderPharmacy call site; the code-collision fix (3ec5c640)
    // moved it inside resolveCustomerCodeGeography itself, which every caller now goes through.
    const resolveGeoIdx = serviceSource.indexOf("async function resolveCustomerCodeGeography(");
    const resolveGeoBody = serviceSource.slice(resolveGeoIdx, serviceSource.indexOf("\n}", resolveGeoIdx));
    assert.match(
      resolveGeoBody,
      /if \(byDistributor\.size === 0\) return mapByKey;/,
      "the customer-map lookup must be skipped entirely when no codes were given",
    );

    // ── No Super Admin rung, and approving the SFE rung IS the acknowledgment ───────────────
    // (owner rule, 2026-08-04: "remove the super admin from the approval workflow".)
    const chainIdx = serviceSource.indexOf("async function buildApprovalChain(");
    const chainBody = serviceSource.slice(chainIdx, serviceSource.indexOf("// ── Row mappers", chainIdx));
    assert.ok(
      !/rungs\.push\(\{[\s\S]{0,200}Super Admin/.test(chainBody),
      "no chain may push a Super Admin rung — the rung is retired",
    );
    assert.ok(
      !chainBody.includes("pharmacyUnverified"),
      "the chain shape must not depend on the pharmacy any more",
    );
    assert.ok(
      chainBody.indexOf("SFE_VALIDATION_ROLE") < chainBody.indexOf("const straightToCeo"),
      "SFE must still be pushed onto the chain before the management line",
    );

    // Approving the confirming rung IS the acknowledgment — one decision, one state change.
    // Keeping them separate is what let an approver clear the request and still leave the
    // pharmacy unverified, so the CEO hit the block anyway and nobody could tell which action
    // was outstanding.
    const decideStart = serviceSource.indexOf("export async function decideDirectOrder(");
    const decideSource = serviceSource.slice(decideStart, serviceSource.indexOf("// ── Reversal", decideStart));
    assert.match(
      decideSource,
      /input\.decision === "approve" && isPharmacyConfirmingStep\(activeStep\)[\s\S]{0,200}markDirectOrderPharmacyVerified\(/,
      "approving the confirming rung must verify the pharmacy",
    );
    // Only on approve: a rejection may well BE because the pharmacy is wrong.
    const ackCall = decideSource.slice(0, decideSource.indexOf("markDirectOrderPharmacyVerified("));
    assert.match(
      ackCall.slice(-260),
      /input\.decision === "approve"/,
      "the acknowledgment must be guarded by the approve decision, not fire on any decision",
    );

    // The STANDALONE registry action stays Super-Admin only. The in-flow path is authorized by
    // being the assigned approver of the confirming rung instead, which is why the write itself
    // lives in a module-private helper rather than behind this exported guard.
    const ackIdx = serviceSource.indexOf("export async function acknowledgeDirectOrderPharmacy(");
    const ackBody = topLevelBlock(serviceSource, ackIdx);
    assert.match(ackBody, /access\.scope === "system" \|\| access\.role === "Super Admin"/);
    assert.match(ackBody, /Forbidden: only a System Admin can acknowledge a venue\./);
    assert.ok(
      !/export async function markDirectOrderPharmacyVerified\(/.test(serviceSource),
      "the unguarded pharmacy write must stay module-private, never exported",
    );
    const writeIdx = serviceSource.indexOf("async function markDirectOrderPharmacyVerified(");
    assert.match(
      topLevelBlock(serviceSource, writeIdx),
      /writeRequiredAuditLog\(/,
      "clearing a pharmacy must be audited with its prior state",
    );

    // The flag is pointless if the approver cannot see it. The condition itself moved into
    // resolveDirectOrderStatusBanner (approval-fields.ts, 2026-08-08) so admin and portal share one
    // sentence instead of each hand-writing it — checked in BOTH places: the window actually calls
    // the shared resolver, and the resolver itself still gates on the unverified pharmacy.
    const adminDetail = readFileSync(
      new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      adminDetail,
      /resolveDirectOrderStatusBanner\(/,
      "the approval window must surface its status banner (including an unverified pharmacy) via the shared resolver",
    );
    // Read fresh rather than reused from the earlier block above — that const is scoped to its own
    // `{ ... }` test block and does not reach this one.
    const approvalFieldsSourceForPendingReviewGate = readFileSync(
      new URL("../src/lib/direct-orders/approval-fields.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      approvalFieldsSourceForPendingReviewGate,
      /pharmacy\?\.verificationStatus === "pending_review"/,
      "the shared status-banner resolver must still gate on an unverified pharmacy",
    );

    // The picker must not silently keep a code that belonged to a different distributor.
    const picker = readFileSync(
      new URL("../src/components/direct-orders/distributor-customer-picker.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      picker,
      /onChange\(\{ distributorCode: event\.target\.value, customerCode: "", customerName: "" \}\)/,
      "changing distributor must clear the chosen customer — the code belongs to the old one",
    );
    assert.match(picker, /seq !== requestSeq\.current/, "a stale type-ahead response must not overwrite a newer one");
    assert.match(picker, /Not listed\? Enter the code manually/, "manual entry must always remain available");
  }

  // ── A requester tracks their OWN order in the same detail an approver reads ─
  // Owner requirement: the submitter must be able to follow their request and see exactly which
  // rung holds it — not a reduced summary. Same component, same payload, different framing.
  {
    const adminPage = readFileSync(
      new URL("../app/(admin)/admin/direct-orders/[id]/page.tsx", import.meta.url),
      "utf8",
    );
    const portalPage = readFileSync(
      new URL("../app/employee-portals/direct-orders/[id]/page.tsx", import.meta.url),
      "utf8",
    );

    for (const [name, source] of [["admin", adminPage], ["portal", portalPage]] as const) {
      // The SAME payload builder as the approval window — a second, thinner read model is exactly
      // how the two views would drift apart.
      assert.match(
        source,
        /getDirectOrderApprovalDetail\(access, id\)/,
        `the ${name} tracking page must reuse the approval payload, not a reduced one`,
      );
      // No hand-rolled permission gate: the service already answers null out of scope, and its
      // scope rule admits a requester for their own request. A second gate here could only ever
      // disagree with the first.
      assert.doesNotMatch(
        source,
        /isDirectOrderRequesterRole|assertPermission/,
        `the ${name} tracking page must not add a second permission gate`,
      );
      assert.match(source, /backLabel=/, `the ${name} tracking page must not send the requester back to an approvals queue`);
    }

    // Both detail components must accept the label so one component can serve both audiences.
    for (const path of [
      "../src/components/approvals-hub/direct-order-request-detail.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, /backLabel = "Back to Direct Orders Approvals"/, `${path} must default to the approver wording`);
      assert.doesNotMatch(
        source,
        /Back to Direct Orders Approvals\s*\n\s*<\/Link>/,
        `${path} must render the label, not a hardcoded approvals string`,
      );
    }

    // The requester reaches it from their own list — a detail page nobody can navigate to is
    // the state this fixes.
    const adminList = readFileSync(
      new URL("../src/components/direct-orders/direct-order-submit-form.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      adminList,
      /\$\{basePath\}\/\$\{encodeURIComponent\(r\.id\)\}/,
      "rows must link to the tracking view",
    );
    // In the READER'S OWN SHELL. This was pinned to a literal "/admin/direct-orders", which is the
    // wrong shell for almost everyone who uses this form — portalShellRoles sends every
    // District / Regional / National Sales Manager and Product / Group Product Manager to the
    // portal, and they are the people who raise direct orders. It resolved only because the admin
    // detail page redirects them back.
    // Comments stripped first. An assertion that cannot tell a comment from a call site is one that
    // gets "fixed" by deleting the explanation — the docblock on the basePath prop says the literal
    // out loud precisely so nobody puts it back.
    const adminListCode = stripComments(adminList);
    assert.doesNotMatch(
      adminListCode,
      /"\/admin\/direct-orders/,
      "the submit form must not hardcode the admin shell — the base path is a prop, set by whichever shell mounts it",
    );

    // A requester must NEVER see Approve on their own request. Both decision panels bail out
    // when no action is available — that is what keeps this page read-only for them.
    //
    // The bail-out gained a second clause on 2026-09-10, when the vacation screen started showing
    // its Acknowledge-as-HR button greyed rather than absent. That set is OPT-IN: `shownDisabled`
    // is empty unless the caller passes `disabledReasons`, and direct orders never does — so this
    // page is as read-only as before. Both halves are asserted, because dropping the opt-in gate
    // is what would silently put dead buttons in front of a requester on their own order.
    for (const path of [
      "../src/components/approvals-hub/decision-actions.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(
        source,
        /if \(available\.length === 0 && shownDisabled\.length === 0\) return null;/,
        `${path} must render nothing when the viewer has no available action`,
      );
      assert.match(
        source,
        /Boolean\(disabledReasons\?\.\[action\]\)/,
        `${path} must only ever grey an action the caller explicitly supplied a reason for`,
      );
    }
  }

  // ── Rebuilding an approval chain must never erase a real decision ──────────
  // This function DELETES approval steps. The only thing making that safe is that it refuses
  // when anybody has already acted — a decided step is a person's recorded approval or
  // rejection, not scaffolding.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const idx = serviceSource.indexOf("export async function rebuildDirectOrderApprovalChain(");
    assert.ok(idx > -1, "the chain-rebuild entry point must exist");
    const body = serviceSource.slice(idx, serviceSource.indexOf("// ── Reversal", idx));

    assert.match(body, /Forbidden: only a System Admin can rebuild an approval chain\./);
    assert.match(body, /request\.status !== "pending_approval"/, "only a pending request may be rebuilt");

    // THE safety gate.
    assert.match(
      body,
      /decided\.length > 0/,
      "rebuilding must refuse when any step is already decided — deleting one erases a real approval",
    );
    assert.match(
      body,
      /!== "pending" \|\| row\.decided_by_hr_id \|\| row\.decided_at/,
      "a step counts as decided by status OR decider OR decision time — any one of the three",
    );
    // The guard must run BEFORE the delete, or it protects nothing.
    assert.ok(
      body.indexOf("decided.length > 0") > -1 &&
        body.indexOf("decided.length > 0") < body.indexOf(".delete()"),
      "the decided-step guard must run BEFORE the delete",
    );
    // Reuse the SAME builder submit uses, so a backfilled chain equals a resubmitted one.
    assert.match(body, /await buildApprovalChain\(\{/, "must reuse buildApprovalChain, not redefine the ladder");
    // A rebuilt chain nobody is told about is a request that silently stalls.
    assert.match(body, /notifyDirectOrder\(\{/, "the new first rung must be notified");
    assert.match(body, /eventType: "chain_rebuilt"/, "the before/after must be recorded on the timeline");
  }

  // ── The approver's notification ─────────────────────────────────────────────
  {
    const ctx = {
      request: request(),
      requesterName: "Mahmoud Adel",
      pharmacyName: "El Ezaby",
      pharmacyCode: "DOP-000123",
      geo: detail().geo,
      medicalRep: detail().medicalRep,
      distributorCodesText: "Ibn Sina: 1234567; Overseas: 7654321",
      distributorNames: "Ibn Sina · Overseas",
    };
    const line = buildDirectOrderNotificationLine(ctx);

    // Telegram collapses all whitespace then hard-slices at 900 chars with no ellipsis, and
    // the transport prepends a module line of its own — so this must stay comfortably short.
    assert.ok(
      line.length <= DIRECT_ORDER_NOTIFICATION_MAX_CHARS,
      `the notification body must stay under ${DIRECT_ORDER_NOTIFICATION_MAX_CHARS} chars for Telegram (was ${line.length})`,
    );
    // The three things the owner said were missing.
    assert.match(line, /El Ezaby/, "the pharmacy NAME must reach the approver");
    assert.match(line, /DOP-000123/, "the pharmacy CODE must reach the approver");
    assert.match(line, /Ibn Sina/, "the DISTRIBUTOR must reach the approver");
    // Geography by name, and the area's rep.
    assert.match(line, /Cairo East/);
    assert.match(line, /Heliopolis/);
    assert.match(line, /Sara Hassan/);
    assert.doesNotMatch(line, /\bCA-07\b/, "the notification must name the area, not code it");

    // The NOTIFICATION is where the HR_ID actually leaked in production ("Medical rep pd-0005"),
    // because buildNotifyContext resolved the rep WITHOUT an employee-name lookup while the
    // approval window resolved it WITH one. Assert the body too, not just the detail field.
    //
    // Scoped to the rep clause on purpose: the line legitimately contains a pharmacy code
    // (DOP-000123) with the same letters-dash-digits shape, so asserting over the whole string
    // fails on correct output.
    const repClause = /Medical rep ([^.]+)\./.exec(line)?.[1] ?? "";
    assert.ok(repClause.length > 0, "the notification must state a medical rep");
    assert.doesNotMatch(
      repClause,
      /\b[A-Za-z]{1,3}-\d{2,}\b/,
      "the notification must name the rep, never fall back to their HR_ID",
    );

    // The email metrics table carries the full distributor→customer-code pairs the one-liner drops.
    const metrics = buildDirectOrderNotificationMetrics(ctx);
    assert.doesNotMatch(
      metrics.find((metric) => metric.label === "Medical rep")?.value ?? "",
      /\b[A-Za-z]{1,3}-\d{2,}\b/,
      "the email metrics table must name the rep too",
    );
    const metricValue = (label: string) => metrics.find((metric) => metric.label === label)?.value ?? "";
    assert.equal(metricValue("Distributor codes"), "Ibn Sina: 1234567; Overseas: 7654321");
    assert.equal(metricValue("Venue"), "El Ezaby (DOP-000123)");
    assert.equal(metricValue("Medical rep"), "Sara Hassan");
    assert.equal(metricValue("Area"), "Cairo East (CA-07)");
  }

  // ── Regression locks on the surfaces that had the bug ───────────────────────
  {
    const adminDetail = readFileSync(
      new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url),
      "utf8",
    );

    // The exact bug: both screens printed `${pharmacy.brickId} / ${pharmacy.areaCode}`.
    // `\.?\.?` also catches the optional-chained `pharmacy?.brickId` form — without it a
    // reintroduced raw-code field slips straight past this lock (confirmed by mutation).
    for (const [name, source] of [["admin", adminDetail]] as const) {
      assert.doesNotMatch(source, /pharmacy\??\.brickId/, `the ${name} approval window must not print a raw brick code`);
      assert.doesNotMatch(source, /pharmacy\??\.areaCode/, `the ${name} approval window must not print a raw area code`);
      assert.doesNotMatch(source, /"Brick \/ Area"/, `the ${name} approval window must not combine brick and area into one cell`);
      // Both must render the SHARED list — which is what stops them drifting apart again.
      assert.match(
        source,
        /buildDirectOrderDetailFields\(/,
        `the ${name} approval window must render the shared field list, not its own copy`,
      );
    }
  }
  {
    // The portal's mobile card dropped the pharmacy code, so an approver on a phone could not
    // tell two same-named pharmacies apart.
    const queueRow = readFileSync(
      new URL("../src/lib/direct-orders/needs-action.ts", import.meta.url),
      "utf8",
    );
    assert.match(queueRow, /row\.pharmacyCode/, "the Needs Action row must show the pharmacy code");
    assert.match(queueRow, /row\.medicalRepName/, "the Needs Action row must show the medical rep");
  }
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    // Enrichment happens at the single read choke point, not in a component.
    const detailIdx = serviceSource.indexOf("export async function getDirectOrderApprovalDetail(");
    const detailBody = topLevelBlock(serviceSource, detailIdx);
    assert.match(detailBody, /loadDirectOrderGeoNames\(/, "the detail payload must resolve geography names");
    assert.match(detailBody, /resolveAreaRep\(/, "the detail payload must resolve the area's medical rep");

    // `nameOf` is a REQUIRED parameter on the resolver, so a call site cannot silently fall back
    // to raw HR_IDs. Typecheck is the real guard; this pins the intent so nobody re-adds a default.
    const resolverSource = readFileSync(
      new URL("../src/lib/employees/area-rep-resolver.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      resolverSource,
      /options: \{ nameOf: \(hrId: string \| null\) => string \| null \}/,
      "nameOf must be REQUIRED — an optional one shipped a notification reading 'Medical rep pd-0005'",
    );
    assert.doesNotMatch(
      resolverSource,
      /options\?\.nameOf \?\?/,
      "no silent default: forgetting the lookup must be a compile error, not a downgrade",
    );
    // EVERY call site must pass a real lookup — not just one of them. A bare `assert.match`
    // here is worthless: it passes as soon as ONE site is correct, which is exactly the state
    // that shipped (the detail path had it, the notification path did not).
    const repCalls = [...serviceSource.matchAll(/resolveAreaRep\([\s\S]{0,160}?\)\s*,?\s*$/gm)];
    const repCallSites = [...serviceSource.matchAll(/resolveAreaRep\(/g)];
    assert.ok(repCallSites.length >= 2, "expected at least the detail and notification call sites");
    for (const match of repCalls) {
      assert.match(
        match[0],
        /\{ nameOf \}/,
        `every resolveAreaRep call must pass the employee-name lookup — found: ${match[0].trim()}`,
      );
    }
    // And nobody may re-introduce a null lookup to satisfy the required parameter.
    assert.doesNotMatch(
      serviceSource,
      /nameOf:\s*\(\)\s*=>\s*null/,
      "passing a null-returning lookup defeats the required parameter and leaks HR_IDs again",
    );
    // Proves the name-map extraction actually replaced the duplicates rather than adding a third.
    assert.doesNotMatch(
      serviceSource,
      /const brickNameById = new Map/,
      "the brick/area/region name maps must come from the shared geo-names helper, not a local copy",
    );
    // The approver's notification must carry the full picture, not just product × qty.
    assert.doesNotMatch(
      serviceSource,
      /A direct order \(\$\{product\.productName\} × \$\{qty\}\) needs your approval\./,
      "the thin product-only notification body must be gone",
    );
    assert.match(serviceSource, /buildDirectOrderNotificationMetrics\(/, "notifications must carry an email metrics table");
  }
  {
    // Portal-shell managers must land in their own shell, not /admin/....
    const hrefs = readFileSync(new URL("../src/lib/notifications/hrefs.ts", import.meta.url), "utf8");
    assert.match(
      hrefs,
      /\/employee-portals\/approvals\/direct-orders/,
      "direct-order notification links must be remapped for portal-shell viewers",
    );
  }
  {
    // The submit forms labelled a picked brick with codes only because the options omitted names.
    for (const path of [
      "../src/components/direct-orders/direct-order-submit-form.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, /selectedBrick\.areaName/, `${path} must label the picked brick's area by NAME`);
      assert.match(source, /selectedBrick\.regionName/, `${path} must label the picked brick's region by NAME`);
    }
  }

  // ── A pharmacy with NO distributor code must say so, not render a dash ──────
  //
  // Found live: محمد ميجا (DOP-000005, 38,016 EGP) and Ibrahim pharmacy (DOP-000004) both reached
  // approval with zero distributor codes, and the window printed "Distributors: —". The owner read
  // that as the screen failing to show the distributor. It was not — there was nothing on file.
  //
  // Those two states demand opposite reactions from an approver, so the empty case has to name
  // itself. This is the repo's most-repeated defect class: missing data must never render as
  // absence. Codes became optional on 2026-08-04, which turned this from a rare edge into the
  // normal state for any pharmacy registered without one.
  {
    for (const [label, path] of [
      ["the admin approval window", "../src/components/approvals-hub/direct-order-request-detail.tsx"],
    ] as const) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const idx = source.indexOf("distributors.length === 0");
      assert.ok(idx > -1, `${label} must handle a pharmacy with no distributor codes`);
      // The empty branch legitimately grew — it now renders explicit "Distributor / Distributor
      // code: Not provided" fields (a missing FIELD reads as "the screen forgot to ask") and forks
      // into THREE states rather than one, because "no code exists anywhere" and "a real code exists
      // but was never linked to this record" demand opposite reactions and were briefly printed on
      // top of each other. The window was widened 1500 → 4000 twice to chase that. It is bounded by
      // the ternary's own else arm at this nesting depth now — a real sibling anchor — so the branch
      // can keep growing, and no marker can leak in from the arm below.
      const elseArm = source.slice(idx).search(/^ {10}\) : \(/m);
      const emptyBranch = source.slice(idx, elseArm >= 0 ? idx + elseArm : source.length);
      assert.match(
        emptyBranch,
        /No distributor customer code on file/,
        `${label} must say WHAT is missing when a pharmacy has no code`,
      );
      assert.match(
        emptyBranch,
        /cannot be linked/,
        `${label} must say what the missing code COSTS, not just that it is absent`,
      );
      // The exact regression: a lone dash as the entire empty state.
      assert.doesNotMatch(
        emptyBranch,
        /className="mt-0\.5 text-sm font-semibold text-slate-\d00">[—-]</,
        `${label} must not render a bare dash for "no distributor codes"`,
      );
    }

    // The notification carries the same fact to an approver who never opens the window.
    const fieldsSource = readFileSync(new URL("../src/lib/direct-orders/approval-fields.ts", import.meta.url), "utf8");
    const metricsIdx = fieldsSource.indexOf("export function buildDirectOrderNotificationMetrics(");
    const metricsBody = topLevelBlock(fieldsSource, metricsIdx);
    assert.match(
      metricsBody,
      /none on file — distributor sales cannot be linked to this venue/,
      "the notification must name an absent distributor code rather than dashing it",
    );
    assert.doesNotMatch(
      metricsBody,
      /\{ label: "Distributor codes", value: text\(/,
      "the notification's distributor field must not fall back to the generic dash helper",
    );
  }

  // ── A half-filled distributor row is refused, never dropped in silence ──────
  //
  // Found by investigating "where are the codes they submitted by their hands?". The codes were
  // never submitted — but the reason the question was fair is that the server used to discard a
  // row with only one half filled, exactly like a row with neither. A submitter who picked a
  // distributor, searched, found nothing and moved on had visibly started filling that row; the
  // pharmacy was then recorded as "no distributor or customer code was given". Both were right.
  //
  // The blank row must STILL be skipped: the form always renders one, and leaving it alone is the
  // legitimate "I do not know the code" answer that made codes optional in the first place.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const idx = serviceSource.indexOf("function normalizeDistributorCodePairs(");
    assert.ok(idx > -1, "the shared code normalizer must exist");
    const body = serviceSource.slice(idx, serviceSource.indexOf("\n}", serviceSource.indexOf("return byDistributor;", idx)));

    // Untouched row → skipped. Note the AND: an `||` here is the original bug.
    assert.match(
      body,
      /if \(!distributorCode && !customerCode\) continue;/,
      "a row with BOTH halves blank must still be skipped — that is the legitimate empty answer",
    );
    assert.doesNotMatch(
      body,
      /if \(!distributorCode \|\| !customerCode\) continue;/,
      "skipping on EITHER half blank is the silent drop this fixes",
    );

    // Half-filled → refused, in both directions.
    assert.match(
      body,
      /if \(distributorCode && !customerCode\) \{[\s\S]{0,400}badRequest\(/,
      "a distributor with no customer must be refused, not dropped",
    );
    assert.match(
      body,
      /if \(!distributorCode && customerCode\) \{[\s\S]{0,400}badRequest\(/,
      "a customer code with no distributor must be refused — the API is reachable directly",
    );
    // The refusal has to be actionable: it names both escape hatches and the remove control.
    assert.match(body, /Not listed\? Enter the code manually/, "the refusal must name the manual-entry escape hatch");
    assert.match(body, /remove the row/, "the refusal must say a row can simply be removed");

    // Names, never raw codes — the owner's standing rule, and the whole point of the resolver.
    assert.match(body, /nameOf\(distributorCode\)/, "the refusal must name the distributor, not print its code");
    const callSites = serviceSource.match(/normalizeDistributorCodePairs\([^)]*\)/g) ?? [];
    const invocations = callSites.filter((call) => call.includes("input.distributorCodes"));
    assert.equal(invocations.length, 3, "the order form, the registry and the code replacement all normalize");
    for (const [i, call] of invocations.entries()) {
      assert.match(
        call,
        /await distributorNameResolver\(\)/,
        `normalizeDistributorCodePairs call ${i + 1} must pass the name resolver`,
      );
    }

    // …and the submitter sees it on the row, not as a rejection after filling the whole form.
    const picker = readFileSync(
      new URL("../src/components/direct-orders/distributor-customer-picker.tsx", import.meta.url),
      "utf8",
    );
    assert.match(
      picker,
      /const halfFilled = Boolean\(row\.distributorCode\) && !row\.customerCode\.trim\(\);/,
      "the picker must derive the half-filled state",
    );
    assert.match(
      picker,
      /You picked a distributor but no customer yet/,
      "the picker must say so inline while the submitter is still on the row",
    );
  }

  // ── Pharmacy registry: set a pharmacy up BEFORE an order needs it ───────────
  // Owner request, 2026-08-04. Registering here counts as confirmation, because the person doing
  // it IS the authority the approval chain would otherwise wait for.
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    // MOVED 2026-09-03 out of service.ts into its own module, so the CRM contact picker could ask
    // the same question without closing an import cycle (service.ts already imports
    // venue-contact-options). The role list itself did not change; only where it lives.
    const registryAccessSource = readFileSync(
      new URL("../src/lib/direct-orders/registry-access.ts", import.meta.url),
      "utf8",
    );

    // Who may open the registry (owner's choice: Super Admin + SFE Manager).
    assert.match(
      registryAccessSource,
      /const PHARMACY_REGISTRY_ROLES = new Set<PhoenixRole>\(\["Super Admin", "SFE Manager"\]\)/,
      "the registry is Super Admin + SFE Manager",
    );

    // THE boundary, restated (owner rule, 2026-08-04: "remove the super admin from the approval
    // workflow of the direct orders").
    //
    // It used to read "SFE must never clear a pharmacy", because SFE sat on the rung directly
    // before the System Admin rung and clearing it would have dissolved the next approver's step
    // on a request SFE was about to sign. That rung is now retired, so there is no second step
    // left to dissolve — SFE confirming the pharmacy IS the intended behaviour, and it happens by
    // approving SFE's own rung, never as a free-standing action.
    //
    // What still has to hold: the STANDALONE registry action stays Super-Admin-only, so an SFE
    // Manager cannot clear an arbitrary pharmacy they are not currently approving. Slice to the
    // exported function's own body so a neighbouring helper's prose cannot satisfy or trip this.
    const ackIdx = serviceSource.indexOf("export async function acknowledgeDirectOrderPharmacy(");
    // CRLF-SAFE. This slice used to look for the literal "\n}\n", which never matches a file with
    // Windows line endings ("\r\n}\r\n") — indexOf returned -1, slice(ackIdx, -1) ran to the end of
    // the file, and the guard silently covered all 5,000 lines instead of this one function. It only
    // looked green because "SFE Manager" happened not to appear anywhere later in service.ts; the
    // moment it did (the 2026-08-09 cleanup gate, a completely unrelated function) the test failed
    // and pointed at the wrong code. Match the closing brace at column 0 on either line ending.
    const ackEnd = serviceSource.slice(ackIdx).search(/\r?\n\}\r?\n/);
    const ackBody = serviceSource.slice(ackIdx, ackEnd === -1 ? undefined : ackIdx + ackEnd);
    assert.ok(
      ackEnd !== -1 && ackBody.length < 2000,
      "the acknowledge slice must end at the function's own closing brace — a slice that runs to end-of-file makes every assertion below it meaningless",
    );
    assert.match(
      ackBody,
      /access\.scope === "system" \|\| access\.role === "Super Admin"/,
      "the standalone acknowledgment must stay Super Admin, never widen to the registry roles",
    );
    assert.doesNotMatch(
      ackBody,
      /PHARMACY_REGISTRY_ROLES|canManagePharmacyRegistry|SFE Manager/,
      "the standalone acknowledgment must not be gated by the registry roles",
    );

    // Every registry write is gated in the SERVICE, not in the route or the component. The route
    // is reachable directly, so a hidden button proves nothing.
    for (const fn of [
      "listDirectOrderPharmacyRegistry",
      "registerDirectOrderPharmacy",
      "updateDirectOrderPharmacyDetails",
      "replaceDirectOrderPharmacyCodes",
    ]) {
      const idx = serviceSource.indexOf(`export async function ${fn}(`);
      assert.ok(idx > -1, `${fn} must exist`);
      const body = topLevelBlock(serviceSource, idx);
      assert.match(body, /assertPharmacyRegistryAccess\(access\)/, `${fn} must gate on the registry roles`);
    }

    // A registry-born pharmacy is CONFIRMED — that is the entire point of pre-registering.
    const regIdx = serviceSource.indexOf("export async function registerDirectOrderPharmacy(");
    const regBody = serviceSource.slice(regIdx, serviceSource.indexOf("export async function updateDirectOrderPharmacyDetails(", regIdx));
    assert.match(regBody, /verification_status: "verified"/, "a pre-registered pharmacy must not need a second confirmation");
    assert.match(regBody, /entry_source: "catalogue"/);
    assert.match(regBody, /verified_by_hr_id: hrIdForStorage\(access\.hrId\)/, "who confirmed it must be recorded, in the casing employees.hr_id stores");
    assert.match(regBody, /writeRequiredAuditLog\(/, "pre-registration must be audited");

    // …and the ORDER FORM must still flag everything it creates. If these two ever converge, a
    // District Manager typing a pharmacy mid-order would silently skip the review entirely.
    const createIdx = serviceSource.indexOf("export async function createDirectOrderPharmacy(");
    const createBody = serviceSource.slice(createIdx, serviceSource.indexOf("export async function acknowledgeDirectOrderPharmacy(", createIdx));
    assert.match(
      createBody,
      /supabase\.rpc\("phx_create_direct_order_pharmacy"/,
      "the order form must keep flagging what it creates, whatever the registry does",
    );
    assert.doesNotMatch(
      createBody,
      /verification_status: "verified"/,
      "the order form must never mint a confirmed pharmacy",
    );

    // Editing a code is not the same act as confirming a pharmacy. Folding them together would
    // let an SFE Manager clear a pending pharmacy by changing one character.
    const replaceIdx = serviceSource.indexOf("export async function replaceDirectOrderPharmacyCodes(");
    const replaceBody = topLevelBlock(serviceSource, replaceIdx);
    assert.doesNotMatch(
      replaceBody,
      /verification_status/,
      "replacing codes must never touch verification status",
    );
    // Replace, not merge: the common case is FIXING a wrong code, and a merge would leave the
    // broken pair sitting beside the corrected one.
    assert.match(
      replaceBody,
      /\.delete\(\)\s*\n\s*\.eq\("pharmacy_id", input\.pharmacyId\)/,
      "the old code set must be cleared before the new one is written",
    );

    // Both write paths must run the SAME code validation — a rule enforced in one but not the
    // other is a rule that does not exist.
    for (const [label, body] of [
      ["the order form", createBody],
      ["the registry", regBody],
      ["the code replacement", replaceBody],
    ] as const) {
      assert.match(
        body,
        /normalizeDistributorCodePairs\(/,
        `${label} must validate codes through the shared normalizer, not its own copy`,
      );
    }
  }

  // ── A RETURNED order's open rung (owner, 2026-09-14) ─────────────────────────────────────────
  // A return leaves the returning rung `pending` so a resubmission resumes there. Read on its own,
  // that rung said "Waiting on SFE Manager now" on an order sitting with its requester, and the SFE
  // Manager went looking for an Approve button a returned order never has. The open rung must name
  // the requester instead — and only on a returned order.
  {
    assert.equal(
      describeReturnedDirectOrderWait("Nermeen Salah Abdelaty Abohussien"),
      "Returned — waiting for Nermeen Salah",
    );
    assert.equal(describeReturnedDirectOrderWait("  Nermeen  "), "Returned — waiting for Nermeen");
    assert.equal(describeReturnedDirectOrderWait(null), "Returned — waiting for the person who raised it");

    const chain = [
      { order: 1, label: "SFE Manager", kind: "role", role: "SFE Manager", approverHrId: null, status: "pending", decisionComment: null, approverName: "SFE Manager", decidedByName: null },
      { order: 2, label: "Regional Sales Manager", kind: "person", role: null, approverHrId: "PD-0001", status: "pending", decisionComment: null, approverName: "Hany Saad", decidedByName: null },
    ] as unknown as Parameters<typeof buildDirectOrderApprovalNarrative>[0];

    const returned = buildDirectOrderApprovalNarrative(chain, {
      requestStatus: "returned",
      requesterName: "Nermeen Salah Abdelaty Abohussien",
      returnedByName: "Khaled Bedair",
    });
    assert.equal(
      returned[0].trackerLabel,
      "Returned — waiting for Nermeen Salah",
      "a returned order's open rung must name its requester on the progress bar, not the SFE Manager",
    );
    assert.equal(
      returned[0].sentence,
      "Khaled Bedair returned this order — waiting for Nermeen Salah Abdelaty Abohussien to correct and resubmit.",
    );
    assert.equal(returned[0].state, "current");
    assert.equal(returned[0].label, "SFE Manager", "the rung keeps its own name — only what the bar and sentence say changes");
    assert.equal(returned[1].trackerLabel, "Regional Sales Manager");
    assert.equal(returned[1].sentence, "Will move to Hany Saad next.");

    // The same chain on an order still in approval is untouched.
    const pending = buildDirectOrderApprovalNarrative(chain, { requestStatus: "pending_approval", requesterName: "Nermeen Salah" });
    assert.equal(pending[0].trackerLabel, "SFE Manager");
    assert.equal(pending[0].sentence, "Waiting on SFE Manager now.");
    assert.deepEqual(
      buildDirectOrderApprovalNarrative(chain).map((step) => step.trackerLabel),
      ["SFE Manager", "Regional Sales Manager"],
    );

    // Every surface naming the open rung goes through the rule: both service list builders (the
    // approvals list and the report's "Awaiting" column) and the order window's progress bar.
    const svc = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    assert.equal(
      (svc.match(/activeStepLabel:\s*request\.status === "returned"\s*\?\s*describeReturnedDirectOrderWait\(/g) ?? []).length,
      2,
      "both activeStepLabel builders in service.ts must name the requester on a returned order",
    );
    assert.doesNotMatch(svc, /activeStepLabel: active\?\.label \?\? ""/, "no activeStepLabel may read the open rung's label unconditionally");
    const detailSource = readFileSync(new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url), "utf8");
    assert.match(detailSource, /requestStatus: request\.status/, "the order window must pass the request's status to the narrative");
    assert.match(detailSource, /label: step\.trackerLabel/, "the progress bar must print trackerLabel, not the rung's raw label");
    const primitives = readFileSync(new URL("../src/components/approvals-hub/direct-order-detail-primitives.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(
      topLevelBlock(primitives, primitives.indexOf("export function ApprovalTracker(")),
      /\btruncate\b/,
      "progress-bar labels wrap — never an ellipsis (owner rule)",
    );
  }

  // ── The Pricing row shows EVERY line's working, then the total (owner, 2026-10-19) ─────────────
  // It priced the order row, which on a basket is line one only: a Lacto Advanced 1 + 2 order
  // printed 24,750 beside a 47,250 total, and a 68.8889% Ivyronc order printed 6,999.98 beside
  // 7,000.00 because the row keeps the discount to 3 decimals. 11 orders on the day it was found.
  {
    const item = (overrides: Partial<DirectOrderPricingItem> & Pick<DirectOrderPricingItem, "lineNo">): DirectOrderPricingItem => ({
      productName: "Lacto Advanced 1",
      dealType: "bonus",
      qty: 0,
      bonus: 0,
      discountPct: null,
      publicPriceSnapshot: null,
      pharmacyPriceSnapshot: null,
      ...overrides,
    });
    const lactoRow = {
      productName: "Lacto Advanced 1",
      dealType: "bonus" as const,
      qty: 300,
      bonus: 30,
      discountPct: null,
      publicPriceSnapshot: 110,
      pharmacyPriceSnapshot: 82.5,
      salesValue: 47250,
    };
    const lactoLines = [
      item({ lineNo: 2, productName: "Lacto Advanced 2", qty: 300, bonus: 30, pharmacyPriceSnapshot: 75 }),
      item({ lineNo: 1, qty: 300, bonus: 30, pharmacyPriceSnapshot: 82.5 }),
    ];
    const basket = computeDirectOrderPricingBreakdown(lactoRow, lactoLines);
    assert.deepEqual(
      basket.lines.map((line) => [line.lineNo, line.productName, line.computedValue]),
      [
        [1, "Lacto Advanced 1", 24750],
        [2, "Lacto Advanced 2", 22500],
      ],
      "every line gets its own working, in entry order — the approver must see what the whole total is made of",
    );
    assert.equal(basket.computedValue, 47250, "the working arrives at the basket's total, not at line one's 24,750");
    assert.equal(basket.lines[1].bonusUnits, 30, "each bonus line carries its own bonus units");

    const zamzam = computeDirectOrderPricingBreakdown(
      { productName: "Ivyronc", dealType: "discount", qty: 500, bonus: 0, discountPct: 68.889, publicPriceSnapshot: 45, pharmacyPriceSnapshot: null, salesValue: 7000 },
      [item({ lineNo: 1, productName: "Ivyronc", dealType: "discount", qty: 500, discountPct: 68.8889, publicPriceSnapshot: 45 })],
    );
    assert.equal(zamzam.lines[0].discountPct, 68.8889, "the discount is the LINE's 4 decimals, never the order row's 3");
    assert.equal(zamzam.computedValue, 7000, "Zamzam Hospital's Ivyronc order works out to the 7,000.00 it is stored at, not 6,999.98");
    assert.equal(zamzam.lines[0].bonusUnits, null, "a discount line carries no bonus units");

    const oneUnpriced = computeDirectOrderPricingBreakdown(lactoRow, [
      lactoLines[1],
      item({ lineNo: 2, productName: "Lacto Advanced 2", qty: 300, pharmacyPriceSnapshot: null }),
    ]);
    assert.equal(oneUnpriced.lines[0].computedValue, 24750, "the priced line still shows its working");
    assert.equal(oneUnpriced.lines[1].computedValue, null, "a line with no price reads 'not set', never 0");
    assert.equal(oneUnpriced.computedValue, null, "a total with a line missing is not the total, so none is printed");

    const noLinesLoaded = computeDirectOrderPricingBreakdown({ ...lactoRow, salesValue: 24750 }, []);
    assert.equal(noLinesLoaded.lines.length, 1, "with no lines loaded, the order row stands in as its single line");
    assert.equal(noLinesLoaded.lines[0].productName, "Lacto Advanced 1");
    assert.equal(noLinesLoaded.computedValue, 24750);

    const detailSource = readFileSync(new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url), "utf8");
    assert.match(
      detailSource,
      /computeDirectOrderPricingBreakdown\(request, detail\.items\)/,
      "the order window must hand the breakdown its lines — called with the request alone it falls back to line one",
    );
    const primitives = readFileSync(new URL("../src/components/approvals-hub/direct-order-detail-primitives.tsx", import.meta.url), "utf8");
    assert.match(
      topLevelBlock(primitives, primitives.indexOf("export function PricingBreakdownFact(")),
      /breakdown\.lines\.map\(/,
      "the Pricing row renders every line, not one",
    );
  }
}
