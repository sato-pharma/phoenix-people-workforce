import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { assignmentToContactRecord, summarizeRepLists, toDoctorListRow } from "@/lib/crm/contact-lists";
import { buildVacationPeriod, vacationAgentKey } from "@/lib/crm/master";
import { toPanelContactRecord } from "@/lib/crm/rep-kpi-reports-data";
import { rosterRecordFromTuple, toRosterEntry } from "@/lib/crm/reps-list";

// The reports read PHOENIX'S OWN DATA, so they keep working the day iReports360 is switched off.
//
// Two kinds of source moved. Contact lists: from the vendor scrape `ireports360_contacts` to the open
// periods of `crm_contact_assignments` — the list sizes are KPI DENOMINATORS, so a frozen list
// freezes every coverage figure. Visits and check-ins: from the vendor tables to the unified views,
// which add Phoenix's own rows from the cutover on. Both halves also key a rep on his HR id, because
// a rep hired after the cutover has no CRM account at all.
//
// The loaders are IO, so their SHAPE is pinned on the source; the mappers they share are pure and
// pinned on behaviour.

/** The body of a top-level function (or `export const x = ...(` call) from its declaration to its close. */
function block(source: string, declaration: string, close = "\n}\n"): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must exist`);
  const end = source.indexOf(close, start);
  assert.ok(end > start, `${declaration} must be closed`);
  return source.slice(start, end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export function runCrmReportsReadPhoenixTests() {
  // ── C8 · the KPI panel reads the open assignments ─────────────────────────────────────────────
  {
    const source = readFileSync("src/lib/crm/rep-kpi-reports-data.ts", "utf8");
    const loader = block(source, "export async function loadPanelRows()");
    assert.equal(
      count(loader, ".from(CRM_CONTACT_ASSIGNMENTS_TABLE)"),
      2,
      "the panel's count AND its pages read crm_contact_assignments — the scrape freezes every KPI denominator the day the sweep stops",
    );
    assert.doesNotMatch(loader, /ireports360_contacts|CRM_CONTACTS_TABLE/, "the panel never reads the vendor scrape");
    assert.equal(
      count(loader, '.is("effective_to", null)'),
      2,
      "the count and every page read OPEN periods only: a closed period is a doctor the rep no longer holds, and counting it inflates his panel",
    );
    assert.ok(
      loader.includes('.order("id", { ascending: true })'),
      "ranged pages are ordered by the unique id — any non-unique order lets pages repeat and skip rows silently",
    );
    assert.ok(loader.includes("toPanelContactRecord(row)"), "every page row goes through the one grade mapper");
  }
  assert.deepEqual(
    toPanelContactRecord({ agent_crm_id: null, agent_hr_id: "B-40", contact_crm_id: 7, grade: "A", list_type: "PM" }),
    { agent_crm_id: null, agent_hr_id: "B-40", contact_crm_id: 7, contact_grade: "A", list_type: "PM" },
    "the assignment's `grade` is the panel's `contact_grade` — dropping it scores every doctor ungraded",
  );

  // ── C9 · rep lists: Phoenix's list, found by HR id ────────────────────────────────────────────
  {
    const lists = readFileSync("src/lib/crm/contact-lists.ts", "utf8");
    assert.doesNotMatch(lists, /CRM_CONTACTS_TABLE|\.from\("ireports360_contacts"\)/, "contact-lists.ts never reads the vendor scrape");
    const reader = block(lists, "async function readOpenList(");
    assert.ok(reader.includes(".from(CRM_CONTACT_ASSIGNMENTS_TABLE)") && reader.includes('.is("effective_to", null)'), "a rep's list is his open assignments");
    assert.ok(
      reader.includes('.in("agent_hr_id", hrIdLookupKeys(rep.hrId))'),
      "a rep's list is found by his HR id in every stored casing — by CRM account a rep hired after the cutover holds nothing",
    );
    assert.ok(reader.includes('.order("id", { ascending: true })'), "the list pages on the unique id");
    const summaries = block(lists, "export const getRepListSummaries", "\n);");
    assert.ok(
      summaries.includes("tags: [CRM_CONTACT_LIST_SUMMARIES_CACHE_TAG]"),
      "the cached summaries keep their tag, or a list change leaves the picker quoting old counts until the TTL runs out",
    );
    assert.ok(summaries.includes("summarizeRepLists(records)"), "the summaries aggregate through the one HR-keyed reducer");

    const board = readFileSync("src/lib/crm/reps-list-board.ts", "utf8");
    assert.ok(board.includes("getRepListSummaries()"), "the Reps List cascade reads the HR-keyed summaries");
    assert.ok(
      board.includes("const key = canonicalHrIdKey(summary.hrId);") && board.includes("const key = canonicalHrIdKey(hrId);"),
      "both sides of the rep-to-list join use the canonical HR id",
    );
    assert.doesNotMatch(
      board,
      /selected\?\.agentCrmId != null\s*\?\s*await getRepsListForAgent/,
      "opening a rep's list must not require a CRM account — that hid the whole list of every rep hired without one",
    );
    assert.ok(
      board.includes("selectedRep && selectedRep.contactCount + selectedRep.pharmacyCount > 0"),
      "a selected rep's list opens on his counts alone, never on whether he holds a CRM account",
    );
    assert.ok(
      board.includes("await getRepsListForAgent({ agentCrmId: selectedRep.agentCrmId, hrId: selectedRep.hrId }"),
      "the board hands the list loader the rep's HR id",
    );

    const repsList = readFileSync("src/lib/crm/reps-list.ts", "utf8");
    assert.doesNotMatch(repsList, /CRM_CONTACTS_TABLE/, "Reps List never reads the vendor scrape");
    assert.ok(repsList.includes("hrId ? await getRepContactList(hrId)"), "Reps List loads the list by HR id whenever it has one");
    const roster = block(repsList, "async function readContactRoster()");
    assert.equal(count(roster, "supabase.rpc(CONTACT_ROSTER_RPC)"), 1, "the sharing roster is ONE statement, not fourteen OFFSET pages with an embed");
    assert.equal(count(roster, ".from("), 0, "the roster's main read touches no table directly");
    assert.ok(roster.includes("if (isMissingCrmRpcError(error)) return readContactRosterByPages();"), "a database without the function falls back to the page walk");
    const pages = block(repsList, "async function readContactRosterByPages()");
    assert.equal(count(pages, ".from(CRM_CONTACT_ASSIGNMENTS_TABLE)"), 2, "the fallback's count and pages read the open assignments");
    assert.equal(count(pages, '.is("effective_to", null)'), 2, "the fallback holds today's lists only, on the count as on the pages");
    const loader = block(repsList, "export async function loadContactRoster()");
    assert.ok(loader.includes('getOrLoadShared(CRM_CONTACT_ROSTER, "open", readContactRoster,'), "every rep page within a minute shares one roster read");
    const migration = readFileSync("supabase/migrations/20261025231000_crm_contact_roster_read_in_one_statement.sql", "utf8");
    assert.ok(migration.replace(/\s+/g, " ").includes("from public.crm_contact_assignments a left join public.crm_contacts c on c.contact_crm_id = a.contact_crm_id where a.effective_to is null;"), "the function keeps the embed's filter and its null contact");
    assert.ok(migration.includes("grant execute on function public.phx_crm_contact_roster() to service_role;"), "only the service role runs it");
    const tuple = rosterRecordFromTuple([7, 55, null, "B-40", "Dr Amal", "0100", "Pediatrics", "Maadi"]);
    assert.deepEqual(tuple, { agent_crm_id: null, agent_hr_id: "B-40", contact: { crm_region_name: "Maadi", name: "Dr Amal", phone: "0100", speciality: "Pediatrics" }, contact_crm_id: 55 }, "the function's tuple maps to the embed's record, field by field");
    const service = readFileSync("src/lib/crm/contact-lists/service.ts", "utf8");
    assert.ok(block(service, "function bustListSummaries()").includes("refreshSharedContactRoster("), "a list change drops the shared roster copy at once");

    const component = readFileSync("src/components/crm/reps-list-board.tsx", "utf8");
    assert.match(component, /const hasList = rep\.contactCount \+ rep\.pharmacyCount > 0;/, "a rep card reads 'has a list' from its counts alone");
    assert.doesNotMatch(component, /const hasList = rep\.agentCrmId != null/, "a rep with no CRM account must not be told he has no list");
  }
  {
    const row = toDoctorListRow(
      assignmentToContactRecord({
        agent_crm_id: null,
        agent_hr_id: "B-40",
        contact: { address: "12 Nile St", crm_region_name: "Maadi", name: " Dr Amal ", name_ar: null, phone: "0100", speciality: "Pediatrics" },
        contact_crm_id: 55,
        effective_from: "2026-09-01",
        grade: "B",
        list_type: "AM",
        updated_at: "2026-09-14T10:00:00Z",
      }),
    );
    assert.equal(row.name, "Dr Amal", "the name comes from the embedded contact master");
    assert.equal(row.grade, "B", "the grade comes from the assignment");
    assert.equal(row.listType, "AM");
    assert.equal(row.region, "Maadi");
    assert.equal(row.agentCrmId, null, "a Phoenix-only row carries no CRM account, and says so");
    assert.equal(row.firstSeenAt, "2026-09-01", "firstSeenAt is when the current period began");
    const nameless = toDoctorListRow(
      assignmentToContactRecord({
        agent_crm_id: 9,
        agent_hr_id: "B-9",
        contact: null,
        contact_crm_id: 77,
        effective_from: null,
        grade: null,
        list_type: "PM",
        updated_at: null,
      }),
    );
    assert.equal(nameless.name, "Contact 77", "a missing contact still renders as something a human can read");
  }
  {
    const summaries = summarizeRepLists([
      { agent_crm_id: null, agent_hr_id: "b-12", list_type: "PM", updated_at: "2026-09-10T00:00:00Z" },
      { agent_crm_id: 1131, agent_hr_id: "B-12", list_type: "AM", updated_at: "2026-09-12T00:00:00Z" },
      { agent_crm_id: 1131, agent_hr_id: "B-12 ", list_type: "Pharmacy", updated_at: null },
      { agent_crm_id: null, agent_hr_id: "B-99", list_type: "PM", updated_at: null },
      { agent_crm_id: 500, agent_hr_id: null, list_type: "PM", updated_at: null },
      { agent_crm_id: null, agent_hr_id: "  ", list_type: "PM", updated_at: null },
    ]);
    assert.equal(summaries.length, 3, "one summary per rep: HR-id casing merges, a row naming nobody is dropped");
    const b12 = summaries.find((summary) => summary.hrId?.trim().toUpperCase() === "B-12");
    assert.ok(b12, "the rep is found by his HR id");
    assert.equal(b12.pmCount + b12.amCount, 2, "his contact count is PM + AM, across a Phoenix row and a vendor row");
    assert.equal(b12.pharmacyCount, 1, "a pharmacy is counted apart — it is not a contact");
    assert.equal(b12.agentCrmId, 1131, "the CRM account is filled from whichever row carries one");
    assert.equal(b12.syncedAt, "2026-09-12T00:00:00Z", "syncedAt is the latest change on his list");
    const hrOnly = summaries.find((summary) => summary.hrId === "B-99");
    assert.ok(hrOnly && hrOnly.agentCrmId === null && hrOnly.pmCount === 1, "a rep with no CRM account still has his list counted");
    assert.ok(summaries.some((summary) => summary.hrId === null && summary.agentCrmId === 500), "a vendor row with no HR id stays visible under its CRM account");
  }
  assert.equal(
    toRosterEntry({ agent_crm_id: null, agent_hr_id: " ", contact: { crm_region_name: "x", name: "Dr A", phone: null, speciality: null }, contact_crm_id: 1 }),
    null,
    "a roster row naming nobody is left out: the sharing matcher could never name its rep",
  );
  assert.equal(
    toRosterEntry({ agent_crm_id: null, agent_hr_id: "b-40", contact: { crm_region_name: null, name: "Dr A", phone: null, speciality: null }, contact_crm_id: 1 })?.repKey,
    "hr:b-40",
    "a roster row of a rep with no CRM account is KEPT, keyed on his HR id — dropping it meant a customer he shared was never highlighted and never named",
  );
  assert.deepEqual(
    toRosterEntry({ agent_crm_id: 4, agent_hr_id: "B-4", contact: { crm_region_name: " Tanta ", name: "Dr B", phone: null, speciality: " ENT " }, contact_crm_id: 2 }),
    { contactCrmId: 2, name: "Dr B", nameKey: toRosterEntry({ agent_crm_id: 4, agent_hr_id: null, contact: { crm_region_name: null, name: "Dr B", phone: null, speciality: null }, contact_crm_id: 2 })?.nameKey, phoneKey: null, regionKey: "tanta", repKey: "4", speciality: "ENT" },
    "the roster keeps speciality and CRM region from the embedded contact — they corroborate every name match — and a rep with a CRM id keeps it as his key",
  );
  {
    const board = readFileSync("src/lib/crm/reps-list-board.ts", "utf8");
    assert.match(
      board,
      /hasList && selectedRep && \(selectedRep\.agentCrmId != null \|\| selectedRep\.hrId\)\s*\?\s*loadRepsListActivity\(/,
      "a rep with no CRM account gets his activity column too — gated on a CRM account, his whole list read 'unavailable'",
    );
    assert.match(
      board,
      /loadRepsListActivity\(\{\s*agentCrmId: selectedRep\.agentCrmId,\s*hrId: selectedRep\.hrId,\s*month: activityMonth\s*\}\)/,
      "the activity loader is handed the HR id, which is the only thing that finds a rep with no CRM account",
    );
    // Started beside the list (2026-10-01), and still only READ for a board that has one.
    assert.match(board, /const activityIndex = rawList \? await activityRead : null;/, "the activity is only ever read for a board with a list");
    assert.match(
      board,
      /const key = repDoctorListRepKey\(summaryFor\(rep\.hrId\)\?\.agentCrmId, rep\.hrId\);/,
      "the shared-customer name map is keyed on the rep key, so a partner with no CRM account can be named",
    );
    const repsList = readFileSync("src/lib/crm/reps-list.ts", "utf8");
    assert.ok(
      // `crm_checkin_id` rides along since 2026-10-16 as the keyset page cursor's tiebreak only.
      repsList.includes('.select("contact_crm_id, agent_crm_id, agent_hr_id, lat, lon, address, check_date, crm_checkin_id")'),
      "check-ins carry the HR id, or a rep with no CRM account never counts as a second observer",
    );
    assert.ok(
      repsList.includes("id, contact_crm_id, agent_crm_id, agent_hr_id, contact:"),
      "the roster carries the HR id, or a partner with no CRM account has no key to be named by",
    );
    assert.ok(
      repsList.includes("const repKey = repDoctorListRepKey(ownCrmId, hrId);") && repsList.includes("entry.repKey !== repKey"),
      "'someone else' is a different rep key, so a rep with no CRM account is never a stranger to his own rows",
    );
  }

  // ── E2 · E3 · E4 · the CRM Master reads the unified views ────────────────────────────────────
  {
    const master = readFileSync("src/lib/crm/master.ts", "utf8");
    assert.doesNotMatch(master, /\bCRM_VISITS_TABLE\b|\bCRM_CHECKINS_TABLE\b/, "no CRM Master read touches a vendor visits or check-ins table");
    assert.doesNotMatch(
      master,
      /"agent_crm_id", "in"/,
      "no CRM Master exclusion filters on agent_crm_id: a Phoenix row by a rep with no CRM account has it null, and `not in` over a null drops the row",
    );

    const triples = block(master, "async function computeTriplesUncached(");
    assert.ok(triples.includes(".from(CRM_VISITS_UNIFIED_VIEW)"), "E2: double-visit triples read the unified visits");
    assert.ok(triples.includes('q.not("exclusion_crm_id", "in", excludedInList)'), "E2: triples exclude departed reps on exclusion_crm_id");

    // The uncached worker holds the read (computeVacationPeriods is now a thin TTL-cache wrapper, the
    // same split as computeTriplesInRange → computeTriplesUncached inspected just above).
    const vacations = block(master, "async function computeVacationPeriodsUncached(");
    assert.ok(vacations.includes(".from(CRM_VISITS_UNIFIED_VIEW)"), "E3: vacations read the unified visits");
    assert.ok(vacations.includes('.eq("visit_type", -4)'), "E3: vacations select leave by CODE — Phoenix's visits carry no vendor label to match");
    assert.doesNotMatch(vacations, /\.ilike\("visit_type_description"/, "E3: no word match on the vendor description survives");
    assert.ok(vacations.includes('q.not("exclusion_crm_id", "in", excludedInList)'), "E3: vacations exclude on exclusion_crm_id");
    assert.ok(vacations.includes("vacationAgentKey(d)"), "E3: leave days are grouped by rep identity, not skipped for want of a CRM account");

    const filters = block(master, "function applyMasterFilters(");
    assert.ok(filters.includes('if (dataset === "vacations") q = q.eq("visit_type", -4);'), "E3: the safety net selects leave by code too");
    assert.doesNotMatch(filters, /\.ilike\("visit_type_description"/, "E3: the safety net's word match is gone");
    assert.ok(filters.includes('q.not("exclusion_crm_id", "in", excludedInList)'), "E4: the shared filter excludes on exclusion_crm_id");

    assert.equal(
      count(master, "isCheckins ? CRM_CHECKINS_UNIFIED_VIEW : CRM_VISITS_UNIFIED_VIEW") +
        count(master, "? CRM_CHECKINS_UNIFIED_VIEW\n        : CRM_VISITS_UNIFIED_VIEW"),
      2,
      "E4: both the paged table and the export choose a unified view",
    );
    assert.ok(
      master.includes("agentCrmOrHrIds: { crmIds: agentIds, hrIds: agentHrIds }"),
      "E4: a page's check-ins are fetched by CRM account OR HR id — by account alone a rep with none never matches a check-in",
    );
    assert.ok(
      master.includes('agentHrId: typeof row.agent_hr_id === "string" ? row.agent_hr_id : null'),
      "E4: the matcher is told the visit's HR id",
    );
  }
  assert.equal(vacationAgentKey({ agent_crm_id: 12, agent_hr_id: "B-1" }), "crm:12");
  assert.equal(vacationAgentKey({ agent_crm_id: null, agent_hr_id: " B-40 " }), "hr:b-40", "a rep with no CRM account is grouped by his HR id");
  assert.equal(vacationAgentKey({ agent_crm_id: null, agent_hr_id: null }), null);
  {
    const period = buildVacationPeriod([
      { crm_visit_id: -5, visit_date: "2026-09-02", ampm: null, agent_crm_id: null, agent_name: "Rep", agent_hr_id: "B-40", visit_type_description: null, comment: null },
    ]);
    assert.equal(period.id, "vac-b-40-2026-09-02-2026-09-02", "an HR-only rep's period id names him, never `null`, so two such reps never collide");
  }

  // ── E6 · the customer-mapping punch-list reads the unified visits ─────────────────────────────
  {
    const brick = readFileSync("src/lib/crm/customer-brick.ts", "utf8");
    assert.ok(brick.includes("const visitsTable = CRM_VISITS_UNIFIED_VIEW;"), "E6: customers are scanned from the unified visits");
    assert.doesNotMatch(brick, /\bCRM_VISITS_TABLE\b/, "E6: never from the vendor visits table");
    assert.ok(
      block(brick, "async function scanAllCrmCustomers(").includes('.neq("contact_crm_id", CATCH_ALL_CONTACT_CRM_ID)'),
      "E6: the catch-all contact is not a customer to map",
    );
    // E6b · a customer only on a rep's plan or doctor list is on the tab too. The visits scan never
    // sees one, so a new one whose locality was unmapped went unseen by BOTH mapping tabs.
    const universe = block(brick, "async function loadCustomerUniverse(");
    assert.ok(universe.includes("loadContactMaster()"), "E6b: the customer universe reads the contact master");
    assert.ok(universe.includes("visitCount: 0"), "E6b: a contact with no visit joins the universe at visit count 0");
    assert.ok(universe.includes("contactId === CATCH_ALL_CONTACT_CRM_ID"), "E6b: the catch-all contact stays out of the master half too");
    for (const reader of ["export async function getCrmCustomerMappingPunchList(", "export async function getAllCrmCustomersForTemplate("]) {
      assert.ok(block(brick, reader).includes("await loadCustomerUniverse()"), `E6b: ${reader} builds on the full universe`);
    }
    assert.doesNotMatch(
      block(brick, "async function loadContactMaster("),
      /\.eq\(\s*"brick_status"/,
      "E6b: the master read is never narrowed to locality-placed contacts",
    );
  }
}
