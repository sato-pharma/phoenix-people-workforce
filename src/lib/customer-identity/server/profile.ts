import { parseCrmContactCode } from "@/lib/crm/contact-code";
import { marketingCustomerHubKind } from "@/lib/customer-360/validated";
import { othersOnMaster } from "@/lib/customer-identity/suggestions";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type {
  AlsoKnownAs,
  AlsoKnownAsRow,
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

  // 🔴 A TYPED NAME HAS NO TABLE, SO ITS ID IS ITS RECORD. `visit_feedback` ids are `brick|name`,
  //    written that way by `typedPharmacyCandidates` precisely because `customer_identity_links`
  //    stores nothing but the source and the id. It is read back here rather than looked up, and
  //    it can never be `missing`: the name a rep typed is still the name he typed even after the
  //    visit is gone. Falling through to the branches below would hand a non-uuid to
  //    `direct_order_pharmacies` and fail the whole read with a Postgres type error.
  if (source === "visit_feedback") {
    for (const id of ids) {
      const bar = id.indexOf("|");
      const where = bar === -1 ? "" : id.slice(0, bar);
      const name = bar === -1 ? id : id.slice(bar + 1);
      out.set(id, {
        brickCode: where || null,
        kind: "pharmacy",
        name,
        source,
        sourceId: id,
      });
    }
    return out;
  }

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
        // IdentityKind has carried "pharmacy" all along; a Phoenix pharmacy customer is one.
        kind: (kind === "AM" ? "AM" : kind === "PHARMACY" ? "pharmacy" : "PM") as IdentityKind,
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

  // A marketing customer is a doctor or an account, never a pharmacy — the same PM/AM split the
  // candidate reader makes (`marketingCustomerHubKind`), so one row never reads two ways.
  if (source === "marketing_customer") {
    const [{ data, error }, { data: contactRows, error: contactError }] = await Promise.all([
      admin
        .from("marketing_customers")
        .select("id, customer_type, display_name, region_name, captured_latitude, captured_longitude")
        .in("id", [...ids]),
      admin.from("marketing_customer_contacts").select("customer_id, crm_code, active").in("customer_id", [...ids]),
    ]);
    if (error) throw new Error(`customer-identity: reading marketing_customers failed — ${error.message}`);
    if (contactError) throw new Error(`customer-identity: reading marketing_customer_contacts failed — ${contactError.message}`);
    const contactIds = new Map<string, number>();
    for (const row of (contactRows ?? []) as Row[]) {
      if (row.active !== true) continue;
      const contactId = parseCrmContactCode(text(row.crm_code));
      const customerId = text(row.customer_id);
      if (customerId && contactId !== null && !contactIds.has(customerId)) contactIds.set(customerId, contactId);
    }
    for (const row of (data ?? []) as Row[]) {
      out.set(String(row.id), {
        contactCrmId: contactIds.get(String(row.id)) ?? null,
        kind: marketingCustomerHubKind(text(row.customer_type)) === "doctor" ? "PM" : "AM",
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

/**
 * What else one row is, for a page that is showing it and knows nothing of this module.
 *
 * 🔴 IT ANSWERS FROM `customer_identity_links` AND NOWHERE ELSE, so it can only ever report what a
 * person confirmed. It never runs the engine, never calls `judgePair`, and never sees a
 * suggestion: a borrowing page therefore cannot accidentally print a maybe as though it were
 * settled, whatever it does with the result.
 *
 * 🔴 NULL IS THE ORDINARY ANSWER, AND MEANS "NOT LINKED", NEVER "NOT THE SAME". A row sitting on
 * no master is simply a row nobody has been asked about yet — on production today that is almost
 * all of them — and a caller that renders an empty section for it would be announcing an absence
 * the owner never stated. Null is also returned for a master holding this row alone, which the
 * decide path cannot create but a withdrawal could leave behind.
 *
 * 🔴 THE ROW ASKED ABOUT IS REMOVED FROM THE ANSWER. "Also known as" is the OTHERS; echoing the
 * caller's own row back is how a one-link master renders as a pharmacy that is also itself.
 */
export async function loadAlsoKnownAs(source: IdentitySource, sourceId: string): Promise<AlsoKnownAs | null> {
  const id = (sourceId ?? "").trim();
  if (!id) return null;

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from("customer_identity_links")
    .select("master_id")
    .eq("source", source)
    .eq("source_id", id)
    .maybeSingle();
  // A page borrowing this must not die because the identity module had a bad day: a 360 view that
  // renders without its "also known as" is still the page, and one that 500s is not.
  if (error) throw new Error(`customer-identity: reading the link for ${source} failed — ${error.message}`);
  const masterId = text((data as Row | null)?.master_id);
  if (!masterId) return null;

  const profile = await loadIdentityProfile(masterId);
  if (!profile) return null;

  const others = othersOnMaster(profile.rows, source, id)
    .map((row) => ({
      kind: row.kind,
      missing: row.missing,
      name: row.name,
      source: row.source,
      sourceId: row.sourceId,
    }));
  if (others.length === 0) return null;

  return { displayName: profile.displayName, masterId: profile.masterId, others };
}

/**
 * The same answer for MANY rows at once, for a screen that lists rows rather than opening one.
 *
 * 🔴 IT EXISTS BECAUSE THE PICKER SEARCHES ON EVERY KEYSTROKE. Calling `loadAlsoKnownAs` per hit
 * would be thirty round trips per letter typed, and each one loads a master's whole history —
 * its events, its rulings and the name of everyone who ever touched it — to print one line. This
 * is four queries however many rows are handed in, and reads only what a label needs.
 *
 * 🔴 IT IS STILL CONFIRMED-ONLY, and silence still means "nobody has been asked". A source id
 * missing from the returned map is a row on no master, never a row somebody ruled apart.
 */
export async function loadAlsoKnownAsBatch(
  source: IdentitySource,
  sourceIds: readonly string[],
): Promise<Map<string, AlsoKnownAsRow[]>> {
  const out = new Map<string, AlsoKnownAsRow[]>();
  const ids = [...new Set(sourceIds.map((id) => (id ?? "").trim()).filter(Boolean))];
  if (ids.length === 0) return out;

  const admin = getSupabaseAdmin();
  const mine: Row[] = [];
  for (let at = 0; at < ids.length; at += 150) {
    const { data, error } = await admin
      .from("customer_identity_links")
      .select("master_id, source_id")
      .eq("source", source)
      .in("source_id", ids.slice(at, at + 150));
    if (error) throw new Error(`customer-identity: reading the links failed — ${error.message}`);
    mine.push(...((data ?? []) as Row[]));
  }
  if (mine.length === 0) return out;

  const masterOf = new Map<string, string>();
  for (const row of mine) masterOf.set(text(row.source_id), text(row.master_id));
  const masterIds = [...new Set([...masterOf.values()])];

  const members: Row[] = [];
  for (let at = 0; at < masterIds.length; at += 150) {
    const { data, error } = await admin
      .from("customer_identity_links")
      .select("master_id, source, source_id, kind")
      .in("master_id", masterIds.slice(at, at + 150));
    if (error) throw new Error(`customer-identity: reading the master's links failed — ${error.message}`);
    members.push(...((data ?? []) as Row[]));
  }

  // One read per SOURCE rather than one per row — `readSource` already batches by id.
  const idsBySource = new Map<IdentitySource, string[]>();
  for (const member of members) {
    const memberSource = text(member.source) as IdentitySource;
    const held = idsBySource.get(memberSource) ?? [];
    held.push(text(member.source_id));
    idsBySource.set(memberSource, held);
  }
  const resolved = new Map(
    await Promise.all([...idsBySource].map(async ([one, list]) => [one, await readSource(one, list)] as const)),
  );

  const byMaster = new Map<string, AlsoKnownAsRow[]>();
  for (const member of members) {
    const memberSource = text(member.source) as IdentitySource;
    const memberId = text(member.source_id);
    const found = resolved.get(memberSource)?.get(memberId);
    const held = byMaster.get(text(member.master_id)) ?? [];
    held.push({
      kind: text(member.kind) as IdentityKind,
      missing: !found,
      // A row whose source has gone still has to appear and still has to say something; its own
      // id is the only honest label left, exactly as the single-row reader does.
      name: found?.name ?? memberId,
      source: memberSource,
      sourceId: memberId,
    });
    byMaster.set(text(member.master_id), held);
  }

  for (const [sourceId, masterId] of masterOf) {
    const others = othersOnMaster(byMaster.get(masterId) ?? [], source, sourceId);
    if (others.length > 0) out.set(sourceId, others);
  }
  return out;
}
