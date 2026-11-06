import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { LIST_TYPES } from "../src/lib/crm/list-types.ts";
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
