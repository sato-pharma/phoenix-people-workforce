/**
 * Customer 360 v2 — one HUB per validated doctor or account, and everything tied to it. Pure.
 *
 * The owner's brief (2026-10-18): "link every customer the system has seen — a doctor visited by all
 * three lines, a direct order from one line, a marketing request from another, and the pharmacies tied
 * to him … was there ROI? Which doctors should be whitelist and which blacklist?" — validated customers
 * only (`validated.ts`), doctors first.
 *
 * A hub is keyed by the contact id every system shares:
 *   `pm_<contactId>` — a validated Phoenix CRM PM customer (several seats and lines on one contact
 *                      are ONE hub);
 *   `am_<contactId>` — the same for AM;
 *   `mc_<uuid>`      — a validated marketing customer that joins no Phoenix CRM hub.
 *
 * A marketing customer JOINS a Phoenix hub by (a) the CRM code on one of its contacts, or (b) a link
 * the Super Admin confirmed in Customer Links. It never joins on a name match by itself — that is
 * the identity module's suggestion, confirmed by him (his 2026-09-30 rule). Conflicting evidence
 * leaves it apart, said under "Not linked".
 *
 * PHARMACIES TIED TO A HUB, four sources, one shape:
 *   · marketing link    — the marketing customer→pharmacy link, at a selectable link status;
 *   · request target    — a pharmacy named as a target on one of the hub's marketing requests;
 *   · direct order      — a TRUSTED direct-order venue tied to the hub's contact id;
 *   · named on visit    — a pharmacy a rep typed on a visit to the hub, tied by the matcher.
 * Rows sharing a proving distributor pair are one pharmacy. A distributor whose code is not proof of
 * a shop (EP-PHS) never merges two rows and is matched on its brick too.
 *
 * Everything here is a function of data: the loaders are `server/sources.ts`, and this file decides.
 */

import { DISTRIBUTORS_WHOSE_CODE_IS_NOT_PROOF } from "@/lib/customer-identity/suggestions";
import { parseCrmContactCode } from "@/lib/crm/contact-code";
import type { CrmContactVisitMonth } from "@/lib/crm/reads";
import { visitCountBucket } from "@/lib/crm/visit-count-buckets";
import { classifyVisit } from "@/lib/crm/visit-types";
import type { NamedPharmacyOnVisit } from "@/lib/phoenix-crm/server/named-pharmacies";

import { matchItemKey, matchNamedPharmacy, type MapShopRow, type MatchCandidate, type MatchPair, type MatchResult, type StoredDecision, type WaitReason } from "./pharmacy-matcher";
import {
  isCountedMarketingLinkStatus,
  isDroppedPhoenixRow,
  isTrustedDirectOrderVenue,
  isValidatedMarketingCustomer,
  isValidatedPhoenixHubRow,
  marketingCustomerHubKind,
  phoenixContactId,
  phoenixHubKind,
  type HubKind,
  type MarketingCustomerRow,
  type PhoenixCustomerRow,
} from "./validated";

// ── Lines ───────────────────────────────────────────────────────────────────────────────────────

/** The three tracked lines, by the closing's own line code. Head Office is never one. */
export const HUB_LINES = [
  { code: "cns", label: "CNS", officialLine: "CNS" },
  { code: "pedia", label: "Pedia", officialLine: "Pedia" },
  { code: "anti_infective", label: "Anti Infective", officialLine: "Anti Infective" },
] as const;

export type HubLineCode = (typeof HUB_LINES)[number]["code"];

export function hubLineCode(raw: string | null | undefined): HubLineCode | null {
  const key = String(raw ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (key === "cns") return "cns";
  if (key === "pedia") return "pedia";
  if (key === "anti_infective" || key === "anti_inf" || key === "antiinfective") return "anti_infective";
  return null;
}

export function hubLineLabel(code: HubLineCode | string | null | undefined): string {
  return HUB_LINES.find((line) => line.code === code)?.label ?? String(code ?? "");
}

// ── Inputs (what the loaders hand over) ─────────────────────────────────────────────────────────

export type SourcePlace = {
  address: string | null;
  brickId: string | null;
  brickName: string | null;
  areaCode: string | null;
  areaName: string | null;
  regionName: string | null;
  lat: number | null;
  lon: number | null;
};

export type SourcePhoenixCustomer = PhoenixCustomerRow & {
  name: string | null;
  grade: string | null;
  line_code: string | null;
  seat_id: string | null;
  status_changed_at: string | null;
  place: SourcePlace | null;
};

export type SourceMarketingCustomer = MarketingCustomerRow & {
  display_name: string | null;
  region_name: string | null;
  extracted_area_name: string | null;
  captured_address: string | null;
  captured_latitude: number | null;
  captured_longitude: number | null;
  /** The CRM codes typed on its contacts, raw. */
  crmCodes: string[];
};

export type SalesPair = { distributorCode: string; customerCode: string; brickId: string | null };

export type SourceMarketingPharmacy = {
  id: string;
  name: string;
  regionName: string | null;
  areaName: string | null;
  address: string | null;
  lat: number | null;
  lon: number | null;
  /** Master-resolved pairs, keyed by the code row's id so a link or target naming one code finds it. */
  codes: Array<{ codeId: string; pair: SalesPair; areaCode: string | null }>;
};

export type SourceMarketingLink = { customerId: string; pharmacyId: string; distributorCodeId: string | null; status: string | null };

export type SourceRequest = {
  id: string;
  code: string;
  customerId: string | null;
  status: string;
  payDate: string | null;
  typeName: string | null;
  cost: number;
  requiredRoi: number;
  roiDurationMonths: number;
  targets: Array<{ pharmacyId: string; distributorCodeId: string | null }>;
  /** The Marketing ROI engine's actuals for it (`loadActuals`), restricted products excluded. */
  actualRoi: number;
  salesRows: number;
};

export type SourceDirectVenue = {
  id: string;
  code: string | null;
  name: string;
  brickId: string | null;
  areaCode: string | null;
  address: string | null;
  crmContactId: number | null;
  doctorName: string | null;
  trust_state: string | null;
  active: boolean | null;
  merged_into_pharmacy_id: string | null;
  pairs: SalesPair[];
};

export type SourceDirectOrder = { pharmacyId: string; value: number; month: string | null; line: string | null };

export type SourceIdentityLink = { masterId: string; source: string; sourceId: string };

export type Customer360Sources = {
  phoenix: SourcePhoenixCustomer[];
  marketingCustomers: SourceMarketingCustomer[];
  marketingPharmacies: Map<string, SourceMarketingPharmacy>;
  marketingLinks: SourceMarketingLink[];
  requests: SourceRequest[];
  directVenues: SourceDirectVenue[];
  directOrders: SourceDirectOrder[];
  identityLinks: SourceIdentityLink[];
  named: NamedPharmacyOnVisit[];
  decisions: Map<string, StoredDecision>;
  /** Active closing-map shops of each brick a name was typed in. */
  brickShops: Map<string, MapShopRow[]>;
  /** Active closing-map shops of each area such a brick sits in. */
  areaShops: Map<string, MapShopRow[]>;
  brickNames: Map<string, string>;
  brickAreas: Map<string, string>;
  areaNames: Map<string, string>;
  visitMonths: Map<number, CrmContactVisitMonth[]>;
  /** A rep's line code, by canonical HR id. */
  repLines: Map<string, HubLineCode>;
  /** A rep's name, by canonical HR id. */
  repNames: Map<string, string>;
  canonicalHrId: (hrId: string | null | undefined) => string | null;
};

// ── Outputs ─────────────────────────────────────────────────────────────────────────────────────

export type LinkedPharmacySource = "marketing_link" | "request_target" | "direct_order" | "named_on_visit";

export const LINKED_PHARMACY_SOURCE_LABELS: Record<LinkedPharmacySource, string> = {
  direct_order: "Direct order",
  marketing_link: "Marketing link",
  named_on_visit: "Named on a visit",
  request_target: "Request target",
};

export type LinkedPharmacy = {
  key: string;
  name: string;
  brickId: string | null;
  brickName: string | null;
  areaName: string | null;
  address: string | null;
  sources: LinkedPharmacySource[];
  pairs: SalesPair[];
  /** For a pharmacy named on a visit: how it was tied. */
  matchStatus: "auto" | "confirmed" | null;
  /** The spellings reps typed, for a pharmacy named on a visit. */
  typedAs: string[];
  /** Lines whose reps named it, for a pharmacy named on a visit. */
  namedByLines: HubLineCode[];
  marketingPharmacyId: string | null;
  directOrderPharmacyId: string | null;
};

export type HubVisitRow = {
  month: string;
  line: HubLineCode | null;
  repName: string;
  source: "phoenix" | "ireports360";
  am: number;
  pm: number;
  pharmacies: number;
  regular: number;
  campaign: number;
};

export type HubRequest = {
  id: string;
  code: string;
  status: string;
  typeName: string | null;
  payDate: string | null;
  cost: number;
  requiredRoi: number;
  actualRoi: number;
  salesRows: number;
  roiDurationMonths: number;
  /** Keys of the hub's linked pharmacies this request targets. */
  targetKeys: string[];
  marketingCustomerName: string;
};

/** One approved order on a trusted venue tied to the hub. Head Office orders are never kept. */
export type HubDirectOrderEntry = { line: HubLineCode; month: string | null; value: number };

/**
 * The trusted venues tied to a hub and their approved orders on the three lines. The order count, the
 * value and the months are counted per view (`report.ts`), through each line's closed months — the
 * same months every other figure on the page reads.
 */
export type HubDirectOrders = {
  venues: number;
  entries: HubDirectOrderEntry[];
};

export type NotLinkedNote = { reason: string };

export type Hub = {
  id: string;
  kind: HubKind;
  name: string;
  speciality: string | null;
  grade: string | null;
  contactCrmId: number | null;
  phoenixCustomerIds: string[];
  marketingCustomerIds: string[];
  /** Lines whose Phoenix CRM lists hold this customer validated. */
  validatedOnLines: HubLineCode[];
  dropped: boolean;
  place: SourcePlace | null;
  visits: HubVisitRow[];
  linesVisiting: HubLineCode[];
  pharmacies: LinkedPharmacy[];
  requests: HubRequest[];
  directOrders: HubDirectOrders;
  notLinked: NotLinkedNote[];
};

/** One item on the confirm tab: a folded name in a brick, and the visits that named it. */
export type MatchItem = {
  key: string;
  nameKey: string;
  brickId: string | null;
  brickName: string | null;
  areaName: string | null;
  typedAs: string[];
  result: MatchResult;
  /** Who named it, from where. */
  sightings: Array<{
    hubId: string;
    hubName: string;
    hubKind: HubKind;
    visitDate: string;
    repName: string;
    line: HubLineCode | null;
    typed: string;
    placeAddress: string | null;
    lat: number | null;
    lon: number | null;
  }>;
};

export type HubAssembly = { hubs: Hub[]; matchItems: MatchItem[] };

// ── Assembly ────────────────────────────────────────────────────────────────────────────────────

const pairKey = (pair: SalesPair): string => `${pair.distributorCode.trim().toUpperCase()}|${pair.customerCode.trim()}`;

function isProvingPair(pair: SalesPair): boolean {
  return !DISTRIBUTORS_WHOSE_CODE_IS_NOT_PROOF.has(pair.distributorCode.trim().toUpperCase());
}

/**
 * A sales pair as the closing wrapper takes it: codes trimmed, distributor upper-cased, and the brick
 * kept only where the code alone is not proof (EP-PHS reuses one code across shops).
 */
export function normalisePair(pair: SalesPair): SalesPair {
  const distributorCode = pair.distributorCode.trim().toUpperCase();
  return {
    brickId: DISTRIBUTORS_WHOSE_CODE_IS_NOT_PROOF.has(distributorCode) ? pair.brickId : null,
    customerCode: pair.customerCode.trim(),
    distributorCode,
  };
}

/**
 * May the closing be asked about this pair? 🔴 AN EP-PHS CODE WITH NO BRICK IS NEVER READ: EP-PHS reuses
 * one code across shops, so without its brick the closing would hand back every shop that carries the
 * code and credit their sales to this one.
 */
export function pairCanBeRead(pair: SalesPair): boolean {
  const normal = normalisePair(pair);
  if (!normal.distributorCode || !normal.customerCode) return false;
  return isProvingPair(normal) || Boolean(normal.brickId);
}

function hubIdFor(kind: HubKind, contactId: number): string {
  return `${kind === "doctor" ? "pm" : "am"}_${contactId}`;
}

/** The kind and contact id a hub key names, or null for a marketing-only hub. */
export function parseHubId(id: string): { kind: HubKind; contactId: number } | { marketingCustomerId: string } | null {
  const match = /^(pm|am|mc)_(.+)$/.exec(id);
  if (!match) return null;
  if (match[1] === "mc") return { marketingCustomerId: match[2] };
  const contactId = Number(match[2]);
  if (!Number.isFinite(contactId)) return null;
  return { contactId, kind: match[1] === "pm" ? "doctor" : "account" };
}

class PharmacyBag {
  private readonly rows: LinkedPharmacy[] = [];
  private readonly byPair = new Map<string, LinkedPharmacy>();
  private readonly byKey = new Map<string, LinkedPharmacy>();

  add(entry: Omit<LinkedPharmacy, "sources" | "typedAs" | "namedByLines"> & { source: LinkedPharmacySource; typedAs?: string[]; namedByLines?: HubLineCode[] }): LinkedPharmacy {
    const pairs = entry.pairs.map(normalisePair).filter(pairCanBeRead);
    let found = this.byKey.get(entry.key) ?? null;
    if (!found) {
      for (const pair of pairs) {
        if (!isProvingPair(pair)) continue;
        const hit = this.byPair.get(pairKey(pair));
        if (hit) {
          found = hit;
          break;
        }
      }
    }
    if (!found) {
      found = {
        address: entry.address,
        areaName: entry.areaName,
        brickId: entry.brickId,
        brickName: entry.brickName,
        directOrderPharmacyId: entry.directOrderPharmacyId,
        key: entry.key,
        marketingPharmacyId: entry.marketingPharmacyId,
        matchStatus: entry.matchStatus,
        name: entry.name,
        namedByLines: [],
        pairs: [],
        sources: [],
        typedAs: [],
      };
      this.rows.push(found);
    }
    this.byKey.set(entry.key, found);
    if (!found.sources.includes(entry.source)) found.sources.push(entry.source);
    found.address ??= entry.address;
    found.areaName ??= entry.areaName;
    found.brickId ??= entry.brickId;
    found.brickName ??= entry.brickName;
    found.marketingPharmacyId ??= entry.marketingPharmacyId;
    found.directOrderPharmacyId ??= entry.directOrderPharmacyId;
    if (entry.matchStatus && !found.matchStatus) found.matchStatus = entry.matchStatus;
    for (const typed of entry.typedAs ?? []) if (!found.typedAs.includes(typed)) found.typedAs.push(typed);
    for (const line of entry.namedByLines ?? []) if (!found.namedByLines.includes(line)) found.namedByLines.push(line);
    for (const pair of pairs) {
      const key = pairKey(pair);
      if (found.pairs.some((existing) => pairKey(existing) === key)) continue;
      found.pairs.push(pair);
      if (isProvingPair(pair)) this.byPair.set(key, found);
    }
    return found;
  }

  list(): LinkedPharmacy[] {
    return this.rows;
  }

  keyOf(key: string): string | null {
    return this.byKey.get(key)?.key ?? null;
  }
}

type HubDraft = Hub & { bag: PharmacyBag };

function emptyDirectOrders(): HubDirectOrders {
  return { entries: [], venues: 0 };
}

function newDraft(id: string, kind: HubKind, name: string): HubDraft {
  return {
    bag: new PharmacyBag(),
    contactCrmId: null,
    directOrders: emptyDirectOrders(),
    dropped: false,
    grade: null,
    id,
    kind,
    linesVisiting: [],
    marketingCustomerIds: [],
    name,
    notLinked: [],
    pharmacies: [],
    phoenixCustomerIds: [],
    place: null,
    requests: [],
    speciality: null,
    validatedOnLines: [],
    visits: [],
  };
}

/** Build every hub from the loaded sources. */
export function assembleHubs(sources: Customer360Sources): HubAssembly {
  const hubs = new Map<string, HubDraft>();
  const hubByPhoenixCustomer = new Map<string, HubDraft>();

  // 1. Validated Phoenix CRM customers, one hub per contact and kind.
  const phoenixRows = sources.phoenix.filter(isValidatedPhoenixHubRow);
  // Active rows first, so a contact validated on one list and dropped on another reads as active.
  phoenixRows.sort((a, b) => Number(isDroppedPhoenixRow(a)) - Number(isDroppedPhoenixRow(b)));
  for (const row of phoenixRows) {
    const kind = phoenixHubKind(row.list_type);
    const contactId = phoenixContactId(row);
    if (!kind || contactId == null) continue;
    const id = hubIdFor(kind, contactId);
    let hub = hubs.get(id);
    if (!hub) {
      hub = newDraft(id, kind, String(row.name ?? "").trim() || "Unnamed customer");
      hub.contactCrmId = contactId;
      hub.dropped = true;
      hubs.set(id, hub);
    }
    hub.phoenixCustomerIds.push(row.id);
    if (!isDroppedPhoenixRow(row)) hub.dropped = false;
    hub.speciality ??= row.speciality;
    hub.grade ??= row.grade;
    hub.place ??= row.place;
    const line = hubLineCode(row.line_code);
    if (line && !hub.validatedOnLines.includes(line)) hub.validatedOnLines.push(line);
    hubByPhoenixCustomer.set(row.id, hub);
  }

  // 2. Marketing customers — join a Phoenix hub by a CRM code fact or a confirmed link, else stand alone.
  const masterBySource = new Map<string, string>();
  const linksByMaster = new Map<string, SourceIdentityLink[]>();
  for (const link of sources.identityLinks) {
    masterBySource.set(`${link.source}:${link.sourceId}`, link.masterId);
    const list = linksByMaster.get(link.masterId) ?? [];
    list.push(link);
    linksByMaster.set(link.masterId, list);
  }
  const hubByMarketingCustomer = new Map<string, HubDraft>();
  for (const customer of sources.marketingCustomers) {
    if (!isValidatedMarketingCustomer(customer)) continue;
    const kind = marketingCustomerHubKind(customer.customer_type);
    const name = String(customer.display_name ?? "").trim() || "Unnamed customer";
    const candidates = new Set<string>();
    const conflicts: string[] = [];

    for (const raw of customer.crmCodes) {
      const contactId = parseCrmContactCode(raw);
      if (contactId == null) continue;
      const sameKind = hubs.get(hubIdFor(kind, contactId));
      const otherKind = hubs.get(hubIdFor(kind === "doctor" ? "account" : "doctor", contactId));
      if (sameKind) candidates.add(sameKind.id);
      else if (otherKind) conflicts.push(`Its CRM code points at ${otherKind.name}, who is validated as ${otherKind.kind === "doctor" ? "a doctor" : "an account"}, not as ${kind === "doctor" ? "a doctor" : "an account"}.`);
    }
    const master = masterBySource.get(`marketing_customer:${customer.id}`);
    if (master) {
      for (const link of linksByMaster.get(master) ?? []) {
        if (link.source === "phoenix_crm") {
          const hub = hubByPhoenixCustomer.get(link.sourceId);
          if (hub && hub.kind === kind) candidates.add(hub.id);
        } else if (link.source === "ireports360") {
          const contactId = Number(link.sourceId);
          const hub = Number.isFinite(contactId) ? hubs.get(hubIdFor(kind, contactId)) : undefined;
          if (hub) candidates.add(hub.id);
        }
      }
    }

    let hub: HubDraft;
    if (candidates.size === 1) {
      hub = hubs.get([...candidates][0]) as HubDraft;
    } else {
      hub = newDraft(`mc_${customer.id}`, kind, name);
      hubs.set(hub.id, hub);
      hub.place = {
        address: customer.captured_address,
        areaCode: null,
        areaName: customer.extracted_area_name,
        brickId: null,
        brickName: null,
        lat: customer.captured_latitude,
        lon: customer.captured_longitude,
        regionName: customer.region_name,
      };
      // Its own CRM code still says which vendor contact it is, when exactly one code names a contact
      // no validated hub holds: the visits that contact received are this customer's history.
      const ownCodes = [...new Set(customer.crmCodes.map(parseCrmContactCode).filter((id): id is number => id != null))];
      if (candidates.size === 0 && conflicts.length === 0 && ownCodes.length === 1) {
        const contactId = ownCodes[0];
        if (!hubs.has(hubIdFor("doctor", contactId)) && !hubs.has(hubIdFor("account", contactId))) hub.contactCrmId = contactId;
      }
      if (candidates.size > 1) {
        hub.notLinked.push({ reason: `Its CRM codes and confirmed links point at ${candidates.size} different validated customers, so it is kept apart until Customer Links settles which one it is.` });
      }
      for (const reason of conflicts) hub.notLinked.push({ reason });
    }
    hub.marketingCustomerIds.push(customer.id);
    hubByMarketingCustomer.set(customer.id, hub);
  }

  // 3. Marketing links and request targets.
  const marketingCustomerName = new Map(sources.marketingCustomers.map((customer) => [customer.id, String(customer.display_name ?? "").trim()]));
  const marketingPharmacyEntry = (pharmacyId: string, distributorCodeId: string | null) => {
    const pharmacy = sources.marketingPharmacies.get(pharmacyId);
    if (!pharmacy) return null;
    const codes = distributorCodeId ? pharmacy.codes.filter((code) => code.codeId === distributorCodeId) : [];
    const pairs = (codes.length > 0 ? codes : pharmacy.codes).map((code) => code.pair);
    const brickId = pharmacy.codes.find((code) => code.pair.brickId)?.pair.brickId ?? null;
    return {
      address: pharmacy.address,
      areaName: pharmacy.areaName,
      brickId,
      brickName: brickId ? sources.brickNames.get(brickId) ?? null : null,
      directOrderPharmacyId: null,
      key: `mp:${pharmacy.id}`,
      marketingPharmacyId: pharmacy.id,
      matchStatus: null,
      name: pharmacy.name,
      pairs,
    };
  };
  for (const link of sources.marketingLinks) {
    if (!isCountedMarketingLinkStatus(link.status)) continue;
    const hub = hubByMarketingCustomer.get(link.customerId);
    if (!hub) continue;
    const entry = marketingPharmacyEntry(link.pharmacyId, link.distributorCodeId);
    if (entry) hub.bag.add({ ...entry, source: "marketing_link" });
  }
  for (const request of sources.requests) {
    const hub = request.customerId ? hubByMarketingCustomer.get(request.customerId) : undefined;
    if (!hub) continue;
    const targetKeys: string[] = [];
    for (const target of request.targets) {
      const entry = marketingPharmacyEntry(target.pharmacyId, target.distributorCodeId);
      if (!entry) continue;
      const added = hub.bag.add({ ...entry, source: "request_target" });
      if (!targetKeys.includes(added.key)) targetKeys.push(added.key);
    }
    hub.requests.push({
      actualRoi: request.actualRoi,
      code: request.code,
      cost: request.cost,
      id: request.id,
      marketingCustomerName: marketingCustomerName.get(request.customerId ?? "") ?? "",
      payDate: request.payDate,
      requiredRoi: request.requiredRoi,
      roiDurationMonths: request.roiDurationMonths,
      salesRows: request.salesRows,
      status: request.status,
      targetKeys,
      typeName: request.typeName,
    });
  }

  // 4. Trusted direct-order venues, by the hub's contact id.
  const ordersByVenue = new Map<string, SourceDirectOrder[]>();
  for (const order of sources.directOrders) {
    const list = ordersByVenue.get(order.pharmacyId) ?? [];
    list.push(order);
    ordersByVenue.set(order.pharmacyId, list);
  }
  const hubsByContact = new Map<number, HubDraft[]>();
  for (const hub of hubs.values()) {
    if (hub.contactCrmId == null) continue;
    const list = hubsByContact.get(hub.contactCrmId) ?? [];
    list.push(hub);
    hubsByContact.set(hub.contactCrmId, list);
  }
  for (const venue of sources.directVenues) {
    if (!isTrustedDirectOrderVenue(venue) || venue.crmContactId == null) continue;
    const owners = hubsByContact.get(venue.crmContactId) ?? [];
    // A contact validated as both a doctor and an account is ambiguous: the venue goes to the doctor.
    const hub = owners.find((one) => one.kind === "doctor") ?? owners[0];
    if (!hub) continue;
    hub.bag.add({
      address: venue.address,
      areaName: venue.areaCode ? sources.areaNames.get(venue.areaCode) ?? null : null,
      brickId: venue.brickId,
      brickName: venue.brickId ? sources.brickNames.get(venue.brickId) ?? null : null,
      directOrderPharmacyId: venue.id,
      key: `do:${venue.id}`,
      marketingPharmacyId: null,
      matchStatus: null,
      name: venue.name,
      // A code row mapped to no brick of its own sits in the venue's brick.
      pairs: venue.pairs.map((pair) => ({ ...pair, brickId: pair.brickId ?? venue.brickId })),
      source: "direct_order",
    });
    hub.directOrders.venues += 1;
    for (const order of ordersByVenue.get(venue.id) ?? []) {
      // The three lines only: a Head Office order is not tracked here, as in the closing.
      const line = hubLineCode(order.line);
      if (line) hub.directOrders.entries.push({ line, month: order.month, value: order.value });
    }
  }

  // 5. Pharmacies named on visits — the matcher, item by item.
  const items = new Map<string, MatchItem>();
  for (const sighting of sources.named) {
    const hub = hubByPhoenixCustomer.get(sighting.customerId);
    if (!hub) continue;
    const itemKey = matchItemKey(sighting.nameKey, sighting.brickId ?? "");
    let item = items.get(itemKey);
    if (!item) {
      const decision = sighting.brickId ? sources.decisions.get(itemKey) ?? null : null;
      const areaCode = sighting.brickId ? sources.brickAreas.get(sighting.brickId) ?? sighting.areaCode : sighting.areaCode;
      const result = matchNamedPharmacy({
        areaShops: areaCode ? sources.areaShops.get(areaCode) ?? [] : [],
        brickId: sighting.brickId,
        brickShops: sighting.brickId ? sources.brickShops.get(sighting.brickId) ?? [] : [],
        decision,
        nameKey: sighting.nameKey,
      });
      item = {
        areaName: sighting.areaName ?? (areaCode ? sources.areaNames.get(areaCode) ?? null : null),
        brickId: sighting.brickId,
        brickName: sighting.brickName ?? (sighting.brickId ? sources.brickNames.get(sighting.brickId) ?? null : null),
        key: itemKey,
        nameKey: sighting.nameKey,
        result,
        sightings: [],
        typedAs: [],
      };
      items.set(itemKey, item);
    }
    if (!item.typedAs.includes(sighting.typed)) item.typedAs.push(sighting.typed);
    const repKey = sources.canonicalHrId(sighting.repHrId);
    const line = hubLineCode(sighting.lineCode) ?? (repKey ? sources.repLines.get(repKey) ?? null : null);
    item.sightings.push({
      hubId: hub.id,
      hubKind: hub.kind,
      hubName: hub.name,
      lat: sighting.lat,
      line,
      lon: sighting.lon,
      placeAddress: sighting.address,
      repName: (repKey ? sources.repNames.get(repKey) : null) ?? "Rep not named",
      typed: sighting.typed,
      visitDate: sighting.visitDate,
    });

    if (item.result.status === "auto" || item.result.status === "confirmed") {
      const first = item.result.pairs[0];
      hub.bag.add({
        address: null,
        areaName: item.areaName,
        brickId: item.brickId,
        brickName: item.brickName,
        directOrderPharmacyId: null,
        key: `nv:${itemKey}`,
        marketingPharmacyId: null,
        matchStatus: item.result.status,
        name: first?.customerName || sighting.typed,
        namedByLines: line ? [line] : [],
        pairs: item.result.pairs.map((pair) => ({ brickId: pair.brickId, customerCode: pair.customerCode, distributorCode: pair.distributorCode })),
        source: "named_on_visit",
        typedAs: [sighting.typed],
      });
    }
  }

  // 6. Visits, folded per month, line, rep and source — AM · PM · Pharmacies apart, regular and campaign apart.
  for (const hub of hubs.values()) {
    if (hub.contactCrmId == null) continue;
    const months = sources.visitMonths.get(hub.contactCrmId) ?? [];
    const folded = new Map<string, HubVisitRow>();
    for (const entry of months) {
      const repKey = sources.canonicalHrId(entry.agentHrId);
      const line = repKey ? sources.repLines.get(repKey) ?? null : null;
      const repName = (repKey ? sources.repNames.get(repKey) : null) ?? entry.agentName ?? "Rep not named";
      const source = entry.source === "phoenix" ? "phoenix" : "ireports360";
      const key = `${entry.month}|${line ?? ""}|${repName}|${source}`;
      const row = folded.get(key) ?? { am: 0, campaign: 0, line, month: entry.month, pharmacies: 0, pm: 0, regular: 0, repName, source };
      const bucket = visitCountBucket({ ampm: entry.ampm, source: entry.source, speciality: entry.speciality, visit_type: entry.visitType });
      if (bucket === "AM") row.am += entry.visits;
      else if (bucket === "PM") row.pm += entry.visits;
      else row.pharmacies += entry.visits;
      const kind = classifyVisit(entry.visitType, null, null).bucket;
      if (kind === "campaign") row.campaign += entry.visits;
      else if (kind === "regular") row.regular += entry.visits;
      folded.set(key, row);
      if (line && !hub.linesVisiting.includes(line)) hub.linesVisiting.push(line);
    }
    hub.visits = [...folded.values()].sort((a, b) => (a.month === b.month ? a.repName.localeCompare(b.repName) : a.month < b.month ? 1 : -1));
  }

  const out: Hub[] = [];
  for (const draft of hubs.values()) {
    const { bag, ...hub } = draft;
    hub.pharmacies = bag.list();
    hub.linesVisiting.sort();
    hub.validatedOnLines.sort();
    out.push(hub);
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "ar"));
  return { hubs: out, matchItems: [...items.values()] };
}

/** Every pair the report needs sales for — hubs' pharmacies and the confirm tab's candidates. */
export function pairsNeedingSales(assembly: HubAssembly): SalesPair[] {
  const seen = new Map<string, SalesPair>();
  const add = (pair: SalesPair) => {
    const normal = normalisePair(pair);
    if (!pairCanBeRead(normal)) return;
    const key = `${pairKey(normal)}|${normal.brickId ?? ""}`;
    if (!seen.has(key)) seen.set(key, normal);
  };
  for (const hub of assembly.hubs) for (const pharmacy of hub.pharmacies) for (const pair of pharmacy.pairs) add(pair);
  for (const item of assembly.matchItems) {
    for (const candidate of item.result.candidates) add(candidate);
    for (const pair of item.result.pairs) add(pair);
  }
  return [...seen.values()];
}

export type { MatchCandidate, MatchPair, WaitReason };
