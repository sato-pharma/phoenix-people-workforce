import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  DistributorCodePair,
  EvidenceBand,
  IdentityCandidate,
  IdentityKind,
  IdentityMasterSummary,
  IdentityProfile,
  IdentityProfileRow,
  IdentityProfileRuling,
  IdentitySource,
} from "@/lib/customer-identity/types";

/**
 * Customer 360 for ONE master — everything the four systems know about one person or one shop,
 * assembled from the links the Super Admin confirmed.
 *
 * 🔴 THIS IS THE PAGE THE EXISTING `customer-360` SAYS CANNOT BE BUILT, AND IT IS NOT A SECOND
 * COPY OF IT. That page opens on a PHARMACY and its own header explains why it shows no CRM
 * visits: "the names do not meet ours — 1 of 330 marketing pharmacy names and 0 of 52
 * direct-order names match a CRM pharmacy name … there is no pharmacy-level CRM join to build."
 * Wave 2 is that join, made by a person rather than by a name match, and this page opens on the
 * MASTER rather than on one register — so it reaches a doctor too, which the other cannot.
 *
 * 🔴 IT READS THE LINKS AND NOTHING ELSE. Nothing here infers, matches or scores: every row on the
 * page is on it because somebody confirmed it, and the band and the confirming name travel with
 * each one so a reader can see how good the evidence was and who agreed. A row whose source has
 * since gone is shown as MISSING rather than dropped — a link quietly disappearing is how a page
 * starts lying about what was decided.
 */

type Row = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value);
}

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The rows of ONE source, by their own ids — never the whole register. */
async function readSource(source: IdentitySource, ids: readonly string[]): Promise<Map<string, IdentityCandidate>> {
  const out = new Map<string, IdentityCandidate>();
  if (ids.length === 0) return out;
  const admin = getSupabaseAdmin();

  if (source === "phoenix_crm") {
    const { data, error } = await admin
      .from("phoenix_crm_customers")
      .select("id, name, speciality, list_type, reference_contact_crm_id")
      .in("id", [...ids]);
    if (error) throw new Error(`customer-identity: reading phoenix_crm_customers failed — ${error.message}`);
    for (const row of (data ?? []) as Row[]) {
      const kind = text(row.list_type).toUpperCase();
      out.set(String(row.id), {
        contactCrmId: num(row.reference_contact_crm_id),
        kind: (kind === "AM" ? "AM" : "PM") as IdentityKind,
        name: text(row.name),
        source,
        sourceId: String(row.id),
        speciality: text(row.speciality) || null,
      });
    }
    return out;
  }

  if (source === "ireports360") {
    const { data, error } = await admin
      .from("crm_contacts")
      .select("contact_crm_id, name, name_ar, speciality, phone, zone, crm_region_name, brick_id")
      .in("contact_crm_id", ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)));
    if (error) throw new Error(`customer-identity: reading crm_contacts failed — ${error.message}`);
    for (const row of (data ?? []) as Row[]) {
      out.set(String(row.contact_crm_id), {
        brickCode: text(row.brick_id) || null,
        contactCrmId: num(row.contact_crm_id),
        // The Arabic name is the one a rep and a pharmacist actually use — the same preference the
        // candidate reader makes, so one row does not read two ways on two screens.
        kind: "PM",
        name: text(row.name_ar) || text(row.name),
        phone: text(row.phone) || null,
        regionCode: text(row.crm_region_name) || text(row.zone) || null,
        source,
        sourceId: String(row.contact_crm_id),
        speciality: text(row.speciality) || null,
      });
    }
    return out;
  }

  if (source === "marketing") {
    // The codes live in their own table here too, and only the MASTER-RESOLVED pair is read —
    // `mapped_*`, never the raw code the desk typed and never the desk's bigint distributor id.
    // The reasoning and the two measurements behind it are on `marketingCodesByPharmacy` in
    // ./reads.ts; this is that same rule for one pharmacy at a time, so the 360 view shows exactly
    // the codes the engine could match on and never one it could not have used.
    const [{ data, error }, { data: codeRows, error: codeError }] = await Promise.all([
      admin
        .from("marketing_pharmacies")
        .select("id, display_name, region_name, captured_latitude, captured_longitude")
        .in("id", [...ids]),
      admin
        .from("marketing_pharmacy_distributor_codes")
        .select("pharmacy_id, mapped_distributor_code, mapped_customer_code, active")
        .in("pharmacy_id", [...ids]),
    ]);
    if (error) throw new Error(`customer-identity: reading marketing_pharmacies failed — ${error.message}`);
    if (codeError) {
      throw new Error(`customer-identity: reading marketing_pharmacy_distributor_codes failed — ${codeError.message}`);
    }

    const codes = new Map<string, DistributorCodePair[]>();
    for (const row of (codeRows ?? []) as Row[]) {
      // A withdrawn code is not evidence. The sweep in reads.ts gets this from `pageActive`; here
      // the filter has to be written out, because this read is keyed by pharmacy and not by active.
      if (row.active !== true) continue;
      const pharmacyId = text(row.pharmacy_id);
      const distributorId = text(row.mapped_distributor_code);
      const code = text(row.mapped_customer_code);
      if (!pharmacyId || !distributorId || !code) continue;
      const pairs = codes.get(pharmacyId) ?? [];
      pairs.push({ code, distributorId });
      codes.set(pharmacyId, pairs);
    }

    for (const row of (data ?? []) as Row[]) {
      out.set(String(row.id), {
        distributorPairs: codes.get(String(row.id)) ?? [],
        kind: "pharmacy",
        lat: num(row.captured_latitude),
        lon: num(row.captured_longitude),
        name: text(row.display_name),
        regionCode: text(row.region_name) || null,
        source,
        sourceId: String(row.id),
      });
    }
    return out;
  }

  // 🔴 THE CODES COME FROM THE CHILD TABLE. `direct_order_pharmacies.distributor_code` and
  //    `.distributor_customer_code` are dead columns — empty on all 131 production rows, against
  //    108 rows in `direct_order_pharmacy_distributor_codes` covering 104 of those pharmacies.
  //    Reading the parent would have shown a blank code on every direct-order card in the 360 view
  //    and raised no error at all. `tests/direct-order-pharmacy-dead-distributor-columns` pins it.
  const [{ data, error }, { data: codeRows, error: codeError }] = await Promise.all([
    admin.from("direct_order_pharmacies").select("id, pharmacy_name, brick_id, region_code, crm_contact_id").in("id", [...ids]),
    admin
      .from("direct_order_pharmacy_distributor_codes")
      .select("pharmacy_id, distributor_code, customer_code")
      .in("pharmacy_id", [...ids]),
  ]);
  if (error) throw new Error(`customer-identity: reading direct_order_pharmacies failed — ${error.message}`);
  if (codeError) {
    throw new Error(`customer-identity: reading direct_order_pharmacy_distributor_codes failed — ${codeError.message}`);
  }

  const codes = new Map<string, DistributorCodePair[]>();
  for (const row of (codeRows ?? []) as Row[]) {
    const pharmacyId = text(row.pharmacy_id);
    // `distributor_code` is WHOSE numbering it is; `customer_code` is the code itself. Read the
    // other way round, every shop at one distributor reads as one shop.
    const distributorId = text(row.distributor_code);
    const code = text(row.customer_code);
    if (!pharmacyId || !distributorId || !code) continue;
    const pairs = codes.get(pharmacyId) ?? [];
    pairs.push({ code, distributorId });
    codes.set(pharmacyId, pairs);
  }

  for (const row of (data ?? []) as Row[]) {
    out.set(String(row.id), {
      brickCode: text(row.brick_id) || null,
      contactCrmId: num(row.crm_contact_id),
      distributorPairs: codes.get(String(row.id)) ?? [],
      kind: "pharmacy",
      name: text(row.pharmacy_name),
      regionCode: text(row.region_code) || null,
      source,
      sourceId: String(row.id),
    });
  }
  return out;
}

export async function loadIdentityProfile(masterId: string): Promise<IdentityProfile | null> {
  const admin = getSupabaseAdmin();
  const { data: masterRow, error: masterError } = await admin
    .from("customer_identity_masters")
    .select("id, kind, display_name, created_at, created_by_hr_id")
    .eq("id", masterId)
    .maybeSingle();
  if (masterError) throw new Error(`customer-identity: reading the master failed — ${masterError.message}`);
  if (!masterRow) return null;
  const master = masterRow as Row;

  const [{ data: linkRows, error: linkError }, { data: eventRows, error: eventError }] = await Promise.all([
    admin
      .from("customer_identity_links")
      .select("source, source_id, kind, band, confirmed_at, confirmed_by_hr_id")
      .eq("master_id", masterId)
      .order("confirmed_at", { ascending: true }),
    admin
      .from("customer_identity_events")
      .select("at, actor_hr_id, event, detail")
      .eq("master_id", masterId)
      .order("at", { ascending: false }),
  ]);
  if (linkError) throw new Error(`customer-identity: reading the links failed — ${linkError.message}`);
  if (eventError) throw new Error(`customer-identity: reading the events failed — ${eventError.message}`);

  const links = (linkRows ?? []) as Row[];
  const events = (eventRows ?? []) as Row[];

  const bySource = new Map<IdentitySource, string[]>();
  for (const link of links) {
    const source = text(link.source) as IdentitySource;
    const held = bySource.get(source) ?? [];
    held.push(text(link.source_id));
    bySource.set(source, held);
  }
  const fetched = await Promise.all([...bySource].map(async ([source, ids]) => [source, await readSource(source, ids)] as const));
  const candidates = new Map(fetched);

  const names = await loadPeopleNames([
    text(master.created_by_hr_id),
    ...links.map((link) => text(link.confirmed_by_hr_id)),
    ...events.map((event) => text(event.actor_hr_id)),
  ]);

  const rows: IdentityProfileRow[] = links.map((link) => {
    const source = text(link.source) as IdentitySource;
    const sourceId = text(link.source_id);
    const found = candidates.get(source)?.get(sourceId);
    return {
      band: text(link.band) as EvidenceBand,
      confirmedAt: iso(link.confirmed_at),
      confirmedBy: nameOf(names, text(link.confirmed_by_hr_id)),
      missing: !found,
      // A row whose source has gone still has to appear, and has to say what it was: a link that
      // silently disappears turns "this was decided" into "this never happened".
      ...(found ?? {
        kind: text(link.kind) as IdentityKind,
        name: "This row is no longer in its own system",
        source,
        sourceId,
      }),
    };
  });

  // Live rulings touching any row on this master — a "not the same" that a later reader needs to
  // see, because it is the reason a row he expects is absent.
  const pairHalves = rows.map((row) => `${row.source}:${row.sourceId}`);
  const ruledApart: IdentityProfileRuling[] = [];
  if (pairHalves.length > 0) {
    const { data: rulingRows, error: rulingError } = await admin
      .from("customer_identity_rulings")
      .select("pair_key, reason, ruled_at, ruled_by_hr_id")
      .is("withdrawn_at", null)
      .eq("kind", text(master.kind));
    if (rulingError) throw new Error(`customer-identity: reading the rulings failed — ${rulingError.message}`);
    const mine = new Set(pairHalves);
    const actorIds = new Set<string>();
    for (const row of (rulingRows ?? []) as Row[]) {
      const key = text(row.pair_key);
      if (![...mine].some((half) => key.includes(half))) continue;
      actorIds.add(text(row.ruled_by_hr_id));
      ruledApart.push({
        pairKey: key,
        reason: text(row.reason) || "No reason was recorded.",
        ruledAt: iso(row.ruled_at),
        ruledBy: text(row.ruled_by_hr_id),
      });
    }
    if (ruledApart.length > 0) {
      const rulingNames = await loadPeopleNames([...actorIds]);
      for (const ruling of ruledApart) ruling.ruledBy = nameOf(rulingNames, ruling.ruledBy);
    }
  }

  return {
    createdAt: iso(master.created_at),
    createdBy: nameOf(names, text(master.created_by_hr_id)),
    displayName: text(master.display_name),
    events: events.map((event) => ({
      actor: nameOf(names, text(event.actor_hr_id)),
      at: iso(event.at),
      detail: event.detail === null || event.detail === undefined ? null : JSON.stringify(event.detail),
      event: text(event.event),
    })),
    kind: text(master.kind) as IdentityKind,
    masterId,
    rows,
    ruledApart,
  };
}

/** The masters a reader can open, newest first — the way in when there is no link to follow. */
export async function listIdentityMasters(limit = 100): Promise<IdentityMasterSummary[]> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("customer_identity_masters")
    .select("id, kind, display_name, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`customer-identity: listing the masters failed — ${error.message}`);
  const masters = (data ?? []) as Row[];
  if (masters.length === 0) return [];

  const { data: linkRows, error: linkError } = await admin
    .from("customer_identity_links")
    .select("master_id")
    .in("master_id", masters.map((row) => String(row.id)));
  if (linkError) throw new Error(`customer-identity: counting the links failed — ${linkError.message}`);
  const counts = new Map<string, number>();
  for (const row of (linkRows ?? []) as Row[]) {
    const id = text(row.master_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return masters.map((row) => ({
    displayName: text(row.display_name),
    kind: text(row.kind) as IdentityKind,
    links: counts.get(String(row.id)) ?? 0,
    masterId: String(row.id),
  }));
}
