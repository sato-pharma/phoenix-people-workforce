import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseVenueContactId } from "../src/lib/direct-orders/venue-contact-options.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A direct order could not reach the rep's CRM contact list, and no matcher could fix it.
//
// `contact-trade.ts` badges a row on a rep's CRM contact list when Phoenix has traded with it. It
// has three rules in order: an explicit CRM id wins outright; else an exact name in the same sales
// area; else a prefix unique in that area. Marketing fires RULE 1, because
// `marketing_customer_contacts.crm_code` carries an id a human wrote down. The direct-order branch
// hardcoded `contactCrmId: null`, so it could only ever reach the two INFERRED rules.
//
// MEASURED AGAINST PRODUCTION, 2026-09-03: of 63 live direct-order venues, exactly ONE linked.
//
// The tempting diagnosis is the area gate, and it really is starved — 759 of 1,872 CRM pharmacies
// (41%) resolve to no area at all. That diagnosis is WRONG, and the ceiling settles it: drop the
// area gate entirely and ask only whether a venue name has ANY twin among all 1,872 CRM pharmacies
// and the answer is 4. Four exact, zero prefix. A company-wide brick-resolution drive would have
// moved this from 1 to at most 4 of 63. The names do not meet — a rep types a venue into an order
// form and the CRM holds a different string for the same shop.
//
// So the gap was a MISSING DECLARATION. The venue now carries the contact the submitter picked.
//
// WHAT THIS FILE GUARDS, and why each part was nearly got wrong:
//   · THE SCOPE IS SELF **UNION** SUBTREE. Venue creators are almost entirely District Sales
//     Managers — 10 of 12 people, 63 of 72 venues — and a DM's own CRM account holds NO contact
//     list; the lists belong to the reps beneath. Self alone offers nothing for 63 of 72. Subtree
//     alone drops the Medical Rep registering her own venue, because `isWithinManagerHierarchy`
//     answers "is this person BELOW the viewer" and is false for the viewer.
//   · THE WRITE IS GATED BY THE SAME SCOPE. Offering one district's contacts while accepting any
//     id in the CRM would let a wrong id put "1 direct order" on the list of a rep who never sold
//     to them. A false trade record is the direction that is not recoverable.
//   · THE MAIN VENUE SELECT MUST NOT NAME THE NEW COLUMN. A deploy applies NO migrations, so
//     between shipping and applying there is a window where the column does not exist — and
//     `isCrmSchemaMissingError` deliberately refuses to swallow 42703. Naming it in the main
//     projection would 500 the whole CRM contact board for every rep during that window.
//   · THE RPC'S venue_type WHITELIST SURVIVES. The live definition maps anything that is not
//     'nursery' to 'pharmacy'. Rewriting the function to add a column is exactly when that gets
//     "simplified" into a pass-through that lets any string reach the column.
//   · THE LINK IS OPTIONAL. The 2026-08-04 owner rule: refusing a field the submitter cannot
//     answer does not produce a correct value, it produces an invented one ("000000").
// ─────────────────────────────────────────────────────────────────────────────

// Comments are stripped before the class sweep: that pin is about CLASSES, not prose, and the
// comment explaining why this picker wraps says the word "truncation". The `[^:]` guard keeps a
// `https://` URL from reading as the start of a line comment — same shape as the dead-column sweep.
function stripSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

export function runDirectOrderVenueCrmContactLinkTests() {
  const read = (relativePath: string) =>
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

  const migration = read("supabase/migrations/20260903193000_direct_order_venue_crm_contact_link.sql");
  const options = read("src/lib/direct-orders/venue-contact-options.ts");
  const service = read("src/lib/direct-orders/service.ts");
  const trade = read("src/lib/crm/contact-trade.ts");
  const route = read("app/api/direct-orders/pharmacies/route.ts");
  const contactsRoute = read("app/api/direct-orders/crm-contacts/route.ts");
  const form = read("src/components/direct-orders/direct-order-submit-form.tsx");
  const picker = read("src/components/direct-orders/crm-contact-picker.tsx");

  // ── 1. "Not declared" must never be an error ──────────────────────────────
  //
  // Every one of these is a real client shape: an untouched picker sends null, a cleared one sends
  // "", and a form library can hand back "abc" or a float. All of them mean the same thing.
  for (const empty of [null, undefined, "", "   ", "abc", "12.5", 0, -1, "0", "-4", Number.NaN]) {
    assert.equal(
      parseVenueContactId(empty),
      null,
      `parseVenueContactId(${JSON.stringify(empty)}) must read as "not declared", never throw or coerce — ` +
        "the picker is optional, and a malformed value must not fail the whole registration",
    );
  }
  assert.equal(parseVenueContactId(48291), 48291, "a real contact id must survive as a number");
  assert.equal(parseVenueContactId("48291"), 48291, "a numeric string from a form must parse");
  assert.equal(parseVenueContactId(" 48291 "), 48291, "surrounding whitespace must not defeat the parse");

  // ── 2. The scope is self UNION subtree ────────────────────────────────────
  {
    const start = options.indexOf("export async function resolveVenueContactScope");
    const end = options.indexOf("\n/**", start + 1);
    assert.ok(start > -1 && end > start, "resolveVenueContactScope must be findable");
    const body = options.slice(start, end);
    assert.match(
      body,
      /new Set<string>\(\[access\.hrId!?\.trim\(\)\]\)/,
      "the viewer's OWN hr id must seed the allow-list — isWithinManagerHierarchy is false for the " +
        "viewer themselves, so a subtree-only scope hands a Medical Rep an empty picker of her own list",
    );
    assert.match(
      body,
      /basis:\s*"team"/,
      "the subtree half must still be resolved through getManagerScope — the org walk is shared with " +
        "the security-sensitive boards and must not be reimplemented here",
    );
    assert.match(
      body,
      /subtree\.kind === "agents"/,
      'a subtree of "none" must be tolerated, not fatal: a Medical Rep has no reports and must still reach her own list',
    );
  }
  assert.match(
    options,
    /doctorListBasisForRole/,
    "company reach must be decided by the same table the Doctor List board uses, so this picker can " +
      "never be silently wider than the board showing the very same contacts",
  );

  // ── 3. The WRITE is gated by the same scope as the READ ───────────────────
  {
    const start = service.indexOf("export async function createDirectOrderPharmacy(");
    const end = service.indexOf("\nexport ", start + 1);
    assert.ok(start > -1 && end > start, "createDirectOrderPharmacy must be findable");
    const body = service.slice(start, end);
    assert.match(
      body,
      /await assertVenueContactInScope\(access, crmContactId\)/,
      "a declared contact must be checked against the submitter's OWN reach before it is stored — " +
        "without this the picker is decoration and any id in the CRM is accepted",
    );
    const gate = body.indexOf("assertVenueContactInScope");
    const write = body.indexOf('supabase.rpc("phx_create_direct_order_pharmacy"');
    assert.ok(gate > -1 && write > gate, "the scope check must run BEFORE the row is written, not after");
    assert.match(body, /crm_contact_id: crmContactId/, "the declared contact must actually reach the RPC");
  }
  assert.match(
    options,
    /export async function assertVenueContactInScope/,
    "the write gate must exist as its own exported function, so the route and the service share one answer",
  );

  // ── 4. The deploy-before-migration window must not 500 the contact board ──
  {
    const start = trade.indexOf("export async function loadTradeCounterparties");
    const end = trade.length;
    const body = trade.slice(start, end);
    assert.doesNotMatch(
      body,
      /select\("id, pharmacy_name, area_code[^"]*crm_contact_id/,
      "the MAIN venue projection must not name crm_contact_id — a deploy applies no migrations, and " +
        "isCrmSchemaMissingError deliberately refuses to swallow a missing column, so this would 500 " +
        "the whole CRM contact board until the migration was applied",
    );
    assert.match(
      body,
      /declaredContacts\.get\(row\.id\) \?\? null/,
      "the direct-order branch must pass the DECLARED contact — hardcoding null is the original bug, " +
        "and it is what limited the link to 1 of 63 venues",
    );
  }
  assert.match(
    trade,
    /42703\|PGRST204/,
    "the declared-contact read must tolerate a MISSING COLUMN specifically, and only that read — " +
      "before the migration is applied, 'no venue has declared a contact' is the true answer",
  );
  assert.doesNotMatch(
    trade,
    /contactCrmId: null,\s*\n\s*count: counted\.total,\s*\n\s*name: row\.pharmacy_name/,
    "the direct-order counterparty must no longer hardcode contactCrmId: null",
  );

  // ── 5. The RPC gains the column and keeps the venue_type WHITELIST ────────
  assert.match(
    migration,
    /add column if not exists crm_contact_id bigint/,
    "the declaration column must be added, and as bigint to match ireports360_contacts.contact_crm_id",
  );
  assert.match(
    migration,
    /check \(crm_contact_id is null or crm_contact_id > 0\)/,
    "zero and negatives are a caller that parsed a blank field into a number, not an 'unknown' contact",
  );
  assert.match(
    migration,
    /when lower\(btrim\(coalesce\(p_pharmacy->>'venue_type', ''\)\)\) = 'nursery' then 'nursery'\s*\n\s*else 'pharmacy'/,
    "the venue_type WHITELIST from the live definition must survive this rewrite — relaxing it to a " +
      "coalesce pass-through would let any string reach a NOT NULL column with a fixed vocabulary",
  );
  assert.match(
    migration,
    /'pending_review',\s*\n\s*'manual',/,
    "the RPC must still PIN the review state — declaring a CRM contact is not evidence and must not " +
      "shorten the approval chain (owner rule, 2026-08-04)",
  );
  assert.ok(
    migration.indexOf("grant execute on function public.phx_create_direct_order_pharmacy") >
      migration.lastIndexOf("revoke all on function public.phx_create_direct_order_pharmacy"),
    "the service_role grant must come AFTER the revokes — revoking from PUBLIC on a default ACL " +
      "strips service_role, and the RPC then fails in production only",
  );
  assert.match(
    migration,
    /case when v_crm_contact_id is null then null\s*\n\s*else nullif/,
    "the author stamp must only be written when a link was actually declared — an author with no " +
      "link would be a value that cannot say what it refers to",
  );
  // No foreign key: ireports360_contacts is a per-agent LIST, not a registry, and 47% of visited
  // contacts are absent from it. An FK would refuse or delete a link that is still correct.
  assert.doesNotMatch(
    migration,
    /references public\.ireports360_contacts/,
    "crm_contact_id must NOT carry a foreign key to the contact mirror — it is a per-agent list, not a registry",
  );

  // ── 6. The form declares it, and the route carries it ─────────────────────
  assert.match(form, /<CrmContactPicker\b/, "the venue form must actually render the picker");
  assert.match(
    form,
    /crmContactId: crmContact\?\.contactCrmId \?\? null/,
    "the picked contact must reach the POST body, or the picker changes nothing",
  );
  assert.match(
    route,
    /crmContactId: body\.crmContactId \?\? null/,
    "the pharmacies route must pass the declared contact through to the service",
  );
  assert.match(
    contactsRoute,
    /listVenueContactOptions\(access, \{ search, limit \}\)/,
    "the picker's own route must go through the service, which is where the scope is resolved",
  );
  assert.doesNotMatch(
    contactsRoute,
    /searchParams\.get\("(hrId|agent|scope|role)"\)/,
    "the scope must come from the live AccessContext, never from a query parameter — a scope read " +
      "off the URL is not a scope",
  );

  // ── 7. Privacy and house style ────────────────────────────────────────────
  {
    // The two places a phone could actually reach a client: the wire type, and the SELECT. A bare
    // word sweep is the wrong test here — `toOption` legitimately writes `phone: null` to satisfy
    // the DoctorListRow shape it borrows, and the header says the word to explain the decision.
    const typeStart = options.indexOf("export type VenueContactOption = {");
    const typeEnd = options.indexOf("};", typeStart);
    assert.ok(typeStart > -1 && typeEnd > typeStart, "VenueContactOption must be findable");
    assert.doesNotMatch(
      options.slice(typeStart, typeEnd),
      /phone/,
      "VenueContactOption must not carry a phone number — picking which shop a venue is does not " +
        "need one, and the narrower the projection the less a widened scope could ever leak",
    );
    const selectStart = options.indexOf("const SELECT_COLUMNS");
    const selectEnd = options.indexOf(";", selectStart);
    assert.ok(selectStart > -1 && selectEnd > selectStart, "SELECT_COLUMNS must be findable");
    assert.doesNotMatch(
      options.slice(selectStart, selectEnd),
      /phone/,
      "the scoped contact read must not even SELECT the phone column",
    );
  }
  const pickerClasses = stripSourceComments(picker);
  assert.doesNotMatch(
    pickerClasses,
    /\btruncate\b|\btext-ellipsis\b|\boverflow-x-auto\b/,
    "no ellipsis and no horizontal scroll — the owner's ellipsis ban and the FITS-THE-SCREEN golden " +
      "rule both apply, and an address is exactly the field needed in full to tell two shops apart",
  );
  assert.match(
    picker,
    /Optional\./,
    "the form must SAY the link is optional — an unexplained required-looking field is how invented " +
      "values get typed into one",
  );
}
