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
  agentCrmIdsFromTuples,
  CONTACT_SYNC_SLICE_COUNT,
  contactRowKey,
  contactSyncSliceForDate,
  contactSyncSliceRefreshedNothing,
  decideContactReplacement,
  rowFromContact,
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

  // ── 7c. A slice that refreshed NOTHING must not read as a success ─────────────────────────────
  // `agents` counts ATTEMPTED agents — a per-agent fetch that throws still lands in `outcomes`. So
  // the condition both schedulers used, `result.agents === 0`, could not see the one shape the cron
  // route's own doc comment names: "a vendor session that rejects every agent". Login succeeds, all
  // seven agents in the twelfth fail, `agents === 7` — and the heartbeat pinged SUCCESS while the
  // mirror rotted, the in-process cursor stepped past that twelfth, and the 15-minute failure retry
  // was replaced by the 5-minute success gap, so the failed twelfth waited a full hour.
  // Found by review on 2026-09-21, before this ever ran.
  assert.equal(
    contactSyncSliceRefreshedNothing({ agents: 7, agentsFailed: 7 }),
    true,
    "a slice where EVERY attempted agent failed refreshed nothing — it must never ping success",
  );
  assert.equal(
    contactSyncSliceRefreshedNothing({ agents: 0, agentsFailed: 0 }),
    true,
    "a slice that never started an agent refreshed nothing either",
  );
  // Partial degradation stays GREEN, deliberately. Twelve-plus ticks a day means anything flappy
  // here pages until it is muted, and a muted check is worth less than no check.
  assert.equal(
    contactSyncSliceRefreshedNothing({ agents: 7, agentsFailed: 6 }),
    false,
    "six of seven failing is an ordinary vendor hiccup on one twelfth — it must stay green",
  );
  assert.equal(
    contactSyncSliceRefreshedNothing({ agents: 7, agentsFailed: 0 }),
    false,
    "a clean slice is a success",
  );
  // `agentsRefusedEmpty` is the DESIGNED safety, not a failure: those agents kept yesterday's rows
  // rather than being emptied by a vendor outage. A whole slice of them is still a slice that ran.
  assert.equal(
    contactSyncSliceRefreshedNothing({ agents: 7, agentsFailed: 0 }),
    false,
    "a slice where every agent refused an empty answer ran fine — the refusal IS the protection",
  );

  // ── 7d. A mirrored row wears the TARGET's hr id, never one re-resolved from the CRM id ────────
  // The CRM never deletes an account: when a rep resigns the admin blanks the name, keeps the area
  // and hands the account to the next hire. So a CRM id identifies a SEAT over time, not a person,
  // and asking "who is agent 1399" without a date answers with whoever `employees.crm_id` points at
  // — which on a handed-over seat is the rep who LEFT. identity.ts names that tier in its own
  // comment: "Tier 2 — employees.crm_id. This is the tier that misattributes a reused CRM slot."
  //
  // rowFromContact used to make exactly that call, `resolveEmployeeHrId(agentCrmId, null, maps,
  // null)`, and a contact list is the one record that cannot survive it: a visit carries a date and
  // the vendor's own label to tell a seat's two occupants apart, and a list carries NEITHER.
  //
  // Measured on production 2026-09-21, both live and both re-stamped every morning by the daily
  // sweep: slot 1399's 103 rows read B-97 (resigned 2026-06-28) while the seat is Ahmed Farag
  // Soliman Elakraa's (AI-0020, 72 visits), and slot 1485's 158 rows read B-171 (resigned
  // 2026-07-11) while the seat is Manar Sadek's (CN-0007, 37 visits). That hr id is copied into
  // crm_contact_assignments by crm_contact_master_refresh, and the venue picker, Reps List and the
  // rep KPI reports all scope on it — so both reps' assigned doctors were filed under a leaver.
  //
  // The target's own hr id has no such failure mode: loadCrmContactSyncTargets builds it from the
  // ACTIVE roster and resolves the seat from that person's own visit and plan rows.
  const handedOverSeat = rowFromContact(first, { agentCrmId: 1399, hrId: "AI-0020" }, "PM");
  assert.equal(
    handedOverSeat.agent_hr_id,
    "AI-0020",
    "a mirrored contact row must carry the hr id of the ACTIVE rep the sweep targeted — re-resolving it " +
      "from the CRM id files a handed-over seat's whole doctor list under the rep who resigned",
  );
  assert.equal(
    handedOverSeat.agent_crm_id,
    1399,
    "the seat id still comes from the same target — one argument now carries both halves, so they cannot disagree",
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
      "SFE Manager",
      "Marketing Manager",
      "Training Manager",
      "National Sales Manager",
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
  // 2026-09-20: an NSM was `company` here while every other screen scoped him to his own line, so he
  // saw all 67 reps on Reps List and 18/26/23 everywhere else. `company` is the over-grant.
  assert.equal(doctorListBasisForRole("National Sales Manager"), "line", "an NSM sees his own line's reps, not the company's");

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
  // `getRepListSummaries` produces ~70 summary rows by reading every open row of
  // crm_contact_assignments — there is no per-rep aggregate in the database, so the whole-table read
  // is inherent. Doing it SEQUENTIALLY on every render was not: three boards call this, and the
  // portal board's FIRST screen (the rep picker, before any rep is chosen) paid ten serial round
  // trips to Amsterdam to put a contact count on about five cards.
  //
  // The harness cannot run Next.js, so this locks the SOURCE SHAPE — the same weaker-but-honest
  // instrument tests/crm-brick-centroids-cache.test.ts uses for the identical migration on
  // loadBrickCentroids. Each invariant fails silently if it regresses:
  {
    const source = readFileSync("src/lib/crm/contact-lists.ts", "utf8");
    const start = source.indexOf("export const getRepListSummaries");
    assert.ok(start > 0, "getRepListSummaries must exist — three boards read their picker counts from it");
    const block = source.slice(start, source.indexOf("\n);", start));

    assert.ok(
      /^export const getRepListSummaries = unstable_cache\(/m.test(source.slice(start)),
      "the summaries must go through unstable_cache: a module-level variable is cold in most route segments (the exact fault loadBrickCentroids was moved off), and without a cache every render re-reads ~9,800 rows",
    );

    // PHOENIX'S OWN LIST, TODAY'S ROWS. The vendor scrape freezes the day the sweep is switched off,
    // and a count over closed periods would add every contact a rep ever held.
    assert.ok(
      block.includes(".from(CRM_CONTACT_ASSIGNMENTS_TABLE)") && !block.includes("CRM_CONTACTS_TABLE") && !block.includes("ireports360_contacts"),
      "the summaries must read crm_contact_assignments, never the vendor scrape — the scrape stops moving when the sweep is switched off",
    );
    assert.equal(
      (block.match(/\.is\("effective_to", null\)/g) ?? []).length,
      2,
      "the count AND every page read open periods only: a count over all history sizes the fan-out for rows no page returns, and a page without the filter counts closed periods as today's list",
    );
    // Plan Verification joins on a CRM account, so it gets a filtered view of the SAME cached read.
    assert.match(
      source,
      /export async function getDoctorListRepSummaries\(\)[^{]*\{\s*return \(await getRepListSummaries\(\)\)\.filter/,
      "getDoctorListRepSummaries must derive from the one cached read — a second read is how two pickers come to quote different counts",
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

    // SEEK on the assignment's unique `id`. Without a total order, paging has no defined row order
    // between requests, so a contact can be counted twice or skipped and the picker's numbers come out
    // quietly wrong — a wrong count reads exactly like a real one. fetchAllRowsKeyset orders by its
    // cursor column, so `cursorColumn: "id"` is that total order.
    assert.ok(
      block.includes('cursorColumn: "id"'),
      "the sweep must seek on id: it is the assignment table's identity key, and only a total order makes paging deterministic",
    );
    // ID RANGES, NEVER OFFSETS (28 Oct 2026). An offset page makes Postgres walk and discard every
    // earlier open row: page 14 walked ~14,000 rows to return 1,000, 9,487 buffer pages a build and the
    // largest single read on the database (8.9% of all page reads over 25–28 Oct).
    assert.ok(
      !block.includes(".range("),
      "the summaries must not page by offset — `.range(` walks every earlier open row on each page; split the id span with keysetRanges and seek inside each range",
    );
    assert.ok(
      block.includes("keysetRanges(") && /fetchAllRowsKeyset(?:<[^(]*>)?\(/.test(block),
      "the summaries must read contiguous id ranges (keysetRanges) and seek inside each one (fetchAllRowsKeyset) — the ranges cover every id, so no open row is lost or read twice",
    );

    // A CACHE WITH NO INVALIDATION IS A STALENESS BUG WEARING A PERFORMANCE COSTUME. While the vendor
    // sweep runs, the contacts cron's master refresh is what moves these counts, and it must bust
    // the tag on every successful slice.
    const cron = readFileSync("app/api/cron/crm-contact-lists/route.ts", "utf8");
    assert.ok(
      cron.includes("CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG") && cron.includes("revalidateTag("),
      "the contacts sync must revalidate the summaries tag — it is the only writer of the table behind them, and a TTL alone leaves the picker quoting pre-sweep counts for five minutes after each of the twelve slices",
    );
    // The summaries read the MASTER's open assignments, so a bust before the master refresh lets a
    // board re-cache the pre-refresh counts for another five minutes.
    assert.ok(
      cron.indexOf("await refreshCrmContactMaster(") >= 0 &&
        cron.indexOf("revalidateTag(") > cron.indexOf("await refreshCrmContactMaster("),
      "the contacts sync must bust the summaries tag AFTER the contact master refresh, which is what moves the counts",
    );
  }


  // ── The rep -> CRM account lookup is ONE statement (2026-10-25 production load audit) ───────────
  // The chunked read scanned all 198,723 plan entries per chunk (124 calls at 229 ms), and each chunk
  // matched about half the table, of which PostgREST returned only its first 1,000 rows, so a rep
  // past that cap could be reported as having no CRM account. phx_crm_agent_crm_ids_by_hr answers
  // from two index-only scans as one jsonb value, which no row cap cuts.
  {
    const source = readFileSync("src/lib/crm/contacts-sync.ts", "utf8");
    const start = source.indexOf("export async function resolveAgentCrmIdsByHr(");
    const end = source.indexOf("export function agentCrmIdsFromTuples(", start);
    assert.ok(start >= 0 && end > start, "resolveAgentCrmIdsByHr must exist");
    const resolver = source.slice(start, end);
    assert.ok(
      resolver.includes("supabase.rpc(AGENT_CRM_IDS_BY_HR_RPC, { p_hr_ids: hrIds })") && !resolver.includes(".from("),
      "the rep -> CRM account lookup must be ONE rpc call: the chunked table read scanned 198,723 plan entries per chunk and PostgREST cut each chunk at 1,000 rows",
    );
    assert.ok(
      resolver.includes("if (isMissingCrmRpcError(error)) return resolveAgentCrmIdsByHrInChunks(hrIds);"),
      "a database without phx_crm_agent_crm_ids_by_hr must fall back to the chunked read, never fail the sync",
    );
    const sync = source.slice(source.indexOf("export async function loadCrmContactSyncTargets("), start);
    assert.ok(
      sync.includes("await resolveAgentCrmIdsByHr(hrIds)") && !sync.includes("CRM_PLAN_ENTRIES_TABLE"),
      "loadCrmContactSyncTargets must resolve through the one-statement lookup, not read the mirrors itself",
    );
    const migration = readFileSync("supabase/migrations/20261025233000_crm_plan_entries_agent_hr_id_index.sql", "utf8");
    assert.ok(
      migration.includes("on public.ireports360_plan_entries (agent_hr_id, agent_crm_id);") &&
        migration.includes("grant execute on function public.phx_crm_agent_crm_ids_by_hr(text[]) to service_role;") &&
        migration.includes("revoke execute on function public.phx_crm_agent_crm_ids_by_hr(text[]) from public, anon, authenticated;"),
      "the migration must carry the plain (agent_hr_id, agent_crm_id) index and keep the function service-role only",
    );
    const map = agentCrmIdsFromTuples([["AI-0001", 900], ["AI-0001", 1399], ["AI-0002", null], ["", 5], ["AI-0003", 12]]);
    assert.equal(map.get("AI-0001"), 1399, "the highest CRM account wins, as the row-by-row read decided");
    assert.equal(map.has("AI-0002"), false, "a pair with no CRM id resolves nothing");
    assert.equal(map.size, 2);
  }

}
