import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripSqlComments } from "./support/comment-strip.ts";

import { normalizeContactName, TITLE_TOKENS } from "../src/lib/crm/campaign-contact-match.ts";

/**
 * Phoenix CRM — one customer, one name key.
 *
 * TWO KEYS WERE ANSWERING ONE QUESTION. `server/duplicate-customers.ts` folds a name through
 * `normalizeContactName` before deciding two rows are the same customer; the loader compared
 * `lower(c.name) = lower(v_name)`. So the loader created the second row and the board then reported
 * it — the system disagreed with itself, and the SFE got a duplicate nobody had prevented.
 *
 * Measured on production 2026-10-06: **2,708 of 9,137** customer names (29.6%) change under the
 * fold, and **8** groups on one seat and one list type hold the same customer twice where the raw
 * key could never have seen it. Every one of the eight is a pure orthography pair — the hamza
 * carrier, final `ى`, or final `ة` — which is to say the same person, typed by two keyboards.
 *
 * WHAT IS PINNED HERE, and why each half matters:
 *
 *   1. THE HONORIFIC LIST IS THE SAME SET ON BOTH SIDES. The fold now exists twice — in TypeScript
 *      for the board and in SQL for the loader's guard, because that guard runs inside a plpgsql
 *      function. Adding "eng" to one and not the other would put the two keys quietly back out of
 *      step, and nothing else in the repository would notice. The sets are compared literally.
 *
 *   2. THE SQL CARRIES EVERY FOLD STEP. Dropping the `ى → ي` translate alone would re-admit five of
 *      the eight real pairs.
 *
 *   3. BOTH GUARDS USE IT. There are two name comparisons in the loader — the customer insert and
 *      the days-and-hours pass — and a fix applied to one of them is a fix that still lets the
 *      duplicate in through the other.
 *
 *   4. IT ONLY EVER SKIPS. The folded hit takes the existing `already_on_the_list` branch. Nothing
 *      here may merge, delete, rename or overwrite a customer: removing a duplicate is the
 *      district-manager-then-SFE two-step the owner owns, and the 55 groups already on the list stay
 *      exactly as they are.
 *
 * The equivalence of the two implementations was ALSO checked against live data rather than only
 * asserted here: every one of the 9,137 real names was folded by both and the digests matched
 * (`00807c0abf8c22d7f9d55c57bbeda6a4`). This file is what keeps them matching.
 */

const MIGRATION = "supabase/migrations/20261006002000_phoenix_crm_customer_name_fold.sql";
/** 2026-10-12 — the same fold reaching the door the rep's own phone comes through, and the place cap. */
const DOOR_MIGRATION = "supabase/migrations/20261012090000_phoenix_crm_door_name_fold_and_place_cap.sql";

/** The honorific array inside `phoenix_crm_fold_name`, as the migration actually writes it. */
function sqlTitleTokens(sql: string): string[] {
  const fold = sql.slice(sql.indexOf("as $fold$"), sql.indexOf("$fold$;"));
  const array = /word <> all \(array\[([\s\S]*?)\]\)/.exec(fold);
  assert.ok(array, "the fold must reject its honorifics with `word <> all (array[…])`");
  return [...array[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

function checkTheHonorificsAreOneList(sql: string): void {
  const inSql = sqlTitleTokens(sql);
  assert.deepEqual(
    [...inSql].sort(),
    [...TITLE_TOKENS].sort(),
    "the SQL fold and normalizeContactName must strip the SAME honorifics — a title in one and not the other is the drift that puts the two keys back out of step",
  );
  assert.ok(inSql.length >= 15, "the honorific list must not be quietly emptied");

  // And each one really is dropped by the TypeScript half, so the list is not decoration.
  for (const title of inSql) {
    assert.equal(
      normalizeContactName(`${title} سمير حسن`),
      "سمير حسن",
      `"${title}" must fold away as an honorific, not survive as part of the name`,
    );
  }
}

function checkTheSqlCarriesEveryFoldStep(sql: string): void {
  const fold = sql.slice(sql.indexOf("as $fold$"), sql.indexOf("$fold$;"));
  for (const [step, pattern] of [
    ["Unicode normalisation", /normalize\(coalesce\(p_name, ''\), NFKC\)/],
    ["the hamza carriers and the final ya and ta", /translate\(lower\([\s\S]*?'أإآٱىة', 'اااايه'\)/],
    ["the diacritics and the tatweel", /\[ًٌٍَُِّْٰـ\]/],
    ["everything that is not a letter or a number", /\[\^\[:alnum:\]\[:space:\]\]/],
    // The SQL holds the two characters `\` and `s`, so the regex literal needs exactly one escaped
    // backslash. `\\\\` here would look for two of them and never match a correct migration.
    ["one space between words", /regexp_split_to_array[\s\S]*?'\\s\+'/],
  ] as const) {
    assert.match(fold, pattern, `the SQL fold must still do ${step}`);
  }
  assert.match(sql, /language sql\s*\nimmutable/, "the fold must be immutable so it can be indexed and inlined");
  assert.match(sql, /revoke execute on function public\.phoenix_crm_fold_name\(text\) from public, anon, authenticated/, "the fold is service-role only");
}

function checkBothGuardsFold(sql: string): void {
  const folded = sql.split("and public.phoenix_crm_fold_name(c.name) = public.phoenix_crm_fold_name(v_name)").length - 1;
  assert.equal(folded, 2, "BOTH name comparisons must fold — the customer insert and the days-and-hours pass");

  const loader = sql.slice(sql.indexOf("create or replace function public.phoenix_crm_load_list_customers"));
  assert.doesNotMatch(loader, /lower\(c\.name\)/, "no raw-lower name comparison may survive in the loader");

  // The hours pass still reaches only a customer who is waiting, and still writes one column.
  assert.match(loader, /and c\.status = 'pending'/, "the hours pass still only touches a customer waiting to be validated");
  assert.match(loader, /intake_timings/, "the days-and-hours pass must still be there — this migration replaces the live function");

  // It skips. It never merges, deletes, renames or overwrites.
  assert.match(loader, /'reason', 'already_on_the_list'/, "a folded hit takes the existing skip branch");
  assert.doesNotMatch(loader, /delete\s+from\s+public\.phoenix_crm_customers/i, "nothing here may delete a customer");
  assert.doesNotMatch(loader, /update\s+public\.phoenix_crm_customers\s+set\s+name/i, "nothing here may rewrite a customer's name");
}

/**
 * 5. THE DOOR AND THE RENAME FOLD TOO — 2026-10-12.
 *
 * The rule above was written about the LOADER, and the loader was the only thing the change touched.
 * The two places a rep's own phone creates or renames a customer went on comparing `lower()`, so the
 * system still disagreed with itself — one door further in. Measured on production 2026-10-12 inside
 * the door's own scope (seat + is_test + list_type + active/pending/outside, 12,272 customers): 183
 * fold-groups already hold more than one live row, and 7 groups / 9 rows are ones the fold catches
 * and `lower()` could not — every one the same doctor with a `د.` honorific or an alef/yeh spelling.
 *
 * The same fences apply here as to the loader, and they are asserted rather than trusted: it only
 * ever SKIPS by raising the existing `same_name` — no merge, no delete, no unique index — the scope
 * stays the seat, and the key is never the identity key.
 */
function checkTheDoorAndTheRenameFold(): void {
  // 🔴 THE COMMENTS COME OFF FIRST, AND THAT IS NOT TIDINESS. Every `doesNotMatch` below asks whether
  // the migration DOES something, and a migration explaining why it does not do that thing names it in
  // prose: the file's own comment says the key is never `identityNameKey`, and a raw read of it failed
  // this very assertion on the sentence promising the opposite. A banned-token check that reads
  // comments can only be satisfied by never discussing the ban, which is the opposite of what these
  // files are for.
  //
  // 🔴 AND IT IS `stripSqlComments`, NEVER A LINE FILTER. This read began as a filter on lines
  // starting `--`, which `tests/comment-strip-ratchet.test.ts` refuses by name: a line is judged by how
  // it STARTS, so a `--` written after code survives and a block comment survives entirely. The shared
  // parser tracks the dollar-quoted body too, so the comments inside this migration's function bodies
  // come off as well, and it blanks each span in place -- the offsets the slices below take are unmoved.
  const sql = stripSqlComments(readFileSync(DOOR_MIGRATION, "utf8"));

  for (const [what, fn] of [
    ["the door", "phoenix_crm_validate_customer"],
    ["the rename", "phoenix_crm_rename_customer"],
  ] as const) {
    const start = sql.indexOf(`create or replace function public.${fn}`);
    assert.ok(start >= 0, `${DOOR_MIGRATION} must carry ${fn} in full — it replaces the live function`);
    const body = sql.slice(start, sql.indexOf("$$;", start));

    assert.doesNotMatch(body, /lower\(c\.name\)/, `no raw-lower name comparison may survive in ${what}`);
    assert.match(
      body,
      /and public\.phoenix_crm_fold_name\(c\.name\) = v_name_key/,
      `${what} must compare the FOLDED name — the same key the loader and the board already use`,
    );
    // An empty fold is not a key. Without this guard the check would collide every name that folds
    // away to nothing onto one customer; the fold's own header says so, and the loader reads it so.
    assert.match(body, /v_name_key <> ''/, `${what} must skip the duplicate check when the name folds away to nothing`);
    // It only ever skips.
    assert.match(body, /raise exception 'phoenix_crm:same_name'/, `${what} must still refuse by raising same_name, never by merging`);
    assert.doesNotMatch(body, /delete\s+from\s+public\.phoenix_crm_customers/i, `nothing in ${what} may delete a customer`);
  }

  assert.doesNotMatch(sql, /create\s+unique\s+index/i, "no unique index — 183 live fold-groups could not satisfy one");
  // Never widened past the seat: 594 of 624 production pairs straddle two lines and are CORRECT.
  const door = sql.slice(sql.indexOf("create or replace function public.phoenix_crm_validate_customer"));
  assert.match(door.slice(0, door.indexOf("$$;")), /c\.seat_id = v_seat/, "the door's duplicate check stays scoped to the seat");
  // And never `identityNameKey`, which collapses محمود onto محمد.
  assert.doesNotMatch(sql, /identity_name_key|identityNameKey/, "the key is phoenix_crm_fold_name, never the identity key");
}

/**
 * 6. THE FIVE-PLACE CAP REACHES THE VALIDATE PATH — 2026-10-12.
 *
 * `phoenix_crm_add_place` has checked `>= 5` all along, but `phoenix_crm_validate_customer` called
 * `phoenix_crm_insert_place` DIRECTLY and checked nothing, so validating a listed customer who
 * already held five clinics added a sixth. Nothing pinned its absence. It is asserted here because
 * the same migration carries it, and the ORDER is the whole fix: a cap checked after the insert is
 * not a cap.
 */
function checkTheValidatePathChecksTheCap(): void {
  const sql = readFileSync(DOOR_MIGRATION, "utf8");
  const door = sql.slice(sql.indexOf("create or replace function public.phoenix_crm_validate_customer"));
  const body = door.slice(0, door.indexOf("$$;"));

  const cap = /count\(\*\) from public\.phoenix_crm_places pl where pl\.customer_id = v_customer\.id and pl\.status = 'active'\) >= 5/;
  assert.match(body, cap, "the validate path must count the customer's ACTIVE places and stop at five");
  assert.match(
    body,
    /raise exception 'phoenix_crm:too_many_places'/,
    "and raise the SAME error add_place raises, which the API already explains to the rep",
  );

  const capAt = body.search(cap);
  const insertAt = body.indexOf("v_place := public.phoenix_crm_insert_place(");
  assert.ok(capAt >= 0 && insertAt >= 0, "both the cap and the insert must be present");
  assert.ok(capAt < insertAt, "the cap must be checked BEFORE the place is inserted");
}

function checkTheRealProductionPairs(): void {
  // The eight pairs that existed on production because the raw key could not see them. Each one is
  // the same customer; the fold must put them on one key.
  const pairs: Array<[string, string]> = [
    ["أحمد محمد الصباغ", "احمد محمد الصباغ"],
    ["مستشفي مصطفى محمود", "مستشفي مصطفي محمود"],
    ["محمد الشكلى", "محمد الشكلي"],
    ["أيسر بسالى", "ايسر بسالي"],
    ["احمد شلبى", "احمد شلبي"],
    ["أسلام نعيم", "اسلام نعيم"],
    ["صيدلية الحرية الجديدة", "صيدلية الحرية الجديده"],
    ["بيشوى نبيل", "بيشوي نبيل"],
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(left.toLowerCase(), right.toLowerCase(), `${left} / ${right} must be a pair the RAW key could not match, or it proves nothing`);
    assert.equal(normalizeContactName(left), normalizeContactName(right), `${left} and ${right} are one customer`);
  }

  // …and the fold must not become a blunt instrument. Two different people stay two.
  assert.notEqual(normalizeContactName("أحمد سمير"), normalizeContactName("محمد سمير"), "a different first name is a different person");
  assert.notEqual(normalizeContactName("صيدلية الحرية"), normalizeContactName("صيدلية الحريه الجديده"), "a longer pharmacy name is a different pharmacy");
  assert.equal(normalizeContactName("   "), "", "a blank name folds to nothing, which the caller must never use as a key");
}

export function runPhoenixCrmCustomerNameFoldTests(): void {
  const sql = readFileSync(MIGRATION, "utf8");

  checkTheHonorificsAreOneList(sql);
  checkTheSqlCarriesEveryFoldStep(sql);
  checkBothGuardsFold(sql);
  checkTheDoorAndTheRenameFold();
  checkTheValidatePathChecksTheCap();
  checkTheRealProductionPairs();

  console.log("phoenix-crm customer name fold: OK");
}
