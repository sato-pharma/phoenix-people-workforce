import assert from "node:assert/strict";

import {
  assembleHubs,
  pairCanBeRead,
  pairsNeedingSales,
  parseHubId,
  type Customer360Sources,
  type SourceMarketingCustomer,
  type SourceMarketingPharmacy,
  type SourcePhoenixCustomer,
} from "../src/lib/customer-360/hub.ts";
import { pharmacyNameKey } from "../src/lib/phoenix-crm/pharmacy-call-rules.ts";
import type { NamedPharmacyOnVisit } from "../src/lib/phoenix-crm/server/named-pharmacies.ts";

/**
 * One hub per validated doctor or account, and everything tied to it (owner, 2026-10-18). PM and AM
 * never mix; a marketing customer joins a Phoenix CRM hub only by its CRM code or a confirmed link;
 * the four pharmacy sources fold into one row per shop, and EP-PHS never proves a shop.
 */

function phoenix(overrides: Partial<SourcePhoenixCustomer> = {}): SourcePhoenixCustomer {
  return {
    grade: "A",
    id: "pc-1",
    is_test: false,
    line_code: "cns",
    list_type: "PM",
    name: "Dr Ahmed Samir",
    own_contact_crm_id: null,
    place: null,
    reference_contact_crm_id: 555,
    seat_id: "seat-1",
    speciality: "Pediatrics",
    status: "active",
    status_changed_at: null,
    validated_at: "2026-10-05T09:00:00Z",
    ...overrides,
  };
}

function marketingCustomer(overrides: Partial<SourceMarketingCustomer> = {}): SourceMarketingCustomer {
  return {
    active: true,
    captured_address: null,
    captured_latitude: null,
    captured_longitude: null,
    crmCodes: [],
    customer_type: "clinic",
    display_name: "Clinic of Dr Ahmed",
    extracted_area_name: null,
    id: "mc-1",
    merged_into_customer_id: null,
    region_name: null,
    validation_status: "system_validated",
    ...overrides,
  };
}

function pharmacy(id: string, pairs: Array<[string, string, string]>): SourceMarketingPharmacy {
  return {
    address: "1 Pyramids St",
    areaName: "Giza 3",
    codes: pairs.map(([codeId, distributorCode, customerCode]) => ({ areaCode: "GZ3", codeId, pair: { brickId: "B1", customerCode, distributorCode } })),
    id,
    lat: null,
    lon: null,
    name: `Pharmacy ${id}`,
    regionName: "Giza",
  };
}

function sources(overrides: Partial<Customer360Sources> = {}): Customer360Sources {
  return {
    areaNames: new Map(),
    areaShops: new Map(),
    brickAreas: new Map(),
    brickNames: new Map([["B1", "Dokki"]]),
    brickShops: new Map(),
    canonicalHrId: (hrId) => (hrId ? hrId.trim().toUpperCase() : null),
    decisions: new Map(),
    directOrders: [],
    directVenues: [],
    identityLinks: [],
    marketingCustomers: [],
    marketingLinks: [],
    marketingPharmacies: new Map(),
    named: [],
    phoenix: [],
    repLines: new Map(),
    repNames: new Map(),
    requests: [],
    visitMonths: new Map(),
    ...overrides,
  };
}

function sighting(overrides: Partial<NamedPharmacyOnVisit> = {}): NamedPharmacyOnVisit {
  return {
    address: "Clinic, Tahrir St",
    areaCode: "GZ3",
    areaName: "Giza 3",
    brickId: "B1",
    brickName: "Dokki",
    customerId: "pc-1",
    lat: 30.03,
    lineCode: null,
    lon: 31.21,
    nameKey: pharmacyNameKey("صيدلية النور"),
    placeId: "place-1",
    regionName: "Giza",
    repHrId: "b-7",
    typed: "صيدلية النور",
    visitDate: "2026-10-12",
    visitId: "v-1",
    ...overrides,
  };
}

export function runCustomer360HubTests() {
  // ── Who is a hub ──────────────────────────────────────────────────────────────────────────────
  const people = assembleHubs(
    sources({
      phoenix: [
        phoenix(),
        phoenix({ id: "pc-2", line_code: "pedia", seat_id: "seat-2" }),
        phoenix({ id: "pc-3", list_type: "AM", name: "Dar El Fouad Hospital" }),
        phoenix({ id: "pc-4", reference_contact_crm_id: 600, validated_at: null }),
        phoenix({ id: "pc-5", reference_contact_crm_id: 700, status: "dropped" }),
        phoenix({ id: "pc-6", line_code: "Anti-Infective", reference_contact_crm_id: 800, status: "dropped" }),
        phoenix({ id: "pc-7", line_code: "anti infective", reference_contact_crm_id: 800 }),
      ],
    }),
  );
  const byId = new Map(people.hubs.map((hub) => [hub.id, hub]));
  const ahmed = byId.get("pm_555");
  assert.ok(ahmed, "a validated PM doctor is a hub keyed by his contact id");
  assert.deepEqual(ahmed.phoenixCustomerIds.sort(), ["pc-1", "pc-2"], "two lines' seats on one contact are ONE hub");
  assert.deepEqual(ahmed.validatedOnLines, ["cns", "pedia"], "and it says which lines hold him validated");
  assert.equal(byId.get("am_555")?.kind, "account", "the same contact validated as an account is a separate hub — PM and AM never mix");
  assert.equal(byId.has("pm_600"), false, "a customer still pending validation is not in the report");
  assert.equal(byId.get("pm_700")?.dropped, true, "a dropped customer stays, said as dropped");
  assert.equal(byId.get("pm_800")?.dropped, false, "validated active on one list and dropped on another reads as active");
  assert.deepEqual(byId.get("pm_800")?.validatedOnLines, ["anti_infective"], "a line name in any spelling lands on its line code");

  // ── Marketing customers join by fact, never by name ──────────────────────────────────────────
  const joined = assembleHubs(
    sources({
      identityLinks: [
        { masterId: "m-1", source: "marketing_customer", sourceId: "mc-3" },
        { masterId: "m-1", source: "phoenix_crm", sourceId: "pc-1" },
      ],
      marketingCustomers: [
        marketingCustomer({ crmCodes: [" 555 "], id: "mc-1" }),
        marketingCustomer({ crmCodes: ["900"], customer_type: "hospital", display_name: "Nile Hospital", id: "mc-2" }),
        marketingCustomer({ display_name: "Dr Ahmed Samir", id: "mc-3" }),
        marketingCustomer({ display_name: "Dr Ahmed Samir", id: "mc-4" }),
        marketingCustomer({ id: "mc-5", validation_status: "pending" }),
      ],
      phoenix: [phoenix(), phoenix({ id: "pc-9", reference_contact_crm_id: 900 })],
    }),
  );
  const joinedById = new Map(joined.hubs.map((hub) => [hub.id, hub]));
  assert.deepEqual(
    joinedById.get("pm_555")?.marketingCustomerIds.sort(),
    ["mc-1", "mc-3"],
    "a marketing clinic joins the doctor by its CRM code, and another by a link he confirmed",
  );
  assert.ok(joinedById.has("mc_mc-4"), "the same name with no code and no confirmed link stays its own hub");
  const nile = joinedById.get("mc_mc-2");
  assert.ok(nile, "a hospital whose code points at a doctor is never folded into him");
  assert.match(nile.notLinked.map((note) => note.reason).join(" "), /validated as a doctor, not as an account/, "and the page says why");
  assert.equal(joinedById.has("mc_mc-5"), false, "a pending marketing customer is not in the report");

  // ── Linked pharmacies: four sources, one row per shop ─────────────────────────────────────────
  const linked = assembleHubs(
    sources({
      directOrders: [
        { line: "cns", month: "2026-08", pharmacyId: "dv-1", value: 1500 },
        { line: "Pedia", month: "2026-09", pharmacyId: "dv-1", value: 500 },
        { line: "head_office", month: "2026-09", pharmacyId: "dv-1", value: 9000 },
      ],
      directVenues: [
        { active: true, address: "Tahrir", areaCode: "GZ3", brickId: "B1", code: "DR-1", crmContactId: 555, doctorName: null, id: "dv-1", merged_into_pharmacy_id: null, name: "El Nour", pairs: [{ brickId: null, customerCode: "1001", distributorCode: "is" }], trust_state: "trusted" },
        { active: true, address: "Tahrir", areaCode: "GZ3", brickId: "B1", code: "DR-2", crmContactId: 555, doctorName: null, id: "dv-2", merged_into_pharmacy_id: null, name: "On probation", pairs: [{ brickId: null, customerCode: "4004", distributorCode: "IS" }], trust_state: "provisional" },
        { active: true, address: "Tahrir", areaCode: "GZ3", brickId: "B1", code: "DR-3", crmContactId: 555, doctorName: null, id: "dv-3", merged_into_pharmacy_id: null, name: "Shared code", pairs: [{ brickId: "B1", customerCode: "50", distributorCode: "EP-PHS" }], trust_state: "trusted" },
        { active: true, address: "Unknown", areaCode: "GZ3", brickId: null, code: "DR-4", crmContactId: 555, doctorName: null, id: "dv-4", merged_into_pharmacy_id: null, name: "No brick", pairs: [{ brickId: null, customerCode: "60", distributorCode: "EP-PHS" }, { brickId: null, customerCode: "6006", distributorCode: "UCP" }], trust_state: "trusted" },
      ],
      marketingCustomers: [marketingCustomer({ crmCodes: ["555"] })],
      marketingLinks: [
        { customerId: "mc-1", distributorCodeId: null, pharmacyId: "mp-1", status: "system_validated" },
        { customerId: "mc-1", distributorCodeId: null, pharmacyId: "mp-2", status: "pending" },
        { customerId: "mc-1", distributorCodeId: null, pharmacyId: "mp-3", status: "admin_approved" },
      ],
      marketingPharmacies: new Map([
        ["mp-1", pharmacy("mp-1", [["c-1", "IS", "1001"]])],
        ["mp-2", pharmacy("mp-2", [["c-2", "IS", "2002"]])],
        ["mp-3", pharmacy("mp-3", [["c-3", "EP-PHS", "50"]])],
      ]),
      phoenix: [phoenix()],
      requests: [
        {
          actualRoi: 0,
          code: "MR-0007",
          cost: 20_000,
          customerId: "mc-1",
          id: "r-7",
          payDate: "2026-08-20",
          requiredRoi: 200_000,
          roiDurationMonths: 3,
          salesRows: 0,
          status: "approved",
          targets: [{ distributorCodeId: "c-1", pharmacyId: "mp-1" }],
          typeName: "Sponsorship",
        },
      ],
    }),
  );
  const hub = linked.hubs.find((one) => one.id === "pm_555");
  assert.ok(hub);
  const nour = hub.pharmacies.find((row) => row.marketingPharmacyId === "mp-1");
  assert.ok(nour, "a pharmacy on a validated link is tied");
  assert.deepEqual(
    [...nour.sources].sort(),
    ["direct_order", "marketing_link", "request_target"],
    "a marketing link, a request target and a direct-order venue sharing a pair are ONE pharmacy",
  );
  assert.equal(nour.directOrderPharmacyId, "dv-1");
  assert.equal(hub.pharmacies.some((row) => row.marketingPharmacyId === "mp-2"), false, "a link still pending ties nothing");
  assert.equal(hub.pharmacies.some((row) => row.directOrderPharmacyId === "dv-2"), false, "a venue on probation ties nothing");
  const noBrick = hub.pharmacies.find((row) => row.directOrderPharmacyId === "dv-4");
  assert.ok(noBrick, "a venue with no brick is still tied");
  assert.deepEqual(
    noBrick.pairs.map((pair) => pair.distributorCode),
    ["UCP"],
    "but its EP-PHS code, which names every shop carrying it, is never kept to be read",
  );
  const shared = hub.pharmacies.filter((row) => row.pairs.some((pair) => pair.distributorCode === "EP-PHS"));
  assert.equal(shared.length, 2, "EP-PHS reuses codes across shops, so a shared EP-PHS code never merges two rows");
  assert.deepEqual(hub.requests.map((one) => one.targetKeys), [[nour.key]], "the request names the linked pharmacy it targets");
  assert.equal(hub.directOrders.venues, 3, "every trusted venue tied to him is counted");
  assert.deepEqual(
    hub.directOrders.entries,
    [
      { line: "cns", month: "2026-08", value: 1500 },
      { line: "pedia", month: "2026-09", value: 500 },
    ],
    "each approved order keeps its line and Finance's month, and a Head Office order is not kept — the view counts them in closed months",
  );

  // ── Pharmacies named on visits ────────────────────────────────────────────────────────────────
  const named = assembleHubs(
    sources({
      brickShops: new Map([["B1", [{ address: "3 Nile St", areaCode: "GZ3", brickId: "B1", customerCode: "1001", customerName: "صيدلية النور", distributorCode: "IS" }]]]),
      named: [
        sighting(),
        sighting({ typed: "صيدليه النور", visitId: "v-2" }),
        sighting({ brickId: "B9", nameKey: pharmacyNameKey("صيدلية الحياة"), typed: "صيدلية الحياة", visitId: "v-3" }),
        sighting({ customerId: "pc-unknown", visitId: "v-4" }),
      ],
      phoenix: [phoenix()],
      repLines: new Map([["B-7", "cns" as const]]),
      repNames: new Map([["B-7", "Mona Adel"]]),
    }),
  );
  const tied = named.hubs[0]?.pharmacies.find((row) => row.sources.includes("named_on_visit"));
  assert.ok(tied, "the one shop of that name in the doctor's brick is tied to him");
  assert.equal(tied.matchStatus, "auto");
  assert.deepEqual(tied.namedByLines, ["cns"], "and it says which line's rep named it");
  assert.deepEqual(tied.typedAs.sort(), ["صيدلية النور", "صيدليه النور"], "every spelling the reps typed is kept");
  assert.equal(named.matchItems.length, 2, "one item per folded name per brick, however many visits named it");
  const auto = named.matchItems.find((item) => item.result.status === "auto");
  assert.equal(auto?.sightings.length, 2, "both visits are listed on the item");
  assert.equal(auto?.sightings[0]?.repName, "Mona Adel", "a rep is named, never coded");
  assert.equal(
    named.matchItems.some((item) => item.sightings.some((one) => one.hubId === "pc-unknown")),
    false,
    "a visit to a customer who is not validated raises nothing",
  );

  // ── Ids and the pairs that need sales ─────────────────────────────────────────────────────────
  assert.deepEqual(parseHubId("pm_555"), { contactId: 555, kind: "doctor" });
  assert.deepEqual(parseHubId("am_555"), { contactId: 555, kind: "account" });
  assert.deepEqual(parseHubId("mc_abc"), { marketingCustomerId: "abc" });
  assert.equal(parseHubId("../etc"), null, "anything else is refused");
  const pairs = pairsNeedingSales(linked);
  assert.equal(
    pairs.filter((pair) => pair.distributorCode === "IS" && pair.customerCode === "1001").length,
    1,
    "a pair tied through three sources is read once",
  );
  assert.ok(pairs.every((pair) => pair.distributorCode === "EP-PHS" || pair.brickId === null), "only EP-PHS carries its brick to the closing");
  assert.ok(pairs.every((pair) => pair.distributorCode !== "EP-PHS" || pair.brickId !== null), "and no EP-PHS code goes to the closing without one");
  assert.equal(pairCanBeRead({ brickId: null, customerCode: "50", distributorCode: "ep-phs" }), false, "an EP-PHS code with no brick cannot be read");
  assert.equal(pairCanBeRead({ brickId: "B1", customerCode: "50", distributorCode: "EP-PHS" }), true, "with its brick it can");
  assert.equal(pairCanBeRead({ brickId: null, customerCode: "1001", distributorCode: "IS" }), true, "any other distributor's code is proof on its own");
  assert.equal(pairCanBeRead({ brickId: null, customerCode: " ", distributorCode: "IS" }), false, "an empty code is never read");
}
