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
//     comparison reads the REFRESH's own file, so the two can only ever drift together.
//   · A NAME THE VENDOR ALREADY CARRIES IS LEFT ALONE. Only a blank is filled. That name is the one
//     every historical report was keyed on; renaming it would restate months already read.
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
 * The refresh migration to compare against is the NEWEST `*contact_refresh*` file on disk, never a
 * hard-coded one: the refresh is re-created by `create or replace` in a new file each time it
 * changes, so a pinned name would quietly compare against a superseded body.
 */
function newestRefreshMigration(): string {
  // Resolved from this file, never from the process cwd: the suite is run from the repo root and from
  // a shard runner, and a relative read is the difference between the two.
  const names = readdirSync(new URL("../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql") && name.includes("contact_refresh"))
    .sort();
  assert.ok(names.length > 0, "no `*contact_refresh*` migration on disk — the comparison below would prove nothing");
  return `supabase/migrations/${names[names.length - 1]}`;
}

/**
 * The `on conflict (contact_crm_id) do update set … ;` arm of the ONE upsert in the given SQL whose
 * written `source` is `'phoenix'`. The refresh holds three upserts into `crm_contacts` and only the
 * name-row pass writes that source, so the literal is what identifies the pass.
 */
function phoenixConflictArm(sql: string, what: string): string {
  const blocks = sql.split("insert into public.crm_contacts as c (").slice(1);
  const phoenix = blocks.filter((block) => block.includes("'phoenix',"));
  assert.equal(
    phoenix.length,
    1,
    `${what} must hold exactly ONE upsert into crm_contacts that writes source 'phoenix' — found ${phoenix.length}`,
  );
  const arm = /on conflict \(contact_crm_id\) do update set([\s\S]*?);/.exec(phoenix[0]);
  assert.ok(arm, `${what}: the name-row upsert has no \`on conflict (contact_crm_id) do update set … ;\` arm`);
  return arm[1].replace(/\s+/g, " ").trim();
}

export function runPhoenixCrmAddPathNameRowTests() {
  const read = (relativePath: string) => readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const addPath = stripSqlComments(read(ADD_PATH_MIGRATION));
  const refreshFile = newestRefreshMigration();
  const refresh = stripSqlComments(read(refreshFile));

  // ── 1. The trigger exists, and it fires on the add ───────────────────────
  assert.match(
    addPath,
    /create or replace trigger phoenix_crm_customers_write_contact_name_row\s+after insert or update of status, name, speciality, phone\s+on public\.phoenix_crm_customers\s+for each row/,
    "the add path's name row is written by an AFTER INSERT OR UPDATE trigger on public.phoenix_crm_customers — " +
      "without it the only writer of crm_contacts is the hourly refresh again, and a doctor a rep just " +
      "added has no name row for minutes",
  );
  assert.match(
    addPath,
    /execute function public\.phoenix_crm_customers_write_contact_name_row\(\)/,
    "the trigger must execute the trigger function this file creates",
  );
  assert.match(
    addPath,
    /create or replace function public\.phoenix_crm_customers_write_contact_name_row\(\)\s+returns trigger\s+language plpgsql\s+set search_path = ''/,
    "the trigger function is plpgsql with search_path pinned EMPTY and every name qualified — an " +
      "unpinned search_path is a Supabase advisor finding and a real hijack surface",
  );

  // ── 2. `create or replace trigger`, never drop-then-create ───────────────
  assert.ok(
    !/drop trigger/i.test(addPath),
    "replace the trigger in place (PostgreSQL 14+; both projects run 17.6) — a drop-then-create leaves " +
      "the table without the trigger for an instant, and a DROP is also what the pre-authorized " +
      "Supabase doors decline",
  );

  // ── 3. The WHEN clause is the refresh pass's own filter, plus reference ───
  const when = /for each row\s+when \(([\s\S]*?)\)\s+execute function/.exec(addPath);
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

  // ── 6. Only a blank is filled — a vendor name is never renamed ───────────
  for (const column of ["name", "speciality", "phone"]) {
    assert.ok(
      addArm.includes(`${column} = coalesce(c.${column}, excluded.${column})`),
      `the conflict arm must fill ${column} only when it is BLANK — \`coalesce(c.${column}, excluded.${column})\`. ` +
        "A name the vendor already carries is the one every historical report was keyed on; overwriting it " +
        "would restate months that have already been read",
    );
    assert.ok(
      !new RegExp(`${column} = excluded\\.${column}(?!\\w)`).test(addArm),
      `\`${column} = excluded.${column}\` would overwrite the vendor's value instead of filling a blank`,
    );
  }
  assert.ok(
    !/\bsource = /.test(addArm),
    "the conflict arm must not rewrite `source` — a contact the vendor list owns stays source 'list', and " +
      "the refresh's own name-row arm does not touch it either",
  );

  // ── 7. The refresh itself is out of scope ────────────────────────────────
  // Naming it is fine and the function's own COMMENT does (a string literal, which the comment strip
  // keeps); re-creating or altering it is what is out of scope.
  assert.ok(
    !/(create (or replace )?|alter |drop )function[^;]*crm_contact_master_refresh/i.test(addPath),
    "this migration must not re-create, alter or drop public.crm_contact_master_refresh — its passes, filters " +
      "and ordering are out of scope, and a change to them belongs in its own file where its header can say why",
  );
}
