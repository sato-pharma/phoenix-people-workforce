import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { archiveReasonLabel } from "../src/lib/phoenix-crm/list-request-rules.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTED HISTORY IS HISTORY: NOTHING THAT JUDGES, ALARMS OR PAYS READS IT.
//
// Owner, 2026-10-29: every current rep's 2026 iReports360 visits, 1 January up to the day before his
// team started on Phoenix, are copied into phoenix_crm_visits "as if it is a complete data"
// (20261029212200; account: docs/phoenix-crm-ireports360-history-import.md). ~69,000 rows, each
// marked `imported_from_ireports360_at`, all saved on ONE day for days months back.
//
// WHAT THIS FILE GUARDS:
//   · EVERY READER THAT JUDGES, ALARMS OR PAYS SKIPS A COPIED VISIT — by the mark, in the query.
//     Read without it: deductions and Field Workforce Compliance credit a partner the old system never
//     named; the first-visit gate never fires again; the third-visit rule refuses a visit he has every
//     right to make; ranks, exceptions and the roster sweep judge months nobody worked on Phoenix; the
//     visit-lifecycle detector buries every real touch under 69,000 rows "created today".
//   · A CUSTOMER THE IMPORT MADE OPENS NO TERRITORY AND IS NOT ON THE LIST THE REP BUILT, and a
//     "Campaign visit N" holder (which names no doctor) is on neither the List, the Archive nor the
//     identity candidates.
//   · THE TWO SQL READERS, THE VIEW, THE TRIGGERS AND THE CONTACT REFRESH — each read from its NEWEST
//     definer by content, so a later `create or replace` that drops the condition goes red here.
//   · THE HISTORY SCREENS KEEP IT. The Frequency and tracking sheet reader must never learn the mark:
//     the history is the rep's, and hiding it is the opposite of what the owner asked for.
//   · Every source is read with its comments stripped, so the comment that explains a filter can
//     never stand in for the filter itself.
// ─────────────────────────────────────────────────────────────────────────────

const IMPORT_MIGRATION = "supabase/migrations/20261029212200_phoenix_crm_imports_ireports360_history.sql";
const REFRESH_MIGRATION = "supabase/migrations/20261029212300_the_contact_refresh_skips_imported_customers.sql";
const SKIP_VISIT = '.is("imported_from_ireports360_at", null)';
const SKIP_HOLDER = '.eq("campaign_visit_holder", false)';

const read = (relativePath: string): string =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** One top-level function, from its declaration to the first closing brace at column 0, comments stripped. */
function body(path: string, declaration: string): string {
  const text = read(path);
  const start = text.indexOf(declaration);
  assert.notEqual(start, -1, `${path}: ${declaration} is gone — re-point this pin at whatever replaced it`);
  const end = text.indexOf("\n}\n", start);
  return stripComments(text.slice(start, end === -1 ? text.length : end));
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** The NEWEST migration whose comment-stripped text matches, oldest-first by name, with that text. */
function newestDefiner(pattern: RegExp, what: string): { file: string; sql: string } {
  const names = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let found: { file: string; sql: string } | null = null;
  for (const name of names) {
    const sql = stripSqlComments(read(`supabase/migrations/${name}`));
    if (pattern.test(sql)) found = { file: `supabase/migrations/${name}`, sql };
  }
  assert.ok(found, `no migration defines ${what}`);
  return found;
}

/** The text of one SQL object from its CREATE to the end of its dollar-quoted body (or its first `;`). */
function sqlObject(sql: string, create: string): string {
  const start = sql.indexOf(create);
  assert.notEqual(start, -1, `${create} not found`);
  const close = sql.indexOf("$function$;", start);
  const semicolon = sql.indexOf(";", start);
  const end = sql.slice(start, semicolon).includes("$function$") ? close : semicolon;
  return sql.slice(start, end).replace(/\s+/g, " ");
}

export function runPhoenixCrmImportedHistoryTests() {
  // ── 1. The readers that judge, alarm or pay ─────────────────────────────────
  const visitReaders: Array<{ path: string; declaration: string; skips: number; why: string }> = [
    {
      path: "src/lib/crm/phoenix-work-evidence.ts",
      declaration: "export async function loadPhoenixWorkEvidenceDays(",
      skips: 1,
      why: "deductions, Field Workforce Compliance and the calendar — the old days are the iReports360 door's, and a copied row credits a partner the door never named",
    },
    {
      path: "src/lib/phoenix-crm/server/visits.ts",
      declaration: "async function isFirstVisitSubmittedBy(",
      skips: 1,
      why: "a copied visit was never submitted here — counted, no rep's first visit would ever be his first",
    },
    {
      path: "src/lib/phoenix-crm/server/visits.ts",
      declaration: "export async function saveVisit(",
      skips: 1,
      why: "the third-visit rule — counted, it refuses a visit he has every right to make",
    },
    {
      path: "src/lib/phoenix-crm/server/silent-detectors.ts",
      declaration: "async function runRosterAndCadence(",
      skips: 1,
      why: "the roster and cadence sweep judges Phoenix work, not the old system's",
    },
    {
      path: "src/lib/rep-ranks/server/compute.ts",
      declaration: "async function readVisits(",
      skips: 1,
      why: "ranks read Phoenix CRM only",
    },
    {
      path: "src/lib/rep-ranks/server/compute.ts",
      declaration: "async function readFieldSaves(",
      skips: 1,
      why: "ranks read Phoenix CRM only",
    },
    {
      path: "src/lib/rep-ranks/server/compute.ts",
      declaration: "async function readFirstVisitDayOf(",
      skips: 1,
      why: "owed days start at the first REAL Phoenix visit, not one copied from January",
    },
    {
      path: "src/lib/phoenix-crm/server/exceptions.ts",
      declaration: "async function loadVisitTallies(",
      skips: 1,
      why: "the exceptions board judges Phoenix tallies",
    },
    {
      path: "src/lib/system-audit/detectors/visit-lifecycle.ts",
      declaration: "export function createDatabaseVisitLifecyclePorts(",
      skips: 2,
      why: "both visit reads — 69,000 rows created on one day would bury every real touch",
    },
  ];
  for (const { path, declaration, skips, why } of visitReaders) {
    const code = body(path, declaration);
    assert.equal(count(code, SKIP_VISIT), skips, `${path}: ${declaration} must skip a copied iReports360 visit ${skips} time(s) — ${why}`);
  }

  const customerReaders: Array<{ path: string; declaration: string; why: string }> = [
    {
      path: "src/lib/crm/phoenix-team-readiness-server.ts",
      declaration: "async function loadSeatLists(",
      why: "an Archive doctor or a holder the import made is not part of the list the rep built",
    },
    {
      path: "src/lib/phoenix-crm/server/insight-reports.ts",
      declaration: "async function capacityLists(",
      why: "a customer the import made opens no territory",
    },
  ];
  for (const { path, declaration, why } of customerReaders) {
    assert.equal(count(body(path, declaration), SKIP_VISIT), 1, `${path}: ${declaration} must skip an imported customer — ${why}`);
  }

  const holderReaders: Array<{ path: string; declaration: string; why: string }> = [
    {
      path: "src/lib/phoenix-crm/server/list.ts",
      declaration: "export async function loadTerritoryCustomers(",
      why: "a \"Campaign visit N\" holder is no customer: on neither the List nor the Archive",
    },
    {
      path: "src/lib/customer-identity/server/reads.ts",
      declaration: "async function phoenixCrmCandidates(",
      why: "a holder names no doctor, so it is never an identity candidate",
    },
  ];
  for (const { path, declaration, why } of holderReaders) {
    assert.equal(count(body(path, declaration), SKIP_HOLDER), 1, `${path}: ${declaration} must leave out campaign-visit holders — ${why}`);
  }

  // The history screens KEEP it — the owner asked for the history, not for it to be counted somewhere else.
  assert.doesNotMatch(
    stripComments(read("src/lib/phoenix-crm/server/reports.ts")),
    /imported_from_ireports360_at/,
    "Frequency and the tracking sheet show the rep's whole history — a copied visit is his, and hiding it undoes the import",
  );

  // The Archive says why the doctor is there.
  assert.equal(archiveReasonLabel("imported_history"), "Visited in the old system, not on your Phoenix list");

  // ── 2. The SQL readers, each from its newest definer ────────────────────────
  {
    const { file, sql } = newestDefiner(/create or replace function public\.phoenix_crm_seats_with_activity\(/, "phoenix_crm_seats_with_activity");
    assert.ok(file >= IMPORT_MIGRATION, `the digest reader's newest definer (${file}) predates the import`);
    const fn = sqlObject(sql, "create or replace function public.phoenix_crm_seats_with_activity(");
    assert.match(
      fn,
      /exists \(select 1 from public\.phoenix_crm_visits t where t\.seat_id = asked\.seat_id and t\.is_test = false and t\.imported_from_ireports360_at is null\)/,
      "the 06:55 digest: a seat whose only visits are copied history has no activity on Phoenix",
    );
    assert.equal(count(fn, "t.is_test = false"), 6, "all six activity tables still ask for real rows only");
  }
  {
    const { file, sql } = newestDefiner(/create or replace function public\.phx_crm_contact_visit_history\(/, "phx_crm_contact_visit_history");
    assert.ok(file >= IMPORT_MIGRATION, `the List line's newest definer (${file}) predates the import`);
    assert.match(
      sqlObject(sql, "create or replace function public.phx_crm_contact_visit_history("),
      /and not exists \( select 1 from public\.phoenix_crm_imported_visit_sources s where s\.crm_visit_id = v\.crm_visit_id \)/,
      "the List's \"N visits in iReports360\" line never counts an old visit already copied into Phoenix",
    );
  }
  {
    const { file, sql } = newestDefiner(/create or replace view public\.phoenix_crm_countable_visits\b/, "phoenix_crm_countable_visits");
    assert.ok(file >= IMPORT_MIGRATION, `the countable view's newest definer (${file}) predates the import`);
    assert.match(
      sqlObject(sql, "create or replace view public.phoenix_crm_countable_visits"),
      /v\.product_manager_hr_id, v\.imported_from_ireports360_at from public\.phoenix_crm_visits v/,
      "the view carries the mark, appended last, so ranks and exceptions can skip a copied visit by name",
    );
  }

  // ── 3. The triggers ─────────────────────────────────────────────────────────
  {
    const { sql } = newestDefiner(/create or replace trigger phoenix_crm_customers_write_contact_name_row\b/, "the contact-name trigger");
    assert.match(
      sqlObject(sql, "create or replace trigger phoenix_crm_customers_write_contact_name_row"),
      /when \( new\.reference_contact_crm_id is null and not new\.is_test and new\.status in \('active', 'pending', 'dropped'\) and not new\.campaign_visit_holder \)/,
      "no \"Campaign visit N\" ever reaches crm_contacts",
    );
    const migration = stripSqlComments(read(IMPORT_MIGRATION)).replace(/\s+/g, " ");
    assert.match(
      migration,
      /create or replace trigger phoenix_crm_customers_clear_import_mark before update of status on public\.phoenix_crm_customers for each row when \(old\.imported_from_ireports360_at is not null\)/,
      "a doctor restored from the Archive is an ordinary customer again",
    );
    assert.match(migration, /if old\.status = 'dropped' and new\.status <> 'dropped' and not new\.campaign_visit_holder then new\.imported_from_ireports360_at := null;/);
  }

  // ── 4. The contact refresh writes no list row and no name for an imported customer ──
  {
    const { file, sql } = newestDefiner(/create or replace function public\.crm_contact_master_refresh\(/, "crm_contact_master_refresh");
    assert.ok(file >= REFRESH_MIGRATION, `the refresh's newest definer (${file}) predates the import`);
    assert.match(
      sqlObject(sql, "create or replace function public.crm_contact_master_refresh("),
      /and c\.imported_from_ireports360_at is null;/,
      "the customers snapshot skips an Archive doctor or a holder the import made",
    );
  }

  // ── 5. The copy itself ──────────────────────────────────────────────────────
  {
    const migration = stripSqlComments(read(IMPORT_MIGRATION)).replace(/\s+/g, " ");
    const copy = sqlObject(migration, "create or replace function public.phoenix_crm_import_ireports360_history(");
    assert.match(copy, /security definer set search_path to 'public'/);
    assert.match(copy, /if p_apply and v_seat is null then raise exception 'phoenix_crm:import_needs_a_seat'/, "a write is one seat at a time");
    assert.match(copy, /'admin', v_now from phx_import_rows r where not r\.conflict/, "every copied row is the admin shape and carries the mark");
    assert.match(copy, /on conflict \(seat_id, customer_id, visit_date, is_test\) do nothing/, "a visit already in Phoenix is never overwritten");
    assert.match(copy, /on conflict \(crm_visit_id\) do nothing/, "a second run writes nothing");
    assert.match(migration, /revoke execute on function public\.phoenix_crm_import_ireports360_history\(text, boolean\) from public, anon, authenticated;/);
    assert.match(migration, /grant execute on function public\.phoenix_crm_import_ireports360_history\(text, boolean\) to service_role;/);
    assert.match(migration, /alter table public\.phoenix_crm_imported_visit_sources enable row level security; revoke all on table public\.phoenix_crm_imported_visit_sources from public, anon, authenticated;/);
  }
}
