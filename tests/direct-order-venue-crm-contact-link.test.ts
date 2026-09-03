import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canManagePharmacyRegistry } from "../src/lib/direct-orders/registry-access.ts";
import { parseVenueContactId } from "../src/lib/direct-orders/venue-contact-options.ts";
import type { AccessContext } from "../src/lib/auth/permissions.ts";

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
  const registryAccess = read("src/lib/direct-orders/registry-access.ts");
  const registryRoute = read("app/api/direct-orders/pharmacies/registry/route.ts");
  const manager = read("src/components/direct-orders/pharmacy-registry-manager.tsx");

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

  // ── 8. THE RETROACTIVE DOOR — the admin registry ──────────────────────────
  //
  // The submit form only ever reaches a venue it is CREATING. Every venue registered before
  // 2026-09-03 carries no link, because the column did not exist when it was created, and a rep
  // cannot edit an existing venue at all. Measured on production the morning this shipped: 74
  // venues, 0 declared. Without an admin door those 74 stay unlinked permanently, and the feature
  // only ever helps venues that do not exist yet.
  //
  // THE PERMISSION IS THE WHOLE PROBLEM. The picker's own gate was `direct_orders:create`, and the
  // SFE Manager — one of exactly two roles the owner allowed to manage the registry on 2026-08-04 —
  // holds `read, export, approve` and no `create`. Shipping the picker onto the registry without
  // widening that gate would have 403'd it for the very person the registry exists for, and it
  // would have read as a broken page rather than as a permission decision.

  // The gate predicate is a pure function, so this is a real behaviour check rather than a pin.
  const asAccess = (role: string, scope: string): AccessContext =>
    ({ hrId: "a-1", loginId: "a-1", role, scope, source: "session" } as unknown as AccessContext);
  assert.equal(
    canManagePharmacyRegistry(asAccess("SFE Manager", "company")),
    true,
    "the SFE Manager must reach the registry gate — they have no direct_orders:create, and gating the " +
      "picker on create alone would 403 the very role the registry was widened for (owner, 2026-08-04)",
  );
  assert.equal(canManagePharmacyRegistry(asAccess("Super Admin", "system")), true, "a system scope must pass");
  for (const role of ["District Manager", "Medical Rep", "CEO", "National Sales Manager", "Employee"]) {
    assert.equal(
      canManagePharmacyRegistry(asAccess(role, "team")),
      false,
      `${role} must NOT be able to manage the registry — the owner named two roles, and this predicate ` +
        "now gates a SECOND surface, so a quiet widening here would widen both at once",
    );
  }

  // One definition, not a copy. The gate moved out of service.ts precisely so the picker could ask
  // the same question; a re-added local copy is what drifts.
  assert.match(
    registryAccess,
    /export function canManagePharmacyRegistry/,
    "the registry gate must live in its own module — service.ts imports venue-contact-options, so the " +
      "picker importing the gate back out of service.ts would close an import cycle",
  );
  assert.doesNotMatch(
    service,
    /(function|const) canManagePharmacyRegistry/,
    "service.ts must IMPORT the gate, never redeclare it — two copies of a role list drift, and the " +
      "drift is silent because both compile",
  );
  {
    const start = options.indexOf("async function assertMayDeclareVenueContact");
    const end = options.indexOf("\n}", start);
    assert.ok(start > -1 && end > start, "assertMayDeclareVenueContact must be findable");
    const body = options.slice(start, end);
    assert.match(
      body,
      /if \(canManagePharmacyRegistry\(access\)\) return;/,
      "a registry manager must reach the picker WITHOUT direct_orders:create",
    );
    assert.match(
      body,
      /await assertPermission\(access, "direct_orders", "create"\)/,
      "everyone else must still be held to direct_orders:create — the registry roles are an ADDITIONAL " +
        "door, never a replacement for the submit form's authority",
    );
  }
  assert.match(
    options,
    /await assertMayDeclareVenueContact\(access\);/,
    "listVenueContactOptions must OPEN with the gate — an enumerating route whose check sits further " +
      "down is a route that has already done the read",
  );

  // ── 9. The retroactive write must be a PATCH, not an overwrite ────────────
  //
  // "An OPTIONAL field written UNCONDITIONALLY is a silent erase." An admin fixing a venue's address
  // must not clear a CRM link someone else declared, so absence and null have to stay different
  // answers at every layer: the component sends the key only when touched, the route forwards on the
  // KEY's presence, and the service patches on `!== undefined`.
  {
    const start = registryRoute.indexOf('if (body.action === "updateDetails")');
    const end = registryRoute.indexOf('if (body.action === "replaceCodes")', start);
    assert.ok(start > -1 && end > start, "the updateDetails branch must be findable");
    const branch = registryRoute.slice(start, end);
    assert.match(
      branch,
      /\.\.\.\("crmContactId" in body \? \{ crmContactId: body\.crmContactId \} : \{\}\)/,
      "the route must forward the CRM link on the KEY's presence — `body.crmContactId ?? null` would " +
        "clear every link on any other edit, silently, with nothing recording what was lost",
    );
    assert.doesNotMatch(
      branch,
      /crmContactId: body\.crmContactId \?\? null/,
      "the `?? null` form is exactly the silent erase this branch exists to avoid",
    );
  }
  {
    const start = service.indexOf("export async function updateDirectOrderPharmacyDetails");
    const end = service.indexOf("\nexport ", start + 1);
    assert.ok(start > -1 && end > start, "updateDirectOrderPharmacyDetails must be findable");
    const body = service.slice(start, end);
    assert.match(
      body,
      /if \(input\.crmContactId !== undefined\)/,
      "the service must patch on `!== undefined` — a truthiness test makes CLEARING a link impossible",
    );
    assert.match(
      body,
      /await assertVenueContactInScope\(access, crmContactId\)/,
      "the retroactive door must run the SAME write gate as the create path — an admin route that " +
        "accepts any id is how a false trade badge lands on a rep who never sold to the venue",
    );
    const gate = body.indexOf("assertVenueContactInScope");
    const write = body.indexOf("patch.crm_contact_id");
    assert.ok(gate > -1 && write > gate, "the scope check must run BEFORE the patch is assembled");
    assert.match(
      body,
      /patch\.crm_contact_linked_by_hr_id = crmContactId === null \? null : /,
      "clearing a link must clear its author too — an author with no link is a value that cannot say " +
        "what it refers to, and it would outlive the fact it recorded",
    );
    assert.match(
      body,
      /patch\.crm_contact_linked_at = crmContactId === null \? null : /,
      "clearing a link must clear its timestamp, for the same reason",
    );
    assert.match(
      body,
      /crm_contact_id, crm_contact_linked_by_hr_id, crm_contact_linked_at/,
      "the before-image must READ the three columns, or the audit row records a change it cannot describe",
    );
  }

  // ── 10. The admin board: names, never ids, and no unintended clear ────────
  assert.match(manager, /<CrmContactPicker\b/, "the registry must actually render the picker");
  assert.match(
    manager,
    /editContactTouched \? \{ crmContactId: editContact\?\.contactCrmId \?\? null \} : \{\}/,
    "the edit form must send the link ONLY when it was touched — sending it on every save would clear " +
      "a link the board could not NAME (a contact outside the viewer's reach) purely because the " +
      "picker had nothing to show",
  );
  assert.match(
    manager,
    /crmContactId: newContact\?\.contactCrmId \?\? null/,
    "the register form must declare the link at creation, exactly as the rep's own form does",
  );
  {
    // The owner's rule: a screen shows human-readable names, never raw codes or ids. A bare
    // `crmContactId` is legitimate in the three-state TEST below, so the sweep is for RENDERING one.
    const rendered = stripSourceComments(manager);
    assert.doesNotMatch(
      rendered,
      /\{row\.crmContactId\}|\{r\.crmContactId\}/,
      "the board must never PRINT the raw contact id — it renders the resolved name, and says the link " +
        "is unnameable when it cannot",
    );
    assert.match(
      rendered,
      /row\.crmContactId !== null/,
      "declared-but-unnameable must be its own state — collapsing it into 'not linked' would invite an " +
        "admin to declare a second contact over a link that is still there",
    );
  }
  {
    const start = service.indexOf("export async function listDirectOrderPharmacyRegistry");
    const end = service.indexOf("\n/**", start + 1);
    assert.ok(start > -1 && end > start, "listDirectOrderPharmacyRegistry must be findable");
    const body = service.slice(start, end);
    assert.match(
      body,
      /describeVenueContacts\(/,
      "the registry must resolve its declared links to NAMES server-side — the column holds an id, and " +
        "the owner's rule is that no screen prints one",
    );
  }
  {
    const start = options.indexOf("export async function describeVenueContacts");
    const end = options.indexOf("\n/**", start + 1);
    assert.ok(start > -1 && end > start, "describeVenueContacts must be findable");
    const body = options.slice(start, end);
    assert.match(
      body,
      // Anchored on the closing paren: a bare `index += 50` is a SUBSTRING of `index += 5000`, so
      // the loose form passed while the chunking was disabled — the exact false green this test
      // exists to prevent, caught by breaking it deliberately.
      /index \+= 50\)/,
      "the id lookup must be chunked at 50 — a PostgREST .in() carrying several hundred ids returns " +
        "ZERO rows with NO error, which here would silently unname every link at once",
    );
    assert.match(
      body,
      /scopeAllowsAgent\(scope, record\.agent_hr_id\)/,
      "the label resolver must be scoped like the picker — both registry roles are company TODAY, but " +
        "assuming that is how widening who manages the registry turns this into an unscoped read",
    );
  }

  // ── 11. Validating ONE id must not read the whole table ───────────────────
  {
    const start = options.indexOf("export async function assertVenueContactInScope");
    const body = options.slice(start);
    assert.match(
      body,
      /readContactsById\(contactCrmId\)/,
      "the write gate must ask about the ONE id. Reading the scope and searching it paged through all " +
        "9,698 production contact rows on every save for a company-scoped caller — invisible while only " +
        "District Managers reached this, and the admin registry is exactly the door that IS company-wide",
    );
    assert.doesNotMatch(body, /readScopedContacts\(scope\)/, "the read-then-search form is what this replaced");
  }
}
