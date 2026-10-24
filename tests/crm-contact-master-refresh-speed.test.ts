import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * The contact-master refresh stops doing work that cannot change anything.
 *
 * Found in the 16 October 2026 slowness audit: `crm_contact_master_refresh()` averaged 2,951 ms over 517
 * calls (peak 7,896 ms against PostgREST's 8 s cut) and runs after every contact-list sync slice. Timed
 * statement by statement on production inside rolled-back transactions, four things made the time:
 *
 *   1. five "is this a started rep?" tests joined the 88-row temp table with an OR of two conditions,
 *      which no join method hashes — a nested loop of 12,142 open assignments by ~56 reps, 675,218
 *      comparisons, 1,235 ms for the frozen count alone;
 *   2. the region-from-name update read all 142,560 visits (209 MB) and sorted 104,240 of them every run to
 *      hand a region id to contacts that carry a region NAME and no id — and there are 0 such contacts;
 *   3. + 4. the two `ON CONFLICT DO UPDATE ... WHERE` upserts into crm_contacts locked every conflicting
 *      row (11,139 and 12,454) before their filter threw nearly all of them away: 11,900 WAL records and 656
 *      full-page images a run.
 *
 * The migration `20261016233000` changes exactly those statements and nothing else; the returned counts
 * and a checksum of every column of both tables were identical, old against new, on staging in three
 * scenarios and on production unperturbed. This file pins the SHAPE, because every one of these failures is
 * silent: put any of them back and every number stays right while the job goes back to three seconds.
 */

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);

/** The newest migration that defines the function, found by CONTENT — a later redefinition resolves. */
function newestDefinition(): { file: string; sql: string; code: string; body: string } {
  let found: { file: string; sql: string } | null = null;
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(name, MIGRATIONS), "utf8").replace(/\r\n/g, "\n");
    if (/create\s+or\s+replace\s+function\s+public\.crm_contact_master_refresh\s*\(/i.test(sql)) {
      found = { file: name, sql };
    }
  }
  assert.ok(found, "no migration defines crm_contact_master_refresh");
  const start = found!.sql.indexOf("create or replace function public.crm_contact_master_refresh(");
  const open = found!.sql.indexOf("$function$", start) + "$function$".length;
  const close = found!.sql.indexOf("$function$", open);
  assert.ok(start >= 0 && close > open, `${found!.file}: the function body must sit between $function$ markers`);
  const body = found!.sql.slice(open, close);
  return { ...found!, body, code: stripSqlComments(body).replace(/\s+/g, " ") };
}

export function runCrmContactMasterRefreshSpeedTests() {
  const { file, sql, code, body } = newestDefinition();

  // ── 1. THE STARTED REPS ARE READ ONCE, INTO ARRAYS ──────────────────────────────────────────────
  assert.match(code, /v_started_keys text\[\];/, `${file}: the started hr keys live in a text[] variable`);
  assert.match(code, /v_started_crm_ids bigint\[\];/, `${file}: the started agent ids live in a bigint[] variable`);
  assert.match(
    code,
    /select coalesce\(array_agg\(s\.hr_key\) filter \(where s\.hr_key is not null\), '\{\}'::text\[\]\), coalesce\(array_agg\(s\.agent_crm_id\) filter \(where s\.agent_crm_id is not null\), '\{\}'::bigint\[\]\) into v_started_keys, v_started_crm_ids from pg_temp\.crm_refresh_started_reps s;/,
    `${file}: the arrays are built ONCE from the temp table, with NULLs filtered out — a NULL element would make "= any" answer NULL, and "not (NULL)" is not true, which would flip a row from kept to dropped`,
  );
  assert.doesNotMatch(
    code,
    /exists \( ?select 1 from pg_temp\.crm_refresh_started_reps/,
    `${file}: the temp table must never be joined per row again — the OR of two conditions cannot be hashed, so it ran as a nested loop of 12,142 x 56 (675,218 comparisons, 1.2 s)`,
  );
  assert.equal(
    (code.match(/pg_temp\.crm_refresh_started_reps/g) ?? []).length,
    2,
    `${file}: the temp table is dropped-if-exists once and read once (into the arrays)`,
  );
  assert.equal(
    (code.match(/= any \(v_started_keys\)/g) ?? []).length,
    5,
    `${file}: the frozen count and the four vendor passes each test the hr id against the started keys`,
  );
  assert.equal(
    (code.match(/= any \(v_started_crm_ids\)/g) ?? []).length,
    5,
    `${file}: ...and fall back to the agent id against the started ids for a row with no hr id`,
  );
  assert.match(
    code,
    /select count\(\*\) into v_assignments_frozen from public\.crm_contact_assignments a where a\.effective_to is null and \( \(nullif\(btrim\(a\.agent_hr_id\), ''\) is not null and lower\(btrim\(a\.agent_hr_id\)\) = any \(v_started_keys\)\) or \(nullif\(btrim\(a\.agent_hr_id\), ''\) is null and a\.agent_crm_id is not null and a\.agent_crm_id = any \(v_started_crm_ids\)\) \);/,
    `${file}: the frozen count is the same two conditions as the passes — it is the single biggest cost the arrays removed`,
  );

  // ── 2. THE REGION-FROM-NAME UPDATE RUNS ONLY WHEN A CONTACT CAN USE IT ──────────────────────────
  const regionsAt = code.indexOf("update public.crm_contacts c set crm_region_id = r.crm_region_id");
  assert.ok(regionsAt > 0, `${file}: the region-from-name update must still exist`);
  assert.match(
    code.slice(Math.max(0, regionsAt - 260), regionsAt),
    /if exists \( select 1 from public\.crm_contacts w where w\.crm_region_id is null and nullif\(btrim\(w\.crm_region_name\), ''\) is not null \) then $/,
    `${file}: the update sits behind an exists test for a contact with a region NAME and no id — production has 0, so the unconditional scan of 142,560 visits (209 MB, 104,240 rows sorted) was a 0.5-1.3 s no-op on every run`,
  );
  assert.match(
    code.slice(regionsAt, regionsAt + 1100),
    /and lower\(btrim\(m\.crm_region_name\)\) in \( select lower\(btrim\(w\.crm_region_name\)\) from public\.crm_contacts w where w\.crm_region_id is null and nullif\(btrim\(w\.crm_region_name\), ''\) is not null \)/,
    `${file}: when it does run, it reads only the visits of the names those contacts carry`,
  );
  assert.match(
    code.slice(regionsAt, regionsAt + 1400),
    /get diagnostics v_regions_from_name = row_count; end if;/,
    `${file}: the counter is set inside the branch and stays at its declared 0 when the branch is skipped — exactly what an update of zero rows reported`,
  );

  // ── 3. THE TWO UPSERTS OFFER ONLY ROWS THAT WOULD CHANGE ───────────────────────────────────────
  assert.equal(
    (code.match(/left join public\.crm_contacts e on e\.contact_crm_id = x\.contact_crm_id/g) ?? []).length,
    2,
    `${file}: the contacts upsert and the name-row upsert are each joined to crm_contacts first — ON CONFLICT DO UPDATE locks every conflicting row BEFORE its WHERE runs (11,139 + 12,454 locks, 11,900 WAL records and 656 full-page images a run to change 112 rows)`,
  );
  assert.match(
    code,
    /where e\.contact_crm_id is null or \(e\.name, e\.name_ar, e\.speciality, e\.phone, e\.address, e\.city, e\.zone, e\.crm_region_name, e\.source\) is distinct from \(coalesce\(x\.name, e\.name\), x\.name_ar, x\.speciality, x\.phone, x\.address, x\.city, x\.zone, x\.crm_region_name, 'list'\) or e\.first_seen_on > x\.first_seen_on on conflict \(contact_crm_id\) do update set/,
    `${file}: the contacts upsert is offered a row only when it is new or differs by the SAME predicate the conflict filter uses`,
  );
  // Since 20261022163100 the name-row pass offers `o` — Phoenix's value for a trusted row, the value on file
  // else Phoenix's for a pending copy — and the pre-filter is still the conflict filter's own predicate.
  assert.match(
    code,
    /where e\.contact_crm_id is null or \(e\.name, e\.speciality, e\.phone\) is distinct from \(coalesce\(o\.name, e\.name\), coalesce\(o\.speciality, e\.speciality\), coalesce\(o\.phone, e\.phone\)\) or e\.first_seen_on > x\.first_seen_on on conflict \(contact_crm_id\) do update set/,
    `${file}: the name-row upsert is offered a row only when it is new or differs by the SAME predicate the conflict filter uses`,
  );
  // The conflict clauses themselves are untouched: the pre-filter is an optimisation in FRONT of them, so
  // a row that changes between the join and the lock is still judged by the original filter.
  assert.match(
    code,
    /on conflict \(contact_crm_id\) do update set name = coalesce\(excluded\.name, c\.name\), name_ar = excluded\.name_ar, speciality = excluded\.speciality, phone = excluded\.phone, address = excluded\.address, city = excluded\.city, zone = excluded\.zone, crm_region_name = excluded\.crm_region_name, source = 'list', first_seen_on = least\(c\.first_seen_on, excluded\.first_seen_on\), updated_at = now\(\) where \(c\.name, c\.name_ar, c\.speciality, c\.phone, c\.address, c\.city, c\.zone, c\.crm_region_name, c\.source\) is distinct from \(coalesce\(excluded\.name, c\.name\), excluded\.name_ar, excluded\.speciality, excluded\.phone, excluded\.address, excluded\.city, excluded\.zone, excluded\.crm_region_name, 'list'\) or c\.first_seen_on > excluded\.first_seen_on;/,
    `${file}: the contacts upsert keeps its original ON CONFLICT clause and filter`,
  );
  assert.match(
    code,
    /on conflict \(contact_crm_id\) do update set name = coalesce\(excluded\.name, c\.name\), speciality = coalesce\(excluded\.speciality, c\.speciality\), phone = coalesce\(excluded\.phone, c\.phone\), first_seen_on = least\(c\.first_seen_on, excluded\.first_seen_on\), updated_at = now\(\) where \(c\.name, c\.speciality, c\.phone\) is distinct from \(coalesce\(excluded\.name, c\.name\), coalesce\(excluded\.speciality, c\.speciality\), coalesce\(excluded\.phone, c\.phone\)\) or c\.first_seen_on > excluded\.first_seen_on;/,
    `${file}: the name-row upsert writes what it is offered — Phoenix wins (owner, 2026-10-22), and a blank offered keeps the value on file`,
  );

  // ── 3b. THE TWO PASSES ARE OFFERED THE SAME PHOENIX ROW, SO NEITHER UNDOES THE OTHER ──────────────
  // Found 22 Oct 2026 on production: two doctors whose phone sat only on a PENDING Phoenix copy were written
  // twice on every run — the vendor pass blanked the phone with the vendor's empty one, and the name-row pass
  // filled it back from the copy (listContactsChanged = 2 on a second run 15 s after the first). Since
  // 20261022163300 the truth table holds every Phoenix doctor with a `trusted` flag, picked in the name-row
  // pass's own order, and the vendor pass lets a pending copy fill what the vendor leaves blank.
  assert.match(
    code,
    /create temporary table crm_refresh_phoenix_truth on commit drop as select distinct on \(coalesce\(t\.reference_contact_crm_id, t\.own_contact_crm_id\)\) coalesce\(t\.reference_contact_crm_id, t\.own_contact_crm_id\) as contact_crm_id, \(t\.reference_contact_crm_id is null or t\.validated_at is not null\) as trusted, nullif\(btrim\(t\.name\), ''\) as name, nullif\(btrim\(t\.speciality\), ''\) as speciality, nullif\(btrim\(t\.phone\), ''\) as phone from pg_temp\.crm_refresh_phoenix_customers t order by coalesce\(t\.reference_contact_crm_id, t\.own_contact_crm_id\), \(t\.reference_contact_crm_id is null or t\.validated_at is not null\) desc, \(t\.status = 'active'\) desc, t\.validated_at desc nulls last, t\.updated_at desc;/,
    `${file}: the truth table holds every Phoenix doctor, trusted or not, one row each in the name-row pass's order — a truth table of trusted rows only leaves the vendor pass blind to the pending copy the name-row pass then writes`,
  );
  assert.match(
    code,
    /order by coalesce\(p\.reference_contact_crm_id, p\.own_contact_crm_id\), \(p\.reference_contact_crm_id is null or p\.validated_at is not null\) desc, \(p\.status = 'active'\) desc, p\.validated_at desc nulls last, p\.updated_at desc/,
    `${file}: the name-row pass picks its Phoenix row in the same order as the truth table, so both passes read the same row`,
  );
  for (const [out, vendor] of [
    ["name", "m.contact_name"],
    ["speciality", "m.speciality"],
    ["phone", "m.phone"],
  ] as const) {
    const vendorRe = vendor.replace(".", "\\.");
    assert.match(
      code,
      new RegExp(
        `coalesce\\(case when t\\.trusted then t\\.${out} end, nullif\\(btrim\\(${vendorRe}\\), ''\\), t\\.${out}\\) as ${out},`,
      ),
      `${file}: the vendor pass writes a trusted Phoenix ${out}, else the vendor's, else the pending copy's — without the last fallback the vendor pass empties what the name-row pass refills on every run`,
    );
  }

  // ── 3c. THE FOUR THINGS THE 24 OCTOBER PASS TOOK OUT ───────────────────────────────────────
  // Timed on production the same day, the pending row settled first so each run is the quiet tick the cron
  // pays about 96 times a day, old and new alternating four times each: 1,338 ms median -> 794 ms. Both
  // bodies wrote the same single assignment row and left an identical checksum of every column of
  // crm_contacts, so none of the four is a behaviour change — and each one is silent if it is put back.

  // 1. The vendor handover joins on ONE text key. An OR of two equalities is not an equijoin, so no join
  // method could hash it: a Nested Loop over the open vendor rows by the 73 list rows, 156,074 of them
  // thrown away in the join filter, 316 ms a run to hand over nothing on a quiet tick. The lookup emits
  // BOTH keys per rep because the two arms of the old OR were mutually exclusive by construction.
  assert.match(
    code,
    /from \(select distinct match_key, counted_from from \(select l0\.hr_key as match_key, l0\.counted_from from pg_temp\.crm_refresh_phoenix_lists l0 where l0\.status in \('active', 'pending'\) union all select 'crm:' \|\| l0\.agent_crm_id::text, l0\.counted_from from pg_temp\.crm_refresh_phoenix_lists l0 where l0\.status in \('active', 'pending'\) and l0\.agent_crm_id is not null\) k\) l where a\.effective_to is null and a\.source = 'ireports360' and l\.match_key = coalesce\(nullif\(lower\(btrim\(a\.agent_hr_id\)\), ''\), 'crm:' \|\| a\.agent_crm_id::text\);/,
    `${file}: the vendor handover matches a rep on one text key — the hr key, or crm:<id> for a row with no hr id`,
  );
  assert.doesNotMatch(
    code,
    /l\.agent_crm_id = a\.agent_crm_id/,
    `${file}: the handover must never match the list on the CRM id as a second OR arm again — that is the un-hashable shape`,
  );

  // 2. The doctor-list door is a 48 ms Function Scan (1,053 buffers for 93 rows) and was read twice.
  assert.equal(
    (code.match(/public\.phoenix_crm_doctor_list_reps\(\)/g) ?? []).length,
    1,
    `${file}: the doctor-list door is read ONCE into pg_temp.crm_refresh_doctor_list_reps — the four vendor passes and the fifth pass then read the same snapshot, which is also strictly more consistent`,
  );
  assert.match(
    code,
    /create temporary table crm_refresh_doctor_list_reps on commit drop as select distinct s\.seat_id, s\.hr_key, s\.hr_id, s\.agent_crm_id, s\.counted_from from public\.phoenix_crm_doctor_list_reps\(\) s where v_today >= s\.counted_from and \(s\.counted_until is null or v_today < s\.counted_until\);/,
    `${file}: the snapshot carries every column both readers need, filtered to today's live spell exactly as both reads were`,
  );
  assert.match(
    code,
    /create temporary table crm_refresh_started_reps on commit drop as select distinct s\.hr_key, s\.agent_crm_id from pg_temp\.crm_refresh_doctor_list_reps s;/,
    `${file}: the started-reps table is built from the snapshot, not from a second call of the door`,
  );

  // 3. The two big temp tables analyze only the columns something joins, filters or sorts by. Timed on
  // production on freshly built tables so no page was warm: customers 14 columns 168 ms vs these 7 at
  // 53 ms, truth 5 columns 80 ms vs contact_crm_id alone at 3 ms.
  assert.match(
    code,
    /analyze pg_temp\.crm_refresh_phoenix_customers \(seat_id, is_test, status, reference_contact_crm_id, own_contact_crm_id, validated_at, updated_at\);/,
    `${file}: the customers temp table analyzes its seven read columns, not all fourteen`,
  );
  assert.match(
    code,
    /analyze pg_temp\.crm_refresh_phoenix_truth \(contact_crm_id\);/,
    `${file}: contact_crm_id is the only column anything compares on the truth table; the rest are projected`,
  );
  assert.doesNotMatch(
    code,
    /analyze pg_temp\.crm_refresh_phoenix_(customers|truth);/,
    `${file}: a bare analyze builds histograms for columns nothing reads — 115 ms + 77 ms a run, 96 times a day`,
  );

  // 4. The A+ fold is inline at its five call sites. public.crm_contact_fold_grade carries
  // `set search_path to 'public'`, and a SQL function with any SET clause cannot be inlined by the planner,
  // so each call was a real call per row — about 110 ms of the list build alone. The expression below is
  // that function's own body, character for character (20260913150000), and the function is neither changed
  // nor dropped: its other callers keep it, and removing its SET clause would raise a
  // function_search_path_mutable advisor finding that scripts/check-advisor-baseline.ts fails on.
  assert.equal(
    (code.match(/case when upper\(btrim\(([a-z]\.[a-z_]+)\)\) = 'A\+' then 'A' else nullif\(upper\(btrim\(\1\)\), ''\) end/g) ?? [])
      .length,
    5,
    `${file}: the A+ fold is written out at all five sites, each over the same column twice`,
  );
  assert.doesNotMatch(
    code,
    /crm_contact_fold_grade\(/,
    `${file}: the fold must not go back to a function call — it cannot inline, and the body is the one in 20260913150000`,
  );

  // ── 4. EVERYTHING ELSE ABOUT THE FUNCTION IS WHAT 20261015215500 LEFT ──────────────────────────
  assert.equal(
    (code.match(/pg_advisory_xact_lock\(hashtext\('public\.crm_contact_master_refresh'\)\)/g) ?? []).length,
    1,
    `${file}: two overlapping refreshes must still queue on the advisory lock`,
  );
  assert.doesNotMatch(code, /security definer/i, `${file}: the refresh keeps the caller's rights, as it always had`);
  assert.match(
    sql,
    /returns jsonb\s+language plpgsql\s+set search_path to 'public'\s+as \$function\$/,
    `${file}: it must keep its pinned search_path`,
  );
  assert.equal(
    (sql.match(/create or replace function/gi) ?? []).length,
    1,
    `${file}: one function per file — several guards resolve "the newest migration that defines X" and read the whole file`,
  );
  for (const door of ["phoenix_crm_doctor_list_reps()", "crm_refresh_phoenix_customers"]) {
    assert.ok(code.includes(door), `${file}: the body must still use ${door}`);
  }
  for (const key of ["startedRepsFrozen", "assignmentsFrozen", "regionsFromName", "listContactsChanged"]) {
    assert.match(code, new RegExp(`'${key}',`), `${file}: the result still reports ${key}`);
  }
  assert.match(
    sql,
    /comment on function public\.crm_contact_master_refresh\(boolean\) is/,
    `${file}: the newest definer re-emits the function comment`,
  );

  // ── 5. THE HEADER STATES THE DIGEST OF THE BODY IT SITS ABOVE, AND THE ROLLBACK ────────────────
  const stated = /AFTER this file:\s*\n--\s+crm_contact_master_refresh\s+md5\(prosrc\) = ([0-9a-f]{32})/.exec(sql);
  assert.ok(stated, `${file}: the header must state the md5(prosrc) the apply is verified against`);
  assert.equal(
    createHash("md5").update(body).digest("hex"),
    stated![1],
    `${file}: the digest in the header must be the digest of the body below it — it is how an apply is proved, because create-or-replace makes the mere presence of the function worthless as evidence`,
  );
  // The rollback names the PREVIOUS definer, whichever it is — an older file that exists and re-emits the
  // function. A fixed name here went stale the first time the function was redefined after it.
  const rollback = /ROLLBACK: re-apply supabase\/migrations\/(\d{14}_[a-z0-9_]+\.sql)/.exec(sql);
  assert.ok(rollback, `${file}: the header must name the one-command rollback`);
  assert.ok(rollback![1] < file, `${file}: the rollback must re-apply an EARLIER migration, not ${rollback![1]}`);
  assert.match(
    readFileSync(new URL(rollback![1], MIGRATIONS), "utf8"),
    /create\s+or\s+replace\s+function\s+public\.crm_contact_master_refresh\s*\(/i,
    `${file}: the rollback file ${rollback![1]} must itself re-emit crm_contact_master_refresh`,
  );
  assert.match(
    sql,
    /SAFE: every DROP TABLE in this file is a `pg_temp\.` one/,
    `${file}: the header must carry the pg_temp annotation the migration check looks for`,
  );
}
