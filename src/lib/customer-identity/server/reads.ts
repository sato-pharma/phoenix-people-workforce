import { getSupabaseAdmin } from "@/lib/supabase/server";
import { suggestIdentityPairs } from "@/lib/customer-identity/suggestions";
import type {
  DistributorCodePair,
  IdentityCandidate,
  IdentityKind,
  SuggestionCluster,
} from "@/lib/customer-identity/types";

/**
 * Phoenix CRM Wave 2 — reading the four worlds, so the engine can compare them.
 *
 * Every read here is SERVICE ROLE and READ-ONLY against the source systems. Nothing in this file
 * writes to `phoenix_crm_*`, `marketing_*`, `direct_order_*` or `crm_*`, and nothing ever will:
 * a link is an annotation that lives entirely in `customer_identity_*`.
 *
 * 🔴 PAGE EVERY READ. An unbounded PostgREST `select()` stops at 1,000 rows and says nothing about
 * it — no error, no marker — and production holds 8,234 Phoenix CRM customers alone. A silent cap
 * here would not fail; it would quietly stop offering the owner most of his own duplicates, which
 * is the worst shape of bug this feature can have.
 */

const PAGE = 1000;

/**
 * One active table, read in full.
 *
 * The admin client is untyped here, so the select list must be a single string literal and the row
 * shape is asserted by the caller — that is the house pattern, not a shortcut. The explicit
 * `order` is what makes the paging correct: without one, two pages can overlap or skip rows.
 */
async function pageActive<T>(table: string, columns: string, orderBy = "id"): Promise<T[]> {
  const admin = getSupabaseAdmin();
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .eq("active", true)
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`customer-identity: reading ${table} failed — ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Phoenix CRM's own customers.
 *
 * 🔴 `is_test` IS FILTERED. A `TEST-` login's rows carry the real employee's HR id with
 * `is_test = true`, so every `phoenix_crm_*` read keyed by a person must exclude them — a test
 * persona's practice customer is not a real doctor and must never be offered as one half of a
 * real identity.
 */
async function phoenixCrmCandidates(): Promise<IdentityCandidate[]> {
  const admin = getSupabaseAdmin();
  const rows: Array<{
    id: string;
    name: string | null;
    speciality: string | null;
    list_type: string | null;
    reference_contact_crm_id: number | null;
  }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("phoenix_crm_customers")
      .select("id, name, speciality, list_type, reference_contact_crm_id")
      .eq("is_test", false)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`customer-identity: reading phoenix_crm_customers failed — ${error.message}`);
    const page = (data ?? []) as unknown as typeof rows;
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  return rows.flatMap((row) => {
    const kind = text(row.list_type).toUpperCase();
    if (kind !== "PM" && kind !== "AM") return [];
    return [
      {
        contactCrmId: row.reference_contact_crm_id ?? null,
        kind: kind as IdentityKind,
        name: text(row.name),
        source: "phoenix_crm" as const,
        sourceId: String(row.id),
        speciality: row.speciality,
      },
    ];
  });
}

/** The iReports360 mirror — the vendor's own contact list, which most carried-over rows came from. */
async function ireports360Candidates(): Promise<IdentityCandidate[]> {
  const admin = getSupabaseAdmin();
  const out: IdentityCandidate[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("crm_contacts")
      .select("contact_crm_id, name, name_ar, speciality, phone, zone, crm_region_name, brick_id")
      .order("contact_crm_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`customer-identity: reading crm_contacts failed — ${error.message}`);
    const rows = (data ?? []) as Array<{
      contact_crm_id: number;
      name: string | null;
      name_ar: string | null;
      speciality: string | null;
      phone: string | null;
      zone: string | null;
      crm_region_name: string | null;
      brick_id: string | null;
    }>;
    for (const row of rows) {
      // The Arabic name is the one a rep and a pharmacist actually use; the Latin one is the
      // vendor's transliteration. Prefer Arabic and fall back, rather than comparing two alphabets.
      const name = text(row.name_ar) || text(row.name);
      if (!name) continue;
      out.push({
        brickCode: row.brick_id,
        contactCrmId: row.contact_crm_id,
        // The vendor mirror does not separate AM from PM on the contact itself; these are the
        // doctors the PM list is built from, so they enter as PM and an AM row can never match one.
        kind: "PM",
        name,
        phone: row.phone,
        regionCode: row.crm_region_name ?? row.zone,
        source: "ireports360",
        sourceId: String(row.contact_crm_id),
        speciality: row.speciality,
      });
    }
    if (rows.length < PAGE) return out;
  }
}

/**
 * Every marketing pharmacy's distributor codes, keyed by pharmacy.
 *
 * 🔴 THE MASTER-RESOLVED PAIR ONLY — `mapped_distributor_code` and `mapped_customer_code`, never
 * the raw `distributor_pharmacy_code` the desk typed and never `distributor_id`. Two reasons, both
 * measured on production 2026-10-01:
 *
 *   · The raw code is a DIFFERENT STRING from the resolved one on 33 of the 479 rows — the master
 *     normalises what a person typed — so keying on it would file those 33 shops under a code no
 *     other system uses, and they would match nothing.
 *   · `distributor_id` is a bigint into `marketing_distributors`, the desk's own numbering. The
 *     direct-order child table speaks `distributor_code` TEXT (`IS-S`, `EP-PHS`). Comparing a
 *     bigint id with a text code across the two is exactly the cross-vocabulary mistake the
 *     distributor rule exists to prevent, and it would quietly match nothing at all.
 *
 * So an UNRESOLVED code is simply not offered as evidence. That is the conservative reading and
 * the owner's standing rule behind it: a false positive is worse than a missed catch. It also
 * matters here because the resolver runs ONCE, at capture, and nothing re-runs it (AGENTS.md §4.1)
 * — a code entered before the master learned that pharmacy stays unresolved for good, and an
 * `unresolved` row can carry a signed human verdict in `validation_notes` rather than a gap. This
 * module reads; it never re-resolves, and it must never be the thing that acts on one of those.
 *
 * Coverage that survives that rule, on production: 435 usable rows over 350 of the 388 marketing
 * pharmacies, at up to FIVE codes each — which is why the pair is a list.
 */
async function marketingCodesByPharmacy(): Promise<Map<string, DistributorCodePair[]>> {
  const rows = await pageActive<{
    pharmacy_id: string | null;
    mapped_distributor_code: string | null;
    mapped_customer_code: string | null;
  }>(
    "marketing_pharmacy_distributor_codes",
    "id, pharmacy_id, mapped_distributor_code, mapped_customer_code",
  );

  const out = new Map<string, DistributorCodePair[]>();
  for (const row of rows) {
    const pharmacyId = text(row.pharmacy_id);
    const distributorId = text(row.mapped_distributor_code);
    const code = text(row.mapped_customer_code);
    if (!pharmacyId || !distributorId || !code) continue;
    const pairs = out.get(pharmacyId) ?? [];
    pairs.push({ code, distributorId });
    out.set(pharmacyId, pairs);
  }
  return out;
}

/** The marketing venue register — pharmacies, with the GPS the desk captured. */
async function marketingCandidates(): Promise<IdentityCandidate[]> {
  const [rows, codes] = await Promise.all([
    pageActive<{
      id: string;
      display_name: string | null;
      region_name: string | null;
      captured_latitude: number | null;
      captured_longitude: number | null;
    }>("marketing_pharmacies", "id, display_name, region_name, captured_latitude, captured_longitude"),
    marketingCodesByPharmacy(),
  ]);

  return rows
    .filter((row) => text(row.display_name).length > 0)
    .map((row) => ({
      distributorPairs: codes.get(String(row.id)) ?? [],
      kind: "pharmacy" as const,
      lat: num(row.captured_latitude),
      lon: num(row.captured_longitude),
      name: text(row.display_name),
      regionCode: row.region_name,
      source: "marketing" as const,
      sourceId: String(row.id),
    }));
}

/**
 * Every direct-order pharmacy's distributor codes, keyed by pharmacy.
 *
 * 🔴 THE CODES LIVE IN THE CHILD TABLE, AND THE PARENT'S TWO COLUMNS ARE DEAD. It reads as though
 * `direct_order_pharmacies.distributor_code` / `.distributor_customer_code` were the link, and they
 * are empty on EVERY row — measured on production 2026-09-30: 0 of 131, against 108 rows in
 * `direct_order_pharmacy_distributor_codes` covering 104 of those pharmacies at 10 distributors.
 * Reading the parent returns null for all of them, silently, so the code evidence simply never
 * fires and the engine looks like it has nothing to say about direct orders.
 *
 * `tests/direct-order-pharmacy-dead-distributor-columns` pins this for the whole repo, and it is
 * what caught this file.
 */
async function directOrderCodesByPharmacy(): Promise<Map<string, DistributorCodePair[]>> {
  const admin = getSupabaseAdmin();
  const out = new Map<string, DistributorCodePair[]>();
  // Paged like every other read here: the child table is small today, and a table that outgrows
  // 1,000 rows without anyone noticing is exactly what the note at the top of this file is about.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("direct_order_pharmacy_distributor_codes")
      .select("id, pharmacy_id, distributor_code, customer_code")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(`customer-identity: reading direct_order_pharmacy_distributor_codes failed — ${error.message}`);
    }
    const rows = (data ?? []) as unknown as {
      pharmacy_id: string | null;
      distributor_code: string | null;
      customer_code: string | null;
    }[];
    for (const row of rows) {
      const pharmacyId = text(row.pharmacy_id);
      const distributorId = text(row.distributor_code);
      const code = text(row.customer_code);
      if (!pharmacyId || !distributorId || !code) continue;
      const pairs = out.get(pharmacyId) ?? [];
      pairs.push({ code, distributorId });
      out.set(pharmacyId, pairs);
    }
    if (rows.length < PAGE) return out;
  }
}

/** The direct-order desk's pharmacies, which carry the distributor's own customer code. */
async function directOrderCandidates(): Promise<IdentityCandidate[]> {
  const [rows, codes] = await Promise.all([
    pageActive<{
      id: string;
      pharmacy_name: string | null;
      brick_id: string | null;
      region_code: string | null;
      crm_contact_id: number | null;
    }>("direct_order_pharmacies", "id, pharmacy_name, brick_id, region_code, crm_contact_id"),
    directOrderCodesByPharmacy(),
  ]);

  return rows
    .filter((row) => text(row.pharmacy_name).length > 0)
    .map((row) => ({
      brickCode: row.brick_id,
      contactCrmId: row.crm_contact_id ?? null,
      // `distributor_code` is WHOSE code it is and `customer_code` is the code itself. Read the
      // other way round, every shop at one distributor looks like one shop — precisely the mistake
      // the cross-distributor rule exists to prevent — which is why the pair travels as one value.
      distributorPairs: codes.get(String(row.id)) ?? [],
      kind: "pharmacy" as const,
      name: text(row.pharmacy_name),
      regionCode: row.region_code,
      source: "direct_order" as const,
      sourceId: String(row.id),
    }));
}

/**
 * Every row the engine may compare, from all four systems.
 *
 * 🔴 A PHOENIX CRM CUSTOMER AND THE iREPORTS360 CONTACT IT WAS CREATED FROM ARE ONE ENTITY, NOT A
 * SUGGESTION. `phoenix_crm_customers.reference_contact_crm_id` already states the tie — the row
 * exists BECAUSE that contact was carried over — so offering the pair for confirmation asks the
 * owner to agree with something the database already says.
 *
 * Measured on production the first time this ran: of the first 500 clusters, **549 of the 609
 * pairs were exactly this shape** — `phoenix_crm ↔ ireports360` in the `fact` band — burying the
 * 53 `likely` and 7 `possible` pairs that are the actual question under thousands of rows of
 * agreement. A review screen that spends 90% of itself on what is already known is a review
 * screen nobody finishes.
 *
 * So the two are FOLDED into one candidate rather than filtered out: the Phoenix row keeps its own
 * id and inherits the vendor row's phone, brick and region, which it does not carry itself. It can
 * then still match a marketing or direct-order row on any of those — the evidence is kept, only
 * the self-agreement is dropped.
 */
export async function loadIdentityCandidates(): Promise<IdentityCandidate[]> {
  const [phoenix, vendor, marketing, direct] = await Promise.all([
    phoenixCrmCandidates(),
    ireports360Candidates(),
    marketingCandidates(),
    directOrderCandidates(),
  ]);

  const vendorById = new Map<number, IdentityCandidate>();
  for (const row of vendor) if (row.contactCrmId != null) vendorById.set(row.contactCrmId, row);

  const carriedOver = new Set<number>();
  const folded = phoenix.map((row) => {
    const source = row.contactCrmId == null ? null : vendorById.get(row.contactCrmId);
    if (!source) return row;
    carriedOver.add(row.contactCrmId as number);
    return {
      ...row,
      brickCode: row.brickCode ?? source.brickCode ?? null,
      phone: row.phone ?? source.phone ?? null,
      regionCode: row.regionCode ?? source.regionCode ?? null,
      speciality: row.speciality ?? source.speciality ?? null,
    };
  });

  // What is left of the mirror is the contacts NO Phoenix CRM customer was carried over from —
  // the ones where a duplicate is a real finding rather than a restatement.
  const remainingVendor = vendor.filter((row) => row.contactCrmId == null || !carriedOver.has(row.contactCrmId));

  return [...folded, ...remainingVendor, ...marketing, ...direct];
}

/**
 * The pairs he has ruled "not the same" and has NOT withdrawn.
 *
 * A withdrawn ruling is simply absent from this set, which is the whole of the undo: the engine
 * drops a ruled pair, so leaving the key out brings the pair straight back as a suggestion with no
 * other change anywhere.
 */
export async function loadRuledOutPairKeys(): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("customer_identity_rulings")
    .select("pair_key")
    .is("withdrawn_at", null);
  if (error) throw new Error(`customer-identity: reading rulings failed — ${error.message}`);
  return new Set((data ?? []).map((row) => String((row as { pair_key: string }).pair_key)));
}

/** Rows already on a master — settled, so never offered again. */
export async function loadLinkedSourceIds(): Promise<Set<string>> {
  const admin = getSupabaseAdmin();
  const out = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("customer_identity_links")
      .select("source, source_id")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`customer-identity: reading links failed — ${error.message}`);
    const rows = (data ?? []) as Array<{ source: string; source_id: string }>;
    for (const row of rows) out.add(`${row.source}:${row.source_id}`);
    if (rows.length < PAGE) return out;
  }
}

/**
 * What the review screen shows.
 *
 * Clustered rather than listed flat, because production holds 543 exact-name groups: a flat list
 * of pairs makes the owner decide the same name four times, where a cluster is one decision about
 * one person. The cluster carries its pairs so his bulk confirm has something exact to act on.
 */
export async function loadIdentitySuggestions(
  options: { kind?: IdentityKind | null; limit?: number } = {},
): Promise<{ clusters: SuggestionCluster[]; totalPairs: number; totalClusters: number }> {
  const [candidates, ruledOut, linkedSourceIds] = await Promise.all([
    loadIdentityCandidates(),
    loadRuledOutPairKeys(),
    loadLinkedSourceIds(),
  ]);

  const wanted = options.kind ? candidates.filter((row) => row.kind === options.kind) : candidates;
  const pairs = suggestIdentityPairs(wanted, { linkedSourceIds, ruledOut });

  const byCluster = new Map<string, SuggestionCluster>();
  for (const pair of pairs) {
    const key = `${pair.kind}|${pair.left.name}`;
    const found = byCluster.get(key);
    if (found) found.pairs.push(pair);
    else byCluster.set(key, { key, kind: pair.kind, name: pair.left.name, pairs: [pair] });
  }

  const clusters = [...byCluster.values()];
  const limit = options.limit && options.limit > 0 ? options.limit : 100;
  return { clusters: clusters.slice(0, limit), totalClusters: clusters.length, totalPairs: pairs.length };
}
