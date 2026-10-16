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
  assert.match(
    code,
    /where e\.contact_crm_id is null or \(e\.name, e\.speciality, e\.phone\) is distinct from \(coalesce\(e\.name, x\.name\), coalesce\(e\.speciality, x\.speciality\), coalesce\(e\.phone, x\.phone\)\) or e\.first_seen_on > x\.first_seen_on on conflict \(contact_crm_id\) do update set/,
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
    /on conflict \(contact_crm_id\) do update set name = coalesce\(c\.name, excluded\.name\), speciality = coalesce\(c\.speciality, excluded\.speciality\), phone = coalesce\(c\.phone, excluded\.phone\), first_seen_on = least\(c\.first_seen_on, excluded\.first_seen_on\), updated_at = now\(\) where \(c\.name, c\.speciality, c\.phone\) is distinct from \(coalesce\(c\.name, excluded\.name\), coalesce\(c\.speciality, excluded\.speciality\), coalesce\(c\.phone, excluded\.phone\)\) or c\.first_seen_on > excluded\.first_seen_on;/,
    `${file}: the name-row upsert keeps its original ON CONFLICT clause and filter`,
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
  for (const door of ["phoenix_crm_doctor_list_reps()", "crm_contact_fold_grade(", "crm_refresh_phoenix_customers"]) {
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
  assert.match(
    sql,
    /ROLLBACK: re-apply supabase\/migrations\/20261015215500_a_vendorless_reps_phoenix_list_opens\.sql/,
    `${file}: the header must name the one-command rollback`,
  );
  assert.match(
    sql,
    /SAFE: every DROP TABLE in this file is a `pg_temp\.` one/,
    `${file}: the header must carry the pg_temp annotation the migration check looks for`,
  );
}
