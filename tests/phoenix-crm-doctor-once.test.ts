import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — a doctor is on a seat once (owner, 2026-10-12: "stop a rep adding a doctor who is
 * already on his list").
 *
 * THE SYSTEM, NOT THE REP, MADE THE SECOND ROW. A rep added a doctor (own id N, origin 'new'); the hourly
 * refresh gave him as an assignment keyed on coalesce(reference_contact_crm_id, own_contact_crm_id), so the
 * reference list carried N; phoenix_crm_seat_reference looked the customer up by reference_contact_crm_id
 * alone and returned NULL; and phoenix_crm_ensure_reference_customers, which runs on every read, minted a
 * pending copy for every NULL. The unique index is on the vendor-id column, so it could not see it.
 *
 * Proven on production 2026-10-12 inside a block that always rolled back: the reference list was 10,767
 * entries before and after, 13 entries that would have been minted a copy resolve to their own customer,
 * and the seat that started this resolves 1000038395 to the original, validated.
 */

const MIGRATION = "supabase/migrations/20261012200000_phoenix_crm_a_doctor_is_on_a_seat_once.sql";

function functionBody(sql: string, name: string): string {
  const match = new RegExp("create or replace function public\\." + name + "\\(([\\s\\S]*?)\\n\\$\\$;").exec(sql);
  assert.ok(match, name + " is defined in " + MIGRATION);
  return match[0];
}

export function runPhoenixCrmDoctorOnceTests(): void {
  const sql = stripSqlComments(readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n"));

  // 1. The customer behind a reference entry is found by the id the assignment carries.
  const reference = functionBody(sql, "phoenix_crm_seat_reference");
  assert.match(
    reference,
    /c\.reference_contact_crm_id = a\.contact_crm_id\s+or \(c\.reference_contact_crm_id is null and c\.own_contact_crm_id = a\.contact_crm_id\)/,
    "a doctor the rep added himself answers to his OWN id; matching the vendor id alone returned NULL and got him a minted copy",
  );
  assert.match(reference, /left join lateral \(/, "one customer per entry, so an existing pair never doubles a reference row");
  assert.match(
    reference,
    /order by \(c\.status <> 'dropped'\) desc, \(c\.status = 'active'\) desc, c\.created_at asc, c\.id asc\s+limit 1/,
    "a pair resolves to the live row, then the active one, then the earliest",
  );

  // 2. Minting skips a contact that is already a customer's own id.
  const ensure = functionBody(sql, "phoenix_crm_ensure_reference_customers");
  assert.match(
    ensure,
    /and not exists \(\s+select 1\s+from public\.phoenix_crm_customers own\s+where own\.seat_id = v_seat\s+and own\.is_test = p_is_test\s+and own\.own_contact_crm_id = r\.contact_crm_id\s+\)/,
    "the minting function must refuse to copy a doctor who is already a customer under his own id",
  );
  assert.match(ensure, /on conflict \(seat_id, reference_contact_crm_id, is_test\) where reference_contact_crm_id is not null\s+do nothing/, "minting stays idempotent");

  // 3. The backstop trigger, on INSERT, naming the refusal the screen already answers.
  assert.match(sql, /raise exception 'phoenix_crm:doctor_already_on_list'/, "the database refuses a second add by name");
  assert.match(
    sql,
    /create trigger phoenix_crm_customers_no_double_add\s+before insert on public\.phoenix_crm_customers\s+for each row/,
    "the trigger fires on insert only: existing pairs are not touched",
  );
  assert.match(sql, /c\.own_contact_crm_id = new\.reference_contact_crm_id\s+and c\.id <> new\.id/, "it compares the new row's reference to another row's OWN id");
  assert.doesNotMatch(sql, /\bdelete\s+from\b|\bdrop\s+table\b|\bupdate\s+public\.phoenix_crm_customers\b/i, "no row is merged, changed or deleted by this migration");

  const db = readFileSync("src/lib/phoenix-crm/server/db.ts", "utf8");
  assert.match(db, /doctor_already_on_list: \{ status: 409,/, "the refusal reaches the rep as a 409 with words, not 'could not be saved'");

  // 4. The LIVE definition (2026-10-16 performance audit) keeps the same match and the same pick, set at a
  //    time: one DISTINCT ON per (seat, id) over the lateral's own four ordering keys, joined on the
  //    entry's contact id — and the pending drop as two joined key sets, never an EXISTS per entry.
  const JOINS_ONCE = "supabase/migrations/20261024003000_phoenix_crm_seat_reference_joins_customers_on_one_key.sql";
  const live = functionBody(stripSqlComments(readFileSync(JOINS_ONCE, "utf8").replace(/\r\n/g, "\n")), "phoenix_crm_seat_reference");
  assert.match(
    live,
    /select distinct on \(c\.seat_id, coalesce\(c\.reference_contact_crm_id, c\.own_contact_crm_id\)\)/,
    "the customer behind an entry is still found by the id the assignment carries — his own id when he has no vendor id",
  );
  assert.match(
    live,
    /\(c\.status <> 'dropped'\) desc,\s+\(c\.status = 'active'\) desc,\s+c\.created_at asc,\s+c\.id asc\s+\)/,
    "a pair still resolves to the live row, then the active one, then the earliest",
  );
  // 23 Oct 2026: the join is ONE key. Joined on seat_id plus contact id the planner merge-joined on seat_id alone
  // and threw away 1.78 million pairs by join filter; one concatenated key sorts and merges on that key.
  assert.match(
    live,
    /c\.seat_id \|\| '\|' \|\| coalesce\(c\.reference_contact_crm_id, c\.own_contact_crm_id\)::text as seat_key/,
    "the customer set carries its one join key",
  );
  assert.match(
    live,
    /customer\.seat_key = ch\.seat_id \|\| '\|' \|\| a\.contact_crm_id::text/,
    "each entry joins its one customer on that one key",
  );
  assert.doesNotMatch(live, /customer\.contact_crm_id = a\.contact_crm_id/, "never back to the two-column join the planner could not merge");
  assert.match(live, /drop_by_customer\.customer_id = customer\.id/, "a pending drop naming the customer still reads drop_pending");
  assert.match(live, /drop_by_contact\.reference_contact_crm_id = a\.contact_crm_id/, "and so does one naming only the contact of an entry never minted");
  assert.doesNotMatch(live, /left join lateral/, "no per-entry lookup of the seat's customers");
  assert.doesNotMatch(live, /when exists \(/, "no per-entry EXISTS over the requests");
  assert.match(live, /\n\s*security definer\n\s*set search_path to 'public'\n/, "still SECURITY DEFINER with its search path pinned");

  console.log("phoenix-crm doctor on a seat once: OK");
}
