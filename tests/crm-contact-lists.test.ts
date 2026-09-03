import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertContactGridShape,
  CrmWebError,
  LIST_TYPES,
  parseAgentGrid,
  parseContactGrid,
  resolveCrmWebBaseUrl,
} from "../src/lib/crm/contacts-web-client.ts";
import {
  CONTACT_SYNC_SLICE_COUNT,
  contactRowKey,
  contactSyncSliceForDate,
  decideContactReplacement,
  selectContactSyncSlice,
} from "../src/lib/crm/contacts-sync.ts";
import {
  EXPECTED_PM_MAX,
  EXPECTED_PM_MIN,
  isInExpectedBand,
  toDoctorListRow,
} from "../src/lib/crm/contact-lists.ts";
import {
  canAccessDoctorList,
  doctorListBasisForRole,
  DOCTOR_LIST_ACCESS_ROLES,
} from "../src/lib/crm/doctor-list-access.ts";

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

// Trimmed from Agents.aspx. Column order re-verified live 2026-09-03, this time against the grid's
// OWN header captions rather than by eye: 0 Area (the ContactsList link) · 1 PM · 2 AM · 3 PH ·
// 4 All · 5 ID · 6 Real Name · 7 Email · 8 Privilege · 9 Manager · 10 Line · 11 Active ·
// 12 Hiring Date. Column 9 was read as a login name until that check — see assertion 5 below.
// Email (7) is left blank in every row because nothing parses it; 55 of the 305 live accounts have
// it blank too, so a blank is faithful and no real address needs to live in this repository.
const AGENT_GRID_HTML = `
<html><body>
<table id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00">
  <tr id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00__0">
    <td><a href="ContactsList.aspx?t=PM&amp;q=1391">Area</a></td>
    <td>104</td><td>12</td><td>47</td><td>All</td><td>1391</td>
    <td>Ashraf.Maged ( Mahalla / A )</td><td>&nbsp;</td><td>Medical Rep</td><td>Saad.Mohamed</td><td>A</td>
    <td>Yes</td><td>2026-04-01</td>
  </tr>
  <tr id="ctl00_ContentPlaceHolder1_RadGrid1_ctl00__1">
    <td><a href="ContactsList.aspx?t=PM&amp;q=1402">Area</a></td>
    <td>0</td><td>0</td><td>0</td><td>All</td><td>1402</td>
    <td>( Mahalla / E )</td><td>&nbsp;</td><td>Medical Rep</td><td>( Others DM / C )</td><td>E</td>
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

  // Column 9 is the grid's `Manager` — the SUPERVISOR's own Real Name. It is NOT this account's
  // login name; the grid has no login column at all. It was parsed into a field literally called
  // `username` until 2026-09-03, and the cost of that name was an ad-hoc audit which matched CRM
  // accounts to employees on `label` OR that field: 22 dormant accounts were credited to the live
  // managers above them and reported as still in service, so it named 19 accounts as retirable
  // where the true answer was 48. Every wrong match landed on a real, currently employed person,
  // which is exactly why nothing looked wrong. Identify an account by its `label` and nothing else.
  assert.equal(
    agents[0].supervisor,
    "Saad.Mohamed",
    "column 9 is the supervisor's Real Name — the manager the account reports to, never its own login",
  );
  assert.notEqual(
    agents[0].supervisor,
    "Ashraf.Maged",
    "the supervisor is never the row's own holder — reading it as one is what made 22 dormant accounts look staffed",
  );
  assert.equal(
    agents[0].title,
    "Medical Rep",
    "column 8 is the grid's `Privilege` caption — the CRM's role name, and the column that 9 is easily confused with",
  );
  // A supervisor value can itself be a nameless `[ ]( Area / Line )` label: 13 of the 305 live
  // accounts point at a manager seat rendered that way, so it must survive as a value, not blank.
  assert.equal(
    agents[1].supervisor,
    "( Others DM / C )",
    "a supervisor rendered as a nameless seat label is a real value, not an empty one",
  );
  assert.ok(
    !("username" in agents[0]),
    "`username` was the wrong name for column 9 and must not return — the agents grid has no login column",
  );

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

  // ── 7b. The sweep is sliced, because the scheduler cuts every request at 30 seconds ───────────
  // Measured 2026-08-28 on the real route: cron-job.org killed the connection at ms=30108 with the
  // job's requestTimeout set to 300 — a platform cap, not a setting. The handler does finish past
  // the cut, so slicing buys a truthful report rather than rescuing data; what it must never do is
  // LOSE a rep, because the schedule gives each twelfth exactly one turn a day. So the partition
  // has to be complete and disjoint, or a rep silently stops being refreshed and nothing says so.
  const roster = Array.from({ length: 82 }, (_value, index) => index);
  const slices = Array.from({ length: CONTACT_SYNC_SLICE_COUNT }, (_value, slice) =>
    selectContactSyncSlice(roster, slice, CONTACT_SYNC_SLICE_COUNT),
  );
  assert.deepEqual(
    slices.flat().sort((left, right) => left - right),
    roster,
    "every agent must land in exactly one slice — a gap here is a rep whose list quietly stops refreshing",
  );
  // Round-robin, not `agentCrmId % of`: on the live roster of 82 the modulo put 11 agents in one
  // slice, which is ~21s of vendor calls against a 30s cap. This bounds every slice at ceil(82/12).
  assert.equal(
    Math.max(...slices.map((entries) => entries.length)),
    Math.ceil(roster.length / CONTACT_SYNC_SLICE_COUNT),
    "no slice may be larger than an even share — an oversized slice is the timeout coming back",
  );
  assert.deepEqual(
    selectContactSyncSlice(roster, 0, 1),
    roster,
    "?all=1 collapses to a single slice holding the whole roster, for the by-hand backfill",
  );

  // The slice comes from the Cairo minute ROUNDED to the nearest five, never floored. A scheduler
  // that fires at 05:04:58 for the 05:05 tick would otherwise repeat slice 0 and skip slice 1 every
  // day — eleven twelfths of the roster still swept, one twelfth never, and the job green throughout.
  const at = (iso: string) => contactSyncSliceForDate(new Date(iso));
  assert.equal(at("2026-08-29T03:00:02Z"), 0, "05:00:02 Cairo is the first slice");
  assert.equal(at("2026-08-29T03:05:01Z"), 1, "05:05:01 Cairo is the second slice");
  assert.equal(at("2026-08-29T03:04:58Z"), 1, "firing 2s EARLY must still be the second slice, not a repeat of the first");
  assert.equal(at("2026-08-29T03:07:20Z"), 1, "firing 2m20s late is still the second slice");
  assert.equal(at("2026-08-29T03:55:00Z"), 11, "05:55 Cairo is the twelfth and last slice");
  assert.equal(at("2026-08-29T03:59:45Z"), 0, "a run at 05:59:45 rounds up to the next hour and wraps to 0, never to 12");
  // No timezone conversion, on purpose: Cairo is a whole-hour offset from UTC in both standard and
  // summer time, so the minute within the hour — the only thing that selects a slice — is the same
  // number in either. This pins that reasoning: the same wall-clock minute in winter and in summer
  // must select the same slice, or the window silently shifts when Egypt changes its clocks.
  assert.equal(
    at("2026-01-15T03:25:00Z"),
    at("2026-07-15T03:25:00Z"),
    "the same minute must select the same slice year-round — an hour-offset change must not move the window",
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

  // ── 10. The access gate, widened once its precondition existed ────────────────────────────────
  // This board names every doctor a named rep is responsible for, with address and phone. It
  // shipped Super-Admin-only because a district manager must see HIS reps only and that scope did
  // not exist yet — shipping it wide first is the exact fault the owner caught on Doctor Coverage
  // on 2026-08-28: scoped data behind an unscoped picker.
  //
  // The scope now exists (`getDoctorListScope` -> `manager-scope.ts`, applied in
  // `getDoctorListBoard` to the REPS as well as the rows), so the list is the District Manager
  // page's real audience. The assertion did its job: widening it took a deliberate edit here, in
  // the same commit as the loader.
  //
  // WIDENED AGAIN 2026-09-03, to the marketing and field-support seats the owner named that day.
  // Marketing Manager and Training Manager are company seats — neither owns a line or supervises a
  // rep, so there is nothing narrower to resolve them to that would not resolve them to nothing at
  // all. Product Manager and Group Product Manager resolve to their own product LINE, which is the
  // reach they already have on KPIs and in the Business Review access map: a seat whose reach
  // changes between two screens listing the same reps is a fault that reports itself as confusing
  // data rather than as a permission bug, so the two lists are kept in agreement.
  assert.deepEqual(
    [...DOCTOR_LIST_ACCESS_ROLES],
    [
      "Super Admin",
      "CEO",
      "National Sales Manager",
      "SFE Manager",
      "Marketing Manager",
      "Training Manager",
      "Product Manager",
      "Group Product Manager",
      "Regional Manager",
      "District Manager",
    ],
    "every widening of this list must be a deliberate edit — the picker is never wider than the viewer",
  );
  assert.equal(canAccessDoctorList({ role: "Super Admin", scope: "company" }), true);
  assert.equal(canAccessDoctorList({ role: "District Manager", scope: "company" }), true);
  // The `system` scope shortcut is the same one every other canAccess* helper in permissions.ts
  // carries; it admits the system-administrator workspace regardless of the role label it wears.
  assert.equal(canAccessDoctorList({ role: "Employee", scope: "system" }), true);
  for (const role of ["Medical Rep", "Employee", "HR Operations"] as const) {
    assert.equal(
      canAccessDoctorList({ role, scope: "company" }),
      false,
      `${role} must not reach a board that names every doctor with address and phone`,
    );
  }
  // The invariant that makes the widening safe, and the one worth pinning: admission IMPLIES a
  // scope. A role admitted with a null basis would reach the board with nothing to filter by, and
  // an unfiltered picker is the original fault all over again.
  for (const role of DOCTOR_LIST_ACCESS_ROLES) {
    const basis = doctorListBasisForRole(role);
    assert.ok(
      basis === "company" || basis === "line" || basis === "team",
      `${role} is admitted to the doctor list but resolves to no scope — it would see every rep in the company`,
    );
  }
  // And the four seats added on 2026-09-03 resolve to the width that was actually decided, not
  // merely to SOME width. `company` where `line` was intended is the silent over-grant this whole
  // block exists to catch, and the two are indistinguishable from a board that renders fine.
  assert.equal(doctorListBasisForRole("Product Manager"), "line", "a PM owns brands on one line, not the company");
  assert.equal(doctorListBasisForRole("Group Product Manager"), "line");
  assert.equal(doctorListBasisForRole("Marketing Manager"), "company");
  assert.equal(doctorListBasisForRole("Training Manager"), "company");

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
  // ── THE REP-PICKER SUMMARIES ARE CACHED, PARALLEL AND DETERMINISTICALLY ORDERED ──────────────
  // `getDoctorListRepSummaries` produces ~69 summary rows by reading all 9,542 rows of
  // ireports360_contacts — there is no per-agent aggregate in the database, so the whole-table read
  // is inherent. Doing it SEQUENTIALLY on every render was not: three boards call this, and the
  // portal board's FIRST screen (the rep picker, before any rep is chosen) paid ten serial round
  // trips to Amsterdam to put a contact count on about five cards.
  //
  // The harness cannot run Next.js, so this locks the SOURCE SHAPE — the same weaker-but-honest
  // instrument tests/crm-brick-centroids-cache.test.ts uses for the identical migration on
  // loadBrickCentroids. Four invariants, each of which fails silently if it regresses:
  {
    const source = readFileSync("src/lib/crm/contact-lists.ts", "utf8");
    const start = source.indexOf("export const getDoctorListRepSummaries");
    assert.ok(start > 0, "getDoctorListRepSummaries must exist — three boards read their picker counts from it");
    const block = source.slice(start, source.indexOf("\n);", start));

    assert.ok(
      /^export const getDoctorListRepSummaries = unstable_cache\(/m.test(source.slice(start)),
      "the summaries must go through unstable_cache: a module-level variable is cold in most route segments (the exact fault loadBrickCentroids was moved off), and without a cache every render re-reads 9,542 rows",
    );

    // PARALLEL, not one page after another. This is the half that fixes the cold path.
    assert.ok(
      block.includes("await Promise.all(") && block.includes("count: \"exact\", head: true"),
      "the pages must be counted first and then fetched AT ONCE — a `for` loop awaiting each range in turn is ten serial hops to Amsterdam on a page a manager opens from a phone",
    );
    assert.ok(
      !/for \(let from = 0; ; from \+= PAGE_SIZE\)/.test(block),
      "the open-ended sequential paging loop must not come back",
    );

    // ORDER BY the table's own conflict key. Without it, ranged paging has no defined row order
    // between requests, so a contact can be counted twice or skipped and the picker's numbers come
    // out quietly wrong — a wrong count reads exactly like a real one.
    for (const column of ["agent_crm_id", "contact_crm_id", "list_type"]) {
      assert.ok(
        block.includes(`.order("${column}", { ascending: true })`),
        `the sweep must order by ${column}: (agent_crm_id, contact_crm_id, list_type) is the table's conflict key, and only a total order makes ranged paging deterministic`,
      );
    }

    // A CACHE WITH NO INVALIDATION IS A STALENESS BUG WEARING A PERFORMANCE COSTUME. The contacts
    // cron is the ONLY writer of ireports360_contacts, so it is the only thing that can move these
    // counts, and it must bust the tag on every successful slice.
    const cron = readFileSync("app/api/cron/crm-contact-lists/route.ts", "utf8");
    assert.ok(
      cron.includes("CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG") && cron.includes("revalidateTag("),
      "the contacts sync must revalidate the summaries tag — it is the only writer of the table behind them, and a TTL alone leaves the picker quoting pre-sweep counts for five minutes after each of the twelve slices",
    );
  }

}
