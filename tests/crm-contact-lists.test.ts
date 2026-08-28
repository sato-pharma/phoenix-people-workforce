import assert from "node:assert/strict";

import {
  assertContactGridShape,
  CrmWebError,
  LIST_TYPES,
  parseAgentGrid,
  parseContactGrid,
  resolveCrmWebBaseUrl,
} from "../src/lib/crm/contacts-web-client.ts";
import { contactRowKey, decideContactReplacement } from "../src/lib/crm/contacts-sync.ts";
import {
  EXPECTED_PM_MAX,
  EXPECTED_PM_MIN,
  isInExpectedBand,
  toDoctorListRow,
} from "../src/lib/crm/contact-lists.ts";
import { canAccessDoctorList, DOCTOR_LIST_ACCESS_ROLES } from "../src/lib/crm/doctor-list-access.ts";

/**
 * The rep's assigned doctor list, mirrored from the CRM WEB app.
 *
 * ## Why this module exists at all
 *
 * The iReports360 Reporting API has no contacts endpoint — nine swagger paths, none of them a list
 * of who a rep is responsible for. Every CRM board in Phoenix is therefore built from activity
 * (visits, plan entries) and is structurally blind to a doctor who was assigned to a rep and never
 * touched: 448 of them company-wide on the first sweep, 2026-08-28. The list itself lives only in
 * the CRM's own web app, at ContactsList.aspx on a DIFFERENT host from the API.
 *
 * ## The two traps this pins
 *
 * 1. `t=Pharmacy`, never `t=PH`. An unknown list type does NOT error — the web app returns HTTP 200
 *    with a well-formed, empty grid. The first sweep read `t=PH` as "no rep has any pharmacies"
 *    while the agents grid's own counter said 45-59. A silently-empty answer that looks identical
 *    to a true one is exactly the shape that has to be caught by a shape assertion, not by a status
 *    code.
 *
 * 2. An empty answer must never empty the mirror. The CRM returns only LIVE contacts, so "no rows"
 *    is genuinely how a doctor's removal is expressed — and it is also how an expired session, a
 *    vendor outage and a wrong `t=` all look. `decideContactReplacement` refuses to prune when the
 *    fetch came back empty and the mirror holds rows, so the worst case degrades to yesterday's
 *    list rather than to "this rep has no doctors".
 *
 * Both fixtures below are trimmed from the real rendered pages.
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
// Trimmed from a real ContactsList.aspx render: the Telerik grid's header row, two data rows, and
// the pager row that carries no numeric id (which the parser must drop).
const CONTACT_GRID_HTML = `
<html><body>
<table id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00" class="rgMasterTable">
  <tr class="rgHeader">
    <th>ID</th><th>AM/PM</th><th>City</th><th>Zone</th><th>Region</th>
    <th>Contact Name</th><th>Grade</th><th>Spec.</th><th>Contact Name Ar</th>
    <th>phone#</th><th>Address</th>
  </tr>
  <tr class="rgRow" id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00__0">
    <td>101</td><td>PM</td><td>Cairo</td><td>Nasr City</td><td>CA1</td>
    <td>Ahmed Fouad</td><td>A</td><td>Cardiology</td><td>&#1571;&#1581;&#1605;&#1583;</td>
    <td>0100 000 0000</td><td>12 Abbas El Akkad St, Nasr City</td>
  </tr>
  <tr class="rgAltRow" id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00__1">
    <td>102</td><td>PM</td><td>Giza</td><td>Dokki</td><td>GZ2</td>
    <td>Mona Adel &amp; Partners</td><td>&nbsp;</td><td>Pediatrics</td><td>&nbsp;</td>
    <td>&nbsp;</td><td>&nbsp;</td>
  </tr>
  <tr class="rgPager">
    <td>Page 1</td><td>of 1</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
    <td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td>
  </tr>
</table>
</body></html>`;

/** What an unknown `t=` returns: HTTP 200, correct columns, no data rows. The `t=PH` trap. */
const EMPTY_CONTACT_GRID_HTML = `
<html><body>
<table id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00" class="rgMasterTable">
  <tr class="rgHeader">
    <th>ID</th><th>AM/PM</th><th>City</th><th>Zone</th><th>Region</th>
    <th>Contact Name</th><th>Grade</th><th>Spec.</th><th>Contact Name Ar</th>
    <th>phone#</th><th>Address</th>
  </tr>
</table>
</body></html>`;

/** The same grid after a vendor redesign dropped Grade and Address. */
const DRIFTED_CONTACT_GRID_HTML = CONTACT_GRID_HTML.replace("<th>Grade</th>", "<th>Tier</th>").replace(
  "<th>Address</th>",
  "<th>Location</th>",
);

// Trimmed from Agents.aspx. Column order verified live 2026-08-28: the three counters at 1/2/3, the
// account label at 6, title 8, username 9, line 10, the CRM's own active flag at 11, hiring date 12.
const AGENT_GRID_HTML = `
<html><body>
<table id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00">
  <tr id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00__0">
    <td><a href="ContactsList.aspx?t=PM&amp;q=1391">open</a></td>
    <td>104</td><td>12</td><td>47</td><td>x</td><td>y</td>
    <td>Ashraf.Maged ( Mahalla / A )</td><td>z</td><td>Medical Rep</td><td>amaged</td><td>A</td>
    <td>Yes</td><td>2026-04-01</td>
  </tr>
  <tr id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00__1">
    <td><a href="ContactsList.aspx?t=PM&amp;q=1402">open</a></td>
    <td>0</td><td>0</td><td>0</td><td>x</td><td>y</td>
    <td>( Mahalla / E )</td><td>z</td><td>Medical Rep</td><td>vacant</td><td>E</td>
    <td>No</td><td>&nbsp;</td>
  </tr>
  <tr id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00_noLink">
    <td>not a grid row</td><td>1</td><td>2</td><td>3</td>
  </tr>
</table>
</body></html>`;

export function runCrmContactListsTests() {
  // ── 1. The list types are the vendor's spelling, not an abbreviation ───────────────────────────
  // `t=PH` returns a well-formed empty grid, so a wrong value is invisible at the HTTP layer. The
  // constant is the single place the spelling lives; the migration's CHECK constraint pins the same
  // three values in the database.
  assert.deepEqual(
    [...LIST_TYPES],
    ["PM", "AM", "Pharmacy"],
    'the CRM spells the pharmacy list "Pharmacy" — `t=PH` returns HTTP 200 and an EMPTY grid, which reads ' +
      "as \"no rep has any pharmacies\" while the agents grid counts 45-59 per rep",
  );

  // ── 2. Parsing a real contact grid ────────────────────────────────────────────────────────────
  const contacts = parseContactGrid(CONTACT_GRID_HTML);
  assert.equal(contacts.length, 2, "the pager row carries no numeric id and must not become a contact");
  assert.deepEqual(
    contacts.map((row) => row.contactCrmId),
    [101, 102],
    "the ID column is contact_crm_id — the exact join to ireports360_visits, never a name match",
  );

  const first = contacts[0];
  assert.equal(first.name, "Ahmed Fouad");
  assert.equal(first.grade, "A");
  assert.equal(first.speciality, "Cardiology");
  assert.equal(first.address, "12 Abbas El Akkad St, Nasr City");
  assert.equal(first.region, "CA1");
  assert.equal(first.phone, "0100 000 0000");
  assert.ok(first.nameAr && first.nameAr.length > 0, "the Arabic name column is decoded, not dropped");

  const second = contacts[1];
  assert.equal(second.name, "Mona Adel & Partners", "&amp; must decode — a mangled name is a wrong name");
  // A `&nbsp;` cell is the CRM saying "nothing here". It must become null rather than a string of
  // whitespace, or every "has an address" count is wrong by however many blanks there are.
  assert.equal(second.grade, null, "an &nbsp; cell is null, not \" \"");
  assert.equal(second.address, null);
  assert.equal(second.phone, null);
  assert.equal(second.nameAr, null);

  // ── 3. An EMPTY grid parses to [], and does NOT throw ─────────────────────────────────────────
  // An agent genuinely holding no contacts of a type is common — 13 of 15 district managers, and one
  // medical rep. Throwing here would turn an ordinary answer into a sync failure.
  assert.deepEqual(
    parseContactGrid(EMPTY_CONTACT_GRID_HTML),
    [],
    "an empty grid is a real answer for an agent with no contacts of that type, not a parse failure",
  );

  // ── 4. A DRIFTED grid throws, and names what went missing ─────────────────────────────────────
  // This is the guard that stops a vendor redesign reading as "every rep lost their doctors". The
  // shape assertion is what separates that from the legitimate empty answer above — a status code
  // cannot, because both are HTTP 200.
  assert.throws(
    () => parseContactGrid(DRIFTED_CONTACT_GRID_HTML),
    (error: unknown) =>
      error instanceof CrmWebError &&
      /Grade/.test(error.message) &&
      /Address/.test(error.message),
    "a grid missing the columns Phoenix reads must throw and name them, never silently return partial rows",
  );

  assert.throws(
    () => assertContactGridShape(["ID", "Contact Name", "Grade", "Spec."]),
    CrmWebError,
    "Address is one of the four fields the owner asked this board to show; its absence is a shape failure",
  );
  assert.doesNotThrow(() =>
    assertContactGridShape(["id", "contact name", "grade", "spec.", "address"]),
  );

  // ── 5. Parsing the agents grid ────────────────────────────────────────────────────────────────
  const agents = parseAgentGrid(AGENT_GRID_HTML);
  assert.equal(agents.length, 2, "a row with no ContactsList link is not an agent row");
  assert.deepEqual(agents.map((row) => row.agentCrmId), [1391, 1402]);
  assert.equal(agents[0].pmCount, 104, "the PM counter is the cheapest cross-check that a fetched list is not silently empty");
  assert.equal(agents[0].amCount, 12);
  assert.equal(agents[0].pharmacyCount, 47);
  assert.equal(agents[0].isActive, true);
  assert.equal(agents[0].label, "Ashraf.Maged ( Mahalla / A )");
  assert.equal(agents[0].line, "A");
  // A nameless label is the CRM admin's deactivation convention: the rep resigned, the name was
  // stripped, the area kept. It is NOT a data fault and must parse cleanly.
  assert.equal(agents[1].label, "( Mahalla / E )");
  assert.equal(agents[1].isActive, false);
  assert.equal(agents[1].hiringDate, null);

  // ── 6. THE SAFETY RULE: an empty answer never empties the mirror ──────────────────────────────
  // The CRM returns live contacts only, so "no rows" is how a removal is expressed — and also how an
  // expired session, an outage and a wrong `t=` all look. When the fetch is empty and the mirror is
  // not, the sync keeps what it has and says so.
  const refused = decideContactReplacement({ fetchedKeys: [], mirroredKeys: ["1391|101|PM", "1391|102|PM"] });
  assert.equal(refused.refusedEmpty, true, "an empty fetch against a non-empty mirror must be REFUSED, not applied");
  assert.deepEqual(refused.staleKeys, [], "a refused replacement must delete nothing at all");

  // A genuine removal — the fetch is non-empty and one mirrored contact is no longer in it.
  const pruned = decideContactReplacement({
    fetchedKeys: ["1391|101|PM"],
    mirroredKeys: ["1391|101|PM", "1391|102|PM"],
  });
  assert.equal(pruned.refusedEmpty, false);
  assert.deepEqual(
    pruned.staleKeys,
    ["1391|102|PM"],
    "a doctor removed from the list in the CRM must be removed here too — the mirror is not an archive",
  );

  // An agent who genuinely holds nothing and is mirrored as holding nothing is not a refusal: there
  // is no evidence to protect, so the sync proceeds normally and prunes nothing.
  const emptyBoth = decideContactReplacement({ fetchedKeys: [], mirroredKeys: [] });
  assert.equal(emptyBoth.refusedEmpty, false, "empty on both sides is an ordinary no-op, not a refusal");
  assert.deepEqual(emptyBoth.staleKeys, []);

  // Nothing is stale when the fetch is a superset.
  assert.deepEqual(
    decideContactReplacement({
      fetchedKeys: ["1391|101|PM", "1391|103|PM"],
      mirroredKeys: ["1391|101|PM"],
    }).staleKeys,
    [],
  );

  // ── 7. The key is the composite PK, so the three lists never collide ──────────────────────────
  // The same doctor can legitimately sit on one agent's PM list and another's AM list. Keying on the
  // contact alone would make one overwrite the other.
  assert.equal(contactRowKey({ agent_crm_id: 1391, contact_crm_id: 101, list_type: "PM" }), "1391|101|PM");
  assert.notEqual(
    contactRowKey({ agent_crm_id: 1391, contact_crm_id: 101, list_type: "PM" }),
    contactRowKey({ agent_crm_id: 1391, contact_crm_id: 101, list_type: "AM" }),
    "list_type is part of the key — one doctor can be on both the PM and the AM list of the same agent",
  );

  // ── 8. The owner's 90-120 rule ────────────────────────────────────────────────────────────────
  // Stated 2026-08-28: "the medical rep maximum, from ninety to one hundred and twenty." Verified
  // against his own CRM exports the same day — five reps, five exact matches (104, 100, 100, 114,
  // 114). It is a band, not a cap: below 90 is as much a finding as above 120.
  assert.equal(EXPECTED_PM_MIN, 90);
  assert.equal(EXPECTED_PM_MAX, 120);
  assert.equal(isInExpectedBand(104), true);
  assert.equal(isInExpectedBand(90), true, "the band is inclusive at both ends");
  assert.equal(isInExpectedBand(120), true);
  assert.equal(isInExpectedBand(89), false, "a short list is a finding too, not just an over-long one");
  assert.equal(isInExpectedBand(121), false);
  assert.equal(isInExpectedBand(0), false);

  // ── 9. A row with no name still renders as something a human can read ─────────────────────────
  // The owner's standing rule: never show a raw code. One doctor row in 7,669 came back nameless.
  const nameless = toDoctorListRow({
    address: null,
    agent_crm_id: 1391,
    agent_hr_id: "AI-0001",
    contact_crm_id: 999,
    contact_grade: null,
    contact_name: "   ",
    contact_name_ar: null,
    crm_region_name: null,
    first_seen_at: null,
    list_type: "PM",
    phone: null,
    speciality: null,
    synced_at: null,
  });
  assert.equal(nameless.name, "Contact 999", "a blank name must not render as an empty cell beside an id");

  // An unrecognised list_type falls back to the doctor list rather than throwing: the CHECK
  // constraint makes it unreachable from the sync, and a board that 500s on one odd row is worse
  // than a board that shows it.
  const oddType = toDoctorListRow({
    address: "somewhere",
    agent_crm_id: 1391,
    agent_hr_id: null,
    contact_crm_id: 1,
    contact_grade: "B",
    contact_name: "Someone",
    contact_name_ar: null,
    crm_region_name: null,
    first_seen_at: null,
    list_type: "NOT-A-LIST",
    phone: null,
    speciality: null,
    synced_at: null,
  });
  assert.equal(oddType.listType, "PM");

  // ── 10. The access gate starts narrow, on purpose ─────────────────────────────────────────────
  // This board names every doctor a named rep is responsible for, with address and phone. It is
  // destined for district managers, but a DM must see HIS reps only and that scope does not exist
  // yet. Shipping it wide first is the exact fault the owner caught on Doctor Coverage on
  // 2026-08-28 — scoped data behind an unscoped picker. This assertion is what makes widening it a
  // deliberate act rather than a passing edit.
  assert.deepEqual(
    [...DOCTOR_LIST_ACCESS_ROLES],
    ["Super Admin"],
    "widening this list requires the reps-per-manager scope in the loader FIRST — a picker is never wider than its viewer",
  );
  assert.equal(canAccessDoctorList({ role: "Super Admin", scope: "company" }), true);
  // The `system` scope shortcut is the same one every other canAccess* helper in permissions.ts
  // carries; it admits the system-administrator workspace regardless of the role label it wears.
  assert.equal(canAccessDoctorList({ role: "Employee", scope: "system" }), true);
  for (const role of ["District Manager", "Medical Rep", "CEO", "SFE Manager", "Employee"] as const) {
    assert.equal(
      canAccessDoctorList({ role, scope: "company" }),
      false,
      `${role} must not reach the doctor list until the per-manager scope exists`,
    );
  }

  // ── 11. The web app is a DIFFERENT host from the Reporting API ────────────────────────────────
  // The API has no contacts endpoint; site7 404s on ContactsList.aspx. Deriving the web host from
  // the API base keeps this to one env var in every environment that already works, and the
  // override exists because "differs only in the site number" is an observation about today's
  // hosting, not a promise the vendor made.
  const config = {
    baseUrl: "https://hmaxhmax-001-site7.rtempurl.com",
  } as Parameters<typeof resolveCrmWebBaseUrl>[0];
  const previous = process.env.IREPORTS360_WEB_BASE_URL;
  delete process.env.IREPORTS360_WEB_BASE_URL;
  try {
    assert.equal(
      resolveCrmWebBaseUrl(config),
      "https://hmaxhmax-001-site10.rtempurl.com",
      "the CRM web app is on site10 — the Reporting API's own host serves no contact list at all",
    );
    process.env.IREPORTS360_WEB_BASE_URL = "https://elsewhere.example.com/";
    assert.equal(
      resolveCrmWebBaseUrl(config),
      "https://elsewhere.example.com",
      "an explicit override wins, with the trailing slash trimmed so path joins do not double up",
    );
  } finally {
    if (previous === undefined) delete process.env.IREPORTS360_WEB_BASE_URL;
    else process.env.IREPORTS360_WEB_BASE_URL = previous;
  }
}
