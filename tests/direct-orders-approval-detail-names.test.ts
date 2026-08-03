import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECT_ORDER_CORE_FIELD_LABELS,
  DIRECT_ORDER_NOTIFICATION_MAX_CHARS,
  buildDirectOrderDetailFields,
  buildDirectOrderNotificationLine,
  buildDirectOrderNotificationMetrics,
  formatMedicalRep,
} from "../src/lib/direct-orders/approval-fields.ts";
import {
  codeNameLabel,
  formatDistributorCodesText,
  formatDistributorNames,
  toDistributorRows,
} from "../src/lib/direct-orders/geo-names.ts";
import {
  areaRepKey,
  normalizeLineKey,
  selectAreaRepsFromSeats,
  type AreaRepSeatRow,
} from "../src/lib/employees/area-rep-resolver.ts";
import type { DirectOrderApprovalDetail, DirectOrderRequest } from "../src/lib/direct-orders/types.ts";

function request(overrides: Partial<DirectOrderRequest> = {}): DirectOrderRequest {
  return {
    id: "req-1",
    requesterHrId: "HR-100",
    requesterRole: "District Manager",
    status: "pending_approval",
    line: "CNS",
    productCode: "CN001",
    productName: "Roya",
    factoryPriceSnapshot: 90,
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

function detail(overrides: Partial<DirectOrderApprovalDetail> = {}): DirectOrderApprovalDetail {
  return {
    request: request(),
    requesterName: "Mahmoud Adel",
    pharmacy: {
      id: "ph-1",
      phoenixPharmacyCode: "DOP-000123",
      pharmacyName: "El Ezaby",
      brickId: "BR-01",
      areaCode: "CA-07",
      regionCode: "RG-1",
      doctorName: "Dr Nour",
      pharmacyAddress: "12 El Merghany Street, Heliopolis, Cairo",
      distributorCodes: [],
      geoVarianceResolved: false,
      createdByHrId: "HR-100",
      active: true,
    },
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
    canSetSalesMonth: false,
    steps: [],
    availableActions: { approve: true, reject: true, return: true },
    bonusOverCap: false,
    missingPharmacyPrice: false,
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

    assert.equal(valueOf("Pharmacy"), "El Ezaby (DOP-000123)");
    assert.equal(valueOf("Doctor"), "Dr Nour");
    assert.equal(valueOf("Medical rep"), "Sara Hassan");

    // Owner rule: never skip a detail. The company's own codes get their OWN labelled fields
    // rather than living only inside a parenthesis on another field's value.
    assert.equal(valueOf("Sato pharmacy code"), "DOP-000123");
    assert.equal(valueOf("Sato product code"), "CN001");
    assert.equal(valueOf("Deal type"), "Bonus");
    assert.equal(valueOf("Pharmacy registered by"), "HR-100");
    assert.equal(valueOf("Pharmacy status"), "Active");

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
    assert.doesNotMatch(valueOf("Medical rep"), /\bHR[-_]?\d/i, "a rep's HR_ID must never leak to the approver");

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
    assert.equal(fields.find((field) => field.label === "Pharmacy address")?.layout, "full");
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
    // A bonus deal that fell back must say so where the approver reads the price.
    const fields = buildDirectOrderDetailFields(
      detail({ request: request({ pharmacyPriceSnapshot: null }), missingPharmacyPrice: true }),
    );
    const value = fields.find((field) => field.label === "Pharmacy price")?.value ?? "";
    assert.match(value, /not set/i, "a fallback-priced bonus order must show that no pharmacy price was set");
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
      "../src/components/employee-portal/direct-order-portal-detail.tsx",
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
    assert.match(
      serviceSource,
      /DIRECT_ORDER_SALES_MONTH_SETTER_HR_ID = "B-185"/,
      "the setter is Ahmed El Maraghy by HR_ID — not the Finance Manager ROLE, so a future second holder cannot inherit it silently",
    );

    // Changing the month must rebuild BOTH periods, or the sales double or vanish.
    const setterIdx = serviceSource.indexOf("export async function setDirectOrderSalesMonth(");
    const setterBody = serviceSource.slice(setterIdx, setterIdx + 3200);
    assert.match(
      setterBody,
      /\[previousMonth, nextMonth\]/,
      "a month change must rebuild the OLD period as well as the new one",
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
    const detailIdx = serviceSource.indexOf("export async function getDirectOrderApprovalDetail(");
    const detailBody = serviceSource.slice(detailIdx, detailIdx + 3000);
    assert.match(detailBody, /retailHistory: retail\.rows/, "retail rides its own field");
    assert.match(detailBody, /pharmacyHistory,/, "direct-order history keeps its own field");
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

    // The email metrics table carries the full distributor→customer-code pairs the one-liner drops.
    const metrics = buildDirectOrderNotificationMetrics(ctx);
    const metricValue = (label: string) => metrics.find((metric) => metric.label === label)?.value ?? "";
    assert.equal(metricValue("Distributor codes"), "Ibn Sina: 1234567; Overseas: 7654321");
    assert.equal(metricValue("Pharmacy"), "El Ezaby (DOP-000123)");
    assert.equal(metricValue("Medical rep"), "Sara Hassan");
    assert.equal(metricValue("Area"), "Cairo East (CA-07)");
  }

  // ── Regression locks on the surfaces that had the bug ───────────────────────
  {
    const adminDetail = readFileSync(
      new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url),
      "utf8",
    );
    const portalDetail = readFileSync(
      new URL("../src/components/employee-portal/direct-order-portal-detail.tsx", import.meta.url),
      "utf8",
    );

    // The exact bug: both screens printed `${pharmacy.brickId} / ${pharmacy.areaCode}`.
    // `\.?\.?` also catches the optional-chained `pharmacy?.brickId` form — without it a
    // reintroduced raw-code field slips straight past this lock (confirmed by mutation).
    for (const [name, source] of [["admin", adminDetail], ["portal", portalDetail]] as const) {
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
    const portalList = readFileSync(
      new URL("../src/components/employee-portal/direct-order-portal-approvals.tsx", import.meta.url),
      "utf8",
    );
    assert.match(portalList, /row\.pharmacyCode/, "the portal approvals card must show the pharmacy code");
    assert.match(portalList, /row\.medicalRepName/, "the portal approvals list must show the medical rep");
  }
  {
    const serviceSource = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    // Enrichment happens at the single read choke point, not in a component.
    const detailIdx = serviceSource.indexOf("export async function getDirectOrderApprovalDetail(");
    const detailBody = serviceSource.slice(detailIdx, detailIdx + 2200);
    assert.match(detailBody, /loadDirectOrderGeoNames\(/, "the detail payload must resolve geography names");
    assert.match(detailBody, /resolveAreaRep\(/, "the detail payload must resolve the area's medical rep");
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
      "../src/components/employee-portal/direct-order-portal-submit.tsx",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.match(source, /selectedBrick\.areaName/, `${path} must label the picked brick's area by NAME`);
      assert.match(source, /selectedBrick\.regionName/, `${path} must label the picked brick's region by NAME`);
    }
  }
}
