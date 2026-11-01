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
 * ## MEASURED YIELD, 2026-09-03 — the direct-order side is effectively inert, and better matching
 * ## cannot fix it
 *
 * Replaying all three rules against production: of 63 live direct-order venues, exactly ONE links to
 * a CRM contact.
 *
 * The tempting diagnosis is the area gate, because the gate really is starved — 759 of the 1,872 CRM
 * pharmacies (41%) resolve to no area at all, and 21 of the 63 venues sit in an area holding no
 * area-resolved CRM pharmacy whatsoever, so no name could match there however good it was. That
 * diagnosis is WRONG, and the number that settles it is the ceiling: drop the area gate entirely and
 * ask only whether a venue name has ANY twin among all 1,872 CRM pharmacies, and the answer is 4 —
 * four exact, zero prefix. So a company-wide brick-resolution drive would move this from 1 to at most
 * 4 of 63. The names do not meet. A rep types a venue into an order form; the CRM holds a different
 * string for the same shop, and no normalizer recovers the difference.
 *
 * WHY MARKETING WORKED AND DIRECT ORDERS DID NOT. The two channels were not doing the same thing.
 * `loadTradeCounterparties` gives a marketing party a real `contactCrmId` out of
 * `marketing_customer_contacts.crm_code`, so marketing fires RULE 1 — an id a human wrote down,
 * not area-gated, always wins. The direct-order branch hardcoded `contactCrmId: null`, so it could
 * only ever reach rules 2 and 3, the inferential ones, whose measured ceiling is the 4 above.
 *
 * So the gap was a MISSING DECLARATION, not a weak matcher, and the matching core already had the
 * feature that closes it. CLOSED 2026-09-03: `direct_order_pharmacies.crm_contact_id` now carries
 * the contact the submitter picked when the venue was registered — the same shape as the campaign
 * picker on the order form, where the requester declares the link instead of the system guessing
 * it — and `loadDeclaredVenueContacts` below passes it in. Rule 1 fires and NOTHING in the matching
 * core changed, which was the point: the three rules and their fixtures are untouched.
 *
 * The yield is therefore no longer a property of this file. It is a property of how many venues
 * have been registered THROUGH the picker, which on the day it shipped was zero — every one of the
 * 72 existing venues predates it and still resolves by name and area alone. Do not read a low
 * number here as the matcher failing again; read `crm_contact_id is not null` first.
 *
 * DO NOT loosen the rules to raise the number. The candidates immediately below the current bar are
 * wrong in the expensive direction: `المنصورية الجديدة` against `المصرية الجديدة`,
 * `اسماء عبد العزيز` against `هند عبد العزيز`, `السيد ابو الفتوح` against `احمد ابو الفتوح`
 * — different businesses, similarity 0.40-0.44, indistinguishable by threshold from the real ones.
 *
 * The matching core is pure and fixture-tested; the Supabase reads sit below it.
 */

import { parseCrmContactCode } from "@/lib/crm/contact-code";
import { isCrmSchemaMissingError } from "@/lib/crm/schema";
import { loadReferenceAreas, type ReferenceArea } from "@/lib/reference/reference-lists";
import { getOrLoadShared } from "@/lib/cache/shared-read";
import { CRM_TRADE_COUNTERPARTIES } from "@/lib/crm/shared-windows";
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
/**
 * A missing COLUMN, specifically — not a missing table.
 *
 * `isCrmSchemaMissingError` deliberately refuses to swallow 42703/PGRST204, because a missing
 * column is normally a projection bug that must surface loudly. This one case is the exception, and
 * it is narrow on purpose: a deploy applies NO migrations, so between shipping this code and
 * applying `20260903193000_direct_order_venue_crm_contact_link.sql` the column genuinely does not
 * exist yet. In that window "no venue has declared a contact" is the TRUE answer, not a degraded
 * one — and the alternative is a 500 that takes out the whole CRM contact board for every rep.
 */
function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const message = `${error.code ?? ""} ${error.message ?? ""}`;
  return /42703|PGRST204|column .* does not exist|Could not find the .* column/i.test(message);
}

/**
 * The CRM contact each direct-order venue was DECLARED to be, by the person who registered it.
 *
 * Read separately from the main venue select rather than folded into it, so that the tolerance
 * above applies to this column alone. Widening the main projection would mean one absent column
 * could silently empty the whole trade board instead of just the declarations.
 */
async function loadDeclaredVenueContacts(): Promise<Map<string, number>> {
  const { data, error } = await getSupabaseAdmin()
    .from("direct_order_pharmacies")
    .select("id, crm_contact_id")
    .not("crm_contact_id", "is", null);
  if (error) {
    if (isMissingColumnError(error) || isCrmSchemaMissingError(error)) return new Map();
    throw new Error(`Could not read declared venue contacts: ${error.message}`);
  }
  const byPharmacyId = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ crm_contact_id: number | null; id: string }>) {
    const parsed = Number(row.crm_contact_id);
    if (!row.id || !Number.isInteger(parsed) || parsed <= 0) continue;
    byPharmacyId.set(String(row.id), parsed);
  }
  return byPharmacyId;
}

const TRADE_COUNTERPARTIES_LIMITS = { maxEntries: 1, maxRowsTotal: 20_000 };

/**
 * Every counterparty Phoenix has traded with, from a shared in-process copy (60 s) since 1 Nov 2026 — the
 * speed root cause: the six whole-table reads below (297 direct-order venues and 137 marketing customers
 * that day) ran again on every Reps List and My List open, for every viewer, each request ~450 ms at
 * Supabase's edge for a few milliseconds of SQL. A direct order or marketing request submitted or decided
 * in this process drops the copy at once (`refreshSharedTradeCounterparties`, src/lib/crm/shared-windows.ts);
 * one on another process is caught by the copy's lifetime. A DISPLAY read — the two counts beside a
 * contact — and nothing that decides money, an approval or a notification.
 */
export async function loadTradeCounterparties(): Promise<TradeCounterparty[]> {
  const { rows } = await getOrLoadShared(CRM_TRADE_COUNTERPARTIES, "all", readTradeCounterparties, TRADE_COUNTERPARTIES_LIMITS);
  return rows ?? [];
}

async function readTradeCounterparties(): Promise<TradeCounterparty[]> {
  const supabase = getSupabaseAdmin();
  const parties: TradeCounterparty[] = [];

  const declaredContacts = await loadDeclaredVenueContacts();

  const [pharmacies, orders, customers, requests, crmLinks, areasResult] = await Promise.all([
    supabase.from("direct_order_pharmacies").select("id, pharmacy_name, area_code"),
    supabase.from("direct_order_requests").select("pharmacy_id, status"),
    supabase.from("marketing_customers").select("id, display_name, area_id"),
    supabase.from("marketing_requests").select("customer_id, status").eq("origin", "phoenix"),
    supabase.from("marketing_customer_contacts").select("customer_id, crm_code"),
    // The 143 areas come from the shared one-minute copy (src/lib/reference/reference-lists.ts)
    // rather than a read of their own on every board. That accessor THROWS where the five reads
    // beside it report `result.error`, so its failure is caught into the same shape and judged by
    // the same two rules, two statements below — never silently swallowed into an empty area map.
    loadReferenceAreas().then(
      (rows) => ({ error: null as unknown, rows }),
      (error: unknown) => ({ error: error ?? new Error("unknown"), rows: [] as ReferenceArea[] }),
    ),
  ]);

  for (const result of [pharmacies, orders, customers, requests, crmLinks]) {
    // Before the direct-order or marketing migrations reach an environment these tables are absent.
    // A board with no trade badges is correct there; a 500 on the whole contact list is not.
    if (result.error && isCrmSchemaMissingError(result.error)) return [];
    if (result.error) throw new Error(`Could not read trade counterparties: ${result.error.message}`);
  }
  if (areasResult.error && isCrmSchemaMissingError(areasResult.error)) return [];
  if (areasResult.error) {
    const message = areasResult.error instanceof Error ? areasResult.error.message : String(areasResult.error);
    throw new Error(`Could not read trade counterparties: ${message}`);
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
      // RULE 1 when the submitter declared one. This is the whole direct-order half of the link:
      // an id a human wrote down, beating every name/area inference, exactly as marketing already
      // does through `marketing_customer_contacts.crm_code`. Null keeps the old behaviour — the
      // venue falls through to the two inferred rules, which is all it could ever reach before.
      contactCrmId: declaredContacts.get(row.id) ?? null,
      count: counted.total,
      name: row.pharmacy_name,
    });
  }

  // 🔴 BOTH SIDES THROUGH `String()`. `areas.id` is a NUMBER, and `marketing_customers.area_id` is
  // declared `string | null` on `MarketingCustomerRow` while holding a number at runtime — so the
  // old map (keyed by a row cast to `string`) and the old lookup agreed only because both were
  // numbers. With the typed reference row the key would be a real string and the lookup a number,
  // and every area code would silently come back undefined. Keyed and looked up as strings now.
  const areaCodeById = new Map<string, string>();
  for (const row of areasResult.rows) {
    if (row.code && row.id != null) areaCodeById.set(String(row.id), row.code);
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
    const areaCode = row.area_id ? (areaCodeById.get(String(row.area_id)) ?? null) : null;
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
