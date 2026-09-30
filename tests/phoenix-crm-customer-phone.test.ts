import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CUSTOMER_PHONE_ERROR, CUSTOMER_PHONE_PATTERN, parseCustomerPhone } from "../src/lib/phoenix-crm/entry-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the customer's phone (owner, 2026-09-30).
 *
 * Rebuilding iReports360's Daily Plan without its phone column put three questions to the owner, and
 * each answer is pinned here:
 *
 *   1. **"Add a phone to validation" — OPTIONAL.** A missing number never blocks a validation; an
 *      empty box is no phone, never a refusal.
 *   2. **"Only what the rep types."** The old list holds a phone for 3,322 of its 19,121 contacts, and
 *      none of them is copied in or shown: the phone is `phoenix_crm_customers.phone`, written only by
 *      the validation and by "Change the details".
 *   3. **"Yes, in Change the details."** The rep corrects it beside the name and speciality; emptying
 *      the box clears it. A caller that never sends the key — one release behind — leaves it alone.
 *
 * And the one thing that would go wrong quietly: the form, the server and the database must agree on
 * what a phone IS, or a number the form accepts is refused by the database after the rep pressed Save.
 */

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

const MIGRATION = "supabase/migrations/20260930235705_phoenix_crm_customer_phone.sql";

/** The migration without its comments, with Windows line endings folded, so a pattern reads it the same everywhere. */
function migrationSql(): string {
  return readFileSync(new URL(MIGRATION, ROOT), "utf8").replace(/\r\n/g, "\n").replace(/--.*$/gm, "");
}

export function runPhoenixCrmCustomerPhoneTests(): void {
  // ── 1. What counts as a phone ─────────────────────────────────────────────────────────────────
  {
    for (const empty of [undefined, null, "", "   ", " - "]) {
      assert.deepEqual(parseCustomerPhone(empty), { ok: true, value: null }, `${JSON.stringify(empty)} is no phone — optional, never a refusal`);
    }
    const cases: Array<[string, string]> = [
      ["01012345678", "01012345678"],
      ["010 1234 5678", "01012345678"],
      ["010-1234-5678", "01012345678"],
      ["(02) 2345.6789", "0223456789"],
      // An Arabic keyboard types Arabic-Indic digits; a Persian one its own.
      ["٠١٠١٢٣٤٥٦٧٨", "01012345678"],
      ["۰۱۰۱۲۳۴۵۶۷۸", "01012345678"],
      // A number copied off an Arabic screen carries invisible direction marks.
      ["‏01012345678‎", "01012345678"],
      ["+20 10 1234 5678", "+201012345678"],
      ["0020 10 1234 5678", "+201012345678"],
    ];
    for (const [typed, saved] of cases) {
      assert.deepEqual(parseCustomerPhone(typed), { ok: true, value: saved }, `${JSON.stringify(typed)} saves as ${saved}`);
    }
    for (const bad of ["123456", "0101234567890123", "010abc5678", "+", "01012345678 ext 5"]) {
      assert.deepEqual(parseCustomerPhone(bad), { ok: false, error: CUSTOMER_PHONE_ERROR }, `${JSON.stringify(bad)} is refused with the one sentence`);
    }
    assert.equal(parseCustomerPhone(1012345678).ok, false, "a number that is not text is refused, not guessed at");
  }

  // ── 2. The form, the server and the database agree on what a phone is ─────────────────────────
  {
    const sql = migrationSql();
    const checks = [...sql.matchAll(/'(\^\\\+\?\[0-9\]\{7,15\}\$)'/g)].map((match) => match[1]);
    assert.ok(checks.length >= 3, `the column check and both functions test the phone's shape — found ${checks.length}`);
    for (const check of checks) {
      assert.equal(check, CUSTOMER_PHONE_PATTERN.source, "the database's pattern is the form's pattern, character for character");
    }
    assert.match(sql, /add column if not exists phone text\s+constraint phoenix_crm_customers_phone check \(phone is null or phone ~/, "the column is optional and checked");
    assert.match(sql, /raise exception 'phoenix_crm:bad_phone'/, "a malformed phone is refused by name");
    assert.match(source("src/lib/phoenix-crm/server/db.ts"), /bad_phone: \{ status: 400, message: CUSTOMER_PHONE_ERROR \}/, "and read back in the form's own words");
  }

  // ── 3. Validation writes it in the SAME save, and never blanks one on file ───────────────────────
  {
    const sql = migrationSql();
    const validate = sql.slice(sql.indexOf("function public.phoenix_crm_validate_customer("), sql.indexOf("function public.phoenix_crm_rename_customer("));
    assert.match(validate, /phone = coalesce\(v_phone, c\.phone\)/, "re-validating a carried-over customer keeps his phone when none is sent");
    assert.equal((validate.match(/is_test, phone\n/g) ?? []).length, 2, "both inserts — a carried-over customer and one met outside the list — write the phone");
    assert.match(validate, /'phone', v_customer\.phone/, "and the save answers with it");

    const list = source("src/lib/phoenix-crm/server/list.ts");
    const validateTs = list.slice(list.indexOf("export async function validateCustomer("), list.indexOf("async function notifyRequestRaised("));
    assert.match(validateTs, /const phone = parseCustomerPhone\(body\.phone\);\s+if \(!phone\.ok\) throw validationError\(phone\.error\);/, "the server reads it with the form's own rule");
    assert.match(validateTs, /phone: phone\.value,/, "and sends it inside the validation, not after it");
    assert.ok(validateTs.indexOf("parseCustomerPhone") < validateTs.indexOf('callPhoenixCrm<Row>("phoenix_crm_validate_customer"'), "checked before anything is saved");
  }

  // ── 4. "Change the details" corrects it, and only when it is sent ────────────────────────────────
  {
    const sql = migrationSql();
    const rename = sql.slice(sql.indexOf("function public.phoenix_crm_rename_customer("));
    assert.match(rename, /v_sets_phone boolean := \(p -> 'phone'\) is not null;/, "the key's presence, even empty, is what moves the phone");
    assert.match(rename, /phone = case when v_sets_phone then v_phone else c\.phone end/, "absent, the phone stays exactly as it was");
    assert.match(rename, /'from', v_before/, "the change is on the record");
    assert.match(rename, /jsonb_build_object\('name', v_customer\.name, 'speciality', v_customer\.speciality, 'phone', v_customer\.phone\)/, "with the phone in its from/to");

    const list = source("src/lib/phoenix-crm/server/list.ts");
    const renameTs = list.slice(list.indexOf("export async function renameCustomer("), list.indexOf("export async function setPrimaryPharmacy("));
    assert.match(renameTs, /Object\.prototype\.hasOwnProperty\.call\(body, "phone"\) \? parseCustomerPhone\(body\.phone\) : null/, "a body without the key sends no key");
    assert.match(renameTs, /\.\.\.\(phone\?\.ok \? \{ phone: phone\.value \} : \{\}\)/, "and the key goes to the database only when the body had it");

    const screens = source("src/components/phoenix-crm/list-screens.tsx");
    const details = screens.slice(screens.indexOf("export function EditDetailsScreen("), screens.indexOf("export function DropScreen("));
    assert.match(details, /phone: phoneCheck\.value,/, "the details screen always sends it, so emptying the box clears it");
    assert.match(details, /<CustomerPhoneField/, "and offers it beside the name and speciality");
  }

  // ── 5. Every validation asks for it, the same way ───────────────────────────────────────────────
  {
    const screens = source("src/components/phoenix-crm/list-screens.tsx");
    const validate = screens.slice(screens.indexOf("export function ValidateScreen("), screens.indexOf("export function EditDetailsScreen("));
    assert.equal((validate.match(/<CustomerPhoneField/g) ?? []).length, 2, "the List's Validate asks for it — a carried-over customer and Add new customer");
    assert.equal((validate.match(/phone: phoneValue/g) ?? []).length, 2, "and sends it in both");
    const outside = source("src/components/phoenix-crm/out-of-list-entry.tsx");
    assert.match(outside, /<CustomerPhoneField/, "Someone new, met on an out-of-list visit, is asked too");
    assert.match(outside, /phone: phone\.trim\(\) \|\| null,/, "and it is sent with his validation");
    for (const [name, text] of [["Validate", validate], ["Someone new", outside]] as const) {
      assert.match(text, /const phoneCheck = parseCustomerPhone\(phone\);\s+if \(!phoneCheck\.ok\) return phoneCheck\.error;/, `${name} refuses on the phone what the server would, before the photo is spent`);
    }
  }

  // ── 6. Only what the rep types — never the old list's phones ────────────────────────────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    assert.match(list, /primary_pharmacy_name, phone";/, "the list reads the customer's own phone column");
    assert.match(list, /phone: text\(row\.phone\),/, "and hands it over as it is stored");
    const daily = source("src/lib/phoenix-crm/server/daily-plan-report.ts");
    assert.match(daily, /customer:phoenix_crm_customers!customer_id\([^)]*\bphone\)/, "the daily plan reads the phone from the customer row");
    assert.match(daily, /phone: textOrNull\(record\(itemRow\?\.customer\)\.phone\),/, "and from nowhere else");
    for (const [path, text] of [["server/list.ts", list], ["server/daily-plan-report.ts", daily]] as const) {
      assert.equal(/crm_contacts[^;]*\bphone\b|\bphone\b[^;]*crm_contacts/.test(text), false, `${path} never reads a phone out of iReports360's contacts`);
    }
  }

  console.log("phoenix-crm customer phone: OK");
}
