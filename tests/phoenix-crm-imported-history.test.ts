import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { archiveReasonLabel } from "../src/lib/phoenix-crm/list-request-rules.ts";
import {
  VISIT_ASK_MARKETING_MANAGER_LINE_CODES,
  VISIT_ASK_MARKETING_MANAGER_ROLE,
  VISIT_ASK_PRODUCT_MANAGER_ROLES,
  VISIT_ASK_TRAINING_MANAGER_ROLE,
} from "../src/lib/phoenix-crm/visit-ask-rules.ts";
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

/** One function, from its declaration to the closing brace at the declaration's own indentation, comments stripped. */
function body(path: string, declaration: string): string {
  const text = read(path);
  const start = text.indexOf(declaration);
  assert.notEqual(start, -1, `${path}: ${declaration} is gone — re-point this pin at whatever replaced it`);
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, start))?.[0] ?? "";
  const end = text.indexOf(`\n${indent}}\n`, start);
  // Never the rest of the file: a pin that read past the function could pass on another function's filter.
  assert.notEqual(end, -1, `${path}: ${declaration} has no closing brace at its own indentation — re-point this pin`);
  return stripComments(text.slice(start, end));
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

const migrationNames = (): string[] =>
  readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();

/** The NEWEST migration whose comment-stripped text matches, oldest-first by name, with that text. */
function newestDefiner(pattern: RegExp, what: string): { file: string; sql: string } {
  let found: { file: string; sql: string } | null = null;
  for (const name of migrationNames()) {
    const sql = stripSqlComments(read(`supabase/migrations/${name}`));
    if (pattern.test(sql)) found = { file: `supabase/migrations/${name}`, sql };
  }
  assert.ok(found, `no migration defines ${what}`);
  return found;
}

/** The text of one SQL object from its CREATE to the end of its dollar-quoted body (or its first `;`). */
function sqlObject(sql: string, create: string): string {
  // Exact: `…phoenix_crm_countable_visits` must never land on `…phoenix_crm_countable_visits_with_history`.
  let start = sql.indexOf(create);
  while (start !== -1 && /\w$/.test(create) && /\w/.test(sql.charAt(start + create.length))) start = sql.indexOf(create, start + 1);
  assert.notEqual(start, -1, `${create} not found`);
  const close = sql.indexOf("$function$;", start);
  const semicolon = sql.indexOf(";", start);
  const quoted = sql.slice(start, semicolon).includes("$function$");
  // `slice(start, -1)` would be the rest of the file, and a pin could pass on another object's text.
  if (quoted) assert.notEqual(close, -1, `${create}: its body opens with $function$ but never closes with $function$;`);
  return sql.slice(start, quoted ? close : semicolon).replace(/\s+/g, " ");
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
      path: "src/lib/phoenix-crm/server/visits.ts",
      declaration: "export async function loadSeatPharmacies(",
      skips: 1,
      why: "a name on a copied visit is offered, and picking it files a new pending pharmacy while the imported one keeps the history",
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

  // ── 1b. THE RATCHET: every read of the visits is counted, per file ───────────
  // The owner asked for the history "as if it is a complete data", so most screens count it — but a new read
  // of phoenix_crm_visits or phoenix_crm_countable_visits_with_history must say which kind it is: it names the
  // mark in its own statement, or the number below goes up by hand, on purpose. Counted per READ and never per
  // file: a file with one filter, or one column naming the mark, used to pass every other read beside it,
  // which is how the pharmacy picker in visits.ts went unseen. A number is what stands today, not a verdict on
  // each read. phoenix_crm_countable_visits is not counted: since 20261031160000 it skips the copy itself.
  const unmarkedReadsToday: Record<string, number> = {
    "src/lib/crm/phoenix-work-evidence.ts": 1,
    "src/lib/customer-identity/server/reads.ts": 2,
    "src/lib/phoenix-crm/server/behaviour.ts": 1,
    "src/lib/phoenix-crm/server/call-prep.ts": 1,
    "src/lib/phoenix-crm/server/commitments.ts": 1,
    "src/lib/phoenix-crm/server/customer-timeline.ts": 1,
    "src/lib/phoenix-crm/server/daily-plan-report.ts": 1,
    "src/lib/phoenix-crm/server/day-route.ts": 2,
    "src/lib/phoenix-crm/server/double-visit-plans.ts": 1,
    "src/lib/phoenix-crm/server/insight-reports.ts": 1,
    "src/lib/phoenix-crm/server/integrity-board.ts": 3,
    "src/lib/phoenix-crm/server/list.ts": 2,
    "src/lib/phoenix-crm/server/location-integrity.ts": 2,
    "src/lib/phoenix-crm/server/manager-customer-marks.ts": 1,
    "src/lib/phoenix-crm/server/manager-plan-report.ts": 1,
    "src/lib/phoenix-crm/server/manager-visit-details.ts": 3,
    "src/lib/phoenix-crm/server/master-list.ts": 1,
    "src/lib/phoenix-crm/server/missed-records.ts": 1,
    "src/lib/phoenix-crm/server/my-map.ts": 1,
    "src/lib/phoenix-crm/server/named-pharmacies.ts": 1,
    "src/lib/phoenix-crm/server/offplan-cap.ts": 2,
    "src/lib/phoenix-crm/server/offplan-day.ts": 2,
    "src/lib/phoenix-crm/server/plan-insight.ts": 1,
    "src/lib/phoenix-crm/server/refused-readings-board.ts": 1,
    "src/lib/phoenix-crm/server/reports.ts": 3,
    "src/lib/phoenix-crm/server/silent-detectors.ts": 1,
    "src/lib/phoenix-crm/server/team-calendar.ts": 4,
    "src/lib/phoenix-crm/server/team.ts": 1,
    "src/lib/phoenix-crm/server/unplanned.ts": 2,
    "src/lib/phoenix-crm/server/validation-reviews.ts": 1,
    "src/lib/phoenix-crm/server/visit-detail-edit.ts": 1,
    "src/lib/phoenix-crm/server/visit-edit.ts": 1,
    "src/lib/phoenix-crm/server/visit-locations.ts": 1,
    "src/lib/phoenix-crm/server/visit-recordings.ts": 3,
    "src/lib/phoenix-crm/server/visit-report.ts": 3,
    "src/lib/phoenix-crm/server/visit-rollup.ts": 1,
    "src/lib/phoenix-crm/server/visits.ts": 2,
    "src/lib/phoenix-crm/server/week-progress.ts": 1,
    "src/lib/system-audit/detectors/visit-lifecycle.ts": 15,
  };
  const sources = (dir: string): string[] =>
    readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true }).flatMap((entry) => {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return sources(child);
      return /\.tsx?$/.test(entry.name) ? [child] : [];
    });
  // One read runs from its mention of the source to the next mention or the end of its statement.
  const unmarkedReads = (code: string): number => {
    const mentions = [...code.matchAll(/\bphoenix_crm_(?:visits|countable_visits_with_history)\b/g)].map((match) => match.index);
    return mentions.filter((at, index) => {
      const semicolon = code.indexOf(";", at);
      const end = Math.min(mentions[index + 1] ?? code.length, semicolon === -1 ? code.length : semicolon);
      return !code.slice(at, end).includes("imported_from_ireports360_at");
    }).length;
  };
  const unmarkedNow: Record<string, number> = {};
  for (const file of [...sources("src"), ...sources("app")]) {
    const found = unmarkedReads(stripComments(read(file)));
    if (found > 0) unmarkedNow[file] = found;
  }
  assert.deepEqual(
    unmarkedNow,
    unmarkedReadsToday,
    "a read of the Phoenix CRM visits changed: a new one skips a copied iReports360 visit by its mark in its own statement (anything that judges, alarms or pays), or raises its file's number above if it counts the history on purpose; a read that left or now names the mark lowers it",
  );

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
    {
      path: "src/lib/phoenix-crm/server/list.ts",
      declaration: "export async function loadListedPharmacies(",
      why: "a pharmacy the import put in the Archive must not refuse Add a pharmacy, or leave a named pharmacy unfiled",
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

  // ── 2b. The countable view skips the copy at its root; the history view is the only one that keeps it ──
  {
    const { file, sql } = newestDefiner(/create or replace view public\.phoenix_crm_countable_visits\b/, "phoenix_crm_countable_visits");
    const countable = sqlObject(sql, "create or replace view public.phoenix_crm_countable_visits");
    const FILTER = " and v.imported_from_ireports360_at is null";
    assert.ok(
      countable.endsWith(FILTER),
      `${file}: phoenix_crm_countable_visits must end with \`${FILTER.trim()}\` — a new reader that forgets the mark must still never count ~69,000 copied visits as Phoenix work`,
    );
    const history = newestDefiner(/create or replace view public\.phoenix_crm_countable_visits_with_history\b/, "phoenix_crm_countable_visits_with_history");
    assert.equal(
      sqlObject(history.sql, "create or replace view public.phoenix_crm_countable_visits_with_history").replace("_with_history", ""),
      countable.slice(0, -FILTER.length),
      `${history.file}: the history view is the countable view without the import filter — every other rule the same`,
    );
  }
  for (const report of ["brick_coverage", "coverage", "manager_visits", "visits_by_day"]) {
    const create = `create or replace function public.phoenix_crm_report_${report}(`;
    const { file, sql } = newestDefiner(new RegExp(String.raw`create or replace function public\.phoenix_crm_report_${report}\(`), `phoenix_crm_report_${report}`);
    const start = sql.indexOf(create);
    const end = sql.indexOf("$$;", start);
    assert.notEqual(end, -1, `${file}: phoenix_crm_report_${report} has no closing $$;`);
    const fn = sql.slice(start, end);
    assert.match(fn, /public\.phoenix_crm_countable_visits_with_history\b/, `${file}: phoenix_crm_report_${report} shows the rep's whole year — it reads the history view`);
    assert.doesNotMatch(fn, /public\.phoenix_crm_countable_visits\b/, `${file}: phoenix_crm_report_${report} must not read the view that skips the copy`);
  }

  // ── 3. The triggers ─────────────────────────────────────────────────────────
  {
    const { file, sql } = newestDefiner(/create or replace trigger phoenix_crm_customers_write_contact_name_row\b/, "the contact-name trigger");
    assert.ok(file >= IMPORT_MIGRATION, `the contact-name trigger's newest definer (${file}) predates the import`);
    assert.match(
      sqlObject(sql, "create or replace trigger phoenix_crm_customers_write_contact_name_row"),
      /when \( new\.reference_contact_crm_id is null and not new\.is_test and new\.status in \('active', 'pending', 'dropped'\) and not new\.campaign_visit_holder \)/,
      "no \"Campaign visit N\" ever reaches crm_contacts",
    );
    const trigger = newestDefiner(/create or replace trigger phoenix_crm_customers_clear_import_mark\b/, "the clear-mark trigger");
    assert.match(
      sqlObject(trigger.sql, "create or replace trigger phoenix_crm_customers_clear_import_mark"),
      /create or replace trigger phoenix_crm_customers_clear_import_mark before update of status on public\.phoenix_crm_customers for each row when \(old\.imported_from_ireports360_at is not null\)/,
      "a doctor restored from the Archive is an ordinary customer again",
    );
    const clearMark = newestDefiner(/create or replace function public\.phoenix_crm_customers_clear_import_mark\(/, "the clear-mark function");
    assert.match(
      sqlObject(clearMark.sql, "create or replace function public.phoenix_crm_customers_clear_import_mark("),
      /if old\.status = 'dropped' and new\.status <> 'dropped' and not new\.campaign_visit_holder then new\.imported_from_ireports360_at := null;/,
    );
  }
  {
    const { sql } = newestDefiner(/create or replace function public\.phoenix_crm_rep_entry_days_on_visit\(/, "the entry-days trigger function");
    const fn = sqlObject(sql, "create or replace function public.phoenix_crm_rep_entry_days_on_visit(");
    assert.match(fn, /if old\.imported_from_ireports360_at is null then perform public\.phoenix_crm_rep_entry_days_touch\(old\./, "a copied visit can never be an entry day, so removing one recomputes nothing");
    assert.match(fn, /if new\.imported_from_ireports360_at is null then perform public\.phoenix_crm_rep_entry_days_touch\(new\./, "and copying ~69,000 visits touches the cache not once");
  }
  {
    const { sql } = newestDefiner(/create or replace function public\.phoenix_crm_edit_visit_detail\(/, "the rep's write-up");
    const fn = sqlObject(sql, "create or replace function public.phoenix_crm_edit_visit_detail(");
    assert.match(
      fn,
      /if v_visit\.imported_from_ireports360_at is not null then raise exception 'phoenix_crm:visit_is_history';/,
      "a pharmacy named on a copied visit would file an unmarked visit dated before the rep's start",
    );
    for (const write of ["insert into public.phoenix_crm_visit_edits", "update public.phoenix_crm_visits"]) {
      const at = fn.indexOf(write);
      assert.ok(at !== -1 && fn.indexOf("'phoenix_crm:visit_is_history'") < at, `the refusal must come before ${write}: below it, the write is already done`);
    }
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
    const definer = newestDefiner(/create or replace function public\.phoenix_crm_import_ireports360_history\(/, "phoenix_crm_import_ireports360_history");
    const migration = definer.sql.replace(/\s+/g, " ");
    const copy = sqlObject(migration, "create or replace function public.phoenix_crm_import_ireports360_history(");
    assert.match(copy, /security definer set search_path to 'public'/);
    assert.match(copy, /if p_apply and v_seat is null then raise exception 'phoenix_crm:import_needs_a_seat'/, "a write is one seat at a time");
    assert.match(copy, /'admin', v_now from phx_import_rows r where not r\.conflict/, "every copied row is the admin shape and carries the mark");
    assert.match(copy, /on conflict \(seat_id, customer_id, visit_date, is_test\) do nothing/, "a visit already in Phoenix is never overwritten");
    assert.match(copy, /on conflict \(crm_visit_id\) do nothing/, "a second run never writes an old visit twice");
    assert.match(migration, /revoke execute on function public\.phoenix_crm_import_ireports360_history\(text, boolean\) from public, anon, authenticated;/);
    assert.match(migration, /grant execute on function public\.phoenix_crm_import_ireports360_history\(text, boolean\) to service_role;/);
    assert.match(
      stripSqlComments(read(IMPORT_MIGRATION)).replace(/\s+/g, " "),
      /alter table public\.phoenix_crm_imported_visit_sources enable row level security; revoke all on table public\.phoenix_crm_imported_visit_sources from public, anon, authenticated;/,
    );
    // The first migration closes it; any migration, then or since, could open it again.
    for (const name of migrationNames()) {
      const sql = stripSqlComments(read(`supabase/migrations/${name}`)).replace(/\s+/g, " ");
      assert.doesNotMatch(sql, /grant [^;]*\bon (?:table )?public\.phoenix_crm_imported_visit_sources\b[^;]*\bto\b[^;]*\b(?:public|anon|authenticated)\b/i, `${name}: the source map is the service role's alone`);
      assert.doesNotMatch(sql, /alter table public\.phoenix_crm_imported_visit_sources (?:disable|no force) row level security/i, `${name}: the source map stays behind row level security`);
      assert.doesNotMatch(sql, /create policy [^;]*\bon public\.phoenix_crm_imported_visit_sources\b/i, `${name}: the source map carries no policy`);
    }

    // The rules of the copy, each from the review of 2026-10-31.
    assert.match(copy, /or exists \(select 1 from phx_import_links l where l\.contact_crm_id = contact\.id and l\.customer_id = cu\.id\)/, "a doctor the rep added himself is found through his identity link");
    assert.match(copy, /create index on phx_import_links \(contact_crm_id, customer_id\); analyze phx_import_links;/, "and that link is looked up, never scanned, for every customer of the seat on every old visit");
    assert.match(copy, /order by \(cu\.imported_from_ireports360_at is null\) desc, \(cu\.reference_contact_crm_id is not distinct from contact\.id\) desc,/, "his own customer beats an Archive copy an earlier run made");
    assert.doesNotMatch(copy, /own_contact_crm_id/, "an own id sits in a reserved band, so that arm could never match");
    assert.doesNotMatch(copy, /job_title ilike/, "the partner's kind is his app role, never a match on his title");
    const sqlList = (roles: readonly string[]): string => roles.map((role) => `'${role}'`).join(", ");
    assert.ok(copy.includes(`when who.role in (${sqlList([...VISIT_ASK_PRODUCT_MANAGER_ROLES, VISIT_ASK_TRAINING_MANAGER_ROLE])}) then 'product_manager'`), "a training manager files as a product manager does, never as a double, by the visit form's own role names");
    assert.ok(copy.includes(`when who.role = '${VISIT_ASK_MARKETING_MANAGER_ROLE}' and lower(c.line_code) = '${[...VISIT_ASK_MARKETING_MANAGER_LINE_CODES].join()}' then 'product_manager'`), "the marketing manager on the visit form's own lines only");
    assert.match(copy, /case when that_day\.in_manager_seat then 'double' when that_day\.seated then null when who\.role in/, "the seat of the visit's day decides, and today's role is only for a day with no seat");
    assert.match(copy, /split_part\(o\.seat_id, '-', 3\) in \('DM', 'ADM', 'RSM', 'NSM'\)/, "an acting district manager's seat is a manager's seat");
    assert.match(copy, /'partners_dropped', \(select count\(\*\) from phx_import_keyed where partner_dropped\)/, "a dry run says how many partners the copy would not file");
    assert.match(copy, /where r\.conflict and cu\.reference_contact_crm_id is null and not cu\.campaign_visit_holder/, "and how many unmapped visits sit on a doctor no old-system line covers");
    assert.match(copy, /when who\.role in \('District Manager', 'Regional Manager', 'National Sales Manager'\) then 'double'/, "only a manager is a double, so a peer rep is no partner");
    assert.equal(count(copy, "nullif(iv.contact_crm_id, 0)"), 1, "no contact is one value, read once by the source row and the customer lookup alike");
    assert.match(copy, /and iv\.contact_crm_id is distinct from 100000/, "the catch-all contact is not copied: it names nobody, and its visits are not campaign visits");
    assert.match(copy, /\) = 'pharmacy' then 'Pharmacy' else coalesce\(own_list\.list_type, any_list\.list_type, a\.majority_list\) end as list_type/, "a pharmacy is never filed as a doctor");
    assert.match(copy, /group by k\.seat_id, k\.grp, k\.visit_date, k\.rep_hr_id;/, "two reps on one seat are never merged under one name");
    assert.match(copy, /and \(e\.captured_at, e\.rep_hr_id\) < \(r\.captured_at, r\.rep_hr_id\)/, "and the later one stays unmapped, on the List's old-system line");
    assert.match(copy, /iv\.visit_type = -8 and not exists \(/, "a day with no seat keeps only its campaign visits");
    assert.doesNotMatch(copy, /o\.seat_id <> c\.seat_id/, "a visit is kept for holding THIS seat, not for not holding another");
  }
}
