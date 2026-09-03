/**
 * Contact trade — has Phoenix actually done business with this row on a rep's contact list?
 *
 * The owner's specification, 2026-09-01: "the contact list we just built for every medical rep. I
 * want to see those in the contact list. If a pharmacy in the contact list and we meet direct
 * order, show." And, when asked what to show: "my objective is two quantity ... how much order we
 * did ... and the contacts or doctors that we made a marketing request with them. I don't need the
 * value now." So a row carries at most two numbers, both counts, and never money.
 *
 * ## The whole difficulty is that no link exists
 *
 * Phoenix has no foreign key from a direct-order pharmacy to a CRM contact. `direct_order_pharmacies`
 * is a venue a rep typed into an order form; `ireports360_contacts` is a list the CRM handed that rep.
 * Nothing joins them. Marketing is only slightly better: `marketing_customer_contacts.crm_code`
 * carries a real CRM contact id, but it is populated on only 8 of the 19 contact rows behind the
 * Phoenix requests.
 *
 * An earlier version of this note said those codes "resolve for 6", counting a code as real only
 * when it appeared in `ireports360_contacts`. That test was wrong, and the correction is worth
 * keeping because the wrong reading is the intuitive one: `ireports360_contacts` is keyed
 * `(agent_crm_id, contact_crm_id, list_type)`, so it is one agent's contact LIST and not a contact
 * registry — 47% of the contacts reps have actually visited are missing from it, and every code
 * measured against production 2026-09-03 turned out to be a real CRM contact with live visits. See
 * `parseCrmContactCode` in src/lib/crm/contact-code.ts for the full measurement.
 *
 * So the join has to be inferred from the NAME, and a bare name match is unusable here. Measured
 * against production 2026-09-01: the direct-order venue `المدينة` name-matches ELEVEN CRM pharmacies
 * — Belkas, Sherbeen, Qena, Kafr Sakr, Abo Kebeer, 6th October and more — because "City Pharmacy" is
 * the "Main Street" of Egyptian pharmacy names. Attaching one order to all eleven would tell ten reps
 * they sold to a pharmacy they have never sold to.
 *
 * ## So the AREA is what turns a name into a match
 *
 * Both sides can reach a sales area code. A direct-order venue carries `area_code` outright; a CRM
 * contact reaches one through the brick it resolves to (`customer/region -> brick -> area`), which is
 * the same two-step precedence `reps-list.ts` already applies for grouping — so this module takes the
 * area from the caller rather than resolving it a second time and risking a different answer.
 *
 * On that same `المدينة` case the area gate cuts eleven candidates to exactly ONE (Belkas), and it
 * correctly REFUSES four other name-twins whose towns disagree — `مستشفى زمزم`, `احمد صالح`, `ريهام`
 * and `أيمن صالح` are each a different business that happens to share a name with a CRM row.
 *
 * ## Three rules, in order, and the reason each exists
 *
 * 1. AN EXPLICIT ID BEATS EVERYTHING. When the source carries a CRM contact id, it is used and no
 *    name or area test runs at all. A human wrote that id down; nothing inferred outranks it.
 *
 * 2. AN EXACT NAME IN THE SAME AREA MATCHES — including when several rows share it. Two CRM rows
 *    reading `حضانه نور المصطفي`, both in Shebeen El Kom, are one nursery entered twice, and the rep
 *    looking at either row should see the order. This is the one place ambiguity is tolerated,
 *    because "same name, same town" is not really ambiguous.
 *
 * 3. A PREFIX MATCH IS ACCEPTED ONLY WHEN IT IS UNIQUE IN THAT AREA. Reps write a venue with its
 *    location appended — the order `ريهام عادل بلقاس ن` is the CRM's `صيدلية ريهام عادل` in Belkas,
 *    and exact matching finds neither it nor `الجناينى - ميت غمر` against `صيدليه الجنايني`. But a
 *    prefix is a guess, and the guess goes wrong in a specific way: `محمد حسام` is a prefix of
 *    `محمد حسام على`, and `انجي جاد` of `انجي جاد عبداللة` — different doctors, same town, on real
 *    production rows. So a prefix that lands on more than one contact attaches to NONE of them.
 *
 * Everything not matched by those three rules shows nothing, which is the safe direction: a missing
 * badge reads as "no record of trading with them", while a wrong badge tells a rep the company sold
 * to a pharmacy it never sold to. Under-reporting is recoverable; a false trade record is not.
 *
 * The matching core is pure and fixture-tested; the Supabase reads sit below it.
 */

import { parseCrmContactCode } from "@/lib/crm/contact-code";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The shortest name a PREFIX rule may fire on. Rule 2 (exact) has no floor — an exact name in the
 * same area is evidence at any length — but a prefix is a guess, and a short one is a bad guess:
 * without this, the four-character `ريهام` would prefix-match every `ريهام <surname>` in its area.
 */
export const PREFIX_MIN_LENGTH = 8;

/** What a row on the board carries. Both counts, never money — the owner's own scoping. */
export type ContactTrade = {
  /** Direct orders raised against this venue, in every status. */
  directOrders: number;
  /** How many of those were approved. Shown so a row cannot imply a sale that was refused. */
  directOrdersApproved: number;
  /** Marketing requests raised against this doctor, in every status. */
  marketingRequests: number;
  /** How many of those are approved and live. */
  marketingRequestsApproved: number;
};

/** A counterparty Phoenix actually traded with, and how often. */
export type TradeCounterparty = {
  approved: number;
  /** Sales area the trade sits in. Null can never match — an unplaceable venue is not evidence. */
  areaCode: string | null;
  channel: "direct-order" | "marketing";
  /** An explicit CRM contact id, when the source recorded one. Rule 1. */
  contactCrmId: number | null;
  count: number;
  name: string;
};

/** One CRM contact, with the area the caller already resolved for it. */
export type TradeContact = {
  areaCode: string | null;
  contactCrmId: number;
  name: string;
};

const EMPTY: ContactTrade = {
  directOrders: 0,
  directOrdersApproved: 0,
  marketingRequests: 0,
  marketingRequestsApproved: 0,
};

/**
 * Fold a venue or contact name down to something two sources can be compared on.
 *
 * DELIBERATELY NOT `nameKey` from `location-confidence.ts`, which exists to match a CRM contact
 * against another CRM contact — one source, one spelling convention — and so strips punctuation and
 * spaces without touching Arabic orthography. This function compares an order form a rep TYPED
 * against a list the CRM EXPORTED, where three differences are systematic rather than incidental:
 *
 * - the CRM writes `صيدلية X` where the order writes `X`, and `د. X` where the order writes `X`;
 * - أ إ آ ٱ are the same letter carelessly typed, as are ى/ي and ة/ه;
 * - diacritics and the tatweel appear in one source and not the other.
 *
 * Spaces are KEPT, unlike in `nameKey`, because the prefix rule has to respect word boundaries:
 * without them `محمد على` would prefix-match `محمد علي` fused into a longer unrelated name.
 */
export function venueKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/^\s*(د\s*\.?|دكتور|dr\s*\.?|صيدلية|صيدليه|صيدلبة|صيدلبه)\s+/u, "")
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/[ً-ْـ]/gu, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Does `long` start with `short` at a WORD boundary — `محمد حسام` inside `محمد حسام على`, not inside a fused token? */
const isWordPrefix = (short: string, long: string): boolean =>
  short.length >= PREFIX_MIN_LENGTH && long.length > short.length && long.startsWith(`${short} `);

const add = (into: Map<number, ContactTrade>, contactCrmId: number, party: TradeCounterparty): void => {
  const current = into.get(contactCrmId) ?? { ...EMPTY };
  if (party.channel === "direct-order") {
    current.directOrders += party.count;
    current.directOrdersApproved += party.approved;
  } else {
    current.marketingRequests += party.count;
    current.marketingRequestsApproved += party.approved;
  }
  into.set(contactCrmId, current);
};

/**
 * PURE CORE — which contacts on a list Phoenix has actually traded with, and how often.
 *
 * Returns entries only for contacts with something to show, so a row with no entry needs no badge
 * and no thought. The three rules and the reasoning behind each are in the file header.
 */
export function matchContactTrade(
  contacts: readonly TradeContact[],
  counterparties: readonly TradeCounterparty[],
): Map<number, ContactTrade> {
  const found = new Map<number, ContactTrade>();
  if (contacts.length === 0 || counterparties.length === 0) return found;

  const byId = new Map<number, TradeContact>();
  // Keyed by area FIRST, so a name can only ever be looked up inside one area. Building this the
  // other way round — name to a list of contacts, filtered by area afterwards — is the same answer
  // but invites a later edit that forgets the filter, which is precisely the eleven-pharmacy bug.
  const byArea = new Map<string, { key: string; contact: TradeContact }[]>();
  for (const contact of contacts) {
    byId.set(contact.contactCrmId, contact);
    if (!contact.areaCode) continue;
    const key = venueKey(contact.name);
    if (!key) continue;
    const bucket = byArea.get(contact.areaCode);
    if (bucket) bucket.push({ contact, key });
    else byArea.set(contact.areaCode, [{ contact, key }]);
  }

  for (const party of counterparties) {
    // RULE 1 — an id a human recorded outranks anything this file can infer, and is not area-gated:
    // the id already names one specific contact, so there is nothing left to disambiguate.
    if (party.contactCrmId != null && byId.has(party.contactCrmId)) {
      add(found, party.contactCrmId, party);
      continue;
    }
    if (!party.areaCode) continue;
    const candidates = byArea.get(party.areaCode);
    if (!candidates || candidates.length === 0) continue;
    const key = venueKey(party.name);
    if (!key) continue;

    // RULE 2 — every exact match in the area, however many. Same name in the same town is one place
    // the CRM holds twice, and the rep reading either copy should see the trade.
    const exact = candidates.filter((entry) => entry.key === key);
    if (exact.length > 0) {
      for (const entry of exact) add(found, entry.contact.contactCrmId, party);
      continue;
    }

    // RULE 3 — a prefix either direction, and ONLY when it names exactly one contact. Two candidates
    // is not a weaker match, it is a different question the data cannot answer, so nothing is shown.
    const prefixed = candidates.filter(
      (entry) => isWordPrefix(key, entry.key) || isWordPrefix(entry.key, key),
    );
    if (prefixed.length === 1) add(found, prefixed[0].contact.contactCrmId, party);
  }

  return found;
}

type PharmacyRow = { area_code: string | null; id: string; pharmacy_name: string | null };
type OrderRow = { pharmacy_id: string | null; status: string | null };
type MarketingCustomerRow = {
  area_id: string | null;
  display_name: string | null;
  id: string;
};
type MarketingRequestRow = { customer_id: string | null; status: string | null };

const APPROVED_ORDER = "approved";
/** A marketing request that reached the money. `pending_approval`, `rejected` and `finance_hold` have not. */
const LIVE_MARKETING = new Set(["active", "approved", "closed", "executed"]);

/**
 * Every counterparty Phoenix has traded with through the app, company-wide.
 *
 * SCOPED TO `origin = 'phoenix'` ON THE MARKETING SIDE BY THE OWNER'S OWN INSTRUCTION, 2026-09-01:
 * "you will do this from the direct orders and marketing requests submitted through phoenix only,
 * not import by xlsx". The marketing tables carry a seeded catalogue many times larger than the
 * requests actually raised in the app — 286 of 332 pharmacies and 156 of 199 customers have no
 * capture behind them — and counting those would put a badge on rows nobody has ever traded with.
 * `direct_order_requests` has no such import path, so every row there is already app-submitted.
 *
 * The whole set is small — 57 venues and 20 customers as of 2026-09-01 — so it is read entire and
 * matched in process rather than queried per rep.
 */
export async function loadTradeCounterparties(): Promise<TradeCounterparty[]> {
  const supabase = getSupabaseAdmin();
  const parties: TradeCounterparty[] = [];

  const [pharmacies, orders, customers, requests, crmLinks, areas] = await Promise.all([
    supabase.from("direct_order_pharmacies").select("id, pharmacy_name, area_code"),
    supabase.from("direct_order_requests").select("pharmacy_id, status"),
    supabase.from("marketing_customers").select("id, display_name, area_id"),
    supabase.from("marketing_requests").select("customer_id, status").eq("origin", "phoenix"),
    supabase.from("marketing_customer_contacts").select("customer_id, crm_code"),
    supabase.from("areas").select("id, code"),
  ]);

  for (const result of [pharmacies, orders, customers, requests, crmLinks, areas]) {
    // Before the direct-order or marketing migrations reach an environment these tables are absent.
    // A board with no trade badges is correct there; a 500 on the whole contact list is not.
    if (result.error && isCrmSchemaMissingError(result.error)) return [];
    if (result.error) throw new Error(`Could not read trade counterparties: ${result.error.message}`);
  }

  const orderCounts = new Map<string, { approved: number; total: number }>();
  for (const row of (orders.data ?? []) as OrderRow[]) {
    if (!row.pharmacy_id) continue;
    const current = orderCounts.get(row.pharmacy_id) ?? { approved: 0, total: 0 };
    current.total += 1;
    if (row.status === APPROVED_ORDER) current.approved += 1;
    orderCounts.set(row.pharmacy_id, current);
  }
  for (const row of (pharmacies.data ?? []) as PharmacyRow[]) {
    const counted = orderCounts.get(row.id);
    if (!counted || !row.pharmacy_name) continue;
    parties.push({
      approved: counted.approved,
      areaCode: row.area_code,
      channel: "direct-order",
      contactCrmId: null,
      count: counted.total,
      name: row.pharmacy_name,
    });
  }

  const areaCodeById = new Map<string, string>();
  for (const row of (areas.data ?? []) as { code: string | null; id: string }[]) {
    if (row.code) areaCodeById.set(row.id, row.code);
  }

  // A customer's contacts can carry a CRM id; the REQUEST cannot (`customer_contact_id` is null on
  // all 27 Phoenix requests, so the column is not a route). The link is therefore customer-level:
  // whichever contacts of this customer name a CRM row, the customer's requests attach to them.
  const crmIdsByCustomer = new Map<string, number[]>();
  for (const row of (crmLinks.data ?? []) as { crm_code: string | null; customer_id: string | null }[]) {
    const parsed = parseCrmContactCode(row.crm_code);
    if (!row.customer_id || parsed === null) continue;
    const bucket = crmIdsByCustomer.get(row.customer_id);
    if (bucket) bucket.push(parsed);
    else crmIdsByCustomer.set(row.customer_id, [parsed]);
  }

  const requestCounts = new Map<string, { approved: number; total: number }>();
  for (const row of (requests.data ?? []) as MarketingRequestRow[]) {
    if (!row.customer_id) continue;
    const current = requestCounts.get(row.customer_id) ?? { approved: 0, total: 0 };
    current.total += 1;
    if (row.status && LIVE_MARKETING.has(row.status)) current.approved += 1;
    requestCounts.set(row.customer_id, current);
  }
  for (const row of (customers.data ?? []) as MarketingCustomerRow[]) {
    const counted = requestCounts.get(row.id);
    if (!counted || !row.display_name) continue;
    const areaCode = row.area_id ? (areaCodeById.get(row.area_id) ?? null) : null;
    const linked = crmIdsByCustomer.get(row.id) ?? [];
    if (linked.length > 0) {
      // One counterparty per linked CRM id, so rule 1 binds each without a name test. A customer
      // with two linked contacts is two people at one clinic, and the request concerns both.
      for (const contactCrmId of linked) {
        parties.push({
          approved: counted.approved,
          areaCode,
          channel: "marketing",
          contactCrmId,
          count: counted.total,
          name: row.display_name,
        });
      }
      continue;
    }
    parties.push({
      approved: counted.approved,
      areaCode,
      channel: "marketing",
      contactCrmId: null,
      count: counted.total,
      name: row.display_name,
    });
  }

  return parties;
}
