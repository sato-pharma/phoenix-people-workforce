import assert from "node:assert/strict";

import type { Hub, HubAssembly, LinkedPharmacy, MatchItem, SalesPair } from "../src/lib/customer-360/hub.ts";
import {
  buildHubViews,
  buildMatchItemViews,
  candidateSalesKey,
  hubsWithMaskedCodes,
  summarizeDirectOrders,
  verdictMonths,
  withoutMaskedPharmacies,
  type ClosedMonths,
  type ClosingSalesRow,
  type RoiContext,
} from "../src/lib/customer-360/report.ts";
import type { VerdictResult } from "../src/lib/customer-360/verdict.ts";

/**
 * The per-viewer step of Customer 360 (owner, 2026-10-18): the verdict judges only months closed for
 * every line, direct orders count in closed months on the three lines, an EP-PHS code is never read
 * without its brick, and El Qema leaves the detail while the verdict stays the same for every viewer.
 */

const HISTORY = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];

/** September is published for CNS only — the closing is still in progress for the other two lines. */
const MONTHS: ClosedMonths = {
  all: [...HISTORY, "2026-07", "2026-08", "2026-09"],
  history: HISTORY,
  published: { anti_infective: ["2026-07", "2026-08"], cns: ["2026-07", "2026-08", "2026-09"], pedia: ["2026-07", "2026-08"] },
};

const ROI: RoiContext = {
  isCommitted: (status) => status === "approved",
  roiResult: () => "behind",
  roiWindow: () => ({ endPeriod: "2026-08", label: "August 2026 to August 2026" }),
  salesDataAsOf: "2026-09",
};

function pharmacy(key: string, pairs: SalesPair[], overrides: Partial<LinkedPharmacy> = {}): LinkedPharmacy {
  return {
    address: null,
    areaName: null,
    brickId: "B1",
    brickName: "Dokki",
    directOrderPharmacyId: null,
    key,
    marketingPharmacyId: null,
    matchStatus: null,
    name: `Pharmacy ${key}`,
    namedByLines: [],
    pairs,
    sources: ["marketing_link"],
    typedAs: [],
    ...overrides,
  };
}

function hub(overrides: Partial<Hub> = {}): Hub {
  return {
    contactCrmId: 555,
    directOrders: { entries: [], venues: 0 },
    dropped: false,
    grade: "A",
    id: "pm_555",
    kind: "doctor",
    linesVisiting: [],
    marketingCustomerIds: ["mc-1"],
    name: "Dr Ahmed Samir",
    notLinked: [],
    pharmacies: [],
    phoenixCustomerIds: ["pc-1"],
    place: null,
    requests: [],
    speciality: "Pediatrics",
    validatedOnLines: ["cns"],
    visits: [],
    ...overrides,
  };
}

function row(overrides: Partial<ClosingSalesRow>): ClosingSalesRow {
  return { brickId: null, clientCode: "1001", clientName: "El Nour", distributorCode: "IS", line: "pedia", period: "2026-04", value: 1000, ...overrides };
}

const IS_1001: SalesPair = { brickId: null, customerCode: "1001", distributorCode: "IS" };

const request = {
  actualRoi: 0,
  code: "MR-0009",
  cost: 10_000,
  id: "r-9",
  marketingCustomerName: "Clinic of Dr Ahmed",
  payDate: "2026-07-10",
  requiredRoi: 100_000,
  roiDurationMonths: 1,
  salesRows: 0,
  status: "approved",
  targetKeys: ["mp:1"],
  typeName: "Sponsorship",
};

function assembly(hubs: Hub[], matchItems: MatchItem[] = []): HubAssembly {
  return { hubs, matchItems };
}

export function runCustomer360ReportTests() {
  // ── 1. The verdict judges only months closed for every line ───────────────────────────────────
  assert.deepEqual(verdictMonths(MONTHS), [...HISTORY, "2026-07", "2026-08"], "a month published for one line only is not judged yet");

  // Pedia sold 1,000 a month before a July request and 1,100 in August; September is not closed for
  // Pedia. Judging September as a zero would read a closing in progress as a fall and blacklist him.
  const growing = hub({
    pharmacies: [pharmacy("mp:1", [IS_1001])],
    requests: [request],
  });
  const pediaRows = [
    row({ period: "2026-04" }),
    row({ period: "2026-05" }),
    row({ period: "2026-06" }),
    row({ period: "2026-08", value: 1100 }),
  ];
  const [judged] = buildHubViews({ assembly: assembly([growing]), moneyVisible: true, months: MONTHS, roi: ROI, salesRows: pediaRows });
  assert.equal(judged.verdict.verdict, "whitelist", "growth over the months closed for every line whitelists");
  assert.equal(judged.verdict.early, true, "and one such month after the request is said to be early");

  // ── 2. Direct orders: closed months, three lines ──────────────────────────────────────────────
  const orders = summarizeDirectOrders(
    {
      entries: [
        { line: "cns", month: "2026-08", value: 1500 },
        { line: "pedia", month: "2026-09", value: 700 },
        { line: "cns", month: "2026-10", value: 300 },
        { line: "cns", month: null, value: 50 },
      ],
      venues: 2,
    },
    MONTHS,
  );
  assert.deepEqual(orders, { byMonth: { "2026-08": 1500 }, orders: 1, value: 1500, venues: 2 }, "an order counts only in a month closed for its own line");
  const [withOrders] = buildHubViews({
    assembly: assembly([hub({ directOrders: { entries: [{ line: "cns", month: "2026-09", value: 400 }], venues: 1 } })]),
    moneyVisible: true,
    months: MONTHS,
    roi: ROI,
    salesRows: [],
  });
  assert.deepEqual(withOrders.directOrders, { byMonth: { "2026-09": 400 }, orders: 1, value: 400, venues: 1 }, "the page and the file read the gated figures");

  // ── 3. An EP-PHS code is never read without its brick ─────────────────────────────────────────
  const sharedRows = [
    row({ brickId: "B1", clientCode: "50", distributorCode: "EP-PHS", line: "cns", period: "2026-08", value: 200 }),
    row({ brickId: "B2", clientCode: "50", distributorCode: "EP-PHS", line: "cns", period: "2026-08", value: 9000 }),
  ];
  const [noBrick] = buildHubViews({
    assembly: assembly([hub({ pharmacies: [pharmacy("mp:2", [{ brickId: null, customerCode: "50", distributorCode: "EP-PHS" }])] })]),
    moneyVisible: true,
    months: MONTHS,
    roi: ROI,
    salesRows: sharedRows,
  });
  assert.equal(noBrick.salesTotal, 0, "an EP-PHS code with no brick would sum every shop that carries it, so it is not read");
  const [withBrick] = buildHubViews({
    assembly: assembly([hub({ pharmacies: [pharmacy("mp:2", [{ brickId: "B1", customerCode: "50", distributorCode: "EP-PHS" }])] })]),
    moneyVisible: true,
    months: MONTHS,
    roi: ROI,
    salesRows: sharedRows,
  });
  assert.equal(withBrick.salesTotal, 200, "with its brick, only that shop's sales are read");

  const item: MatchItem = {
    areaName: "Giza 3",
    brickId: "B1",
    brickName: "Dokki",
    key: "B1|nour",
    nameKey: "nour",
    result: {
      candidates: [
        { address: null, areaCode: "GZ3", brickId: "B1", customerCode: "50", customerName: "El Nour", distributorCode: "EP-PHS", why: "same_name_same_brick" },
        { address: null, areaCode: "GZ3", brickId: null, customerCode: "77", customerName: "El Nour", distributorCode: "EP-PHS", why: "near_name_same_brick" },
      ],
      decision: null,
      pairs: [],
      reason: "near_name_only",
      status: "waiting",
    },
    sightings: [],
    typedAs: ["النور"],
  };
  const [matchView] = buildMatchItemViews({
    items: [item],
    months: MONTHS,
    salesRows: [...sharedRows, row({ brickId: "B4", clientCode: "77", distributorCode: "EP-PHS", line: "cns", period: "2026-08", value: 5000 })],
  });
  assert.equal(matchView.candidateSales[candidateSalesKey("EP-PHS", "50")], 200, "a confirm-tab candidate is read on its own brick");
  assert.equal(candidateSalesKey("EP-PHS", "77") in matchView.candidateSales, false, "and a candidate with no brick shows no borrowed figure at all");

  // ── 4. El Qema leaves the detail; the verdict is the same for every viewer ────────────────────
  const visibleCode = (code: string) => code.trim().toUpperCase() !== "QM";
  const mixed = hub({
    pharmacies: [
      pharmacy("mp:1", [IS_1001]),
      pharmacy("nv:qm-only", [{ brickId: null, customerCode: "9", distributorCode: "QM" }], { name: "El Qema's own name for the shop", sources: ["named_on_visit"] }),
      pharmacy("mp:3", [{ brickId: null, customerCode: "8", distributorCode: "qm" }, { brickId: null, customerCode: "3003", distributorCode: "UCP" }]),
      pharmacy("mp:4", []),
    ],
    requests: [request],
  });
  const masked = withoutMaskedPharmacies(assembly([mixed]), visibleCode);
  const maskedHub = masked.hubs[0];
  assert.deepEqual(maskedHub.pharmacies.map((one) => one.key), ["mp:1", "mp:3", "mp:4"], "a shop known only by an El Qema code leaves the page, name and all");
  assert.deepEqual(
    maskedHub.pharmacies.find((one) => one.key === "mp:3")?.pairs.map((pair) => pair.distributorCode),
    ["UCP"],
    "a shop with other codes stays, without the El Qema one",
  );
  assert.ok(maskedHub.pharmacies.some((one) => one.key === "mp:4"), "a shop that never had a code is not taken for a masked one");
  assert.deepEqual([...hubsWithMaskedCodes(assembly([mixed]), visibleCode)], ["pm_555"], "the hubs whose verdict leans on hidden rows are known");

  const realVerdict: VerdictResult = {
    early: false,
    reasons: ["Request MR-0009 (paid July 2026): its pharmacies sold 1,400 EGP a month after against 1,000 EGP before.", "Visited by CNS in August 2026."],
    requests: [],
    verdict: "watch",
    visits: null,
  };
  const [viewerCopy] = buildHubViews({
    assembly: masked,
    hideVerdictAmounts: new Set(["pm_555"]),
    moneyVisible: true,
    months: MONTHS,
    roi: ROI,
    salesRows: pediaRows,
    verdicts: new Map([["pm_555", realVerdict]]),
  });
  assert.equal(viewerCopy.verdict.verdict, "watch", "the verdict decided on the real rows is the one every viewer reads, never re-decided on what is left");
  assert.deepEqual(viewerCopy.verdict.reasons, ["Visited by CNS in August 2026."], "and no amount that would size the hidden rows reaches the reasons");
  assert.equal("nv:qm-only" in viewerCopy.pharmacySales, false, "the dropped shop has no sales entry either");
  const [ownerCopy] = buildHubViews({
    assembly: assembly([mixed]),
    moneyVisible: true,
    months: MONTHS,
    roi: ROI,
    salesRows: pediaRows,
    verdicts: new Map([["pm_555", realVerdict]]),
  });
  assert.equal(ownerCopy.verdict.reasons.length, 2, "a viewer who may see El Qema reads every reason");
}
