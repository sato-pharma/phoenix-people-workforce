import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { LIST_TYPES } from "../src/lib/crm/list-types.ts";
import {
  EXPECTED_PM_MAX,
  EXPECTED_PM_MIN,
  isInExpectedBand,
  repListRecordFromGroup,
  summarizeRepLists,
  toDoctorListRow,
  type RepListSummaryGroupTuple,
} from "../src/lib/crm/contact-lists.ts";
import {
  canAccessDoctorList,
  doctorListBasisForRole,
  DOCTOR_LIST_ACCESS_ROLES,
} from "../src/lib/crm/doctor-list-access.ts";

/**
 * The rep's assigned doctor list, as Phoenix serves it from its own stored contact lists.
 *
 * The vendor scrape that used to fill these lists (the old CRM's ContactsList.aspx / Agents.aspx
 * grids, the sliced sweep and its parsers) went with iReports360 on 6 November 2026, and its tests
 * with it. What this file still pins is what stayed: the list-type spelling every stored row is keyed
 * by, the owner's 90-120 band, the nameless-row fallback, the doctor-list access gate, and the shape
 * of the cached rep-picker summaries.
 */

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


  // ── THE REP-PICKER SUMMARIES ARE CACHED AND COME FROM ONE STATEMENT ────────────────────────────
  // `getRepListSummaries` puts a contact count on every rep card of three boards. Until 23 Nov 2026 it
  // read every open crm_contact_assignments row in ~40 requests, eighteen at a time; ten minutes after a
  // deploy the cold cache was rebuilt three times in thirteen seconds, the waves took every PostgREST
  // connection, and 19 unrelated reads (the pulse, the direct-order page) crossed the 15 s client budget
  // together. `phx_crm_rep_list_summary_groups` now groups the rows in the database (327 groups, one
  // request); the id-range walk is kept only for a database the function has not reached.
  //
  // The harness cannot run Next.js, so the SOURCE SHAPE is locked here; the arithmetic is proved below.
  {
    const source = readFileSync("src/lib/crm/contact-lists.ts", "utf8").replace(/\r\n/g, "\n");
    const sliceFrom = (marker: string, end: string) => {
      const start = source.indexOf(marker);
      assert.ok(start > 0, `${marker} must exist`);
      return source.slice(start, source.indexOf(end, start));
    };
    const cached = sliceFrom("export const getRepListSummaries", "\n);");
    const read = sliceFrom("async function readRepListSummaryRecords", "\n}\n");
    const walk = sliceFrom("async function readRepListRecordsByRanges", "\n}\n");

    assert.ok(
      /^export const getRepListSummaries = unstable_cache\(/m.test(source.slice(source.indexOf("export const getRepListSummaries"))),
      "the summaries must go through unstable_cache: a module-level variable is cold in most route segments (the exact fault loadBrickCentroids was moved off)",
    );
    assert.ok(
      cached.includes("summarizeRepLists(await readRepListSummaryRecords())") && cached.includes("revalidate: 300"),
      "the cached function must summarize what readRepListSummaryRecords returns, on the same five-minute window",
    );

    // ONE STATEMENT FIRST — the wave of chunked reads is what queued the whole app behind it.
    assert.ok(
      source.includes('const REP_LIST_SUMMARY_GROUPS_RPC = "phx_crm_rep_list_summary_groups";') &&
        read.includes(".rpc(REP_LIST_SUMMARY_GROUPS_RPC)") &&
        read.includes("isMissingRpcError(error)) return readRepListRecordsByRanges()") &&
        !read.includes(".from("),
      "the summaries must ask phx_crm_rep_list_summary_groups in one request and fall back to the id walk ONLY on PGRST202 — never read the table in chunks first",
    );
    assert.ok(
      read.indexOf("isMissingRpcError(error)") < read.indexOf("throw new Error"),
      "any other error must throw, never fall back: a transient failure retried as ~40 parallel requests is the stampede itself",
    );

    // The fallback walk keeps every property it had (28 Oct 2026): Phoenix's own list, open rows, ID RANGES.
    assert.ok(
      walk.includes(".from(CRM_CONTACT_ASSIGNMENTS_TABLE)") && !walk.includes("ireports360_contacts"),
      "the fallback must read crm_contact_assignments, never the vendor scrape",
    );
    assert.equal(
      (walk.match(/\.is\("effective_to", null\)/g) ?? []).length,
      2,
      "the count AND every page read open periods only",
    );
    assert.ok(
      walk.includes('count: "exact", head: true') && walk.includes('cursorColumn: "id"') && !walk.includes(".range(") &&
        walk.includes("keysetRanges(") && /fetchAllRowsKeyset(?:<[^(]*>)?\(/.test(walk),
      "the fallback must size by an exact count, split the id span with keysetRanges and seek on id inside each range — never offset pages",
    );
    assert.match(
      source,
      /export async function getDoctorListRepSummaries\(\)[^{]*\{\s*return \(await getRepListSummaries\(\)\)\.filter/,
      "getDoctorListRepSummaries must derive from the one cached read — a second read is how two pickers come to quote different counts",
    );

    // NO FIGURE CHANGES. The function's grouping, replayed here exactly as its SQL does it, must give
    // the same summaries as the raw rows: counts, the first row's HR id, the first CRM account, the
    // newest updated_at — including a rep whose first rows carry no CRM account and one spelled twice.
    const rows = [
      { id: 1, agent_crm_id: null, agent_hr_id: "B-7", list_type: "PM", updated_at: "2026-11-20T08:00:00+00:00" },
      { id: 2, agent_crm_id: 501, agent_hr_id: "B-7", list_type: "AM", updated_at: "2026-11-21T08:00:00+00:00" },
      { id: 3, agent_crm_id: 501, agent_hr_id: "b-7", list_type: "PM", updated_at: "2026-11-19T08:00:00+00:00" },
      { id: 4, agent_crm_id: 900, agent_hr_id: null, list_type: "Pharmacy", updated_at: null },
      { id: 5, agent_crm_id: null, agent_hr_id: "B-7", list_type: "PM", updated_at: "2026-11-22T08:00:00+00:00" },
      { id: 6, agent_crm_id: 900, agent_hr_id: null, list_type: "odd", updated_at: "2026-11-01T08:00:00+00:00" },
      { id: 7, agent_crm_id: null, agent_hr_id: null, list_type: "PM", updated_at: null },
      { id: 8, agent_crm_id: 77, agent_hr_id: "PD-0026", list_type: "PM", updated_at: "2026-11-02T08:00:00+00:00" },
    ];
    const groups = new Map<string, RepListSummaryGroupTuple>();
    for (const row of rows) {
      const key = JSON.stringify([row.agent_hr_id, row.agent_crm_id, row.list_type]);
      const group = groups.get(key);
      if (!group) {
        groups.set(key, [row.id, row.agent_crm_id, row.agent_hr_id, row.list_type, 1, row.updated_at]);
        continue;
      }
      group[4] += 1;
      if (row.updated_at && (!group[5] || row.updated_at > group[5])) group[5] = row.updated_at;
    }
    const tuples = [...groups.values()].sort((left, right) => left[0] - right[0]);
    assert.ok(tuples.length < rows.length, "the fixture must actually group rows, or it proves nothing about the weights");
    assert.deepEqual(
      summarizeRepLists(tuples.map(repListRecordFromGroup)),
      summarizeRepLists(rows),
      "the grouped tuples must summarize to exactly what the raw rows do",
    );
    assert.deepEqual(
      repListRecordFromGroup([4, "900" as unknown as number, null, "Pharmacy", "2" as unknown as number, null]),
      { agent_crm_id: 900, agent_hr_id: null, list_type: "Pharmacy", rows: 2, updated_at: null },
      "jsonb numbers arriving as strings are read as numbers",
    );

    const migration = readFileSync(
      "supabase/migrations/20261123160756_crm_rep_contact_list_summaries_in_one_statement.sql",
      "utf8",
    ).replace(/\r\n/g, "\n");
    assert.ok(
      migration.includes("where a.effective_to is null") &&
        migration.includes("group by a.agent_hr_id, a.agent_crm_id, a.list_type") &&
        migration.includes("order by g.first_id") &&
        migration.includes("revoke execute on function public.phx_crm_rep_list_summary_groups() from public, anon, authenticated;") &&
        migration.includes("grant execute on function public.phx_crm_rep_list_summary_groups() to service_role;"),
      "the function must group the open rows by (HR id, CRM account, list), order by each group's lowest id, and stay service-role only",
    );
  }

  // ── The one-statement rep -> CRM account lookup keeps its service-role-only grant ────────────────
  // (2026-10-25 production load audit.) The function and its index live in the database whether or
  // not the code that called it does, so the migration that creates them stays pinned.
  {
    const migration = readFileSync("supabase/migrations/20261025233000_crm_plan_entries_agent_hr_id_index.sql", "utf8");
    assert.ok(
      migration.includes("on public.ireports360_plan_entries (agent_hr_id, agent_crm_id);") &&
        migration.includes("grant execute on function public.phx_crm_agent_crm_ids_by_hr(text[]) to service_role;") &&
        migration.includes("revoke execute on function public.phx_crm_agent_crm_ids_by_hr(text[]) from public, anon, authenticated;"),
      "the migration must carry the plain (agent_hr_id, agent_crm_id) index and keep the function service-role only",
    );
  }
}
