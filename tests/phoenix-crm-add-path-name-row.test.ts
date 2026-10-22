import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE ADD PATH WRITES THE DOCTOR'S NAME ROW ITSELF.
//
// Until 20261015135844 nothing on the add path wrote `crm_contacts`:
// `public.crm_contact_master_refresh` was its only writer, so a doctor a rep added himself was a
// customer with no name row until the next hourly run — measured on production 15 Oct 2026, a mean
// of 312 s and a longest of 327 s — and every per-doctor read keyed on `crm_contacts` printed a bare
// id in that window.
//
// WHAT THIS FILE GUARDS:
//   · THE TRIGGER EXISTS AND FIRES ON THE ADD. `phoenix_crm_customers_write_contact_name_row` is
//     what makes the name row atomic with the customer row. Six functions insert into
//     `phoenix_crm_customers`; a trigger is the one shape the seventh cannot forget.
//   · ITS WRITTEN VALUES AND ITS CONFLICT ARM ARE BYTE-IDENTICAL TO THE REFRESH'S NAME-ROW PASS.
//     This is the whole point of the change: identical means the next refresh finds nothing to
//     change about this doctor, so the add stops being a race and the refresh stays idempotent. The
//     comparison reads the REFRESH's own file, so the two can only ever drift together. The trigger
//     FUNCTION is read from its NEWEST definer (20261022163200 re-emits it), the trigger from its own.
//   · PHOENIX'S VALUE WINS (owner, 2026-10-22: "phoenix is the source of trust and its data override
//     old crm data"). The arm writes what it is offered — `name = coalesce(excluded.name, c.name)` —
//     so a rename or a corrected speciality reaches crm_contacts the moment the rep saves it, and a
//     blank in Phoenix never erases a value. Until 20261022163200 the arm filled blanks only, which
//     kept the vendor's speciality on Dr Tharwat Milad after Phoenix had changed it.
//   · THE WHEN CLAUSE IS THE REFRESH PASS'S OWN FILTER. Not a test row, and `status = 'outside'`
//     writes no name row here either — a customer met out of list is on nobody's list yet, and the
//     refresh has always excluded him.
//   · A REFERENCE CUSTOMER IS EXCLUDED. His `crm_contacts` row already exists by construction
//     (`phoenix_crm_seat_reference` took the id FROM the contact master), and
//     `phoenix_crm_ensure_reference_customers` runs on every list read — so including him would buy
//     nothing and make a list opened mid-refresh wait on a row lock the refresh holds.
//   · THE FILE DOES NOT TOUCH `crm_contact_master_refresh`. Its passes, filters and ordering are out
//     of scope, and a change to them belongs in its own migration.
// ─────────────────────────────────────────────────────────────────────────────

const ADD_PATH_MIGRATION = "supabase/migrations/20261015135844_the_add_path_writes_the_doctors_name_row.sql";

/**
 * The refresh migration to compare against is the NEWEST migration that re-creates the function, found
 * by CONTENT, never by a file name: the refresh is re-created by `create or replace` in a new file each
 * time it changes. Until 2026-10-22 this matched `*contact_refresh*` file NAMES, and 20261016233000
 * (`crm_contact_master_refresh_skips_idle_work`) does not contain that string — so for six days the
 * comparison below read the superseded 20261015132445 body and proved nothing about the live one.
 */
function newestRefreshMigration(): string {
  // Resolved from this file, never from the process cwd: the suite is run from the repo root and from
  // a shard runner, and a relative read is the difference between the two.
  const names = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) =>
      stripSqlComments(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8")).includes(
        "create or replace function public.crm_contact_master_refresh(",
      ),
    );
  assert.ok(names.length > 0, "no migration defines crm_contact_master_refresh — the comparison below would prove nothing");
  return `supabase/migrations/${names[names.length - 1]}`;
}

/**
 * The `on conflict (contact_crm_id) do update set … ;` arm of the ONE upsert in the given SQL whose
 * written `source` is `'phoenix'`. The refresh holds three upserts into `crm_contacts` and only the
 * name-row pass writes that source, so the literal is what identifies the pass — written `'phoenix',`
 * in a VALUES list and `'phoenix'::text as source,` in a select list, so both spellings count.
 */
function phoenixConflictArm(sql: string, what: string): string {
  const blocks = sql.split("insert into public.crm_contacts as c (").slice(1);
  const phoenix = blocks.filter((block) => /'phoenix'(::text\s+as\s+source)?,/.test(block));
  assert.equal(
    phoenix.length,
    1,
    `${what} must hold exactly ONE upsert into crm_contacts that writes source 'phoenix' — found ${phoenix.length}`,
  );
  const arm = /on conflict \(contact_crm_id\) do update set([\s\S]*?);/.exec(phoenix[0]);
  assert.ok(arm, `${what}: the name-row upsert has no \`on conflict (contact_crm_id) do update set … ;\` arm`);
  return arm[1].replace(/\s+/g, " ").trim();
}

/**
 * The NEWEST migration that re-creates the trigger function, found by content — the function is
 * re-emitted by `create or replace` in a new file whenever its arm changes, and a pinned name would
 * quietly read a superseded body.
 */
function newestTriggerFunctionMigration(): string {
  const names = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .filter((name) =>
      /create or replace function public\.phoenix_crm_customers_write_contact_name_row\(\)/.test(
        stripSqlComments(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8")),
      ),
    );
  assert.ok(names.length > 0, "no migration defines public.phoenix_crm_customers_write_contact_name_row()");
  return `supabase/migrations/${names[names.length - 1]}`;
}

export function runPhoenixCrmAddPathNameRowTests() {
  const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const trigger = stripSqlComments(read(ADD_PATH_MIGRATION));
  const functionFile = newestTriggerFunctionMigration();
  const addPath = stripSqlComments(read(functionFile));
  const refreshFile = newestRefreshMigration();
  const refresh = stripSqlComments(read(refreshFile));

  // ── 1. The trigger exists, and it fires on the add ───────────────────────
  // The trigger is defined once, in ADD_PATH_MIGRATION; a later file that re-created it would have to be
  // read here instead, so that is refused rather than silently ignored.
  const triggerDefiners = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .filter((name) =>
      /create or replace trigger phoenix_crm_customers_write_contact_name_row/.test(
        stripSqlComments(read(`supabase/migrations/${name}`)),
      ),
    );
  assert.deepEqual(
    triggerDefiners.map((name) => `supabase/migrations/${name}`),
    [ADD_PATH_MIGRATION],
    "the trigger is created in exactly one migration — re-creating it elsewhere needs this test to read that file",
  );
  assert.match(
    trigger,
    /create or replace trigger phoenix_crm_customers_write_contact_name_row\s+after insert or update of status, name, speciality, phone\s+on public\.phoenix_crm_customers\s+for each row/,
    "the add path's name row is written by an AFTER INSERT OR UPDATE trigger on public.phoenix_crm_customers — " +
      "without it the only writer of crm_contacts is the hourly refresh again, and a doctor a rep just " +
      "added has no name row for minutes",
  );
  assert.match(
    trigger,
    /execute function public\.phoenix_crm_customers_write_contact_name_row\(\)/,
    "the trigger must execute the trigger function",
  );
  assert.match(
    addPath,
    /create or replace function public\.phoenix_crm_customers_write_contact_name_row\(\)\s+returns trigger\s+language plpgsql\s+set search_path = ''/,
    "the trigger function is plpgsql with search_path pinned EMPTY and every name qualified — an " +
      "unpinned search_path is a Supabase advisor finding and a real hijack surface",
  );

  // ── 2. `create or replace trigger`, never drop-then-create ───────────────
  for (const [label, sql] of [["the trigger's migration", trigger], [functionFile, addPath]] as const) {
    assert.ok(
      !/drop trigger/i.test(sql) && !/drop function/i.test(sql),
      `${label}: replace the trigger and its function in place (PostgreSQL 14+; both projects run 17.6) — a ` +
        "drop-then-create leaves the table without the trigger for an instant, and a DROP is also what the " +
        "pre-authorized Supabase doors decline",
    );
  }

  // ── 3. The WHEN clause is the refresh pass's own filter, plus reference ───
  const when = /for each row\s+when \(([\s\S]*?)\)\s+execute function/.exec(trigger);
  assert.ok(when, "the trigger must carry a WHEN clause — firing on every customer row is not the rule");
  const whenClause = when[1].replace(/\s+/g, " ").trim();
  assert.equal(
    whenClause,
    "new.reference_contact_crm_id is null and not new.is_test and new.status in ('active', 'pending', 'dropped')",
    "the WHEN clause is the refresh name-row pass's own filter (not a test row, status active/pending/dropped) " +
      "plus the reference exclusion. `outside` is absent deliberately: a customer met out of list is on " +
      "nobody's list yet. A reference customer is absent because his name row already exists, and " +
      "upserting onto it would make a list read wait on the refresh's row lock",
  );
  assert.match(
    refresh,
    /where not p\.is_test\s+and p\.status in \('active', 'pending', 'dropped'\)/,
    `${refreshFile} must still filter the name-row pass on \`not is_test\` and those three statuses — ` +
      "if the refresh's filter moved, the trigger's WHEN clause above moved with it or they now disagree",
  );

  // ── 4. The key, the source and first_seen_on ─────────────────────────────
  assert.match(
    addPath,
    /coalesce\(new\.reference_contact_crm_id, new\.own_contact_crm_id\)/,
    "the name row is keyed on coalesce(reference_contact_crm_id, own_contact_crm_id) — the same expression " +
      "every Phoenix CRM door emits, so a doctor is one contact however he was added",
  );
  assert.match(addPath, /'phoenix',/, "a name row this trigger creates carries source 'phoenix', as the refresh writes it");
  assert.match(
    addPath,
    /least\(\(new\.created_at at time zone 'Africa\/Cairo'\)::date, \(now\(\) at time zone 'Africa\/Cairo'\)::date\)/,
    "first_seen_on is least(created_at in Cairo, today in Cairo) — the refresh's own expression, with its " +
      "`v_today` spelled out. A customer promoted out of `outside` months later keeps the date he was created on",
  );

  // ── 5. 🔴 The conflict arm is BYTE-IDENTICAL to the refresh's ────────────
  const addArm = phoenixConflictArm(addPath, "the add-path trigger");
  const refreshArm = phoenixConflictArm(refresh, refreshFile);
  assert.equal(
    addArm,
    refreshArm,
    "the trigger's `on conflict` arm must be IDENTICAL to the refresh name-row pass's arm. That identity is " +
      "the whole change: it is what makes the next refresh a no-op for a doctor the add already wrote, " +
      `instead of a second opinion about his name. Compared against ${refreshFile}`,
  );

  // ── 6. Phoenix's value wins, and a blank never erases one ────────────────
  // Owner, 2026-10-22: "phoenix is the source of trust and its data override old crm data".
  for (const column of ["name", "speciality", "phone"]) {
    assert.ok(
      addArm.includes(`${column} = coalesce(excluded.${column}, c.${column})`),
      `the conflict arm must write Phoenix's ${column} — \`coalesce(excluded.${column}, c.${column})\`. The ` +
        "blank-only arm (`coalesce(c.x, excluded.x)`) kept the vendor's value on every doctor Phoenix corrected: " +
        "Dr Tharwat Milad read Internal Medicine after Phoenix changed him to General Surgery",
    );
    assert.ok(
      !new RegExp(`${column} = excluded\\.${column}(?!\\w)`).test(addArm),
      `\`${column} = excluded.${column}\` would let a blank in Phoenix erase a value already on file`,
    );
  }
  assert.ok(
    addArm.includes(
      "where (c.name, c.speciality, c.phone) is distinct from " +
        "(coalesce(excluded.name, c.name), coalesce(excluded.speciality, c.speciality), coalesce(excluded.phone, c.phone))",
    ),
    "the arm's filter is its own assignment's predicate, so a row that would not change is never rewritten",
  );
  assert.ok(
    !/\bsource = /.test(addArm),
    "the conflict arm must not rewrite `source` — a contact the vendor list owns stays source 'list', and " +
      "the refresh's own name-row arm does not touch it either",
  );

  // ── 7. The refresh itself is out of scope ────────────────────────────────
  // Naming it is fine and the function's own COMMENT does (a string literal, which the comment strip
  // keeps); re-creating or altering it is what is out of scope.
  for (const [label, sql] of [["the trigger's migration", trigger], [functionFile, addPath]] as const) {
    assert.ok(
      !/(create (or replace )?|alter |drop )function[^;]*crm_contact_master_refresh/i.test(sql),
      `${label} must not re-create, alter or drop public.crm_contact_master_refresh — its passes, filters ` +
        "and ordering belong in their own file where its header can say why",
    );
  }
}
